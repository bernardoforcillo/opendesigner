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
- [x] Auto layout: groups as children (one box of the union of their children, in rows, columns and grid cells); see docs/layout.md
- [x] Auto layout: baseline alignment on the cross axis of a row (estimated from font size and line height)
- [x] Auto layout: grid mode (rows / columns tracks with fixed, hug and fr sizes, gaps, cell spans; panel, MCP `set_grid_cell`, `display:grid` export, SwiftUI `Grid` and Compose `DesignGrid` export); see docs/layout.md
- [x] Context menu (right click on the canvas or a layer): swap, reset overrides, detach, go to main component, group / ungroup, bring forward / back, duplicate, delete; see docs/layout.md
- [x] MCP twins of the context menu commands that had none: `group_nodes`, `ungroup_nodes`, `arrange_nodes`, `duplicate_nodes`; see docs/layout.md
- [x] Constraints and responsive resize (min/max/stretch/center/scale per axis, recursive, exact undo); see docs/layout.md
- [x] Variants and component properties: component sets with axes, instances that choose a variant, boolean (show/hide) and text properties, editor dialog and instance controls, MCP tools, exported code; see docs/components.md
- [x] Instance swap (carrying over the overrides that fit), detach instance, reset overrides (all / per layer), go to main component; see docs/components.md
- [x] Shared libraries across documents: publish a document as a library, import components, styles, variables, fonts and images with their dependencies as ordinary undoable ops; editor dialog and MCP `set_library` / `get_library` / `import_from_library`; docs/libraries.md
- [x] Variables / design tokens with modes: color and number variables in collections with modes, bound to fills, strokes, opacity, rotation, radius and stroke width, pinned per subtree; editor dialog and panel, MCP tools, resolved in canvas/export/code, see docs/variables.md
- [x] Variables: string (text content) and boolean (visibility) variables, spacing / padding bindings that the auto layout engine reads per mode (density), aliases; see docs/variables.md
- [x] Variables: CSS custom properties per mode in the exported code (html target, `-css-vars`: `var(--collection-name, fallback)` plus a `:root` and a `[data-mode-...]` rule per mode; docs/codegen.md)
- [x] Typography: uploaded fonts (TTF/OTF/WOFF/WOFF2 as content-addressed assets, drawn by the 2D and GPU renderers and exported as @font-face), shared text styles, italic; multi-line text and wrapping were already there; see docs/typography.md
- [x] Type extras: text case (upper, lower, title, small caps), super/subscript, bulleted and numbered lists with indent, OpenType feature string, vertical alignment and inset in text boxes (canvas, CanvasKit, SVG, CSS, panel, MCP); see docs/typography.md
- [x] Horizontal text scale (a percentage on every text style: layout, canvas, CanvasKit, SVG, CSS, panel, MCP); see docs/typography.md
- [x] Rich text honours the type extras: case, super/subscript, small caps and OpenType features per range, lists and indent per paragraph, inset and vertical alignment of the box; paragraph and character styles carry them; see docs/typography.md
- [x] Live boolean groups (union, subtract, intersect, exclude; flatten on demand), outline stroke, masks (canvas, GPU, SVG, code, hit-test); see docs/vector.md
- [x] Presentation mode: the playable prototype (Present)
- [x] Diagrams: flowchart and UML (class, sequence, state) from Mermaid text, computed by the server; editor (document menu) and MCP (`create_diagram`, `update_diagram`, `list_diagrams`), see docs/diagrams.md
- [x] Connectors that follow the shapes (Link tool and panel; derived path, see docs/whiteboard.md)
- [x] Diagrams: `subgraph` (nested, titled boxes), ER diagrams (`erDiagram`), notes in class and state diagrams; see docs/diagrams.md
- [x] SVG import (paste, drop, import tool)
- [x] .fig import (experimental: read from the documented layout, tested on generated files; components and instances are not kept; docs/handoff.md)
- [x] .fig import tail: connectors (saved, straight, elbowed, curved, placed by their ends), tables and cells, sticky notes and other frame-like layers with their text, per-kind counts (synthetic files only; docs/handoff.md)
- [x] .fig variables: collections with modes, color / number / string / boolean variables, aliases and the layer bindings and pinned modes; what cannot bind is reported (synthetic files only; docs/handoff.md, docs/variables.md)
- [x] .fig import robustness tests on generated files: truncation at every length, bit flips, junk, hostile counts (no real file was available)
- [x] Prototyping: animated transitions between frames (dissolve, slide, push, smart animate) with duration and easing, and `auto` transitions after a delay; see docs/flows.md
- [x] Prototyping: hover, drag and scroll triggers, overlays in the player; see docs/flows.md
- [x] Prototyping: component state changes (`set-variant` transitions: variants on hover / press / click) in the player; see docs/flows.md
- [x] Present: device frames (generic, phone, tablet, desktop browser, none) and hotspot hints (flash on a missed click, a "Show hotspots" toggle); see docs/flows.md
- [x] Present device frame as a document setting (`DocSettings.present_device`, `set_document_settings`, "Make default" in the player), the person's pick kept as an override; see docs/flows.md
- [x] Prototype variables with expressions (`count = count + 1`, `count >= 3 || paid`) and an `else` guard for if / else on a hotspot; see docs/flows.md
- [x] Ordered if / else if / else chains in prototypes: `Transition.order` (proto), evaluated in sequence by the player, a Chain row in the Flows panel, MCP `set_transition` `order`, analysis rules (`else_orphan`, `shadowed`); docs/flows.md
- [x] Multiple artboards (frames), smart guides and snapping to nodes, layout grids on frames (columns, rows, square grid) that guide and snap; see docs/layout.md
- [x] Snap to a pixel grid (document menu: 1 / 4 / 8 px, per person) and spacing guides (equal gaps between neighbours, drawn while dragging)

