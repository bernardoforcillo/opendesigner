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

## Not there yet

An infinite board without frames, quick-text and arrow tools, connectors that follow the shapes they join (an arrow here is a vector: moving a box does not move it), exporting a drawing back to Mermaid text, and the facilitation tools (cursor chat, reactions, timer, voting, follow mode).
