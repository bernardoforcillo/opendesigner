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

## Not yet

- Instance-swap and number properties, and properties that set fills or sizes.
- Shared libraries across documents.
- Detaching an instance (turning it into plain nodes) and pushing overrides back to
  the master.
- Per-variant property defaults beyond what each variant defines for itself.
