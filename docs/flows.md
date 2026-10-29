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
| `trigger` | `click` (default), `hover`, `drag`, `scroll`, `submit`, `auto`, `key`, `back` or free text. With `key` the `label` is the key to press. See "Gestures and overlays in the player" |
| `element_id` | optional: the node INSIDE `from` that triggers (the hotspot) |
| `guard` | condition under which the edge can be taken: free text ("cart not empty"), or a condition the player evaluates (`user=guest`, `count >= 3`, `else`; see "Variables, expressions and if / else in the player") |
| `effect` | what the edge changes: free text ("order created"), or assignments the player runs (`cart=full; count = count + 1`) |
| `order` | position in the hotspot's **if / else if / else chain** (1, 2, 3...; `0` = not in a chain, an independent branch). The player tries the chain in this order and the first guard that holds wins; see "Variables, expressions and if / else in the player" |

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
| `ambiguous` | two exits of the same screen have the same trigger and element and no `guard` telling them apart (or an identical `guard`), unless an `order` tells them apart; or two chain branches with the same `order` |
| `else_orphan` | a transition whose `guard` is `else` where no other transition shares its screen, trigger and element |
| `shadowed` | a branch of an ordered if / else if chain that can never fire (an earlier branch has no condition, or the same condition) |

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

## Variables, expressions and if / else in the player

The player (**Present**) keeps **variables** while you click through a flow. They are strings at rest; a transition's `effect` writes them and its `guard` reads them. Beyond the plain `k=v` forms (still meaning exactly what they did), both take **expressions** (`web/src/flow/expr.ts`, pure and tested; the model did not change: a guard and an effect are still text on the transition).

| In | You can write | Means |
|---|---|---|
| `effect` | `cart=full` | text: `cart` becomes `full` (a bare word, a number or a quoted string on the right is text, never a variable) |
| `effect` | `count = count + 1; total = total * 1.5` | arithmetic `+ - * / %`, parentheses, `"Hi " + name` (`+` joins text when an operand is not a number). Assignments run in order, so `a=1; b=a+1` sees the new `a`. A variable never set is `0` in arithmetic. A right side that cannot be computed (`name * 2`, `1 / 0`) leaves the variable alone |
| `guard` | `user=guest`, `user!=admin`, `paid`, `!paid` | as before |
| `guard` | `count >= 3`, `total <= 50 && total > 10`, `count + 1 > limit` | comparisons `== != = < <= > >=` (numbers compare as numbers: `3` equals `3.0`; two words compare as text), arithmetic, parentheses, `true` / `false` |
| `guard` | `user=admin \|\| count > 5` | `\|\|` between alternatives, `&&` inside each one |
| `guard` | `else` (or `otherwise`) | holds when **no other transition on the same screen, trigger and element** (hotspot) holds |

A guard with a term nobody can evaluate (`cart not empty`, `count >`, an unclosed parenthesis) makes the whole guard unevaluable: the option is disabled with the reason, never silently true. Variable names inside expressions are letters, digits, `_` and `.` (a name with `-` still works in the plain forms, not in arithmetic, where `a-1` is `a` minus 1).

**If / else if / else** is several transitions on the same hotspot with different guards, and an `else` transition for the rest:

```
Pay button  --[ total > 100 ]-------------------> Premium checkout
Pay button  --[ total > 50 && total <= 100 ]----> Standard checkout    (the "else if": a condition that does not overlap)
Pay button  --[ else ]--------------------------> Basic checkout
```

On a hotspot the branch that holds is the one that can be clicked; the branches that do not apply are not drawn as locked (they are simply the other side of the if), while a hotspot with nothing enabled still shows its lock and why.

**Ordered chains (`order`).** Conditions that do not overlap work, but the overlap is the natural way to write an else if (`total >= 100`, then `total >= 50`, then `else`). `Transition.order` (proto field 20, 0..1000) makes the order explicit: the transitions of one hotspot (the same flow, screen, trigger and element) with `order > 0` form a **chain**, evaluated by `order` (ties broken by id). The first one whose guard holds applies; a later one whose guard also holds gives way ("Not when total >= 100"), is not enabled and is not drawn as locked. Rules:

