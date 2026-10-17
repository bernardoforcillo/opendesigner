# Handoff: Dev mode inspect and syncing tokens and components with code

Status: draft for review. Date: 2026-10-15. Scope: roadmap section 3 only
(`docs/roadmap.md`: "Dev mode ... CSS/Tailwind/React and measurements" is ticked;
"Syncing components with the code" is open; "Tokens in and out" is ticked but one-way
and web-only; "Variables: ... CSS custom properties per mode in the exported code"
in section 1 is open and is a prerequisite). No product code is part of this document.

## 1. Goal

Make the design and a code repository two views of the same system:

1. **Inspect (Dev mode):** select any layer and read its measurements, CSS, Tailwind
   and React snippet, with tokens shown by name instead of resolved values.
2. **Sync tokens:** variables/modes in the document and a token file in the repo
   (DTCG JSON + CSS custom properties) stay aligned in both directions.
3. **Sync components:** components, variant sets and properties in the document map to
   React components and their props in the repo, with a stable link and a visible
   drift report.

Non-goals: a cloud service, Figma-style Code Connect hosting, arbitrary framework
support (React + Tailwind v4 and HTML only, as today), parsing arbitrary hand-written
React into design nodes, text/spacing/alias variables (separate roadmap item, but
see section 8).

## 2. Current state (with citations)

Code generation (Go, one implementation for CLI, RPC and MCP):
- `internal/codegen/codegen.go`, `build.go`, `ir.go`, `css.go`, `tailwind.go`,
  `react.go`, `html.go`: one IR, CSS and Tailwind from the same tree, deterministic
  bytes (`docs/codegen.md`). Every element carries `data-node-id`; screens are
  top-level frames, named by `meta["code.component"]` and routed by `meta["code.route"]`
  (`docs/codegen.md`, "What a screen is").
