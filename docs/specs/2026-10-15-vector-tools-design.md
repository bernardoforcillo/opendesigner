# Vector tools: booleans, outline stroke, masks, SVG import (design spec)

Date: 2026-10-15. Status: draft for review. No product code is part of this document.

## 0. Read this first: the roadmap boxes are already ticked

`docs/roadmap.md` lists all four items as done:

- section 1: "Live boolean groups (union, subtract, intersect, exclude; flatten on demand), outline stroke, masks ... see docs/vector.md" `[x]`
- section 1: "SVG import (paste, drop, import tool)" `[x]`
- section 1: ".fig import (experimental ...)" `[x]`

So this spec is NOT about building them. It is about the distance between "ticked" and
"Illustrator/Figma parity", measured against what the code does today. Every gap below was
found by reading the code. The `.fig` importer is touched only as a later phase (task 15),
as requested.

Terminology trap: "mask" has two unrelated meanings in this repo. A **design mask** is a node
with `is_mask` (this spec). A **field mask** is `google.protobuf.FieldMask` on `SetProperties`
(`web/src/store/maskPaths.ts`, `core.applySetProps`). Any new Node field needs a field-mask
path in both languages; a new design-mask feature that reuses `is_mask` does not.

## 1. Goal

Make the four vector features reliable enough that a designer, and an MCP agent, can use
them for real work without hitting a silent limit:

1. Booleans and outline stroke produce correct, editable results and are reachable from MCP,
   not only from the editor panel.
2. Masks cover the shapes people actually mask with (groups, boolean results) and survive
   import/export round trips.
3. SVG import keeps clip-paths and masks instead of dropping them with a warning, and the
   SVG round trip (import, edit, export, import) is stable.
4. TypeScript (editor) and Go (server code export) agree on geometry, enforced by tests.

Non-goals: new rendering backends, variable-width strokes and brushes (roadmap 1b), live
corners, gradient meshes, a full SVG filter pipeline, AI/EPS export.

## 2. Current state (with sources)

### 2.1 Booleans

- Live boolean group = a `group` node with `meta["boolean.op"]` in union / subtract /
  intersect / exclude. Nothing is stored; the result is derived in `resolveScene`:
  `web/src/store/booleans.ts` (`deriveBooleans`, memoized per `SceneState`, hides the
  children, turns the group into a `vector`).
- Geometry: `web/src/vector/regions.ts`. Every node becomes closed polygon rings: rounded
  rects use 12 steps per corner, ellipses 96 steps, curves flatten at
  `BEZIER_TOLERANCE = 0.05` world units. A node's region is the XOR of its rings (even-odd).
  The operation is `polygon-clipping` (`union/intersection/difference/xor`).
- Commands: `web/src/vector/boolean.ts` (`booleanOps` = flatten at once, `liveBooleanOps`,
  `setBooleanOpOps`, `flattenGroupOps`). Panel: `web/src/ui/BooleanControls.tsx`, mounted in
  `PropertiesPanel.tsx`.
- Sources: `rect, ellipse, vector, frame` and groups of them (`isBooleanSource`). Text,
  images and instances are excluded.
- Server twin: `internal/codegen/boolean.go` (256 lines) re-implements the region math with
  `github.com/ctessum/polyclip-go` v1.1.0 (`go.mod`), so code export draws live booleans.
- The result is always **polygons with corner anchors**; curves are lost on every flatten
  (docs/vector.md says so).

### 2.2 Outline stroke

- `web/src/vector/outlineStroke.ts`: union of one quad per segment, a join piece per vertex
  and a cap piece per open end, via `polygon-clipping`; inside/outside alignment is done by
  intersecting/subtracting the shape's region (the stroke is doubled first).
- Limits visible in the code: first stroke only (`strokes.find(weight > 0)`); dashes ignored;
  output is polygons (a round cap/join circle is 24 steps, `CIRCLE_STEPS`); only rect,
  ellipse, vector and frame can be outlined (`canOutlineStroke`); not live (one-shot,
  destructive); a gradient stroke becomes a single solid colour (`toPbFills([stroke.color])`).

### 2.3 Masks

- Proto: `Node.is_mask = 49` (`proto/opendesigner/v1/opendesigner.proto:503`); the field-mask
  path `is_mask` is in `internal/core/apply.go:394` and `web/src/store/maskPaths.ts`.
