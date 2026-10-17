# Collaboration: conflicts on the same property, comments, versions and branches

Status: draft for review. No product code is part of this document.
Date: 2026-10-15.

## 0. Scope correction

The request named three roadmap items. Reading `docs/roadmap.md` (section 2) and `docs/collaboration.md` shows that two of them are already shipped:

| Item | Roadmap | Reality |
|---|---|---|
| Comments on the canvas | `[x]` | `Document.comments`, ops `SetComment`/`DeleteComment`, `internal/core/comments.go`, `internal/mcp/comments.go`, golden `testdata/golden/comments.json` |
| Named versions and branching | `[x]` | `internal/store/versions.go`, `internal/server/versions.go` (RPCs `CreateVersion`, `ListVersions`, `DeleteVersion`, `BranchDocument`); three-way branch merge in `internal/merge` |
| Conflicts on the same property | `[ ]` | open: "today the last op to reach the server wins" |
| Property-level merge in REAL TIME | `[ ]` | open; the same problem seen from the other side |

So the real work is the two unchecked rows, which are one problem: **what happens when two writers change the same field of the same node while online together**. Comments and versions are in scope only where they touch that work (section 4: turning a conflict into a comment; section 5: reusing `internal/merge` and versions as building blocks). Everything below respects the standing decision: **no accounts**. Identity stays a `client_id` plus a nickname; access stays share-link roles.

## 1. Goal

When two people (or a person and an MCP agent) edit the same property of the same node at the same time:

1. Nobody's edit disappears silently. Today one of them does, and the loser only sees their change flip back on the canvas.
2. The outcome is deterministic and identical on the server, every browser and the Go/TS golden tests.
3. Resolution costs nothing in the common case (different properties, or sequential edits) and stays local-first and self-hostable.

Non-goals: collaborative editing of character ranges inside one text node (a sequence CRDT), accounts, a hosted relay, changing the branch merge.

## 2. Current state (cited)

**Op model.** `proto/opendesigner/v1/opendesigner.proto`: `Op` (line ~777) is a `oneof` of whole-intent ops. `SetProperties` carries `id`, a `patch` Node and a `FieldMask` over top-level Node fields. Dedicated ops exist for text (`SetText`), vector paths (`SetVectorPath`), reparent, instance overrides, and so on. `OpRecord` = `seq`, `ts`, `client_id`, `op`. `Ack` = `op_id`, `seq`. `ErrorMsg` = `op_id`, `message`.

**Server.** `internal/server/hub.go`, `Hub.Submit`: one writer at a time (`writeMu`), applies the op to a copy-on-write clone (`core.ApplyShared`), assigns `seq = baseSeq+1`, appends to the oplog (`store.Bundle.Append`), then publishes. The hub has no notion of what the submitter had seen: `SubmitOpRequest` is `doc_id`, `client_id`, `op` only. Arrival order is the only arbiter, hence "last op wins". Because `SetProperties` is already mask-based, two writers touching **different** fields never clobber each other; the loss is confined to the same field, or to the same target of a dedicated whole-value op (two `SetText` on one node replace `content`; two `SetVectorPath` replace the subpaths wholesale).

**History retention.** `h.history` holds only records after the last snapshot; `snapshotEveryOps = 256`, `ErrHistoryTooOld`, `historyBase`. Any conflict detection that looks back in history is bounded by this window (open question 3).

**Client.** `web/src/rpc/syncClient.ts` (serial outbox, `MAX_OUTBOX = 64`, 10 s deadline) and `web/src/store/store.ts` keep `confirmed` + `pending`; the view is confirmed + pending re-applied on every remote record (the "rebase"). Consequence today: if my pending `x=100` meets a remote `x=200` that was confirmed first, my view shows 100 until my op lands, then the server applies 100 last and everyone converges on 100 and the remote write is lost without notice; in the other order mine is lost without notice. Undo/redo already treats a remote change to the same node as making an inverse **stale** and tells the user through a banner (`web/src/store/store.ts`, the "entries made STALE by a remote op" comment), so there is precedent for surfacing a conflict as a notice instead of blocking.

**Branches.** `internal/merge/merge.go`: `Compute(base, branch, source)` is already a three-way, property-level merge with conflict detection (`decide`, `editNode`, `Plan.Conflicts`) and `Plan.Ops(docID, preferBranch)` emits ordinary ops. This is the right unit to reuse for any "merge two values" UI.

**Presence / MCP.** `internal/server/presence.go` (ephemeral, not in the oplog). MCP agents are ordinary clients (`internal/mcp/session.go`, `ClientID`, they submit through the same `SubmitOp`) and appear as "Claude" in presence. Agents are the most likely source of same-property conflicts because they write fast and in bulk.

## 3. Data-model and op changes

Common to both approaches:

