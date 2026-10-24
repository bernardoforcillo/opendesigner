# PDF import, PDF and EPUB export of the whole document

All three commands live in the **document menu** and work on the pages of the open document.

## Import PDF…

Every page of the PDF becomes a **page** of the document, holding one image node: the PDF page rasterised (long side up to 2000 px) and uploaded like a dropped image, with the node sized in PDF points (1/72 in) so the proportions are real. A one-page PDF gives a page named after the file; longer ones `<file> 1`, `<file> 2`, … The whole import is one gesture: a single undo removes every imported page. At most 200 pages are taken per import; the notice says how many were left out. A password-protected or broken file is reported and leaves the document untouched.

The PDF is read in the browser with [pdf.js](https://mozilla.github.io/pdf.js/) (loaded only when the command runs); the server sees nothing but the PNG assets.

## Export all pages as PDF…

Like the single-page PDF export, it hands the SVG to the browser's print dialog (**Save as PDF**), but for **every non-empty page** in one job: each page is a CSS named page with its own `@page` size, so the PDF has one page per document page, each the exact size of its content and vector. There is no PDF writer to keep in step with the canvas.

## Export all pages as EPUB

Downloads `<name>.epub` (EPUB 3, **fixed layout**): one XHTML spine item per non-empty page containing that page's SVG, a navigation document listing the page names, and the document id as identifier. Fixed layout keeps the geometry of the design instead of reflowing it as text. Images are embedded in the SVG, as in the SVG export. The container is a store-only zip written by `web/src/export/zip.ts`, no extra dependency.

Empty pages are skipped; if every page is empty nothing is exported and a notice says so.

Code: `web/src/pdf/importPdf.ts`, `web/src/export/epub.ts`, `web/src/export/zip.ts`, `runDocumentExport` in `web/src/export/exportScene.ts`.
