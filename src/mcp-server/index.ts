import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { WebSocketBridge } from './bridge';
import { registerReadTools } from './tools/read-tools';
import { registerWriteTools } from './tools/write-tools';
import { registerAnalysisTools } from './tools/analysis-tools';
import { registerSchReadTools } from './tools/sch-read-tools';
import { registerSchWriteTools } from './tools/sch-write-tools';
import { registerSchInjectTools } from './tools/sch-inject';
import { registerLibTools } from './tools/lib-tools';
import { registerManufactureTools } from './tools/manufacture-tools';
import { registerPcbDrcTools } from './tools/pcb-drc-tools';
import { registerPcbLayerTools } from './tools/pcb-layer-tools';
import { registerPourFillTools } from './tools/pour-fill-tools';
import { textResult } from './tools/util';

const WS_PORT = Number(process.env.EDA_WS_PORT) || 15168;

async function main() {
	const bridge = new WebSocketBridge(WS_PORT);
	await bridge.start();

	const server = new McpServer({
		name: 'easyeda-agent-mcp-server',
		version: '1.0.0',
	});

	registerReadTools(server, bridge);
	registerWriteTools(server, bridge);
	registerAnalysisTools(server, bridge);
	registerSchReadTools(server, bridge);
	registerSchWriteTools(server, bridge);
	registerSchInjectTools(server, bridge);
	registerLibTools(server, bridge);
	registerManufactureTools(server, bridge);
	registerPcbDrcTools(server, bridge);
	registerPcbLayerTools(server, bridge);
	registerPourFillTools(server, bridge);

	// System tools
	server.tool(
		'get_editor_context',
		'Check which EDA Pro editor is active and what is connected. Reports `editorType`/`schematicAvailable`/`pcbAvailable` (the ACTIVE document of the answering instance) plus `connectedEditors` (all editor clients the bridge sees) and `clientCount`. If a write fails with "make sure a … tab is focused", call set_active_editor(<uuid>) to activate the target document. NOTE: `editorType` reflects the active document; after a reconnect it may lag until something activates the intended editor — trust `connectedEditors` for what is reachable.',
		{},
		async () => {
			let ext: Record<string, unknown> = {};
			try {
				ext = (await bridge.send('sys.getEditorContext')) as Record<string, unknown>;
			} catch (err) {
				ext = { connected: bridge.isConnected(), error: String((err as Error)?.message ?? err) };
			}
			// Authoritative from the bridge: which editor client types are actually connected.
			const connectedEditors = Array.from(new Set(bridge.getConnectedEditorTypes()));
			return textResult({ ...ext, connectedEditors, clientCount: bridge.getClientCount() });
		},
	);

	server.tool(
		'bridge_diagnose',
		'Low-level diagnostic battery for the extension↔editor binding. Run this (ideally with the PCB or schematic canvas focused) when editor commands hang or report a non-editor context. Reports which eda.* namespaces exist and, for each of getCurrentDocumentInfo / getCurrentProjectInfo / getSplitScreenTree / pcb.net.getAllNetsName: whether it succeeded, how long it took (ms), and its value or error — so you can see exactly where the editor-context binding breaks (e.g. the instance can enumerate tabs via getSplitScreenTree but getCurrentDocumentInfo returns null and pcb.net hangs). Does not go through the editor preflight.',
		{},
		async () => {
			const result = await bridge.send('sys.diagnose');
			return textResult(result);
		},
	);

	server.tool(
		'set_active_editor',
		'Bring a document (schematic page or PCB) to the foreground AND make it the ACTIVE editor so subsequent sch_*/pcb_* WRITES target it. This is the fix when writes fail with "make sure a … tab is focused" (e.g. after a reconnect the active-document pointer is stale): openDocument alone opens a tab but does not activate it — this opens then calls activateDocument. Pass the document UUID from get_project (the schematic PAGE uuid or the PCB uuid).',
		{
			documentUuid: z.string().describe('UUID of the schematic page or PCB to activate (from get_project)'),
		},
		async ({ documentUuid }) => {
			const result = await bridge.send('sys.editor.setActiveDocument', { documentUuid });
			return textResult(result);
		},
	);

	server.tool(
		'get_connection_status',
		`Check EDA Pro connection status, which editors are connected, session uptime, and current project info.
Returns: connected, clientCount, sessions (per editor: type, project name/uuid, connected time, last activity).
Call this first to understand what is open before issuing sch_* or pcb_* commands.`,
		{},
		async () => {
			const connected = bridge.isConnected();
			const clientCount = bridge.getClientCount();
			const sessions = bridge.getSessionInfo();
			const now = Date.now();
			const enriched = sessions.map(s => ({
				editorType: s.editorType,
				projectName: s.projectInfo?.name,
				projectUuid: s.projectInfo?.uuid,
				documents: s.projectInfo?.documents,
				connectedAgoSeconds: Math.round((now - s.connectedAt) / 1000),
				lastActivityAgoSeconds: Math.round((now - s.lastActivityAt) / 1000),
			}));
			return {
				content: [{
					type: 'text',
					text: JSON.stringify({ connected, clientCount, sessions: enriched }, null, 2),
				}],
			};
		},
	);

	// Project management tools
	server.tool(
		'get_project',
		`Get detailed info about the currently open EasyEDA Pro project: name, UUID, and all documents (schematics, PCBs, panels) with their UUIDs.
Use this at the start of a session to understand what project is loaded and get UUIDs needed to open specific documents.`,
		{},
		async () => {
			const result = await bridge.send('sys.project.getCurrent');
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);

	server.tool(
		'open_project',
		'Open an EasyEDA Pro project by its UUID. WARNING: this will switch the active project — unsaved changes in the current project will be lost.',
		{
			projectUuid: z.string().describe('Project UUID to open'),
		},
		async ({ projectUuid }) => {
			const result = await bridge.send('sys.project.open', { projectUuid });
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);

	server.tool(
		'rename',
		`Rename the current project, or a schematic / schematic page / PCB / board in the open EasyEDA Pro project.
Use get_project first to obtain the UUID (or, for a board, its current name).
- target "project": renames the current project's friendly name (no uuid needed). NOTE: the underlying SDK call is unofficial and typically returns false / no-ops for the currently-open project — schematic/schematicPage/pcb/board renames work reliably, project rename often does not.
- target "schematic" / "schematicPage" / "pcb": pass the matching UUID from get_project.
- target "board": pass originalBoardName (the board's current name).
Returns true on success.`,
		{
			target: z.enum(['project', 'schematic', 'schematicPage', 'pcb', 'board']).describe('What to rename'),
			newName: z.string().describe('The new name'),
			uuid: z.string().optional().describe('UUID of the schematic / schematicPage / pcb (from get_project). Not used for project or board.'),
			originalBoardName: z.string().optional().describe('For target "board": the board\'s current name.'),
		},
		async ({ target, newName, uuid, originalBoardName }) => {
			let result: unknown;
			switch (target) {
				case 'project':
					result = await bridge.send('sys.project.rename', { newName });
					break;
				case 'schematic':
					result = await bridge.send('sys.schematic.rename', { schematicUuid: uuid, newName });
					break;
				case 'schematicPage':
					result = await bridge.send('sys.schematicPage.rename', { schematicPageUuid: uuid, newName });
					break;
				case 'pcb':
					result = await bridge.send('sys.pcb.rename', { pcbUuid: uuid, newName });
					break;
				case 'board':
					result = await bridge.send('sys.board.rename', { originalBoardName, newName });
					break;
				default:
					throw new Error(`Unknown rename target: ${target}`);
			}
			return { content: [{ type: 'text', text: JSON.stringify({ target, newName, result }, null, 2) }] };
		},
	);

	server.tool(
		'open_document',
		`Open a document (schematic page, PCB, or panel) in the EasyEDA Pro editor by UUID and ACTIVATE it (bring to foreground + make it the active editor, so writes target it). Get UUIDs from get_project. Optionally place it in a specific split-screen pane (use get_split_screen_tree to find pane IDs). Returns {tabId, activated}. (To only activate an already-open doc, set_active_editor does the same open+activate.)`,
		{
			documentUuid: z.string().describe('UUID of the schematic page, PCB, or panel to open'),
			splitScreenId: z.string().optional().describe('Optional split-screen pane ID to open the document in'),
		},
		async ({ documentUuid, splitScreenId }) => {
			const result = await bridge.send('sys.document.open', { documentUuid, splitScreenId });
			return textResult(result);
		},
	);

	server.tool(
		'open_schematic_and_pcb_side_by_side',
		`Open the current project's schematic and PCB in a vertical split-screen layout.
Automatically finds the first schematic page and first PCB in the project.
Optionally specify exact UUIDs to open specific documents.
Returns the project name, document UUIDs, and split-screen arrangement.`,
		{
			schematicPageUuid: z.string().optional().describe('Optional: specific schematic page UUID (uses first page if omitted)'),
			pcbUuid: z.string().optional().describe('Optional: specific PCB UUID (uses first PCB if omitted)'),
		},
		async (params) => {
			const result = await bridge.send('sys.project.openSideBySide', params);
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);

	server.tool(
		'get_split_screen_tree',
		'Get the current editor split-screen layout — shows all open tabs and how they are arranged in panes. Use this to find split-screen IDs for opening documents in specific panes.',
		{},
		async () => {
			const result = await bridge.send('sys.editor.getSplitScreenTree');
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);

	const transport = new StdioServerTransport();
	await server.connect(transport);

	console.error('[MCP] EasyEDA Agent MCP Server started');
	console.error(`[MCP] WebSocket Server on port ${WS_PORT}, waiting for EDA Pro Extension...`);

	// Shut down cleanly once, no matter how the exit is triggered.
	let shuttingDown = false;
	const shutdown = async (reason: string) => {
		if (shuttingDown) return;
		shuttingDown = true;
		console.error(`[MCP] Shutting down (${reason})`);
		try { await bridge.stop(); } catch { /* ignore */ }
		process.exit(0);
	};

	// When a newer Claude session wants the port, relinquish it so it can take over.
	bridge.onTakeover = () => { void shutdown('takeover by newer session'); };

	process.on('SIGINT', () => void shutdown('SIGINT'));
	process.on('SIGTERM', () => void shutdown('SIGTERM'));

	// The MCP client (Claude session) talks to us over stdio. When the session
	// ends, Claude closes our stdin — but the WebSocket server + ping intervals
	// keep the event loop alive, so the process would otherwise orphan and keep
	// holding port 15168. Exit when stdin closes so the server dies WITH the
	// session and the port frees for the next one.
	transport.onclose = () => void shutdown('stdio transport closed');
	process.stdin.on('end', () => void shutdown('stdin end'));
	process.stdin.on('close', () => void shutdown('stdin close'));
}

main().catch((err) => {
	console.error('[MCP] Fatal error:', err);
	process.exit(1);
});