- Semantics: not drawn; clips every sibling above it in the same parent. Only
  rect/ellipse/frame/closed vector mask (`isMaskShape`, `canvasRenderer.ts:607`).
- Drawn by: Canvas 2D (`canvasRenderer.ts:537-603`, `clipByMask`), CanvasKit
  (`renderer/ck/ckRenderer.ts`), SVG export (`export/svg.ts:417-473`: `<clipPath>` plus a
  wrapper `<g clip-path>`), code export (`internal/codegen/build.go:227-257`: CSS
  `clip-path` wrapper, not inside auto layout, not for rotated masks), and hit-testing.
- It is a hard clip. There is no luminance or alpha mask, no soft edge, no group or
  boolean-group mask, and no explicit scoping other than sibling order.
- Doc drift: the comment at `build.go:147-148` says the clipped siblings are "not exported",
  but `build.go:227` and docs/vector.md say they are wrapped in a `clip-path`.
- MCP: only `set_properties { isMask }` (`internal/mcp/tools.go:330, 855`).

### 2.4 SVG import

- `web/src/svg/importSvg.ts` (1432 lines, pure: text in, create-node ops out), plus
  `pathData.ts`, `styles.ts`, `transform.ts`, `color.ts`, and the store-facing
  `web/src/tools/svgImport.ts` (paste, drop, menu; one undo step; uploads embedded images).
- Strong on: path data, transforms baked into anchors, CSS, gradients, `<use>`, text,
  data-URI images, hostile-input limits (`MAX_SVG_BYTES` 5 MB, `MAX_SVG_NODES` 5000),
  fixtures in `web/src/svg/__fixtures__/`, 1198 lines of tests.
- Dropped with a warning today: `clipPath` and `mask` definitions are in the `SKIPPED` set
  (line 741), and a `clip-path`/`mask`/`filter`/`mix-blend-mode` property only produces
  "not supported: ignored" (line 816). Also `pattern`, `marker`, `symbol`, `filter`.
- This is the biggest practical gap: icon sets, logos and exported illustrations use
  `clipPath` constantly, and they import visibly wrong (unclipped).
- Server/MCP: none. SVG import exists only in the browser.

### 2.5 .fig import (context only)

`internal/figimport/fig.go` reads `mask` into `IsMask` (line 455) and maps
`BOOLEAN_OPERATION` to a plain `vector` using Figma's stored result geometry, dropping the
operand children (lines 427, 462-467). Figma booleans therefore arrive flattened, never live.

### 2.6 MCP surface

`internal/mcp/tools.go` registers create_rectangle/ellipse/frame/text, set_properties,
delete/reparent, pages and components. A grep of `internal/mcp` finds no tool for boolean,
flatten, outline stroke, creating a vector, or importing SVG. `set_node_meta` could set
`boolean.op` by hand, but nothing creates the group or computes a result.

## 3. Library choices for path boolean operations

Constraints: it must run in the browser inside `resolveScene` on every edit (synchronous),
work in vitest/jsdom without wasm ceremony, and have a Go equivalent for code export (or the
result must be computable without one). The licence must fit `license.md`.

Licences below are from memory and **must be re-verified from each package's LICENSE file
before adoption** (task 0). `node_modules` and the Go module cache were not available when
this was written, so nothing here was checked against installed packages.

| Option | Where | Curves kept | Licence (verify) | Fit |
|---|---|---|---|---|
| `polygon-clipping` 0.15.x (current web) | TS, pure JS | no | MIT | Works, fast enough, robust on degenerate input. No curves, no offset. |
| `ctessum/polyclip-go` 1.1.0 (current server) | Go | no | BSD-style fork of akavel/polyclip-go (check) | Works. Less robust than newer libraries on coincident edges. TS and Go use different algorithms, so results can differ by an epsilon. |
| Clipper2 (Angus Johnson) | C++ original; JS and Go ports exist, third-party | no (polygons) | Boost Software License 1.0 | Very robust, and it also does **offset** (round/miter/square joins, open-path end types), which could replace the hand-written stroker and path offset. Port maturity and licence must be checked. |
| paper.js | JS | **yes**, boolean ops on Beziers | MIT | Preserves curves through flatten, which no polygon library does. Heavy (global project model, needs an offscreen setup), can be fragile on tangent curves. Viable only for explicit user actions, not per frame. No Go counterpart. |
| Skia path ops via `canvaskit-wasm` (already in `web/package.json`) | wasm | **yes** (`Path.op`, `Path.stroke` with cap/join/miter/dash, simplify) | BSD-3-Clause | Best fidelity, real stroking incl. dashes. But CanvasKit is an optional, lazily loaded GPU renderer today (`store/rendererChoice.ts`); depending on it for geometry forces a multi-MB wasm download on the default path and makes tests async. No Go counterpart. |
| `martinez-polygon-clipping`, Clipper1 wasm | JS | no | MIT / Boost | Superseded by the options above; not recommended. |

