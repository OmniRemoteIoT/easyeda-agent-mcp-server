/**
 * Open + activate a document (its split-screen PANE and its TAB) by UUID. Returns the
 * tabId and per-step results. NOTE: the runtime has no working `getCurrentDocumentInfo`,
 * so we cannot read back the resulting active documentType — we report what the activation
 * calls returned instead.
 */
async function activateDocumentByUuid(documentUuid: string, splitScreenId?: string): Promise<Record<string, unknown>> {
	const tabId = await eda.dmt_EditorControl.openDocument(documentUuid, splitScreenId);
	let paneActivated: boolean | undefined;
	let activated = false;
	if (tabId) {
		try {
			const splitId = await eda.dmt_EditorControl.getSplitScreenIdByTabId(tabId);
			if (splitId) paneActivated = await eda.dmt_EditorControl.activateSplitScreen(splitId);
		} catch { /* non-fatal */ }
		try { activated = await eda.dmt_EditorControl.activateDocument(tabId); } catch { /* non-fatal */ }
	}
	return {
		tabId,
		activated,
		paneActivated,
		note: !tabId
			? 'openDocument returned no tab — the uuid may not be a schematic page / PCB / panel.'
			: `Opened + activated (activateDocument=${activated}${paneActivated === undefined ? '' : `, activatePane=${paneActivated}`}). Active-document read-back is unavailable in this runtime; if a write still says a tab must be focused, click the ${'target'} editor canvas in EasyEDA Pro.`,
	};
}

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

	// Open a document (schematic page UUID, PCB UUID, or panel UUID) and ACTIVATE it
	// (pane + tab). Returns before/after active documentType so callers can see whether
	// the active canvas actually switched (1 = schematic page, 3 = PCB).
	'sys.document.open': async (params) => {
		return activateDocumentByUuid(params.documentUuid, params.splitScreenId);
	},

	// Activate an already-open tab by its tab id (bring to foreground + make active editor).
	'sys.editor.activate': async (params) => {
		return eda.dmt_EditorControl.activateDocument(params.tabId);
	},

	// Open (if needed) AND fully activate a document by its UUID — the reliable "focus this
	// document for writes" primitive. Returns {tabId, activated, beforeDocumentType,
	// afterDocumentType, switched, note} for diagnosis.
	'sys.editor.setActiveDocument': async (params) => {
		return activateDocumentByUuid(params.documentUuid);
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

		// itemType uses mixed case in the project tree ("Schematic", "PCB", "Board") —
		// compare case-insensitively (uppercase-only checks silently found nothing → the
		// "No schematic found" bug even when get_project lists schematics).
		for (const item of project.data) {
			const t = String((item as any).itemType || '').toUpperCase();
			if (!schPageUuid && t === 'SCHEMATIC') {
				const sch = item as any;
				if (sch.page && sch.page.length > 0) {
					schPageUuid = params.schematicPageUuid || sch.page[0].uuid;
				}
			}
			if (!pcbUuid && t === 'PCB') {
				pcbUuid = params.pcbUuid || (item as any).uuid;
			}
			if (schPageUuid && pcbUuid) break;
		}

		// Also check under boards (schematic+PCB pairs)
		if (!schPageUuid || !pcbUuid) {
			for (const item of project.data) {
				if (String((item as any).itemType || '').toUpperCase() === 'BOARD') {
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

		// Activate the PCB tab so it's the active editor (writes target it) after opening.
		let pcbActivated = false;
		try { pcbActivated = await eda.dmt_EditorControl.activateDocument(pcbTabId); } catch { /* non-fatal */ }

		return {
			projectName: project.friendlyName,
			projectUuid: project.uuid,
			schematicPageUuid: schPageUuid,
			schTabId,
			pcbUuid,
			pcbTabId,
			pcbActivated,
			splitScreen: splitResult,
		};
	},
};
