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

## Checked
The QR encoder was decoded by an independent reader (OpenCV) for every level and for versions 1–10 with several blocks; the test pins the matrices.

## Limits
- Text GREP: find/change on *text* already supports regular expressions (Find dialog); there is no InDesign GREP style/metacharacter dialect (`~m`, `^p`).
- A snippet keeps image asset hashes: images show only in documents that hold the asset. There is no shared object library on the server; snippets are files/text you keep yourself.
- Frame fitting cannot crop an image *node* (it is stretched to its box); cover/contain apply to image fills.
- QR above version 10, Kanji/numeric/alphanumeric modes and Micro QR are not implemented (byte mode always works).
- Gradient feather (soft edge fading along a gradient) is **not** implemented.
- Step and Repeat offsets are in the parent's units; rotated parents are not compensated.
