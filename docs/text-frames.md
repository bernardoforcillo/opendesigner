# Threaded text frames

Text frames can be **chained**: the text of the first frame (the *story*) flows into the next one when the first is full, and on to the following ones, in any size and position, also on other pages. Resize or move a frame and the text reflows.

## In the editor

Select text frames; the **Text** section of the properties panel has the thread controls.

- **Thread frames** (two or more text frames selected): the text flows from the first selected frame into the next, in **selection order**. Text already in the later frames is appended to the first frame's story, so nothing is lost (one undo gives it all back).
- **Add next frame** (one frame selected): creates an empty frame of the same size beside it, linked, and selects it.
- **Unlink after this frame**: cuts the chain there; the text stays with the first part.
- The panel says which frame of the chain is selected (`Frame 2 of 3`) and `text left over` when the last frame cannot hold everything.

On the canvas, a frame that flows into another shows a filled square at its bottom-right corner and the next frame a hollow one at its top-left; selecting a frame of the chain draws a dashed line between them. A **red "+"** at the bottom-right of the last frame means **overset text**: make a frame bigger or add another.

Editing any frame of a chain (double click) edits the **story**, which lives in the first frame. All frames are laid out with the first frame's text style; each frame keeps its own width and height, and lines break to the width of the frame they land in.

A story with **paragraph and character styles** (docs/rich-text.md) keeps them as it flows: each frame is laid out with its own width and the paragraphs' spacing, indents and baseline-grid alignment, as many lines go in as the frame's height holds, and the rest of the text moves on to the next frame together with the formatting that belongs to it. A paragraph that breaks across frames keeps its style on the continuation (its first-line indent is applied again there).

## Model

Nothing is added to the document format. The link is a node meta key on every frame but the last:

```
meta["text.next"] = <id of the next frame>
```

A frame links to a text node other than itself that no other frame flows into, and a link never closes a cycle. A link to a deleted node, or to a node that is not text, is ignored. Only the first frame's `content` is the story; the later frames' own content is ignored while they are linked.

## How it is drawn

The flow is **derived** (`web/src/store/threads.ts`, last step of `resolveScene`): each frame is drawn with the slice of the story that fits in it (`floor(height / line height)` lines for plain text, the lines that fit its height for a formatted story, wrapped to its width with the same measure the canvas uses) and the last frame is flagged `overset` when text is left over. The canvas, GPU renderer, SVG/PNG/PDF/EPUB export and the prototype all see the sliced text. The slices are the frames' lines joined with newlines, so a soft wrap becomes a line break in the derived node only.

If a font loads after the layout was computed, the flow settles on the next change to the document.

## MCP

- `thread_text_frames { ids }` chains frames in reading order (same rules, text gathered in the first one);
- `unlink_text_frame { id }` cuts after a frame;
- the links show as `text.next` in the nodes' `meta`; `set_text` on the first frame changes the story.

## Around and along things

**Text wrap.** Select an object (not a text) and tick *Text flows around it* in the properties panel. The lines of the text frames that sit *below* the object (same parent, lower in the stacking order) are laid out beside it, on the wider side, and jump over it when neither side has room. *Gap* sets the space around it (default 6). Only the object's bounding box counts, rotation included; a rotated text frame is not wrapped, and threaded frames each wrap around their own objects. Stored as `meta["wrap.mode"] = "box"` and `meta["wrap.offset"]`.

**Text on a path.** Select a text and a vector together and choose *Run the text along the path*. The first paragraph is set along the vector's first outline, each character turned to follow it; alignment centres or right-aligns it on the path, and what does not fit is cut. The text node takes the box of the path while linked, and follows the vector when it moves or is reshaped. Stored as `meta["text.path"] = <vector id>`; *Release from the path* removes it. Underline is not drawn along a path.

**Tables.** *Insert table…* in the document menu makes a group of cells: a rectangle (box, fill, borders) and a text per cell. The group's meta holds the column widths, row heights and header rows. With a table or a cell selected the properties panel adds or removes rows and columns and sets a column's width or a row's height (one gesture, one undo); everything else — text, fills, borders, a whole row's look — is ordinary node editing. **Cell spanning.** Select several cells (click one, Shift-click the others) and *Merge cells* in the panel joins the block into its top-left cell: the cell grows over the area (`table.span` = "rows,cols" on its rectangle and its text), takes the texts of the others one per line, and the others go. *Split cell* gives the covered positions empty cells back. A block that would cut through a merged cell sticking out of it is refused. Adding a row or column inside a merged cell lengthens it, removing one shortens it, and removing the row or column it starts in drops the merge; resizing a row or column resizes the cells over it. There are no table or cell styles beyond the table styles of docs/rich-text.md.

## Footnotes, index marks and running heads

These are markers in the content of a text, turned into something else when drawn; the document keeps the markers (`web/src/store/textTokens.ts`).

- `[^note text]` is a **footnote**: drawn as a superscript number, with the note set at the foot of the page above the bottom margin, under a thin rule. Numbered through the document in reading order (page, then top to bottom, then left to right); a threaded story counts where its first frame is. The area is a derived, non-selectable text sized by an estimate of the wrapped lines.
- `[#term]` is an **index entry**: not drawn. *Index* in the document menu writes the terms alphabetically with their page numbers (the pages' own numbering) into a frame it creates or refreshes (`meta["contents.kind"] = "index"`).
- Give a paragraph style a **heading level** (Styles… → *Heading level*, 1–9) and its paragraphs are headings. *Table of contents* writes them down to level 3, one line each, in styles "Contents 1–3" (indented per level, with a right tab and a dotted leader); running it again refreshes the same frame. Generated text is plain text with those styles: restyle the styles and regenerate, or edit by hand until the next update.
- In the text of a **master page**, `<#>` is the page number, `<pages>` the page count, `<doc>` the document name and `<h1>` `<h2>` `<h3>` the running header: the first heading of that level on the page, else the last before it (a new level-1 heading clears the lower levels).

## Find and change

*Find and change…* searches the text of every page (master pages too) in reading order — plain text, match case, whole word, or a regular expression with `$1` in the replacement — lists the matches with their page, jumps to one (opens the page, selects the text), and changes one or all. Changes keep paragraph and character styles on their characters. The later frames of a thread are skipped (their text is the first frame's story). The editing field has the browser's spell checker switched on; there is no dictionary of our own.

## OpenType features

A style's *OpenType features* (`liga off, onum, ss01 2`: tags of four characters, each optionally followed by `on`, `off` or a number) are written as `font-feature-settings` in SVG output and applied in the editing field. **The canvas cannot apply them** — the 2D canvas and the GPU text path have no feature switch — so they do not show on screen until the PDF writer (a later block) embeds fonts.

## Not yet

Dragging from a frame's port to link, a story editor, rotation of threaded frames, a different style per frame and columns inside one frame (a frame of several columns is for now several linked frames). Wrap follows the bounding box (no contour or "both sides"); footnotes are numbered continuously and cannot restart per page or break across pages; the footnote area height is an estimate; tables have no spanning or styles; the index has one level (no sub-entries or cross references). The MCP tools set the wrap, text-path and heading-level fields (`set_node_meta`, `set_text_style`), but tables, the contents/index generators and find/change are editor commands. Generated code (`opendesigner export`) outputs each frame's own content, so a chain exports as its first frame holding the whole story.