## 1b. Vector (Illustrator parity)
- [x] Node tool: anchors, handles, add/delete points, corner/smooth, join, smooth/corner all (docs/vector.md)
- [x] Path offset (grow/shrink) and simplification; pathfinder = the live boolean groups
- [x] Live corners (a handle inside the corner of a selected rectangle: drag to round all four, live; docs/shapes.md)
- [x] Strokes: cap, join, miter limit and dashes on every shape (panel, canvas, GPU, SVG)
- [x] Arrowheads on open vector strokes (arrow, triangle, circle, square, diamond at either end; panel, canvas, GPU, SVG, code, MCP `set_stroke`)
- [x] Variable-width strokes on vectors (width points with a left and right width along the path, presets, a Variable width tool and panel; canvas, GPU, SVG as a filled outline, outline stroke, MCP `set_stroke`); see docs/vector.md
- [x] Advanced strokes: brushes (stretch and scatter brushes with dot, dash, square, diamond and leaf tips, spacing, scatter, size and angle jitter and a seed; chalk, marker, dots and leaves presets; stamps placed by arc length with a seeded RNG; canvas, GPU, SVG as a filled path, panel, MCP `set_stroke`); see docs/vector.md. Pen pressure and user-defined tips are not done
- [x] Shape builder tool: click or drag across the regions of overlapping shapes to merge them into one vector (Alt removes); see docs/vector.md
- [x] Shape builder over MCP (`list_shape_builder_faces`, `shape_builder`; Go port of the arrangement, areas golden-tested against the editor); see docs/vector.md
- [x] Gradient mesh (a color grid blended over the box; the points do not move; code export uses the average color)
- [x] SVG export and PDF (a real PDF writer, docs/output.md)
- [x] PDF import (editable text with embedded fonts and shared text styles, shapes and images, one page per PDF page), and export of all pages as PDF or EPUB (fixed layout); see docs/pdf-epub.md
- [x] EPS export (PostScript Level 2, vector pages; export panel, `export_eps` job, `export_image` format eps; docs/eps.md)
- [ ] Native .ai export; EPS carries no transparency, gradient meshes, blur or embedded fonts
- [x] Color: ICC profile stored with the document, CMYK<->RGB conversion through it and embedded in the PDF output intent (docs/color-management.md)
- [ ] ICC: v4 and matrix/TRC profiles, soft proofing, images converted through the profile, checked against a real printer profile

## 1c. Whiteboard (Miro parity)
- [x] Sticky notes (six colors) and arrows (flow and user-flow templates) as plain nodes; see docs/whiteboard.md
- [x] A Board mode (infinite board without frames: sticky, text, link, vote), arrows that follow the shapes
- [x] Tables, kanban boards and mind maps, drawn as groups of plain nodes (editor dialog, `RenderBoard` RPC, `create_board_object` MCP tool)
- [x] Templates: brainstorm, retrospective, user flow, customer journey
- [x] Cursor chat, reactions, timer, dot voting, follow mode (ephemeral, through presence)
- [x] Mermaid import/export in both directions: diagrams are drawn from Mermaid text, and the flows are written back as Mermaid (`opendesigner flow mermaid`, MCP `export_mermaid`; docs/diagrams.md)

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
- [x] Text frames with columns, inset and vertical alignment (columns and gutter in the Text section; docs/text-frames.md)
- [x] Threaded frames (text flows from one frame to the next, across pages), overset indicator; thread/unlink/add next frame, MCP (`thread_text_frames`); see docs/text-frames.md
- [x] Threading by dragging from a frame's port, a story editor (docs/text-frames.md)
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
- [x] Table styles (header/body/alternate), index sub-entries, endnotes, cross-references, conditional text, editorial notes, typographic text checks (no dictionary spell check); see docs/long-documents.md
- [x] Cell spanning (merge selected cells into the top-left one, split again; rows and columns added or removed keep spans consistent; docs/text-frames.md)
- [x] Find/change (text, word, regex), browser spell check, text variables (running headers, page count, document name)
- [x] Text on a path
- [x] OpenType feature settings per style (SVG output and editing field; not drawn on the canvas)

