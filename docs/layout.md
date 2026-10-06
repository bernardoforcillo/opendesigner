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
own -- rectangle, ellipse, text, image, vector, frame and **instance** (laid out with the
width/height of its own node) -- in a row or a column. Groups stay where they are: their
bounds are derived from their children.

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
- **Drag**: reordering a child inside an auto layout frame already worked; dragging it
  more than a margin outside its frame, over no other auto layout frame, now **takes it
  out** into the frame's parent, centered on the pointer (the row closes up).
- **MCP**: `set_constraints`, `set_layout_sizing`; `create_frame` / `set_auto_layout` take
  `wrap` and `crossSpacing`; node views report `constraintX/Y` and `layoutSizingX/Y`.

## Not yet

- Min/max sizes, absolute-positioned children inside an auto layout frame, per-child
  alignment overriding the frame's.
- Groups as auto layout children, and constraints relative to a group.
- Constraints for a rotated or scaled parent frame (the move is in its own axes).
- Exporting constraints to responsive CSS (they are an editing behavior; the export is the
  laid-out result).
