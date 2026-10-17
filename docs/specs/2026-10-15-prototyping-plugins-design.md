# Prototyping interactions and the plugin platform: design spec

Date: 2026-10-15. Status: draft for review. No product code is part of this document.

Source of scope: `docs/roadmap.md`, section 1 ("Prototyping: hover and drag interactions, overlays, scroll, component state changes in the player") and section 3 ("Plugin API"), whose basic version is already checked off. This spec covers only what is still open in those two items. The two parts are independent: they share no code, no proto messages and no task. Either can ship first.

- Part A: Prototyping and presentation (interactions, overlays, scroll, state changes, present view).
- Part B: Plugin platform (sandbox hardening, API surface, distribution).

---

# Part A: Prototyping and presentation

## A1. Goal

Make the Present view able to play the interactions a real prototype needs, not only "click a hotspot, go to another screen": hover and drag triggers, overlays (modals, menus, toasts), scrollable regions, and component variant changes in place. Keep the flow graph as the single source of truth, so the same data still drives `flow spec`, `flow tests` and `flow coverage` (`docs/flows.md`).

Non-goals: a full expression language, video/audio, device frames beyond the existing bezel, exporting interactions to generated code (codegen does not animate screen changes today either, `docs/flows.md`).

## A2. Current state

- Model: `Flow` and `Transition` in `proto/opendesigner/v1/opendesigner.proto` (around lines 569-607). A `Transition` has `trigger` (free text: click, submit, auto, key, back), `element_id` (hotspot), `guard`, `effect`, `animation`, `duration_ms`, `easing`, `delay_ms`. Validation lives in `internal/core/flows.go` (`applySetTransition`, closed set `TransitionAnimations`, range checks on timing) and is mirrored in `web/src/store/applyOp.ts` (Go is the authority).
- The player: `web/src/ui/PrototypePlayer.tsx` (410 lines). It draws one screen at a time through `sceneForScreen` (`web/src/flow/protoScene.ts`, which re-parents the screen under a fake page), builds hotspots from transitions that have `elementId`, puts the others in a bottom bar, and follows `auto` transitions after `delayMs`.
- Pure logic: `web/src/flow/prototype.ts`. State is `{screenId, vars, history}`. Variables are strings written by `effect` (`k=v; k2=v2`) and read by `guard` (`&&`, `=`, `!=`, truthy, `!`). An unparseable guard disables the transition with a reason, deliberately.
- Screen-to-screen animation: `web/src/flow/transitionAnim.ts` and `web/src/ui/protoAnim.ts` (dissolve, slide, push, smart animate by name path).
- Per-node animation clips already have `enter`, `loop`, `hover`, `tap` triggers (`web/src/animation/runtime.ts`, `pointerClipsForScreen`). So hover/tap exist for clips, but a hover cannot navigate or change state.
- MCP: `internal/mcp/flows.go` (`list_flows`, `get_flow`, `set_transition`, `analyze_flows`, `get_flow_spec`). Analysis and path generation: `internal/flow/analyze.go`, `internal/flow/playwright.go`.
- Gaps matching the roadmap: no hover/drag/scroll triggers; no overlays (a screen can only replace the previous one); no scrollable frames (the proto has no scroll field); instance variants cannot be switched by a transition although `InstanceNode.variant_props` and `ComponentSet` exist (proto lines ~370-430).

## A3. Data-model and op changes

All changes are additive and backward compatible (proto3 defaults mean old documents keep playing as before). New fields are validated in `internal/core/flows.go` and mirrored in `applyOp.ts`; golden fixtures under `testdata/golden/` get new cases (as `transition_anim.json` did).

