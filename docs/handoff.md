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

## Not there yet

Dev-mode measurements on the canvas (spacing and size redlines), a plugin API for running scripts inside the editor (the MCP server is the automation surface today), and syncing components with the code.
