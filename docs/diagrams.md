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
| UML state | `stateDiagram-v2` | states, transitions, start and end dot, choice, notes |
| Entity-relationship | `erDiagram` | entities with typed attributes, relationships with their cardinalities |

Other Mermaid types (Gantt, pie, …) are rejected with a message.

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
`subgraph id [Title]` ... `end` draws a titled box around the nodes first written inside it, and they nest;
the title may be `"Quoted"`, and a block with only a title uses it as its id. The layout does not know about
subgraphs, so a box is the bounding box of its members: a node outside it that the layout happens to place among
them is drawn over it (rare for hand-written diagrams). A subgraph without nodes draws nothing, and edges to a
subgraph's own id are not supported (they would add a node of that name).

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
`..` links; multiplicity in quotes and label after `:`. `note for Animal "text"` hangs a yellow note from a class on
a dotted line and `note "text"` draws a free one (`\n` breaks a line). The one carrying
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
does not. `note right of A : text` (or `left of`, `top of`, `bottom of`; or the block form closed by `end note`)
draws a note on a dotted line to the state; the side is not honoured, the layout places it.

**Entities.**

```
erDiagram
  CUSTOMER ||--o{ ORDER : places
  CUSTOMER {
    string name
    string email PK, UK "the login"
  }
  ORDER["Purchase order"] {
    int id PK
  }
```

An entity is drawn like a class (its name over its attribute rows: `type name`, then `PK`, `FK` or `UK`, then a
quoted comment). A relationship is a line with the cardinality at each end as text -- `||` is `1`, `|o` / `o|`
`0..1`, `}|` / `|{` `1..*`, `}o` / `o{` `0..*` -- and `..` in place of `--` makes it dotted (non-identifying).
The cardinalities are written as text, not as crow's-foot marks.

Caps: 200 nodes, 400 edges, 60 participants, 2000 events, 64 KiB of text. The
`style`, `classDef`, `click` lines are ignored.

## Known limits

- The arrows are **not attached** to the shapes: moving a node leaves the arrow
  where it is. To change a diagram you rewrite the text (`update_diagram`
  or Update). A "connector" node type in the model would be needed.
- Text width is estimated (the server has no fonts): the boxes have a
  bit of extra room.
- No dashing in the model: dashed lines are drawn as dashes.
- Composite states are flattened (no box); an ER relationship shows its cardinality as text.

The flows between screens (specification and Playwright tests) are another thing: see
`docs/flows.md`.