Takeaways:

1. For **live** results (derived on every edit, synchronous, mirrored in Go) polygons are the
   right representation. The real risk is TS/Go drift, solved by tests (section 7), not by
   swapping libraries.
2. For **destructive, explicit** actions (Flatten, Outline stroke, Offset) polygons are a
   visible quality loss (a flattened circle is a 96-gon). A curve-preserving engine is worth
   it only there, and only if it runs without wasm: paper.js is the spike candidate, Skia
   path ops the high-fidelity alternative if the GPU renderer ever becomes the default.
3. Clipper2 is the strongest candidate to replace the hand-written stroker and unify the
   engine on both sides, but only if a JS and a Go port both pass the licence and maturity
   check. Otherwise do not adopt it.

## 4. Data-model and op changes

Principle: the smallest change that closes the gaps; derive instead of store, as the repo
already does for variables and booleans.

Phases 1 to 3 need **no proto change**:

- SVG `clipPath` import maps to existing nodes: a wrapper `group` containing the mask shape
  (`is_mask = true`: a `vector`, or a live boolean group of several shapes) followed by the
  clipped content.
- MCP tools compose existing ops (`createNode`, `setProps` with `meta`, `reparent`).
- A boolean group as a mask: `isMaskShape` (TS and Go) accepts a group that has `boolean.op`;
  `regionOf` already handles groups. Pure logic, no schema.

A schema change is needed only for later, separately approved work:

- **Mask mode** (hard clip vs alpha vs luminance): `enum MaskMode { CLIP = 0; ALPHA = 1; LUMINANCE = 2 }`
  and `Node.mask_mode`, with a field-mask path `mask_mode` added in all three places that
  must agree: `core.applySetProps` (Go, the authority), `maskPaths.ts` and `applyOp.ts` (a
  cross-language guard test fails otherwise, see the header of `maskPaths.ts`). Add a
  `testdata/golden/*.json` fixture. Default 0 leaves every existing document unchanged.
- **Live outline stroke** is not recommended now; if wanted, `meta["outline.stroke"]` on a
  group mirrors `boolean.op` with no proto change.
- No new `Op` types. Each editor command stays ONE gesture (one undo step), as
  `liveBooleanOps` does.

Server geometry: introduce `internal/vector` (Go) holding the region math now private to
`internal/codegen/boolean.go`, so `codegen` and `mcp` share it. A pure refactor with the
existing tests as the safety net.

## 5. Impact by surface

| Surface | Booleans | Outline stroke | Masks | SVG import |
|---|---|---|---|---|
| Canvas 2D / CanvasKit | none (derived scene) | none | group/boolean masks: `clipByMask` takes a region path instead of a node; both renderers; add to `pnpm parity` | none |
| SVG export | none | none | multi-child `<clipPath>` for group masks; alpha/luminance later becomes `<mask>` | round-trip test only |
| Code export (Go) | geometry moves to `internal/vector`; goldens unchanged | none | extend `maskClip` to groups; auto-layout and rotation limits stay documented | none |
| Properties panel | exists; no change | dash option, keep paint | "Use as mask" for groups and booleans; mode select only if phase 11 lands | richer warnings list |
| Layers / hit-test | none | none | hit-test uses the same region function | none |
| MCP | `create_boolean_group`, `set_boolean_op`, `flatten_node` | `outline_stroke` | `set_properties isMask` exists; document the group case | `import_svg` (open question 1) |
| Docs | `docs/vector.md`, roadmap | same | same | same, plus a warnings table |

## 6. Approaches

### Approach A: harden in place (polygon engines kept)

Keep `polygon-clipping` (TS) and `polyclip-go` (Go). Close the gaps by:

