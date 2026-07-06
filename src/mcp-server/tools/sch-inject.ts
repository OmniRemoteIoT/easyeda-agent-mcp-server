import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { execFileSync } from 'child_process';
import { gunzipSync, gzipSync } from 'zlib';
import { copyFileSync } from 'fs';
import { resolve as nodeResolve } from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';
import { textResult, resolveNetlistInput } from './util';

/**
 * Write real schematic connectivity into an EasyEDA Pro `.eprj` (SQLite) at the file
 * level. The extension write API cannot create schematic connectivity (setNetlist
 * no-ops; API-inserted wires stay inert), but EDA Pro *computes* the netlist from the
 * stored geometry when it opens a file. So we inject a short named "wire stub" on each
 * pin (a `WIRE` touching the pin + a child `NET` attr); same-named wire nets merge, so
 * this is net-labels-by-name and yields a real, ERC-clean netlist on reopen.
 *
 * Verified live on the Iris Wand board: 68 nets / 362 pins exact match + ERC pass.
 */

const OUT_DIR: Record<number, [number, number]> = { 0: [-1, 0], 90: [0, -1], 180: [1, 0], 270: [0, 1] };
const STUB_LEN = 8; // shorter than the min pin pitch (10), so a stub can never reach a neighbouring pin

function expandPath(p: string): string {
	return p === '~' ? homedir() : p.startsWith('~/') ? nodeResolve(homedir(), p.slice(2)) : nodeResolve(p);
}
function sqlRead(db: string, sql: string): string {
	return execFileSync('sqlite3', [db, sql], { maxBuffer: 256 * 1024 * 1024 }).toString('utf8');
}
function sqlExec(db: string, sql: string): void {
	execFileSync('sqlite3', [db], { input: sql, maxBuffer: 256 * 1024 * 1024 });
}
function decodeDataStr(raw: string): string {
	let r = raw.trim();
	if (r.startsWith('base64')) r = r.slice(6);
	return gunzipSync(Buffer.from(r, 'base64')).toString('utf8');
}
function encodeDataStr(text: string): string {
	return 'base64' + gzipSync(Buffer.from(text, 'utf8')).toString('base64');
}
const onSeg = (px: number, py: number, x1: number, y1: number, x2: number, y2: number): boolean =>
	x1 === x2
		? px === x1 && py >= Math.min(y1, y2) && py <= Math.max(y1, y2)
		: y1 === y2
			? py === y1 && px >= Math.min(x1, x2) && px <= Math.max(x1, x2)
			: false;

interface InjectResult {
	ok: boolean;
	nets: number;
	pinRefs: number;
	stubs: number;
	unresolved: string[];
	foreignPinHits: string[];
	stubTouches: number;
	outputPath?: string;
	renamedTo?: string;
	integrity?: string;
	note: string;
}

