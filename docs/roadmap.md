# Roadmap

Goal: a local-first design editor, with native AI co-design (MCP), that
can replace Figma for small teams and for those who want design and code together.

Legend: [x] done · [ ] to do

## 1. Basic parity
- [x] Shapes, text, images, vector, groups, frames, pages
- [x] Components with instances and overrides
- [x] Linear and radial gradients (canvas, SVG, panel, MCP)
- [ ] More stops per gradient, gradient on strokes from the panel, image as a fill
- [x] Effects: drop shadow and layer blur (canvas, SVG, panel, MCP, copy/paste; one per type per node is drawn)
- [ ] Effects: multiple shadows per node, inner shadow, background blur, blend mode
- [x] Auto layout: direction, spacing, padding, alignments, hug; computed by the server (Shift+A wraps the selection, Frame tool, panel, MCP `create_frame`/`set_auto_layout`)
- [x] Auto layout: reordering by dragging children (also into another auto layout), with insertion line and outline; a single undo step
- [ ] Auto layout: children that fill the space (fill), wrapping onto several rows, dragging a child OUT of the frame, groups and instances as children
- [ ] Constraints and responsive resize
- [ ] Variants and component properties, shared libraries
- [ ] Variables / design tokens with modes
- [ ] Typography: loadable fonts, text styles, multi-line text
- [ ] Boolean operations, outline stroke, masks
- [ ] Prototyping and presentation mode
- [x] Diagrams: flowchart and UML (class, sequence, state) from Mermaid text, computed by the server; editor (document menu) and MCP (`create_diagram`, `update_diagram`, `list_diagrams`), see docs/diagrams.md
- [ ] Diagrams: connectors that follow the shapes, `subgraph`, ER, notes in class and state diagrams
- [ ] SVG import (then .fig)
- [ ] Prototyping: transitions between frames, smart animate, interactions on top of the existing animation engine
- [ ] Multiple artboards, grids, smart guides and snapping

## 1b. Vector (Illustrator parity)
- [ ] Pen tool: node editing, handles, join, smooth
- [ ] Pathfinder, path offset and simplification, live corners
- [ ] Advanced strokes: variable width profiles, brushes, arrowheads, dashes
- [ ] Gradient mesh
- [ ] SVG and PDF export; later AI/EPS
- [ ] Color: CMYK and ICC profiles (print)

## 1c. Whiteboard (Miro parity)
- [ ] Whiteboard mode: sticky notes, quick text and arrows
- [ ] Tables, kanban and mind maps as native objects
- [ ] Templates: brainstorming, retrospective, user flow, customer journey
- [ ] Cursor chat, reactions, timer, voting, follow mode
- [ ] Mermaid import/export in both directions

## 2. Collaboration
- [x] Multiplayer on the same network: nickname, avatar, others' cursors and selections, `/doc/<id>` link to join the same document (no accounts, on purpose)
- [x] MCP agents show up as people in presence (name with `-nickname`, default "Claude"; they highlight the node they are editing)
- [ ] Conflicts on the same property: today the last op to reach the server wins
- [ ] Comments on the canvas
- [ ] Named versions and branching (on the oplog), with review and merge
- [ ] Property-level merge (CRDT or equivalent) instead of last-write-wins
- [ ] Accounts, permissions, read-only and comment-only links (optional; local-first stays the default)
- [ ] Optional relay/cloud for use beyond the LAN, still self-hostable

## 3. Handoff and ecosystem
- [ ] Dev mode: measurements, CSS/Tailwind/React
- [ ] Plugin API
- [ ] Syncing tokens and components with the code

## 4. Performance
- [x] Invalidation-driven rendering, incremental scene index, discarding what is not visible, levels of detail, image reuse during pan/zoom; test bench on 20,000 nodes (see docs/performance.md)
- [x] Optional GPU renderer with CanvasKit (WebGL), parity verified with `pnpm parity`; to be measured on a real GPU before making it the default
- [ ] User-loadable fonts (today only Inter in the GPU renderer; system fonts only on CPU)
- [ ] Kerning and text shaping in the GPU renderer (CanvasKit's Paragraph)
- [ ] Persistent data structures for the scene (applyOp without copying the whole map)

## 5. Differentiators
- [ ] MCP AI agent: consistency reviews, variants, token usage
- [ ] AI design review: accessibility (contrast, touch targets), token consistency
- [ ] Generate screens from text or screenshot using the document's own components and tokens
- [ ] Design, code and flow tests in one pipeline (prototype -> codegen -> Playwright)
- [ ] Git-versionable bundle format (readable diffs)
