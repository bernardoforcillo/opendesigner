# Flows: from the drawing to the spec, the tests and the coverage

The flow graph you draw in the editor is not an illustration: it is the
**specification** of what the app must do. From it opendesigner derives, with no
other input:

- a **Markdown specification** to read or to hand to an AI agent;
- a generated **Playwright e2e suite**, one test per path;
- a **coverage report**: which screens exist in the code and which
  transitions are covered by a test;
- an **activity checklist** with the gaps, ready for the issue tracker.

Everything is computed by pure functions on the document (`internal/flow`), so
the same graph always yields the same bytes: it can be versioned, compared in a
PR and used as a CI gate.

> The editor has a dedicated view for drawing and linking screens; it is
> developed separately and is not described here. Everything that follows also
> works without it, from the CLI and from MCP tools.

## The model

- **Flow** (`Flow`): a user journey. It has `id`, `name`, `description` and
  an entry screen (`start_id`).
- **Screen**: an ordinary document node (usually a frame), referenced by id.
  It is not a copy: moving or renaming it does not break the flow.
- **Transition** (`Transition`): a `from -> to` edge inside a flow, with
  `label`, `trigger`, `element_id`, `guard` and `effect`.

Invariants guaranteed by the server: a transition belongs to an existing flow
and links existing nodes; deleting a flow deletes its transitions; deleting a
node deletes the transitions that pass through it, clears the `start_id` of the
flows that started from it and zeroes the `element_id` of whoever used it as a
hotspot.

### Transition fields

| Field | Meaning |
|---|---|
| `label` | text of the triggering element (e.g. the "Sign in" button) |
| `trigger` | `click` (default), `submit`, `auto`, `key`, `back` or free text. With `key` the `label` is the key to press |
| `element_id` | optional: the node INSIDE `from` that triggers (the hotspot) |
| `guard` | condition under which the edge can be taken, free text ("cart not empty") |
| `effect` | what the edge changes, free text ("order created") |

## Node metadata conventions

Every node has a free-form `meta` map (key -> value). The flow tools read these
keys; the model does not enforce them.

| Key | Values | Use |
|---|---|---|
| `flow.kind` | `screen` (default), `decision`, `action`, `start`, `end`, `note` | `end` terminates paths and is the only kind allowed without exits |
| `code.route` | e.g. `/login`, `/cart/:id`, `/p/[slug]` | route that realises the screen: `goto` and URL assertion in the tests, code search for the coverage |
| `code.component` | e.g. `LoginPage` | component that realises it: code search for the coverage |
| `test.id` | e.g. `go-login` | `data-testid` of an element: `getByTestId` locator |
| `test.text` | e.g. `Go to cart` | accessible text of an element: `getByText` locator |
| `status` | `planned` (default), `implemented`, `tested` | manual override of a screen's status |

`test.id` and `test.text` go on the node that is the `element_id` of a
transition. The parametric segments of routes (`:id`, `[id]`) become
`[^/]+` in the URL assertion.

## Analysis

`opendesigner flow check` (and the `AnalyzeFlows` RPC, and the `analyze_flows`
tool) report, with messages that name the screen:

| Kind | When |
|---|---|
| `empty` | the flow has no transitions |
| `no_start` | it has transitions but no start screen |
| `unreachable` | a screen is not reachable from the entry |
| `dead_end` | a reachable screen has no exits and is not `end` |
| `ambiguous` | two exits of the same screen have the same trigger and element and no `guard` telling them apart (or an identical `guard`) |

It also lists the **paths** from the entry to a final screen or to a cycle
(an edge that returns to a screen already in the path: the path stops there,
`loops=true`). Exits are visited by `(label, id)`. Cap: 200 paths and
depth 50, beyond which the report is `paths_truncated`.

## CLI

```
opendesigner flow <spec|tests|coverage|check|tasks> [-workspace DIR] [-doc ID-or-NAME]
                  [-flow ID] [-repo DIR] [-out FILE] [-format md|json] [-min PCT]
```

The document is opened **offline** from the workspace (the same as `serve`, by
default `~/.opendesigner`): no server is needed and the workspace is not
modified, so it can also be run while `serve` is running. `-doc` accepts the id
or the exact name and can be omitted if there is only one document.

| Command | What it does |
|---|---|
| `spec` | Markdown specification: screens, numbered transitions, Given/When/Then scenarios, problems |
| `tests` | `@playwright/test` TypeScript file with one `test()` per path |
| `coverage` | implemented screens and tested transitions in `-repo`; `-format json` for machines; `-min 80` exits with 1 below the threshold |
| `check` | prints the problems; **exits with 1 if there is at least one** |
| `tasks` | Markdown checklist of the gaps (screens to implement, transitions to test, graph problems) |

`-flow` restricts to one flow, `-out` writes to a file. Exit codes: 0 ok, 1
gate not passed (`check`, `coverage -min`), 2 usage or read error.

### How the coverage works

- A **transition is tested** if a source file in the repository contains
  `flow:<transition-id>`. The generated tests already emit it as a comment
  (`// flow:t1`) before every step.
- A **screen is implemented** if its `code.route` or its `code.component`
  appear in a non-generated, non-test source file (`*.spec.*`, `*.test.*`,
  `*_test.go`), or if `status` is `implemented` / `tested`. The route `/` alone
  appears everywhere, so it only counts as a quoted string (`"/"`).
