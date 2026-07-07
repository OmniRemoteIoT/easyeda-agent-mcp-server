// Resolve a PCB layer NAME (e.g. "Board Outline Layer", "Top Layer") to the numeric
// layer id the primitive-create APIs actually require (TPCB_LayersOfLine = EPCB_LayerId,
// a number). The MCP tools pass friendly layer names, but PCB_PrimitiveLine.create etc.
// expect the id — passing the name stores a malformed primitive (layer as a string) that
// EDA persists + reads back but never RENDERS or recognizes (e.g. a board-outline line
// that shows 0 outlines in the catalog). Confirmed: real LINEs store layer as a number.

let layerCache: Array<{ id: number; name: string }> | null = null;

const norm = (s: unknown): string => String(s ?? '').toLowerCase().replace(/\s+/g, '');

/**
 * Map a layer name (or numeric/numeric-string) to its numeric layer id.
 * - number → returned as-is.
 * - numeric string ("11") → Number.
 * - name ("Board Outline Layer" / "BoardOutlineLayer" / "TopLayer") → id via getAllLayers,
 *   matched case- and space-insensitively. Caches the layer list; refetches once on a miss
 *   (e.g. after the copper-layer count changed). Falls back to the original value if unresolved.
 */
export async function resolvePcbLayer(layer: unknown): Promise<unknown> {
	if (typeof layer === 'number') return layer;
	if (typeof layer === 'string' && /^\d+$/.test(layer)) return Number(layer);
	if (typeof layer !== 'string') return layer;

	const want = norm(layer);
	const find = (list: Array<{ id: number; name: string }> | null): number | undefined => {
		for (const l of list ?? []) if (norm(l?.name) === want) return l.id;
		return undefined;
	};

	let id = find(layerCache);
	if (id === undefined) {
		try {
			layerCache = (await eda.pcb_Layer.getAllLayers()) as any;
			id = find(layerCache);
		} catch {
			/* getAllLayers failed — fall through to pass-through */
		}
	}
	return id !== undefined ? id : layer;
}

/** Invalidate the cached layer list (call if layers were added/removed). */
export function clearPcbLayerCache(): void {
	layerCache = null;
}
