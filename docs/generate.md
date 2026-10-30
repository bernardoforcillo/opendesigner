# Generate screens from the document's own kit

Describe a screen (in words, or with a screenshot an agent can look at) and get a frame built ONLY from what the
document already has: its components, its color variables and its text styles. Nothing is invented, so the result
follows the design system and re-themes when a variable changes.

## How it works

opendesigner has no model of its own. The agent that is connected over MCP does the reading; the server guarantees
that what comes out is made of the kit.

1. `get_design_kit {}` lists what may be used: components (id, name, size, variant axes, properties), color variables
   (with their default-mode color as hex) and text styles (name, size, weight).
2. `generate_screen {name, width, height?, autoLayout?, fill?, nodes}` builds the screen. `nodes` is a FLAT list
   (a node names its parent by `ref`; parents come first), so the tool's schema is not recursive.

| `kind` | Fields | Built as |
|---|---|---|
| `frame` | `autoLayout`, `fill`, `width`, `height` | A frame. With an auto layout and no height it hugs its content. |
| `text` | `content`, `textStyle`, `color` | A text node that applies the text style and whose fill is bound to the color variable. |
| `rectangle` | `fill`, `width`, `height` | A rectangle with a bound fill. |
| `instance` | `component`, `variant`, `properties` | An instance of the component; variant and property values are validated like `set_instance_props`. |

Colors are only ever color variables (`fill`, `color`, by name or id). Each one becomes a solid paint with the
variable's current color and a `fills.0` binding, so it follows modes. Width defaults to the parent's inner width
(its width minus the auto layout padding).

### Refusal, not guessing

The whole spec is checked before the first node is created. A color variable, text style or component the document
does not have, a parent that is not an earlier frame, an unknown kind or bad instance properties come back as one
error that lists every problem and the names the document does have; nothing is created, so the agent corrects the
spec and calls again. An empty kit is not an error of the tool: the prompt tells the agent to say there is nothing to
build from and to ask.

The prompt `generate_screen {description, width?}` is the plan: kit, then map the description or screenshot to kit
parts, then `generate_screen`, then `review_design`, then report which kit parts were used and which parts the kit
could not cover.

## In the editor

Document menu, "Generate screen from the kit...": shows what the kit holds (counts of components, color variables
and text styles), takes the description and copies a ready prompt for the connected agent to the clipboard (it names
the MCP tools and carries the kit's names). The editor itself does not call a model: the screen appears when the
agent runs the prompt, and arrives through the normal sync like any agent edit.

## Limits

- No model runs in the server: "from text or screenshot" works through a connected agent. A screenshot is read by the
  agent's own vision; the tool never receives pixels.
- The build is a sequence of create operations, not one transaction. A failure after validation (a lost connection)
  leaves the part that was made; the error says how many nodes were created and the screen's id.
- Only color variables bind fills; borders, corner radii, effects and number variables are not part of the spec yet
  (use `bind_variable` and `set_properties` afterwards).
- At most 500 nodes per call.
- Code: `internal/mcp/generate.go`, tests in `internal/mcp/generate_test.go`; editor side `web/src/features/generate`.
