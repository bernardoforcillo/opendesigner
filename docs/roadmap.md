# Roadmap

Goal: a local-first design editor, with native AI co-design (MCP), that
can replace Figma for small teams and for those who want design and code together.

Legend: [x] done · [ ] to do

## 1. Basic parity
- [x] Shapes, text, images, vector, groups, frames, pages
- [x] Components with instances and overrides
- [x] Linear and radial gradients (canvas, SVG, panel, MCP)
- [x] Angular (conic) and diamond gradients (canvas, GPU, SVG export, CSS conic-gradient, panel, MCP; docs/shapes.md)
- [x] Polygon and star shapes (sides / points / inner ratio) and arcs, pies and rings on ellipses (tool dock, panel, canvas, GPU, SVG, code, hit-test, MCP `create_polygon` / `create_star` / `set_properties`; `.fig` import keeps them; docs/shapes.md)
- [x] Rectangle corner smoothing (squircle) and independent corner radii (panel, canvas, GPU, SVG, code, MCP)
- [x] Per-side stroke weights on rectangles and frames (panel, canvas, GPU, SVG, CSS, MCP `set_stroke`)
- [x] Shared paint styles and effect styles: named, applied to fills / strokes / effects, resolved like text styles (panel, ops, MCP, merge; docs/shapes.md)
- [x] More stops per gradient (add, move, remove from the panel)
- [x] Gradient on strokes from the panel; image as a fill or stroke paint (fill / fit / tile; canvas, GPU, SVG, code)
- [x] Effects: drop shadow and layer blur (canvas, SVG, panel, MCP, copy/paste; one per type per node is drawn)
- [x] Effects: multiple shadows per node, inner shadow, background blur, blend mode (docs/effects.md)
- [x] Effects: progressive layer and background blur, noise (mono, duo, multi), texture and a simplified glass (frosted backdrop, grain, light edge); canvas, CanvasKit, SVG, panel, MCP (docs/effects.md)
- [x] Auto layout: direction, spacing, padding, alignments, hug; computed by the server (Shift+A wraps the selection, Frame tool, panel, MCP `create_frame`/`set_auto_layout`)
- [x] Auto layout: reordering by dragging children (also into another auto layout), with insertion line and outline; a single undo step
- [x] Auto layout: children that fill the space (fill), wrapping onto several lines, dragging a child OUT of the frame, instances as children; see docs/layout.md
- [x] Auto layout: min/max sizes (fill children redistribute around them) and absolute children that stay constrained to the frame; see docs/layout.md
- [ ] Auto layout: groups as children
- [x] Auto layout: baseline alignment on the cross axis of a row (estimated from font size and line height)
- [ ] Auto layout: grid mode (rows / columns tracks with fixed, hug and fr sizes, cell spans)
- [x] Constraints and responsive resize (min/max/stretch/center/scale per axis, recursive, exact undo); see docs/layout.md
- [x] Variants and component properties: component sets with axes, instances that choose a variant, boolean (show/hide) and text properties, editor dialog and instance controls, MCP tools, exported code; see docs/components.md
- [x] Instance swap (carrying over the overrides that fit), detach instance, reset overrides (all / per layer), go to main component; see docs/components.md
- [ ] Shared libraries across documents
- [x] Variables / design tokens with modes: color and number variables in collections with modes, bound to fills, strokes, opacity, rotation, radius and stroke width, pinned per subtree; editor dialog and panel, MCP tools, resolved in canvas/export/code, see docs/variables.md
- [x] Variables: string (text content) and boolean (visibility) variables, spacing / padding bindings that the auto layout engine reads per mode (density), aliases; see docs/variables.md
- [ ] Variables: CSS custom properties per mode in the exported code
- [x] Typography: uploaded fonts (TTF/OTF/WOFF/WOFF2 as content-addressed assets, drawn by the 2D and GPU renderers and exported as @font-face), shared text styles, italic; multi-line text and wrapping were already there; see docs/typography.md
- [x] Type extras: text case (upper, lower, title, small caps), super/subscript, bulleted and numbered lists with indent, OpenType feature string, vertical alignment and inset in text boxes (canvas, CanvasKit, SVG, CSS, panel, MCP); see docs/typography.md
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
- [x] Present: device frames (generic, phone, tablet, desktop browser, none) and hotspot hints (flash on a missed click, a "Show hotspots" toggle); see docs/flows.md
- [x] Prototype variables with expressions (`count = count + 1`, `count >= 3 || paid`) and an `else` guard for if / else on a hotspot; see docs/flows.md
- [x] Ordered if / else if / else chains in prototypes: `Transition.order` (proto), evaluated in sequence by the player, a Chain row in the Flows panel, MCP `set_transition` `order`, analysis rules (`else_orphan`, `shadowed`); docs/flows.md
- [x] Multiple artboards (frames), smart guides and snapping to nodes, layout grids on frames (columns, rows, square grid) that guide and snap; see docs/layout.md
- [x] Snap to a pixel grid (document menu: 1 / 4 / 8 px, per person) and spacing guides (equal gaps between neighbours, drawn while dragging)

