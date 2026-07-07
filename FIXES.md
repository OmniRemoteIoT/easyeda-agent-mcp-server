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
port 15168). As of **v1.2.0** this is self-healing: a session's server exits when the
session ends (frees the port), and a newer session **evicts** an older one automatically
(takeover handshake). To hand the bridge to another session, just start/reconnect
easyeda-pro there — it takes over within ~1.5s; the extension re-attaches on its
staleness check (~25s) or immediately on EasyEDA window focus. Manual eviction
(`/mcp` disable / kill) is no longer required. See v1.2.0 below.

## Current build: v1.2.8

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
| **1.1.9** | **File-path netlist ingestion (below)**: `pcb_set_netlist` + `sch_set_netlist` now take an optional `path` (mutually exclusive with `netlist`). The **server** reads the file from disk, so a real ~150 KB / 68-net board's netlist no longer has to be emitted inline by the model (which blew the output-token limit) and its **CRLF is preserved byte-for-byte** (inline JSON tool args normalize `\r\n`→`\n`, corrupting Protel2). Pure server-side change — no `.eext` re-import | server | ✅ helper unit-tested; ⏳ needs live EDA Pro end-to-end |
| **1.2.0** | **Session lifecycle & takeover (below)**: server now exits when the Claude session ends (`stdin` EOF / `transport.onclose`), so it no longer orphans and squats on port 15168; and a newer session **evicts** an incumbent via a `takeover` handshake instead of waiting on the passive rebind loop. Fixes the "MCP won't disconnect / can't take over" problem — no more manual PID hunting. Pure server-side change — no `.eext` re-import | server | ✅ takeover + stdin-exit verified end-to-end (real pipe) |
| **1.2.8** | **`pcb_create_polyline_track` bad-polygon fix (below)**: with the framework unblocked (v1.2.7), the board-outline write STILL failed `无法创建多边形图元…参数不正确` — a REAL parameter bug, not focus. `PCB_PrimitivePolyline.create(net, layer, polygon, lineWidth)` wants an **`IPCB_Polygon` object** (built via `pcb_MathPolygon.createPolygon(sourceArray)` from the flat `[x1,y1,"L",x2,y2,…]` format), but the handler passed the raw `[{x,y},…]` point list, which the API rejects. Fixed: the `pcb.create.polyline` handler now converts the point list → source array → `IPCB_Polygon` (same pattern the working `region` handler uses). Live-confirmed via `bridge_diagnose` that reads (`pcb.net.getAllNetsName`, layers) work — proving the failure was the polygon param all along | ext | ✅ CONFIRMED live — outline polyline created (primitiveId returned) |
| **1.2.7** | **THE root cause — `getCurrentDocumentInfo` doesn't exist in the runtime (below)**: `bridge_diagnose` run live returned `getCurrentDocumentInfo → "is not a function"` while `getCurrentProjectInfo`, `getSplitScreenTree`, and **`pcb.net.getAllNetsName` (68 nets) all WORK**. The type package declares `getCurrentDocumentInfo` but the EDA Pro runtime lacks it — so the entire v1.2.x detection/focus/preflight stack was gating on a method that always throws, and v1.2.5's preflight was BLOCKING every editor command. Fix: removed ALL dependence on `getCurrentDocumentInfo` — deleted the preflight + focusEditorTab + active-doc detection; `wrapHandler` now just runs the handler and surfaces the raw error; `get_editor_context` bases `editorContextHealthy` on `getCurrentProjectInfo` (which works) and reports `editorType:"unknown"` by design; `set_active_editor` drops the impossible read-back. `bridge_diagnose` enhanced to enumerate the REAL runtime methods (`dmtEditorControlMethods`) + full split tree. Net: editor commands are UNBLOCKED; the single global instance reaches `pcb_*`/`sch_*` directly | ext + server | ✅ CONFIRMED live — pcb reads (68 nets, layers) work |
| **1.2.6** | **`bridge_diagnose` tool (below)**: new low-level diagnostic that probes the extension↔editor binding in one call — reports which `eda.*` namespaces exist and, for `getCurrentDocumentInfo` / `getCurrentProjectInfo` / `getSplitScreenTree` / `pcb.net.getAllNetsName`, whether each succeeds, its latency (ms), and value/error. Bypasses the editor preflight. Built to pinpoint the detached-context asymmetry (the instance can issue `openDocument`/enumerate tabs but `getCurrentDocumentInfo`→null and `pcb.net.*` hangs). SDK research confirmed the model: a SINGLE global extension instance (not per-editor), APIs act on the focused document, and there is NO editor-activation event (only window blur/focus) — so auto-recovery hooks are limited; this tool is the setup for a live pinpoint session | ext + server | ⏳ run live with the canvas focused |
| **1.2.5** | **Detached-context fail-fast (below)**: live test on v1.2.4 revealed the real problem — after some restarts the extension activates (`onStartupFinished`) in a **background/non-editor context**: `getCurrentDocumentInfo()` returns null and editor-scoped APIs (`pcb.net.getAllNames`) **hang for the full 120 s** before the bridge times out. Can't fix the EDA host-context binding from here (needs live iteration / EDA SDK), but made it non-miserable: (1) **preflight** on every `sch.`/`pcb.` command — if there's no active editor document, reject in ~3 s with an actionable message ("bridge is in a non-editor context — click the canvas and Connect Claude from the editor menu") instead of hanging 120 s; (2) `get_editor_context` now returns **`editorContextHealthy`** (+ `hint` when false) so the state is visible at a glance; (3) a proactive EDA Pro **warning toast** on connect when the bridge binds to a non-editor context. The actual re-bind is the user action (Connect Claude from the focused editor). **ext only** — re-import the v1.2.5 `.eext` + restart | ext | ⏳ mitigation; root host-context fix still needs a live session |
| **1.2.4** | **PCB-write block, take 2 — active-editor detection + activation (below)**: v1.2.3's `activateDocument` didn't fix it — live test showed `connectedEditors` is ALWAYS `["schematic"]` and `set_active_editor` returned `activated:true` but the active doc never changed. **Real root cause: `detectEditorType()` checks `eda.sch_Document` presence, which is a globally-present API object → it ALWAYS returns 'schematic'**, so the client mis-identifies and detection never consults the authoritative `getCurrentDocumentInfo().documentType`. Fixes: (1) editor-type detection + `get_editor_context` now use `getCurrentDocumentInfo` FIRST (namespace only as last resort); (2) `focusEditorTab`/`set_active_editor` now also activate the split-screen **pane** (`activateSplitScreen`), not just the tab — the active doc follows the pane in split view; (3) `set_active_editor`/`open_document` return `{beforeDocumentType, afterDocumentType, switched, note}` so it's visible whether the canvas actually switched; (4) `wrapHandler` only appends the "focus a tab" hint when the right editor is genuinely NOT active — otherwise it surfaces the RAW error (the `无法创建多边形图元…参数不正确` may be a real param error, not focus). If activation still can't switch the canvas, the error now says to open ONLY the PCB and Connect Claude from it | ext + server | ⏳ live re-test — the new before/after diagnostics will confirm whether the API can switch the active canvas |
| **1.2.3** | **PCB writes blocked after reconnect — active-editor not activated (below)**: `focusEditorTab` + `open_document` called `openDocument()` (opens a TAB) but never `activateDocument(tabId)` (makes it the ACTIVE editor that writes target), so after a reconnect the active-doc pointer stuck on the schematic and every PCB write failed with "make sure a … tab is focused" despite the PCB tab being open. Now both activate the tab. **New `set_active_editor(documentUuid)`** tool (open+activate) as the explicit fix. `get_editor_context` now also reports bridge-authoritative `connectedEditors` + `clientCount` (the old single-instance answer could "lie" after reconnect). Extension re-identifies its editorType to the bridge when it resolves post-reconnect (routing self-heal). Also fixed: `open_schematic_and_pcb_side_by_side` "No schematic found" (uppercase `itemType` compare vs mixed-case `Schematic`/`Board`), and `pcb_manage_layers action:"select"` malformed `text:undefined` envelope (now `textResult`). **ext + server** — `.eext` re-import + restart for the activate/side-by-side fixes; `/mcp` reconnect for the tool/envelope fixes | ext + server | ⏳ needs live EDA Pro to confirm PCB writes unblock |
| **1.2.2** | **Schematic connectivity, unified as a tool (below)**: new **`sch_inject_connectivity`** writes real schematic nets into the `.eprj` SQLite as named wire-stubs (the extension API can't — `setNetlist` no-ops, API wires stay inert; EDA computes connectivity from the injected geometry on file open). Ports the validated `inject_netlist.mjs` logic into the server: parses a Protel2 netlist, computes each pin from its symbol (stub direction from the pin's rotation field), runs 2 geometric self-checks (no stub hits a foreign pin; no different-net stubs touch), writes a new project copy (or in-place with EDA closed). **Live-verified on Iris Wand: 68 nets / 362 pins exact match + ERC pass.** Needs the `sqlite3` CLI on the server PATH. Server-side — `/mcp` reconnect | server | ✅ injection logic verified vs real board; ⏳ live tool call needs a connected session |
| **1.2.1** | **Easier netmapping (below)**: new **`pcb_apply_netlist`** — one call that runs `pcb_import_changes` (schematic→PCB, so the footprints exist) then `PCB_Net.setNetlist`, the whole connectivity flow in one shot. Both it and `pcb_set_netlist` now run a **preflight** (footprint count on the PCB + netlist component/net counts + designator cross-check) so a failed apply says *why* — "PCB has 0 footprints, run the import first" or "designators U3/U4 aren't on the PCB" — instead of an opaque `applied:false`. Parser `parseNetlistSummary` validated against the real 113-part/68-net `wand_full.protel2.txt`. Pure server-side change — no `.eext` re-import | server | ✅ parser verified vs real board file; ⏳ needs live EDA Pro end-to-end |

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
2. `pcb_set_netlist(Protel2, path="…/Hardware/wand_full.protel2.txt")` → expect `{applied:true, changed:true}`. (Use `path`, not inline — see v1.1.9 below.)
3. `pcb_get_all_nets` → lists GND/+3V3/VBAT/… (the 68).
4. If `applied:false`, footprints likely aren't placed / designators don't match — run
   `pcb_import` first, or the dialect doesn't match `type`.