1. **`base_seq` on submissions.** Add `uint64 base_seq` to `SubmitOpRequest` (and to `OpRecord` for replay). Meaning: "the highest seq I had applied in my confirmed state when I produced this op". The browser knows it (`SyncClient.seq`); MCP sessions know it (`session.go` tracks applied records). `0` = unknown (old clients): the server falls back to today's behaviour. Additive, wire-compatible.
2. **Touch set of an op.** A pure function `core.Touches(op) []Target`, `Target = (kind, id, field)`: for `SetProperties` one per mask path on the node; for `SetText` `(node, "text.content")` and `(node, "text.style")` when `style_present`; `SetVectorPath` `(node, "vector.subpaths")`; `ReparentNode` `(node, "parent")`; `DeleteNode` `(node, "*")`; other singleton ops one target per entity id. Defined once in Go and mirrored in TS, pinned by golden fixtures like `Apply` is.
3. **Conflict outcome in the ack.** `Ack` gains `repeated Conflict conflicts`, `Conflict { target, winner_client_id, winner_seq, resolution }` with `resolution` an enum (`APPLIED_OVER`, `KEPT_THEIRS`, `MERGED`). Additive.
4. **Conflict record in the oplog.** `OpRecord.conflicts` (same message) so a late subscriber and the earlier writer's client learn why a value is what it is.

Approach B only (per-field clocks):

5. **Per-field clock** as a side map `Document.field_clocks: map<string, FieldClock>` keyed `"<nodeId>/<field>"`, `FieldClock { uint64 seq; string client_id; }`. Kept out of `Node` so the design data and the pack/unpack bundle (`internal/pack`, stable bytes) are unaffected; it lives in `snapshot.pb` and is rebuilt by replay.

No change to `Comment`, versions, `origin.json` or the branch-merge format.

## 4. UI and MCP impact

**Editor.**
- When an ack (or an echoed record) carries conflicts, show a non-blocking notice through the store's `notice` channel, not the red `lastError`: "Maria also changed Fill on Rectangle 4; your value was kept." A **Review** action opens a small popover with both values and a one-click "use the other value" that submits an ordinary op (undoable, and itself conflict-checked).
- A node with an unresolved conflict gets a small marker on the canvas overlay (same family as comment pins, never exported).
- A conflict can be turned into a **comment thread** on the node (`SetComment`, author = the nickname) with one click. This is the only place comments are touched, and it needs no comment changes.
- Undo stays per person; the STALE rule for entries made stale by a remote op is unchanged.
- Viewers and commenters (share-link roles) never submit design ops, so are unaffected.

**MCP.**
- Results of design-changing tools include the conflict list from the ack (`conflicts: [{node, field, with, resolution}]`), so an agent can notice it overwrote or was overwritten and re-read. Small addition where tools wait for the echo (`internal/mcp/session.go`, the SubmitOp helper around line 265).
- New read tool `list_conflicts` (recent conflicts in the retained window).
- A stable policy for agents: by default an agent's op yields to a human's concurrent op on the same field ("agents yield", approach A; open question 2).

## 5. Approaches

### Approach A: server-side detection with a deterministic policy (recommended)

The hub already serializes everything. With `base_seq` it can answer, for each submitted op: "did anyone else write any of this op's targets in records `(base_seq, now]`?" It scans the retained `h.history` tail (cheap: about 256 records at most) comparing touch sets.

On a hit it applies a **fixed, documented policy**, decided once by the server and recorded in the record, so every replica agrees:
- default: **last writer wins on the field, but the overwritten value is recorded**: a `Conflict` in the ack to the late writer and in `OpRecord.conflicts`, so the earlier writer's client learns it was overwritten when the record echoes;
- opt-in "agents yield": if the submitter is an MCP client and the earlier writer is not, the late op's conflicting targets are **dropped from the mask** (partial apply, still validated all-or-nothing) and reported as `KEPT_THEIRS`;
- whole-value ops (`SetText`, `SetVectorPath`, reparent vs delete) use the same rule with the op as a single target; "delete vs edit" keeps the delete and reports it.

Pros: no new persistent document state, only `base_seq` and `conflicts` on records; loading and snapshots are unchanged; the oplog stays a plain ordered log and replay needs no extra logic because the reduced mask is already baked into the stored op; small, testable, reversible; consistent with the server-as-arbiter model used by the hub, versions and share-link enforcement.
Cons: detection and reporting, not a true merge: for scalar fields one value still wins (the gain is that it is never silent, and agents can yield). Detection is limited to the retained history window and to clients that send `base_seq`. No character-level text merging.

### Approach B: per-field clocks (last-writer-wins register per field)

Every field carries a clock (`FieldClock`: seq and client of its last write). A submit carries `base_seq`; the server compares `field_clocks[node/field].seq` with it: newer means a concurrent write. Resolution is a total order `(seq, client_id)` that any replica can recompute, which also prepares offline or relay editing, where ordering would no longer depend on arrival at one hub. Text could later move to a sequence CRDT.

