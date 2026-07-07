import { resolvePcbLayer } from './layer-util';

/**
 * Convert a polyline/polygon point list into EDA's flat polygon source array
 * (TPCB_PolygonSourceArray): `[x1, y1, 'L', x2, y2, x3, y3, ...]` — start point first,
 * then the 'L' (line) mode token, then the remaining points as flat pairs. Accepts either
 * a `[{x,y}, ...]` list (the MCP tool format) or an already-flat source array (passed
 * through untouched).
 */
function pointsToPolygonSource(polygon: any): Array<number | string> {
	if (!Array.isArray(polygon) || polygon.length === 0) return polygon;
	// Already a flat source array (numbers / 'L' tokens) — pass through.
	if (typeof polygon[0] !== 'object') return polygon;
	const pts = polygon as Array<{ x: number; y: number }>;
	const source: Array<number | string> = [pts[0].x, pts[0].y, 'L'];
	for (let i = 1; i < pts.length; i++) source.push(pts[i].x, pts[i].y);
	return source;
}

export const trackHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	// Line
	'pcb.getAll.line': async (params) => {
		return eda.pcb_PrimitiveLine.getAll(params.net, params.layer);
	},

	'pcb.get.line': async (params) => {
		return eda.pcb_PrimitiveLine.get(params.primitiveIds);
	},

	'pcb.create.line': async (params) => {
		// create() needs the numeric layer id, not the name — resolve it (else the LINE is
		// stored with a string layer and never renders / isn't recognized as an outline).
		return eda.pcb_PrimitiveLine.create(
			params.net,
			(await resolvePcbLayer(params.layer)) as any,
			params.startX,
			params.startY,
			params.endX,
			params.endY,
			params.lineWidth,
		);
	},

	'pcb.modify.line': async (params) => {
		return eda.pcb_PrimitiveLine.modify(params.primitiveId, params.property);
	},

	'pcb.delete.line': async (params) => {
		return eda.pcb_PrimitiveLine.delete(params.ids);
	},

	// Polyline
	'pcb.getAll.polyline': async (params) => {
		return eda.pcb_PrimitivePolyline.getAll(params.net, params.layer);
	},

	'pcb.get.polyline': async (params) => {
		return eda.pcb_PrimitivePolyline.get(params.primitiveIds);
	},

	'pcb.create.polyline': async (params) => {
		// PCB_PrimitivePolyline.create wants an IPCB_Polygon object (built via
		// pcb_MathPolygon.createPolygon from a flat source array [x1,y1,"L",x2,y2,...]),
		// NOT a raw [{x,y},...] point list. Passing the point list makes the API reject it
		// with "无法创建多边形图元…参数不正确". Convert the point list to a source array.
		const source = pointsToPolygonSource(params.polygon);
		const polygon = eda.pcb_MathPolygon.createPolygon(source as any);
		if (!polygon) {
			throw new Error('Could not build a polygon from the given points (pcb_MathPolygon.createPolygon returned nothing). Points must be [{x,y}, ...] with at least 2 vertices.');
		}
		return eda.pcb_PrimitivePolyline.create(params.net, (await resolvePcbLayer(params.layer)) as any, polygon, params.lineWidth);
	},

	'pcb.modify.polyline': async (params) => {
		return eda.pcb_PrimitivePolyline.modify(params.primitiveId, params.property);
	},

	'pcb.delete.polyline': async (params) => {
		return eda.pcb_PrimitivePolyline.delete(params.ids);
	},
};