- the first branch is the `if`, the following ones the `else if`s; a branch with an empty guard always holds, so it works as the final `else` and shadows what comes after it;
- an `else` guard keeps its meaning (it holds when no other transition of the hotspot does) wherever it sits in the chain, so it is always the last resort;
- transitions with `order` 0 stay outside the chain and independent of each other, exactly as before (older documents behave the same);
- following a branch that gave way does nothing, and the winner's `effect` runs as usual.

The Flows panel has a **Chain** row in the transition editor: *Add to if / else chain* puts it at the end of its hotspot's chain, *Earlier* / *Later* swap it with its neighbour (the others are renumbered 1..n in the same undo step) and *Leave* takes it out. The MCP tool `set_transition` takes `order`; `get_flow` shows it. The analysis (panel, CLI, MCP `analyze_flows`) reports `else_orphan` (an `else` on a hotspot where no other transition shares the trigger and element: nothing to be the else of), `shadowed` (a chain branch that can never fire: an earlier one has no condition or the very same condition) and, as `ambiguous`, two branches with the same position. The spec, the generated tests and the exported code mention the position in their `guard` comments. Validation (a negative order or one above 1000 rejects the op) is tested from both sides in `testdata/golden/transition_order.json`.

A nested "if inside an action" would still need the transition to carry a list of actions instead of one `effect`; that was not done. The generated code and tests still treat `guard` and `effect` as comments (`// guard: ...`), exactly as before.

## Present: device frames and hotspot hints

**Present** shows the screen inside a device frame, chosen in the bottom bar (the **document's** default, or the person's own pick): **Generic** (the plain bezel it always had), **Phone** (rounded body, a dynamic-island pill and a home bar over the screen), **Tablet** (a thicker bezel with a camera), **Desktop** (a browser window: title bar with the three buttons and an address bar showing the screen's name) or **No frame**. The frame is presentation only: the prototype plays at the frame's own size and the geometry is computed by `web/src/flow/devices.ts`.

**Two levels.** The document carries a default (`DocSettings.present_device`, empty = generic), so a prototype opens in the frame its author meant for everyone who plays it. A person's own pick in the bar is remembered in this browser (`od.protoDevice`) and overrides the document's for them; *Reset* (shown when the pick differs from the document's) goes back to following the document, and *Make default* (shown when the frame on screen differs from the document's) writes it into the document as one undo step and drops the personal override. Over MCP: `set_document_settings { presentDevice }` (`generic`, `phone`, `tablet`, `desktop` or `none`; an unknown device is refused by the server) and `get_document` reports `presentDevice`. It is a document setting, not a per-flow one: all flows of a document open in the same frame unless a person chose another.

**Hotspot hints.** The clickable areas flash when a screen appears. Clicking anywhere else on the screen flashes them again ("where can I click?"), and **Show hotspots** in the bottom bar keeps them lit until turned off.

## Gestures and overlays in the player

- **`hover`**: a hotspot (the transition has an `element_id`) is followed when the pointer enters it.
- **`drag`**: followed when a press on the hotspot moves 24 px or more. With no `element_id` the drag works anywhere on the screen.
- **`scroll`**: followed by the mouse wheel over the hotspot, or anywhere on the screen when there is no `element_id`.
- A hover, drag or scroll transition with no element is also in the bottom bar as a button, and a hotspot of these triggers can still be activated from the keyboard (Enter / Space).
- **Overlays**: a transition whose `animation` is `overlay` opens `to_id` *over* the current screen, centred on it, with the screen dimmed. The screen under it stays (and in the path); while the overlay is open only its own exits apply, and a click outside it closes it. Taking an exit of the overlay leaves the overlay and goes to that exit's target. Back reopens the overlay it came from. The `effect` of the opening transition runs. `set_transition` takes `animation: "overlay"` and the Flows panel lists it as "Open as overlay".

- **Component state changes**: a transition with `animation: "set-variant"` makes the instance `element_id` (a component instance on the screen) show another variant: `to_id` is the master of that variant (a component's root node, from the component set). It never leaves the screen, adds no step to the path (Back is unaffected), and runs its `effect`. With the `hover` trigger the variant shows while the pointer is on the instance; with `press` while the button is down; with `click` (or anything else) it stays until the prototype restarts or Back goes to an earlier step. Because it is not a step of the journey, set-variant transitions are left out of the flow analysis (no unreachable or dead-end screens from the masters), and `element_id` is required. Only the variants are switched: property values and overrides of the instance stay.
