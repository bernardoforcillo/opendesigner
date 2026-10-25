# Layout: auto layout, constraints and sizing

The document computes layout itself and stores the result: after every op the server
rewrites the positions (and, for hugging frames, the sizes) that the layout decides,
so a client that knows nothing about layout -- an MCP agent, an export tool -- reads
numbers that are already right. The Go code (`internal/core/layout.go`) is the
authority; `web/src/store/layout.ts` repeats it step by step so the browser's optimistic
view gives the same numbers, bit for bit, and the golden fixtures
`testdata/golden/auto_layout.json` and `testdata/golden/constraints_layout.json` run both.

## Auto layout

A frame with `auto_layout` arranges its visible children that have a measure of their
own -- rectangle, ellipse, text, image, vector, frame, **instance** (laid out with the
width/height of its own node) and **group** (see below) -- in a row or a column, or in the cells of a
grid.

```
AutoLayout { direction, spacing, padding_*, main_align, cross_align,
             hug_width, hug_height,
             wrap, cross_spacing }                    // wrapping
Node.layout_sizing_x / layout_sizing_y : FIXED | FILL  // per child, per axis of the child
```

### Fill

A child whose sizing on an axis is `FILL` takes the free space of that axis:

- on the layout's **main** axis the free space (inner size minus the fixed children and
  the gaps) is shared **equally** among the children that fill, and nothing is left for
  the alignment;
- on the **cross** axis the child spans the whole inner extent.