## The transport fix: file-path netlist ingestion (v1.1.9)

`CONNECTIVITY_SOLUTION_BRIEF.md` §3 identified that even with `pcb_set_netlist` working,
**the netlist could not travel through an inline MCP tool argument**, for two independent
reasons:

1. **Output-token limit.** A ~150 KB netlist (≈40K tokens) must be emitted *inline* by
   the model as it generates the tool call — it hits the per-response output ceiling
   mid-argument. The file can't be produced as an argument at all.
2. **CRLF corruption.** `sch_get_netlist(Protel2)` round-trips **CRLF** (`\r\n`). When the
   model emits the argument as a JSON string, newlines normalize to **LF** (`\n`) — CRLF
   is lost before the payload reaches the API.

**Fix:** both `pcb_set_netlist` and `sch_set_netlist` now accept an optional **`path`**
(mutually exclusive with `netlist`). When `path` is given, the **Node server** reads the
file from disk itself (`resolveNetlistInput` in `tools/util.ts`) and passes the exact bytes
over the WebSocket bridge — JSON-over-WS preserves `\r\n`. The model passes a ~40-char path,
not 150 KB, so **both the token limit and the CRLF loss are sidestepped**. `~` is expanded;
relative paths resolve against the server cwd (absolute preferred). Exactly one of
`netlist`/`path` is required; missing/unreadable files return a clear `{submitted:false,error}`.