1. SVG `clipPath` (and `mask` as an approximated hard clip, with a warning) import to
   `is_mask` nodes inside a wrapper group.
2. Extract the Go region math to `internal/vector`; add TS-vs-Go geometry tests.
3. MCP tools for boolean group, set op, flatten, outline stroke. Flatten and outline need
   Go geometry (port the stroker) or are deferred (open question 1).
4. Group and boolean-group masks; outline stroke honors dashes by splitting polylines before
   stroking (still polygons).
5. Make ellipse/corner/circle step counts adaptive to size so large flattened shapes stay
   round (current constants 12 / 96 / 24).

Pros: no new dependency or licence, small blast radius, existing tests stay valid, ships as
small independent PRs, live booleans stay synchronous and wasm-free.
Cons: flattened and outlined results remain polygons (facets when zoomed far in); two
different polygon engines remain a drift risk; the hand-written stroker stays.

### Approach B: curve-preserving geometry core

Replace the polygon path, at least for explicit actions, with a Bezier-aware engine
(paper.js or Skia path ops), plus Clipper2 for offset.

Pros: flatten and outline return real curves with tidy node counts; real dashes; one less
hand-written stroker.
Cons: a heavy dependency or a wasm load on the default path; no Go twin, so code export
still needs polygons or a stored cached result, which breaks the "nothing is stored"
invariant and invites stale-cache bugs and merge conflicts (`internal/merge`); fragile on
tangent and coincident curves; a larger test surface; much longer to land.

### Recommendation

**Approach A as the committed scope, plus a time-boxed paper.js spike (task 14)** to decide
whether curve-preserving Flatten and Outline are worth a hybrid later. The biggest
user-visible gaps are SVG clip-path import and MCP reachability, and A fixes both. The live
path must stay synchronous, pure and mirrored in Go, which polygons satisfy and curve
engines do not. B's real benefit, curves after a destructive action, can be added later
behind the same command functions without changing the data model, so deferring costs
nothing.

## 7. Testing plan

Follow the repo's tooling: `pnpm test` (vitest), `go test ./...`, `pnpm parity`,
`pnpm export-parity`, `pnpm svg-import`, fixtures and goldens under `testdata/`.

- **Geometry parity TS vs Go**: a shared JSON corpus (shapes, op, expected area and bounding
  box within a tolerance) read by `web/src/vector/boolean.test.ts` and a new
  `internal/vector/*_test.go`. Compare area and bbox, not vertex lists (engines differ).
  Cover coincident edges, tangent circles, zero area, holes, nested groups, rotated nodes,
  rounded rects.
- **Outline stroke**: area checks against analytic values within epsilon for butt / round /
  miter on closed and open polylines; inside, outside and centre alignment; dashes; miter
  limit falling back to bevel.
- **Masks**: renderer tests for group masks (`canvasRenderer.test.ts`); a mask case in the
  `pnpm parity` scene set (Canvas 2D vs CanvasKit); `export/svg.test.ts` for multi-child
  `<clipPath>`; codegen goldens in `internal/codegen/testdata/` (new `mask.html`); hit-test
  inside and outside the mask.
- **SVG import**: new fixtures `clip-icon.svg`, `clip-nested.svg`,
  `clip-objectBoundingBox.svg`, `mask-luminance.svg`, `clip-use.svg` in
  `web/src/svg/__fixtures__/`; assertions on tree shape (mask first, content after, wrapper
  group) and warnings (the "clip-path not supported" warning disappears for the supported
  subset and stays otherwise); hostile input (cyclic `clip-path` reference, deep nesting,
  `MAX_VISITS`). Round trip: import, export SVG, import again, compare visible bounding
  boxes and node counts.
- **MCP**: tests in `internal/mcp/*_test.go` modeled on `blend_test.go` and
  `diagram_test.go`: happy path, invalid arguments, and one batch per call.
- **Performance**: add live boolean groups and masks to the 20,000-node bench
  (`web/src/bench`, docs/performance.md); assert `deriveBooleans` is not recomputed when an
  unrelated node changes.
- **Regression**: `outlineStroke.test.ts`, `boolean.test.ts`, `booleans.test.ts`,
  `importSvg.test.ts`, `figimport/fig_test.go` pass unchanged unless a task says why.

## 8. Ordered task breakdown

Each task is one PR-sized unit with tests. Order is by value and dependency.

