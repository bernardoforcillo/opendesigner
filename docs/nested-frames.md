# Nested frames in output

Frames can sit inside frames. The model keeps a child's box in its PARENT's space; the canvas and the PNG export (which reuses the canvas renderer) already drew that correctly. SVG and PDF draw flat, so `exportRegion` (web/src/export/region.ts) now walks the tree and hands them:

- every node in WORLD space (position of its centre pushed through the containers' transforms, rotation accumulated), in tree draw order (a container, then its children, siblings by order key);
- `exportClips` (derived, never saved): the boxes of every frame with "clip content" around the node, outermost first, rotation included.

Output:
- SVG: one `<clipPath>` per distinct frame box, nested `<g clip-path>` per node (the clips intersect). Identical boxes share one definition.
- PDF: each box is intersected into the clip (`W n`) inside the node's `q`/`Q`.
- Bounds: a node clipped away entirely is left out and does not widen the export; a partly clipped one counts only for the visible part.
- Selection export: a selected node is lifted out of its frames (placed in the world, not cut by the frames around it).
- Print PDF page groups shift the clip boxes with their nodes.

Tests: web/src/export/nestedFrames.test.ts.

## Limits
- The clip is the frame's rectangle: corner radius of a clipping frame is not applied in SVG/PDF.
- Nodes under a masked group inside a frame keep their own mask on top of the frame clip (not separately tested).
- No PDF-stream test of the clip operators; verified by the SVG path and the shared geometry only.
- Frame fitting (fit a frame to its content, fit a child frame into its parent) has no new tool here; existing `fit_frame` is unchanged (docs/object-tools.md).
