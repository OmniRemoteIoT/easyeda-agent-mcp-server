import { componentHandlers } from './handlers/component';
import { trackHandlers } from './handlers/track';
import { viaHandlers } from './handlers/via';
import { netHandlers } from './handlers/net';
import { drcHandlers } from './handlers/drc';
import { documentHandlers } from './handlers/document';
import { schComponentHandlers } from './handlers/sch-component';
import { schWireHandlers } from './handlers/sch-wire';
import { schDocumentHandlers } from './handlers/sch-document';
import { schSelectHandlers } from './handlers/sch-select';
import { schPrimitiveHandlers } from './handlers/sch-primitive';
import { libraryHandlers } from './handlers/library';
import { pourFillHandlers } from './handlers/pour-fill';
import { manufactureHandlers } from './handlers/manufacture';
import { layerHandlers } from './handlers/layer';
import { pcbPrimitiveHandlers } from './handlers/pcb-primitive';
import { projectHandlers } from './handlers/project';

const WS_URL = 'ws://localhost:15168';

// After this many ms of no incoming commands, show an idle notification in EDA Pro
const IDLE_NOTIFY_MS = 30 * 60 * 1000; // 30 minutes

// How often to send a heartbeat ping to the server.
const HEARTBEAT_MS = 10 * 1000;
// If no frame at all (including the heartbeat pong) arrives within this window,
// treat the connection as dead and reconnect. The EDA WebSocket API exposes no
// onClose/onError callback and send() does not throw on a silently-dropped
// socket, so staleness is the only reliable way to detect a server that went away.
const STALE_MS = 25 * 1000;

/** Detect which editor context this extension instance is running in. */
function detectEditorType(): 'schematic' | 'pcb' | 'unknown' {
	try {
		// sch_Document exists only in schematic editor context
		if ((eda as any).sch_Document) return 'schematic';
	} catch { /* not schematic */ }
	try {
		// pcb_Document exists only in PCB editor context
		if ((eda as any).pcb_Document) return 'pcb';
	} catch { /* not pcb */ }
	return 'unknown';
}

/**
 * Detect the editor type for the identify message.
 *
 * There is no working runtime API to read the active document's type
 * (`getCurrentDocumentInfo` does not exist in the EDA Pro runtime), and the
 * namespace-presence check (`detectEditorType`) always reports 'schematic' because
 * `eda.sch_Document` is a globally-present object. Since this is a SINGLE global
 * extension instance that can drive both editors, editor-type routing is unnecessary —
 * report 'unknown' and let the bridge's single-client fallback route everything.
 */
async function detectEditorTypeReliable(): Promise<'schematic' | 'pcb' | 'unknown'> {
	return 'unknown';
}

/** Use a unique WS_ID per editor type so both can coexist without conflict. */
function getWsId(): string {
	const type = detectEditorType();
	return type === 'unknown' ? 'mcp-bridge' : `mcp-bridge-${type}`;
}

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 2000;
let activeExtensionUuid = '';
/** WS_ID of the currently-registered socket, so we can re-send identify frames. */
let currentWsId = '';
/** Last editorType we told the bridge, to avoid redundant re-identify frames. */
let lastIdentifiedType: EditorType = 'unknown';

type EditorType = 'schematic' | 'pcb' | 'unknown';

/**
 * Re-send the identify frame if our detected editor type has changed (e.g. it was
 * 'unknown' at connect time and resolved later). Keeps the bridge's per-client
 * editorType — which drives sch/pcb command routing and get_editor_context's
 * connectedEditors — in sync with reality after a reconnect.
 */
function reIdentify(editorType: EditorType): void {
	if (editorType === 'unknown' || editorType === lastIdentifiedType || !currentWsId || !activeExtensionUuid) return;
	try {
		eda.sys_WebSocket.send(currentWsId, JSON.stringify({ type: 'identify', editorType }), activeExtensionUuid);
		lastIdentifiedType = editorType;
	} catch { /* non-fatal */ }
}
/** Timestamp of the last frame received from the server — used for staleness detection. */
let lastMessageAt = 0;
/** True after the first successful connect — prevents repeated auto-open on reconnects. */
let pairedDocumentOpened = false;
/** True once the window-focus reconnect listener is registered (register only once). */
let focusReconnectRegistered = false;

