# Diagrams, agent tools, git bundle, persistent scene: design

Date: 2026-10-15. Status: draft for review. No product code in this document.

Source: the open items of `docs/roadmap.md` (sections 1, 4 and 5). Four parts, each
shippable on its own and in any order, except where noted.

| Part | Roadmap item | Ships alone |
|---|---|---|
| A | Diagrams: edges that follow shapes, `subgraph`, ER, notes in class/state | yes |
| B | MCP agent: consistency reviews, variants, token usage | yes |
| C | Git-versionable bundle with readable diffs | yes |
| D | Persistent data structures for the scene | yes |

A note on the roadmap itself: three of these lines overstate what is missing.
Whiteboard connectors are done (`docs/whiteboard.md`), but diagram edges still do
not use them; `PMap` already makes the client node map persistent (`web/src/store/nodeMap.ts`);
`pack`/`unpack` already exist (`internal/pack/pack.go`). Each part below states the
real remaining gap. `docs/performance.md` also contradicts itself (its "Known limits"
section still says `applyOp` copies the whole map, the section above it says it does
not); task D0 fixes that.

---

## Part A. Diagrams that behave like the rest of the document

### A.1 Goal

A diagram stops being a picture made of ordinary shapes and arrows that fall apart when
touched. After this part: moving a box in a flowchart/state/class/ER diagram moves its
edges; flowcharts can group nodes in `subgraph`s; `erDiagram` is drawn; class and state
diagrams read `note`. All of it still comes from Mermaid text, computed by the server,
identical in the editor and over MCP.

### A.2 Current state

- `internal/diagram/build.go::line` turns every edge into one **plain vector** plus a
  separate `Tip` polygon per arrowhead. Nothing records which boxes the edge joins.
  `docs/diagrams.md` "Known limits" says so: "arrows are not attached to the shapes".
- Connectors exist for the whiteboard: a vector with `meta` `connector.from/to/route/head`,
  its path **derived** in the client (`web/src/store/connectors.ts`, geometry in
  `web/src/vector/connector.ts`, found via `store/tagged.ts`). Only `straight`/`elbow`
  routes and `none/end/both` heads. There is no Go counterpart: code export and `pack`
  see the stored path (`docs/whiteboard.md`).
- Layout is `internal/diagram/layered.go` (flat layered layout), shared by flowchart and
  state (`state.go` returns a `flowchart`); class has `class.go`. Edges there are routed
  polylines, with labels as separate text nodes.
- `flowchart.go:59` (`flowIgnored`) skips `subgraph`/`end`; `state.go` flattens composite
  states; `class.go:124` skips `note`; `state.go:56-66` skips note blocks;
  `diagram.go:52` lists `erDiagram` as unsupported.
- The root group stores `diagram.kind` and `diagram.source` in `meta`; `update_diagram`
  redraws from it and replaces the whole group (so manual edits are lost, by design).

### A.3 Data-model and op changes

No new node kind and no proto change: everything is nodes plus `meta`, consistent with
"a diagram is a group of ordinary layers".

