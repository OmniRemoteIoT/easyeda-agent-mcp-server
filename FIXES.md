# EasyEDA Agent MCP — Fix Log & Handoff

Status reference for the fixes applied to this server (June–July 2026). Written for a
parallel session driving a real design to know what's fixed, what to load, and how to verify.

## How to load a fix

Extension changes ship in the `.eext`; server changes ship in `dist/`.

- **Extension-side change** (anything in `src/extension/**`): bump `version` in
  `extension.json`, `npm run build`, then in EasyEDA Pro **Advanced → Extensions →
  Import**, pick `build/dist/easyeda-agent-mcp-server_v<ver>.eext`, confirm overwrite,
  **restart EasyEDA Pro**. Check the loaded version via **Claude → About**.
- **Server-side change** (`src/mcp-server/**`): `npm run compile`, then `/mcp` →
  reconnect easyeda-pro in Claude Code (restarts `node dist/mcp-server/index.js`).

Only **one** Claude session can own the EasyEDA bridge (extension connects out to fixed
port 15168). To hand it to another session: stop this session's easyeda-pro server
(`/mcp` disable, or kill the process); the other session's server auto-binds within ~5s
(retry loop); then **Claude → Connect Claude** (or focus the window) in EasyEDA.

## Current build: v1.1.7

| Ver | Change | Side | Verified |
|-----|--------|------|----------|
| 1.1.0→1.1.1 | Bridge no longer crashes on `EADDRINUSE` (the `-32000`); retries bind | server | ✅ |
| 1.1.1 | `rename`/`open_project`/`open_document`/`open_*_side_by_side` were plain-object schemas → SDK stripped args; converted to Zod | server | ✅ |
| 1.1.2 | `sch_modify_component` rewrite: try `modify` → `get()+setState` → `getAll()+setState`, resolve canonical `$1I..` id, report `via` | ext | ✅ (single board) |
| 1.1.2 | Stability: `focusEditorTab` stopped re-opening the current doc every command (WS thrash); identify retry | ext | ✅ |
| 1.1.3 | Case-insensitive project traversal (board `itemType` is `"Board"`, not `"BOARD"`) | ext | ✅ |
| 1.1.4 | Auto-reconnect on EasyEDA window `focus` event (beats background timer throttling) | ext | ✅ |
| 1.1.4 | `sch_run_drc` returns `{passed, note}`; net flags kept fire-and-forget (API sends no response) | server | ✅ |
| 1.1.4 | Docs: wires don't auto-net (use `sch_set_netlist`); import needs "Apply Changes"; PCB units are mil | server | ✅ |
| 1.1.5 | `focusEditorTab` reliable single-board switch (tracked last editor) | ext | ✅ (single board) |
| 1.1.6 | `sch_get_all_components`/`pcb_get_all_primitives` `compact:true` (~90% fewer tokens) | server | ✅ |
| 1.1.6 | Correct pour/fill polygon format in docs: `[x1,y1,"L",x2,y2,...]` (start point FIRST) | server | ✅ |
| 1.1.6 | `sch.component.delete` resolves via `getAll()` (schematic doc), not raw by-ID | ext | ⏳ needs live test |
| **1.1.7** | **Multi-board fix (below)** | ext | ⏳ **needs live test** |

## The blocking bug this fixes (v1.1.7)

**Symptom (multi-board project):** `sch_get_all_components` always returned the FIRST
board's parts (e.g. "Iris Wand PRO", 87 parts) regardless of which board's tab was
focused, ignored `open_document`, and force-switched the UI to that board. Single-ID
`get`/`modify`/`delete` failed with `对象未在 PCB 画布初始化，不存在 PrimitiveId`.

**Root cause (a regression from the seamless-dual-editor change):** `focusEditorTab`
called `findEditorDocUuid()` — the FIRST board's schematic/PCB — and `openDocument`'d it
before *every* `sch.*`/`pcb.*` command. So it kept dragging the editor to board[0] and
reading/resolving there. The single-ID ops then failed because they resolved on the
wrong document.

**Fix:** `focusEditorTab` now:
- does **nothing** if the focused tab is already the right editor type (checks
  `getCurrentDocumentInfo().documentType`: 1 = schematic page, 3 = PCB) — respects the
  board you're on;
- only switches when the type is genuinely wrong, preferring the **same board's** paired
  doc (`findPairedDocUuid`), falling back to board[0] only if the current board can't be
  identified.

Because get/modify/delete resolve via `getAll()` (which now runs against the focused
board), this should fix the single-ID ops too.

## Verify v1.1.7 (do this after re-import + restart)

1. Focus a **non-first board's** schematic tab (e.g. the blank "Iris Wand").
2. `sch_get_all_components` → should return **that board's** parts (empty for a blank
   board), **not** board[0]'s, and must **not** drag the UI to board[0].
3. `sch_modify_component` / `sch_delete_component` on a part there → should succeed.

If step 2 still returns board[0], then `getCurrentDocumentInfo()` itself is misreporting
the active board — flag it and the MCP-dev session will debug live.

## Iris Wand project UUIDs (from `get_project`, which works reliably)

| Board | Schematic page | PCB |
|-------|----------------|-----|
| Iris Wand (blank — build target) | `6b7beda30e0b4092ac1eeda4391d0d55` | `6e1a59ed54fc4382b0f438f02fbde4fd` |
| Iris Wand PRO (old 87-part; what reads wrongly returned) | `5c403a28…` | `7e33f343…` |
| Iris Wand LITE (old) | `d6788341…` | `872b9baf…` |

## Known EasyEDA-API limits (documented, not fixable in the server)

- API-drawn wires / net flags do **not** form electrical nets — use `sch_set_netlist`
  for programmatic connectivity (no connectivity-rebuild API exists).
- `pcb_import_changes` opens a modal and returns before applying — user must click
  "Apply Changes".
- PCB primitive coordinates/sizes are in the document display unit (**mil** by default).
- Project rename (`rename` target `project`) usually no-ops on the open project;
  schematic/PCB/board renames work.
- Schematic DRC returns only a boolean (no per-violation list, unlike PCB DRC).
