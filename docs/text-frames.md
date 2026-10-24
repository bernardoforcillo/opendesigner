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

## Not yet

Dragging from a frame's port to link, a story editor, rotation of threaded frames, a different style per frame, text wrap around objects and columns inside one frame (a frame of several columns is for now several linked frames). Generated code (`opendesigner export`) outputs each frame's own content, so a chain exports as its first frame holding the whole story.
