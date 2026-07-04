import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WebSocketBridge } from '../bridge';
import { textResult } from './util';

const DELETE_HANDLER_MAP: Record<string, string> = {
	component: 'pcb.delete.component',
	track: 'pcb.delete.line',
	polyline: 'pcb.delete.polyline',
	via: 'pcb.delete.via',
	pad: 'pcb.delete.pad',
	pour: 'pcb.delete.pour',
	fill: 'pcb.delete.fill',
	arc: 'pcb.delete.arc',
	region: 'pcb.delete.region',
};

const MODIFY_HANDLER_MAP: Record<string, string> = {
	via: 'pcb.modify.via',
	polyline: 'pcb.modify.polyline',
	arc: 'pcb.modify.arc',
	pad: 'pcb.modify.pad',
	pour: 'pcb.modify.pour',
	fill: 'pcb.modify.fill',
	region: 'pcb.modify.region',
};

export function registerWriteTools(server: McpServer, bridge: WebSocketBridge): void {
	// === Create Tools (keep separate — different param schemas) ===

	server.tool(
		'pcb_create_track',
		'Create a single track segment (line) between two points on a specified layer and net. UNITS: all coordinates and widths are in the PCB document\'s current display unit (mil by default, not mm — 1 mil = 0.0254 mm). Check/set the unit selector in EasyEDA to match your intent.',
		{
			net: z.string().describe('Net name for the track'),
			layer: z.string().describe('Layer name (e.g. "TopLayer", "BottomLayer", "InnerLayer1")'),
			startX: z.number().describe('Start X coordinate'),
			startY: z.number().describe('Start Y coordinate'),
			endX: z.number().describe('End X coordinate'),
			endY: z.number().describe('End Y coordinate'),
			lineWidth: z.number().optional().describe('Track width (default uses design rules)'),
		},
		async (params) => {
			const result = await bridge.send('pcb.create.line', params);
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);

	server.tool(
		'pcb_create_polyline_track',
		'Create a multi-segment polyline track defined by a series of points',
		{
			net: z.string().describe('Net name for the track'),
			layer: z.string().describe('Layer name'),
			polygon: z
				.array(z.object({ x: z.number(), y: z.number() }))
				.min(2)
				.describe('Array of points [{x, y}, ...] defining the polyline path'),
			lineWidth: z.number().optional().describe('Track width'),
		},
		async (params) => {
			const result = await bridge.send('pcb.create.polyline', params);
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);

	server.tool(
		'pcb_create_via',
		'Create a via at the specified position. UNITS: position and diameters are in the PCB document\'s current display unit (mil by default, not mm — 1 mil = 0.0254 mm). A too-small value will fail DRC (e.g. diameter 0.6 is read as 0.6 mil, far below the ~19.7 mil minimum).',
		{
			net: z.string().describe('Net name'),
			x: z.number().describe('X coordinate'),
			y: z.number().describe('Y coordinate'),
			holeDiameter: z.number().describe('Hole diameter'),
			diameter: z.number().describe('Via pad diameter'),
			viaType: z.string().optional().describe('Via type (e.g. "Through", "BlindBuried")'),
		},
		async (params) => {
			const result = await bridge.send('pcb.create.via', params);
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);

	server.tool(
		'pcb_create_arc',
		'Create an arc track segment on the PCB',
		{
			net: z.string().describe('Net name'),
			layer: z.string().describe('Layer name'),
			startX: z.number().describe('Start X coordinate'),
			startY: z.number().describe('Start Y coordinate'),
			endX: z.number().describe('End X coordinate'),
			endY: z.number().describe('End Y coordinate'),
			arcAngle: z.number().describe('Arc angle in degrees'),
			lineWidth: z.number().optional().describe('Track width'),
		},
		async (params) => {
			const result = await bridge.send('pcb.create.arc', params);
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);

	server.tool(
		'pcb_create_pad',
		'Create a standalone pad on the PCB. UNITS: position and sizes are in the PCB document\'s current display unit (mil by default, not mm — 1 mil = 0.0254 mm).',
		{
			layer: z.string().describe('Pad layer'),
			padNumber: z.string().describe('Pad number/name'),
			x: z.number().describe('X coordinate'),
			y: z.number().describe('Y coordinate'),
			rotation: z.number().optional().describe('Rotation angle in degrees'),
			net: z.string().optional().describe('Net name'),
		},
		async (params) => {
			const result = await bridge.send('pcb.create.pad', params);
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);

	server.tool(
		'pcb_create_region',
		'Create a design rule region (keepout/constraint area) on the PCB',
		{
			layer: z.string().describe('Layer name'),
			polygon: z
				.array(z.union([z.string(), z.number()]))
				.describe('Polygon source array — start point FIRST, then "L", then remaining points: [x1, y1, "L", x2, y2, ..., x1, y1]'),
			ruleType: z.array(z.string()).optional().describe('Rule type(s) for the region'),
			regionName: z.string().optional().describe('Name for the region'),
			lineWidth: z.number().optional().describe('Outline width'),
		},
		async (params) => {
			const result = await bridge.send('pcb.create.region', params);
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);

	// === Modify Tools ===

	server.tool(
		'pcb_move_component',
		'Move and/or rotate a component. Can also change its layer (flip to "BottomLayer" for two-sided placement), lock status, designator, etc. UNITS: x/y are in the PCB document\'s current display unit (mil by default, not mm).',
		{
			primitiveId: z.string().describe('The component primitive ID'),
			x: z.number().optional().describe('New X coordinate'),
			y: z.number().optional().describe('New Y coordinate'),
			rotation: z.number().optional().describe('New rotation angle in degrees'),
			layer: z.string().optional().describe('Target layer ("TopLayer" or "BottomLayer")'),
			primitiveLock: z.boolean().optional().describe('Whether to lock the component'),
			designator: z.string().optional().describe('New designator (e.g. "R1", "U2")'),
		},
		async ({ primitiveId, ...property }) => {
			const result = await bridge.send('pcb.modify.component', { primitiveId, property });
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);

	server.tool(
		'pcb_modify_track',
		'Modify properties of an existing track segment (line)',
		{
			primitiveId: z.string().describe('The track primitive ID'),
			net: z.string().optional().describe('New net name'),
			layer: z.string().optional().describe('New layer'),
			startX: z.number().optional().describe('New start X'),
			startY: z.number().optional().describe('New start Y'),
			endX: z.number().optional().describe('New end X'),
			endY: z.number().optional().describe('New end Y'),
			lineWidth: z.number().optional().describe('New track width'),
		},
		async ({ primitiveId, ...property }) => {
			const result = await bridge.send('pcb.modify.line', { primitiveId, property });
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);

	server.tool(
		'pcb_modify_primitive',
		`Modify properties of a PCB primitive. Property keys vary by type:
- via: net, x, y, holeDiameter, diameter, viaType
- polyline: net, layer, lineWidth
- arc: net, layer, startX, startY, endX, endY, arcAngle, lineWidth
- pad: x, y, rotation, net, padNumber, layer
- pour: net, layer, pourFillMethod, preserveSilos, pourName, pourPriority, lineWidth
- fill: layer, net, fillMode, lineWidth
- region: layer, ruleType, regionName, lineWidth
All types support: primitiveLock`,
		{
			type: z
				.enum(['via', 'polyline', 'arc', 'pad', 'pour', 'fill', 'region'])
				.describe('Primitive type to modify'),
			primitiveId: z.string().describe('The primitive ID'),
			property: z
				.record(z.any())
				.describe('Properties to modify (see description for valid keys per type)'),
		},
		async ({ type, primitiveId, property }) => {
			const result = await bridge.send(MODIFY_HANDLER_MAP[type], { primitiveId, property });
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);

	// === Delete (consolidated) ===

	server.tool(
		'pcb_delete_primitives',
		'Delete one or more PCB primitives by type and IDs',
		{
			type: z
				.enum(['component', 'track', 'polyline', 'via', 'pad', 'pour', 'fill', 'arc', 'region'])
				.describe('Primitive type to delete'),
			ids: z
				.union([z.string(), z.array(z.string())])
				.describe('Primitive ID(s) to delete'),
		},
		async ({ type, ids }) => {
			const result = await bridge.send(DELETE_HANDLER_MAP[type], { ids });
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);

	// === Netlist ===

	server.tool(
		'pcb_set_netlist',
		'Apply a netlist to the PCB (assign nets to the placed footprints\' pads by designator-pin, building the ratsnest). This wraps EDA Pro\'s PCB_Net.setNetlist, which — unlike the schematic\'s @beta sch_set_netlist — is a @public API that returns a real boolean success flag. This is the recommended programmatic path to establish connectivity on the PCB when sch_set_netlist no-ops: place footprints first (via pcb_import from the schematic or manually), then feed the full [components]+(nets) netlist here. The tool reports the API\'s boolean (`applied`) plus a before/after read-back (`changed`) so a silent no-op is visible. If applied/changed are false, fall back to native File → Import Netlist. type must match the netlist string format.',
		{
			type: z
				.enum(['Allegro', 'PADS', 'Protel2', 'JLCEDA', 'EasyEDA', 'DISA'])
				.optional()
				.describe('Netlist format type (must match the netlist string)'),
			netlist: z.string().describe('Netlist data string (same format as pcb_get_netlist / sch_get_netlist output)'),
		},
		async ({ type, netlist }) => {
			// Snapshot before/after and also capture the API's own boolean so a silent
			// no-op is distinguishable from a real apply.
			let before: unknown;
			try {
				before = await bridge.send('pcb.net.getNetlist', { type });
			} catch {
				before = undefined;
			}
			const applied = await bridge.send('pcb.net.setNetlist', { type, netlist });
			let after: unknown;
			try {
				after = await bridge.send('pcb.net.getNetlist', { type });
			} catch {
				after = undefined;
			}
			const readBackAvailable = typeof after === 'string';
			const changed = readBackAvailable ? after !== before : null;
			const note =
				applied === false
					? 'PCB_Net.setNetlist returned false — the write was rejected (check that footprints are placed with matching designators, and the netlist dialect matches `type`). Fall back to native File → Import Netlist.'
					: changed === false
						? 'setNetlist returned truthy but the PCB netlist is unchanged on read-back — verify the netlist actually differs from the current one, or fall back to native File → Import Netlist.'
						: changed === true
							? 'Netlist applied — PCB net model changed on read-back.'
							: 'Netlist submitted; read-back verification unavailable (could not re-read the PCB netlist).';
			return textResult({ submitted: true, applied, changed, note });
		},
	);

	// === Save ===

	server.tool(
		'pcb_save',
		'Save the current PCB document',
		{
			uuid: z.string().optional().describe('Document UUID (uses current document if not provided)'),
		},
		async ({ uuid }) => {
			const result = await bridge.send('pcb.document.save', { uuid });
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);
}