This is a **pure server-side change** — `npm run compile` + `/mcp` reconnect, **no `.eext`
re-import**.

### Verify file-path ingestion (PCB tab focused, footprints placed)
1. `pcb_get_netlist(Protel2)` → snapshot.
2. `pcb_set_netlist(type="Protel2", path="/…/OmniRemote-PhysicalRemote/Hardware/wand_full.protel2.txt")`
   → expect `{submitted:true, applied:true, changed:true}`. **Pass an absolute path.**
3. `pcb_get_all_nets` → the 68 nets. Then forward-tests C→D→E.
4. Bad path → `{submitted:false, error:"Could not read netlist from path … file not found …"}`
   (no bridge call made). Passing both `netlist` and `path` → `error` about EITHER/OR.

The `resolveNetlistInput` helper is unit-tested (inline-verbatim, CRLF-preserved read,
both/neither/missing-file errors all pass); the live end-to-end apply still needs an EDA Pro
connection to confirm `applied:true/changed:true` on the real board.

## Easier netmapping: `pcb_apply_netlist` + preflight diagnostics (v1.2.1)

**Problem:** connectivity has to happen on the PCB (the schematic side is permanently dead
— EDA Pro never recomputes API-created wires/labels/`setNetlist`; see `MCP_NETLIST_CONNECTIVITY_FINDINGS.md`).
The PCB path (`pcb_import_changes` to place the footprints → `pcb_set_netlist` to assign nets)
worked, but was **two manual steps** and failed **opaquely**: an empty PCB or a designator
mismatch just returned `applied:false` with a generic "check your designators" guess, so a
session couldn't tell whether the fix was "run the import first" or "your netlist is wrong."

**Fix — two server-side additions (`tools/write-tools.ts`, `tools/util.ts`):**

1. **`pcb_apply_netlist` — the one-shot easy button.** Runs `pcb.document.importChanges`
   (schematic → PCB, so the 113 footprints exist) **then** `PCB_Net.setNetlist` in a single
   call. Takes the same `type` / `netlist` / `path` as `pcb_set_netlist`, plus
   `schematicUuid` (import source) and `skipImport:true` (footprints already placed). This is
   the programmatic equivalent of the manual "PCB → File → Import → Netlist" the user was
   doing by hand.