Pros: exact detection, unbounded by history retention; a foundation for real property-level merge, the optional NAT-crossing relay and multi-server sync; "who last touched this and when" for the UI.
Cons: much larger blast radius: a new map in `Document` and in snapshots; clocks must be maintained by `core.Apply` for every op type and mirrored in TS `applyOp`; snapshot growth (needs pruning of clocks older than every connected client's base); pack/unpack and `internal/merge` must carry or ignore the clocks; every golden fixture grows. The benefit over A appears only once offline or multi-server editing exists, which the roadmap lists as not built, and it overlaps with what `internal/merge` already does for branches.

### Recommendation

Do **A now**, shaped so **B is a later superset**: `base_seq`, `Touches()` and `Conflict` are exactly what B needs, so nothing is thrown away. A removes the silent loss (the user-visible bug) at a fraction of the cost and keeps the oplog simple. Revisit B when the relay/offline item is scheduled.

## 6. Testing plan

- **Unit, Go** (`internal/core`): `Touches()` table test over every op kind; overlapping and disjoint cases; mask nesting (`fills` vs `fills.0`) decided and pinned.
- **Hub** (`internal/server/hub_test.go`): two clients with stale and fresh `base_seq`; same field gives a conflict, different fields none; "agents yield" partial apply is all-or-nothing and the stored record holds the reduced op; `base_seq = 0` behaves exactly as today; `base_seq` older than `historyBase` takes the documented fallback and never errors; replay from the oplog after restart yields the same document.
- **Race and ordering**: in the style of `submit_bench_test.go`, N concurrent writers on one field; every loser sees a conflict, one deterministic final value; run with `-race`.
- **Golden** (`testdata/golden/`): `conflict_same_field.json`, `conflict_delete_vs_edit.json`, `conflict_text.json`, run from Go and TS so both `Touches` implementations agree.
- **Client** (`web/src/rpc/syncClient.test.ts`, `web/src/store/*.test.ts`): an ack with conflicts sets the notice; a pending op rebased over a remote write to the same field; STALE undo behaviour unchanged; a resync during a conflict clears the notice.
- **MCP** (`internal/mcp/session_test.go`, `http_test.go`): tool result carries conflicts; `list_conflicts`; agent-yields policy.
- **Compatibility**: a client without `base_seq` against the new server, and an old server against the new client.
- **Manual**: two browsers and one MCP agent dragging the same rectangle; check the notice, the review popover and the comment shortcut. `pnpm parity` is expected unchanged.

## 7. Ordered task breakdown

1. Review this spec and settle open questions 1 and 2 (they block tasks 5 and 7).
2. Proto: `base_seq` on `SubmitOpRequest` and `OpRecord`, `Conflict` message and enum, `conflicts` on `Ack` and `OpRecord`; regenerate Go and TS.
3. `core.Touches(op)` in Go with table tests; TS mirror with the shared golden fixtures.
4. Hub: carry `base_seq` through `Submit`, scan the `h.history` tail, build the conflict list, store it on the record; identical to today when `base_seq = 0`. Tests including `-race`.
5. Policy layer: default LWW with reporting; "agents yield" as a hub option (flag or per-document setting); partial-mask apply with all-or-nothing validation.
6. `SyncClient`: send `base_seq`; surface ack conflicts into the store `notice`; handle conflicts on echoed records (my value was overwritten).
7. UI: notice text, Review popover with "use the other value", overlay marker, "turn into comment" shortcut.
8. MCP: conflicts in tool results, `list_conflicts`, mark agent clients for the policy.
9. Docs: update `docs/collaboration.md` ("What is not there") and the roadmap rows accurately (detection and reporting done; real-time property merge stays unchecked until approach B).
10. Manual multi-client pass and a perf check against `submit_bench_test.go` (the history scan must not regress Submit at 20,000 nodes).

## 8. Open questions

1. **Is "never silent, one value still wins" enough to close the roadmap row, or is true merge expected?** For scalars (x, a fill) merging is not meaningful, so the real question is text: do two simultaneous edits to one text node need character-level merging (a sequence CRDT, a much larger project), or is whole-field last-writer-wins with a notice acceptable for text too?
2. **Who should win by default, and should agents be second class?** Pure arrival order, or a human's edit beats a concurrent agent edit? Without accounts the server only knows "MCP client vs browser client" plus a self-chosen nickname; is that signal trustworthy enough on a trusted LAN, and should the policy be per document, a server flag, or fixed?
3. **How far back must detection reach?** The hub keeps only the history since the last snapshot (256 ops), so a client that was slow or offline longer has no detection. Is a silent fallback to last-write-wins (with a generic "you were out of date" notice) acceptable, or should snapshots keep a per-field last-writer index (a lighter cousin of approach B)?
4. Should a resolved conflict be recorded permanently (a conflict log or an auto-created comment thread) or live only in the ack and notice? Permanent records add oplog and UI surface, and an auto-created comment writes into the document without the user asking.
5. Delete vs move (A moves a node into a frame that B deletes at the same time): is "delete wins, the move is reported" right, given that the deleter's undo would bring the node back in its old place?
