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
