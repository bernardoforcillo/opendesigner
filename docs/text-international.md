# International text

Paragraph direction, vertical writing and word breaking for scripts without spaces. Proto fields `TextStyle.direction` (31) and `TextStyle.writing_mode` (32); fields 31..39 are reserved for this range.

## Paragraph direction

- `auto` (the default): the first strong character decides, as before. A document that already holds Arabic or Hebrew text with the default alignment draws it where it was.
- `ltr` / `rtl`: the author's choice. In `rtl`, `left` and `right` alignment mean start and end, so the default puts the text at the right edge, the first-line indent is reserved at the right, and the canvas base direction, the SVG (`unicode-bidi: plaintext`) and the PDF shaping (bidi order) follow it.
- Panel: Text section, "Direction". MCP: `direction` (`auto | ltr | rtl`) in the text format tools.

## Vertical writing

`writing_mode = vertical-rl`: characters stand upright one under another in square cells, columns run from the right edge to the left, a line break starts a new column, and a column breaks when the box height is used up. Alignment is along the column (left = top, center = middle, right = bottom). Every glyph is laid out as its own placed line, so the canvas, SVG and PDF draw it with no vertical support of their own.

- Panel: "Writing mode". MCP: `writingMode` (`horizontal | vertical`).
- Limits: Latin letters stay upright (a real vertical typesetter turns them sideways), no vertical punctuation forms (CJK brackets and the long vowel mark are not rotated), no `tate-chu-yoko`, and vertical text is not laid out inside rich text runs or threaded frames.

## Thai, Lao, Khmer, Myanmar

These scripts have no spaces between words. Line breaking uses the platform word segmenter (`Intl.Segmenter`, dictionary based) and never cuts inside a cluster. Where the platform has no segmenter the word stays whole. Shaping itself (stacked vowels and tone marks, Indic conjuncts and reordering) is done by the font engine of the browser; the PDF writer embeds the font whole without OpenType shaping, so Indic conjuncts and Thai mark positioning are NOT guaranteed in the PDF.

## Not done

- Ruby (furigana): needs a per-run annotation field in the rich-text model; deferred.
- OpenType shaping in the PDF for Indic scripts (see above).
- Vertical punctuation, sideways Latin, `tate-chu-yoko`.
