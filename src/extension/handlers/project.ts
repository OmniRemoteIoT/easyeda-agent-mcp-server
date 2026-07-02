export const projectHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	// Get the currently open project (name, UUID, all schematic/PCB/panel documents)
	'sys.project.getCurrent': async () => {
		return eda.dmt_Project.getCurrentProjectInfo();
	},

	// Open a project by UUID (will switch the active project in EasyEDA Pro)
	'sys.project.open': async (params) => {
		return eda.dmt_Project.openProject(params.projectUuid);
	},

	// Get the document currently in focus (type, uuid, parent project uuid)
	'sys.document.getCurrent': async () => {
		return eda.dmt_EditorControl.getCurrentDocumentInfo();
	},

	// Open a document (schematic page UUID, PCB UUID, or panel UUID) in the editor
	'sys.document.open': async (params) => {
		return eda.dmt_EditorControl.openDocument(params.documentUuid, params.splitScreenId);
	},

	// Close a document tab by its tab ID
	'sys.document.close': async (params) => {
		return eda.dmt_EditorControl.closeDocument(params.tabId);
	},

	// Get the editor split-screen layout (shows all open tabs and their arrangement)
	'sys.editor.getSplitScreenTree': async () => {
		return eda.dmt_EditorControl.getSplitScreenTree();
	},

	// Create a split-screen with a specific tab (moves that tab into a new pane)
	'sys.editor.createSplitScreen': async (params) => {
		return eda.dmt_EditorControl.createSplitScreen(params.splitScreenType, params.tabId);
	},

	// Move a document to a specific split-screen pane
	'sys.editor.moveDocumentToSplitScreen': async (params) => {
		return eda.dmt_EditorControl.moveDocumentToSplitScreen(params.tabId, params.splitScreenId);
	},

	// Rename the current (or a specified) project's friendly name.
	// modifyProjectFriendlyName is present at runtime but excluded from the public types.
	'sys.project.rename': async (params) => {
		let uuid = params.projectUuid;
		if (!uuid) {
			const project = await eda.dmt_Project.getCurrentProjectInfo();
			if (!project) throw new Error('No project is currently open');
			uuid = project.uuid;
		}
		return (eda.dmt_Project as any).modifyProjectFriendlyName(uuid, params.newName);
	},

	// Rename a schematic by its schematic UUID
	'sys.schematic.rename': async (params) => {
		return eda.dmt_Schematic.modifySchematicName(params.schematicUuid, params.newName);
	},

	// Rename a schematic page by its page UUID
	'sys.schematicPage.rename': async (params) => {
		return eda.dmt_Schematic.modifySchematicPageName(params.schematicPageUuid, params.newName);
	},

	// Rename a PCB by its PCB UUID
	'sys.pcb.rename': async (params) => {
		return eda.dmt_Pcb.modifyPcbName(params.pcbUuid, params.newName);
	},

	// Rename a board by its current (original) name
	'sys.board.rename': async (params) => {
		return eda.dmt_Board.modifyBoardName(params.originalBoardName, params.newName);
	},

	// Open a project's schematic and PCB side-by-side in split-screen
	// Finds first schematic page and first PCB in the current project
	'sys.project.openSideBySide': async (params) => {
		const project = await eda.dmt_Project.getCurrentProjectInfo();
		if (!project) throw new Error('No project is currently open');

		// Find the first schematic page and first PCB in the project
		let schPageUuid: string | undefined;
		let pcbUuid: string | undefined;

		for (const item of project.data) {
			if (!schPageUuid && (item as any).itemType === 'SCHEMATIC') {
				const sch = item as any;
				if (sch.page && sch.page.length > 0) {
					schPageUuid = params.schematicPageUuid || sch.page[0].uuid;
				}
			}
			if (!pcbUuid && (item as any).itemType === 'PCB') {
				pcbUuid = params.pcbUuid || (item as any).uuid;
			}
			if (schPageUuid && pcbUuid) break;
		}

		// Also check under boards (schematic+PCB pairs)
		if (!schPageUuid || !pcbUuid) {
			for (const item of project.data) {
				if ((item as any).itemType === 'BOARD') {
					const board = item as any;
					if (!schPageUuid && board.schematic?.page?.length > 0) {
						schPageUuid = params.schematicPageUuid || board.schematic.page[0].uuid;
					}
					if (!pcbUuid && board.pcb?.uuid) {
						pcbUuid = params.pcbUuid || board.pcb.uuid;
					}
					if (schPageUuid && pcbUuid) break;
				}
			}
		}

		if (!schPageUuid) throw new Error('No schematic found in the current project');
		if (!pcbUuid) throw new Error('No PCB found in the current project');

		// Open schematic first
		const schTabId = await eda.dmt_EditorControl.openDocument(schPageUuid);
		if (!schTabId) throw new Error(`Failed to open schematic (uuid: ${schPageUuid})`);

		// Open PCB — EDA Pro will open it in the same split area unless we split first
		const pcbTabId = await eda.dmt_EditorControl.openDocument(pcbUuid);
		if (!pcbTabId) throw new Error(`Failed to open PCB (uuid: ${pcbUuid})`);

		// Create a vertical split-screen with the PCB tab
		const splitResult = await eda.dmt_EditorControl.createSplitScreen('vertical', pcbTabId);

		return {
			projectName: project.friendlyName,
			projectUuid: project.uuid,
			schematicPageUuid: schPageUuid,
			schTabId,
			pcbUuid,
			pcbTabId,
			splitScreen: splitResult,
		};
	},
};