2. **Preflight on both `pcb_apply_netlist` and `pcb_set_netlist`.** Before calling the API it
   reads `pcb.getAll.component` (footprint count + designators) and parses the netlist
   (`parseNetlistSummary`), then:
   - **0 footprints → hard stop** with `{submitted:false, note:"PCB has 0 footprints … run
     pcb_apply_netlist or pcb_import_changes first"}` (doesn't waste the API call).
   - Cross-checks netlist designators vs. placed footprints and, when the apply fails, names
     the **missing designators** in the note + `preflight.missingFromPcb` instead of guessing.
   - Reports `preflight: {footprintsOnPcb, netlistComponents, netlistNets, missingFromPcb, missingCount}`.

`parseNetlistSummary` parses the Protel2 dialect (`[…]` component blocks → designators,
`(…)` net blocks → net names + `DESIG-PIN` refs); other dialects degrade to `format:"unknown"`
with null counts so the diagnostic never reports wrong numbers. Verified against the real
`wand_full.protel2.txt`: **113 components, 68 nets, all 109 referenced designators resolve,
CRLF intact.**

**Pure server-side change** — `npm run compile` + `/mcp` reconnect, **no `.eext` re-import**
(uses only pre-existing bridge handlers).

### Verify (PCB tab focused)
1. Blank PCB → `pcb_set_netlist(type="Protel2", path="…/wand_full.protel2.txt")` → expect
   `{submitted:false, note:"PCB has 0 footprints …"}` (the hard stop).
2. `pcb_apply_netlist(type="Protel2", path="…/wand_full.protel2.txt")` → expect
   `{importedChanges:…, submitted:true, applied:true, changed:true, preflight:{footprintsOnPcb:113, netlistComponents:113, netlistNets:68, missingCount:0}}`.
3. `pcb_get_all_nets` → the 68 nets. If `applied:false`, read `note` / `preflight.missingFromPcb`.

## Session lifecycle & takeover (v1.2.0)

**Symptom:** the MCP server didn't disconnect when a Claude session ended. Ending a
session left an **orphaned `node dist/mcp-server/index.js`** still holding port 15168, so
the next session hit `EADDRINUSE`, reported "extension not connected" for every tool, and
the user had to manually find and `kill` the zombie PID before another session could work.

**Root cause:** the MCP server is the WebSocket *server* (the extension dials *in* to fixed
port 15168), so only one process can own the port. `index.ts` only handled
`SIGINT`/`SIGTERM`. When a session ends, Claude Code closes the server's **stdin** — but the
`WebSocketServer` plus the 10 s ping intervals keep Node's event loop alive, so closing
stdin alone never exited the process. It orphaned and squatted on the port.

**Fix (two complementary, server-side changes):**
- **Exit with the session** (`index.ts`): a single-shot `shutdown()` is wired to
  `transport.onclose`, `process.stdin` `end`/`close`, *and* the existing signals. Closing
  stdin (session end) now stops the bridge and exits → the port frees immediately.
- **Active takeover** (`bridge.ts`): on `EADDRINUSE` the new server connects to the
  incumbent and sends `{type:"takeover", pid}`. The incumbent's message handler invokes
  `onTakeover` (wired to `shutdown` in `index.ts`) → it stops and exits, and the newcomer
  binds on the next retry (now **1.5 s**, was 5 s). "Latest session wins." A takeover-unaware
  old build simply ignores the message and the passive rebind loop still eventually wins, so
  it's backward-safe.

**Handoff note:** after a takeover the extension's socket to the old server drops; it
re-attaches to the new server via its staleness check (~25 s) or immediately on EasyEDA
window **focus**. Pure server-side change — `npm run compile` + `/mcp` reconnect, **no
`.eext` re-import**.

### Verify session lifecycle (no live EDA Pro needed)
1. Start server on a scratch port, confirm it `LISTEN`s: `EDA_WS_PORT=15197 node dist/mcp-server/index.js` fed by a real pipe.
2. Close the pipe (simulates session end) → log shows `Shutting down (stdin end)` and the port frees. ✅
3. Start server A, then server B on the same port → B logs `EADDRINUSE`, A logs `Takeover requested … relinquishing`, A **exits**, B binds. ✅
   (Verified with real anonymous pipes — note a **FIFO** does *not* deliver EOF to Node like the anonymous pipe `spawn` uses, so test with a real pipe, not `mkfifo`.)

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
