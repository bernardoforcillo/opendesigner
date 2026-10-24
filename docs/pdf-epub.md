# PDF import, PDF and EPUB export of the whole document

All three commands live in the **document menu** and work on the pages of the open document.

## Import PDF…

Every page of the PDF becomes a **page** of the document, sized in PDF points (1/72 in). The page is read with [pdf.js](https://mozilla.github.io/pdf.js/) (loaded only when the command runs), described as SVG (`web/src/pdf/pdfToSvg.ts`) and handed to the normal SVG importer, so what comes across is **native, editable nodes**:

| In the PDF | In the document |
|---|---|
| filled / stroked paths | rect nodes (axis-aligned rectangles) and vector nodes, with fill rule, colour, opacity, line width, caps, joins, miter limit and dashes |
| text | text nodes with position, size, bold / italic, colour and font; lines of one paragraph become **one multi-line node** (see Typography below) |
| embedded images | image nodes (uploaded as assets) |
| the paper | a white `page-background` rect |

### Typography

- **Blocks.** Consecutive lines with the same font, size and colour, a steady line step and a shared left, right or centre edge are joined into one text node with a row per line. The line height comes from the step between rows and the alignment from the shared edge. Rows are the PDF's own line breaks (hard breaks), so the block does not reflow when resized.
- **Embedded fonts.** The fonts inside the PDF are extracted with pdf.js and added to the document as fonts (`SetFont`; family, weight and italic come from the PDF font name, e.g. `ABCDEF+DejaVuSans-Bold` -> DejaVu Sans, 700), so the text is drawn with its real typeface. They are **subsets**: they only contain the characters the PDF uses, so text typed with them later may show missing glyphs. A font is registered only if its Unicode character map covers every character the PDF draws with it; otherwise (symbolic or remapped subsets, Type 3 fonts, non-sfnt data) the text keeps the font's name and falls back to a system font, and the notice lists those fonts. A family already in the document with the same weight and style is left alone. Check the font's licence before reusing it: the file comes from whoever made the PDF.
- **Text styles.** Texts that look alike (family, size, weight, italic, line height, alignment) and appear at least twice share one **text style** (`SetTextStyleDef`, named like `DejaVu Sans 12 Bold`); editing the style restyles all of them. A text that is unique gets no style.
- Not carried over: letter spacing, horizontal scaling, text rendering modes, vertical text.

Not carried over, and said in the notice: clipping, gradients and patterns (the previous solid colour is kept), soft masks. Text colour is matched to its text run by order and falls back to black if the counts disagree; stacking between text and shapes follows the PDF. A page the SVG importer refuses (too many shapes) is imported as a picture, and the notice says how many.

**Import PDF as pictures…** keeps the old behaviour: each page is rasterised (long side up to 2000 px) into one image node, a faithful picture to annotate or trace over.

Both are one gesture (one undo removes every imported page); at most 200 pages per import. A password-protected or broken file is reported and leaves the document untouched.

## Export all pages as PDF…

Like the single-page PDF export, it hands the SVG to the browser's print dialog (**Save as PDF**), but for **every non-empty page** in one job: each page is a CSS named page with its own `@page` size, so the PDF has one page per document page, each the exact size of its content and vector. There is no PDF writer to keep in step with the canvas.

## Export all pages as EPUB

Downloads `<name>.epub` (EPUB 3, **fixed layout**): one XHTML spine item per non-empty page containing that page's SVG, a navigation document listing the page names, and the document id as identifier. Fixed layout keeps the geometry of the design instead of reflowing it as text. Images are embedded in the SVG, as in the SVG export. The container is a store-only zip written by `web/src/export/zip.ts`, no extra dependency.

Empty pages are skipped; if every page is empty nothing is exported and a notice says so.

Code: `web/src/pdf/importPdf.ts`, `web/src/pdf/pdfToSvg.ts`, `web/src/pdf/sfnt.ts`, `web/src/export/epub.ts`, `web/src/export/zip.ts`, `runDocumentExport` in `web/src/export/exportScene.ts`.
