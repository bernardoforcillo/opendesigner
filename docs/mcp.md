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

Code: `internal/mcp/agent.go` (`RegisterAgentSurface`, installed next to `RegisterTools` in `http.go`).
