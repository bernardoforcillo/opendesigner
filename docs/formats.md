# File formats (block 9)

Menu *Document*; every one is also an MCP tool (they run in the open editor, see mcp-editor.md).

| Format | Direction | MCP | What is carried |
|---|---|---|---|
| HTML | export | `export_html` | one file, every page as inline SVG: text stays selectable, images embedded, fonts **not** embedded |
| PowerPoint (.pptx) | export | `export_pptx` | one slide per page: rectangles (rounded), ellipses, vectors (bezier), text boxes (font, size, weight, italic, colour, alignment), PNG/JPEG images, solid and 2-stop linear gradients, strokes, opacity, rotation |
| InDesign IDML | export | `export_idml` | one spread per page: rectangles, ovals, polygons (bezier), text frames with their story (font, size, bold/italic, colour, alignment, paragraph styles by name), RGB swatches |
| InDesign IDML | import | `import_idml` | pages with their sizes (facing spreads split into pages), rectangles/ovals/polygons/lines (as vectors), text frames with story text, solid fills and strokes (CMYK converted naively), group and item transforms |
| Word (.docx), RTF | place | `place_document` | one text frame: paragraphs, Heading 1–3 (outline levels, so the contents list them), bold and italic as character styles, tabs and line breaks |
| Excel (.xlsx) | place | `place_document` | the first sheet as a table (header row = first row); cached values, not formulas |
| Tagged PDF | export option | `export_pdf` `tagged` | marked content and a structure tree: headings (outline-level styles), paragraphs (one per text frame), figures with alt text (`meta alt`, else the layer name), language from the book metadata; other drawing is marked as an artifact |
| Accessible EPUB | export (both modes) | `export_epub` | reflowable: `doc-chapter`/`doc-toc`/`doc-noteref`/`doc-footnote` roles, landmarks, headings from outline styles, `alt` on every image (`meta alt`, else the layer name; a bare file name counts as no description); fixed layout: each page's text repeated as real headings and paragraphs in reading order behind the picture (the SVG is `aria-hidden`); accessibility metadata (`schema:accessMode`, `accessModeSufficient`, `accessibilityFeature`, `accessibilitySummary`) claiming only what is true |
| Booklet | export option | `export_pdf` `booklet` | saddle-stitch imposition: two pages per sheet side (N-1\|1, 2\|N-2, …), padded with blanks to a multiple of 4 |

## How they were checked
- PPTX: read back with python-pptx (shapes, text, freeform, picture, slide size). **Not opened in PowerPoint.**
- IDML: round-trips through its own importer; an InDesign-style facing-pages spread with CMYK swatches and a group is imported with the right positions; all XML parts are well-formed. **Not opened in InDesign.**
- DOCX/XLSX: real files made by python-docx and openpyxl (deflated), stored as fixtures; RTF by a hand-written file.
- EPUB (both modes): validated with **epubcheck** (no errors or warnings). Conformance to EPUB Accessibility 1.1 is **not** claimed (the summary says so); hazards are `unknown`. The check also found that the fixed-layout package lacked `properties="svg"` on its pages, now fixed.
- Tagged PDF: the structure tree is read back with pdf.js. **Not validated as PDF/UA**, and the reading order is top-to-bottom, left-to-right per page (one element per text frame, not per paragraph).

## Limits
- INDD (InDesign's binary format) cannot be opened: it is proprietary and undocumented.
- IDML export/import: no images or links, effects, master-page items, character styles, tables, gradients, tracking or OpenType; rotation of imported boxes is dropped (they come in upright).
- PPTX: other image types, effects, masks, auto layout and master pages are not carried; one slide size for the deck (the first page's).
- Word: images, tables, footnotes, comments, fonts and colours inside the file are not carried; the frame is sized by an estimate and may overflow (thread more frames).
- Booklet: pages of different sizes are placed side by side as they are; there is no creep or gutter compensation.
- HTML: page by page as it looks; for reflowing text use the reflowable EPUB.
