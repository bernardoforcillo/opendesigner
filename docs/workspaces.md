# Workspaces

One editor, two workspaces. The document's vertical (docs/publishing.md) decides which one opens; the document, the canvas and the renderers are the same.

| | Design and Design × Development | Publishing |
|---|---|---|
| Shape | a design tool's: icon rail and panel on the left, canvas, mode tabs and properties on the right, floating tool bar | a page-layout app's: tool rail, Control panel, canvas, tabbed dock, status bar |
| Left | **rail** (Layers, Components, Comments, Variables) and its panel; under Layers, the **Pages** list above the layer tree with **Find layers** | the tool rail |
| Right | a **people row** (your avatar and the others, with the nickname and link in a popover, and a **Share** button that opens the Share dialog), then the **mode tabs** (Board, Design, Flows, Develop; only the open one shows its name) and the **zoom menu**, then Properties | the dock: Properties, Pages, Layers, Styles, Preflight, Comments |
| Tools | floating bar at the bottom | vertical rail on the left |
| Top | document menu, name, people, status | the same, plus the one mode (Layout), and under it the Control panel |
| Bottom | -- | zoom field, Fit, page navigator, Spread, preflight verdict |

Shared by both:

- **Zoom** (`canvas/zoomCommands.ts`): in, out, 100%, fit, to selection -- from the zoom menu, the status bar, or the keyboard: Shift+0 / 1 / 2 (design tools) and Ctrl/Cmd+0 / 1 / + / - (page-layout apps). Fit frames the sheet (or the spread) of a sized page, else its content.
- **Actions palette** (Ctrl/Cmd+K or Ctrl/Cmd+/, `ui/shell/ActionsPalette.tsx`): type to find a tool, a mode, a zoom command, a panel, undo or redo, and run it. Results are ranked prefix first, then word, then substring, then group; at most 60. It also reaches the modes when the right panel (where their tabs are) is closed.
- **Find layers**: a search field over the layer tree; while it is not empty the tree shows only the matches and the containers that lead to them (reordering and collapsing wait until it is cleared).

The two shells are built from the pieces in `web/src/ui/shell/`; see docs/publishing.md for the Publishing ones.
