# Paragraph and character styles

Text can now have more than one look. A **paragraph style** sets the look of whole paragraphs (font, size, spacing, indents, alignment); a **character style** overrides a few fields over some characters inside a paragraph (a bold word, an underlined phrase). Both are named, shared styles: edit one and every text that uses it changes.

## In the editor

- **Document menu → Styles (paragraph, character)…** creates and edits the styles. A style has a name, font, size, weight, italic, underline, strikethrough and, for paragraph styles, line height, alignment, **space before / after**, **first-line indent** and **left indent**. **Based on** inherits every field the style leaves unset from another style of the same kind; **Next style** is the paragraph style a new paragraph gets after one in this style.
- **Editing a text** (double click): a small bar above the field has a *Paragraph style* picker (applies to the paragraphs the selection or caret touches) and a *Character style* picker (applies to the selected characters; it needs a selection). Formatting stays attached to its characters while you type: text typed at the end of a styled run joins it, a run you delete disappears, and Enter at the end of a paragraph starts the next paragraph in the style's *Next style*. Everything done in one editing session is one undo step.
- **Properties panel → Text** applies a paragraph style to every paragraph, or a character style to the whole text, of the selected nodes; **U** and **S** toggle underline and strikethrough on the text's own style. (The panel's *Text style* is different: it replaces the look of the whole node, as before.)

## Tracking and the baseline grid

- **Tracking** (letter spacing) is a field of every style, in px added after each character; negative tightens. It is set on the text itself (properties panel, *Tracking*), in a paragraph style, or in a character style over a range. Layout measures with it, so lines wrap where they will be drawn; drawing places the characters one by one (a string with tracking loses its kerning pairs), and the SVG export writes `letter-spacing`. As with other fields, `0` means "not set" and inherits.
- **Align to baseline grid** (paragraph styles): the document has a baseline grid (*Page setup…* → *Baseline grid*, or `set_document_settings`); a paragraph in a style with this option puts every line on a grid line, moving it down to the next one when its baseline falls between two. The grid counts from the top of the page, so it follows the text box when you move it. Only text with a paragraph style can align (the text's own style cannot).

## How styles combine

For a character: the node's own style (or its shared *Text style*), then the **paragraph style** of its paragraph on top, then the **character style** of its run on top. A field counts as *set* when it is non-empty / non-zero: font family `""`, size `0`, weight `""`, line height `0`, italic / underline / strikethrough off and alignment *left* are "not set" and inherit. So a paragraph style can centre or right-align but cannot force *left* over a centred text, and a character style cannot turn italic *off*. Spacing and indents of a child style override only when non-zero.

A paragraph is the text between newlines. A line is as tall as its tallest piece (pieces share one baseline). The first paragraph ignores *space before*; the last ignores *space after*. Indents shrink the wrapping width of the lines they apply to.

## Model

```
TextStyle      + underline, strikethrough
TextStyleDef   + kind (PARAGRAPH | CHARACTER), based_on, next_style_id,
                 space_before, space_after, indent_first, indent_left
TextNode       + paragraph_styles[]  (style id per paragraph; "" = none)
               + runs[]              ({ start, end, style_id } over the content, UTF-16 units)
SetText        + paragraph_styles, runs, rich_present
```

`SetText` with `rich_present` replaces the lists (after validation: runs sorted, non-overlapping, inside the content, naming character styles; paragraph styles naming paragraph styles, at most one per paragraph; a style that is based on itself or loops, or a character style with paragraph settings, is refused). Without it the lists follow the new content: runs are cut to its length, paragraph styles to its paragraph count. Deleting a style leaves its id in the text: it is ignored while the style is gone and comes back with it (so undo is exact). Go (`internal/core/richtext.go`, `typography.go`) is the authority; `web/src/store/richText.ts` and `typography.ts` are its twin.

## How it is drawn

The style ids are resolved into drawable values by the same derived pass as variables and shared styles (`resolveScene`, `text.rich`); the document is untouched. The layout (`layoutRich` in `web/src/renderer/text.ts`) is the same greedy wrap as plain text, measuring every piece with its own font; text without formatting still goes through the unchanged plain layout. The 2D canvas, the GPU renderer and the SVG / PNG / PDF / EPUB export all consume the same placed lines, which now carry the pieces (`segments`) with their style; underline and strikethrough are drawn as bars (`text-decoration` in SVG).

## MCP

`set_text_style` takes `letterSpacing`, `alignToGrid`, `kind` (`paragraph` | `character`), `basedOn`, `nextStyleId`, `spaceBefore`, `spaceAfter`, `indentFirst`, `indentLeft`, `underline`, `strikethrough`; `list_text_styles` returns them. `format_text { nodeId, paragraphStyles, runs }` sets a text node's formatting; `get_document` / `list_nodes` return `paragraphStyles` and `runs`. `set_text` keeps the formatting (adjusted to the new content).

## Not yet

- **Colour** in styles (a character style cannot change the fill), small caps, super/subscript, nested styles, bullets and numbering, tabs.
- The editing field shows plain text (the canvas shows the result once you leave it), and generated code (`opendesigner export`) exports the text's own style.
