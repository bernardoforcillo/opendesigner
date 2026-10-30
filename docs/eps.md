# EPS export

Encapsulated PostScript Level 2 of a page or a selection, written by `web/src/export/eps.ts` from the same nodes
the SVG and PDF exports draw. Plain ASCII, no library.

Where it is exposed:

- Export panel: the "EPS" format button (`ui/ExportSection.tsx`, `runExport` in `export/exportScene.ts`).
- Editor job `export_eps` (`jobs/editorJobs.ts`), accepted by `RunJob` (`internal/server/jobs.go`).
- MCP tool `export_image` with `format: "eps"`.

Carried over: rectangles (rounded), ellipses, polygons, stars, vectors (fill rule, caps, joins, dash), text laid out
as on the canvas in a base-14 font, solid RGB fills and strokes, clip masks.

Not carried over (the editor shows a notice listing what applied): transparency (composited on white), gradients
(average colour), images and meshes (placeholder box), blur and shadow, embedded fonts, CMYK and spot paints.
Scale is ignored: EPS is vector.
