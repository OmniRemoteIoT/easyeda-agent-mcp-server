export const netHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	'pcb.net.getAllNames': async () => {
		return eda.pcb_Net.getAllNetsName();
	},

	'pcb.net.getPrimitives': async (params) => {
		return eda.pcb_Net.getAllPrimitivesByNet(params.net, params.types);
	},

	'pcb.net.getLength': async (params) => {
		return eda.pcb_Net.getNetLength(params.net);
	},

	'pcb.net.highlight': async (params) => {
		return eda.pcb_Net.highlightNet(params.net);
	},

	'pcb.net.select': async (params) => {
		return eda.pcb_Net.selectNet(params.net);
	},

	// PCB-side netlist read/write. Unlike sch_Netlist.setNetlist (@beta, returns void,
	// no-ops on current builds), PCB_Net.setNetlist is @public and returns a boolean
	// success flag — a genuine programmatic path to apply connectivity/net assignments
	// to the placed footprints (by designator-pin, like native Import Netlist).
	'pcb.net.getNetlist': async (params) => {
		return eda.pcb_Net.getNetlist(params.type);
	},

	'pcb.net.setNetlist': async (params) => {
		return eda.pcb_Net.setNetlist(params.type, params.netlist);
	},
};