Fill is ignored on an axis the frame **hugs** (its length is the content's) and in a
**wrapping** frame. A child frame whose size the layout changes is laid out again (if it
has auto layout itself) or resizes its own children by their constraints, so the effect
propagates down.

### Wrap

With `wrap` the children flow onto lines as long as the inner main extent; a child that
does not fit goes to the next line (a line always has at least one child). Each line is
aligned on its own (main alignment within the line, cross alignment within the line's
extent) and the lines are `cross_spacing` apart. Hugging the cross axis fits the frame to
the lines; wrap is ignored when the main axis hugs. In the exported CSS it is
`flex-wrap: wrap` with `gap: <row> <column>` (the two spacings swap with the direction).

### Size limits

`Node.min_width`, `max_width`, `min_height` and `max_height` (0 = no limit) bound the size the
layout computes:

- a **fixed** child is clamped to its limits (the clamped size is what is stored, so the next
  sibling follows it);
- **fill** children share the free space the way flexbox does: a child whose even share
  falls outside its limits is frozen at the limit and the others share the rest, until nobody
  violates. When a max leaves space unused, the main alignment distributes it;
- a **hugging** auto layout frame stays within its own limits (the content may be smaller or
  larger); an auto layout frame's own limits also bound a size typed into it;
- wrapping frames cut their lines from the clamped sizes;
- when `min > max` the min wins. Written with the `min_width`, `max_width`, `min_height`,
  `max_height` mask paths (finite, >= 0; anything else rejects the op).

The limits are read by the layout, so they only act on children of (and on) an auto layout
frame; a node in a plain frame is not clamped. Removing a limit does not bring back the size
it had before it clamped, but undo does (the inverse also writes the previous size).

### Baseline alignment

`cross_align = BASELINE` in a **horizontal** layout lines the children's first baselines up
(in a vertical layout, and as a main alignment, it behaves as `START`). With no font metrics
in the document a text's baseline sits `font_size * (line_height - 1) / 2 + font_size * 0.8`
below its top (a line box of `line_height` x `font_size` with an ascent of 0.8 em; 16 and 1.2
when unset), and any other node's is its bottom edge, like a replaced element in CSS. The line's
baseline is the largest of them, the children hang from it, and a hugging cross axis takes the
extent they cover. A child that fills the cross axis stays at the start. When the layout wraps,
each line has its own baseline. Exported code uses `align-items: baseline`. It is an estimate:
the canvas draws text from the top of its box, so a font whose ascent is not 0.8 em is off by
a pixel or two against the real glyph baseline.

### Absolute children

`Node.layout_positioning = ABSOLUTE` takes a child out of its auto layout parent's flow: it
takes no room, is not hugged or aligned, ignores size limits and fill, and keeps its own x/y.
It stays **constrained to the frame**: when the frame changes size (typed, hugging, a limit)
the child follows by its `constraint_x`/`constraint_y`, like a child of a plain frame. Back to
`AUTO` it rejoins the flow (undo also restores its old x/y). The mask path is
`layout_positioning`; the exported code gives it `position: absolute` at its x/y.

## Groups as children

A visible group in an auto layout frame (row, column or grid) acts as **one box**: the union of its
visible children (nested groups included, rotation ignored), `Node.width`/`height` are rewritten to
it and the layout puts that box where the flow says, by **translating the group** (the group's x/y are
the translation it contributes to its children, so the children keep their own x/y). A child that grows,
moves, hides or leaves the group re-lays the frame out. A group never fills (its size is its content's)
and has no size limits; an **empty** group has no box and stays where it is. Moving or resizing the
children by hand works as before (the gesture touches the leaves); the next layout puts the group's box back
in its slot. Exported code gives the group a flow box of the union's size with its children hanging from a
zero-size anchor at the box's corner.

## Grid mode

`AutoLayout.mode = GRID` turns the frame into rows x columns of **tracks** instead of a row. The Go engine
(`internal/core/layout_grid.go`) is the authority; `web/src/store/layoutGrid.ts` repeats it, and the golden
fixtures `testdata/golden/layout_grid.json` and `layout_group.json` run both.

```
AutoLayout { mode, columns[], rows[], column_gap, row_gap,   // plus padding, hug_width/hug_height, main/cross_align
             ... }                                           // direction, spacing, wrap, cross_spacing are ignored
GridTrack  { kind: FIXED | HUG | FR, size }                  // px / - / weight
Node.grid_cell { column, column_span, row, row_span }        // 1-based; 0 = auto / one cell
```

- **Tracks**: FIXED has its size; HUG is as big as the biggest child in it (a child spanning several tracks
  widens the HUG ones among them by what is missing, smallest spans first); FR tracks share what is left
  after the fixed and hug tracks and the gaps by weight (a weight <= 0 counts as 1) and ignore their content.
  When the frame **hugs** an axis its FR tracks hug too, and the frame is the tracks plus gaps plus padding
  (within the frame's own limits). Columns or rows no definition covers are HUG.
- **Placement**: children with both a column and a row go to that cell (they may overlap). The others flow
  row by row into the first free cells in document order (a span wider than the grid is cut to it); a child with
  only a column or only a row takes the first free line along the other axis.
- **In the cell**: a child keeps its size, or fills the cell on an axis when its sizing says `fill` (min/max
  limits apply). `main_align` aligns it horizontally and `cross_align` vertically (center and end; anything else
  is the start), whatever `direction` was. The tracks do not stretch to a bigger frame without FR tracks.
- **Panel**: *Layout mode* (Flex / Grid) in the Auto layout section; switching starts from two FR columns and a
  hug row (gaps from the spacing, the tracks are remembered when you go back to Flex). Each column and row has a
  kind, a size or weight and a remove button; *Column gap* / *Row gap*; alignments are horizontal / vertical.
  A child of a grid shows a *Grid cell* section (column, row, spans).
- **MCP**: `create_frame` / `set_auto_layout` take `mode: "grid"`, `columns`, `rows` (`{kind, size}`),
  `columnGap`, `rowGap`; `set_grid_cell` places nodes; node views report `gridCell`.
- **Code**: `display:grid` with `grid-template-columns/rows` (`<n>px`, `max-content`, `<w>fr`), `gap`,
  `justify-items`/`align-items`, and `grid-column`/`grid-row` per child (`2 / span 2`). CSS auto-placement is the
  browser's (it matches ours for ordinary grids; with mixed explicit and auto cells it can differ). SwiftUI and
  Compose have no grid export: their children are not placed.
- A bad track kind, a negative or non-finite size or gap, more than 100 tracks, an unknown mode or a cell number
  outside 0..1000 rejects the whole op.

## Context menu

Right click on the canvas (Design mode, with write access) or on a layer opens one shared menu
(`ui/ContextMenu.tsx`, state in `ui/contextMenuStore.ts`, entries in `ui/contextMenuItems.ts`). The node under the
pointer becomes the selection unless it is already part of it; right click on empty canvas opens nothing. Entries,
each one gesture = one undo step:

- for a selection of **instances**: *Swap instance* (a submenu of the document's components), *Reset all changes*
  (disabled without overrides), *Detach instance*, *Go to main component* (one instance);
- for any selection: *Group selection*, *Ungroup*, *Bring to front / forward*, *Send backward / to back*
  (`tools/arrange.ts`: an `order_key` write on the nodes that move, per parent; disabled at the end of the line),
  *Duplicate*, *Delete*.

The menu closes on Escape, a click elsewhere, scroll, resize or after an entry runs; arrows move, Right opens a
submenu, Left closes it.

## Constraints

A frame **without** auto layout keeps its children where their x/y put them, and when it
is **resized** it moves and resizes them by their constraints, per axis:

| Constraint | Effect when the frame grows by `d` |
|---|---|
| `MIN` (default, left/top) | nothing |
| `MAX` (right/bottom) | position `+ d` |
| `STRETCH` (both margins) | size `+ d` (never below 0) |
| `CENTER` | position `+ d/2` |
| `SCALE` | position and size scaled by `new/old` |

Vectors, groups and instances only move (their size is not a free field). A child frame
that this resizes applies its own children's constraints in turn. Moving a frame, or
resizing a frame with auto layout, applies no constraints. Written with the mask paths
`constraint_x`, `constraint_y`, `layout_sizing_x` and `layout_sizing_y`; the enums are closed
(an out-of-range number rejects the whole op).

Undo is exact: the inverse of a resize also writes back, parents first, every
descendant the resize changed, because applying constraints backwards is not exact for the
clamped (`STRETCH` below zero) and the scaled (`SCALE`) cases.

## In the editor

- **Properties panel**: *Constraints* (horizontal/vertical selects) for a node inside a
  frame without auto layout; *Sizing* (fixed / fill container, per axis) for a node inside
  an auto layout frame; *Wrap* and *Line spacing* in the *Auto layout* section.
- **Properties panel, more**: in an auto layout frame, *Position* (auto / absolute; an
  absolute node shows its constraints instead of its sizing) and *Min/Max width/height*; an
  auto layout frame elsewhere shows *Size limits* too.
- **Drag**: reordering a child inside an auto layout frame already worked; dragging it
  more than a margin outside its frame, over no other auto layout frame, now **takes it
  out** into the frame's parent, centered on the pointer (the row closes up).
- **MCP**: `set_constraints`, `set_layout_sizing`, `set_layout_limits`,
  `set_layout_positioning` (node views report `minWidth`.., `layoutPositioning`); `create_frame` / `set_auto_layout` take
  `wrap` and `crossSpacing` (and `crossAlign` takes `baseline`); node views report `constraintX/Y` and `layoutSizingX/Y`.

## Not yet

- Per-child alignment overriding the frame's.
- Constraints relative to a group.
- Constraints for a rotated or scaled parent frame (the move is in its own axes).
- Exporting constraints to responsive CSS (they are an editing behavior; the export is the
  laid-out result).

## Layout grids

A frame can carry any number of **layout grids** (`Node.layout_grids`, the `layout_grids` mask path replaces the list; only frames take them): `columns` and `rows` (`count`, `gutter`, `margin`) and a square `grid` (`size`). They are editor guides, drawn under the selection and never exported.

Their lines are **snap targets**: a node dragged or resized near a column edge, a row edge or a grid line snaps to it and shows the guide. Frames that are rotated do not offer snap lines. The panel's **Layout grid** section (single selected frame) adds, edits and removes them; the core rejects a list with a bad kind, `count` outside 1..1000, `size` <= 0, a negative gutter or margin, or a non-frame node (golden fixture `testdata/golden/layout_grids.json`).

## PDF export

The export section offers **PDF**: the exported region as SVG is printed from a hidden frame whose `@page` is the region's size, so "Save as PDF" in the print dialog gives one vector page. Fonts and images are the browser's.
