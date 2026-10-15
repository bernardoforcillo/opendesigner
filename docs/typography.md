# Typography

The document has **uploaded fonts** and **shared text styles**. Like variables,
flows and clips they live in the document and go through the op log: the editor,
MCP agents and code read and write the same ones, and every change is one undo step.
(Multi-line text, wrapping and alignment were already in the text node.)

## Model

```
Document.fonts       : map<id, FontFace>
Document.text_styles : map<id, TextStyleDef>

FontFace     { id, family, weight "100".."900", style "normal"|"italic", asset_hash }
TextStyleDef { id, name, style: TextStyle }
TextStyle    { font_family, font_size, font_weight, line_height, align, italic }
Node.text_style_id : the shared style a text node applies (text nodes only)
```

Four ops, **absolute upserts** (the inverse of an op is the previous state):

| Op | Number | Effect |
|---|---|---|
| `SetFont { font }` | 31 | registers a font face or replaces it |
| `DeleteFont { id }` | 32 | removes it (text naming its family falls back to the default font) |
| `SetTextStyleDef { text_style }` | 33 | creates a text style or replaces it |
| `DeleteTextStyleDef { id }` | 34 | deletes it and clears `text_style_id` on the nodes that used it |

`text_style_id` is written with `SetProperties` (mask path `text_style_id`); empty
detaches.

### Uploaded fonts

The file (TTF, OTF, WOFF or WOFF2) is a content-addressed asset, exactly like an
image: `POST /assets-api/{doc}` returns its sha256, the document only stores the
hash, and the bytes are served immutable from `/assets-api/{doc}/{hash}`. The
upload route recognises fonts from their magic bytes (a closed allowlist, served
with `nosniff`), never from the client's Content-Type.

A text whose `font_family` starts with a registered family draws with that file:

- the **2D canvas** (editor, prototype player, PNG export) through `document.fonts`
  (`renderer/fontRegistry.ts`);
- the **GPU renderer** loads the same files into its own font book
  (`FontBook.setDocumentFonts`), picking the face by family, then italic, then
  nearest weight; without a match it falls back to Inter;
- **generated code** gets an `@font-face` per font and the copied files
  (`assets/` for HTML, `public/assets/` for React), and `italic` text gets
  `font-style: italic`.

### Shared text styles

A text node that applies a style is drawn with the style's values; its own
`style` stays in the document as the fallback. The resolution is the same pipeline
as variables (`resolveNode` / `resolveScene`), so the canvas, the prototype player,
exports and generated code all see it, and a document without styles or variables
pays nothing. Editing a style changes every node that uses it.

In the editor, changing a value of a styled text (size, weight, family...) detaches
the style first and keeps what the node was drawn with, because a value that the
shared style overrides would otherwise change nothing visible.

## Invariants

Enforced by `core.Apply` (Go, the authority) and mirrored in
`web/src/store/typography.ts`; `testdata/golden/typography.json` runs both sides,
rejections included.

1. A font has a non-empty id, a plain family name (letters, digits, space, `_`, `.`,
   `-`; 1..64 characters: it ends up inside `ctx.font`, SVG and `@font-face`), a
   weight `100`..`900`, a style `normal` or `italic`, and a sha256 asset hash.
2. Two different fonts cannot claim the same (family, weight, style).
3. A text style has a non-empty id and a style with finite, non-negative size and
   line height and a font family made of plain characters (a CSS family list such as
   `Inter, sans-serif` is fine).
4. `text_style_id` only applies to a text node, and is empty or an existing style.
5. Deleting a style detaches it from the nodes (they keep their own style).

## Where it shows up

- **Editor**: document menu → *Fonts…* uploads files (family, weight and italic are
  guessed from the file name) and lists/removes them; the *Text* section of the
  properties panel has the font picker (built-in stacks plus uploaded families),
  italic, line height and the text style controls (apply, new, update, delete).
- **MCP**: `list_text_styles`, `set_text_style`, `delete_text_style`,
  `apply_text_style`, `list_fonts`, `set_font`, `delete_font`; `create_text` and
  `set_text` take `italic` and `lineHeight`; `get_document` includes `fonts`,
  `textStyles` and each node's `textStyleId`. Uploading the font file itself is an
  editor action (the MCP tools register an already-uploaded hash).

## Not yet

- Letter spacing, text decoration, case, paragraph spacing, per-range styling
  (one style per text node today), OpenType features and variable fonts' axes.
- Kerning and shaping in the GPU renderer (it measures glyph by glyph).
- A text style that overrides only some properties (a style replaces the node's
  whole style).
- Font subsetting and licence metadata in the export.
