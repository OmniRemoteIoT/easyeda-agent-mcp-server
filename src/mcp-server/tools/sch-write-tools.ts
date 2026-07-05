import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WebSocketBridge } from '../bridge';
import { textResult, resolveNetlistInput } from './util';

export function registerSchWriteTools(server: McpServer, bridge: WebSocketBridge): void {
	server.tool(
		'sch_create_component',
		'Create a schematic component from a library device reference. Use lib_search_device or lib_get_device first to get the component object.',
		{
			component: z
				.record(z.any())
				.describe(
					'Component object from library search/get (ILIB_DeviceItem or ILIB_DeviceSearchItem), or an object with {deviceUuid, libraryUuid}',
				),
			x: z.number().describe('X coordinate for placement'),
			y: z.number().describe('Y coordinate for placement'),
			subPartName: z.string().optional().describe('Sub-part name for multi-part components'),
			rotation: z.number().optional().describe('Rotation angle in degrees'),
			mirror: z.boolean().optional().describe('Whether to mirror the component'),
			addIntoBom: z.boolean().optional().describe('Whether to include in BOM (default true)'),
			addIntoPcb: z.boolean().optional().describe('Whether to include in PCB (default true)'),
		},
		async (params) => {
			const result = await bridge.send('sch.component.create', params);
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);

	server.tool(
		'sch_create_net_flag',
		'Create a Power/Ground/AnalogGround/ProtectGround net flag in the schematic. Fire-and-forget: EDA Pro does not send a response for this call, so it resolves immediately without confirmation — verify placement with sch_get_all_components (componentType "netflag") or visually. Note: a net flag placed at a pin does NOT by itself establish an electrical net in the netlist (API-inserted connectivity is not computed like interactive edits; see sch_set_netlist for programmatic connectivity).',
		{
			identification: z
				.enum(['Power', 'Ground', 'AnalogGround', 'ProtectGround'])
				.describe('Net flag type'),
			net: z.string().describe('Net name (e.g. "VCC", "GND", "3V3")'),
			x: z.number().describe('X coordinate'),
			y: z.number().describe('Y coordinate'),
			rotation: z.number().optional().describe('Rotation angle in degrees'),
			mirror: z.boolean().optional().describe('Whether to mirror'),
		},
		async (params) => {
			const result = await bridge.send('sch.component.createNetFlag', params, { fireAndForget: true });
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);

	server.tool(
		'sch_create_net_port',
		'Create an IN/OUT/BI directional net port in the schematic. Fire-and-forget: EDA Pro does not send a response, so it resolves immediately without confirmation — verify visually. Note: like net flags, a port placed at a pin does not by itself form an electrical net in the netlist (see sch_set_netlist for programmatic connectivity).',
		{
			direction: z.enum(['IN', 'OUT', 'BI']).describe('Port direction'),
			net: z.string().describe('Net name'),
			x: z.number().describe('X coordinate'),
			y: z.number().describe('Y coordinate'),
			rotation: z.number().optional().describe('Rotation angle in degrees'),
			mirror: z.boolean().optional().describe('Whether to mirror'),
		},
		async (params) => {
			const result = await bridge.send('sch.component.createNetPort', params, { fireAndForget: true });
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);

	server.tool(
		'sch_delete_component',
		'Delete one or more schematic components by their primitive IDs',
		{
			ids: z
				.union([z.string(), z.array(z.string())])
				.describe('Single primitive ID or array of primitive IDs to delete'),
		},
		async ({ ids }) => {
			const result = await bridge.send('sch.component.delete', { ids });
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);

	server.tool(
		'sch_modify_component',
		'Modify properties of a schematic component (position, rotation, designator, etc.)',
		{
			primitiveId: z.string().describe('The component primitive ID'),
			x: z.number().optional().describe('New X coordinate'),
			y: z.number().optional().describe('New Y coordinate'),
			rotation: z.number().optional().describe('New rotation angle in degrees'),
			mirror: z.boolean().optional().describe('Whether to mirror'),
			addIntoBom: z.boolean().optional().describe('Whether to include in BOM'),
			addIntoPcb: z.boolean().optional().describe('Whether to include in PCB'),
			designator: z.string().nullable().optional().describe('New designator (e.g. "R1", "U2")'),
			name: z.string().nullable().optional().describe('New component name'),
			uniqueId: z.string().nullable().optional().describe('New unique ID'),
			manufacturer: z.string().nullable().optional().describe('Manufacturer name'),
			manufacturerId: z.string().nullable().optional().describe('Manufacturer part number'),
			supplier: z.string().nullable().optional().describe('Supplier name'),
			supplierId: z.string().nullable().optional().describe('Supplier part number (e.g. LCSC C-number)'),
		},
		async ({ primitiveId, ...property }) => {
			const result = await bridge.send('sch.component.modify', { primitiveId, property });
			return { content: [{ type: 'text', text: JSON.stringify(result ?? { success: true }, null, 2) }] };
		},
	);

	server.tool(
		'sch_create_wire',
		'Create a wire (geometry) in the schematic defined by a series of coordinate points. IMPORTANT: this draws the wire but does NOT compute electrical connectivity — even endpoints coincident with component pins do not form a net in the netlist (EDA Pro only recomputes connectivity for interactive edits, and exposes no rebuild API). For programmatic connectivity, define nets with sch_set_netlist. Use this tool for visual wiring / annotation.',
		{
			line: z
				.union([
					z.array(z.number()).min(4).describe('Flat array of coordinates [x1,y1,x2,y2,...]'),
					z
						.array(z.array(z.number()).length(2))
						.min(2)
						.describe('Array of point pairs [[x1,y1],[x2,y2],...]'),
				])
				.describe('Wire path coordinates'),
			net: z.string().optional().describe('Net name to assign to the wire'),
			color: z.string().nullable().optional().describe('Wire color (null for default)'),
			lineWidth: z.number().nullable().optional().describe('Wire width (null for default)'),
			lineType: z
				.enum(['0', '1', '2', '3'])
				.optional()
				.describe('Line type: 0=Solid, 1=Dashed, 2=Dotted, 3=DotDashed'),
		},
		async ({ lineType, ...rest }) => {
			const params: Record<string, any> = { ...rest };
			if (lineType !== undefined) {
				params.lineType = Number(lineType);
			}
			const result = await bridge.send('sch.wire.create', params);
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);

	server.tool(
		'sch_delete_wire',
		'Delete one or more wires by their primitive IDs',
		{
			ids: z
				.union([z.string(), z.array(z.string())])
				.describe('Single primitive ID or array of primitive IDs to delete'),
		},
		async ({ ids }) => {
			const result = await bridge.send('sch.wire.delete', { ids });
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);

	server.tool(
		'sch_modify_wire',
		'Modify properties of an existing wire',
		{
			primitiveId: z.string().describe('The wire primitive ID'),
			line: z
				.union([z.array(z.number()), z.array(z.array(z.number()))])
				.optional()
				.describe('New wire path coordinates'),
			net: z.string().optional().describe('New net name'),
			color: z.string().nullable().optional().describe('New wire color (null for default)'),
			lineWidth: z.number().nullable().optional().describe('New wire width (null for default)'),
			lineType: z
				.enum(['0', '1', '2', '3'])
				.optional()
				.describe('Line type: 0=Solid, 1=Dashed, 2=Dotted, 3=DotDashed'),
		},
		async ({ primitiveId, lineType, ...rest }) => {
			const property: Record<string, any> = { ...rest };
			if (lineType !== undefined) {
				property.lineType = Number(lineType);
			}
			const result = await bridge.send('sch.wire.modify', { primitiveId, property });
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);

	server.tool(
		'sch_select_primitives',
		'Select primitives in the schematic editor by their IDs',
		{
			primitiveIds: z
				.union([z.string(), z.array(z.string())])
				.describe('Single primitive ID or array of primitive IDs to select'),
		},
		async ({ primitiveIds }) => {
			const result = await bridge.send('sch.select.select', { primitiveIds });
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);

	server.tool(
		'sch_clear_selection',
		'Clear all selection in the schematic editor',
		{},
		async () => {
			const result = await bridge.send('sch.select.clear');
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);

	server.tool(
		'sch_set_netlist',
		'Update the schematic netlist. NOTE: this wraps EasyEDA Pro\'s @beta sch_Netlist.setNetlist API, which returns no value and — as of current EDA Pro builds — frequently does NOT persist (the submitted nets do not appear on read-back). This tool now reads the netlist back after writing and reports `changed` so a silent no-op is visible; if `changed` is false, apply the netlist to the PCB via pcb_set_netlist instead, or fall back to native EDA Pro File → Import Netlist. Provide the netlist EITHER inline via `netlist` OR via `path` (the server reads the file from disk, avoiding the model output-token limit and preserving CRLF exactly). Round-trip a known-good one from sch_get_netlist to learn the exact format. type should match the netlist string format.',
		{
			type: z
				.enum(['Allegro', 'PADS', 'Protel2', 'JLCEDA', 'EasyEDA', 'DISA'])
				.optional()
				.describe('Netlist format type (must match the netlist string)'),
			netlist: z
				.string()
				.optional()
				.describe('Netlist data string (same format as sch_get_netlist output). Provide EITHER this OR `path`.'),
			path: z
				.string()
				.optional()
				.describe('Absolute filesystem path to a netlist file the SERVER reads directly from disk (CRLF preserved, zero token cost). Preferred for real boards. Provide EITHER this OR `netlist`.'),
		},
		async ({ type, netlist: netlistArg, path }) => {
			let netlist: string;
			try {
				netlist = resolveNetlistInput(netlistArg, path);
			} catch (err) {
				return textResult({ submitted: false, error: String((err as Error)?.message ?? err) });
			}
			// EDA Pro's setNetlist is @beta and returns void — no success signal, and it
			// often no-ops. Snapshot the netlist before/after so we can report honestly
			// whether the write actually landed instead of returning an unwrappable void.
			let before: unknown;
			try {
				before = await bridge.send('sch.netlist.get', { type });
			} catch {
				before = undefined;
			}
			await bridge.send('sch.netlist.set', { type, netlist });
			let after: unknown;
			try {
				after = await bridge.send('sch.netlist.get', { type });
			} catch {
				after = undefined;
			}
			const readBackAvailable = typeof after === 'string';
			const changed = readBackAvailable ? after !== before : null;
			const note =
				changed === false
					? 'setNetlist did not change the schematic netlist (read-back is identical). This is a known limitation of EDA Pro\'s @beta setNetlist — the write did not persist. To establish connectivity programmatically, apply the netlist to the PCB instead via pcb_set_netlist (PCB_Net.setNetlist is a @public API that returns a real success flag); otherwise fall back to native File → Import Netlist in EasyEDA Pro.'
					: changed === true
						? 'Netlist changed on read-back — the write landed.'
						: 'Netlist submitted; read-back verification unavailable (could not re-read the netlist).';
			return textResult({ submitted: true, changed, note });
		},
	);

	server.tool(
		'sch_save',
		'Save the current schematic document',
		{},
		async () => {
			const result = await bridge.send('sch.document.save');
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);

	server.tool(
		'sch_import_changes',
		'Import changes from PCB back into the schematic',
		{},
		async () => {
			const result = await bridge.send('sch.document.importChanges');
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);

	server.tool(
		'sch_cross_probe',
		'Cross-probe select between schematic and PCB: highlight/select specific components, pins, or nets in both editors simultaneously',
		{
			components: z
				.array(z.string())
				.optional()
				.describe('Component designators to cross-probe (e.g. ["R1", "U2"])'),
			pins: z
				.array(z.object({ designator: z.string(), pin: z.string() }))
				.optional()
				.describe('Specific pins to cross-probe (e.g. [{designator: "U1", pin: "1"}])'),
			nets: z
				.array(z.string())
				.optional()
				.describe('Net names to cross-probe (e.g. ["GND", "VCC"])'),
			highlight: z.boolean().optional().describe('Whether to highlight the probed items'),
			select: z.boolean().optional().describe('Whether to select the probed items'),
		},
		async (params) => {
			const result = await bridge.send('sch.select.crossProbe', params);
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);
}
