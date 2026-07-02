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
 * Detect the editor type, retrying briefly because `eda.sch_Document` /
 * `eda.pcb_Document` are not always populated the instant the socket connects —
 * detecting too early yielded editorType "unknown", which broke sch/pcb routing.
 */
async function detectEditorTypeReliable(retries = 8, delayMs = 250): Promise<'schematic' | 'pcb' | 'unknown'> {
	for (let i = 0; i < retries; i++) {
		const sync = detectEditorType();
		if (sync !== 'unknown') return sync;
		// Authoritative fallback: the current document's type (1 = schematic page, 3 = PCB).
		try {
			const info = await eda.dmt_EditorControl.getCurrentDocumentInfo();
			const dt = (info as any)?.documentType;
			if (dt === 1) return 'schematic';
			if (dt === 3) return 'pcb';
		} catch { /* not ready yet */ }
		await new Promise((r) => setTimeout(r, delayMs));
	}
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
/** Timestamp of the last frame received from the server — used for staleness detection. */
let lastMessageAt = 0;
/** True after the first successful connect — prevents repeated auto-open on reconnects. */
let pairedDocumentOpened = false;

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
 * Bring the schematic/PCB tab to the foreground before running a command.
 * EDA Pro requires the relevant tab to be active for most read/write APIs.
 * openDocument() on the current doc UUID re-activates it without side effects.
 */
async function focusEditorTab(editorPrefix: 'sch' | 'pcb'): Promise<void> {
	try {
		const docInfo = await eda.dmt_EditorControl.getCurrentDocumentInfo();
		if (!docInfo?.uuid) return;
		// documentType: 1 = SCHEMATIC_PAGE, 3 = PCB (EDMT_EditorDocumentType).
		// If the active tab is already the editor we need, do nothing — re-opening the
		// document on every command thrashed the editor and dropped the WebSocket.
		const dt = (docInfo as any).documentType;
		if (editorPrefix === 'sch' && dt === 1) return;
		if (editorPrefix === 'pcb' && dt === 3) return;
		await eda.dmt_EditorControl.openDocument(docInfo.uuid);
	} catch { /* non-fatal */ }
}

// Wrap handlers with context-aware error messages and auto-focus
function wrapHandler(
	method: string,
	handler: (params: Record<string, any>) => Promise<any>,
): (params: Record<string, any>) => Promise<any> {
	return async (params) => {
		// Auto-focus the correct editor tab before running editor-specific commands
		if (method.startsWith('sch.')) {
			await focusEditorTab('sch');
		} else if (method.startsWith('pcb.')) {
			await focusEditorTab('pcb');
		}
		try {
			return await handler(params);
		} catch (err: any) {
			const msg = err instanceof Error ? err.message : String(err);
			if (method.startsWith('sch.')) {
				throw new Error(`${msg} — Make sure a schematic editor tab is focused in EasyEDA Pro. Switch to a schematic tab and retry.`);
			} else if (method.startsWith('pcb.')) {
				throw new Error(`${msg} — Make sure a PCB editor tab is focused in EasyEDA Pro. Switch to a PCB tab and retry.`);
			}
			throw err;
		}
	};
}

const allHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {};
for (const [method, handler] of Object.entries(rawHandlers)) {
	allHandlers[method] = wrapHandler(method, handler);
}

// Editor context detection — reports which editor type is currently active
allHandlers['sys.getEditorContext'] = async () => {
	const editorType = detectEditorType();
	// Also try to get the current project name for context
	let projectName: string | undefined;
	try {
		const projectInfo = await eda.dmt_Project.getCurrentProjectInfo();
		projectName = projectInfo?.friendlyName;
	} catch { /* non-fatal */ }

	return {
		connected: true,
		editorType,
		schematicAvailable: editorType === 'schematic',
		pcbAvailable: editorType === 'pcb',
		projectName,
	};
};

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
		const project = await eda.dmt_Project.getCurrentProjectInfo();
		if (!project?.data) return;

		let targetUuid: string | undefined;

		if (editorType === 'schematic') {
			// Connected from schematic — open the first PCB
			for (const item of project.data) {
				const t = (item as any).itemType;
				if (t === 'PCB' && (item as any).uuid) {
					targetUuid = (item as any).uuid;
					break;
				}
				if (t === 'BOARD' && (item as any).pcb?.uuid) {
					targetUuid = (item as any).pcb.uuid;
					break;
				}
			}
		} else {
			// Connected from PCB — open the first schematic page
			for (const item of project.data) {
				const t = (item as any).itemType;
				if (t === 'SCHEMATIC' && (item as any).page?.[0]?.uuid) {
					targetUuid = (item as any).page[0].uuid;
					break;
				}
				if (t === 'BOARD' && (item as any).schematic?.page?.[0]?.uuid) {
					targetUuid = (item as any).schematic.page[0].uuid;
					break;
				}
			}
		}

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

	const WS_ID = getWsId();
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
