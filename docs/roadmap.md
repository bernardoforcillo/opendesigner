# Roadmap

Goal: a local-first design editor, with native AI co-design (MCP), that
can replace Figma for small teams and for those who want design and code together.

Legend: [x] done · [ ] to do

## 1. Basic parity
- [x] Shapes, text, images, vector, groups, frames, pages
- [x] Components with instances and overrides
- [x] Linear and radial gradients (canvas, SVG, panel, MCP)
- [x] More stops per gradient (add, move, remove from the panel)
- [x] Gradient on strokes from the panel; image as a fill or stroke paint (fill / fit / tile; canvas, GPU, SVG, code)
- [x] Effects: drop shadow and layer blur (canvas, SVG, panel, MCP, copy/paste; one per type per node is drawn)
- [x] Effects: multiple shadows per node, inner shadow, background blur, blend mode (docs/effects.md)
- [x] Auto layout: direction, spacing, padding, alignments, hug; computed by the server (Shift+A wraps the selection, Frame tool, panel, MCP `create_frame`/`set_auto_layout`)
- [x] Auto layout: reordering by dragging children (also into another auto layout), with insertion line and outline; a single undo step
- [x] Auto layout: children that fill the space (fill), wrapping onto several lines, dragging a child OUT of the frame, instances as children; see docs/layout.md
- [ ] Auto layout: groups as children, min/max sizes, absolute children
- [x] Constraints and responsive resize (min/max/stretch/center/scale per axis, recursive, exact undo); see docs/layout.md
- [x] Variants and component properties: component sets with axes, instances that choose a variant, boolean (show/hide) and text properties, editor dialog and instance controls, MCP tools, exported code; see docs/components.md
- [ ] Shared libraries across documents, instance swap, detach instance
- [x] Variables / design tokens with modes: color and number variables in collections with modes, bound to fills, strokes, opacity, rotation, radius and stroke width, pinned per subtree; editor dialog and panel, MCP tools, resolved in canvas/export/code, see docs/variables.md
- [ ] Variables: text and spacing, aliases, CSS custom properties per mode in the exported code
- [x] Typography: uploaded fonts (TTF/OTF/WOFF/WOFF2 as content-addressed assets, drawn by the 2D and GPU renderers and exported as @font-face), shared text styles, italic; multi-line text and wrapping were already there; see docs/typography.md
- [ ] Typography: letter spacing, decoration, case, per-range styling, kerning/shaping on the GPU
- [x] Live boolean groups (union, subtract, intersect, exclude; flatten on demand), outline stroke, masks (canvas, GPU, SVG, code, hit-test); see docs/vector.md
- [x] Presentation mode: the playable prototype (Present)
- [x] Diagrams: flowchart and UML (class, sequence, state) from Mermaid text, computed by the server; editor (document menu) and MCP (`create_diagram`, `update_diagram`, `list_diagrams`), see docs/diagrams.md
- [x] Connectors that follow the shapes (Link tool and panel; derived path, see docs/whiteboard.md)
- [ ] Diagrams: `subgraph`, ER, notes in class and state diagrams
- [x] SVG import (paste, drop, import tool)
- [x] .fig import (experimental: read from the documented layout, tested on generated files; components and instances are not kept; docs/handoff.md)
- [x] Prototyping: animated transitions between frames (dissolve, slide, push, smart animate) with duration and easing, and `auto` transitions after a delay; see docs/flows.md
- [ ] Prototyping: hover and drag interactions, overlays, scroll, component state changes in the player
- [x] Multiple artboards (frames), smart guides and snapping to nodes, layout grids on frames (columns, rows, square grid) that guide and snap; see docs/layout.md
- [x] Snap to a pixel grid (document menu: 1 / 4 / 8 px, per person) and spacing guides (equal gaps between neighbours, drawn while dragging)

## 1b. Vector (Illustrator parity)
- [x] Node tool: anchors, handles, add/delete points, corner/smooth, join, smooth/corner all (docs/vector.md)
- [x] Path offset (grow/shrink) and simplification; pathfinder = the live boolean groups
- [ ] Live corners
- [x] Strokes: cap, join, miter limit and dashes on every shape (panel, canvas, GPU, SVG)
- [ ] Advanced strokes: variable width profiles, brushes, arrowheads
- [x] Gradient mesh (a color grid blended over the box; the points do not move; code export uses the average color)
- [x] SVG export and PDF (a real PDF writer, docs/output.md)
- [x] PDF import (editable text with embedded fonts and shared text styles, shapes and images, one page per PDF page), and export of all pages as PDF or EPUB (fixed layout); see docs/pdf-epub.md
- [ ] AI/EPS export
- [ ] Color: ICC profiles and color-managed print (CMYK read-out/entry exists, plain conversion only)

