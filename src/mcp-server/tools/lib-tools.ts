import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WebSocketBridge } from '../bridge';

export function registerLibTools(server: McpServer, bridge: WebSocketBridge): void {
	server.tool(
		'lib_search_device',
		'Search the component library for devices by keyword. Returns a list of matching components with their UUIDs, names, descriptions, and package info.',
		{
			key: z.string().describe('Search keyword (e.g. "2.2k resistor", "STM32F103", "0805 capacitor")'),
			libraryUuid: z.string().optional().describe('Library UUID to search in (omit to search all libraries)'),
			itemsOfPage: z.number().optional().describe('Number of results per page (default varies)'),
			page: z.number().optional().describe('Page number (0-based)'),
		},
		async (params) => {
			const result = await bridge.send('lib.device.search', params);
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);

	server.tool(
		'lib_get_device',
		'Get detailed information about a specific device by its UUID, including symbol, footprint, and all properties',
		{
			deviceUuid: z.string().describe('The device UUID'),
			libraryUuid: z.string().optional().describe('Library UUID (omit to search all libraries)'),
		},
		async ({ deviceUuid, libraryUuid }) => {
			const result = await bridge.send('lib.device.get', { deviceUuid, libraryUuid });
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);

	server.tool(
		'lib_get_device_by_lcsc',
		'Get device(s) by LCSC C-number(s). WARNING: EDA Pro sometimes returns a different part than requested. Always verify the returned component value/description matches your intent before placing.',
		{
			lcscIds: z
				.union([z.string(), z.array(z.string())])
				.describe('Single LCSC ID (e.g. "C17414") or array of LCSC IDs'),
			libraryUuid: z.string().optional().describe('Library UUID (omit to search all libraries)'),
		},
		async ({ lcscIds, libraryUuid }) => {
			const result = await bridge.send('lib.device.getByLcscIds', { lcscIds, libraryUuid });
			// Add verification warnings: check that returned LCSC IDs match what was requested
			const requestedIds = Array.isArray(lcscIds) ? lcscIds : [lcscIds];
			const warnings = verifyLcscResults(result, requestedIds);
			const output: Record<string, unknown> = { result };
			if (warnings.length > 0) {
				output._warnings = warnings;
			}
			return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
		},
	);

	server.tool(
		'lib_get_system_library_uuid',
		'Get the UUID of the system (built-in) component library',
		{},
		async () => {
			const result = await bridge.send('lib.getSystemLibraryUuid');
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);

	server.tool(
		'lib_get_all_libraries',
		'Get a list of all available component libraries with their UUIDs and names',
		{},
		async () => {
			const result = await bridge.send('lib.getAllLibraries');
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);
}

/**
 * Verify that LCSC lookup results match the requested IDs.
 * EDA Pro sometimes returns different parts than requested.
 */
function verifyLcscResults(result: unknown, requestedIds: string[]): string[] {
	const warnings: string[] = [];
	if (!result || typeof result !== 'object') return warnings;

	const items = Array.isArray(result) ? result : [result];

	// Check if any requested IDs are missing from results
	const returnedLcscIds = new Set<string>();
	for (const item of items) {
		if (item && typeof item === 'object') {
			const obj = item as Record<string, unknown>;
			// Check common fields where LCSC ID might appear
			for (const key of ['lcscId', 'supplierId', 'supplierNumber', 'lcsc']) {
				if (typeof obj[key] === 'string') {
					returnedLcscIds.add(obj[key] as string);
				}
			}
		}
	}

	if (returnedLcscIds.size > 0) {
		for (const id of requestedIds) {
			if (!returnedLcscIds.has(id)) {
				warnings.push(`LCSC ID "${id}" was requested but the returned part may not match. Verify component value before placing.`);
			}
		}
	} else {
		warnings.push('Could not verify LCSC IDs in response. Verify component values before placing.');
	}

	return warnings;
}
