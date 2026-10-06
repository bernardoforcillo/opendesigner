# Variables (design tokens)

The document has **variables**: named colors and numbers that nodes can bind
to, with one value per **mode** (Light / Dark, Compact / Comfortable, brand A /
brand B…). Like flows and clips, they live in the document and go through the op
log, so the editor, MCP agents and code read and write the same tokens, they
survive a reload and every change is one undo step.

## Model

```
Document.collections : map<id, VariableCollection>
Document.variables   : map<id, Variable>

VariableCollection { id, name, modes[] }            // modes[0] is the default
Variable           { id, collection_id, name, type, values: map<mode_id, value> }
                     type  = color | number
                     value = Color{r,g,b,a} (0..1) | double

Node.bindings : map<property, variable_id>          // what is bound to what
Node.modes    : map<collection_id, mode_id>         // mode pinned on this subtree
```

Four ops, **absolute upserts** (the incoming value is the final value, so the
inverse of an op is the previous state):

| Op | Number | Effect |
|---|---|---|
| `SetCollection { collection }` | 27 | creates the collection or replaces it |
| `DeleteCollection { id }` | 28 | deletes it, its variables and the bindings to them |
| `SetVariable { variable }` | 29 | creates the variable or replaces it |
| `DeleteVariable { id }` | 30 | deletes it and unbinds it everywhere |

Bindings and pins are written with `SetProperties`, mask paths `bindings` and
`modes`; like `meta`, the mask replaces the whole map.

### Bindable properties

| Key | Type | Notes |
|---|---|---|
| `fills.N`, `strokes.N` | color | N is the paint's index; only a solid paint takes the color (a gradient keeps its own stops) |
| `opacity`, `rotation` | number | opacity is clamped to 0..1 |
| `corner_radius` | number | rectangles only |
| `strokes.N.weight` | number | clamped to ≥ 0 |

The literal stored on the node stays as the fallback: detaching a binding gives
it back, and a binding whose variable, value or target (say `fills.3` on a node
with one fill) is missing is ignored.

### Which mode applies

For a node and a collection, the **active mode** is the one pinned by the
nearest ancestor (the node itself included) in `Node.modes`, else the
collection's first mode. If the variable has no value for that mode it uses the
default mode's value. Pin a frame to *Dark* and everything inside it resolves
in dark; pin an inner frame to *Light* and that subtree goes back.

## Invariants

Enforced by `core.Apply` (Go, the authority) and mirrored in
`web/src/store/variables.ts` (TypeScript); the shared fixture
`testdata/golden/variables.json` runs both sides, rejections included.

1. A collection has a non-empty id and at least one mode; mode ids are non-empty
   and unique within it.
2. A variable has a non-empty id, an existing collection, a type, and values
   only for modes of that collection, each of the variable's type (colors in
   0..1, numbers finite).
3. An existing variable cannot change type or collection: delete and recreate.
4. Every binding key is in the grammar above, points to an existing variable of
   the property's type. Every mode pin names an existing collection and one of
   its modes. A single bad entry rejects the whole `SetProperties`.
5. Removing a mode from a collection drops that mode's values and the pins on
   it; deleting a variable removes the bindings to it; deleting a collection
   deletes its variables, their bindings and the pins on it. Undo restores
   all of it in one step.

## Where it shows up

- **Canvas, prototype player and exports (PNG, SVG)** draw the *resolved* scene:
  `resolveScene` derives it from the document without writing anything, the same
  way animation poses a scene. A document without variables pays nothing (same
  scene instance). Tools and the properties panel keep reading the real document.
- **Code generation** (`export_code`, `opendesigner export`) emits the resolved
  values of each node's active mode, so the code matches the canvas. A master
  descended into through an instance resolves in the master's own modes.
- **Editor**: document menu → *Variables…* creates collections, modes and
  variables; the properties panel's *Variables* section binds the selection's fill,
  stroke, opacity, rotation, radius and stroke width, and pins collections to modes.
  A color bound to a variable shows, read-only, what the variable resolves to (what the
  canvas draws); detach it there to edit the node's own literal again.
- **MCP**: `list_variables`, `create_collection`, `delete_collection`,
  `set_variable`, `delete_variable`, `bind_variable`, `set_node_mode`;
  `get_document` includes `variables` and each node's `bindings` / `modes`.

## Not yet

- Variables for text (font size, family), spacing and auto layout, booleans and strings.
- Aliases (a variable that points to another) and variable groups with their own settings.
- Emitting CSS custom properties per mode in the exported code instead of resolved values.
- The mode of an instance applying to its master's subtree.