## 1b. Vector (Illustrator parity)
- [x] Node tool: anchors, handles, add/delete points, corner/smooth, join, smooth/corner all (docs/vector.md)
- [x] Path offset (grow/shrink) and simplification; pathfinder = the live boolean groups
- [ ] Live corners
- [x] Strokes: cap, join, miter limit and dashes on every shape (panel, canvas, GPU, SVG)
- [x] Arrowheads on open vector strokes (arrow, triangle, circle, square, diamond at either end; panel, canvas, GPU, SVG, code, MCP `set_stroke`)
- [ ] Advanced strokes: variable width profiles, brushes
- [x] Gradient mesh (a color grid blended over the box; the points do not move; code export uses the average color)
- [x] SVG export and PDF (the SVG through the browser's print dialog, Save as PDF)
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


Multi-page documents, long text and print output. Already there: pages, layout grids (columns, rows), uploaded fonts and shared text styles, PDF import with editable text, PDF/EPUB export of all pages (docs/pdf-epub.md).

Pages and structure
- [x] Page sizes and presets (A3-A6, Letter, Legal, Tabloid, book, square, custom)
- [x] Facing pages and spreads (inside/outside margins, left/right pages), numbering sections with styles 1, i, I, a, A; see docs/publishing.md
- [x] Master pages: template pages drawn behind the pages that apply them, `<#>` page-number token, editor, MCP (`update_page`), export; see docs/master-pages.md
- [x] Master pages: overrides per page, left/right masters, a master based on another (chains), ruler guides from the master
- [x] Pages panel with thumbnails (open, add page / master, setup)
- [x] Pages panel: reorder, duplicate, spreads, sections with their own numbering
- [x] Page size, margins, columns, gutter and bleed per page (Page setup…), drawn on the sheet, snapped to, and exported as the sheet; PDF for print with bleed
- [x] Slug areas, ruler guides per page, different margins for left and right pages
- [ ] Slug and spreads in the PDF/EPUB export
- [ ] Layers shared across pages

Text
- [ ] Text frames with columns, inset and vertical alignment
- [x] Threaded frames (text flows from one frame to the next, across pages), overset indicator; thread/unlink/add next frame, MCP (`thread_text_frames`); see docs/text-frames.md
- [ ] Threading by dragging from a frame's port, a story editor, columns in a single frame
- [x] Paragraph styles and character styles (based-on, next style, space before/after, indents), underline and strikethrough, editor pickers, MCP (`format_text`); see docs/rich-text.md
- [ ] Nested styles, colour in styles, bullets and numbering, tabs
- [x] Baseline grid (document setting, drawn on the page, snap target) and paragraphs that align to it; see docs/rich-text.md
- [x] Letter spacing (tracking) and underline / strikethrough
- [ ] Kerning control, horizontal scale, small caps, super/subscript
- [ ] Hyphenation and justification, widows/orphans, keep-with-next, drop caps
- [ ] Bullets and numbered lists, tabs, indents
- [ ] Text wrap around objects, anchored (inline) objects
- [ ] Footnotes, tables with cell and table styles, table of contents, index
- [ ] Find/change, spell check, text variables (running headers, page numbers)
- [ ] Text on a path; OpenType features (ligatures, stylistic sets, tabular figures)

Graphics and colour
- [ ] Placed (linked) images with update-on-change, fitting options, image frames, effective resolution
- [ ] Swatches (spot, tint, gradient), CMYK document mode, overprint, ICC profiles (see section 1b)
- [ ] Object styles, anchored and nested frames, frame fitting
- [ ] Transparency flattening for print, drop shadows and effects in PDF output

Output
- [ ] Print-ready PDF writer (PDF/X-1a, PDF/X-4): fonts embedded, bleed, crop marks, colour bars, CMYK
- [ ] Preflight panel (missing fonts, low-res images, overset text, RGB in CMYK documents)
- [ ] Package (document + fonts + links)
- [ ] EPUB: reflowable export from threaded text and styles (today: fixed layout), with a table of contents
- [ ] Interactive PDF (links, bookmarks, forms), HTML export of text
- [ ] Data merge (variable data from CSV), book (several documents with shared styles and numbering)

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
- [x] SwiftUI and Jetpack Compose code (screens, auto layout, fills, gradients, strokes, shadows, text, vectors, images, components with properties as parameters, flows as navigation); format picker in Develop and Ship, `export_code` target; docs/codegen.md
- [ ] Leptos (Rust) code target
- [x] Ready for dev: frames marked ready (with a server-side snapshot), a ready list with focus view, colour-coded annotations on layers shown in Develop and written into the exported code, Compare changes (property-level diff against the snapshot); RPC `CompareReady`, MCP tools; see docs/handoff.md
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