Graphics and colour
- [x] Linked images: file name and pixel size, effective resolution with a low-resolution warning, fitting from pixel size, relink, Links panel
- [x] Image frame fitting (`fit_frame`: fill, fit, tile, frame to content)
- [x] Swatches (process CMYK, RGB, spot, tints that follow their base), CMYK document mode and a recorded output profile
- [x] Overprint (written to the PDF, Ink manager UI)
- [x] Gradient swatches (shared paint styles with a gradient paint) and profile-managed conversion for CMYK mft1/mft2 profiles
- [ ] Gradient swatches that follow later edits of the swatches they were built from
- [x] Object styles (fill, stroke, effects, opacity, corner radius, blend mode; based-on)
- [x] Frame fitting (`fit_frame`)
- [x] Nested frames: clipping and placement in SVG and PDF, `fit_frame` frame-to-children and fit-in-parent (docs/nested-frames.md)
- [ ] Nested frames: corner radius in the clip, fit with auto layout or rotated frames
- [x] PDF output: blurred shadows, inner shadows, layer blur and gradient alpha stops; transparency flattened against white under PDF/X-1a and X-3
- [ ] Transparency flattening against the real backdrop; blur on vectors beyond rectangles and ellipses

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
- [x] HTML export of text (`export_html` mode `text`; File menu "Export text as HTML")
- [x] Book: server-side entity grouping documents with shared styles and continuous page numbering, Home section, MCP tools, booklet creep in imposition (docs/book.md)
- [x] PDF: ICC output profile embedded, TrueType font subsetting, GSUB ligatures and alternates, PDF/X and PDF/UA validation report on the written file (docs/pdf-fonts-validation.md)
- [ ] A full PDF/X validator (this is a report of the checks the writer can answer, not a certified validator); GPOS kerning and contextual substitution in the PDF

## 2. Collaboration
- [x] Multiplayer on the same network: nickname, avatar, others' cursors and selections, `/doc/<id>` link to join the same document (no accounts, on purpose)
- [x] MCP agents show up as people in presence (name with `-nickname`, default "Claude"; they highlight the node they are editing)
- [x] Conflicts on the same property: per-property last-writer-wins registers on the server, ops stamped with `base_seq`, a losing optimistic value rolled back (docs/collaboration.md)
- [x] Comments on the canvas: pins on a node or free on a page, threads with replies, resolve, in the Comments tab and as MCP tools (`list_comments`, `add_comment`, `resolve_comment`, `delete_comment`); see docs/collaboration.md
- [x] Named versions and branching: frozen copies of the document, opened as a branch (a new document)
- [x] Review and merge of a branch back into its source (three-way, conflicts flagged; docs/collaboration.md)
- [ ] Property-level merge in REAL TIME for structural ops (reparent, reorder, create, delete), list fields and text: those still resolve by arrival order; registers are in memory and reset on a server restart
- [x] Permissions without accounts: share links with view / comment / edit / owner roles, enforced by the server (optional; open stays the default); per-person accounts are not there