1. **Edge as connector.** A diagram edge is a vector node carrying
   `connector.from`/`connector.to` (ids of the two shape nodes). `Scene`/`Box` get a
   stable symbolic key (`Box.Key`) and `Line` gets `From`/`To` keys; `build.go` maps keys
   to the uuids it mints. New optional meta, all backward compatible (absent = today):
   - `connector.route`: add `routed` (keep the stored waypoints) next to `straight|elbow`.
   - `connector.start` / `connector.end`: head kind, one of `none|arrow|open|triangle|
     diamond|diamondFilled|cross|one|zeroOne|many|zeroMany|oneMany` (the last five are
     ER crow's-foot marks). `connector.head` stays and is read when these are absent.
   - `connector.dash`: `dashed` (today the server fakes it with many short subpaths).
   - `connector.at`: a short hash of the two end boxes (in the connector's parent space)
     at draw time.
   - `connector.label`: id of the label text node.
2. **Derivation rule.** In `deriveConnectors`, if `connector.route=routed` and the
   current boxes hash to `connector.at`, return the stored path untouched (the layered
   layout's route survives at rest, identical to the server's output). If either end
   moved, recompute as `elbow` from the current boxes, keeping heads and dash, and move
   the label to the new path midpoint. So a diagram looks exactly as before until the
   user moves something.
3. **Heads in TS.** `connectorSubpaths` learns the head kinds, ported from
   `build.go::head`. The head becomes part of the connector's vector (today it is a
   separate `Tip` node), so the derived path is one node.
4. **Subgraph.** Each subgraph becomes a **group** (named after the title) holding a
   background rect, a title text and its member nodes; nested subgraphs are nested groups.
   Meta `diagram.cluster=<id>` on the group. Edges stay children of the diagram root and
   reference member ids, so they follow across group boundaries (`worldBoundsOfNode`
   already handles parents).
5. **ER.** `diagram.kind = "er"`, constant `KindER`; `Detect` stops rejecting `erDiagram`.
   An entity is a group like a class box (header + attribute rows, reusing the
   three-compartment drawing in `class.go`). Relationships are connectors with
   `connector.start/end` in the crow's-foot set; identifying `--` solid, non-identifying
   `..` dashed.
6. **Notes.** A note is a rect with a folded corner (`colNote`) plus text, meta
   `diagram.note=<target key|"">`. An attached note gets a dashed connector (no heads) to
   its target, so it follows too. Class: `note "text"`, `note for Class "text"`. State:
   `note left|right of X : text` and the multi-line `note ... end note` block.

No op changes: `CreateNode`/`SetProperties` already carry meta. The `RenderDiagram`
response keeps its shape (nodes, ready to insert); the nodes just carry more meta.

### A.4 Impact

- Server: `internal/diagram` (scene, build, layered, flowchart, state, class, new `er.go`),
  `diagram.go` (Detect/unsupported list), MCP tool descriptions (`diagramSyntax` in
  `internal/mcp/diagram.go`), docs.
- Client: `web/src/vector/connector.ts`, `web/src/store/connectors.ts`, tests. The editor
  dialog's examples (`web/src/diagram/DiagramDialog.tsx`) get ER and subgraph samples.
- Performance: every diagram edge becomes a "tagged" connector; `store/tagged.ts` keeps
  the derive pass proportional to connectors. A 200-edge diagram costs 200 derived nodes
  on a scene change that moves an end, none otherwise (the `connector.at` hash
  short-circuits).
- Code export / `pack` show the stored (drawn) path, as for whiteboard connectors. With
  the `connector.at` rule that is exact until someone moves a box.
- Sequence diagrams are **out of scope** for connectors: messages are time-ordered
  on lifelines, not shape-to-shape. They keep today's drawing.
- Existing documents keep working: no meta means no behavior change. Redrawing an old
  diagram through `update_diagram` produces connectors.
- Risk: head geometry now exists twice (Go for the stored path, TS for derivation).
  Mitigated by a golden parity test (A.6).

### A.5 Approaches

**A1 (recommended). Connectors with a "rest" shortcut, recursive subgraph layout.**
As in A.3. Subgraph layout is recursive: lay out a cluster's contents as its own layered
graph, then treat the cluster as one node (inner size plus padding and title) in the
parent layer; edges that cross a boundary are ranked against the cluster and then drawn
to the real inner node.
- Pros: reuses `layered.go` unchanged in its core; deterministic; sibling clusters cannot
  overlap by construction; the same mechanism gives real composite states for free.
- Cons: edges crossing a cluster boundary can be longer or cross more than in a global
  compound layout.

**A2. Global compound layered layout, edges stay plain vectors plus a "reattach" action.**
Implement compound Sugiyama (keep cluster members contiguous in each rank, compute
cluster boxes afterwards); leave edges as plain vectors and add a "Reattach edges" button
that converts them to connectors.
- Pros: best-looking subgraph layouts; no derive/head port.
- Cons: much more layout code (a known-hard algorithm), and it does not deliver the main
  value (edges that follow) by default; reattaching a stored polyline to boxes is a
  guess.

Recommendation: A1. Layout quality can be improved later behind the same output
contract; connectors are the point of the part.

### A.6 Testing plan

- Go unit tests per parser (`diagram_test.go` style): subgraph (nested, empty, edge to a
  subgraph id, title forms), ER (every cardinality token, `--` vs `..`, attributes with
  `PK/FK/UK` and quoted comments, entity alias, unknown tokens give a line-numbered
  error), notes (single line, multi-line, `for`, unattached).
- Determinism: same text gives the same node structure (ids aside), as today.
- Invariants test over all samples: every `connector.from/to` is a node id in the result;
  every cluster's members lie inside its rect; no two sibling clusters overlap.
- `viz_test.go` renders new samples for eyeballing (existing pattern).
- TS, `connectors.test.ts` additions: `routed` with unchanged boxes returns the stored
  path identity-equal; a moved end gives elbow with heads; the label follows; undo
  restores.
- **Golden parity**: Go head geometry versus TS `connectorSubpaths` for every head kind
  (same fixture, compare subpaths to 0.01).
- Caps: ER entity/attribute/relationship caps and the existing 200/400/64 KiB limits
  hold; malformed input never panics.
- MCP: `create_diagram` with each new kind round-trips through `list_diagrams`.

### A.7 Task breakdown (in order)

A1. `Scene` keys and `Line.From/To`; builder emits `connector.*` meta on flowchart and
    state edges with `routed` + `connector.at`. Keep the `Tip` nodes behind a flag until A2.
A2. TS: head kinds in `connector.ts`, `routed`/`at` rule and label follow in
    `connectors.ts`; golden parity test; drop the `Tip` nodes.
A3. Class diagram edges as connectors (UML heads, multiplicity labels).
A4. Notes in class and state (parser, drawing, dashed connector).
A5. Subgraph in flowchart (parser, recursive layout, group output, edge-to-cluster).
A6. Composite states reuse A5 (replace the flattening in `state.go`).
A7. ER: parser, entity drawing, crow's-foot heads (Go and TS), `Detect`.
A8. Docs: `diagrams.md` (syntax, limits), `whiteboard.md` (new meta), roadmap tick; editor
    dialog samples; MCP tool descriptions.

A1-A2 are the shippable core; A3-A7 are independent of each other after A2.

### A.8 Open questions

1. Should clusters be real **groups** (drag a cluster, its members move) or flat shapes
   behind the members? Recommended: groups. It changes how `update_diagram` replaces a
   diagram and how selection feels.
2. When a user moves a box and the connector falls back to `elbow`, is losing the layered
   route acceptable, or should a connector remember "avoid obstacles"? Recommended:
   acceptable for v1.
3. Should `update_diagram` try to **preserve manual moves** by matching nodes on their
   Mermaid ids (store the id in `meta`)? Out of scope here, but the keys introduced in A1
   make it cheap, so decide whether to store them now.

---

## Part B. Agent tools: consistency review, token usage, variants

### B.1 Goal

Give an MCP agent three things it cannot do well today: judge whether a design is
**consistent with itself**, know **how the document's tokens are actually used**, and
**explore variants** of a design without hand-copying nodes. The server stays model-free:
these tools are deterministic helpers; the agent connected over MCP is the intelligence.
That keeps the app local-first and offline-capable.

### B.2 Current state

- `review_design` (`internal/mcp/review.go`, `internal/review/review.go`): three rules,
  `contrast`, `touch-target`, `token` (a literal color equal to a color variable's value);
  pure, deterministic, sorted. `Issue` has `rule/severity/nodeId/nodeName/message`, no
  machine-readable fix.
- Variables: `list_variables`, `bind_variable`, `set_node_mode`, `set_variable`
  (`internal/mcp/variables.go`). Bindings live on `Node.bindings` (proto, near line 480).
  There is no usage report: nothing says which variables are unused or how much of the
  document is tokenized.
- Component *variants* exist (component sets with axes, `docs/components.md`,
  `internal/mcp/variants.go`). There is no tool for **design** variants (exploring a
  frame), and no server-side subtree clone: `internal/core` has no duplicate; the
  editor's duplicate is client-side.
- `set_node_meta` exists, so provenance can be recorded in `meta`.

### B.3 Data-model and op changes

No proto change. New pure packages/functions and tools:

1. **Consistency review** extends `internal/review` with rules (each independently
   switchable) and `Issue` gains an optional `fix`, `{tool, args}`, so an agent applies it
   with the existing tool (the review stays non-mutating).
   - `spacing`: auto-layout gap/padding off the document's own scale (the most common
     values, including variable values) and within 2px of a scale value.
   - `radius`, `stroke-weight`: same idea.
   - `font`: text whose size/family/weight matches no text style but is close to one.
   - `color-near`: literal colors within a small perceptual (Lab) distance of another
     literal that is used more often, or of a token.
   - `naming`: default names ("Rectangle 12") on nodes that have children or meta.
   - `detached`: a frame structurally equal to a component master (candidate for an
     instance).
   Thresholds derive from the document (frequency), not hard-coded, with a minimum sample
   size per rule so a small file does not drown in noise.
2. **Token usage.** New `internal/review/usage.go`, tool `token_usage` (plus RPC
   `TokenUsage` so a panel can use it later): per variable, number of bindings by
   property and the first N node ids; unused variables; per collection and per mode
   coverage (bound / bindable properties among fills, strokes, opacity, rotation,
   corner radius, stroke weight); text-style usage; and the "candidate bindings" the
   `token` rule already finds, aggregated. Scope: whole document, a page, or a subtree.
3. **Variants.** New core function `CloneSubtree(doc, rootID, patches)` returning ops:
   fresh ids and order keys, **remapped** `connector.from/to`, instance/component refs and
   bindings kept, comments/flows/clips not copied. Tools:
   - `create_variants {nodeId, variants:[{label, set:[{path, props}]}], gap?}`: clones
     the subtree once per variant beside the original in a row, applies each variant's
     property patches, tags the clone roots with `variant.group`, `variant.of`,
     `variant.label` meta. One call; all validation happens before anything is submitted.
   - `create_mode_variants {nodeId, collectionId}`: one clone per mode with
     `set_node_mode` pinned (instant Light/Dark/Brand previews).
   - `list_variants` and `adopt_variant {variantId}`: keep the chosen one in place of the
     original, delete the rest and the tags.
   The agent writes the variants (it does the design thinking); the server guarantees
   correct cloning and cleanup.

### B.4 Impact

- Server only (`internal/review`, `internal/core`, `internal/mcp`), plus an RPC if
  `TokenUsage` is exposed. No client change required; a Develop panel section for usage is
  optional later.
- `review_design` output grows a field; existing consumers ignore unknown fields. Default
  rules stay the current three, so nothing becomes noisier unless asked
  (`rules: ["all"]` or named).
- Cloning interacts with Part A (connector remap) and with auto layout (clone, then
  relayout via normal `ApplyShared`).
- Cost: review is O(N) per call over the session's document; for 50,000 nodes that is
  tens of ms, acceptable for an on-demand tool. `ReviewDesign` today holds `s.mu` for the
  whole run; heavier rules should snapshot instead of holding the lock.
- Undo: each MCP op is its own log record, so `create_variants` is many undo steps;
  see open question 1.

### B.5 Approaches

**B1 (recommended). Deterministic tools, agent decides.** As above.
- Pros: no API keys or model dependency in the server; reproducible; testable; works with
  any MCP client's model; honest about what is mechanical.
- Cons: variant quality depends on the agent; the review cannot judge taste.

**B2. Server-side model calls** (the server asks an LLM for variants and review
commentary).
- Pros: one-click features in the editor without an agent.
- Cons: needs keys, network and cost; breaks "local-first, no accounts"; nondeterministic
  and hard to test; duplicates what MCP clients already do.

Recommendation: B1. Revisit B2 only as an opt-in plugin.

### B.6 Testing plan

- Table tests per new review rule with documents built by `codegen/samples` builders:
  flagged, not flagged, below sample size, determinism (same bytes twice), and the `fix`
  payload actually fixes the issue (apply it, review again, expect it gone).
- Usage: exact counts on a fixture with bound, unbound and unused variables, multi-mode,
  a deleted variable, and scope filters.
- `CloneSubtree`: ids unique, parent/order valid, connector ends remapped, instance
  overrides kept, nested components, `proto.Equal` of clone against original modulo ids,
  cascade-deleting the clone leaves the original byte-identical.
- MCP tests against the in-memory serve (pattern of `review_test.go`, `variants_test.go`):
  create, list, adopt; a validation failure leaves the document unchanged.
- Property test: random subtree, `create_variants` with an empty patch is a pure copy.

### B.7 Task breakdown (in order)

B1. `token_usage` (pure function, tool, tests): smallest and most useful.
B2. `Issue.fix` plus `rules` selection on `review_design`; docs.
B3. New review rules one at a time (`spacing`, `radius`, `color-near`, `font`, then
    `naming`, `detached`), each with tests.
B4. `core.CloneSubtree` with tests (also useful for plugins later).
B5. `create_variants`, `create_mode_variants`, `list_variants`, `adopt_variant`.
B6. Docs (`handoff.md` review table, new "Agent tools" section) and roadmap tick.

### B.8 Open questions

1. Can MCP writes share **one undo step**? The editor has gestures; MCP ops are separate
   records. Without batching, `create_variants` is N undo steps. Decide whether to add a
   batch/gesture op or accept it.
2. What may a consistency review flag without an existing token or scale? If a file has
   no variables, should spacing/radius rules still derive a scale from frequency
   (recommended) or stay silent?
3. Should `Issue.fix` be a tool-call descriptor (recommended) or a proposed `Op`
   (more exact, less readable to the agent)?

---

## Part C. A git bundle whose diffs people can read

### C.1 Goal

Make `pack` output that is pleasant in a pull request and safe to merge: small,
property-level diffs, no needless conflicts, text-like content (diagram sources, copy)
readable as text, and a way to detect a broken merge before `unpack`.

### C.2 Current state

`internal/pack/pack.go` (docs in `docs/handoff.md`): `document.json` (everything but the
nodes), `nodes/<id>.json` per node, `assets/<hash>`; sorted keys, two-space indent, stable
bytes, rewrites only changed files, removes deleted nodes' files; percent-encoded ids.
CLI in `cmd/opendesigner/pack.go`. Tests in `internal/pack/pack_test.go`. Gaps seen in the
code:

1. **`document.json` is a monolith** (pages, flows, transitions, clips, variables, fonts,
   text styles, components, comments). Two people adding comments, or editing different
   variables, edit the same file; comments in particular churn constantly.
2. **One flat `nodes/` directory.** 20,000 nodes is 20,000 files in one folder
   (`scripts/gen-large-doc` makes such a document); slow in editors and `git status`.
3. **Text blobs are escaped one-liners.** A diagram's `meta["diagram.source"]` and any
   long text content appear as one JSON string with `\n`; changing one line of a
   Mermaid diagram shows the whole line changed.
4. **Verbose structure.** Every vector anchor spans several lines (`x`, `y`, handles); a
   path edit is a wall of changes. Sibling order is a generated `orderKey` string, so
   reordering looks like arbitrary key edits.
5. **No integrity check.** `Unpack` verifies only that a file's id matches its name.
   After a git merge, a dangling `parentId`, `connector.from/to`, binding or flow target
   goes unnoticed until the editor misbehaves. Conflict markers give a raw protojson error.
6. **No format version** in the folder (the document has `schemaVersion`), so the layout
   cannot evolve safely.
7. Named versions and the op log are deliberately not packed (history; git has its own).
   Not a gap, but the docs should say it.

### C.3 Data-model and op changes

No document-model or proto change. File format v2 (the proto round trip must remain
lossless: `proto.Equal(doc, Unpack(Pack(doc)))`, the property `TestRoundTrip` already
asserts):

```
<dir>/pack.json                    {"format": 2}
<dir>/document.json                id, name, schemaVersion, pages (small, stable)
<dir>/collections/<id>.json        a variable collection with its variables
<dir>/components/<id>.json         component defs and sets
<dir>/flows/<id>.json              a flow with its transitions
<dir>/comments/<id>.json           one thread each
<dir>/clips/<id>.json, fonts.json, textstyles.json
<dir>/pages/<pageId>/nodes/<id>.json   nodes sharded by page (then by id prefix if > 1000)
<dir>/pages/<pageId>/<nodeId>.mmd      sidecar: diagram source, referenced from the node
<dir>/assets/<hash>
```

- Node JSON: vector anchors written compactly, one per line. Sibling order stays in
  `orderKey` (the key is the model; do not invent a second source of truth).
- Text sidecars: a `meta` value that is multi-line text moves to `<name>.<ext>` and the
  node holds `{"$file": "..."}`; `Unpack` inlines it. Only for known keys
  (`diagram.source`, long `TextNode.content`) so the rule is explicit.
- `Unpack` reads **v1 and v2**; `Pack` writes v2 and removes v1 leftovers (fields moved
  out of `document.json`, flat `nodes/`). A `-format 1` flag keeps the old output for one
  release.
- `opendesigner pack -check DIR` (also run by `unpack`): dangling references, duplicate
  ids across shards, unresolved sidecars, conflict markers, with file and line in the
  message; non-zero exit for CI.

### C.4 Impact

- `internal/pack` and `cmd/opendesigner/pack.go` only, plus docs (`handoff.md`) and the
  `.gitattributes` snippet the docs recommend.
- Existing v1 folders still unpack. Anyone with a repo of v1 packs gets a one-commit
  reshuffle on the first v2 `pack` (documented; `-format 1` avoids it).
- Performance: more, smaller files at the cost of directory fan-out; `Pack` already
  rewrites only changed files, so a no-op pack stays cheap. Measure at 20,000 nodes
  (the large-doc script) before and after.
- No server, editor or protocol change. Offline, like `export` and `flow`.

### C.5 Approaches

**C1 (recommended). Evolve the JSON-per-file layout (format v2).**
- Pros: reuses `stable()` and the lossless protojson path; git merges it as-is; files are
  still individually valid protojson; incremental delivery; v1 compatible.
- Cons: still JSON (verbose for vectors); many files.

**C2. A purpose-built line-oriented text format** (one node per line or a small DSL,
indentation for the tree).
- Pros: the most readable diffs and the best line-based merges.
- Cons: a new parser/printer to keep in lockstep with the proto, and a lossless-ness
  burden for every new field (today new proto fields are free); a format only this tool
  reads; high risk of silently dropping data.

Recommendation: C1. If diffs of vector-heavy files stay too noisy, add compact encodings
inside C1 rather than a new language.

An optional piece, independent of either: a **git merge driver** for node files that
reuses `internal/merge` (the three-way merge behind branch review) to merge by property
when git sees both sides touched the same file. Listed last because it needs the most
care.

### C.6 Testing plan

- Round trip stays `proto.Equal` for a rich fixture (all node kinds, components,
  variables, comments, flows, a diagram with sidecar, ids needing percent-encoding).
- Stability: pack twice gives identical bytes; pack after a one-property change changes
  exactly one file and one line (assert the diff, as the existing layout test does).
- v1 compatibility: a golden v1 folder (checked in under `testdata/`) unpacks to the same
  document as its v2 repack.
- Migration: pack v2 over a v1 folder leaves no stale files.
- `-check`: one test per failure class (dangling parent, connector end, binding,
  conflict markers, bad sidecar), asserting file and line.
- Git-level test (skipped if `git` is missing): two branches edit different nodes and
  different comments in a temp repo; `git merge` is clean and `unpack` of the result
  equals the expected document. Same-property edits conflict, and `-check` reports it.
- Scale: 20,000-node pack/unpack time budget in a benchmark (not a unit test).

### C.7 Task breakdown (in order)

C1. `pack.json` format marker and the v1/v2 reader (still writing v1), with golden tests.
C2. Split `document.json` into per-entity files; migration removal of stale files.
C3. Shard nodes by page.
C4. Text sidecars (`.mmd`, long text).
C5. Compact vector encoding.
C6. `-check` and its use in `unpack`; CI snippet in the docs.
C7. Switch default output to v2; keep `-format 1` for a release.
C8. (Optional) merge driver on top of `internal/merge`; `.gitattributes` docs.

C1, C2 and C6 alone already solve the worst problems (monolith, integrity).

### C.8 Open questions

1. **Is a one-time reshuffle of existing packed repos acceptable**, or must v1 remain the
   default until a deliberate switch? (Task C7 is where this is decided.)
2. Is sharding by page right for people who keep everything on one big page? Alternative:
   shard by the first two characters of the id (uniform, but unrelated to the design).
3. Merge driver: worth building, or is "git merges files; `-check` catches the rest"
   enough for small teams?

---

## Part D. Persistent data structures for the scene

### D.1 Goal

Make the cost of one op proportional to what the op touches, at 100,000 nodes as well as
at 20,000, on both the editor and the server. The roadmap line says "applyOp without
copying the whole map"; most of that is done, so this part finishes the job where the
cost still grows with the size of the document.

### D.2 Current state (numbers from `docs/performance.md`)

- Client node map: `PMap` (`web/src/store/nodeMap.ts`), 256 fixed hash buckets; an edit
  copies 256 pointers plus the touched buckets (~N/256 entries each). At 20,000 nodes
  that is ~340 entries copied; drag p90 went 268 ms to ~33 ms. The cost still grows
  linearly with N (at 1,000,000 nodes a touched bucket holds ~3,900 entries).
- `applyOp` records provenance (`store/sceneDelta.ts`) only for create, set-props,
  set-text and set-vector-path (`singleTouchedNode` in `store/applyOp.ts`). **Delete,
  reparent, pages and components record none**, so the scene index falls back to the
  linear whole-map comparison for them.
- **Children are not indexed.** `store/tree.ts::childrenOf` scans every node and sorts;
  `childIndexOf` rebuilds a throwaway full index per call (the comment in `tree.ts`
  explicitly defers a persistent index to "if the cost shows up"). Auto layout
  (`store/layout.ts`), reparent and cascade delete go through these scans. Go has the
  same shape: `core.ChildrenOf` scans `doc.Nodes`.
- Server: `Hub.Submit` uses `cowClone` (`internal/server/hub.go:543`), which copies the
  node map pointer by pointer for every op, O(N): 0.65 ms at 5,000 nodes, 2.2 ms at
  20,000, so roughly 5 to 6 ms at 50,000 (extrapolated), next to the `Append` fsync.
- Documents with components rebuild the whole scene index when a node inside a master
  changes (`docs/performance.md`, "Known limits").

### D.3 Data-model and op changes

No wire or storage change: this is in-memory structure only; ops, op log and snapshots
are untouched. Internal changes:

1. **Client map.** Replace the fixed 256-bucket `PMap` by a structure with O(log N) path
   copying, a hash-array-mapped trie (HAMT, 32-way). Same public API (`get`, `set`,
   `delete`, `edit()`, `diff`, iteration), so call sites do not change. `diff` keeps its
   "skip shared subtrees by identity" property.
2. **Persistent child index.** `SceneState` gains `children: PMap<string, readonly string[]>`
   (parent id to sibling ids in order), maintained by `applyOp` for create, delete,
   reparent and set-props of `orderKey`/`parentId`. `childrenOf`/`childIndexOf` read it;
   the scan versions stay as the reference implementation used by tests.
3. **Provenance for every op.** `recordDelta` also carries `removed` ids, so delete and
   reparent stop forcing the full comparison.
4. **Server.** Replace the per-op `Nodes` map copy with layered copy-on-write: a
   published `Document` keeps its map; `next` holds a small overlay (`written`,
   `deleted`) over the base map, and the hub **compacts** (merges the overlay into a new
   map) every K ops or when the overlay exceeds a bound. `core.Apply*` reads nodes
   through an accessor instead of `doc.Nodes[id]`. A parent-to-children index in Go (same
   idea as the client's) replaces the `ChildrenOf` scans in layout and delete.

### D.4 Impact

- Client: `store/nodeMap.ts`, `store/types.ts` (`SceneState`), `store/applyOp.ts`,
  `store/tree.ts`, `store/layout.ts`, `store/sceneDelta.ts`, `renderer/sceneIndex.ts`;
  the existing tests (`nodeMap.test.ts`, `reconcile.test.ts`, the scene-index random
  comparison test) are the safety net.
- Server: `internal/core/apply.go`, `tree.go`, `layout.go` and `internal/server/hub.go`.
  `core.Apply` handles about 30 op kinds; the accessor change touches all of them, and
  `Apply` is **the** shared invariant between Go and TS (`internal/core/golden_test.go`,
  `web/src/store/golden.test.ts`). This is the riskiest piece of the whole spec.
- Memory: a HAMT costs more per entry than a bucket object; expect a measurable but
  modest increase at 50,000 nodes. Measure.
- The benefit shows only on large documents; at 1,000 nodes nothing changes. Do not start
  before measuring the baseline at 100,000 nodes (the bench currently stops at 50,000).

### D.5 Approaches

**D1 (recommended). Incremental, client first.** Order: baseline at 100,000; persistent
child index and removal provenance (the real remaining O(N) paths); HAMT only if the
baseline shows the bucket map is the bottleneck; server overlay last, and only if
`Submit` is shown to matter next to `Append`.
- Pros: each step is measurable and revertable; the child index and delete provenance
  are the likely biggest wins and the lowest risk; the Go core stays untouched until a
  number justifies it.
- Cons: may end with "HAMT not needed", which makes the roadmap item smaller than
  written (arguably a feature).

**D2. Do it all at once on both sides**, with a persistent node map in Go (a HAMT behind
`core`'s accessor) and the HAMT in TS.
- Pros: the server also scales to millions of nodes; one design on both sides.
- Cons: touches every op in `core.Apply`; a large, hard-to-bisect change in the module
  whose Go/TS parity the product depends on; benefit unproven (server cost is ~6 ms at
  50,000 nodes against the fsync).

Recommendation: D1.

### D.6 Testing plan

- Reference-model tests: run a long random sequence of ops through the new structure and
  the old scan-based one; assert equal nodes, equal `childrenOf`, equal scene index (the
  repo already does this for the index; extend it to the child index and `diff`).
- Go/TS parity: the golden suites must pass unchanged. Add delete/reparent cascades and
  auto-layout parents to the golden set.
- Property tests for the HAMT: set/delete/get against a `Map`, `diff` correctness,
  canonical shape (equal contents give structurally equal tries), hash-collision handling
  (force equal hashes).
- Undo/redo history tests (`history.test.ts`, `undo.test.ts`) unchanged and green.
- Benchmarks, recorded in `docs/performance.md`: `runBench`/`runPan` at 20,000, 50,000
  and 100,000 nodes (headless Chromium as documented); `go test ./internal/server -bench
  SubmitLargeDoc` extended to 50,000 and 100,000; one-edit cost for set-props, delete
  and reparent, with and without auto-layout parents.
- Acceptance: one edit at 100,000 nodes stays within about 2x the 20,000-node cost for
  set-props, delete and reparent; no regression at 1,000.

### D.7 Task breakdown (in order)

D0. Fix the contradictory "Known limits" text in `docs/performance.md`; extend the bench
    to 100,000 nodes and record the baseline per op kind.
D1. `recordDelta` with `removed`; delete and reparent record provenance; the scene index
    uses it; random-sequence test.
D2. Persistent child index on the client; `childrenOf`/`childIndexOf` read it; layout and
    reparent use it; measure.
D3. Decision gate: if the bench says the bucket map is the bottleneck, HAMT behind the
    unchanged `PMap` API; otherwise stop and close this task with the numbers.
D4. Go child index in `core` (replaces `ChildrenOf` scans in layout and the delete
    cascade); measure `Submit`.
D5. Decision gate: only if `Submit` matters at 100,000, the overlay-based `cowClone`.
D6. Update `performance.md`, tick the roadmap with what was actually done.

### D.8 Open questions

1. What document size must the scene scale to? 20,000 is handled and 50,000 is bearable;
   if nobody opens 100,000-node files, D3 to D5 may never justify their risk. Decide the
   target before D3.
2. D2 adds a derived structure to `SceneState` that every code path creating a scene
   (fixtures, import, snapshot load) must build, as with `nodes`. Alternative: compute it
   lazily and cache in a `WeakMap` like `taggedOf`. Which?
3. Should the page-lazy scene index ("the index is still built for every page") be part
   of this part or its own item?

---

## Cross-cutting

- **Order if done serially**: B1 (token usage), C1+C2+C6, A1+A2, D0+D1 first (each small
  and useful), then the rest by value. Parts do not block each other. Two couplings:
  B4 (`CloneSubtree`) must remap the `connector.from/to` of Part A, and C6 (`-check`)
  should validate the same references.
- **Docs to keep honest**: `docs/roadmap.md` (stale entries named at the top),
  `docs/diagrams.md`, `docs/whiteboard.md`, `docs/handoff.md`, `docs/performance.md`.
- **Out of scope**: sequence diagram connectors, Mermaid export (a separate roadmap
  item), server-side model calls, real-time CRDT merge, a Go port of connector derivation
  (code export keeps showing the stored path).

## The three questions that most affect the plan

1. (Part B) MCP writes are not one undo step. Add a batch/gesture op, or accept N steps
   for `create_variants`?
2. (Part C) May existing packed repos be reshuffled by the v2 layout, or must v1 stay the
   default for now?
3. (Part D) What document size must the scene scale to? That decides whether the HAMT and
   the server overlay are worth building at all.
