# Vector tools: booleans, outline stroke, masks, stroke style

## Boolean operations

With two or more shapes selected (rectangles, ellipses, frames, vectors and groups of them) the panel offers **Union, Subtract, Intersect, Exclude**. They make a **live boolean group**: the shapes become the children of a new group whose meta `boolean.op` makes it *draw* as the result. The group takes the bottom shape's fills, strokes and effects (and you restyle it like any shape); the shapes stay in the layers panel, and moving or resizing one changes the result at once. With the group selected the same buttons change its operation, and **Flatten** turns it into a plain vector (the shapes go). Releasing it with Ungroup gives the shapes back.

Nothing is stored for the result: it is derived, like variables (`store/booleans.ts`, inside `resolveScene`), so the canvas, the GPU renderer, the exports and the prototype all draw it, and code export computes it on the server (`internal/codegen/boolean.go`). Subtract removes every upper shape from the bottom one. Groups nest: an inner boolean group is one operand of the outer one. Curves are flattened to straight segments within 0.05 world units, and rounded corners and ellipses become polygons. The geometry is `polygon-clipping` (web) and `polyclip-go` (server); a node's region is the XOR of its closed subpaths (even-odd).

## Outline stroke

A single shape with a stroke offers **Outline stroke**: a new vector with the stroke's region (segments, joins, caps), filled with the stroke's paint. Inside and outside strokes are clipped by the shape as the canvas draws them. The node keeps its fill and loses the stroke; a node without fill is replaced. Dashes are not applied to the outline.

## Masks

`Node.is_mask` (the `is_mask` mask path). A mask is **not drawn**; its outline clips every sibling **above** it in the same parent. Only rectangles, ellipses, frames and closed vectors mask (the panel's **Use as mask** toggle, MCP `set_properties isMask`).

- Canvas 2D and CanvasKit clip with the outline; SVG export writes a `<clipPath>` and wraps the clipped siblings.
- Code export omits the mask node and wraps the siblings above it in a `clip-path` (an ellipse, or a path for rectangles, frames and closed vectors), so it works outside auto layout and for masks that are not rotated.
- Hit-testing follows the mask: a node above a mask is only picked inside it, and the mask itself is not picked.

## Stroke style

Cap (butt / round / square), join (miter / round / bevel), miter limit and dash pattern are kept in the node's `meta` (`stroke.cap`, `stroke.join`, `stroke.miter`, `stroke.dash`, `stroke.dashOffset`, the same keys the SVG import writes) and apply to every stroke of the node. The panel's Stroke section edits them; Canvas 2D, CanvasKit and SVG export draw them. Code export draws borders as rings and ignores dashes and caps.
