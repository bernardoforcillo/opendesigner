# MCP: the agent surface

opendesigner's MCP server (`serve` exposes it at `/mcp`, see the readme) has three layers. The design follows
FigCraft's MCP server: a few general tools, resources to read, and prompts to start from.

## Tools

About 180 specific tools (`create_frame`, `set_properties`, `create_flow`, `export_pdf`, `preflight`, ...; each one's
description says what it does and what to do next), and three general ones that need no knowledge of the rest:

| Tool | What it does |
|---|---|
| `create_node {type, x?, y?, width?, height?, parentId?, name?, text?, fontSize?, clipsContent?, autoLayout?}` | A rectangle, an ellipse, a frame or a text in one call (`type`). A text needs `text`. Returns the node id; set the rest with `set_properties`. |
| `get_node {id}` | One node as it is now. An unknown id is a tool error. |
| `inspect_document {}` | The whole document: pages, components, styles and every node (the same as `get_document`). |

### Review tools

- `review_design`: contrast, tap targets and unbound tokens (docs/handoff.md).
- `review_consistency`: the same thing said two ways. Rules `near-color` (literal colors within 4/255 per channel of a commoner one), `near-size` (a font size one step from a commoner one), `near-radius` (a corner radius within 2 of a commoner one) and `unstyled` (text with no text style in a document that has text styles). Suggestions (`warn`), not failures; values bound to a variable or a style are left out.
- `token_usage`: every variable and text, paint and effect style with its number of uses, the unused ones, and `candidates`: colors written by value three or more times that no color variable has.

Code: `internal/review/consistency.go`.

## Resources

Read rather than called (`resources/read`):

| URI | Content |
|---|---|
| `opendesigner://document` | The open document, like `inspect_document`. |
| `opendesigner://comments` | Every open comment thread on every page. |
| `opendesigner://node/{id}` (template) | One node. An unknown id is "resource not found". |

## Prompts

Each returns a step-by-step plan that names the exact tools to use and how to check the result. A test
(`TestPromptsNameRealTools`) fails if a plan names a tool that is not registered.

| Prompt | Arguments |
|---|---|
| `mobile_screen` | `screen` (required), `device` (default iPhone 16), `brand_color` |
| `design_system` | `name`, `primary` |
| `landing_page` | `product` (required), `width` (default 1440), `accent` |
| `prototype_flow` | `screens` (comma separated), `transition` |
| `fix_comments` | `page` (default all), `auto_resolve` (yes or no, default yes), `author` (default AI) |
| `watch_comments` | `minutes` (default 5) |
| `consistency_review` | `fix` (yes or no, default yes): `review_design`, `review_consistency` and `token_usage`, then tidy up the odd values |
| `design_variants` | `node` (required), `count` (default 3, up to 8), `vary` (color, layout, type or all): alternative copies of a frame laid out in a row, checked with `review_design` |
| `token_cleanup` | none: turn repeated literal colors into variables, report unused tokens |

Code: `internal/mcp/agent.go` (`RegisterAgentSurface`, installed next to `RegisterTools` in `http.go`).
