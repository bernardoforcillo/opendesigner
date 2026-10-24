# PDF import, PDF and EPUB export of the whole document

All three commands live in the **document menu** and work on the pages of the open document.

## Import PDF…

Every page of the PDF becomes a **page** of the document, sized in PDF points (1/72 in). The page is read with [pdf.js](https://mozilla.github.io/pdf.js/) (loaded only when the command runs), described as SVG (`web/src/pdf/pdfToSvg.ts`) and handed to the normal SVG importer, so what comes across is **native, editable nodes**:

| In the PDF | In the document |
|---|---|
| filled / stroked paths | rect nodes (axis-aligned rectangles) and vector nodes, with fill rule, colour, opacity, line width, caps, joins, miter limit and dashes |
| text | one text node per run: position, size, bold / italic, colour; the font is matched **by name** (not embedded), with a generic fallback |
| embedded images | image nodes (uploaded as assets) |
| the paper | a white `page-background` rect |

Not carried over, and said in the notice: clipping, gradients and patterns (the previous solid colour is kept), soft masks. Text colour is matched to its text run by order and falls back to black if the counts disagree; stacking between text and shapes follows the PDF. A page the SVG importer refuses (too many shapes) is imported as a picture, and the notice says how many.

**Import PDF as pictures…** keeps the old behaviour: each page is rasterised (long side up to 2000 px) into one image node, a faithful picture to annotate or trace over.

Both are one gesture (one undo removes every imported page); at most 200 pages per import. A password-protected or broken file is reported and leaves the document untouched.

## Export all pages as PDF…

Like the single-page PDF export, it hands the SVG to the browser's print dialog (**Save as PDF**), but for **every non-empty page** in one job: each page is a CSS named page with its own `@page` size, so the PDF has one page per document page, each the exact size of its content and vector. There is no PDF writer to keep in step with the canvas.

## Export all pages as EPUB

Downloads `<name>.epub` (EPUB 3, **fixed layout**): one XHTML spine item per non-empty page containing that page's SVG, a navigation document listing the page names, and the document id as identifier. Fixed layout keeps the geometry of the design instead of reflowing it as text. Images are embedded in the SVG, as in the SVG export. The container is a store-only zip written by `web/src/export/zip.ts`, no extra dependency.

Empty pages are skipped; if every page is empty nothing is exported and a notice says so.

Code: `web/src/pdf/importPdf.ts`, `web/src/pdf/pdfToSvg.ts`, `web/src/export/epub.ts`, `web/src/export/zip.ts`, `runDocumentExport` in `web/src/export/exportScene.ts`.
