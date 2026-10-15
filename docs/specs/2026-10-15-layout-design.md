# Layout: constraints, fill, wrap, drag-out, groups and instances as children

Date: 2026-10-15. Status: draft for review. No product code is part of this document.

## 1. Goal

Close the layout items of `docs/roadmap.md` section 1 so that a design built from nested
auto layout frames behaves like the same design in Figma when it is resized, filled, wrapped
or edited by dragging, with the server still the single authority and the browser, the
MCP agents and the exported code reading the same numbers.

**Scope correction (important).** The brief lists constraints and responsive resize, fill
children, wrapping, dragging a child out of a frame, and instances as children. The roadmap
already marks all of these `[x]` and `docs/layout.md` documents them (commits `ba9a8a6`,
`bad4d95`). What is genuinely open is the one unchecked line: *"Auto layout: groups as
children, min/max sizes, absolute children"*, plus the "Not yet" list in `docs/layout.md`
and a few gaps found in the code (section 2.2). This spec therefore covers:

1. Groups as auto layout children (the only brief item still missing).
2. Min/max sizes on a child (needed to make fill and wrap trustworthy).
3. Absolute-positioned children inside an auto layout frame.
4. Fill and wrap interaction: fill inside wrapped lines; weighted fill is deferred (see open questions).
5. Hardening of what exists: drag-out targets, constraints for instances, rotated parents.

If the user wanted the already-shipped items re-specified, say so; it would be a docs
exercise, not a design.

## 2. Current state

### 2.1 What exists

- **Authority:** `internal/core/layout.go` (`layoutFrame`, `layoutLine`, `layoutWrapped`,
  `resizeChildren`, `constrainAxis`, `layoutTargets`, `relayout`). `internal/core/apply.go`
  runs `layoutTargets` before and after each op, then `relayout` (apply.go ~L98-102), and
  calls `resizeChildren` when a frame's size changes (~L584). Layout results are stored
  as ordinary `x/y/width/height`.
- **Twin:** `web/src/store/layout.ts` repeats it step for step so the optimistic view is
  bit-identical. Both run the golden fixtures `testdata/golden/auto_layout.json` and
  `testdata/golden/constraints_layout.json`. Float rule: no fused multiply-add, products
  wrapped in `float64()` (header of `layout.go`).
- **Proto** (`proto/opendesigner/v1/opendesigner.proto`): `AutoLayout` (direction, spacing,
  paddings, `main_align`, `cross_align`, `hug_width/height`, `wrap`, `cross_spacing`),
  `LayoutSizing {FIXED, FILL}` (`Node.layout_sizing_x/y`, fields 46-47), `Constraint`
  (`constraint_x/y`, fields 44-45), `LayoutGrid` (field 50). Mask paths are validated in
  `apply.go` (~L396-423); the enums are closed.
- **Participation:** `participates()` accepts visible rect, ellipse, text, image, vector,
  frame and instance. **Groups and hidden nodes do not participate**; a group child of an
  auto layout frame keeps its stored x/y and takes no space
  (`TestLayoutIgnoresGroupsAndInstances` in `internal/core/layout_test.go`; the test name is
  stale, it only asserts the group half).
- **Fill:** `layoutLine` shares the free main-axis space equally among FILL children;
  cross-axis FILL spans the inner extent; FILL is ignored on a hugging axis and in a
  wrapping frame.
- **Wrap:** `layoutWrapped` greedy line breaking, per-line alignment, `cross_spacing`;
  ignored when the main axis hugs.
- **Constraints:** applied only by `resizeChildren` for a frame **without** auto layout
  that changed size; vectors, groups and instances only move (`hasFreeSize`). Undo of a
  resize also writes back every descendant the resize changed (exact inverse).
- **Drag:** `web/src/tools/layoutDrop.ts` (`reorderableParent`, `computeLayoutDrop`,
  `layoutDropOps`); `DETACH_MARGIN = 24` takes the node out into the frame's parent when
  the pointer is outside the origin frame and over no other auto layout frame
  (`LayoutDrop.out`). Wired from `web/src/tools/selectTool.ts` (~L246, L351). One undo step.
