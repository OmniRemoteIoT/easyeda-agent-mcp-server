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

## Current build: v1.1.8

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
| 1.1.6 | `sch.component.delete` resolves via `getAll()` (schematic doc), not raw by-ID | ext | ✅ |
| **1.1.7** | **Multi-board fix (below)** | ext | ✅ **confirmed** — read-targeting + get/modify/create all work on the focused board |
| 1.1.7 | **Malformed-envelope fix**: `sch_set_netlist` + single-id `sch_get_component` returned `text: undefined` (`JSON.stringify(undefined)` is not a string) → MCP `-32602 invalid result`. New `textResult()` helper always emits a string; single-id miss returns `{found:false}` | server | ⏳ reconnect to verify |
| 1.1.7 | `sch_set_netlist` now reads the netlist back and reports `changed` — exposes EDA Pro's @beta setNetlist silently no-op'ing instead of returning a bad void | server | ⏳ reconnect to verify |
| **1.1.8** | **Connectivity unblock (below)**: new `pcb_set_netlist` / `pcb_get_netlist` wrap `PCB_Net.setNetlist` — a **@public** API returning a real `boolean` (vs the schematic's dead `@beta` void). Applies a netlist to the placed footprints by designator-pin, building the ratsnest. Reports `applied` (API bool) + `changed` (read-back) | ext + server | ⏳ needs live EDA Pro to verify |

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

## Connectivity: `sch_set_netlist` is dead, but `pcb_set_netlist` is a live path (v1.1.8)

The MCP_WRITE_BUG_REPORT asked to rule out 5 alternative connectivity paths before
closing Defect 2. Result of walking `@jlceda/pro-api-types` (v0.1.156):

| # | Alt-path proposed | Verdict from SDK types |
|---|-------------------|------------------------|
| 1 | `SCH_Document.importChanges()` ingests a netlist/ECO | **Dead.** Signature is `importChanges(): Promise<boolean>` — takes **no args** and pulls **from PCB** (「从 PCB 导入变更」). It cannot accept a netlist. |
| 2 | Invoke native *File → Import Netlist* command programmatically | **Dead.** `SYS_HeaderMenu` only inserts/removes/replaces the *extension's own* menus; `SYS_ShortcutKey` only registers *extension* shortcuts; `SCH_Utils` exposes only `splitLines`. No command-id / menu-execute API. |
| 3 | API wires/flags promote to nets after save + reload | **Untested** (needs live EDA Pro) — but moot given path #6. |
| 4 | Lower-level net-model write (`SCH_Net.rebuild()`) | **Dead.** There is **no `SCH_Net` class** (only `PCB_Net`). `SCH_PrimitivePin` has no net-name state. The only schematic net API is `SCH_Netlist` {getNetlist @public, setNetlist @beta void}. No rebuild/refresh. |
| 5 | `setNetlist` preconditions (save-first / commit) | Return type is `Promise<void>` — no success signal regardless; not worth chasing on the sch side given #6. |
| **6** | **(new) Apply the netlist to the PCB instead** | **LIVE LEAD.** `PCB_Net.setNetlist(type, netlist)` is **`@public`** and returns **`Promise<boolean>`** — a real, non-beta path with a success flag. Now exposed as `pcb_set_netlist`. |

**So the schematic net model has no working programmatic writer, but the PCB one does.**
For a fully-placed design whose goal is PCB layout, apply the 68-net Protel2 netlist
directly to the PCB with `pcb_set_netlist` (footprints must be on the PCB first — via
`pcb_import` from the schematic, or the netlist's own `[components]` blocks). This
builds the net model + ratsnest and satisfies forward-tests C/D directly, bypassing the
dead `sch_set_netlist`. **This is unverified live** (no EDA Pro connection this session) —
run the acceptance test below when connected.

### Verify `pcb_set_netlist` (do after re-import + restart, PCB tab focused)
1. `pcb_get_netlist(Protel2)` → snapshot current PCB nets.
2. `pcb_set_netlist(Protel2, wand_full.protel2.txt)` → expect `{applied:true, changed:true}`.
3. `pcb_get_all_nets` → lists GND/+3V3/VBAT/… (the 68).
4. If `applied:false`, footprints likely aren't placed / designators don't match — run
   `pcb_import` first, or the dialect doesn't match `type`.

## Known EasyEDA-API limits (documented, not fixable in the server)

- API-drawn wires / net flags do **not** form electrical nets, and **schematic**
  `sch_set_netlist` (EDA Pro's `sch_Netlist.setNetlist`, `@beta`, returns `void`)
  **frequently no-ops**. Our tool snapshots before/after and returns `changed`; when
  `changed:false`, there is no **schematic-side** connectivity writer — establish
  connectivity on the **PCB** via `pcb_set_netlist` (see above) or use native
  **File → Import Netlist**.
- `pcb_import_changes` opens a modal and returns before applying — user must click
  "Apply Changes".
- PCB primitive coordinates/sizes are in the document display unit (**mil** by default).
- Project rename (`rename` target `project`) usually no-ops on the open project;
  schematic/PCB/board renames work.
- Schematic DRC returns only a boolean (no per-violation list, unlike PCB DRC).
