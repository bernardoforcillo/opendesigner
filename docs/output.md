# Output: PDF, print, preflight, package, EPUB, data merge

Everything here lives in the **document menu**, except the single-page **Download PDF** in the properties panel. Nothing changes the document: export only reads it.

## The PDF writer

`web/src/pdf/write/*` writes the PDF itself (no print dialog, no server). It draws from the same nodes as the SVG export, in the same order, with the same text layout as the canvas, so the file shows what the editor shows. One document unit is one CSS pixel = 0.75 pt.

| Carried into the PDF | How |
|---|---|
| text | real text, laid out by the editor's own composer; character style colour, decoration, tracking, horizontal scale, baseline shift |
| fonts | **uploaded fonts are embedded whole** (CID font, Identity-H, widths and a ToUnicode map, so text is searchable); everything else becomes Helvetica / Times / Courier (WinAnsi), **not embedded**, and the preflight says so |
| images | JPEG as it is (CMYK JPEGs stay CMYK); PNG without alpha or interlacing as its own data; others (alpha PNG, WebP, GIF) decoded through a canvas into RGB plus a soft mask |
| shapes | rectangles with radius, ellipses, vectors (fill rule, caps, joins, miter, dashes), strokes |
| gradients | linear and radial as true shadings with stitched stops; mesh gradients as a small bitmap |
| transparency | node opacity, paint alpha and blend modes (ExtGState); masks as clip paths |
| colour | a swatch with CMYK → DeviceCMYK as typed; a spot swatch (or its tint) → a Separation named after the spot; a CMYK document → plain colours converted with the device conversion; else RGB |
| layers | a layer marked **do not print** is left out; hidden layers are not exported |

Not carried over (and reported by the preflight where it can be seen): blur and inner shadows (a drop shadow is drawn hard-edged, offset), transparency in gradient stops, OpenType features (ligatures, alternates), font subsetting (files are larger), text on a path's glyph shaping beyond per-segment rotation.

## Export PDF for print…

Options, with the preflight of the document beside them:

- **Standard** — none, PDF/X-4, PDF/X-3, PDF/X-1a. Writes the PDF/X identification (Info and XMP), an output intent naming the condition from *Swatches and colour mode* (e.g. FOGRA39), TrimBox, BleedBox and ArtBox on every page. X-1a forces CMYK paints and no transparency group.
- **Include bleed** — each sheet gets its page's bleed.
- **Crop marks and page information** — marks in registration colour at the trim corners, offset beyond the bleed, and a line with the file and page name.
- **Include slug** — the page's slug as extra paper around the sheet.
- **Facing pages as spreads** — a left and its right page as one wide page (needs facing pages; a section start begins a new spread).
- **Bookmarks and links** — see below.

**Honest scope of "PDF/X":** the file is *PDF/X-ready*, **not validated**. No ICC profile is embedded (the editor records the profile, it does not apply one), so a strict checker will say the output intent has no destination profile. Run the printer's own preflight (or Acrobat's) before sending.

## Interactive PDF

- **Bookmarks** from the headings (paragraphs in a paragraph style with an outline level), nested by level.
- **Links**: a URL stored in a node's `link.url` property, and prototype transitions whose element sits on one page and whose target is on another (a click goes to that page). No form fields.

## Preflight

A checklist of known problems, not a validator. Before the export it reads the document: fonts that cannot be embedded (an error under PDF/X), overset text, pages without a size or without a bleed when printing with bleed or marks, a missing output condition, layers that do not print, spot colours. After the file is written it adds what only the writer sees: images under 150 ppi, glyphs a font lacks, transparency under X-1a / X-3, RGB left under X-1a, effects it could not reproduce, images or fonts that could not be read. The latter are summarised in the notice.

## Package…

One zip: `<Name>/<Name>.pdf` (with the options chosen), `Fonts/` (the uploaded fonts as uploaded), `Links/` (the placed image files) and `Report.txt` (pages, standard, colour mode, colours used, fonts, links, preflight). It is the output and its ingredients, **not** an editable copy of the document.

## Export text as EPUB (reflowable)

The stories in reading order (page by page, top to bottom, left to right; a threaded story counts once) as real text: headings (`h1`–`h6` from the outline level), paragraphs with a class per paragraph style, character styles as spans, bullets and numbers as markers, footnotes as numbered notes, images, and a nested navigation from the headings. A level-1 heading starts a new chapter file. The paragraph and character styles become the CSS (size in `em`, margins, indents, alignment, hyphenation). Page geometry is **not** kept: use the fixed-layout export for that. Not carried over: tab leaders, drop caps, text on a path, wrap geometry, OpenType features; a table's cell text reads in place.

## Data merge (CSV)…

Write `{{Field}}` in the text of a page (or in a node's `link.url`), paste or open a table (CSV, semicolon or tab separated; field names in the first row), and **Create merged pages** adds one copy of the page per record after it, in one undo step. A placeholder with no column stays as written and is reported; line breaks in a value become spaces so paragraph styles stay aligned; character-style runs follow the replaced text. Images are not merged.

## What is not here

- **Book** (several documents with shared styles and continuous numbering): not built. It needs a server-side entity and cross-document style sync. A single document already has sections with their own numbering.
- HTML export of text, PDF/X validation, an embedded ICC profile, font subsetting, forms, blur in the PDF.

Code: `web/src/pdf/write/{pdfFile,pdfFonts,pdfColor,pdfImages,pdfPage,pdfDocument}.ts`, `web/src/export/{printPdf,preflight,packageForPrint,epubReflow}.ts`, `web/src/tools/dataMerge.ts`, `web/src/ui/{PrintPdfDialog,DataMergeDialog}.tsx`, `runDocumentExport` / `runPackage` in `web/src/export/exportScene.ts`.