/**
 * Reconnect when the EasyEDA window regains focus.
 *
 * While EasyEDA is backgrounded, the OS/Chromium throttles JS timers, so the
 * heartbeat/staleness loop can't detect a dropped socket or reconnect. A drop
 * that happens while backgrounded therefore lingers until the user clicks
 * "Connect Claude". The `focus` window event is NOT throttled, so on regaining
 * focus we do an immediate staleness check and reconnect if needed — recovery
 * becomes automatic the moment the user returns to EasyEDA.
 */
function setupFocusReconnect(extensionUuid: string): void {
	if (focusReconnectRegistered) return;
	try {
		eda.sys_Window.addEventListener('focus' as any, () => {
			if (Date.now() - lastMessageAt > STALE_MS) {
				connectToMcpServer(extensionUuid);
			}
		});
		focusReconnectRegistered = true;
	} catch { /* addEventListener unavailable — non-fatal */ }
}

const rawHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	...componentHandlers,
	...trackHandlers,
	...viaHandlers,
	...netHandlers,
	...drcHandlers,
	...documentHandlers,
	...schComponentHandlers,
	...schWireHandlers,
	...schDocumentHandlers,
	...schSelectHandlers,
	...schPrimitiveHandlers,
	...libraryHandlers,
	...pourFillHandlers,
	...manufactureHandlers,
	...layerHandlers,
	...pcbPrimitiveHandlers,
	...projectHandlers,
};

/**
 * Find the UUID of the first schematic page or first PCB in the current project.
 * Case-insensitive on itemType because the project tree uses mixed case
 * (e.g. "Board", "Schematic", "PCB"), not the uppercase forms.
 */
async function findEditorDocUuid(editorPrefix: 'sch' | 'pcb'): Promise<string | undefined> {
	try {
		const project = await eda.dmt_Project.getCurrentProjectInfo();
		if (!project?.data) return undefined;
		for (const item of project.data) {
			const t = String((item as any).itemType || '').toUpperCase();
			if (editorPrefix === 'pcb') {
				if (t === 'PCB' && (item as any).uuid) return (item as any).uuid;
				if (t === 'BOARD' && (item as any).pcb?.uuid) return (item as any).pcb.uuid;
			} else {
				if (t === 'SCHEMATIC' && (item as any).page?.[0]?.uuid) return (item as any).page[0].uuid;
				if (t === 'BOARD' && (item as any).schematic?.page?.[0]?.uuid) return (item as any).schematic.page[0].uuid;
			}
		}
	} catch { /* non-fatal */ }
	return undefined;
}

/**
 * Given the currently-focused document UUID, find the paired document (schematic
 * page or PCB) of the SAME board. Lets a schematic↔PCB toggle stay on the board the
 * user is actually working on, instead of jumping to the first board in the project.
 */
async function findPairedDocUuid(currentDocUuid: string | undefined, editorPrefix: 'sch' | 'pcb'): Promise<string | undefined> {
	if (!currentDocUuid) return undefined;
	try {
		const project = await eda.dmt_Project.getCurrentProjectInfo();
		if (!project?.data) return undefined;
		for (const item of project.data) {
			const t = String((item as any).itemType || '').toUpperCase();
			if (t !== 'BOARD') continue;
			const board = item as any;
			const schPages: any[] = board.schematic?.page ?? [];
			const pcbUuid: string | undefined = board.pcb?.uuid;
			const belongsToThisBoard = pcbUuid === currentDocUuid || schPages.some((p) => p?.uuid === currentDocUuid);
			if (belongsToThisBoard) {
				return editorPrefix === 'pcb' ? pcbUuid : schPages[0]?.uuid;
			}
		}
	} catch { /* non-fatal */ }
	return undefined;
}

