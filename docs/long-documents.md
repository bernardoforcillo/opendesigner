# Long documents

Markers live in the text of a frame and are resolved when the page is drawn or exported; the document keeps the markers.

| Marker | Meaning |
|---|---|
| `[^note]` | footnote (bottom of the frame/page) |
| `[*note]` | endnote: numbered in the text, collected by *Document > Endnotes* |
| `[#term]` / `[#Parent:Child]` | index entry; `:` makes a sub-entry (the parent is listed too) |
| `[=anchor]` | cross-reference destination (at a point in the text) |
| `[>anchor]` | reference to the page label of the destination; `[>anchor:text]` the destination paragraph's text; `??` if unknown |
| `[!comment]` | editorial note: never drawn, exported or printed; listed in *Long documents…* |
| `[?Name]…[/?]` | conditional text, shown or hidden by the document condition `Name` |

## Conditions
Declared in the document settings (`conditions`: name + visible). A hidden condition removes its text from canvas, PDF/EPUB, contents and index. Undefined conditions are visible.

## Table styles
A table style names an object style for the header, body and alternate rows and text styles for header and body. *Apply* paints the selected table (the style is remembered on the table group, so re-applying is idempotent). Cell "styles" are the existing object and text styles.

## Text checks
Not a dictionary spell check: no word list ships with the editor, so words are not verified (the browser's spell check still works while typing). `check_text` finds repeated words, double spaces, space before punctuation, straight quotes, `...` and spaced hyphens.

## MCP
`set_document_settings` (`conditions`, `table_styles`), `set_text` (markers), `generate_contents` (`toc`, `index`, `endnotes`), `apply_table_style`, `check_text`, `list_editorial_notes`. Editor commands need an open editor (see mcp-editor.md).

## Limits
Editorial notes are not flagged on the canvas. Conditions are inline markers, not character-style attributes. No multi-document book.
