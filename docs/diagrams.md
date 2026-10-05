# Diagrams and UML

You describe a diagram in [Mermaid](https://mermaid.js.org/) text and
opendesigner draws it on the canvas as a **group of ordinary layers** (shapes,
arrows, text): it can be edited, exported and, in the editor, undone in a single
undo step. The drawing is computed by the **server** (`internal/diagram`), so
the editor and MCP agents produce exactly the same diagram.

| Type | Header | What it draws |
|---|---|---|
| Flowchart | `flowchart TD` / `graph LR` | nodes in five shapes, solid, dashed or thick edges |
| UML class | `classDiagram` | three-compartment classes, inheritance, composition, aggregation, association, dependency, realization |
| UML sequence | `sequenceDiagram` | participants, messages, activations, notes, `loop`/`alt`/`opt`/`par` fragments |
| UML state | `stateDiagram-v2` | states, transitions, start and end dot, choice |

Other Mermaid types (ER, Gantt, …) are rejected with a message.

## From the editor

Document menu → **Diagram (Mermaid, UML)…**. The dialog has an example
for each type. With a diagram selected the dialog opens on its text and
**Update** redraws it in place (same name and position).

## From MCP

| Tool | What it does |
|---|---|
| `create_diagram` | draws a diagram from `source`; `parentId`, `x`, `y`, `name` optional (by default to the right of what is already there) |
| `update_diagram` | redraws an existing diagram from new text, in the same place; returns the new id |
| `list_diagrams` | lists the diagrams with kind, position and source text |

The source text stays in the root's `meta` (`diagram.source`, `diagram.kind`),
so an agent can read a diagram back and fix it with `update_diagram`
instead of moving shapes by hand. Unreadable text is a tool error that
names the line; no change is left half-done.

Via the Connect protocol: `DocumentService.RenderDiagram(source)` is pure (it does
not touch the document) and returns the nodes, ready to insert.

## Syntax read

**Flowchart.** `A[rectangle]`, `A(rounded)`, `A([pill])`, `A((circle))`,
`A{decision}`; edges `-->`, `---`, `-.->`, `==>`, `<-->`, with text `-->|yes|` or
`-- yes -->`; chains `A --> B --> C` and groups `A & B --> C`; `<br/>` wraps.

**Classes.**

```
classDiagram
  class Animal {
    <<abstract>>
    +String name
    +eats() void
  }
  Animal <|-- Duck
  Owner "1" --> "*" Animal : owns
  Duck ..> Pond : uses
```

Relations: `<|--` / `--|>` inheritance, `*--` composition, `o--`
aggregation, `-->` association, `..>` dependency, `..|>` realization, `--` and
`..` links; multiplicity in quotes and label after `:`. The one carrying
the triangle or the diamond sits on top. A member with `(` is a method, the others are
attributes; `Name~T~` becomes `Name<T>`.

**Sequence.** `participant A as Alice`, `actor B`; messages `->>` (solid),
`-->>` (dashed reply), `->`/`-->` (no arrowhead), `-x` (lost), `-)`
(async); `+`/`-` after the arrow activate/deactivate; `activate`/
`deactivate`; `Note over A,B: …`, `Note left of A`, `Note right of A`;
`autonumber`; blocks `loop`, `alt`/`else`, `opt`, `par`/`and`, `critical`/
`option`, `break` closed by `end`.

**States.** `[*] --> A`, `A --> B : event`, `state "Long name" as X`,
`state X <<choice>>`, `X : description`, `direction LR`. Composite states
(`state X { … }`) are flattened: the inner transitions stay, the box
does not.

Caps: 200 nodes, 400 edges, 60 participants, 2000 events, 64 KiB of text. The
`subgraph`, `style`, `classDef`, `click` lines are ignored.

## Known limits

- The arrows are **not attached** to the shapes: moving a node leaves the arrow
  where it is. To change a diagram you rewrite the text (`update_diagram`
  or Update). A "connector" node type in the model would be needed.
- Text width is estimated (the server has no fonts): the boxes have a
  bit of extra room.
- No dashing in the model: dashed lines are drawn as dashes.
- No `subgraph`, notes in class and state diagrams, ER.

The flows between screens (specification and Playwright tests) are another thing: see
`docs/flows.md`.
