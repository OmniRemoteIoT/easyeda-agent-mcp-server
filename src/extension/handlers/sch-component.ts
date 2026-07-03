export const schComponentHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	'sch.component.create': async (params) => {
		return eda.sch_PrimitiveComponent.create(
			params.component,
			params.x,
			params.y,
			params.subPartName,
			params.rotation,
			params.mirror,
			params.addIntoBom,
			params.addIntoPcb,
		);
	},

	'sch.component.createNetFlag': async (params) => {
		return eda.sch_PrimitiveComponent.createNetFlag(
			params.identification,
			params.net,
			params.x,
			params.y,
			params.rotation,
			params.mirror,
		);
	},

	'sch.component.createNetPort': async (params) => {
		return eda.sch_PrimitiveComponent.createNetPort(
			params.direction,
			params.net,
			params.x,
			params.y,
			params.rotation,
			params.mirror,
		);
	},

	'sch.component.delete': async (params) => {
		// Resolve IDs to component OBJECTS via getAll() (which walks the active schematic
		// document) instead of passing raw string IDs to delete(). The by-ID path can
		// resolve through the PCB canvas registry and fail with "object not initialized
		// in PCB canvas" when no PCB is open. Passing the resolved objects avoids that.
		const ids: string[] = Array.isArray(params.ids) ? params.ids : [params.ids];
		const all = await eda.sch_PrimitiveComponent.getAll();
		const targets = all.filter((c: any) => ids.includes(c.getState_PrimitiveId?.()));
		if (targets.length === 0) {
			// Fall back to raw delete so an unusual ID still gets a chance.
			return eda.sch_PrimitiveComponent.delete(params.ids);
		}
		return eda.sch_PrimitiveComponent.delete(targets);
	},

	'sch.component.modify': async (params) => {
		const id: string = params.primitiveId;
		const p: Record<string, any> = params.property ?? {};
		const attempts: string[] = [];

		const applyState = (async: any): void => {
			if (p.x !== undefined) async.setState_X(p.x);
			if (p.y !== undefined) async.setState_Y(p.y);
			if (p.rotation !== undefined) async.setState_Rotation(p.rotation);
			if (p.mirror !== undefined) async.setState_Mirror(p.mirror);
			if (p.addIntoBom !== undefined) async.setState_AddIntoBom(p.addIntoBom);
			if (p.addIntoPcb !== undefined) async.setState_AddIntoPcb(p.addIntoPcb);
			if (p.designator !== undefined) async.setState_Designator(p.designator ?? undefined);
			if (p.name !== undefined) async.setState_Name(p.name ?? undefined);
			if (p.uniqueId !== undefined) async.setState_UniqueId(p.uniqueId ?? undefined);
			if (p.manufacturer !== undefined) async.setState_Manufacturer(p.manufacturer ?? undefined);
			if (p.manufacturerId !== undefined) async.setState_ManufacturerId(p.manufacturerId ?? undefined);
			if (p.supplier !== undefined) async.setState_Supplier(p.supplier ?? undefined);
			if (p.supplierId !== undefined) async.setState_SupplierId(p.supplierId ?? undefined);
			if (p.otherProperty !== undefined) async.setState_OtherProperty(p.otherProperty);
		};
		const resolvedId = (r: any): string => r?.getState_PrimitiveId?.() ?? id;

		// Strategy 1: high-level modify(id, property).
		try {
			const r = await eda.sch_PrimitiveComponent.modify(id, p);
			if (r) return { success: true, via: 'modify', primitiveId: resolvedId(r) };
			attempts.push('modify() returned undefined (primitiveId not found/matched)');
		} catch (e: any) {
			attempts.push(`modify() threw: ${e?.message ?? String(e)}`);
		}

		// Strategy 2: get(id) → toAsync → setState → done (fresh editable handle).
		try {
			const comp: any = await eda.sch_PrimitiveComponent.get(id);
			if (!comp) {
				attempts.push('get(id) returned undefined');
			} else {
				const async = comp.toAsync();
				applyState(async);
				const done = await async.done();
				return { success: true, via: 'get+setState', primitiveId: resolvedId(done ?? comp) };
			}
		} catch (e: any) {
			attempts.push(`get+setState threw: ${e?.message ?? String(e)}`);
		}

		// Strategy 3: getAll → find by primitiveId → toAsync → setState → done.
		try {
			const all = await eda.sch_PrimitiveComponent.getAll();
			const comp: any = all.find((c: any) => c.getState_PrimitiveId?.() === id);
			if (!comp) {
				attempts.push(`getAll find: no component with primitiveId "${id}" (available: ${all.map((c: any) => c.getState_PrimitiveId?.()).join(', ')})`);
			} else {
				const async = comp.toAsync();
				applyState(async);
				const done = await async.done();
				return { success: true, via: 'getAll+setState', primitiveId: resolvedId(done ?? comp) };
			}
		} catch (e: any) {
			attempts.push(`getAll+setState threw: ${e?.message ?? String(e)}`);
		}

		throw new Error(`sch.component.modify failed for "${id}". Attempts: ${attempts.join(' || ')}`);
	},

	'sch.component.get': async (params) => {
		// get(id) triggers an internal cloud lookup that can fail.
		// Workaround: use getAll() and filter — different code path, consistently works.
		const ids: string[] = Array.isArray(params.primitiveIds) ? params.primitiveIds : [params.primitiveIds];
		const all = await eda.sch_PrimitiveComponent.getAll();
		const matches = all.filter((c: any) => ids.includes(c.getState_PrimitiveId?.()));
		return Array.isArray(params.primitiveIds) ? matches : (matches[0] ?? undefined);
	},

	'sch.component.getAll': async (params) => {
		return eda.sch_PrimitiveComponent.getAll(params.componentType, params.allSchematicPages);
	},

	'sch.component.getAllPins': async (params) => {
		return eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(params.primitiveId);
	},
};
