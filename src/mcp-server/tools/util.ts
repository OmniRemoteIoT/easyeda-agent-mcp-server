import { readFileSync } from 'fs';
import { resolve as nodeResolve } from 'path';
import { homedir } from 'os';

/**
 * Wrap any handler result as a well-formed MCP `text` content block.
 *
 * IMPORTANT: `JSON.stringify(undefined, null, 2)` returns the *value* `undefined`
 * (not the string "undefined"), and functions/symbols do the same. Handlers that
 * resolve to `void` (e.g. EDA Pro's beta `setNetlist`) or single-id lookups that
 * find no match therefore used to emit `{ type:'text', text: undefined }`, which
 * the MCP SDK rejects with:
 *   "Invalid tools/call result: content[0].text expected string, received undefined".
 * This helper guarantees `text` is always a string.
 */
export function textResult(value: unknown): { content: { type: 'text'; text: string }[] } {
	const json = JSON.stringify(value, null, 2);
	const text = json === undefined ? (value === undefined ? 'null' : String(value)) : json;
	return { content: [{ type: 'text', text }] };
}

/**
 * Resolve a netlist payload from EITHER an inline string OR a filesystem path.
 *
 * A real board's netlist is ~150 KB (~40K tokens) with CRLF line endings. It
 * cannot travel as an inline MCP tool argument: the model hits its output-token
 * ceiling while emitting the string, and JSON tool-call encoding normalizes CRLF
 * (`\r\n`) → LF (`\n`), corrupting CRLF-sensitive dialects (Protel2). Reading the
 * file here — in the Node server, off the model's output path — sidesteps both:
 * no token cost, and the bytes reach the API exactly as written on disk.
 *
 * Exactly one of `netlist` / `path` must be provided. `~` is expanded to the home
 * directory; relative paths resolve against the server's cwd (absolute preferred).
 * Throws with an actionable message on bad input or a missing/unreadable file.
 */
export function resolveNetlistInput(netlist?: string, path?: string): string {
	const hasNetlist = typeof netlist === 'string';
	const hasPath = typeof path === 'string' && path.length > 0;
	if (hasNetlist && hasPath) {
		throw new Error('Provide EITHER `netlist` (inline string) OR `path` (file on disk), not both.');
	}
	if (!hasNetlist && !hasPath) {
		throw new Error('No netlist provided — pass `netlist` (inline string) or `path` (file on disk).');
	}
	if (hasNetlist) return netlist as string;

	const raw = path as string;
	const expanded =
		raw === '~' ? homedir() : raw.startsWith('~/') ? nodeResolve(homedir(), raw.slice(2)) : nodeResolve(raw);
	try {
		return readFileSync(expanded, 'utf8');
	} catch (err) {
		const reason = (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'file not found' : String((err as Error)?.message ?? err);
		throw new Error(`Could not read netlist from path "${expanded}": ${reason}. Pass an absolute path to the netlist file.`);
	}
}

export interface NetlistSummary {
	/** 'protel2' when the header/structure parsed cleanly; 'unknown' otherwise (counts left null). */
	format: 'protel2' | 'unknown';
	/** Number of `[ … ]` component blocks, or null if the dialect wasn't parsed. */
	componentCount: number | null;
	/** Number of `( … )` net blocks, or null if the dialect wasn't parsed. */
	netCount: number | null;
	/** Designators from the component blocks (what must exist as footprints on the PCB). */
	designators: string[];
	/** Net names from the net blocks. */
	netNames: string[];
	/** Designators referenced by net pin entries (`U1-40` → `U1`) — a superset check vs. placed parts. */
	referencedDesignators: string[];
}

/**
 * Parse a Protel2 netlist into a lightweight summary used for preflight diagnostics.
 *
 * The Protel2 dialect that `sch_get_netlist(Protel2)` / `pcb_get_netlist(Protel2)`
 * round-trips looks like:
 *   PROTEL NETLIST 2.0
 *   [ DESIGNATOR \n U1 \n PARTTYPE \n … \n FOOTPRINT \n … ]      ← one component block
 *   ( NETNAME \n U1-40 \n C1-1 )                                 ← one net block
 *
 * This is deterministic (the server owns the file bytes), so it lets `pcb_set_netlist`
 * tell the caller *why* an apply failed — "PCB has 0 footprints" or "netlist references
 * U3/U4 which aren't on the PCB" — instead of a generic "check your designators".
 *
 * Only the Protel2 layout is parsed; other dialects (PADS/Allegro/…) return
 * `format:'unknown'` with null counts so the diagnostic degrades to a no-op rather
 * than reporting wrong numbers. Never throws — parsing is best-effort.
 */
export function parseNetlistSummary(netlist: string): NetlistSummary {
	const empty: NetlistSummary = {
		format: 'unknown',
		componentCount: null,
		netCount: null,
		designators: [],
		netNames: [],
		referencedDesignators: [],
	};
	if (typeof netlist !== 'string' || netlist.length === 0) return empty;
	// Tolerate CRLF/LF/CR and stray blank lines.
	const lines = netlist.split(/\r\n|\r|\n/).map((l) => l.trim());
	const isProtel = lines.some((l) => /^PROTEL NETLIST/i.test(l)) || (lines.includes('[') && lines.includes('('));
	if (!isProtel) return empty;

	const designators: string[] = [];
	const netNames: string[] = [];
	const referenced = new Set<string>();
	let componentCount = 0;
	let netCount = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line === '[') {
			componentCount++;
			// Component block: DESIGNATOR is the token whose *next* line is the value.
			for (let j = i + 1; j < lines.length && lines[j] !== ']'; j++) {
				if (lines[j].toUpperCase() === 'DESIGNATOR' && j + 1 < lines.length) {
					const d = lines[j + 1];
					if (d && d !== ']') designators.push(d);
					break;
				}
			}
		} else if (line === '(') {
			netCount++;
			// Net block: first non-empty line is the net name; the rest are `DESIG-PIN` refs.
			let sawName = false;
			for (let j = i + 1; j < lines.length && lines[j] !== ')'; j++) {
				const entry = lines[j];
				if (!entry) continue;
				if (!sawName) {
					netNames.push(entry);
					sawName = true;
				} else {
					// `U1-40` → `U1`; a pad like `U1-A12` still yields `U1` (split on first '-').
					const dash = entry.indexOf('-');
					referenced.add(dash > 0 ? entry.slice(0, dash) : entry);
				}
			}
		}
	}

	return {
		format: 'protel2',
		componentCount,
		netCount,
		designators,
		netNames,
		referencedDesignators: [...referenced],
	};
}

/**
 * Best-effort extraction of a component designator from a bridge-serialized
 * `pcb.getAll.component` entry. The EDA Pro class instance serializes its private
 * fields to plain JSON, so `designator` is normally a top-level string; we also
 * probe a couple of nested/alternate shapes and fall back to null when absent so
 * the caller can distinguish "no designators readable" from "designator missing".
 */
export function extractDesignator(component: unknown): string | null {
	if (!component || typeof component !== 'object') return null;
	const c = component as Record<string, any>;
	const candidate =
		c.designator ??
		c.Designator ??
		c.name ??
		(c.component && typeof c.component === 'object' ? c.component.designator : undefined);
	return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}