- **UI:** `web/src/ui/AutoLayoutControls.tsx`, `LayoutRelationControls.tsx`
  (constraints select, sizing select), `autoLayoutOps.ts`, `layoutRelationOps.ts`,
  `web/src/tools/wrapFrame.ts` (Shift+A). **MCP:** `internal/mcp/layout.go`
  (`create_frame`, `set_auto_layout`, `set_constraints`, `set_layout_sizing`; node views
  report `constraintX/Y`, `layoutSizingX/Y`). Codegen: `internal/codegen/build.go` emits
  flex including `flex-wrap`; constraints are not exported.

### 2.2 Gaps found while reading the code

1. **Group child is unreachable by the layout.** It overlaps its siblings, cannot be
   reordered by dragging (`reorderableParent` returns null if any id is a non-participant)
   and the user gets no explanation.
2. **No min/max.** FILL can produce a zero-width child (`share` clamps to 0); wrapped
   children cannot shrink; text wrapping with FILL has no lower bound.
3. **Fill is dropped under wrap**, so the common "card grid whose cards fill the row"
   is not expressible. Fill is also equal-share only (no weights).
4. **Instances are laid out but their size is not constraint-resizable** (`hasFreeSize`
   false), while FILL does set their `width/height`. Behavior is inconsistent: a stretched
   instance in a plain frame only moves, a filled one resizes. Whether instance contents
   follow a resize is to be verified (open question 4).
5. **Drag-out only targets the origin frame's parent** and `frameAt` only considers auto
   layout frames as drop targets: a child cannot be dragged straight into a plain
   (non-auto-layout) frame or an unrelated nested frame without a second gesture.
6. **No absolute children** (no way to pin a badge over a card in an auto layout frame).
7. **Constraints with a rotated or scaled parent** move in the frame's own axes.
8. Doc debt: stale test name; `docs/layout.md` "Not yet" must be updated at the end.

## 3. Data-model and op changes

All additive proto fields, defaults preserving today's behavior. The wire format of
existing documents is unchanged. Every new field needs a mask path validated in
`apply.go`, applied in both `apply.go` and `web/src/store/applyOp.ts`, mirrored in
`web/src/store/types.ts` (`NodeLite`) and in the pack/merge/.fig round-trips
(`internal/merge/merge.go`, `internal/figimport/fig.go`) where fields are enumerated.

| Change | Field | Notes |
|---|---|---|
| Absolute child | `Node.layout_positioning = 51` (`AUTO` default, `ABSOLUTE`) | Closed enum, mask path `layout_positioning`. ABSOLUTE children skip the flow but their constraints are applied against the auto layout frame when it resizes. |
| Min/max | `Node.min_width = 52`, `max_width = 53`, `min_height = 54`, `max_height = 55` (0 = unset) | Mask paths with the same names; reject negatives, NaN and `min > max` (new `ErrLayoutSizeLimit`). |
| Fill weight (deferred) | `Node.layout_grow = 56` | Only if approach B is chosen. |
| Group as child | none | Behavioral: a group participates with the size of its **content bounds** (helper shared by both sides); layout moves it by translating its x/y, never resizing it. |

Field numbers 51+ are to be confirmed against the current proto before regenerating.

