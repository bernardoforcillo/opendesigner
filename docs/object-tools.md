# Object tools

Menu *Document > Object tools…*; every action is one undo step. Each one is also an MCP tool (they run in the open editor, see mcp-editor.md).

| Tool | MCP | Notes |
|---|---|---|
| Step and Repeat | `step_and_repeat` | 1–200 copies, each offset (dx, dy) from the previous; groups are copied with their children |
| Gap tool | `set_gap` | exact space between neighbours along x or y; the left/top one stays; negative overlaps |
| Frame fitting | `fit_frame` | image *fills* cover (`fill`), contain (`fit`) or `tile`; `frame-to-content` resizes an image *node* to its natural proportions |
| Clipping path | `clip_with_shape` | the shape becomes a mask at the bottom of a new group with the content; `release` turns it back into an ordinary shape |
| QR code | `create_qr_code` | ISO 18004 byte mode, versions 1–10 (up to 271 bytes at level L), levels L/M/Q/H, quiet zone, colours; drawn as vectors (a background square and one vector for the dark modules) |
| Find/change objects | `find_objects`, `change_objects` | by kind, layer-name regex, solid fill/stroke colour; change fill, stroke, weight, opacity, visibility, name |
| Snippets | `export_snippet`, `place_snippet` | the nodes and their children as text (protobuf JSON); place anywhere with the top-left at x, y |
| Object library | `object_library` | `list`, `save` (name + nodes), `place` (name or id, x, y), `delete`; saving an existing name (any case) replaces it; at most 200 items |
| Gradient feather | effect `gradientFeather` via `set_properties` | the node's own opacity ramps from `startOpacity` at (x1, y1) to `endOpacity` at (x2, y2), points in the node's unit box (defaults 1 to 0, top to bottom); held before and after |

## GREP (Find and change)
Tick *GREP* in the Find dialog, or pass `grep: true` to `find_change`. The pattern is translated to a JavaScript regular expression (Unicode, `^`/`$` at paragraph starts and ends, case sensitive unless *Match case* is off or the pattern starts with `(?i)`). Groups, alternation, quantifiers (greedy and lazy), lookahead and lookbehind pass through as they are.

| Write | Means |
|---|---|
| `~m` `~>` `~<` `~s` | em space, en space, thin space, no-break space |
| `~_` `~=` `~.` `~-` `~~` | em dash, en dash, ellipsis, discretionary hyphen, a tilde |
| `\r` `\n` `\t` `\h` | paragraph break (the model has one kind of break, `\n`), same, tab, horizontal white space |
| `\u` `\l` `\d` `\w` `\s` | uppercase letter, lowercase letter, digit, word character (any script), white space |
| `\<` `\>` | start / end of a word |
| `\x{00A0}` | a character by code point |
| `[[:alpha:]]` `[[:digit:]]` `[[:alnum:]]` `[[:upper:]]` `[[:lower:]]` `[[:punct:]]` `[[:space:]]` `[[:blank:]]` | classes, inside a set |

In the change-to text: `$0` the whole match, `$1`..`$9` groups, `\$` a dollar, and the same `~` and `\` characters. An unknown `~x` or escape is an error shown in the dialog, never silently literal.

## Checked
The QR encoder was decoded by an independent reader (OpenCV) for every level and for versions 1–10 with several blocks; the test pins the matrices.

## Limits
- GREP is a *translated subset* of InDesign's dialect (see below), not InDesign's engine: no possessive quantifiers, no negated `[[:^name:]]`, no `\K`, no `~b`/`~#`-style markers (page numbers, anchors), no case-changing `\U`/`\L` in the replacement, and no GREP *styles* (applying a character style by pattern).
- A snippet keeps image asset hashes: images show only in documents that hold the asset.
- The object library lives in the browser's localStorage: shared by every document opened in that browser, **not** synced to the server, other browsers or other users, and there is no editor panel for it yet (use the `object_library` MCP tool).
- Gradient feather is drawn in 24 strips (so a very slow fade can show faint banding), does not fade the node's inner shadows or noise/texture overlays, is not exported to SVG or CSS, and has no Properties-panel control yet (set it with `set_properties`).
- Frame fitting cannot crop an image *node* (it is stretched to its box); cover/contain apply to image fills.
- QR above version 10, Kanji/numeric/alphanumeric modes and Micro QR are not implemented (byte mode always works).
- Step and Repeat offsets are in the parent's units; rotated parents are not compensated.
