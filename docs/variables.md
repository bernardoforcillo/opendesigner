# Variables (design tokens)

The document has **variables**: named colors, numbers, strings and booleans that nodes can bind
to, with one value per **mode** (Light / Dark, Compact / Comfortable, brand A /
brand B…). Like flows and clips, they live in the document and go through the op
log, so the editor, MCP agents and code read and write the same tokens, they
survive a reload and every change is one undo step.

## Model

```
Document.collections : map<id, VariableCollection>
Document.variables   : map<id, Variable>

VariableCollection { id, name, modes[] }            // modes[0] is the default
Variable           { id, collection_id, name, type, values: map<mode_id, value>, alias_of }
                     type  = color | number | string | boolean
                     value = Color{r,g,b,a} (0..1) | double | string | bool

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
| `font_size` | number | text nodes only; ignored when ≤ 0 |
| `text` | string | text nodes only: the content |
| `visible` | boolean | show / hide the node; a hidden node also leaves its auto layout parent's flow |
| `spacing`, `cross_spacing`, `padding_left`, `padding_top`, `padding_right`, `padding_bottom` | number | auto layout frames only; clamped to ≥ 0 |

The literal stored on the node stays as the fallback: detaching a binding gives
it back, and a binding whose variable, value or target (say `fills.3` on a node
with one fill) is missing is ignored.

### Variables that move the layout

The auto layout engine reads `spacing`, the paddings and `visible` **through** the variables,
in the active mode of the frame (a mode can be a density: *Comfortable* / *Compact*). The
stored `auto_layout` keeps its literal values as the fallback, but the positions the server
writes into the children are the ones the bound values give, and they are recomputed
whenever something they depend on changes: the binding itself, a mode pinned on the frame or
an ancestor, the variable (or an alias of it) being edited or deleted, the collection's modes.
`web/src/store/layout.ts` repeats the same dependency walk (`layoutTargets`), and
`testdata/golden/variables_layout.json` runs both sides. Exported code and the canvas read the
same resolved values (`ResolveNode`).

### Which mode applies

For a node and a collection, the **active mode** is the one pinned by the
nearest ancestor (the node itself included) in `Node.modes`, else the
collection's first mode. If the variable has no value for that mode it uses the
default mode's value. Pin a frame to *Dark* and everything inside it resolves
in dark; pin an inner frame to *Light* and that subtree goes back.

### Aliases

A variable may be an **alias** of another (`alias_of`): a semantic token
(`sem/surface`) over a primitive (`prim/white`). An alias holds no values of its
own and reads the target's. The target may be in another collection, so the
modes are matched by id: the alias reads the target in the mode of **the alias's
own collection** active on the node when the target's collection has a mode with
that id (the usual case, an alias within one collection), else in the target's
first mode. Chains resolve hop by hop the same way. Deleting a variable deletes
the aliases of it, transitively (a dangling alias has nothing to read), and
undo restores them after their targets.

## Invariants

Enforced by `core.Apply` (Go, the authority) and mirrored in
`web/src/store/variables.ts` (TypeScript); the shared fixture
`testdata/golden/variables.json` and `variables_alias.json` run both sides, rejections included.

1. A collection has a non-empty id and at least one mode; mode ids are non-empty
   and unique within it.
2. A variable has a non-empty id, an existing collection, a type, and values
   only for modes of that collection, each of the variable's type (colors in
   0..1, numbers finite).
3. An existing variable cannot change type or collection: delete and recreate.
   An alias carries no values, names an existing variable of the same type and
   never closes a cycle.
4. Every binding key is in the grammar above, points to an existing variable of
   the property's type. Every mode pin names an existing collection and one of
   its modes. A single bad entry rejects the whole `SetProperties`.
5. Removing a mode from a collection drops that mode's values and the pins on
   it; deleting a variable removes the bindings to it and deletes its aliases;
   deleting a collection deletes its variables, their aliases, their bindings and
   the pins on it. Undo restores
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
  stroke, opacity, rotation, radius, stroke width, visibility, the gap and paddings of an
  auto layout frame and (text nodes) font size and text, and pins collections to modes
  (the *Boolean* button of the dialog adds a checkbox variable).
  A color bound to a variable shows, read-only, what the variable resolves to (what the
  canvas draws); detach it there to edit the node's own literal again.
- **MCP**: `list_variables`, `create_collection`, `delete_collection`,
  `set_variable` (`aliasOf`, string and boolean values), `delete_variable`, `bind_variable`, `set_node_mode`;
  `get_document` includes `variables` and each node's `bindings` / `modes`.

- **`.fig` import**: the variables of a Figma file come in with their modes, aliases and bindings (docs/handoff.md).

## Not yet

- Variables for font family, and for widths / heights / size limits of auto layout children.
- A boolean variable driving a component's boolean property.
- Variable groups with their own settings.
- Emitting CSS custom properties per mode in the exported code instead of resolved values.
- The mode of an instance applying to its master's subtree.