1. Triggers become a documented set while still allowing free text for specs. Add `hover` and `drag` to the playable list (`core.PlayableTriggers`) and a new `trigger_arg` string field (drag direction, key name for `key`) instead of overloading `label`.
2. New transition `action` (string, default `navigate`): `navigate` (today's behaviour), `overlay-open`, `overlay-close`, `set-variant`, `back`. `to_id` stays meaningful: for `overlay-open` it is the overlay screen; for `set-variant` the target is `action_node_id`.
3. Overlay options on the transition (new message `OverlayOptions`, embedded as a field): `position` (`center`, `top`, `bottom`, `at-element`), `backdrop` (`none`, `dim`), `close_on_outside_click` (bool). Read only when `action = overlay-open`.
4. Variant change: `action_node_id` (the instance) and `variant_props` map (axis -> option), same shape as `InstanceNode.variant_props`. Validation: the node is an instance and the options exist on the component set.
5. Scroll: a new frame property `scroll` on the frame node (`none` default, `vertical`, `horizontal`, `both`), with content bounds derived from children and no stored offset. Offsets are player runtime state only, never ops.
6. Analysis (`internal/flow/analyze.go`): `overlay-open` edges count for reachability and `overlay-close` edges are exits (an overlay with no close path is a new `FlowIssue` kind `overlay_trap`). `set-variant` edges stay on the same screen, so they create no paths; `playwright.go` emits a comment, not a step, for them (documented limitation).

No new top-level op kind is required: everything rides on `SetTransition` (op 23) and the existing node property ops, plus one new `scroll` entry in the property field mask. This keeps `pack`/`unpack`, undo and merge working, except that `internal/merge/definitions.go` must learn the new transition fields so they are not dropped.

## A4. UI and MCP impact

Editor (`web/src/ui/FlowPanel.tsx`, `web/src/ui/ds/flow-parts.tsx`):
- The transition editor gains Action, Trigger (with arg), Overlay options and Variant picker sections, shown by action.
- The frame panel gains a Scroll select.

Player (`PrototypePlayer.tsx`, `flow/prototype.ts`):
- State becomes `{screenId, overlays: string[], vars, history}`; `follow` returns the new state and the logic stays pure in `prototype.ts` (testable without a DOM). `back` pops the topmost overlay first.
- Overlays render by drawing the base screen and then each overlay screen through the existing `drawScene` (a second `sceneForScreen` pass), with the dim backdrop drawn by the player.
- Scrollable frames: wheel/drag adjust a per-frame offset held in player state; hotspot hit-testing subtracts it.
- Hover/drag: reuse the pointer plumbing from `useProtoAnimation` (`protoAnim.ts`). A hover transition fires on enter after a small intent delay (default 100 ms) and pushes history only if it navigates.
- Present view polish (the "presentation" half of the item): a clean fullscreen mode (a key hides the chrome), keyboard navigation (arrows follow the only enabled transition, otherwise show the choices), and a read-only link that opens straight into Present (reuses the `?page=` nuqs param and the share-link roles in `internal/server/access.go`; a `view` role may present).

MCP (`internal/mcp/flows.go`): extend `set_transition` input with `action`, `triggerArg`, `overlay`, `actionNodeId`, `variantProps`; extend `get_flow` / `get_flow_spec` output and the Markdown spec (`internal/flow/spec.go`) so an agent sees overlays and state changes as scenarios. Fold `scroll` into the existing frame property tool rather than adding a new one.

## A5. Approaches

### Approach 1 (recommended): extend the transition model, keep one graph

Everything is a `Transition` with an `action`. One graph, one analysis, one spec, one set of CLI commands.

Pros: no new entity to sync, merge, pack or undo; MCP and CLI extend by fields; existing flows are unaffected; the spec/tests/coverage pipeline (the project's differentiator) keeps working. Cons: `Transition` grows into a wide struct and per-action validity rules multiply (mitigate with a single `validateAction` in core); `set-variant` is not a graph edge, so analysis has a deliberate blind spot.

### Approach 2: an interaction layer on nodes (Figma-style reactions)

Each node carries a list of reactions (`trigger -> action`); the flow graph is derived from them.

Pros: matches how designers think ("this button does X"), supports many interactions per element without a flow, and component-level interactions would travel with instances. Cons: a second source of truth next to flows (or a migration of all existing transitions); a big change to analysis, spec generation, coverage (which keys on transition ids, `flow:<id>`), codegen and merge; a much larger blast radius for the same player features.

Recommendation: Approach 1. It delivers the roadmap items with additive fields and keeps flows as the spec. Revisit reactions only if per-element authoring proves to be the real bottleneck.

## A6. Testing plan

- Core (Go): table tests in `internal/core/flows_test.go` for every new validation (bad action, overlay target missing, variant axis/option mismatch, drag without arg); golden JSON fixtures in `testdata/golden/`, run on both the Go and TS appliers.
- Pure logic (vitest): `flow/prototype.test.ts` for overlay stack semantics (open, close, back pops overlay first, overlay inside overlay), variant state change, guards combined with the new actions.
- Player: `PrototypePlayer.test.tsx` additions (jsdom) for hotspot hit-testing under a scroll offset and backdrop clicks; extend `PrototypePlayer.anim.test.tsx` for hover-triggered navigation.
- Analysis: `internal/flow/flow_test.go` cases for `overlay_trap`, reachability through overlays, and unchanged path generation for old flows (existing golden files in `internal/flow/testdata`).
- MCP: `internal/mcp/flows_test.go` for the extended `set_transition` and the spec output.
- Performance guard: the 20,000-node bench (`docs/performance.md`) must not regress; overlays add one scene pass only while open.
- Manual: run Present on the shop sample (`internal/codegen/samples/shop.go`) with a new overlay and a hover state.

## A7. Ordered tasks

1. Proto: add `action`, `trigger_arg`, `OverlayOptions`, `action_node_id`, `variant_props` on `Transition`, and `scroll` on the frame; regenerate; update `internal/merge/definitions.go` and `internal/pack`.
2. Core: validation in `internal/core/flows.go` and mirrored `applyOp.ts`; golden fixtures; tests.
3. Pure player logic: overlay stack and variant state in `flow/prototype.ts` plus tests (no UI yet).
4. Analysis and spec: `overlay_trap`, overlay reachability, spec text, Playwright comment for `set-variant`.
5. Player: overlay rendering and backdrop; fullscreen/keyboard polish.
6. Player: hover and drag triggers on the existing pointer plumbing.
7. Player and frame property: scroll frames.
8. Editor UI: transition editor sections, frame Scroll select.
9. MCP tools and `docs/flows.md` update; tick roadmap items one by one.
10. Present share link (a read-only role opens in Present).

Tasks 1-4 are shippable as "data and agents only"; 5-8 ship the visible features incrementally (overlays first).

## A8. Open questions (Part A)

- Should interactions live on the transition (recommended) or on nodes (reactions)? Is per-element authoring a real need for the target users?
- Variant changes on hover/press (button states) are the most common prototype feature. Should component-level variant interactions, defined once on the component, be in this scope?
- Is a stored scroll offset ever needed (for example "start scrolled"), or is player-only state enough?
- Should the `view` share role be allowed to enter Present, and should Present be reachable without the editor bundle (a standalone export)?

---

# Part B: Plugin platform

## B1. Goal

Turn the current "paste a JSON script, run it once" feature into a platform people can rely on: a sandbox that contains hostile or buggy code, an API broad enough to build useful tools (layout, rename, tokens, import/export, UI), and a way to distribute and update plugins safely. Local-first stays: no mandatory marketplace server.

Non-goals: a hosted marketplace with accounts (the product has no accounts), running plugins on the server, native or Node plugins.

## B2. Current state

- Manifest and storage: `web/src/plugins/manifest.ts`. A plugin is JSON `{name, version, description, permissions: ["read"|"write"], code}`; `code` is capped at 200,000 bytes; stored in `localStorage` under `od.plugins`, not in the document, with no integrity or origin recorded. Installed through `web/src/ui/PluginsDialog.tsx` (document menu, "Plugins...").
- Sandbox: `web/src/plugins/run.ts`. A hidden `<iframe sandbox="allow-scripts">` with `srcdoc`, CSP `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'` set by a meta tag inside the srcdoc. Communication is `postMessage` with `"*"` and a `Proxy` named `od`. The host accepts messages only when `e.source === frame.window`. The 15 s timeout (`PLUGIN_TIMEOUT_MS`) is a host `setTimeout`, after which the frame is removed.
- API: `web/src/plugins/api.ts` (`PluginSession`). Read: `selection`, `getNode`, `listNodes`, `page`. Write: `createRect/Ellipse/Frame/Text`, `setProps` (x, y, width, height, rotation, opacity, name, visible, fill), `deleteNode`, `select`. Always: `notify`. Every argument is validated; all writes are ops inside one gesture (`beginGesture`/`endGesture`/`cancelGesture`), so one undo step and nothing kept on failure.
- Tests: `web/src/plugins/api.test.ts`, `web/src/ui/PluginsDialog.test.tsx`.
- Docs: the "Plugins" section of `docs/handoff.md`, which already says "Only install plugins you trust".
- Absent: plugin UI (panels/forms), command invocation from the menu or shortcuts, a storage API, any network access, access to variables/components/flows/comments/fonts, API versioning, signing, a per-update permission prompt, and anything server-side (nothing in `internal` or `cmd` mentions plugins).

## B3. Data-model and op changes

Plugins stay client-side, so the document model barely changes.

1. Manifest v2 (client only, `manifest.ts`): add `apiVersion` (integer, required for new plugins), extended `permissions` (see B4), `network` (allowed hosts, empty by default), `commands` (named entry points `{id, title, run}`), optional `ui` descriptor, `source` (`{kind: "file"|"url"|"bundle", url?, sha256}`), `author` and `homepage`. Old v1 plugins load as `apiVersion: 1` with their original two permissions and unchanged behaviour.
2. Plugin data, two scopes chosen by permission: `storage:local` (browser, per person, `localStorage` namespaced by plugin id) and `storage:document` (in the document, so it travels with it and with collaborators). Document scope needs a proto change: `Node.meta` already exists as a free-form map (used by the flow tools, `docs/flows.md`), so use namespaced keys `plugin.<id>.<key>` on a node, plus a new document-level `plugin_data` map<string,string> for non-node data. Writes go through a new op `SetPluginData{plugin_id, key, value}` (absolute upsert, same inverse rules as other upserts in `internal/core`), size-capped (for example 64 KiB per plugin), validated in core and mirrored in `applyOp.ts`, with a golden fixture.
3. No op for installing plugins (a plugin is not document content). A document may recommend plugins (a `recommended_plugins` list of `{name, source, sha256}`) as a banner; it never installs or runs anything by itself.

## B4. API surface, UI and MCP impact

Permissions (all opt-in, shown at install and again when an update adds one):
- `read`, `write` (as today).
- `read:variables`, `write:variables` (collections, modes, binding), `read:components`, `read:flows`, `write:flows` (reusing the flow validation), `read:comments`.
- `selection:events` (subscribe to selection and document changes with a throttled `od.on`).
- `export` (`od.exportNode(id, format)` through the existing export code, size-capped).
- `storage:local`, `storage:document`.
- `network:<host>` (fetch performed by the host, only to declared hosts; see B6).
- `ui` (open a plugin panel).

Plugin UI: two tiers. (a) Declarative forms (inputs described as JSON and rendered by the host, so no plugin DOM at all) as the default, which keeps accessibility and theming in the host. (b) For the `ui` permission, a second sandboxed iframe (`sandbox="allow-scripts"`, no same-origin) mounted in a right-panel tab, talking over the same bridge.

Commands: `commands` appear in a command menu and can be bound to a shortcut.

MCP: deliberately small. Plugins are client-side, so no `run_plugin` tool; agents edit through the MCP tools directly. Plugin-written `plugin.*` meta keys already surface in `get_document` / `list_nodes` through `meta`.

API versioning: `od.apiVersion`, additive changes within a major version, a documented deprecation window, and CI that runs a fixture plugin per past `apiVersion`.

Distribution:
- File install (today), install from URL (fetched by the host, showing the sha256 and permissions before confirm) and an `.odplugin` bundle (zip with `manifest.json`, `main.js`, assets) so plugins can be more than one file. The content hash is pinned at install; an update with a different hash re-prompts; no silent auto-update.
- An optional, self-hostable static registry: a JSON index (name, versions, url, sha256, permissions, signature) that `opendesigner serve` can serve from its workspace (`~/.opendesigner/plugins/`), so a small team shares plugins on the LAN with no cloud. The server only serves files; it never executes them.
- CLI for authors: `opendesigner plugin pack|verify` (validates the manifest, computes the hash). Optional detached Ed25519 signatures; a verified-publisher UI is a later step.

## B5. Approaches

### Approach 1 (recommended): harden the current iframe, run code in a Worker, grow the API behind permissions

Keep the architecture that exists (sandboxed iframe, postMessage, validated `PluginSession`) and make two structural fixes: run plugin code in a Web Worker created inside the sandboxed iframe, so a `while(true)` cannot freeze the editor and a timeout can `terminate()` for real; and move the bridge to a `MessageChannel`. Then grow permissions, storage, UI and distribution on top.

Pros: smallest change, keeps the audited validation layer and the one-undo-step semantics, no new dependency, ships incrementally. Cons: still relies on browser sandboxing; `unsafe-eval` stays in the CSP (needed by `AsyncFunction`); a determined plugin can still burn CPU in its worker until the timeout.

### Approach 2: a JS interpreter in WebAssembly (QuickJS)

Run plugin code in a QuickJS-in-Wasm VM inside a worker; the plugin sees only the objects the host injects.

Pros: strongest isolation (no DOM, no `fetch`, no host globals, deterministic memory and instruction limits, interruptible without killing a thread); removes `unsafe-eval` from the CSP. Cons: a new dependency and bundle size (hundreds of KB), a different debugging story, no browser APIs for plugin authors unless re-bridged (plugin UI would still need an iframe), slower for heavy loops, and more engineering before any user-visible feature.

Recommendation: Approach 1 now, keeping the bridge engine-agnostic (`PluginSession.call` is already transport-neutral) so QuickJS can replace the worker later without touching the API. Choose Approach 2 up front only if plugins will come from untrusted public sources at scale (open question).

## B6. Security notes

Threat model: a plugin is untrusted third-party code; the user owns the document; collaborators receive whatever ops the plugin writes. The document, the clipboard, other documents, the admin token and the MCP endpoint must stay out of reach.

Already right (`run.ts`, `api.ts`): an opaque origin (no `allow-same-origin`), no top navigation or popups, CSP `default-src 'none'` blocks fetch/XHR/WebSocket/img, an `e.source` check on host messages, every argument validated, all writes are ordinary ops in one gesture (a failed run leaves nothing), a 15 s timeout, a 200 KB code cap.

Gaps to close (each maps to a task in B8):
1. CPU denial of service: a synchronous infinite loop in an iframe that shares the renderer process can freeze the editor tab, and the timeout lives on the host's event loop, so it may never fire. Fix: run in a Worker and `terminate()` on timeout.
2. Window messaging: the host posts to the frame with `"*"` (unavoidable with an opaque origin). Use a per-run `MessageChannel` port so no other frame or injected script can speak to a session, and never send secrets over it.
3. The CSP is a `<meta>` inside `srcdoc`, which is weaker than a header and cannot express `sandbox`, `frame-ancestors` or `form-action` well. Serve the sandbox page from the server (a route in `internal/server/webui.go`) with a real `Content-Security-Policy` header including `connect-src 'none'`, `frame-src 'none'`, `form-action 'none'`, `base-uri 'none'`; keep a `srcdoc` fallback for dev.
4. Side channels that `default-src` does not cover: DNS prefetch and `preconnect` need a DOM, which a worker does not have (another reason for the Worker); WebRTC must be verified per supported browser.
5. Resource exhaustion in the API: today a plugin can create unlimited nodes inside 15 s and ship one huge gesture to the server and every peer. Cap ops per run (for example 10,000), nodes created, and notify rate; field sizes are already capped.
6. Network permission: never give the plugin `fetch`. The host performs requests only to declared `network:<host>` entries, refuses redirects to other hosts, strips credentials, caps response size and rate, and blocks private ranges (localhost, RFC1918, link-local, cloud metadata) to prevent SSRF against the user's own `serve` and MCP endpoints. Show the host list at install.
7. Supply chain: URL installs pin a sha256 and re-prompt on change; no auto-update; the registry is data only; signatures are verified before the dialog says "verified".
8. Social engineering: the permission dialog states consequences in plain words ("can change or delete any layer; you can undo it"). No document banner, link or deep link may install or run a `write` plugin.
9. Collaboration: ops are attributed to the person who ran the plugin. Share-link roles `view` and `comment` (`internal/server/access.go`) must disable the write APIs on the client too, so the user gets a clear message instead of a server rejection.
10. Storage: document-scoped plugin data is shared with collaborators, so the permission text must say not to store secrets there.

## B7. Testing plan

- Unit (vitest): extend `plugins/api.test.ts` for each new method and permission (allowed, denied, bad arguments, size caps, op-count cap); manifest parsing for v1 and v2 (old plugins still load), sha256 pinning, update re-prompt logic.
- Sandbox (`run.ts`) with a test `Frame`: timeouts, abort leaves no ops, and a malicious script cannot reach `parent.document`, `localStorage`, `fetch`, `XMLHttpRequest`, `WebSocket`, URL `import()`, `navigator.sendBeacon`, or navigate the top window. Add a Playwright e2e in a real browser covering those and the infinite-loop case, asserting the editor stays responsive.
- Network proxy: tests for the host allowlist, redirect refusal, private-range blocking, size cap, no credentials.
- Core: `SetPluginData` validation and size cap with golden fixtures on both appliers; merge keeps `plugin.*` keys.
- Compatibility: a fixture plugin per `apiVersion` in CI.
- Server: the sandbox route returns the CSP header; a `view`-role link cannot apply plugin writes.
- Manual: install from a URL whose hash changed and confirm the re-prompt; build a bundle with `opendesigner plugin pack` and install it.

## B8. Ordered tasks

1. Security first, no API change: run plugin code in a Worker with `terminate()`, a per-run `MessageChannel`, and op-count and node-count caps; tests for the infinite loop and the escape attempts. Ships alone as a hardening release.
2. Serve the sandbox page with a real CSP header from `internal/server/webui.go`; keep the `srcdoc` fallback.
3. Client-side enforcement of share-link roles for plugin writes.
4. Manifest v2 (`apiVersion`, `commands`, `source`, hash) with v1 compatibility; rewrite the permission dialog in plain language.
5. `storage:local`, then the `SetPluginData` op and `storage:document` (proto, core, `applyOp.ts`, golden, merge).
6. API expansion by permission group: variables, components, flows, comments, export, selection events (one PR each, each with tests).
7. Declarative plugin UI and commands in a command menu.
8. Install from URL and `.odplugin` bundle with sha256 pinning; `opendesigner plugin pack|verify`.
9. Network permission through the host proxy, after a security review of B6.6.
10. Optional self-hosted registry index and signatures; iframe UI panels (`ui` permission) last.
11. Docs: a new `docs/plugins.md` (move the section out of `docs/handoff.md`) and the roadmap updated item by item.

Tasks 1-3 are independent of everything else and should ship first.

## B9. Open questions (Part B)

- Who is the plugin audience: the user's own scripts and a trusted team (Approach 1 is enough), or strangers' plugins from a public registry (leans to QuickJS and signatures)? This sets the whole security budget.
- Should document-scoped plugin data exist at all, given there are no accounts and it is shared with every collaborator?
- Is the network permission worth the SSRF and abuse surface, or should plugins that need the network wait for a relay (roadmap, section 2)?
- Should agents (MCP) be able to trigger plugin commands? That would cross the client/server boundary the design currently keeps clean.

---

# Cross-cutting

- Sequencing: Part B tasks 1-3 (hardening) are the cheapest high-value work and have no dependencies; Part A tasks 1-4 are next (additive model plus agent visibility). The rest can be interleaved freely.
- Both parts add proto fields: regenerate once per part, update `internal/pack` and `internal/merge/definitions.go`, and add golden fixtures so the Go and TypeScript appliers stay identical.
- Docs: `docs/flows.md` (Part A), a new `docs/plugins.md` (Part B), and the roadmap checkboxes, each updated in the same PR as the feature.
