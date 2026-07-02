export const schSelectHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	'sch.select.getAll': async () => {
		// getAllSelectedPrimitives() serializes full primitive objects and can hang on large
		// schematics. Use the IDs-only call instead; callers can fetch details with get() if needed.
		return eda.sch_SelectControl.getAllSelectedPrimitives_PrimitiveId();
	},

	'sch.select.getAllIds': async () => {
		return eda.sch_SelectControl.getAllSelectedPrimitives_PrimitiveId();
	},

	'sch.select.select': async (params) => {
		return eda.sch_SelectControl.doSelectPrimitives(params.primitiveIds);
	},

	'sch.select.crossProbe': async (params) => {
		return eda.sch_SelectControl.doCrossProbeSelect(
			params.components,
			params.pins,
			params.nets,
			params.highlight,
			params.select,
		);
	},

	'sch.select.clear': async () => {
		return eda.sch_SelectControl.clearSelected();
	},
};
