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

## Plugins

**Document menu → Plugins…** installs small scripts (a JSON file: name, permissions, and `code`, the body of an async function that receives `od`). They run in a **sandboxed iframe** (`sandbox="allow-scripts"` only: an opaque origin, no access to the editor, storage or cookies) whose content-security policy forbids every network request; the only way out is the `od` bridge (`plugins/api.ts`), checked against the permissions the plugin declared (`read`, `write`). Everything a run writes goes in as ordinary ops inside **one gesture**: one undo step, and nothing is kept if the script fails or takes more than 15 seconds.

`read`: `od.selection()`, `od.getNode(id)`, `od.listNodes(parentId?)`, `od.page()`. `write`: `od.createRect / createEllipse / createFrame({x, y, width, height, fill, name, parentId})`, `od.createText({text, fontSize, x, y})`, `od.setProps(id, {x, y, width, height, rotation, opacity, name, visible, fill})`, `od.deleteNode(id)`, `od.select(ids)`. Always: `od.notify(message)`. Arguments are validated; a plugin cannot reach anything beyond that list. Plugins are kept in the browser (`localStorage`), not in the document. Only install plugins you trust: the sandbox contains a script, but a script allowed to `write` can still rearrange your design (and you can undo it).

## Importing a Figma file (experimental)

**Document menu → Import Figma file…** reads a `.fig` (the server does it: `ImportFig`, `internal/figimport`). `.fig` is **not a public format**: the reader follows the layout open-source tools have documented (a zip with `canvas.fig` and `images/`, "fig-kiwi" chunks of deflate or zstd data, a Kiwi schema inside, a list of node records) and was **tested against files built to that layout, not against files exported by every version of Figma**. If it cannot read a file it says why; what it cannot place it lists as a warning instead of guessing.

It carries over pages (as groups, stacked), frames with their auto layout, groups, rectangles (corner radius), ellipses, text (family, size, weight, italic, line height, alignment), vector paths (lines, curves), fills (solid, linear and radial gradients, images), strokes (weight, alignment), shadows and blurs, masks, constraints, rotation, opacity, blend mode. **Not carried over**: components and instances as such (an instance becomes a plain frame), variables, prototyping, plugin data, slices, and anything the file stores in a form the reader does not know. A path it misreads falls back to a rectangle with a warning. The result lands as one group at the center of the view, in one undo step.

## CMYK

The fill's color has a **CMYK** read-out and entry under the hex field: four percentages, converted with the plain device-independent formula. The document stays RGB (the model, the renderers and every export are RGB). **ICC profiles and color-managed print output are not there**: that needs a color-management engine and a printer's own profile, and without it a CMYK number is a starting point for the print shop's conversion, not a proof.

## Not there yet

Syncing components with the code, and ICC-managed CMYK / print proofs.
