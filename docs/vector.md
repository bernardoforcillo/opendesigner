# Vector tools: booleans, outline stroke, masks, stroke style

## Boolean operations

With two or more shapes selected (rectangles, ellipses, frames, vectors and groups of them) the panel offers **Union, Subtract, Intersect, Exclude**. The result is a plain **vector node** (a "flatten"): one gesture creates it right above the topmost source and deletes the sources, so one Ctrl+Z brings everything back. It takes the style of the bottom shape. Subtract removes every upper shape from the bottom one.

Curves are flattened to straight segments within 0.05 world units, and rounded corners and ellipses become polygons; there are no live (re-editable) boolean groups. The geometry is done in `web/src/vector/boolean.ts` with `polygon-clipping`; a node's region is the XOR of its closed subpaths, which is how the vector renderer fills (even-odd). Rotation and ancestors' transforms are applied, so the result sits where the sources were drawn.

## Outline stroke

A single shape with a stroke offers **Outline stroke**: a new vector with the stroke's region (segments, joins, caps), filled with the stroke's paint. Inside and outside strokes are clipped by the shape as the canvas draws them. The node keeps its fill and loses the stroke; a node without fill is replaced. Dashes are not applied to the outline.

## Masks

`Node.is_mask` (the `is_mask` mask path). A mask is **not drawn**; its outline clips every sibling **above** it in the same parent. Only rectangles, ellipses, frames and closed vectors mask (the panel's **Use as mask** toggle, MCP `set_properties isMask`).

- Canvas 2D and CanvasKit clip with the outline; SVG export writes a `<clipPath>` and wraps the clipped siblings.
- Code export omits the mask node but does **not** clip the siblings.
- Hit-testing ignores masks: clicking outside the mask still picks a clipped node.

## Stroke style

Cap (butt / round / square), join (miter / round / bevel), miter limit and dash pattern are kept in the node's `meta` (`stroke.cap`, `stroke.join`, `stroke.miter`, `stroke.dash`, `stroke.dashOffset`, the same keys the SVG import writes) and apply to every stroke of the node. The panel's Stroke section edits them; Canvas 2D, CanvasKit and SVG export draw them. Code export draws borders as rings and ignores dashes and caps.
