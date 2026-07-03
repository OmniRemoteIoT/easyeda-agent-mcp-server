import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WebSocketBridge } from '../bridge';

/** Strip the verbose per-component blob (datasheet, description, 3D transforms) to save tokens. */
function toCompactSchComponents(result: unknown): unknown {
	if (!Array.isArray(result)) return result;
	return result.map((c: any) => ({
		primitiveId: c?.primitiveId,
		componentType: c?.componentType,
		designator: c?.designator,
		x: c?.x,
		y: c?.y,
		rotation: c?.rotation,
		mirror: c?.mirror,
		value: c?.otherProperty?.Value ?? c?.name,
		supplierId: c?.supplierId,
		footprint: c?.otherProperty?.Footprint ?? c?.otherProperty?.['Supplier Footprint'],
	}));
}

export function registerSchReadTools(server: McpServer, bridge: WebSocketBridge): void {
	server.tool(
		'sch_get_all_components',
		'Get all components in the schematic with their properties, positions, rotations, designators, etc. For large designs, pass compact:true to strip the verbose per-part property blob (datasheet, description, 3D transforms) and return only essentials — cuts token usage ~90%.',
		{
			componentType: z
				.enum(['part', 'sheet', 'netflag', 'netport', 'nonElectrical_symbol', 'short_symbol', 'netlabel'])
				.optional()
				.describe('Filter by component type (e.g. "part", "netflag", "netport")'),
			allSchematicPages: z
				.boolean()
				.optional()
				.describe('If true, get components from all schematic pages instead of just the current page'),
			compact: z
				.boolean()
				.optional()
				.describe('Return only essentials (primitiveId, designator, x, y, rotation, value, supplierId, footprint) to save tokens. Recommended for boards with many parts.'),
		},
		async ({ componentType, allSchematicPages, compact }) => {
			const result = await bridge.send('sch.component.getAll', { componentType, allSchematicPages });
			const out = compact ? toCompactSchComponents(result) : result;
			return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
		},
	);

	server.tool(
		'sch_get_component',
		'Get one or more schematic components by primitive ID(s)',
		{
			primitiveIds: z
				.union([z.string(), z.array(z.string())])
				.describe('Single primitive ID or array of primitive IDs'),
		},
		async ({ primitiveIds }) => {
			const result = await bridge.send('sch.component.get', { primitiveIds });
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);

	server.tool(
		'sch_get_component_pins',
		'Get all pins of a schematic component by its primitive ID. Pin Y coordinates are normalized to match component placement coordinates (EDA Pro natively returns negated Y for pins).',
		{
			primitiveId: z.string().describe('The component primitive ID'),
		},
		async ({ primitiveId }) => {
			const result = await bridge.send('sch.component.getAllPins', { primitiveId });
			// Normalize pin Y coordinates: EDA Pro returns pin Y values negated relative to
			// component placement coordinates. Negate them so pin positions are in the same
			// coordinate space as component placement (x, y).
			const normalized = normalizePinCoordinates(result);
			return { content: [{ type: 'text', text: JSON.stringify(normalized, null, 2) }] };
		},
	);

	server.tool(
		'sch_get_all_wires',
		'Get all wires in the schematic, optionally filtered by net name',
		{
			net: z
				.union([z.string(), z.array(z.string())])
				.optional()
				.describe('Filter by net name or array of net names'),
		},
		async ({ net }) => {
			const result = await bridge.send('sch.wire.getAll', { net });
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);

	server.tool(
		'sch_get_wire',
		'Get one or more wires by primitive ID(s)',
		{
			primitiveIds: z
				.union([z.string(), z.array(z.string())])
				.describe('Single primitive ID or array of primitive IDs'),
		},
		async ({ primitiveIds }) => {
			const result = await bridge.send('sch.wire.get', { primitiveIds });
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);

	server.tool(
		'sch_get_selected',
		'Get primitive IDs of all currently selected primitives in the schematic editor. Use sch_get_component on returned IDs to fetch full details.',
		{},
		async () => {
			const result = await bridge.send('sch.select.getAll');
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);

	server.tool(
		'sch_get_selected_ids',
		'Get primitive IDs of all currently selected primitives in the schematic editor',
		{},
		async () => {
			const result = await bridge.send('sch.select.getAllIds');
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);

	server.tool(
		'sch_get_primitive',
		'Get a schematic primitive by its ID with all properties',
		{
			id: z.string().describe('The primitive ID'),
		},
		async ({ id }) => {
			const result = await bridge.send('sch.primitive.get', { id });
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);

	server.tool(
		'sch_get_primitive_type',
		'Get the type of a schematic primitive by its ID',
		{
			id: z.string().describe('The primitive ID'),
		},
		async ({ id }) => {
			const result = await bridge.send('sch.primitive.getType', { id });
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);

	server.tool(
		'sch_get_primitive_bbox',
		'Get the bounding box of one or more schematic primitives',
		{
			primitiveIds: z.array(z.string()).describe('Array of primitive IDs'),
		},
		async ({ primitiveIds }) => {
			const result = await bridge.send('sch.primitive.getBBox', { primitiveIds });
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);

	server.tool(
		'sch_get_netlist',
		'Get the schematic netlist in the specified format',
		{
			type: z
				.enum(['Allegro', 'PADS', 'Protel2', 'JLCEDA', 'EasyEDA', 'DISA'])
				.optional()
				.describe('Netlist format type'),
		},
		async ({ type }) => {
			const result = await bridge.send('sch.netlist.get', { type });
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);

	server.tool(
		'sch_run_drc',
		'Run Design Rule Check (DRC) on the schematic. The EDA API only returns a boolean (unlike pcb_run_drc, there is no detailed violation list for schematics) — true = no errors, false = errors found (in strict mode a Warning also yields false). The detailed results appear in the EasyEDA DRC panel at the bottom, which opens automatically when errors exist.',
		{
			strict: z.boolean().optional().describe('Strict mode — a Warning (not just an Error) makes the check return false'),
			userInterface: z.boolean().optional().describe('Show the DRC results panel in EasyEDA (default true)'),
		},
		async ({ strict, userInterface }) => {
			const ui = userInterface ?? true;
			const passed = await bridge.send('sch.drc.check', { strict, userInterface: ui });
			const result = {
				passed,
				note: passed
					? 'No DRC errors.'
					: 'DRC found errors (or warnings, in strict mode). See the DRC panel in EasyEDA for details — the schematic DRC API does not expose a per-violation list.',
			};
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);
}

/**
 * Normalize pin Y coordinates from EDA Pro's native format.
 * EDA Pro returns pin Y values negated relative to component placement coordinates.
 * This function negates Y values so pins are in the same coordinate space as placements.
 */
function normalizePinCoordinates(result: unknown): unknown {
	if (!result || typeof result !== 'object') return result;

	if (Array.isArray(result)) {
		return result.map((pin) => normalizePinY(pin));
	}

	return result;
}

function normalizePinY(pin: unknown): unknown {
	if (!pin || typeof pin !== 'object') return pin;
	const p = pin as Record<string, unknown>;
	const out = { ...p };

	if (typeof p.y === 'number') {
		out._rawY = p.y;
		out.y = -p.y;
	}
	if (typeof p.pinDot === 'object' && p.pinDot !== null) {
		const dot = p.pinDot as Record<string, unknown>;
		if (typeof dot.y === 'number') {
			out.pinDot = { ...dot, _rawY: dot.y, y: -dot.y };
		}
	}

	return out;
}