Op changes: **no new op kinds**. All writes go through `SetProps` masks, as with
constraints and sizing today. `layoutTargets` already covers `SetProps`, `Reparent`,
`Create`, `Delete`; groups need an addition: a change to a **descendant** of a group that
sits in an auto layout frame must retarget that frame (the group's content bounds changed).
Both `layoutTargets` (Go) and its twin (`layout.ts` ~L308) get the same ancestor walk.

Group semantics (recommended): a group takes part with its content bounds; its children
keep their local coordinates and the group node's `x/y` is rewritten (translate only).
FILL/min/max on a group are ignored (a group has no free size). This keeps the "groups'
bounds are derived" invariant documented in `docs/layout.md`.

Constraints: `resizeChildren` is extended, not redesigned: (a) apply constraints to
ABSOLUTE children of an auto layout frame when it changes size; (b) respect min/max when
STRETCH/SCALE/FILL set a size (clamp after the constraint; exact undo still holds because
the inverse writes back every changed descendant); (c) rotated parent: make the local-axes
behavior explicit and tested rather than implicit.

Undo: nothing new while layout stays "stored result of ops"; the existing exact-inverse
write-back covers changed descendants, including the clamped cases.

## 4. Canvas, panel and MCP impact

**Canvas / tools**
- `participates` (TS) gains the group rule; `reorderableParent` and `computeLayoutDrop`
  then treat a group as a reorderable child using `contentWorldBounds`.
- `frameAt` optionally returns a non-auto-layout frame as a plain reparent target for
  drag-out (world position preserved through `worldTransformOf`); the insertion line is
  only drawn for auto layout targets. `DETACH_MARGIN` unchanged.
- Absolute children are drawn and dragged like free nodes (x/y written directly); the
  select tool must not reorder them. A marker in the layers panel is enough.
- Resize handles: clamp the live preview to min/max so it matches the server result.

**Properties panel** (`LayoutRelationControls.tsx`, `AutoLayoutControls.tsx`)
- Sizing section: min/max inputs per axis (empty = unset) and an "Absolute position"
  toggle next to fixed/fill.
- Sizing select stays enabled in wrapping frames (fill now works per line).
- Constraints select is shown for absolute children of an auto layout frame.

**MCP** (`internal/mcp/layout.go`, `tools.go`)
- Min/max: extend `set_layout_sizing` or add `set_size_limits` (open question 6).
- `set_layout_positioning` (auto | absolute), one tool per concept as with
  `set_constraints` / `set_layout_sizing`.
- Node views report `minWidth..` and `layoutPositioning`, omitted when default, like
  `constraintX`.
- `create_frame` / `set_auto_layout` descriptions updated: groups now take part.
- Codegen (`internal/codegen/build.go`): `position:absolute` for absolute children (frame
  `position:relative`), `min-/max-width|height` for limits, a group child as a flex item
  with its content bounds as size.

## 5. Approaches

### A. Extend the current "stored result" model in place (recommended)

Keep the server-computed layout and the Go/TS twin. Add the proto fields above, extend
`participates`, `layoutLine`, `layoutWrapped` and `resizeChildren`, and let fill work inside
wrap lines by treating each line independently (the line's free space shared equally among
its FILL children, after line breaking on the children's current main sizes).

- **Pros:** no architectural change (one set of numbers; MCP and export read stored values;
  exact undo already works). Smallest blast radius. Golden fixtures extend naturally.
  Matches all existing conventions.
- **Cons:** the Go/TS twin grows again and every addition must stay bit-identical; fill in
  wrap is "equal share per line", which differs from CSS `flex-grow` only once weights
  exist; min/max needs a freeze-and-redistribute loop implemented identically in two
  languages.

### B. A flex-style solver (grow / shrink / basis) as one shared routine

Replace `layoutLine`'s equal-share logic with a CSS-flexbox-like algorithm: each child has
`grow`, min/max, items freeze when clamped and free space is redistributed; wrap uses flex
line breaking with fill per line.

- **Pros:** exact match with exported CSS (flex-grow, min/max); weights, min/max and wrap
  fill handled uniformly; fewer special cases long term.
- **Cons:** larger rewrite of a heavily tested core; regression risk on existing documents
  (equal share must be proven a special case); one more field (`layout_grow`); an iterative
  algorithm is harder to keep bit-identical in two languages; nobody has asked for weights.

**Recommendation: A**, with min/max done as the standard freeze-and-redistribute loop
restricted to the FILL children of one line (B's algorithm only where required, no
`layout_grow` yet). Revisit B when weights are requested.

## 6. Testing plan

- **Golden fixtures (both runtimes):** new `testdata/golden/layout_groups.json`,
  `layout_minmax.json`, `layout_absolute.json`, `layout_wrap_fill.json`; extend
  `constraints_layout.json` for instance resize and clamped STRETCH/SCALE undo. Existing
  fixtures must pass unchanged (equal share stays the default).
- **Go unit** (`internal/core/layout_test.go`): group takes content bounds and translates;
  a group descendant edit relayouts the frame; min/max clamp and redistribution; fill under
  wrap per line; absolute child skipped by flow and followed by constraints; validation
  (negative limits, `min > max`, bad enum rejects the whole op); idempotence
  (`TestLayoutIsIdempotent` pattern) for each new mode; rename the stale
  `TestLayoutIgnoresGroupsAndInstances`.
- **TS twin:** `web/src/store/constraints.test.ts`, `web/src/tools/layoutDrop.test.ts`,
  `web/src/tools/selectTool.reorder.test.ts`, `web/src/ui/autoLayoutOps.test.ts` extended:
  group reorder, drag-out into a plain frame, undo as one step, hug + fill interaction.
- **Property/fuzz test (new):** random trees of auto layout frames, plain frames, groups and
  instances; random resizes and ops; assert Go and TS agree bit for bit and that undo
  restores the document exactly.
- **MCP** (`internal/mcp/constraints_test.go`, `session_test.go`): new tools and fields;
  views omit defaults.
- **Codegen** (`internal/codegen/codegen_test.go`): absolute, min/max, group child.
- **Perf:** run the 20,000-node bench (`docs/performance.md`) to confirm the group ancestor
  walk in `layoutTargets` does not regress.
- Manual pass in the editor for drag feel; `pnpm parity` unaffected.

## 7. Task breakdown (ordered)

1. Proto: add `layout_positioning` and min/max fields; regenerate Go and TS; mask paths and
   validation in `apply.go` and `applyOp.ts`; `NodeLite`, merge, pack and figimport
   plumbing. Tests: validation and round-trip.
2. Group content-bounds helper in Go and TS; extend `participates`; extend `layoutTargets`
   (both) with the descendant-of-group walk. Golden `layout_groups`.
3. Min/max clamp in `layoutLine` (freeze/redistribute) and in `resizeChildren` (clamp after
   constraint). Golden `layout_minmax`; undo test.
4. Fill inside wrapped lines. Golden `layout_wrap_fill`.
5. Absolute children: flow skip, constraints against the auto layout frame, hit-test and
   move. Golden `layout_absolute`.
6. Instances: implement the consistent resize rule once open question 4 is answered;
   update `hasFreeSize`.
7. Select tool: group as reorderable child, drag-out into plain frames and nested targets,
   preview clamp. Tool tests.
8. Panel: min/max inputs, absolute toggle, sizing enabled under wrap. MCP tools, views and
   descriptions.
9. Codegen: absolute, min/max, group wrapper. Check `review_design` for fill under hug.
10. Fuzz test; perf bench; docs: update `docs/layout.md` ("Not yet"), tick the roadmap
    line, `docs/handoff.md` if codegen output changes.

Tasks 1-5 are server-first and can ship without UI; 7-9 depend on 2-5.

## 8. Open questions for the user

1. **Scope:** the roadmap shows constraints, fill, wrap, drag-out and instance children as
   done. Limit this spec to the genuinely open items (groups, min/max, absolute children,
   hardening) as written, or is something about the shipped behavior wrong in practice
   (what did you see)?
2. **Groups in auto layout:** should a group take part with its content bounds (translated
   only, recommended), or should dropping a group into an auto layout frame offer to
   convert it to a frame?
3. **Fill:** is equal-share fill enough, or do you need proportional grow (`layout_grow`,
   approach B)? Should fill inside wrap share per line (recommended) or across the whole
   container?
4. **Instances:** should constraints be able to resize an instance (contents following when
   the component is itself a frame with layout), or stay "move only"? Resizing instances
   touches component overrides (`docs/components.md`).
5. **Drag-out:** allow dropping into any frame under the pointer (including plain frames),
   or only the parent as now?
6. **Min/max tooling and export:** one MCP tool (`set_layout_sizing`) or a new one? Should
   the export emit `min-/max-` CSS, or ignore limits as it ignores constraints?
7. **Constraints in export:** keep editing-only (today) or map them to responsive CSS in a
   later spec?
