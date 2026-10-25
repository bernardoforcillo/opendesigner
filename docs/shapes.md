# Shapes and paints: gradients, polygons and stars, arcs, corners, arrowheads, per-side strokes, shared styles

Everything here lives in the document (the proto, `internal/core`, the op log), is drawn by the 2D canvas and the GPU renderer, goes out through the SVG export and the generated code, and is reachable from the Properties panel and from the MCP tools. New proto fields use the numbers reserved for this area (`Paint` 20-29, `Node` shape cases 60-69, `Stroke` 20-29, `RectNode` 20-29, `Document` 60-69, `Op` 60-69; `Node` style ids 70-72).

## Angular and diamond gradients

Two more gradient kinds beside linear and radial (`Paint.angular`, `Paint.diamond`; both reuse `GradientPaint`, so they have the same stops, stop positions, variable-bound stops and the "add / move / remove stop" controls). The geometry is in the box's normalized coordinates, like the others:

- **Angular (conic)**: the center is `(x1,y1)`; the 0% stop points from the center toward `(x2,y2)` and the stops sweep **clockwise** once around (360 degrees). Only the *direction* of the second point matters. The panel's **Angle** field turns it (measured in world units, so it is the angle you see on a non-square box).
- **Diamond**: the center is `(x1,y1)`; the bands are axis-aligned diamonds of constant `|dx| + |dy|` (world units), and the 100% stop sits where that sum equals the distance between the two points.

| Surface | Angular | Diamond |
|---|---|---|
| Canvas 2D | native `createConicGradient` (flat color where a browser lacks it) | rasterized (`renderer/gradientBitmap.ts`, 128 px) and drawn as a pattern, like a mesh |
| GPU (CanvasKit) | `MakeSweepGradient` | the same bitmap as an image shader |
| SVG export | embedded PNG `<pattern>` of the same bitmap (SVG has no conic gradient) | the same |
| CSS code | `conic-gradient(from <deg> at x y, ...)` | `radial-gradient(circle ...)` approximation: a circle through the diamond's edge midpoints (CSS has no diamond) |
| SVG code (vector nodes) | flat first-stop color | the same circle approximation |

MCP: `set_properties` fills, `create_*` fills and the paint-style tools accept `{gradient:{kind:"angular"|"diamond", stops, x1,y1,x2,y2}}`. `.fig` import keeps `GRADIENT_ANGULAR` and `GRADIENT_DIAMOND` instead of turning them into radial ones.

## Polygons, stars, arcs and rings

Two node kinds and one extension of the ellipse:

```
PolygonNode { sides }                      3..60, a regular polygon inscribed in the box's ellipse, first vertex at the top
StarNode    { points, inner_ratio }        points 3..60, inner_ratio 0.05..0.95 (inner radius / outer radius)
EllipseNode { arc_start, arc_sweep, inner_ratio }
                                           degrees, 0 = 3 o'clock growing clockwise; sweep -360..360 (0 = full);
                                           inner_ratio 0..0.99 cuts a hole (a ring). Sweep < 360 with no hole is a pie slice.
```

