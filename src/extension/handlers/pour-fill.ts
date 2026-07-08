import { resolvePcbLayer } from './layer-util';

export const pourFillHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	// === Pour ===

	'pcb.getAll.pour': async (params) => {
		return eda.pcb_PrimitivePour.getAll(params.net, (await resolvePcbLayer(params.layer)) as any);
	},

	'pcb.get.pour': async (params) => {
		return eda.pcb_PrimitivePour.get(params.primitiveIds);
	},

	'pcb.create.pour': async (params) => {
		const polygon = eda.pcb_MathPolygon.createPolygon(params.polygon);
		if (!polygon) {
			throw new Error('Invalid polygon data');
		}
		return eda.pcb_PrimitivePour.create(
			params.net,
			(await resolvePcbLayer(params.layer)) as any,
			polygon,
			params.pourFillMethod,
			params.preserveSilos,
			params.pourName,
			params.pourPriority,
			params.lineWidth,
			params.primitiveLock,
		);
	},

	'pcb.modify.pour': async (params) => {
		return eda.pcb_PrimitivePour.modify(params.primitiveId, params.property);
	},

	'pcb.delete.pour': async (params) => {
		return eda.pcb_PrimitivePour.delete(params.ids);
	},

	// === Fill ===

	'pcb.getAll.fill': async (params) => {
		return eda.pcb_PrimitiveFill.getAll((await resolvePcbLayer(params.layer)) as any, params.net);
	},

	'pcb.get.fill': async (params) => {
		return eda.pcb_PrimitiveFill.get(params.primitiveIds);
	},

	'pcb.create.fill': async (params) => {
		const polygon = eda.pcb_MathPolygon.createPolygon(params.polygon);
		if (!polygon) {
			throw new Error('Invalid polygon data');
		}
		return eda.pcb_PrimitiveFill.create(
			(await resolvePcbLayer(params.layer)) as any,
			polygon,
			params.net,
			params.fillMode,
			params.lineWidth,
			params.primitiveLock,
		);
	},

	'pcb.modify.fill': async (params) => {
		return eda.pcb_PrimitiveFill.modify(params.primitiveId, params.property);
	},

	'pcb.delete.fill': async (params) => {
		return eda.pcb_PrimitiveFill.delete(params.ids);
	},
};