/**
 * Ensure the correct KIND of editor (schematic vs PCB) is active before a command,
 * so one connection can drive both — WITHOUT hijacking a multi-board project.
 *
 * documentType: 1 = SCHEMATIC_PAGE, 3 = PCB (EDMT_EditorDocumentType).
 * - If the focused tab is already the right editor type, DO NOTHING. This is critical:
 *   the user may have any board's schematic focused; force-switching to the first
 *   board's schematic (the old behavior) read/wrote the wrong board and yanked the UI.
 * - Only when the focused tab is the WRONG type do we switch — preferring the paired
 *   document of the current board, falling back to the first board's matching doc.
 */
/** Reject if `p` doesn't settle within `ms` — turns a hung EDA API call into a fast error. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	return Promise.race([
		p,
		new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} did not respond within ${ms}ms`)), ms)),
	]);
}

/**
 * Wrap handlers with a light error hint.
 *
 * IMPORTANT (v1.2.7): earlier versions gated every sch./pcb. command on
 * `eda.dmt_EditorControl.getCurrentDocumentInfo()` to detect/switch/verify the active
 * editor. That method DOES NOT EXIST in the EDA Pro runtime — it throws
 * "getCurrentDocumentInfo is not a function" (confirmed via bridge_diagnose). Meanwhile
 * the editor APIs themselves (`pcb_*` / `sch_*`, e.g. `pcb_Net.getAllNetsName`) work
 * directly on their document with no activation. So the detection/focus/preflight
 * machinery was pure dead weight — and the v1.2.5 preflight was actively BLOCKING every
 * editor command. We now just run the handler and surface the raw error.
 */
function wrapHandler(
	method: string,
	handler: (params: Record<string, any>) => Promise<any>,
): (params: Record<string, any>) => Promise<any> {
	return async (params) => {
		try {
			return await handler(params);
		} catch (err: any) {
			const msg = err instanceof Error ? err.message : String(err);
			if (method.startsWith('sch.') || method.startsWith('pcb.')) {
				const kind = method.startsWith('pcb.') ? 'PCB' : 'schematic';
				throw new Error(`${msg} — (${kind} command failed. If it mentions a focused tab, click into the ${kind} canvas in EasyEDA Pro and retry; otherwise this is the raw API error, e.g. bad parameters/layer name.)`);
			}
			throw err;
		}
	};
}

const allHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {};
for (const [method, handler] of Object.entries(rawHandlers)) {
	allHandlers[method] = wrapHandler(method, handler);
}

// Editor context — reports whether the editor APIs are reachable and the project.
// There is no working runtime call for the ACTIVE document's type (getCurrentDocumentInfo
// is missing), so editorType stays 'unknown'; reachability is proven by getCurrentProjectInfo
// (which works) instead. This is a single instance that can drive both editors directly, so
// schematicAvailable/pcbAvailable are both reported from reachability, not per-editor.
allHandlers['sys.getEditorContext'] = async () => {
	let editorContextHealthy = false;
	let projectName: string | undefined;
	try {
		const projectInfo = await withTimeout(eda.dmt_Project.getCurrentProjectInfo(), 4000, 'getCurrentProjectInfo');
		if (projectInfo != null) {
			editorContextHealthy = true;
			projectName = projectInfo.friendlyName;
		}
	} catch { /* project unreachable — editor context not healthy */ }

	return {
		connected: true,
		// Cannot read the active document's type in this runtime — 'unknown' by design.
		editorType: 'unknown',
		// The single instance reaches the pcb_*/sch_* APIs directly; availability tracks
		// overall reachability rather than which canvas is focused.
		schematicAvailable: editorContextHealthy,
		pcbAvailable: editorContextHealthy,
		editorContextHealthy,
		...(editorContextHealthy
			? {}
			: { hint: 'Editor APIs unreachable (getCurrentProjectInfo failed) — reconnect via Claude > Connect Claude in EasyEDA Pro.' }),
		projectName,
	};
};