## 1c. Whiteboard (Miro parity)
- [x] Sticky notes (six colors) and arrows (flow and user-flow templates) as plain nodes; see docs/whiteboard.md
- [x] A Board mode (infinite board without frames: sticky, text, link, vote), arrows that follow the shapes
- [x] Tables, kanban boards and mind maps, drawn as groups of plain nodes (editor dialog, `RenderBoard` RPC, `create_board_object` MCP tool)
- [x] Templates: brainstorm, retrospective, user flow, customer journey
- [x] Cursor chat, reactions, timer, dot voting, follow mode (ephemeral, through presence)
- [ ] Mermaid import/export in both directions

## 1d. Publishing (InDesign parity)

Verticals (docs/publishing.md): a document is for publishing, design or design × development, and the editor, the Home and the templates follow.
- [x] Verticals per document (publishing, design, design × development): modes, menu, Home and templates; document type switch
- [x] Publishing templates (book, magazine, report) and design templates (poster, brand sheet); Pages panel with thumbnails


Multi-page documents, long text and print output. Already there: pages, layout grids (columns, rows), uploaded fonts and shared text styles, PDF import with editable text, PDF/EPUB export (docs/pdf-epub.md, docs/output.md).

Pages and structure
- [x] Page sizes and presets (A3-A6, Letter, Legal, Tabloid, book, square, custom)
- [x] Facing pages and spreads (inside/outside margins, left/right pages), numbering sections with styles 1, i, I, a, A; see docs/publishing.md
- [x] Master pages: template pages drawn behind the pages that apply them, `<#>` page-number token, editor, MCP (`update_page`), export; see docs/master-pages.md
- [x] Master pages: overrides per page, left/right masters, a master based on another (chains), ruler guides from the master
- [x] Pages panel with thumbnails (open, add page / master, setup)
- [x] Pages panel: reorder, duplicate, spreads, sections with their own numbering
- [x] Page size, margins, columns, gutter and bleed per page (Page setup…), drawn on the sheet, snapped to, and exported as the sheet; PDF for print with bleed
- [x] Slug areas, ruler guides per page, different margins for left and right pages
- [x] Slug and spreads in the PDF export (the EPUB has no print areas; fixed-layout spreads are not written)
- [x] Layers shared across pages (hide, lock, keep out of print); see docs/graphics-colour.md

Text
- [ ] Text frames with columns, inset and vertical alignment
- [x] Threaded frames (text flows from one frame to the next, across pages), overset indicator; thread/unlink/add next frame, MCP (`thread_text_frames`); see docs/text-frames.md
- [ ] Threading by dragging from a frame's port, a story editor, columns in a single frame
- [x] Paragraph styles and character styles (based-on, next style, space before/after, indents), underline and strikethrough, editor pickers, MCP (`format_text`); see docs/rich-text.md
- [x] Nested styles, colour in styles, bullets and numbering, tabs (with leaders); see docs/rich-text.md
- [x] Baseline grid (document setting, drawn on the page, snap target) and paragraphs that align to it; see docs/rich-text.md
- [x] Letter spacing (tracking) and underline / strikethrough
- [x] Kerning on/off, horizontal scale, small caps, super/subscript
- [x] Hyphenation and justification, drop caps
- [x] Widows/orphans, keep-with-next, keep lines together (between threaded frames); see docs/rich-text.md
- [x] Paragraph rules above/below, shading and border, optical margin alignment, variable-font axes (SVG and editing field only)
- [x] Bullets and numbered lists, tabs, indents
- [x] Text wrap around objects (bounding box, gap); see docs/text-frames.md
- [x] Anchored (inline) objects, tied to a place in the text; see docs/graphics-colour.md
- [x] Footnotes, tables (rows, columns, header), table of contents, index; see docs/text-frames.md
- [ ] Table and cell styles, cell spanning, index sub-entries
- [x] Find/change (text, word, regex), browser spell check, text variables (running headers, page count, document name)
- [x] Text on a path
- [x] OpenType feature settings per style (SVG output and editing field; not drawn on the canvas)

Graphics and colour
- [x] Linked images: file name and pixel size, effective resolution with a low-resolution warning, fitting from pixel size, relink, Links panel
- [ ] Update-on-change from disk, image frames with fitting inside them
- [x] Swatches (process CMYK, RGB, spot, tints that follow their base), CMYK document mode and a recorded output profile
- [ ] Gradient swatches, overprint, profile-managed conversion
- [x] Object styles (fill, stroke, effects, opacity, corner radius, blend mode; based-on)
- [ ] Nested frames, frame fitting
- [ ] Transparency flattening for print, blur and inner shadows in PDF output (opacity, blend modes and hard-edged drop shadows are written; blur is reported by the preflight)

