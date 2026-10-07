# Vector tools: booleans, path editing, mesh gradients, outline stroke, masks, stroke style

## Boolean operations

With two or more shapes selected (rectangles, ellipses, frames, vectors and groups of them) the panel offers **Union, Subtract, Intersect, Exclude**. They make a **live boolean group**: the shapes become the children of a new group whose meta `boolean.op` makes it *draw* as the result. The group takes the bottom shape's fills, strokes and effects (and you restyle it like any shape); the shapes stay in the layers panel, and moving or resizing one changes the result at once. With the group selected the same buttons change its operation, and **Flatten** turns it into a plain vector (the shapes go). Releasing it with Ungroup gives the shapes back.

Nothing is stored for the result: it is derived, like variables (`store/booleans.ts`, inside `resolveScene`), so the canvas, the GPU renderer, the exports and the prototype all draw it, and code export computes it on the server (`internal/codegen/boolean.go`). Subtract removes every upper shape from the bottom one. Groups nest: an inner boolean group is one operand of the outer one. Curves are flattened to straight segments within 0.05 world units, and rounded corners and ellipses become polygons. The geometry is `polygon-clipping` (web) and `polyclip-go` (server); a node's region is the XOR of its closed subpaths (even-odd).

## Editing a path

**Node tool** (`D`, in the dock): on the selected vector, drag an anchor or its handles; click the outline to add an anchor there (it keeps the curve's shape); double-click an anchor to flip it between corner and smooth; Delete removes the selected anchor; Alt-drag a handle breaks the smooth link with the opposite one; Esc abandons the drag. Each drag is one gesture. A smooth anchor (two opposite handles) turns its other handle as you drag one.

The panel's **path tools** act on the whole selected vector: **Smooth** (handles along the neighbours, Catmull-Rom style), **Corners** (no handles), **Simplify** (flatten, thin out with Ramer-Douglas-Peucker within 1 unit, smooth again if the path had curves) and **Grow / Shrink** by the distance in the field (**offset**, with round corners: the closed shapes grow or shrink, open paths are left alone, a shape shrunk away is refused). With two open vectors selected, **Join paths** connects the nearest ends (merging ends that touch) into the first node and deletes the second. Path edits are for upright nodes: a rotated vector turns about its box's center, which a new box would move, so rotate it back first. Offset and Pathfinder-style results are polygons (corner anchors), like any boolean result.

The geometry is pure functions in `vector/pathOps.ts`; the ops they produce are a `setVectorPath` plus the matching `setProps` box, in one gesture (`vector/editOps.ts`).

## Mesh gradients

A fill or stroke paint can be a **Mesh**: a grid of 2 to 8 rows and columns of colors (`MeshPaint` in the proto, validated on both sides: the grid size and one color per point), blended smoothly between the points over the node's box. The panel's Fill type → **Mesh** starts from the fill's color with a 3x3 grid, lets you change the grid size (the new points take the old blend's colors) and pick each point's color. Canvas 2D and the GPU renderer draw it from a small bitmap that the browser or the GPU stretches and smooths (`renderer/mesh.ts`); the SVG export embeds that bitmap as a PNG in a `<pattern>`. Limits, honestly: the points are on a regular grid and **do not move** (no Bezier patches, no free-form meshes), and code export has no CSS equivalent, so it gets the grid's **average color**.

## Outline stroke

A single shape with a stroke offers **Outline stroke**: a new vector with the stroke's region (segments, joins, caps), filled with the stroke's paint. Inside and outside strokes are clipped by the shape as the canvas draws them. The node keeps its fill and loses the stroke; a node without fill is replaced. Dashes are not applied to the outline.

## Masks

`Node.is_mask` (the `is_mask` mask path). A mask is **not drawn**; its outline clips every sibling **above** it in the same parent. Only rectangles, ellipses, frames and closed vectors mask (the panel's **Use as mask** toggle, MCP `set_properties isMask`).

- Canvas 2D and CanvasKit clip with the outline; SVG export writes a `<clipPath>` and wraps the clipped siblings.
- Code export omits the mask node and wraps the siblings above it in a `clip-path` (an ellipse, or a path for rectangles, frames and closed vectors), so it works outside auto layout and for masks that are not rotated.
- Hit-testing follows the mask: a node above a mask is only picked inside it, and the mask itself is not picked.

## Stroke style

Cap (butt / round / square), join (miter / round / bevel), miter limit and dash pattern are kept in the node's `meta` (`stroke.cap`, `stroke.join`, `stroke.miter`, `stroke.dash`, `stroke.dashOffset`, the same keys the SVG import writes) and apply to every stroke of the node. The panel's Stroke section edits them; Canvas 2D, CanvasKit and SVG export draw them. Code export draws borders as rings and ignores dashes and caps.
