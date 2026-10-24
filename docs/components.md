# Component variants and properties

A component (a master node registered with `createComponent`) can be grouped with
others into a **component set** of **variants**, and can define **properties** that
each instance sets without touching the master. Like variables and typography they
live in the document and go through the op log, so the editor, MCP agents and code
read and write the same definitions, and every change is one undo step.

## Model

```
Document.component_sets : map<id, ComponentSet>
ComponentSet { id, name, axes: [VariantAxis { name, options[] }] }

Component    { root_node_id, name,
               set_id, variant: map<axis, option>,        // variants
               properties: [ComponentProperty] }          // properties
ComponentProperty { name, type: BOOLEAN | TEXT, default_value, target_node_ids[] }

InstanceNode { component_id, overrides[],
               variant_props:   map<axis, option>,        // the variant it chose
               property_values: map<name, value> }        // by property NAME
```

Four ops, **absolute upserts** (the inverse of an op is the previous state):

| Op | Number | Effect |
|---|---|---|
| `SetComponentSet { component_set }` | 35 | creates the set or replaces it |
| `DeleteComponentSet { id }` | 36 | deletes it; its members become standalone |
| `SetComponentDef { component_id, set_id, variant, properties }` | 37 | replaces a component's set membership, variant and properties wholesale |
| `SetInstanceProps { instance_id, property_values, variant_props }` | 38 | replaces an instance's values and variant choice wholesale |

### Variants

A set has **axes** (State: `default` | `hover`; Size: `sm` | `md`). Each member
component assigns exactly one option on every axis and no two members share a
combination. An instance renders the member that matches **its base component's
assignment overridden by its `variant_props`**: switching `State` to `hover` swaps
the master it shows; axes it does not mention keep the base component's option. If
nothing matches (a stale choice) it falls back to the base component.

### Properties

- **BOOLEAN**: `"false"` hides the target nodes of the master (drawing, hit-test,
  marquee, bounds and generated code all leave them out, like an invisible node).
- **TEXT**: sets the content of the target text nodes.

Values are stored on the instance by property **name**, so the same property can
exist on every variant of a set and survive a variant switch. An explicit instance
override on a node still wins over a property-derived text. A stored value that is
not valid for the property's type is ignored (the default applies).

## Invariants

Enforced by `core.Apply` (Go, the authority) and mirrored in
`web/src/store/components.ts`; `testdata/golden/component_variants.json` runs both
sides, rejections included.

1. A set has a non-empty id and at least one axis; axis names and options are plain
   names (letters, digits, space, `_`, `.`, `-`; 1..32), axis names are unique,
   every axis has at least one option and options are unique within it.
2. A component is standalone (no set, no variant) or a member of an existing set
   with exactly one valid option per axis; no two members share a combination.
3. A property has a unique plain name, a type, a default of that type (`"true"` /
   `"false"`, or at most 1000 bytes of text) and at least one target, each inside the
   master's subtree (text nodes only for TEXT).
4. An instance's variant choice names axes of its base component's set with valid
   options; its property values name properties of the component it resolves to,
   with values of the property's type.
5. Deleting a node removes it from the property targets it was in (a property left
   without targets goes away); changing a set's axes or deleting the set detaches
   the members whose assignment no longer fits. Undo restores all of it.

## Where it shows up

- **Canvas, hit-test, marquee, bounds, prototype player, exports**: through
  `resolveInstance` (which master) and `instanceOverrideMap` (property-derived and
  explicit overrides, plus the hidden nodes), the same funnel as plain overrides.
- **Code generation** exports the variant the instance chose, with the property
  values applied.
- **Editor**: in the Components panel, the pen button on a component opens the
  component dialog: create a variant set, add options and axes, move this component
  to another combination, duplicate it as a new variant, and add properties from the
  nodes selected on the canvas (boolean: show/hide; text: content). A selected
  instance shows its variant selects and property controls in the properties panel;
  switching variant keeps the values of the properties the new variant also has.
- **MCP**: `create_instance`, `list_component_sets`, `set_component_set`,
  `delete_component_set`, `set_component_def`, `set_instance_props`;
  `list_components` and `get_document` include the set, variant and properties.

## Swap, reset, detach, go to main component

One more op, **`SetInstance { instance_id, instance }` (70)**, replaces an instance's whole
payload (component, overrides, property values, variant choice); its inverse is the previous
payload. The node's own transform is untouched, so a swap also writes the new size with a
`SetProperties`. It is validated like the rest: the component and its master exist, every
override names a node of that master (or of a variant of its set) and overrides something,
the property values and variant choice are valid for the component it resolves to, and the
instance may not show a component that contains it (directly, through nested instances or
through the variants of a set).

- **Swap** (`SwapInstance` in `internal/core/instances.go`, `swapInstance` in
  `web/src/store/instanceOps.ts`): the instance points at another component and keeps what
  still fits. Overrides follow the layers the two masters have in common (same kind and name
  at the same place among the siblings, from the roots down; a text override only on a text
  layer); property values stay when the new component defines a property of that name and type
  and the value is valid; variant choices stay when the new component's set has that axis and
  option. The instance takes the new master's size.
- **Reset**: *all* is a `SetInstance` with the lists emptied (same component); *one layer* is
  the existing `SetInstanceOverride` with nothing present.
- **Detach** has no op of its own: the instance is deleted and the master it renders (the
  variant it chose) is copied in its place under the **same id**, with overrides baked in (text,
  fills), boolean properties that were off as hidden nodes, number properties written into the
  nodes, swap properties applied to the nested instances. The new root keeps the instance's
  name, place, size, layout settings and mode pins; nested instances stay instances. As it is a
  delete plus creates, flow transitions that pointed at the instance go with the old node.
- **Go to main component**: selects the master's root, switching to its page.

In the editor: the *Instance* section of the properties panel (component select, one *Reset*
per override, *Reset all changes*, *Detach instance*, *Go to main component*) and Ctrl/Cmd+Alt+B
for detach; each is one gesture, one undo step. MCP: `swap_instance`, `reset_instance_overrides`,
`detach_instance`, `get_main_component`.

## Not yet

- Instance-swap and number properties, and properties that set fills or sizes.
- Shared libraries across documents.
- Pushing overrides back to the master.
- A context menu for the instance commands (the editor has none yet).
- Per-variant property defaults beyond what each variant defines for itself.