0. **Verify licences and versions** of every option in section 3 from the real LICENSE files
   and `license.md`; record the result here. Fix the stale comment at
   `internal/codegen/build.go:147`.
1. **SVG clip-path import, basic**: resolve `clipPath` definitions (same registry style as
   gradients), `userSpaceOnUse` first; `clip-path:url(#id)` on an element or group; wrap as
   in section 4; drop the warning for the supported subset; cycle and depth guards.
2. **SVG clip-path import, full**: `clipPathUnits="objectBoundingBox"`, `clip-rule`, several
   children (a live union boolean group as the mask), `<use>` inside a clipPath, transforms,
   `clip-path` on the clipPath itself.
3. **SVG `<mask>` import as an approximation**: convert to a hard clip from the mask's
   shapes and warn once "luminance mask approximated as a clip". Exact masks are task 11.
4. **Extract `internal/vector`** from `internal/codegen/boolean.go`; no behaviour change;
   existing codegen goldens stay byte-identical.
5. **Geometry parity corpus and tests** (TS and Go), section 7.
6. **Group and boolean-group masks**: `isMaskShape` (TS and Go) accepts a group, a live
   boolean group and a multi-subpath vector; `clipByMask` takes a path built from
   `regionOf`; both renderers, SVG export, code export, hit-test, panel toggle; add to
   `pnpm parity`.
7. **MCP boolean tools**: `create_boolean_group(nodeIds, op)`, `set_boolean_op(id, op)`;
   they only compose existing ops and need no server geometry.
8. **MCP geometry tools**: `flatten_node`, `outline_stroke` on `internal/vector` (needs a Go
   port of the stroker with the same unit tests, or deferral per open question 1).
9. **Outline stroke improvements**: dashes (split before stroking), keep gradient paint where
   representable, adaptive circle steps, outline of a group or boolean result.
10. **Adaptive flattening resolution** for ellipses and corners in `regions.ts` and its Go
    twin, with the parity corpus proving both stay equal.
11. **Mask mode** (alpha/luminance): proto field and the three-way path guard, renderers
    (Canvas 2D offscreen composite, CanvasKit `saveLayer` + blend), SVG `<mask>`, upgrade of
    task 3. Only after open question 3 is answered.
12. **MCP `import_svg`** (depends on open question 1).
13. **Docs**: update `docs/vector.md` (limits and new behaviour), `docs/roadmap.md` (split
    the ticked lines into done and new open items), `docs/handoff.md`.
14. **Spike (time-boxed, no merge required)**: paper.js and Skia path ops for
    curve-preserving Flatten/Outline on explicit actions; measure bundle size, test setup
    cost and robustness on the parity corpus; append a go/no-go note to this spec.
15. **Later phase, .fig booleans and masks**: import `BOOLEAN_OPERATION` as a live boolean
    group when operand geometry is readable (today only the result vector is kept,
    `fig.go:462-467`); check Figma's mask scoping against our sibling-above rule; test on
    generated files as the importer already does. Out of scope until the importer leaves
    "experimental".

## 9. Open questions

1. **Where does geometry run for MCP?** Outline stroke and SVG import exist only in the
   browser; booleans exist in Go only for code export. Agents with no editor open cannot flatten, outline or
   import. Options: port the stroker and the 1432-line importer to Go, bridge to a connected
   editor, or ship MCP tools that only compose existing ops. This decides tasks 8 and 12.
2. **Is polygon quality after Flatten / Outline a real complaint?** It decides whether the
   curve-preserving spike (task 14) is scheduled, or MCP reach plus SVG clip-path is the
   whole priority.
3. **Do we need luminance/alpha masks, or are hard clips enough?** It is the only item that
   changes the proto and the three-place field-mask guard. If hard clips cover the target
   documents, task 11 is dropped.
4. **Which licences are acceptable?** Confirm against `license.md`, and check the licence of
   `ctessum/polyclip-go` and any Clipper2 port before relying on them.
5. **Mask scoping.** Today a mask clips all siblings above it. SVG and Figma scope a mask to
   an explicit group. Should import always wrap in a group (this spec), or should the model
   gain an explicit "mask group"?
6. **Live outline stroke.** Should outline stroke ever be derived (weight edits update the
   outline), or stay a one-shot destructive command?
7. **Rotated and auto-layout masks in code export** are skipped today (documented). Is that
   acceptable for handoff?