Output (docs/output.md)
- [x] PDF writer: fonts embedded (uploaded fonts, whole, no subsetting), original JPEG/PNG bytes, gradients as true shadings, opacity and blend modes, masks, CMYK and spot paints (Separation), page boxes, layers that do not print left out
- [x] Print options: bleed, crop marks and page information, slug, spreads, PDF/X-1a / X-3 / X-4 identification with an output intent ("ready", not validated: no ICC profile is embedded)
- [x] Preflight (missing fonts, overset text, no bleed, low-resolution images, missing glyphs, transparency under X-1a/X-3, RGB under X-1a, effects the PDF cannot reproduce)
- [x] Package for print: PDF, fonts, placed images and a text report in one zip
- [x] EPUB: reflowable export from the stories (headings, paragraph and character styles as CSS, footnotes as notes, images, nested navigation); the fixed-layout export stays
- [x] Interactive PDF: bookmarks from headings, link annotations (URL in a node's `link.url`, prototype transitions between pages); no forms
- [x] Data merge from a CSV/TSV table (`{{Field}}` in text and link URLs, one page per record); no image fields
- [x] ONIX 3.0 book metadata: record in the document, ONIX message export, EPUB and PDF metadata; see docs/onix.md (not validated against the schema or code lists)
- [x] Everything available over MCP: outputs, imports and editing commands run by an editor on request, ONIX / data merge / duplicate page by the server; see docs/mcp-editor.md
- [ ] HTML export of text
- [ ] Book (several documents with shared styles and continuous numbering): not built. A document already holds sections with their own numbering; a multi-document book needs a server-side entity and cross-document style sync
- [ ] PDF/X validation and an embedded ICC profile; font subsetting; OpenType layout (ligatures, alternates) in the PDF; blur and inner shadows; gradient transparency stops

## 2. Collaboration
- [x] Multiplayer on the same network: nickname, avatar, others' cursors and selections, `/doc/<id>` link to join the same document (no accounts, on purpose)
- [x] MCP agents show up as people in presence (name with `-nickname`, default "Claude"; they highlight the node they are editing)
- [ ] Conflicts on the same property: today the last op to reach the server wins
- [x] Comments on the canvas: pins on a node or free on a page, threads with replies, resolve, in the Comments tab and as MCP tools (`list_comments`, `add_comment`, `resolve_comment`, `delete_comment`); see docs/collaboration.md
- [x] Named versions and branching: frozen copies of the document, opened as a branch (a new document)
- [x] Review and merge of a branch back into its source (three-way, conflicts flagged; docs/collaboration.md)
- [ ] Property-level merge in REAL TIME (CRDT or equivalent) instead of last-write-wins (the branch merge is property-level; live edits are still last-write-wins)
- [x] Permissions without accounts: share links with view / comment / edit / owner roles, enforced by the server (optional; open stays the default); per-person accounts are not there
- [ ] Optional relay/cloud for use beyond the LAN, still self-hostable (what exists: HTTPS and an admin token for exposing your own server; a NAT-crossing relay is not built)

## 3. Handoff and ecosystem
- [x] Dev mode: CSS/Tailwind/React and measurements (size, position, gaps to parent and siblings of the selection, in the Ship panel)
- [x] Plugin API (sandboxed scripts with a read/write bridge; docs/handoff.md)
- [x] Tokens in and out: W3C Design Tokens (DTCG) JSON and CSS custom properties, with modes; import of a DTCG file as collections (variables dialog); see docs/handoff.md
- [ ] Syncing components with the code

## 4. Performance
- [x] Invalidation-driven rendering, incremental scene index, discarding what is not visible, levels of detail, image reuse during pan/zoom; test bench on 20,000 nodes (see docs/performance.md)
- [x] Optional GPU renderer with CanvasKit (WebGL), parity verified with `pnpm parity`; to be measured on a real GPU before making it the default
- [x] User-loadable fonts (also in the GPU renderer)
- [ ] Kerning and text shaping in the GPU renderer (CanvasKit's Paragraph)
- [ ] Persistent data structures for the scene (applyOp without copying the whole map)

## 5. Differentiators
- [ ] MCP AI agent: consistency reviews, variants, token usage
- [x] Design review: text contrast (WCAG), tap targets and token consistency, as a Develop panel and the `review_design` MCP tool; see docs/handoff.md
- [ ] Generate screens from text or screenshot using the document's own components and tokens
- [ ] Design, code and flow tests in one pipeline (prototype -> codegen -> Playwright)
- [x] Git-versionable bundle format: `opendesigner pack` / `unpack` (one JSON file per node, stable bytes); see docs/handoff.md