// Low-level diagnostic battery — bypasses the editor preflight on purpose. Run this live
// (e.g. with the PCB focused) to pinpoint WHERE the editor-context binding breaks: which
// eda.* namespaces exist, whether getCurrentDocumentInfo returns a doc or null/hangs,
// whether the extension can still enumerate open tabs (getSplitScreenTree) even when the
// "current document" is null, and whether a trivial editor read (pcb.net) hangs.
allHandlers['sys.diagnose'] = async () => {
	const probe = async (label: string, fn: () => any, ms = 4000) => {
		const t0 = Date.now();
		try {
			const v = await withTimeout(Promise.resolve().then(fn), ms, label);
			return { ok: true, ms: Date.now() - t0, value: summarizeProbe(v) };
		} catch (e: any) {
			return { ok: false, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
		}
	};
	const e = eda as any;
	// Enumerate the REAL runtime methods on an object (own + prototype chain) so we can
	// discover the correct API names (the type package and the runtime disagree — e.g.
	// getCurrentDocumentInfo is typed but missing at runtime).
	const methodsOf = (obj: any): string[] => {
		const out = new Set<string>();
		for (let o = obj; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
			for (const n of Object.getOwnPropertyNames(o)) {
				try { if (typeof obj[n] === 'function' && n !== 'constructor') out.add(n); } catch { /* getter threw */ }
			}
		}
		return [...out].sort();
	};
	return {
		namespaces: {
			sch_Document: typeof e.sch_Document,
			pcb_Document: typeof e.pcb_Document,
			pcb_Net: typeof e.pcb_Net,
			dmt_EditorControl: typeof e.dmt_EditorControl,
			dmt_Project: typeof e.dmt_Project,
		},
		// The real method names available at runtime — use these to find the active-doc API.
		dmtEditorControlMethods: (() => { try { return methodsOf(e.dmt_EditorControl); } catch { return null; } })(),
		getCurrentDocumentInfo: await probe('getCurrentDocumentInfo', () => e.dmt_EditorControl?.getCurrentDocumentInfo?.()),
		getCurrentProjectInfo: await probe('getCurrentProjectInfo', () => eda.dmt_Project.getCurrentProjectInfo()),
		// Full split-screen tree (untruncated) — the tabs list every open document + tabId.
		getSplitScreenTree: await probe('getSplitScreenTree', () => eda.dmt_EditorControl.getSplitScreenTree(), 4000),
		splitScreenTreeRaw: await (async () => { try { return await withTimeout(eda.dmt_EditorControl.getSplitScreenTree(), 4000, 'tree'); } catch (e2: any) { return { error: String(e2?.message ?? e2) }; } })(),
		pcbNetNames: await probe('pcb.net.getAllNetsName', () => e.pcb_Net?.getAllNetsName?.(), 6000),
	};
};

/** Compact, JSON-safe summary of a probe value (avoid dumping huge objects). */
function summarizeProbe(v: any): unknown {
	if (v == null) return v;
	if (Array.isArray(v)) return { array: true, length: v.length, sample: v.slice(0, 5) };
	if (typeof v === 'object') {
		const o = v as Record<string, any>;
		if ('documentType' in o || 'uuid' in o) return { documentType: o.documentType, uuid: o.uuid, title: o.title };
		if ('friendlyName' in o) return { friendlyName: o.friendlyName, uuid: o.uuid, dataCount: Array.isArray(o.data) ? o.data.length : undefined };
		const keys = Object.keys(o);
		return { keys: keys.slice(0, 12), keyCount: keys.length };
	}
	return v;
}

// Heartbeat response so the bridge can detect dead connections
allHandlers['sys.ping'] = async () => ({ pong: true });

/**
 * When connecting from one editor, auto-open the paired document in the other editor.
 * Schematic → opens first PCB; PCB → opens first schematic page.
 * EDA Pro will load the new tab and the extension auto-connects from within it.
 */
async function openPairedDocument(editorType: 'schematic' | 'pcb' | 'unknown'): Promise<void> {
	if (editorType === 'unknown') return;
	try {
		// Connected from schematic → open the first PCB; from PCB → open the first schematic page.
		const targetUuid = await findEditorDocUuid(editorType === 'schematic' ? 'pcb' : 'sch');
		if (targetUuid) {
			await eda.dmt_EditorControl.openDocument(targetUuid);
		}
	} catch { /* non-fatal — paired document open is best-effort */ }
}

function stopHeartbeat(): void {
	if (heartbeatTimer !== null) {
		clearInterval(heartbeatTimer);
		heartbeatTimer = null;
	}
}

function cancelReconnect(): void {
	if (reconnectTimer !== null) {
		clearTimeout(reconnectTimer);
		reconnectTimer = null;
	}
}

function resetIdleTimer(extensionUuid: string, wsId: string): void {
	if (idleTimer !== null) {
		clearTimeout(idleTimer);
	}
	idleTimer = setTimeout(() => {
		idleTimer = null;
		const editorType = detectEditorType();
		const label = editorType === 'unknown' ? '' : ` (${editorType})`;
		eda.sys_Message.showWarningMessage(
			`Claude MCP connection${label} has been idle for 30 minutes. Use Claude > Disconnect Claude if you are done working.`,
		);
	}, IDLE_NOTIFY_MS);
}

function scheduleReconnect(extensionUuid: string): void {
	stopHeartbeat();
	if (reconnectTimer !== null) return; // an attempt is already scheduled
	const delay = reconnectDelay;
	reconnectDelay = Math.min(reconnectDelay * 2, 30000);
	reconnectTimer = setTimeout(() => {
		reconnectTimer = null;
		connectToMcpServer(extensionUuid);
		// Re-arm the loop. Because the API has no onClose callback, a failed attempt
		// gives no signal — so keep retrying on the backoff schedule until a successful
		// connect cancels this via cancelReconnect() in the connected callback.
		scheduleReconnect(extensionUuid);
	}, delay);
}

export function connectToMcpServer(extensionUuid: string): void {
	stopHeartbeat();
	activeExtensionUuid = extensionUuid;
	setupFocusReconnect(extensionUuid);

	const WS_ID = getWsId();
	currentWsId = WS_ID;
	lastIdentifiedType = 'unknown';
	let editorType = detectEditorType();

	// Close any existing connection before re-registering to avoid duplicate listeners
	try {
		eda.sys_WebSocket.close(WS_ID, undefined, undefined, extensionUuid);
	} catch { /* ignore — may not be open */ }

	eda.sys_WebSocket.register(
		WS_ID,
		WS_URL,
		async (event: MessageEvent<any>) => {
			// Any inbound frame proves the connection is alive — feeds staleness detection.
			lastMessageAt = Date.now();
			let id: string | undefined;
			try {
				const message = typeof event.data === 'string' ? event.data : String(event.data);
				const request = JSON.parse(message);
				id = request.id;
				const method: string = request.method;
				const params: Record<string, any> = request.params || {};

				// Frames without a method are server responses (e.g. heartbeat pongs) — ack silently.
				if (!method) {
					return;
				}

				// Reset idle timer on every incoming command (not pings)
				if (method !== 'sys.ping') {
					resetIdleTimer(extensionUuid, WS_ID);
				}

				const handler = allHandlers[method];
				if (!handler) {
					sendResponse(extensionUuid, WS_ID, id!, undefined, `Unknown method: ${method}`);
					return;
				}

				const result = await handler(params);
				sendResponse(extensionUuid, WS_ID, id!, result);
			} catch (err: any) {
				const errorMsg = err instanceof Error ? err.message : String(err);
				if (id) {
					sendResponse(extensionUuid, WS_ID, id, undefined, errorMsg);
				}
			}
		},
		async () => {
			// Successful connection — reset backoff and cancel any pending reconnect loop
			reconnectDelay = 2000;
			lastMessageAt = Date.now();
			cancelReconnect();
			// Re-detect now (with retry) — the type captured synchronously at register()
			// time is often still 'unknown' because the editor APIs aren't populated yet.
			const resolvedType = await detectEditorTypeReliable();
			if (resolvedType !== 'unknown') editorType = resolvedType;
			const label = editorType === 'unknown' ? '' : ` (${editorType})`;
			eda.sys_Message.showMessage(`Connected to Claude MCP Server${label}`);
			// If we can't see an active editor document, the bridge bound to a background/
			// non-editor context — warn proactively so the user re-connects from the editor
			// menu instead of hitting hung reads/writes later.
			if (resolvedType === 'unknown') {
				try {
					eda.sys_Message.showWarningMessage(
						'Claude connected, but NOT to an editor context — PCB/schematic commands will fail. Click into the PCB or schematic canvas and run Claude > Connect Claude from that editor to re-bind.',
					);
				} catch { /* non-fatal */ }
			}

			// Gather project info to send with the identify message
			let projectInfo: Record<string, any> | undefined;
			try {
				const info = await eda.dmt_Project.getCurrentProjectInfo();
				if (info) {
					projectInfo = {
						uuid: info.uuid,
						name: info.friendlyName,
						// Include document UUIDs so the bridge knows what's in this project
						documents: info.data?.map((item: any) => ({
							type: item.itemType,
							uuid: item.uuid,
							name: item.name || item.friendlyName,
							pages: item.page?.map((p: any) => ({ uuid: p.uuid, name: p.name })),
						})),
					};
				}
			} catch { /* non-fatal */ }

			// Send editor identity + project context so the bridge can route commands correctly
			try {
				eda.sys_WebSocket.send(
					WS_ID,
					JSON.stringify({ type: 'identify', editorType, projectInfo }),
					extensionUuid,
				);
			} catch { /* non-fatal */ }

			// Auto-open the paired document (PCB↔schematic) on first connect only
			if (!pairedDocumentOpened) {
				pairedDocumentOpened = true;
				openPairedDocument(editorType);
			}

			// Start idle timer
			resetIdleTimer(extensionUuid, WS_ID);

			// Heartbeat every HEARTBEAT_MS. Two ways to notice a dead server:
			//   1. no frame (including the pong) has arrived within STALE_MS, or
			//   2. send() throws synchronously (rare).
			// The API has no onClose callback, so (1) is the primary detector.
			stopHeartbeat();
			heartbeatTimer = setInterval(() => {
				if (Date.now() - lastMessageAt > STALE_MS) {
					scheduleReconnect(extensionUuid);
					return;
				}
				try {
					eda.sys_WebSocket.send(
						WS_ID,
						JSON.stringify({ id: `hb-${Date.now()}`, method: 'sys.ping', params: {} }),
						extensionUuid,
					);
				} catch {
					scheduleReconnect(extensionUuid);
				}
			}, HEARTBEAT_MS);
		},
	);
}

function sendResponse(extensionUuid: string, wsId: string, id: string, result?: any, error?: string): void {
	const response: Record<string, any> = { id };
	if (error) {
		response.error = error;
	} else {
		response.result = result;
	}
	eda.sys_WebSocket.send(wsId, JSON.stringify(response), extensionUuid);
}

export function disconnectFromMcpServer(extensionUuid: string): void {
	stopHeartbeat();
	cancelReconnect();
	if (idleTimer !== null) {
		clearTimeout(idleTimer);
		idleTimer = null;
	}
	pairedDocumentOpened = false;
	const WS_ID = getWsId();
	try {
		eda.sys_WebSocket.close(WS_ID, undefined, undefined, extensionUuid);
	} catch {
		// Ignore close errors
	}
}