- `node_modules`, `.git`, `dist`, `vendor`, `gen`, binary files, files over
  1 MiB and generated ones (`Code generated`, `DO NOT EDIT`, and the tests
  produced by `flow tests`, which cite routes and components without
  implementing them) are skipped.
- The total is `(implemented screens + tested transitions) / (screens +
  transitions)`; a screen shared between several flows counts once.

## MCP tools

An agent connected to `http://localhost:8080/mcp` (exposed by `opendesigner serve`) can drive the whole workflow.
The tool descriptions repeat the conventions, so one is enough to understand the
model.

| Tool | What it does |
|---|---|
| `list_flows` | lists the flows with entry and sizes |
| `get_flow` | one flow with screens (name, kind, route, component, status) and transitions |
| `create_flow` | creates a flow, optionally with the start screen |
| `delete_flow` | deletes the flow and its transitions (the screens stay) |
| `set_transition` | creates (without `id`) or updates (with `id`) an edge; on update the omitted fields stay |
| `delete_transition` | deletes an edge |
| `set_node_meta` | merges keys into a node's `meta` (`unset` to remove some); validates `flow.kind` and `status` |
| `analyze_flows` | problems and paths, one or all flows |
| `get_flow_spec` | the Markdown specification, to use as a requirement |

`set_node_meta` does a read-modify-write: `SetProperties`' `meta` field replaces
the whole map, so the tool reads the current one, merges and rewrites. `get_document`
and `list_nodes` now also expose `meta`.

A typical agent loop: `get_flow_spec` to read what to build, build the
screens, `set_node_meta` to write `code.route` and `code.component`, `analyze_flows`
to verify the graph, then `opendesigner flow tests` and `coverage` to close the loop.

## CI recipe

```yaml
- name: The flow graph is consistent
  run: opendesigner flow check -workspace ./design -doc "Shop"

- name: Regenerate the e2e tests from the design
  run: opendesigner flow tests -workspace ./design -doc "Shop" -out e2e/flows.generated.spec.ts

- name: Run the e2e tests
  run: npx playwright test

- name: Flow coverage
  run: opendesigner flow coverage -workspace ./design -doc "Shop" -repo . -min 80
```

The generated file carries the notice "Generated by opendesigner" at the top: it
must not be edited by hand. Steps that cannot be resolved (`code.route` missing
on the start screen, no `test.id`/`test.text`/label to find the trigger)
become `// TODO` and the test is marked `test.fixme`, so the suite does not
fail but the debt is visible. For hand-written tests it is enough to annotate
every step with `// flow:<id>` for the coverage to count them.

## Example

A "Purchase" flow: Home -> Login -> Cart -> Payment -> Thanks.

1. In the editor (or with `create_flow` / `set_transition`) the screens are
   linked. Home's "Sign in" button has `test.id = go-login` and is
   the `element_id` of the `t-login` transition.
2. On the screens: Home `code.route=/`, Login `code.route=/login`, Cart
   `code.route=/cart/:id`, Thanks `flow.kind=end` and `code.route=/thanks`.
3. `opendesigner flow check -doc Shop` prints `OK: 1 flows without problems`.
4. `opendesigner flow tests -doc Shop -out e2e/flows.spec.ts` produces, for each
   path:

   ```ts
   test("path 1: Home → Login → Cart → Payment → Thanks", async ({ page }) => {
     await page.goto("/");

     // flow:t-login
     // Home -> Login
     await page.getByTestId("go-login").click();
     await expect(page).toHaveURL(new RegExp("^[a-z]+://[^/]+/login/?(?:[?#].*)?$"));
     ...
   });
   ```

5. `opendesigner flow coverage -doc Shop -repo . -min 80` says which screens
   are missing in the code and which edges have no test; `opendesigner flow tasks -doc
   Shop` turns that into a checklist to paste into an issue.

## Transition animations in the player

A transition can animate how the player (**Present**) goes from its source screen to its destination:

| Field | Meaning |
|---|---|
| `animation` | `""` (a cut), `dissolve`, `slide-left` / `slide-right` / `slide-up` / `slide-down` (the new screen comes in over the old one, from the right / left / bottom / top), `push-left|right|up|down` (both move), `smart` |
| `duration_ms` | 0..10000; 0 means the default, 300 ms |
| `easing` | the animation grammar: `linear`, `easeIn`, `easeOut`, `easeInOut` (default), `spring` or `cubic-bezier(x1,y1,x2,y2)` |
| `delay_ms` | for `trigger: auto`: the player follows the transition by itself after this long on the screen (0..60000) |

**Smart animate** matches nodes of the two screens by name along the same path (`card` inside `A` with `card` inside `B`; several nodes with the same name match in order). Matched nodes move, resize, turn, fade and change fill color from the source's values to the destination's; nodes only in the destination fade in and nodes only in the source fade out in place.

The values are validated by the core (an unknown animation, a duration or delay out of range or a bad easing rejects the op; golden fixture `testdata/golden/transition_anim.json`). They are edited in the Flows panel (transition editor) or with the MCP tool `set_transition` (`animation`, `durationMs`, `easing`, `delayMs`). Exported code does not animate screen changes.
