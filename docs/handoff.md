# Handoff: design review, tokens and a git-friendly format

## Design review

`opendesigner` checks a design against rules that can be decided mechanically (`internal/review`; pure and deterministic, so a panel, a CI job and an agent see the same findings):

| Rule | Severity | What it flags |
|---|---|---|
| `contrast` | error | text whose color against its background is below WCAG AA: 4.5:1, or 3:1 for large text (>= 24px, or >= 18.66px bold). The background is the nearest filled ancestors composited over white; a gradient or image behind makes the check skip rather than guess |
| `touch-target` | warn | an element used as a hotspot of a flow transition that is smaller than 44x44 |
| `token` | warn | a literal solid fill or stroke color that equals the value (in any mode) of a color variable but is not bound to it |

Hidden nodes and blank texts are not reviewed. Where to run it:

- the **Develop** mode's left panel, **Design review** (a click on an issue selects the node);
- the RPC `ReviewDesign`;
- the MCP tool `review_design`: an agent reviews its own work, fixes what it finds with `set_properties` / `bind_variable`, and reviews again.

## Tokens in and out

The variables dialog (**document menu → Variables…**) has **Export JSON**, **Export CSS** and **Import tokens…**.

- **JSON** is [W3C Design Tokens](https://design-tokens.github.io/community-group/format/): one top-level group per collection, a nested group for every `/` in a variable's name, `$type` (`color` or `number`) and `$value` for the collection's first mode. The other modes travel in `$extensions."com.opendesigner".modes` (the format has no modes of its own), and the collection's mode names in the group's extension. Colors are `#rrggbb`, or `#rrggbbaa` when not opaque.
- **CSS** puts the first mode of every collection in `:root` as `--group-name: value;` and the changes of every other mode in `[data-theme="<mode name>"] { ... }`. Numbers are written without a unit.
- **Import** reads a DTCG file into **new** collections (a name already taken gets a number). A group's `$type` is inherited; colors may be hex or `rgb()`, numbers and dimensions may be `12`, `12px` or `1.5rem` (the number is kept). Tokens of other types, and unreadable values, are skipped and counted in the message.

## A format for git

`opendesigner pack -doc <id|name> <dir>` writes a document as small files:

```
<dir>/document.json        everything except the nodes (pages, flows, variables, fonts, components, comments, ...)
<dir>/nodes/<id>.json      one node
<dir>/assets/<hash>        the asset files
```

The JSON is sorted and indented and ends with one newline: the same document always gives the same bytes, a pack rewrites only the files that changed and removes the files of deleted nodes, so **moving one rectangle changes one line of one file** and two people editing different nodes never touch the same file. A node id that is not a safe file name is percent-encoded.

`opendesigner unpack <dir>` builds the document back in the workspace (`-force` replaces one with the same id; the old one goes to the trash). Both work offline, like `export` and `flow`.

## Measurements in Develop

With one layer selected, the **Ship** panel (right) lists its **size and position inside its parent**, and the **distance to the parent's edges** and **to the nearest sibling on each side** (`dev/measure.ts`): the redlines, as numbers you can read off and copy. Gaps are measured between the layers' boxes in px. While you drag in Design, **equal-gap guides** show when the box lands the same distance from two neighbours (or repeats the gap between two others), and the document menu's **Pixel snap** (1, 4 or 8 px, per person) rounds a moved or resized box to a grid where no layer's edge offers a line.

## Ready for dev, annotations and Compare changes

Develop is where a design is handed over. Three things make the hand-over explicit (model in `internal/core/devmode.go`, TypeScript twin `web/src/store/devMode.ts`, parity fixture `testdata/golden/devmode.json`):

- **Ready for dev.** A **frame** is marked ready (Ship → **Dev status** → **Mark ready for dev**, with an optional note). The server stores the mark, who and when, and a **snapshot** of the frame and everything inside it as it is at that moment (a client never sends one: the server takes it when it applies the op, so replaying the log gives the same baseline). **Mark ready again** after more work takes a new snapshot; **Unmark** removes the mark. The left column lists the ready frames, oldest first, with the colours of the annotations inside each; picking one is the **focus view**: it selects the frame, so the code view shows its file and Ship shows its status. A frame that is deleted afterwards stays in the list as "(deleted frame)".
- **Annotations.** A note for the developer on any layer, with a **category** that sets its colour: `note` grey, `interaction` blue, `accessibility` green, `content` amber, `animation` purple, `layout` red. They are listed under Dev status for the selected layer, and exported as comments in the generated code: `// annotation [interaction] Opens the cart as a sheet (Ana)` above the element (`<!-- -->` in html), and a screen that is ready says `// ready for dev since 2026-10-24 by Ana: note` above its root. Annotations on a component's master are not repeated in every instance. A deleted layer leaves its annotations in the document (undoing the deletion brings them back).
- **Compare changes.** For a ready frame, **Compare changes** lists the property-level differences between the frame now and its snapshot: layers added or removed, and for each changed layer every property with its before and after (`Width 100 → 160`, `Fill 1 solid #ff0000 → solid #0000ff`, `Text content "Pay now" → "Pay"`). The server computes it (`internal/devmode`, RPC `CompareReady`): it walks the Node message by reflection, so a field added later is compared without touching the diff. It is the same property-level idea as the branch merge (`internal/merge`), but the merge only needs to know *which* paths moved to decide what to apply; this one reports the values, so it is its own code. Not reported: the position among siblings (inserting a layer renumbers its siblings' order keys, and the report would be noise); a moved frame does not report its children, whose coordinates are relative to it.

None of these ops enters the undo stack (like comments: they are hand-over state, not design edits). Roles: they need edit access.

MCP: `mark_ready_for_dev`, `clear_ready_for_dev`, `list_ready_for_dev` (with how many changes each frame has since), `compare_ready_for_dev`, `add_annotation`, `list_annotations`, `delete_annotation`. `export_code` writes the annotations into the code.

## Plugins

**Document menu → Plugins…** installs small scripts (a JSON file: name, permissions, and `code`, the body of an async function that receives `od`). They run in a **sandboxed iframe** (`sandbox="allow-scripts"` only: an opaque origin, no access to the editor, storage or cookies) whose content-security policy forbids every network request; the only way out is the `od` bridge (`plugins/api.ts`), checked against the permissions the plugin declared (`read`, `write`). Everything a run writes goes in as ordinary ops inside **one gesture**: one undo step, and nothing is kept if the script fails or takes more than 15 seconds.

`read`: `od.selection()`, `od.getNode(id)`, `od.listNodes(parentId?)`, `od.page()`. `write`: `od.createRect / createEllipse / createFrame({x, y, width, height, fill, name, parentId})`, `od.createText({text, fontSize, x, y})`, `od.setProps(id, {x, y, width, height, rotation, opacity, name, visible, fill})`, `od.deleteNode(id)`, `od.select(ids)`. Always: `od.notify(message)`. Arguments are validated; a plugin cannot reach anything beyond that list. Plugins are kept in the browser (`localStorage`), not in the document. Only install plugins you trust: the sandbox contains a script, but a script allowed to `write` can still rearrange your design (and you can undo it).

**WebAssembly plugins.** Instead of `code`, a plugin file may carry `wasm`: a module in base64 (`plugins/wasm.ts`, `wasmRun.ts`, `wasmWorker.ts`). A module is a pure function from a JSON snapshot to a JSON list of commands. It exports `memory`, `od_input()`, `od_output()` and `od_run(n)` (the input is `n` bytes at `od_input()`; the answer is the returned number of bytes at `od_output()`, or a negative error code; both regions are at most 16 KiB), and it may **import nothing**: no clock, network, files or callbacks. Its memory must declare a maximum of at most 64 pages (4 MiB), and a module over 1 MiB is refused; both are checked from the binary at install time and again before each run. The snapshot (`{selection: [layers], page}`) is given only to plugins with the `read` permission. The answer is `[{"method": "createRect", "args": [{...}]}, ...]`, up to 1000 commands, and each one goes through the same bridge as a script plugin's `od.*` calls (same permissions, same validation), as ONE undo step; if any fails nothing is kept. The module runs in a Worker that is terminated after 5 seconds. The Plugins dialog has a "Show a WebAssembly example" button: `plugins/wasmExample.ts` builds it with `plugins/wasmAsm.ts`, a 70-line assembler (memory, functions as instruction bytes, data), so no toolchain is needed to try it; any `wasm32` toolchain (Rust, C, Zig, AssemblyScript) that satisfies the exports works. Tested with Node's WebAssembly and fake workers; the Worker itself, and stopping a real endless loop, were not exercised in a browser.


**Document menu → Import Figma file…** reads a `.fig` (the server does it: `ImportFig`, `internal/figimport`). `.fig` is **not a public format**: the reader follows the layout open-source tools have documented (a zip with `canvas.fig` and `images/`, "fig-kiwi" chunks of deflate or zstd data, a Kiwi schema inside, a list of node records) and was **tested against files built to that layout, not against files exported by every version of Figma**. If it cannot read a file it says why; what it cannot place it lists as a warning instead of guessing.

It carries over pages (as groups, stacked), frames with their auto layout, groups, rectangles (corner radius), ellipses, text (family, size, weight, italic, line height, alignment), vector paths (lines, curves), fills (solid, linear and radial gradients, images), strokes (weight, alignment), shadows and blurs, masks, constraints, rotation, opacity, blend mode. **Not carried over**: components and instances as such (an instance becomes a plain frame), prototyping, plugin data, slices, and anything the file stores in a form the reader does not know. A path it misreads falls back to a rectangle with a warning. The result lands as one group at the center of the view, in one undo step.

**Import tail** (synthetic files only; nothing was checked against a file saved by Figma). **Connectors** come in as vectors: a saved path (`strokeGeometry`, an outline) is kept and filled with the stroke's colour; the saved path may also sit in the generated row of `derivedImmutableFrameData` (guid path `40000000:0`); without one the line is redrawn between its two ends (`connectorStart` / `connectorEnd`: a free `position`, or a sibling layer's transform applied to `relativePosition`; the corners of the layer's box when an end cannot be placed) as a straight line, an elbow (across, along, across) or a cubic curve, and a warning says so. They are not attached to the layers they joined and their labels are left out. **Tables, table cells, sticky notes, shapes with text, code blocks and slides** come in as frames (a slide clips), and the text they carry becomes a text layer inside, with a warning per kind. The result also carries the report's numbers (`Imported` and `Skipped`, layers per Figma kind).

**Variables from a `.fig`** (synthetic files only; field names taken from FigCraft's reader, `crates/format/src/fig/map.rs`, not from a file saved by Figma). `ImportFig` also returns `collections` and `variables`; the editor creates them (SetCollection, then SetVariable, in the order given: an alias after its target) in the same gesture as the nodes, whose `bindings` and `modes` name them.

- **Collections** are `VARIABLE_SET` nodes, their modes `variableSetModes` (by `sortPosition`; the first is the default; at most 256 per collection). **Variables** are `VARIABLE` nodes: `variableSetID` (a guid, or an `assetRef` key and version), `variableResolvedType` (`COLOR`, `FLOAT`, `STRING`, `BOOLEAN`; other types are left out and counted) and one value per mode in `variableDataValues`. Variables of a collection that is not in the file (library variables) are left out and counted.
- **Aliases** stay aliases (`alias_of`) when every mode of the variable aliases the same variable of the same type; otherwise (different targets per mode, or a literal in some modes, a cycle, a chain longer than 32 hops) the variable is imported with the values its aliases resolve to, and a warning says so. A cross-collection alias reads the target in the same mode only when the mode ids match (they never do after import), so it reads the target's default mode.
- **Bindings** come from `variableConsumptionMap` (opacity, corner radius on rectangles, stroke weight, auto layout spacing, counter spacing and paddings on auto layout frames, visibility, text and font size on text) and from `colorVar` on a solid fill or stroke paint (`fills.N` / `strokes.N`, indexed by the paints that were kept: hidden ones drop out). `variableModeBySetMap` becomes the node's `modes`. A binding to a variable of the wrong type, or to a field with no counterpart (width, height, min/max sizes, per-corner radii, gradient stops, font family, letter spacing, line height, paragraph fields) stays a literal, and the warning counts it by field.

Robustness is tested on generated files (`internal/figimport/robust_test.go`): truncation at every length, a flipped bit in every byte, junk, absurd counts and chains, deep trees. They show the reader neither panics nor hangs and that what it returns, variables included, passes `core.Apply`; they say nothing about files Figma wrote.

## CMYK

The fill's color has a **CMYK** read-out and entry under the hex field: four percentages, converted with the plain device-independent formula. The document stays RGB (the model, the renderers and every export are RGB). **ICC profiles and color-managed print output are not there**: that needs a color-management engine and a printer's own profile, and without it a CMYK number is a starting point for the print shop's conversion, not a proof.

## Not there yet

Syncing components with the code, and ICC-managed CMYK / print proofs.
