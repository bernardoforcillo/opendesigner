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
- [x] SVG export and PDF (the SVG through the browser's print dialog, Save as PDF)
- [ ] AI/EPS export
- [ ] Color: ICC profiles and color-managed print (CMYK read-out/entry exists, plain conversion only)

## 1c. Whiteboard (Miro parity)
- [x] Sticky notes (six colors) and arrows (flow and user-flow templates) as plain nodes; see docs/whiteboard.md
- [x] A Board mode (infinite board without frames: sticky, text, link, vote), arrows that follow the shapes
- [x] Tables, kanban boards and mind maps, drawn as groups of plain nodes (editor dialog, `RenderBoard` RPC, `create_board_object` MCP tool)
- [x] Templates: brainstorm, retrospective, user flow, customer journey
- [x] Cursor chat, reactions, timer, dot voting, follow mode (ephemeral, through presence)
- [ ] Mermaid import/export in both directions

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
