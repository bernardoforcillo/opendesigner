# Whiteboard objects

**Document menu → Whiteboard…** drops a ready-made object at the center of the view, and the MCP tool `create_board_object` (RPC `RenderBoard`) does the same for an agent. They are **not a new kind of node**: each one is a group of plain rectangles, text and vectors (drawn by `internal/board` on top of the diagram builder), so afterwards it is edited, restyled, aligned, commented and exported like anything else. The root group's `board.kind` meta says what it started as. One gesture, one undo step, the new group is selected.

| Object | Parameters |
|---|---|
| `sticky` | the text, a color: yellow (default), pink, green, blue, orange, purple |
| `table` | rows and columns (default 4 x 3, at most 400 cells), header texts; the first row is the header |
| `kanban` | column titles (default To do, Doing, Done), each with two task cards |
| `mindmap` | the center, then its branches, split between right and left |
| `brainstorm` | a title and two zones, Ideas and Wild ideas, each with sticky notes |
| `retrospective` | Went well, To improve, Actions, each with sticky notes |
| `user-flow` | five steps joined by arrows |
| `customer-journey` | five stages by Actions, Thoughts, Pain points, Opportunities |

Text is at most 400 characters per item and 60 items per request. Mermaid diagrams (flowchart, class, sequence, state) were already there: **Diagram (Mermaid, UML)…**, and a diagram keeps its source, so it is editable as text.

## The Board

**Board** (key `B`, in the top bar) is a mode for an infinite board without frames: the dock offers Select, **Sticky note** (`N`, a click drops a note centered on the pointer, drawn by the same server function as the dialog), Text, **Link** (`L`), **Vote** (`Y`), Pen, Hand and Comment. Nothing is a new kind of node: a note is still a group of plain nodes, and everything made in the Board shows in Design too.

### Connectors that follow the shapes

**Link**: drag from one thing to another (a note, a table, a card: the outermost group under the pointer) and an arrow joins them. With two nodes selected, the properties panel offers **Connect with arrow** / **Elbow connector** in any mode; a selected connector can switch between straight and elbow and between no arrow, one arrow and both ends.

A connector is a vector node whose `meta` names its ends (`connector.from`, `connector.to`, plus `connector.route` = `straight`/`elbow` and `connector.head` = `none`/`end`/`both`). The editor **derives** its path from where the two nodes are (like live booleans and variables: `store/connectors.ts`, nothing is written), so moving a box, an agent's `set_props`, a remote edit or an undo all keep the arrow attached. The path stored in the document is the one it had when it was made; code export and `pack` therefore show the arrow as it was drawn, not as it follows now (the SVG export and the prototype do follow).

### Facilitation

A strip on top of the Board (`FacilitationBar`) with:

- a **timer** (1, 3 or 5 minutes) that every person sees counting down; the one who started it can stop it;
- **dot voting**: five dots per person, put with the Vote tool (Alt-click takes one back), shown as red badges with the total on each node, **Results** lists the ranking and selects the node;
- **cursor chat** and **reactions**: a line of text or an emoji next to your cursor for six seconds, visible to everyone;
- **follow mode**: pick a person and your view takes theirs (their center point and zoom) every time they move; it stops when they leave or you pick Nobody.

All of it is **ephemeral and carried by presence** (`PresenceState`: view, chat, reaction, votes, timer), like the cursors: no accounts, no document change, no undo. The honest consequence: when someone leaves, their dots and their timer leave with them, and nothing is saved for later; take a screenshot or note the ranking before a workshop ends. The server bounds everything it relays (140 characters of chat, 50 dots, 40 of timer label, a timer at most one day long).

## Not there yet

Quick-text and arrow *drawing* with the pen as a connector, exporting a drawing back to Mermaid text, and votes that outlive the session.
