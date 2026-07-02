import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WebSocketBridge } from '../bridge';

export function registerPourFillTools(server: McpServer, bridge: WebSocketBridge): void {
	server.tool(
		'pcb_get_all_pours',
		'Get all copper pour regions on the PCB, optionally filtered by net and layer',
		{
			net: z.string().optional().describe('Filter by net name'),
			layer: z.string().optional().describe('Filter by layer'),
		},
		async ({ net, layer }) => {
			const result = await bridge.send('pcb.getAll.pour', { net, layer });
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);

	server.tool(
		'pcb_create_pour',
		'Create a copper pour region on the PCB. The polygon should be a flat array like ["L", x1, y1, x2, y2, ..., x1, y1] where "L" indicates line segments.',
		{
			net: z.string().describe('Net name for the pour'),
			layer: z.string().describe('Layer name (e.g. "TopLayer", "BottomLayer", "InnerLayer1", "InnerLayer2")'),
			polygon: z
				.array(z.union([z.string(), z.number()]))
				.describe('Polygon source array, e.g. ["L", x1, y1, x2, y2, ..., x1, y1]'),
			pourFillMethod: z
				.enum(['solid', '45grid', '90grid'])
				.optional()
				.describe('Fill method: "solid", "45grid", or "90grid"'),
			preserveSilos: z.boolean().optional().describe('Whether to preserve copper islands'),
			pourName: z.string().optional().describe('Name for the pour region'),
			pourPriority: z.number().optional().describe('Pour priority (higher = poured first)'),
			lineWidth: z.number().optional().describe('Line width'),
			primitiveLock: z.boolean().optional().describe('Whether to lock the pour'),
		},
		async (params) => {
			const result = await bridge.send('pcb.create.pour', params);
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);

	server.tool(
		'pcb_delete_pours',
		'Delete copper pour regions by their IDs',
		{
			ids: z.array(z.string()).describe('Array of pour primitive IDs to delete'),
		},
		async ({ ids }) => {
			const result = await bridge.send('pcb.delete.pour', { ids });
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);

	server.tool(
		'pcb_get_all_fills',
		'Get all fill regions on the PCB, optionally filtered by layer and net',
		{
			layer: z.string().optional().describe('Filter by layer'),
			net: z.string().optional().describe('Filter by net name'),
		},
		async ({ layer, net }) => {
			const result = await bridge.send('pcb.getAll.fill', { layer, net });
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);

	server.tool(
		'pcb_create_fill',
		'Create a solid fill region on the PCB. The polygon should be a flat array like ["L", x1, y1, x2, y2, ..., x1, y1] where "L" indicates line segments.',
		{
			layer: z.string().describe('Layer name (e.g. "TopLayer", "BottomLayer")'),
			polygon: z
				.array(z.union([z.string(), z.number()]))
				.describe('Polygon source array, e.g. ["L", x1, y1, x2, y2, ..., x1, y1]'),
			net: z.string().optional().describe('Net name to assign'),
			fillMode: z.string().optional().describe('Fill mode'),
			lineWidth: z.number().optional().describe('Line width'),
			primitiveLock: z.boolean().optional().describe('Whether to lock the fill'),
		},
		async (params) => {
			const result = await bridge.send('pcb.create.fill', params);
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);

	server.tool(
		'pcb_modify_pour',
		'Modify properties of an existing copper pour',
		{
			primitiveId: z.string().describe('The pour primitive ID'),
			property: z
				.object({
					net: z.string().optional(),
					layer: z.string().optional(),
					pourFillMethod: z.enum(['solid', '45grid', '90grid']).optional(),
					preserveSilos: z.boolean().optional(),
					pourName: z.string().optional(),
					pourPriority: z.number().optional(),
					lineWidth: z.number().optional(),
					primitiveLock: z.boolean().optional(),
				})
				.describe('Properties to update'),
		},
		async ({ primitiveId, property }) => {
			const result = await bridge.send('pcb.modify.pour', { primitiveId, property });
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);

	server.tool(
		'pcb_modify_fill',
		'Modify properties of an existing fill region',
		{
			primitiveId: z.string().describe('The fill primitive ID'),
			property: z
				.object({
					layer: z.string().optional(),
					net: z.string().optional(),
					fillMode: z.string().optional(),
					lineWidth: z.number().optional(),
					primitiveLock: z.boolean().optional(),
				})
				.describe('Properties to update'),
		},
		async ({ primitiveId, property }) => {
			const result = await bridge.send('pcb.modify.fill', { primitiveId, property });
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);

	server.tool(
		'pcb_delete_fills',
		'Delete fill regions by their IDs',
		{
			ids: z.array(z.string()).describe('Array of fill primitive IDs to delete'),
		},
		async ({ ids }) => {
			const result = await bridge.send('pcb.delete.fill', { ids });
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);
}
