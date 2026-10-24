# Shapes and paints: angular and diamond gradients, polygons, stars, arcs, corners, arrowheads, per-side strokes, shared styles

## Angular and diamond gradients

Two more gradient kinds beside linear and radial (`Paint.angular`, `Paint.diamond`, proto fields 20-21; both reuse `GradientPaint`, so they have the same stops, stop positions, variable-bound stops and the "add / move / remove stop" controls). The geometry is in the box's normalized coordinates, like the others:

- **Angular (conic)**: the center is `(x1,y1)`; the 0% stop points from the center toward `(x2,y2)` and the stops sweep **clockwise** once around (360 degrees). Only the *direction* of the second point matters. The panel's **Angle** field turns it (measured in world units, so it is the angle you see on a non-square box).
- **Diamond**: the center is `(x1,y1)`; the bands are axis-aligned diamonds of constant `|dx| + |dy|` (world units), and the 100% stop sits where that sum equals the distance between the two points.

Where they are drawn:

| Surface | Angular | Diamond |
|---|---|---|
| Canvas 2D | native `createConicGradient` (flat color where a browser lacks it) | rasterized (`renderer/gradientBitmap.ts`, 128 px) and drawn as a pattern, like a mesh |
| GPU (CanvasKit) | `MakeSweepGradient` | the same bitmap as an image shader |
| SVG export | embedded PNG `<pattern>` of the same bitmap (SVG has no conic gradient) | the same |
| CSS code | `conic-gradient(from <deg> at x y, ...)` | `radial-gradient(circle ...)` approximation: a circle through the diamond's edge midpoints (CSS has no diamond) |
| SVG code (vector nodes) | flat first-stop color | the same circle approximation |

MCP: `set_properties` / `create_*` fills accept `{gradient:{kind:"angular"|"diamond", stops, x1,y1,x2,y2}}`. `.fig` import now keeps `GRADIENT_ANGULAR` and `GRADIENT_DIAMOND` instead of turning them into radial ones.