## 3. Handoff and ecosystem
- [x] Dev mode: CSS/Tailwind/React and measurements (size, position, gaps to parent and siblings of the selection, in the Ship panel)
- [x] SwiftUI and Jetpack Compose code (screens, auto layout, fills, gradients, strokes, shadows, text, vectors, images, components with properties as parameters, flows as navigation); format picker in Develop and Ship, `export_code` target; docs/codegen.md
- [x] Leptos (Rust) code target (view! macros with the IR's inline CSS, components with props, `leptos_router` routes, flows as `use_navigate`, the react target's Playwright tests; format picker in Develop and Ship, `export_code` target, CLI; type-checked with `cargo check`); docs/codegen.md
- [x] Diamond gradient exact in CSS (four quadrant layers) and angular / diamond as SVG patterns in vector code (was a circle / the first stop); docs/shapes.md
- [x] Ready for dev: frames marked ready (with a server-side snapshot), a ready list with focus view, colour-coded annotations on layers shown in Develop and written into the exported code, Compare changes (property-level diff against the snapshot); RPC `CompareReady`, MCP tools; see docs/handoff.md
- [x] Plugin API (sandboxed scripts with a read/write bridge; docs/handoff.md)
- [x] Plugin API for agents: `describe_plugin_api`, `validate_plugin`, `list_ui_languages` (read-only; running plugins and switching language stay editor-only); see docs/handoff.md, docs/localization.md
- [x] WebAssembly plugins (import-free modules run in a terminable Worker, capped memory, commands through the same bridge, one undo step; docs/handoff.md)
- [x] Tokens in and out: W3C Design Tokens (DTCG) JSON and CSS custom properties, with modes; import of a DTCG file as collections (variables dialog); see docs/handoff.md
- [x] Syncing components with the code: map components to code files and detect drift (CLI `sync` and MCP)
- [x] Localization layer: typed catalogs, live language switch, language from the browser or the document menu / Home, plurals; menus, tool dock, Home and panel headings translated into es, fr, de, it, pt-BR, ja, zh-Hans (machine drafts); see docs/localization.md
- [x] Localization: dates, numbers and relative times by interface language (docs/localization.md)
- [x] Localization: the remaining dialogs and panels named here, the Components panel and the facilitation bar translated
- [ ] Localization: Flow panel, Presence bar, typography / layout / brush / path / connector controls; review of all machine drafts with native speakers

## 4. Performance
- [x] Invalidation-driven rendering, incremental scene index, discarding what is not visible, levels of detail, image reuse during pan/zoom; test bench on 20,000 nodes (see docs/performance.md)
- [x] Optional GPU renderer with CanvasKit (WebGL), parity verified with `pnpm parity`; to be measured on a real GPU before making it the default
- [x] User-loadable fonts (also in the GPU renderer)
- [x] Kerning in the GPU renderer through CanvasKit Paragraph (pair kerning; docs/typography.md)
- [ ] GPU renderer: OpenType features and shaping beyond pair kerning, kerning with letter spacing, `pnpm parity` run on a real GPU
- [x] Persistent data structures for the scene (`store/nodeMap.ts`: a persistent 256-bucket map, an edit copies the touched buckets; the server's `core.ApplyShared` is copy-on-write; docs/performance.md)

## 5. Differentiators
- [x] MCP AI agent: `review_consistency` and `token_usage` tools, prompts `consistency_review`, `design_variants`, `token_cleanup`; see docs/mcp.md
- [x] Design review: text contrast (WCAG), tap targets and token consistency, as a Develop panel and the `review_design` MCP tool; see docs/handoff.md
- [x] Generate screens from the document's own kit: MCP `get_design_kit` / `generate_screen` and a Document menu entry; the text or screenshot is read by the connected agent
- [x] Playwright tests generated from flow paths (`opendesigner flow`, react and leptos targets)
- [x] One pipeline prototype -> codegen -> Playwright (`opendesigner pipeline`, MCP tool; react target)
- [ ] Pipeline: run the real npm install and Playwright path end to end, leptos target
- [x] Git-versionable bundle format: `opendesigner pack` / `unpack` (one JSON file per node, stable bytes); see docs/handoff.md

## Object tools (block 8)
- [x] Step and Repeat, Gap tool, frame fitting, clipping path, QR code, find/change objects, snippets (see docs/object-tools.md; all over MCP)
- [x] Gradient feather (effect, MCP, paste; drawn as strips), InDesign-style GREP dialect in find/change, shared object library (per browser, `object_library` command)
- [ ] Object library panel and sync across browsers; a smooth alpha mask for feather and its inspector controls

## Formats (block 9)
- [x] HTML, PowerPoint and IDML export; IDML import; place Word, RTF and Excel; tagged PDF; booklet imposition (see docs/formats.md; all over MCP)
- [x] Images in IDML and PPTX export, PDF/UA validation report, booklet creep
- [ ] IDML import of placed pictures

## Platform (block 10)
- [x] Ink manager (spot -> process, aliases, total ink), overprint in the PDF; CJK line breaking with kinsoku; Arabic shaping and bidi ordering in the PDF; `batch` and `list_editor_commands` (see docs/platform.md)
- [x] Bidi and Arabic shaping in the PDF
- [x] Paragraph direction control, vertical writing (vertical-rl), Thai / Lao / Khmer / Myanmar word breaking, separation preview, trapping suggestions and overprint merge colour as functions (docs/text-international.md, docs/print-preview.md)
- [ ] Ruby, Indic conjuncts and Thai mark positioning in the PDF, vertical text in rich-text runs and threaded frames, a canvas overlay for plate / overprint preview, creating a trap from a suggestion