The fields are written with `SetProperties` mask paths `sides`, `points`, `inner_ratio`, `arc_start`, `arc_sweep` (plus `corner_smoothing` and `radii` for rectangles, below). Like `corner_radius` they sit inside the `shape` oneof and are accepted only on the shape that owns them (Go answers `ErrNotPolygon` / `ErrNotStar` / `ErrNotEllipse` / `ErrNotRectNode` and rejects the whole op); `inner_ratio` is shared by ellipses (the ring's hole) and stars (the notch depth). Out-of-range values are rejected by both Go (`internal/core/shapes.go`, the authority) and TypeScript (`store/shapes.ts`); `testdata/golden/shapes_params.json` runs both sides, rejections included.

The outline is computed once, as path commands, by `renderer/shapeGeometry.ts` (the Go twin is `internal/codegen/shapes.go`), and every consumer uses it: the 2D canvas (`Path2D`), the GPU renderer (a Skia path), hit-testing (the true outline, widened by the stroke), the SVG export (`<path>`), the boolean operations and outline stroke (flattened rings), masks, `draw` animations (the outline's length) and the generated code. A plain full rectangle / ellipse is not computed: each renderer keeps its native fast path.

Editor: the shapes menu of the tool dock has **Polygon** and **Star** (drag a box, or click for a 100 px one); the panel shows **Sides**, **Points** / **Inner ratio**, or **Start** / **Sweep** / **Ring** for the selected shape. MCP: `create_polygon`, `create_star`, and `set_properties` with `sides`, `points`, `innerRatio`, `arcStart`, `arcSweep`; `list_nodes` / `get_document` report them in `shape`. `.fig` import keeps `STAR`, `REGULAR_POLYGON` and the `arcData` of ellipses.

## Rectangle corners: smoothing and independent radii

`RectNode.corner_smoothing` (0..1) and `RectNode.radii` (four radii: top left, top right, bottom right, bottom left; when present they replace `corner_radius`).

- **Smoothing** blends each circular corner into the straight edges with two cubic transitions around a shortened arc, so the curve starts `(1 + smoothing) x radius` before the corner (as far as the side allows) instead of `radius`. At 0 the corner is the plain circular arc; at 1 it is the fully "continuous" iOS-style curve. Where there is not enough room the smoothing gives way first, then the radius is kept.
- **Independent radii** are scaled down together when two neighbours do not fit along a side (the CSS rule).
- Mask paths `corner_smoothing` and `radii`; panel section **Corners** (Smoothing, and an "Independent corners" switch that shows the four radii); MCP `set_properties` with `cornerSmoothing`, `cornerRadii`, `uniformCorners`.
- Drawn as a computed path (see above); in generated code a rectangle with smoothing or independent corners becomes an inline `<svg>` path, a plain rounded rectangle stays a CSS `border-radius`.
- The branch merge (`internal/merge`) merges smoothing and radii apart from the single radius.

## Arrowheads and per-side stroke weights

`Stroke` gained (fields 20-22):

- `start_cap` / `end_cap` (`ArrowHead`: none, arrow, triangle, circle, square, diamond) for **open vector paths** (a pen line): the head goes on the first anchor of the first open subpath and the last anchor of the last open subpath, pointing out along the direction the path leaves (handles first). The head's tip sits **on the end point** and its body extends back along the path, so it never overhangs the node's box; its length is `max(8, 4 x weight)`. Triangle, circle, square and diamond are filled with the stroke's paint; the arrow is an open "V" stroked with it. Drawn by the 2D canvas, the GPU renderer, the SVG export (extra `<path>` elements) and the generated code.
- `sides` (`StrokeSides`: top, right, bottom, left) for **rectangles and frames**: a border that is thicker on one side. The stroke is drawn as the band between an outer and an inner rectangle (inside / center / outside as for the uniform stroke; inside and outside are clipped by the outline, so rounded corners still follow). `weight` is kept at the widest side by every writer, so everything that only checks `weight > 0` (and the bounds) still sees the stroke. SVG export writes the band as a filled path (square corners); CSS code writes one `box-shadow` band per side.

Panel: **Start** / **End** arrowhead pickers under the stroke for an open vector, and a "Per-side weights" switch with Top / Right / Bottom / Left for a rectangle or frame. MCP: `set_stroke` (the whole stroke list: color or gradient, weight, align, `startCap`, `endCap`, `sides`).

## Shared paint and effect styles

`Document.paint_styles` (`PaintStyleDef { id, name, paints }`) and `Document.effect_styles` (`EffectStyleDef { id, name, effects }`), upserted and deleted by four ops (`SetPaintStyleDef` 60, `DeletePaintStyleDef` 61, `SetEffectStyleDef` 62, `DeleteEffectStyleDef` 63) and referenced by `Node.fill_style_id`, `stroke_style_id` and `effect_style_id` (the same-named mask paths; empty detaches). It is the text styles' twin:

- A node that names a style draws with the style's values: a **fill style** replaces the fills; a **stroke style** replaces each stroke's paint (the one at the stroke's index, the last when the style has fewer) and keeps its weight, alignment and arrowheads; an **effect style** replaces the effects. The node's own values stay in the document as the fallback. The resolution is the variables pipeline (`resolveNode` / `resolveScene`; `core.ResolveNode` in Go), so the canvas, the GPU renderer, the prototype player, the exports and the generated code all see it. Editing a style changes every node that uses it.
- Invariants (Go authority in `internal/core/styles.go`, mirrored in `store/paintStyles.ts`, golden fixture `testdata/golden/paint_styles.json`): a style has an id and a name; a paint style has at least one valid paint; a node may only name an existing style; deleting a style clears the id on the nodes that used it (they keep their own paints).
- Panel: a picker under **Fill**, **Stroke** and an **Effect style** section, with **New style** (made from the node's fills / strokes / effects, then applied), **Detach** (the style's values are copied into the node, so nothing jumps) and **Delete style**. While a style is applied the fill's controls show the style's paints read-only; detach to edit.
- MCP: `list_paint_styles`, `set_paint_style`, `delete_paint_style`, `apply_paint_style` (`target` fill or stroke), and the same four for effects; `list_nodes` reports the style ids.
- The branch merge carries paint and effect styles like the other definitions; the hub copies them per op.

## Limits, on purpose

- Hit-testing of a rectangle with smoothed or independent corners uses the true outline, but the **marquee** works on boxes, as for every shape.
- An arc's angles are *parametric* (the angle of the point on the unit circle before it is stretched to the box), which is the geometric angle only on a circle.
- Arrowheads exist for open vector paths; there is no "line" node kind other than a two-anchor vector. Dashes are not applied to the heads.
- Per-side strokes in the SVG export have square corners, and CSS code treats CENTER as a half-weight band on each side of the edge.
- The diamond gradient is approximated in CSS and in SVG code (a circle); the canvas, the GPU renderer and the SVG export use the exact bitmap.
- The GPU paths (sweep gradient, diamond image, computed outlines, per-side bands, arrowheads) are written against the CanvasKit API and type-checked, but were not run on a GPU here: check them with `pnpm parity` on a machine that has one.