/** Core injection — pure file work, no bridge. Throws on unrecoverable input errors. */
export function injectConnectivity(opts: {
	srcEprj: string;
	outEprj: string;
	schematicPageUuid: string;
	netlist: string;
	newName?: string;
}): InjectResult {
	const { srcEprj, outEprj, schematicPageUuid: DOC, netlist, newName } = opts;

	const docRaw = sqlRead(srcEprj, `SELECT dataStr FROM documents WHERE uuid='${DOC}';`).trim();
	if (!docRaw) {
		// Help the caller pick the right page.
		const list = sqlRead(srcEprj, `SELECT substr(uuid,1,32)||'  '||title FROM documents WHERE docType=1;`).trim();
		throw new Error(`No schematic page with uuid '${DOC}' in ${srcEprj}. Available schematic pages (docType 1):\n${list}`);
	}
	const docText = decodeDataStr(docRaw);
	let lines = docText.split('\n').filter((l) => l.length);
	const alreadyWired = lines.some((l) => l.startsWith('["WIRE"'));

	// component instances: id -> {x,y,des,sym}
	const comps: Record<string, any> = {};
	for (const l of lines) {
		if (l.startsWith('["COMPONENT"')) {
			const a = JSON.parse(l);
			comps[a[1]] = { x: a[3], y: a[4] };
		} else if (l.startsWith('["ATTR"')) {
			const a = JSON.parse(l);
			if (comps[a[2]]) {
				if (a[3] === 'Designator') comps[a[2]].des = a[4];
				if (a[3] === 'Symbol') comps[a[2]].sym = a[4];
			}
		}
	}
	const byDes: Record<string, any> = {};
	for (const id in comps) if (comps[id].des) byDes[comps[id].des] = comps[id];

	// symbol pin maps: symUuid -> { pinNumber -> {px,py,rot} }
	const symCache: Record<string, Record<string, any>> = {};
	function symPins(sym: string): Record<string, any> {
		if (symCache[sym]) return symCache[sym];
		const s = decodeDataStr(sqlRead(srcEprj, `SELECT dataStr FROM components WHERE uuid='${sym}';`));
		const origin: Record<string, any> = {};
		const num: Record<string, string> = {};
		for (const l of s.split('\n')) {
			if (l.startsWith('["PIN"')) {
				const a = JSON.parse(l);
				origin[a[1]] = { px: a[4], py: a[5], rot: a[7] };
			} else if (l.startsWith('["ATTR"')) {
				const a = JSON.parse(l);
				if (a[3] === 'NUMBER') num[a[2]] = String(a[4]);
			}
		}
		const pins: Record<string, any> = {};
		for (const pid in origin) if (num[pid] != null) pins[num[pid]] = origin[pid];
		return (symCache[sym] = pins);
	}

	// all-pins index for the foreign-pin collision check
	const allPins: Record<string, string[]> = {};
	for (const des in byDes) {
		const c = byDes[des];
		const pins = symPins(c.sym);
		for (const n in pins) {
			const k = `${c.x + pins[n].px},${c.y + pins[n].py}`;
			(allPins[k] = allPins[k] || []).push(`${des}-${n}`);
		}
	}

	// parse Protel2 net blocks: ( name \n DES-PIN ... )
	const nl = netlist.split(/\r\n|\r|\n/);
	const nets: { name: string; refs: [string, string][] }[] = [];
	for (let i = 0; i < nl.length; i++) {
		if (nl[i].trim() === '(') {
			i++;
			const name = nl[i].trim();
			i++;
			const refs: [string, string][] = [];
			while (i < nl.length && nl[i].trim() !== ')') {
				const e = nl[i].trim();
				if (e) {
					const d = e.indexOf('-');
					refs.push([e.slice(0, d), e.slice(d + 1)]);
				}
				i++;
			}
			nets.push({ name, refs });
		}
	}

	// build stubs
	const stubs: any[] = [];
	const unresolved: string[] = [];
	for (const net of nets)
		for (const [des, pin] of net.refs) {
			const c = byDes[des];
			if (!c) {
				unresolved.push(`${des}-${pin} (no component)`);
				continue;
			}
			const p = symPins(c.sym)[pin];
			if (!p) {
				unresolved.push(`${des}-${pin} (pin not in symbol)`);
				continue;
			}
			const ax = c.x + p.px;
			const ay = c.y + p.py;
			let d = OUT_DIR[p.rot];
			if (!d) d = Math.abs(p.px) >= Math.abs(p.py) ? [p.px >= 0 ? 1 : -1, 0] : [0, p.py >= 0 ? 1 : -1];
			stubs.push({ net: net.name, ax, ay, bx: ax + d[0] * STUB_LEN, by: ay + d[1] * STUB_LEN, des, pin });
		}

	// geometric self-checks (fail closed)
	const foreignPinHits: string[] = [];
	for (const s of stubs)
		for (const k in allPins) {
			const [x, y] = k.split(',').map(Number);
			if (x === s.ax && y === s.ay) continue;
			if (onSeg(x, y, s.ax, s.ay, s.bx, s.by)) foreignPinHits.push(`${s.net} @${s.des}-${s.pin} hits ${allPins[k].join('/')}`);
		}
	let stubTouches = 0;
	for (let a = 0; a < stubs.length; a++)
		for (let b = a + 1; b < stubs.length; b++) {
			if (stubs[a].net === stubs[b].net) continue;
			const A = stubs[a],
				B = stubs[b];
			const touch =
				onSeg(A.ax, A.ay, B.ax, B.ay, B.bx, B.by) ||
				onSeg(A.bx, A.by, B.ax, B.ay, B.bx, B.by) ||
				onSeg(B.ax, B.ay, A.ax, A.ay, A.bx, A.by) ||
				onSeg(B.bx, B.by, A.ax, A.ay, A.bx, A.by);
			if (touch) stubTouches++;
		}

	const fail = unresolved.length > 0 || foreignPinHits.length > 0 || stubTouches > 0;
	if (fail) {
		return {
			ok: false,
			nets: nets.length,
			pinRefs: nets.reduce((s, n) => s + n.refs.length, 0),
			stubs: stubs.length,
			unresolved: unresolved.slice(0, 25),
			foreignPinHits: foreignPinHits.slice(0, 25),
			stubTouches,
			note:
				'ABORTED — nothing written. ' +
				(unresolved.length ? `${unresolved.length} netlist pins did not resolve to symbol pins. ` : '') +
				(foreignPinHits.length ? `${foreignPinHits.length} stub(s) would touch a foreign pin. ` : '') +
				(stubTouches ? `${stubTouches} different-net stub pair(s) would touch. ` : '') +
				'Fix the netlist/designators or report this — do not force it.',
		};
	}

	// inject: append stubs, bump HEAD maxId
	const hi = lines.findIndex((l) => l.startsWith('["HEAD"'));
	const head = JSON.parse(lines[hi]);
	let maxId = head[1].maxId;
	const nid = () => 'e' + ++maxId;
	for (const s of stubs) {
		const w = nid();
		lines.push(JSON.stringify(['WIRE', w, [[s.ax, s.ay, s.bx, s.by]], 'st1', 0]));
		lines.push(
			JSON.stringify(['ATTR', nid(), w, 'NET', s.net, 0, 1, Math.round((s.ax + s.bx) / 2), Math.round((s.ay + s.by) / 2), 0, 'st1', 0]),
		);
	}
	head[1].maxId = maxId;
	lines[hi] = JSON.stringify(head);
	const newData = encodeDataStr(lines.join('\n') + '\n');

	copyFileSync(srcEprj, outEprj);
	let sql = `UPDATE documents SET dataStr='${newData}' WHERE uuid='${DOC}';\n`;
	let renamedTo: string | undefined;
	if (newName) {
		const OLD = sqlRead(outEprj, `SELECT uuid FROM projects LIMIT 1;`).trim();
		const NEW = randomBytes(32).toString('hex');
		const esc = newName.replace(/'/g, "''");
		const tables = [
			'schematics',
			'block_symbol_attributes',
			'devices',
			'boards',
			'documents',
			'components',
			'project_logs',
			'texts',
			'components_tmp',
			'project_members',
			'coppers',
			'backups',
		];
		sql += `UPDATE projects SET uuid='${NEW}', name='${esc}', content=REPLACE(content,'${OLD}','${NEW}'), boards=REPLACE(boards,'${OLD}','${NEW}') WHERE uuid='${OLD}';\n`;
		for (const t of tables) sql += `UPDATE ${t} SET project_uuid='${NEW}' WHERE project_uuid='${OLD}';\n`;
		renamedTo = newName;
	}
	sqlExec(outEprj, sql);
	const integrity = sqlRead(outEprj, 'PRAGMA integrity_check;').trim();

	return {
		ok: true,
		nets: nets.length,
		pinRefs: nets.reduce((s, n) => s + n.refs.length, 0),
		stubs: stubs.length,
		unresolved: [],
		foreignPinHits: [],
		stubTouches: 0,
		outputPath: outEprj,
		renamedTo,
		integrity,
		note:
			`Injected ${stubs.length} named wire stubs for ${nets.length} nets (integrity: ${integrity})` +
			(alreadyWired ? '. WARNING: the target sheet already had wires — you may have duplicate stubs.' : '') +
			`. Now OPEN ${renamedTo ? `the "${renamedTo}" project` : 'this file'} in EDA Pro (cold), then verify with sch_get_netlist + sch_run_drc.`,
	};
}

export function registerSchInjectTools(server: McpServer, _bridge: unknown): void {
	server.tool(
		'sch_inject_connectivity',
		'★ Establish REAL schematic connectivity by writing named wire-stubs into the .eprj SQLite (the extension write API cannot — setNetlist no-ops and API wires stay inert). EDA Pro computes the netlist from the injected geometry when it OPENS the file, so after this call you must open/reopen the resulting project. Feed a Protel2 netlist (path preferred) and the target schematic PAGE uuid (from get_project). SAFETY: this writes a .eprj file directly; by default it writes a NEW project copy (outputName) which is safe while EDA Pro is open. In-place (inPlace:true) overwrites the source .eprj and REQUIRES EDA Pro to be closed first (it overwrites on save / can corrupt an open file) — back up first. Runs geometric self-checks (no stub touches a foreign pin; no two different-net stubs touch) and refuses to write if they fail. Returns {ok, nets, stubs, outputPath, integrity, note}.',
		{
			schematicPageUuid: z
				.string()
				.describe('UUID of the target schematic PAGE (the "Schematic Page" node from get_project, e.g. Iris Wand = 6b7beda30e0b4092ac1eeda4391d0d55). Must be a net-less sheet.'),
			netlist: z.string().optional().describe('Protel2 netlist string. Provide EITHER this OR `path`.'),
			path: z.string().optional().describe('Absolute path to a Protel2 netlist file the server reads from disk (preferred; avoids token limits & preserves formatting).'),
			projectName: z
				.string()
				.optional()
				.describe('Project name whose .eprj to inject into (resolved as <projectsDir>/<projectName>.eprj). Get it from get_editor_context.projectName. Ignored if `eprjPath` is given.'),
			eprjPath: z.string().optional().describe('Explicit absolute path to the source .eprj. Overrides projectName/projectsDir.'),
			projectsDir: z
				.string()
				.optional()
				.describe('Directory holding .eprj projects (default ~/Documents/EasyEDA-Pro/projects).'),
			outputName: z
				.string()
				.optional()
				.describe('Name for the output copy project (written as <projectsDir>/<outputName>.eprj with a fresh project UUID). Default "<source>-NETMAP". Ignored when inPlace:true.'),
			inPlace: z
				.boolean()
				.optional()
				.describe('Overwrite the source .eprj itself instead of writing a copy. REQUIRES EDA Pro closed + a backup. Default false (safe copy).'),
		},
		async ({ schematicPageUuid, netlist: netlistArg, path, projectName, eprjPath, projectsDir, outputName, inPlace }) => {
			let netlist: string;
			try {
				netlist = resolveNetlistInput(netlistArg, path);
			} catch (err) {
				return textResult({ ok: false, error: String((err as Error)?.message ?? err) });
			}
			const dir = expandPath(projectsDir ?? '~/Documents/EasyEDA-Pro/projects');
			let src: string;
			if (eprjPath) src = expandPath(eprjPath);
			else if (projectName) src = nodeResolve(dir, `${projectName}.eprj`);
			else return textResult({ ok: false, error: 'Provide `eprjPath` or `projectName` to locate the source .eprj.' });

			const base = src.replace(/\.eprj$/i, '').split('/').pop() ?? 'project';
			let out: string;
			let newName: string | undefined;
			if (inPlace) {
				out = src;
			} else {
				newName = outputName ?? `${base}-NETMAP`;
				out = nodeResolve(dir, `${newName}.eprj`);
			}
			try {
				const result = injectConnectivity({ srcEprj: src, outEprj: out, schematicPageUuid, netlist, newName });
				return textResult(result);
			} catch (err) {
				return textResult({ ok: false, error: String((err as Error)?.message ?? err) });
			}
		},
	);
}