- Variables are **resolved**, not emitted: `build.go` `element()` calls
  `core.ResolveNode` and the output contains literal values
  (`docs/variables.md` "Not yet": "Emitting CSS custom properties per mode ... instead
  of resolved values"). So the generated code has no token names.
- Components: instances are **expanded inline**; there is no extraction into React
  components (`react.go` README text: "Component instances are expanded inline").
  The chosen variant and property values are exported by value (`docs/components.md`,
  "Code generation exports the variant the instance chose").
- Component model (`docs/components.md`): `ComponentSet {axes}`, component
  `set_id` + `variant` map + `properties` (BOOLEAN, TEXT), instance
  `variant_props` + `property_values`; ops `SetComponentDef`, `SetInstanceProps`.
- Write path: `internal/codegen/write.go` `WriteFiles` refuses a non-empty directory
  unless `-force`, then overwrites generated files and leaves others alone.
  `cmd/opendesigner/export.go` is offline and read-only on the document.

Tokens:
- DTCG JSON and CSS custom properties export, and DTCG import, exist only in the
  web app: `web/src/tokens/tokens.ts` (`toDtcg`, `toCssVariables`, `fromDtcg`),
  exposed in the variables dialog (`docs/handoff.md` "Tokens in and out"). Modes ride in
  `$extensions."com.opendesigner".modes`; CSS puts mode 1 in `:root` and others in
  `[data-theme="<mode>"]`. Import always creates **new** collections.
- There is **no** Go implementation, so no CLI command, RPC or MCP tool can read or
  write tokens (MCP only has `list_variables`, `create_collection`, `set_variable`,
  `bind_variable`... in `internal/mcp/variables.go`).

Dev mode:
- `web/src/ui/dev/CodeWorkbench.tsx` + `web/src/dev/codegen.ts` fetch `ExportCode`
  from the server (debounced, cancelled, never during a gesture) and show **files**;
  selecting a node picks its screen's file (`screenOf`). Inspect is therefore
  per screen file, not a per-layer snippet.
- `web/src/dev/measure.ts`: size/position in parent and gaps to parent edges and
  nearest siblings (Ship panel). `web/src/dev/ship.ts`: zip and commands.
  `web/src/dev/highlight.ts`: dependency-free highlighter.
- `internal/review` + `review_design` MCP tool: includes a `token` rule (literal color
  equal to a variable's value but unbound).

Git format: `internal/pack/pack.go` (`opendesigner pack/unpack`): the design itself
as stable files; useful as the precedent for stable, diffable output and for the
"design lives in the repo" model.

## 3. Exists versus missing

| Capability | Exists | Missing |
|---|---|---|
| Measurements of a selection | yes (`dev/measure.ts`) | copy-as-redline overlay on canvas; distances to non-siblings |
| Whole-screen CSS/Tailwind/React | yes | **per-layer snippet** for the selection (CSS, Tailwind classes, JSX) with `data-node-id` mapping back to a sub-tree of the IR |
| Token names in inspect and code | no | emit `var(--token)` / Tailwind theme names instead of resolved values |
| Tokens JSON/CSS export | web only | Go implementation (CLI, RPC, MCP); Tailwind v4 `@theme` output |
| Tokens import | web only, new collections only | update-in-place merge by token path; deletions; conflict report |
| Components in code | inline expansion | extraction to `src/components/<Name>.tsx` with props typed from variant axes and properties |
| Component link to code | `meta["code.component"]` on screens only | stable mapping component id <-> file/export; drift report |
| Sync workflow | `export -force` overwrite | watch mode, three-way state, conflict handling, round trip of tokens |

## 4. Sync direction, format and conflicts

Principle: **code is a first-class source for tokens, a derived artifact for
components**. Reason: tokens are plain data and engineers edit them; components carry
hand-written logic that opendesigner must never overwrite or try to parse.

### 4.1 Tokens (bidirectional)

Files in the repo (default dir `design/`, configurable):
- `design/tokens.json`: DTCG, exactly today's `toDtcg` shape (modes in the
  `com.opendesigner` extension), made canonical (sorted keys, 2-space indent, one
  trailing newline, same rules as `internal/pack`).
- `design/tokens.css`: `:root` plus `[data-theme]` blocks (today's `toCssVariables`),
  generated from the JSON, never edited by hand.
- `design/tokens.theme.css` (optional): Tailwind v4 `@theme { --color-surface: ... }`.
- `design/.opendesigner-sync.json`: **base snapshot** (hash per token, document id,
  tool version). Committed. This is what makes a three-way compare possible.

Token identity is its **path** (`Theme/color/surface`), not the variable id, because the
repo has no ids. A rename in the design is a delete + add unless the user maps it
(open question 3).

Three-way rule per token, comparing design (D), file (F) and base (B):
- D==B, F!=B: file wins, design updated (pull).
- F==B, D!=B: design wins, file rewritten (push).
- both changed, equal: no-op. Both changed, different: **conflict**; nothing is written
  for that token, it is reported with all three values, and the command exits non-zero.
  Resolution is explicit: `--prefer design|code` per run, or `--resolve path=design|code`.
- Tokens of an unsupported type (anything but color/number today) are preserved verbatim in
  the file (round-trip safe) and skipped in the design, never dropped.

### 4.2 Components (design -> code, with a drift check back)

Generated files, in a dedicated directory the tool owns:
`src/design/components/<Name>.tsx`, `src/design/components/index.ts`,
`src/design/components.manifest.json`.

A component with a variant set becomes:
```
type ButtonProps = { state?: "default" | "hover"; label?: string; showIcon?: boolean };
export function Button({ state = "default", label = "Button", showIcon = true }: ButtonProps) { ... }
```
Axes become union-typed props, TEXT and BOOLEAN properties become `string` / `boolean`
props with the design's defaults; the body is the master's IR for each variant
(selected by a lookup keyed on the axes), with the property targets wired to the props.
Screens then use `<Button state="hover" label="Buy" />` instead of an inline expansion.

The **manifest** records, per component: design component id, set id, export name,
file path, hash of the generated content, and props signature. It is the stable link
(replaces guessing from names) and the drift record.

Ownership and conflicts:
- Files under `src/design/` carry a "generated" header and a content hash in the
  manifest. If the file's hash differs from the manifest on the next run, the file
  was edited by hand: the tool **does not overwrite**, writes the new output next to it as
  `<Name>.generated.tsx`, and reports `drift`. This is the whole conflict model;
  there is no merge of TSX.
- The escape hatch for hand-written behavior: a component marked `code: "manual"`
  (meta `code.mode=manual`) is **not generated**; only its props contract is checked.
- Code -> design for components is **check only**: `opendesigner sync check` compares the
  manifest props signature with the design's axes/properties and reports added,
  removed or retyped props. It never creates or edits design nodes from TSX.

### 4.3 Commands and watch mode

```
opendesigner sync [push|pull|check] -doc <id|name> -dir <repo/design> [--prefer design|code] [--dry-run]
opendesigner sync watch -doc <id> -dir <repo/design>
```
- `push`: design -> files. `pull`: files -> design (tokens only; needs the server, since
  it writes through ops, like the editor does; see 5). `check`: report only, exit codes
  0 clean / 1 drift or conflict / 2 error, for CI.
- `watch`: subscribes to the document (the server already streams changes, as
  presence and collaboration do) and watches the token file with debounce (~300 ms,
  ignoring its own writes by hash). Design change -> push; file change -> pull with the
  same three-way rule. A conflict pauses that token and prints it; watch never
  overwrites silently. Watch needs a running server (`opendesigner serve`); push/check
  can stay offline like `export` and `pack`.
- Writes use temp file + rename, and a dry-run prints the unified diff.

## 5. Panel and MCP impact

Web (Develop mode):
- **Inspect panel** (right): for one selected layer, tabs Measure / CSS / Tailwind /
  React, each a per-layer snippet with copy buttons; tokens appear as names with the
  resolved value as a hint; a "bound to token" chip links to the variable. Needs an
  RPC returning the IR slice for a node id (extends `ExportCode`, see approach).
- **Sync panel** (left or the Ship panel): repo path (dev server only, see open
  question 2), last sync time, counts of in sync / design changed / code changed /
  conflicts, and per-item resolve actions. Component rows show props drift.
- The variables dialog keeps its manual Export/Import (becomes a thin client of the same
  Go core once it exists).

RPC (new): `InspectNode(doc_id, node_id, target)`, `ExportTokens(doc_id, format)`,
`DiffTokens`/`ApplyTokens(doc_id, file, resolutions)` (applies as ordinary ops in one
gesture, so one undo step). Proto change, so `buf generate`.

MCP (new tools, all thin wrappers over `internal/handoff`):
- `inspect_node` (node id, target): CSS/Tailwind/React for one layer.
- `export_tokens` / `import_tokens` (merge mode, dry run).
- `sync_status` (the report of section 4) and `sync_push` (writes files to a dir the
  server was started with, never an arbitrary path from the agent; mirrors
  `export_code`'s `outDir` validation).
- `review_design` gains a rule `unnamed-token-use` only if cheap; otherwise out of scope.

## 6. Approaches

### Approach A: Extend the Go codegen core (recommended)

Add `internal/handoff` (tokens read/write/merge, sync state, manifest) and teach
`internal/codegen` two things: emit token references, and extract components into
files. Web, CLI, RPC and MCP all call the same Go code; the web `tokens.ts` becomes a
client (or is deleted in favour of an RPC, with golden tests moved to Go).

Pros: one implementation, deterministic, offline CLI and CI work, MCP agents get parity
with the UI, fits the existing rule "the server is the only source of generated code"
(`web/src/dev/codegen.ts`). Cons: porting `tokens.ts` and its tests to Go, proto
changes, and codegen changes touch every golden file (large, but mechanical and
reviewable).

### Approach B: Keep TS tokens, add a thin sync layer in the web app plus a file watcher

Use the browser File System Access API (or a Vite-like dev helper) to read/write a
folder; component sync as a one-way export button. Pros: smallest first step, no proto
change. Cons: Chromium-only, no CI/headless use, no MCP access, two implementations
of token logic would persist (TS for sync, Go for code), watch mode only while a tab
is open, and no solution for component extraction (which must live in Go codegen
anyway). It would be rewritten into A later.

### Recommendation

Approach A, delivered so that every step ships value on its own: token references in
code first (benefits Dev mode immediately and is the roadmap's open variables item),
then Go tokens + CLI, then component extraction, then watch and panels. Trade-off
accepted: a bigger up-front refactor in exchange for one core and CI/agent parity.

## 7. Testing plan

- **Golden files** (existing convention in `internal/codegen/testdata`): token
  references in CSS, Tailwind and React for light/dark modes; component extraction for the
  `shop` sample plus a variant-set sample (axes + TEXT + BOOLEAN props).
- **Parity**: extend the CSS-vs-Tailwind parity check to cover `var(--...)` output; a
  test that the React output with tokens renders pixel-equal to the resolved output
  (same canvas semantics) in the existing parity harness.
- **Tokens**: port `web/src/tokens/tokens.test.ts` cases to Go; add round-trip
  (`toDtcg -> fromDtcg -> toDtcg` is byte-identical), unsupported-type preservation,
  rename as delete+add, and three-way merge table tests (every cell of D/F/B
  combinations, including conflicts).
- **Sync state**: temp-dir tests for manifest creation, drift detection when a generated
  file is hand-edited, `.generated.tsx` side file, `--dry-run` writes nothing,
  idempotence (second `push` changes zero bytes), exit codes.
- **Watch**: fake clock and in-memory server; own-write suppression (no feedback loop),
  debounce, conflict pause. One integration test with a real file and a real `serve`.
- **Components**: generated project compiles (`tsc --noEmit`) and the Playwright flow tests
  from `flow tests` still pass on the extracted components (the existing shop
  pipeline already does this for screens).
- **Web**: component tests for the Inspect and Sync panels (the `dev.test.tsx` style);
  `InspectNode` snippet for a single layer equals the corresponding slice of the full
  export (consistency test).
- **MCP**: tests for each new tool following `internal/mcp/*_test.go`, including path
  restriction for `sync_push`.
- **Property tests**: random token trees survive pack -> sync -> pull unchanged.

## 8. Ordered task breakdown

1. **Token references in codegen.** Add a resolution mode to `core.ResolveNode` that
   keeps the binding; emit `var(--<path>)` in CSS/Tailwind (arbitrary-value or `@theme`
   names) and React; emit `tokens.css` into the exported project. Goldens. (Closes the
   open "CSS custom properties per mode" item; text/spacing/alias variables stay out.)
2. **`InspectNode` RPC + `inspect_node` MCP tool**: IR slice for one node id, for all
   three targets. Reuses step 1 so snippets show token names.
3. **Inspect panel** in the Develop right side (measure + CSS/Tailwind/React for the
   selection, copy buttons, token chips).
4. **Go tokens core** (`internal/handoff/tokens`): port DTCG/CSS/import from
   `tokens.ts`, canonical bytes, Tailwind `@theme` output, tests ported. Web variables
   dialog switches to the RPC; delete the TS duplicate when parity is proven.
5. **Token merge and sync state**: base snapshot, three-way compare, conflict report,
   `ApplyTokens` as ops in one gesture. `export_tokens`/`import_tokens` MCP tools.
6. **`opendesigner sync push|pull|check`** for tokens (CLI, exit codes, dry-run, diff).
7. **Component extraction** in `internal/codegen`: React component files with typed
   props from axes/properties, screens use them; manifest; README updated; goldens;
   `tsc` check.
8. **Component drift and `sync check`** for components: manifest hash, `.generated.tsx`,
   `code.mode=manual`, props-signature compare; `sync_status` MCP tool.
9. **Watch mode** (`sync watch`) with debounce and own-write suppression.
10. **Sync panel** in the web app (status, per-item resolve) and docs: new
    `docs/handoff.md` sections, tick the roadmap boxes only when each is true.

Each task ends green on `go test ./...` and `pnpm test` before the next starts;
tasks 1-3 are independent of 4-10 and can ship first.

## 9. Open questions

1. **Source of truth for tokens.** Is the repo file allowed to win (pull edits into the
   design), or is the document always authoritative with code only checked? This sets
   whether sections 4.1 `pull` and `watch` exist at all, and it is the largest scope
   lever. (Recommendation: allow pull, with conflicts never auto-resolved.)
2. **Where does the repo path live?** The server may run on another machine from the
   repo (LAN/relay), and the browser cannot write to disk safely. Options: CLI only
   (no web write), a path configured server-side at `serve` time, or a local
   companion process that does `sync watch`. Which deployment do we support first?
3. **Token identity on rename.** Path-as-identity makes a rename a delete + add and
   would break component bindings. Do we persist a stable id in `$extensions` so renames
   survive (small format addition, but the file then carries ids), or accept the
   limitation and map renames manually?
4. Component extraction granularity: is every component extracted, or only ones the
   user marks (`code.mode`), given that unmarked inline expansion is today's behavior and
   changes every existing export? Needs an opt-in or a version flag to avoid churn.
5. Tailwind output: `@theme` custom names versus arbitrary values `bg-[var(--x)]`.
   Which does the target audience expect, and do we support Tailwind v3 configs?
6. Should `review_design` (and a CI `sync check`) fail builds on drift, and who owns the
   exit-code contract?
7. How are variants with different structure (not just different values) represented
   in a single React component: one switch on the axes in the body, or one subcomponent per
   variant? Affects readability of generated code.
8. Inspect panel for layers inside an instance: show the master's node or the instance
   path with overrides applied?
