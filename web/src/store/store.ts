import { create as createStore } from "zustand";
import { create } from "@bufbuild/protobuf";
import { OpSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { applyOp } from "./applyOp";
import { invertOp } from "./history";
import { recordFinal, recordPreview } from "../animation/recordHook";
import { isReachableFrom, subtreeOf } from "./tree";
import type { PageLite, SceneState } from "./types";
import type { PenPreview } from "./vectorGeometry";

/** The Link tool's rubber band: the box it starts from, the pointer (world), and the node under it. */
export interface LinkPreview { from: { x: number; y: number; width: number; height: number }; x: number; y: number; targetId: string | null }
import type { Camera } from "../canvas/camera";
import type { Bounds } from "../canvas/geometry";
import type { SnapGuide } from "../selection/snap";

// The minimum the store asks of the transport: "send this op" (and apply it
// optimistically). SyncClient satisfies it structurally; tests can pass
// a double without touching the network, and the store does not depend on rpc/.
export interface OpSink {
  submit(op: Op): void;
}

// The state of the connection to the server, in the way the UI must be able to
// tell the user:
//  - "connecting"   initial open (snapshot + subscribe) not finished yet;
//  - "connected"    the stream is open: ops get confirmed;
//  - "reconnecting" the stream dropped and the client is retrying on its own --
//                   changes stay optimistic but are not lost;
//  - "error"        attempts are over (or the bootstrap failed): from here
//                   on it does not recover on its own, a reload is needed.
// The difference between "reconnecting" and "error" is the only one the user must
// really understand: in the first case they can wait, in the second they cannot.
// The preview of a reorder in an auto layout (see tools/layoutDrop.ts), in
// WORLD coordinates: the insertion line and the outline of the dragged node.
export interface LayoutDropPreview {
  indicator: Bounds;
  ghost: Bounds | null;
}

export type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "error";

// An op SUBMITTED but not yet returned by the server. The key is
// the opId, the only identifier that survives the round trip (Hub clones the Op
// verbatim into the OpRecord it rebroadcasts), so the only way the
// client has to recognize its OWN echo.
export interface PendingOp {
  opId: string;
  op: Op;
}

// An op that the CLIENT rolled back on its own initiative (rollback after a failed
// submit) but whose outcome on the server was actually UNKNOWN: Hub.Submit does the
// broadcast BEFORE replying to the unary (internal/server/hub.go), so a
// dead request may very well have left the op in the op-log.
//
// As long as the stream never came back (M0/M1a before the lifecycle) the
// difference was not observable: the echo would never arrive. With
// reconnection it does, and it says that the rollback was a LIE -- the change is
// durable, but the user read "undone" and their undo entry was
// rewound. Keeping the opId (and the message we showed them) is what
// allows REVOKING the rollback when the proof arrives.
interface DisownedOp {
  opId: string;
  message: string;
}

// Cap on the memory of revocable rollbacks. An op truly rejected by the server
// produces no echo, so its entry would never be consumed: the
// cap is what makes them age out instead of accumulating for the whole session.
// Same order of magnitude as the outbox (rpc/syncClient.ts): the window of
// doubt is at most as long as the queue that produced it.
const MAX_DISOWNED = 64;

// The text accompanying a revocation. It is not an error -- it is the opposite: a
// change given up for lost was actually saved. It goes through `notice` and not through
// `lastError` precisely for this reason (the red banner says "not saved and
// undone": repeating it here would be the second lie after the first).
const REVOKED =
  "a change reported as lost was actually saved: it is back on the canvas, with its undo";

// The text accompanying the invalidation of undo/redo entries made STALE by a
// remote op (see markStale). It must be said for the same reason a
// rollback must be said: if the stacks shorten silently, the next Ctrl+Z undoes
// an OLDER gesture than the one the user expects -- which is again
// an unrequested and unexplained change. It goes through `notice` and not `lastError`:
// none of the user's changes was undone, it is their history that lost
// some steps.
const STALE =
  "someone else changed these elements: the undo/redo steps that involved them are no longer valid and were removed";

// The SHAPE of a stack transition: what it pushed, what it removed, what
// it emptied. Keeping the shape and not only the result is what allows
// RECONSTRUCTING the transition on a PREFIX of its ops -- the case, far from
// rare, in which part of the group landed on the server and the rest did not.
//
// Three shapes, one per source:
//  - "gesture": endGesture pushes `entry` (the inverses of the final ops, in
//    stack order) onto undo and EMPTIES redo;
//  - "undo": undo() removes `ops` from undo -- they are exactly the ops it
//    submits -- and pushes `entry` onto redo;
//  - "redo": symmetric.
//
// In all three the same POSITIONAL correspondence holds: `entry[i]` inverts
// the op at position `n-1-i` (invertChain returns the reversed chain), so
// the prefix of surviving ops corresponds to the TAIL of `entry`. It is this
// correspondence that makes partial reconstruction possible without having to
// label the inverses one by one.
//
// `entry` is therefore a list of GROUPS and not of ops: the inverse of ONE op can
// be made of several ops (a deleteNode deletes in cascade, and undoing it means
// re-creating the whole subtree, see history.ts). Flattening it here
// would break precisely the positional correspondence -- `entry[i]` would no
// longer correspond to one op -- and the repair of a half-landed gesture
// would put the wrong portion of the entry back on the stack. The stack
// entries remain FLAT instead (one gesture = one entry = the ops that undo it):
// flattening happens at the boundary, when the entry is pushed.
// Empty `entry` = the transition produced no entry (invertChain
// failed): it may still have emptied redo.
type HistoryShape =
  | { kind: "gesture"; entry: Op[][] }
  | { kind: "undo"; ops: Op[]; entry: Op[][] }
  | { kind: "redo"; ops: Op[]; entry: Op[][] };

// A TRANSITION of the undo/redo stacks produced by SUBMITTED ops not
// yet confirmed.
//
// endGesture pushes the undo entry and empties redo BEFORE the ops are
// accepted (it must: Ctrl+Z right after a drag cannot wait for the network
// round trip). If the server then rejects them, that entry stays there with inverses
// computed on a state the server NEVER reached: a rectangle whose
// createNode was rejected leaves a [deleteNode n5] on top of the
// stack, Ctrl+Z consumes it, the server replies ErrNodeNotFound
// (internal/core/apply.go) -> another rollback, another banner, the entry is burned
// and the PREVIOUS gesture -- the real one -- is not undone. And the redo stack
// had already been emptied for a change that never happened.
//
// The mark keeps the stacks as they were BEFORE the transition plus its shape.
// A rejection lowers `kept` and the history is REPLAYED (revertHistory), the echo
// of the group's last op makes it durable and the mark disappears
// (confirmHistory). It is the same principle as `pending` applied to history:
// as long as the ops are in doubt, so is the undo entry they produced.
//
// The mark is NOT atomic, and it is the point the first version got wrong: the
// transport's discard policy works per OP (the outbox sends one at a
// time and a failure throws away only the tail behind it), while
// multi-op gestures are the norm -- selectTool emits one setProps per selected node
// on drag and on resize, and one deleteNode per node on Delete. Rewinding the whole
// entry because the group's LAST op fell wipes out the undoability of the
// half that was instead persisted: in the Delete case, a node deleted
// forever with no Ctrl+Z possible.
interface HistoryMark {
  // ALL the ops submitted by the transition, in SEND ORDER. Immutable:
  // it is the POSITION within this list that says how much of the transition
  // a rejection takes away.
  opIds: string[];
  // Those still in flight. The echo removes them one by one, a rejection removes all
  // those from the rejected position onward (they will never arrive). With an empty
  // list the transition is DECIDED and the mark can disappear.
  awaiting: string[];
  // How many INITIAL ops of the transition are still valid. Starts from the total;
  // a rejection lowers it to the index of the rejected op. The survivors are
  // always a PREFIX: the outbox sends one op at a time and in order, echoes
  // come back in the seq order decided by the server, and a failure discards the whole
  // tail behind it (rpc/syncClient.ts).
  kept: number;
  // The stacks as they were BEFORE this transition. They serve as the base for the replay
  // only for the FIRST `history` entry; the following ones carry them along
  // so they can become the first when those ahead of them are confirmed.
  undoStack: Op[][];
  redoStack: Op[][];
  shape: HistoryShape;
}

// State of an open gesture. It no longer contains a snapshot of the scene: the base
// of a gesture is "confirmed + in-flight ops", which is recomputed when needed (see
// viewOf) and is always up to date, even if in the meantime records
// arrived from the server or an in-flight op was rejected.
interface GestureSnapshot {
  selection: string[];
  // PREVIEW-only ops of the gesture. They have never been on the wire and will not
  // go there: at the end of the gesture the tool sends the FINAL ops and these are
  // thrown away. They serve to be able to RECOMPUTE the view when an authoritative record
  // arrives mid-drag, without making the preview vanish under the user's
  // fingers.
  //
  // COALESCED by target (see previewKey), not accumulated one per
  // pointermove: a 5s drag at 60Hz on 50 nodes produces 15,000 applyLocal, and
  // a list would keep all 15,000 -- copied on every call (quadratic
  // on the drag hot path) and REPLAYED in full by viewOf on every record
  // that lands mid-drag, with a full clone of the nodes map per op.
  // By coalescing, the preview stays as large as the selection (one entry per
  // node and mask shape), regardless of how long the drag lasts.
  preview: ReadonlyMap<string, Op>;
}

// COALESCING key of a preview op: two ops with the same key
// write EXACTLY the same fields of the same node, so the most
// recent makes the previous irrelevant and can replace it.
//
// It holds for setProps and setText, and only because preview ops are ABSOLUTE
// (selectTool recomputes x/y/width/height from the gesture's start bounds, never from the
// delta of the last move; the editing textarea sends the WHOLE content on
// every key, never the added character): an absolute op on the same fields
// fully rewrites the effect of the previous one. Ops with a DIFFERENT mask remain separate
// entries -- a {width,height} resize preview must not vanish because a
// {x,y} move one arrives -- and for the same reason a setText that
// also carries the STYLE does not collapse with a content-only one.
// createNode/deleteNode do not coalesce at all (unique key): they are not
// idempotent among themselves and no tool emits them per pointermove, so they are not
// on the hot path.
let previewCounter = 0;
function previewKey(op: Op): string {
  if (op.kind.case === "setProps") {
    const { id, mask } = op.kind.value;
    // Sorted: ["x","y"] and ["y","x"] write the same fields.
    return `s|${id}|${[...(mask?.paths ?? [])].sort().join(",")}`;
  }
  if (op.kind.case === "setText") {
    // An editing session (ui/TextEditorOverlay.tsx) does one applyLocal per
    // KEY and lasts as long as the writing does: without coalescing, a thousand characters
    // are a thousand preview ops, all replayed by viewOf on every authoritative
    // record that lands while typing.
    const { id, stylePresent } = op.kind.value;
    return `t|${id}|${stylePresent ? "style" : ""}`;
  }
  if (op.kind.case === "setVectorPath") {
    // Same source as the drag, and the WORST: the pen tool (and dragging
    // an anchor) does one applyLocal per POINTERMOVE, and every op carries the WHOLE
    // subpaths -- not a delta. Without coalescing a single 5s drag
    // at 60Hz leaves 300 preview ops, each with all the geometry
    // inside, copied on every applyLocal and REPLAYED by viewOf on every authoritative
    // record that lands mid-gesture: exactly the quadratic that
    // previewKey exists to avoid.
    //
    // The key is the id alone: setVectorPath is wholesale and ABSOLUTE (it replaces
    // the subpaths in bulk), so two ops on the same node write by
    // definition the same fields and the last makes the previous irrelevant.
    // No variant like setText's `style`: the op IS the subpaths, it does not
    // carry a second piece that could remain intact.
    const { id } = op.kind.value;
    return `v|${id}`;
  }
  return `#${previewCounter++}`;
}

// THE VIEW. Single definition of the rendered scene:
//   confirmed by the server  ->  ops still in flight (in send order)  ->  gesture preview
// Every reconciliation (wire record, rejection, end of gesture) recomputes from here
// instead of patching the previous state: it is what makes ordering, rollback and
// rebase defined instead of ad hoc.
function viewOf(confirmed: SceneState, pending: readonly PendingOp[], preview: Iterable<Op>): SceneState {
  let scene = confirmed;
  for (const p of pending) scene = applyOp(scene, p.op);
  for (const op of preview) scene = applyOp(scene, op);
  return scene;
}

// Removes from the queue the FIRST entry with this opId (the queue is in send
// order). An empty opId identifies nothing and must not be able to remove the wrong op
// from the queue: in that case it touches nothing.
function dropPending(pending: PendingOp[], opId: string): PendingOp[] {
  if (opId === "") return pending;
  const i = pending.findIndex((p) => p.opId === opId);
  return i < 0 ? pending : [...pending.slice(0, i), ...pending.slice(i + 1)];
}

// --- entries made STALE by a remote op -------------------------------------
// An undo/redo entry is made of ABSOLUTE inverses (a setProps carries the values
// in full, not a delta) computed on a precise state: the one in which the
// entry was created. It stays valid as long as the nodes it touches are not changed by
// SOMEONE ELSE -- local ops, instead, keep it valid by construction
// (a gesture pushes its own entry on top, an undo consumes it).
//
// After a remote change there is no sensible rebase: two
// ABSOLUTE writes on the same field do not merge, one of them wins, and letting
// ours win is exactly the silent overwrite to avoid (the user did not
// ask to undo someone else's work, they asked to undo their
// OWN). The stale op is therefore removed from the entry, and the user reads it from the
// banner (STALE).
//
// Granularity: per OP, not per whole entry. A multi-node gesture is a single entry
// (selectTool sends one setProps per selected node) and throwing it all away
// because another client touched ONE of the nodes would make even the part that is still entirely ours
// non-undoable. It is the same choice the
// rollback repair already makes on half-landed gestures.

// The TARGET of an op: the node it touches and, for a setProps, the FIELDS it
// writes to it. `paths: null` = the whole node -- createNode and deleteNode do not touch
// a field, they touch the node's EXISTENCE, which is beneath every field.
interface OpTarget {
  id: string;
  paths: readonly string[] | null;
}

function targetOf(op: Op): OpTarget | null {
  switch (op.kind.case) {
    case "createNode": {
      const node = op.kind.value.node;
      return node && node.id !== "" ? { id: node.id, paths: null } : null;
    }
    case "deleteNode": {
      const { id } = op.kind.value;
      return id === "" ? null : { id, paths: null };
    }
    case "setProps": {
      const { id, mask } = op.kind.value;
      return id === "" ? null : { id, paths: mask?.paths ?? [] };
    }
    // "text" is NOT a FieldMask path (it is not in MASK_PATHS, and Go
    // would reject it inside a setProps): it is the LABEL of the field a setText
    // writes, and it only serves here, to decide conflicts. It sits in the same
    // namespace as the setProps paths precisely because it must be disjoint from
    // ALL of them: rewriting the content and moving the node are
    // independent changes, and someone else's rename must not burn the undo of an
    // editing session (nor vice versa).
    // Without this branch a remote setText would make nothing stale and an undo
    // entry containing a setText would NEVER be invalidated: the next Ctrl+Z
    // would silently rewrite someone else's text.
    case "setText": {
      const { id } = op.kind.value;
      return id === "" ? null : { id, paths: ["text"] };
    }
    // "subpaths" is the LABEL of the field a setVectorPath writes (not a
    // FieldMask path -- Go would reject it inside a setProps), exactly
    // like "text" for setText. Without it, a remote setVectorPath would make
    // nothing stale and an undo entry containing one would NEVER be
    // invalidated: the next Ctrl+Z would silently delete the geometry
    // just drawn by someone else.
    //
    // Unlike "text", however, the label alone is NOT enough -- and it is
    // the only op with more than one field in its target. For a vector node the
    // box IS the path's bbox (proto invariant on VectorNode), so
    // x/y/width/height and subpaths are not independent fields: they are two HALVES
    // of the same value. They are written with TWO ops -- a resize is a single gesture
    // that emits setProps{x,y,width,height} + setVectorPath (see
    // tools/selectTool.ts::resizeOps) -- while the pruning of stale ops
    // works per OP. With a target restricted to "subpaths" a remote record
    // would prune ONLY ONE of them and keep the other:
    //  - a remote DRAG (setProps{x,y}) would prune the box's inverse and keep
    //    the geometry's -> Ctrl+Z would put the OLD ink back into the
    //    new box;
    //  - a remote setVectorPath would prune the geometry's inverse and keep
    //    the box's -> Ctrl+Z would put the OLD box back around
    //    the other's ink.
    // In both cases a node remains whose box is no longer the bbox of its
    // path: the 8 resize handles do not touch the ink (overlayRenderer
    // draws them from the box) and the marquee grabs empty space.
    //
    // The target therefore includes the WHOLE box. On width/height it is obvious: they
    // determine it. On x/y less so, because a move alone would not detach
    // anything -- the anchors are LOCAL, so the ink travels with the
    // node. They are there anyway, for two reasons:
    //  1. they are the only way to close the first track: there the remote record is
    //     a setProps{x,y}, and without x/y here the target remains disjoint
    //     from the geometry's inverse, which survives alone -- that is
    //     exactly the half-undo to avoid;
    //  2. they do not cost an undo step that was not already about to fall: whoever
    //     rewrites the subpaths sends IN THE SAME GESTURE the setProps{x,y,width,
    //     height} that renormalizes the box (the invariant belongs to the writer, see
    //     vectorGeometry.ts::normalizeVector), so that second record
    //     would have pruned the same entries an instant later. Anticipating the pruning
    //     does not remove more: it removes the WINDOW in which half an entry survives.
    // It is not "a remote op on this node burns its whole history": the per-field
    // cut remains, and with a rename, the opacity or the fill there is
    // no conflict.
    //
    // A single change is enough for both directions because `conflicts` intersects
    // the two lists: widened here, the target bites both when the
    // setVectorPath is the REMOTE record and when it is the op inside the entry (where
    // its counterpart is the setProps on another client's box).
    case "setVectorPath": {
      const { id } = op.kind.value;
      return id === "" ? null : { id, paths: ["subpaths", "x", "y", "width", "height"] };
    }
    // A reparent writes TWO fields: the container and the position among peers.
    // They are in the same namespace as the setProps paths precisely because
    // "order_key" is also a mask path (the layers panel
    // reordering): a remote reparent must invalidate the undo of a
    // local reorder of the same node, while it must not touch that of
    // a move (x/y), which stays exact.
    case "reparentNode": {
      const { id } = op.kind.value;
      return id === "" ? null : { id, paths: ["parent_id", "order_key"] };
    }
    // An unknown kind has no known target: it cannot invalidate anything, but
    // it is not invalidatable either (applyOp ignores it, so it never ended up in
    // an entry).
    default:
      return null;
  }
}

// The targets of an op, EXPANDED against the scene the op lands on.
//
// It only serves deleteNode, and it is the consequence of the cascade: the op names a
// node but takes away a SUBTREE (see applyOp). An op that touches a
// descendant is therefore in conflict with this delete as much as one that
// touches the root -- without the expansion, a group deleted by another
// client would leave standing the undo entries concerning its children, and the
// next Ctrl+Z would send the server a setProps on a node that no longer
// exists (rejection, red banner, burned entry).
//
// For all other kinds it is the single target from targetsOf.
function targetsOf(op: Op, scene: SceneState): OpTarget[] {
  if (op.kind.case !== "deleteNode") {
    const t = targetOf(op);
    return t ? [t] : [];
  }
  const { id } = op.kind.value;
  if (id === "") return [];
  const sub = subtreeOf(scene, id);
  // Node already absent from the given scene: the named target remains, so an op
  // of an entry (computed on an older state) keeps conflicting.
  if (sub.length === 0) return [{ id, paths: null }];
  return sub.map((n) => ({ id: n.id, paths: null }));
}

// Two ops are in CONFLICT when they touch the SAME node and at least one field in
// common.
//
// The per-field cut is not a detail: without it, any remote change to
// any property of a node would wipe out the history concerning it -- someone else's
// rename would burn the undo of your move. Two setProps on
// DISJOINT masks instead do not really touch each other: applyOp reads and writes only the
// mask's paths, so the inverse remains exact and there is nothing to
// overwrite.
//
// Existence (`paths: null`) instead conflicts with everything, in both directions:
// deleting a node that another has just modified throws away its change
// ENTIRELY (worse than overwriting a field), and a node deleted or
// re-created by another is no longer the state on which the inverse was computed.
function conflicts(a: OpTarget, b: OpTarget): boolean {
  if (a.id !== b.id) return false;
  const pa = a.paths;
  const pb = b.paths;
  if (pa === null || pb === null) return true;
  return pa.some((p) => pb.includes(p));
}

// All the entries a remote record can make stale: the LIVE stacks and those
// held by the marks still in doubt. The marks must be looked at even if they are not
// visible: their bases are what replayHistory rebuilds the stacks from at the
// next rejection, so a stale op left in there would COME BACK.
function allEntries(undoStack: Op[][], redoStack: Op[][], history: HistoryMark[]): Op[][] {
  const out: Op[][] = [...undoStack, ...redoStack];
  for (const m of history) out.push(...m.undoStack, ...m.redoStack, m.shape.entry.flat());
  return out;
}

// Marks the ops made stale by `remote`. Returns true if it marked at least one
// new one.
//
// The set is a WeakSet and not a Set for a precise reason: a stale op leaves
// every stack immediately, so keeping it in a STRONG structure would mean
// keeping it alive for the whole session just to be able to recognize it. With the
// WeakSet membership survives exactly as long as the op that uses it (the marks
// keep a copy while they are in doubt), and not an instant longer.
// The two scenes are NOT the same, and cannot be: the two sides of the
// comparison answer two different questions (see targetsOf, which expands
// cascades).
//  - `before` -- the confirmed state BEFORE `remote` -- is the document the
//    remote op lands on, that is the only one that knows what its deleteNode
//    took away: afterwards, that subtree no longer exists and the expansion
//    would fall back on the named id only (the entries that touch the CHILDREN of a group
//    deleted by another would remain standing).
//  - `after` -- the confirmed state AFTER -- is instead the document the
//    next Ctrl+Z will land on, that is the only one that knows what a deleteNode OF AN
//    ENTRY would take away NOW. A remote op that INSERTS a node into a
//    subtree (createNode with that parent, or a reparent inward)
//    touches no node the previous scene contained: looked at on the
//    old document it conflicts with nothing, the entry survives, and the next
//    Ctrl+Z deletes in cascade the node of ANOTHER client -- silently,
//    because without a conflict there is not even the STALE banner.
// The opposite direction (a remote that TAKES a node AWAY from a subtree) is
// symmetric and applies on the new document: the entry would no longer destroy it,
// so there is nothing to invalidate and the undo step remains.
//
// The entries remain computed on older states anyway, so `after` is for
// them an approximation -- but it is the one of the moment they would be
// sent, which is the only moment that matters.
//
// The comparison by TARGET is not enough on its own: it looks at the node an op
// NAMES, and since the scene became a tree an op can depend on a node it
// does not name at all -- its own CONTAINER (requiredParent). That
// dependency must be compared with the nodes the remote makes DISAPPEAR, see below.
function markStale(
  remote: Op,
  stale: WeakSet<Op>,
  entries: Op[][],
  before: SceneState,
  after: SceneState,
): boolean {
  const targets = targetsOf(remote, before);
  if (targets.length === 0) return false;
  // The nodes the remote TAKES AWAY from the document: the named root and its whole
  // cascade (targetsOf expands it on `before`, the only document that knows what
  // the delete took away).
  //
  // Only a deleteNode makes any disappear. A reparent leaves them all standing,
  // only elsewhere: every container an entry requires still exists, and
  // invalidating there would be pruning WITHOUT CAUSE -- an entry removed for nothing is an
  // undo step the user silently loses, that is the symmetric defect of
  // the one this check repairs.
  const removed = remote.kind.case === "deleteNode" ? new Set(targets.map((t) => t.id)) : null;
  let hit = false;
  for (const entry of entries) {
    for (const op of entry) {
      if (stale.has(op)) continue;
      // The container the op NEEDS ended up inside the remote cascade:
      // the op can no longer land (ErrParentNotFound in core.applyCreate /
      // applyReparent) however intact its target is.
      //
      // It is the case that escapes the comparison by target entirely: the entry
      // that re-creates c1 inside g1 (the inverse of our delete of c1) does not name
      // g1 anywhere, and c1 -- already out of the document -- does not appear
      // in the cascade the remote op takes away. No conflict, the entry
      // stays, Ctrl+Z sends it, the server rejects it; and since invertOp on
      // it returns null (the parent does not exist) no redo entry is recorded,
      // while revertHistory puts it back on the undo stack: red banner on
      // every subsequent Ctrl+Z, and the entry never drains.
      const parent = requiredParent(op);
      if (parent !== null && removed !== null && removed.has(parent)) {
        stale.add(op);
        hit = true;
        continue;
      }
      const us = targetsOf(op, after);
      if (us.some((u) => targets.some((t) => conflicts(t, u)))) {
        stale.add(op);
        hit = true;
      }
    }
  }
  return hit;
}

// The id an op makes EXIST. It is the only way an op of an entry can
// be the PRECONDITION of another op in the same entry (see pruneEntry).
function createdId(op: Op): string | null {
  if (op.kind.case !== "createNode") return null;
  const node = op.kind.value.node;
  return node && node.id !== "" ? node.id : null;
}

// The container an op REQUIRES to already exist. These are the two ops
// core.Apply validates against the tree: a createNode with an unknown parent and a
// reparent toward an unknown parent are both rejected
// (ErrParentNotFound). null = the op depends on no container.
//
// It is the only dependency of an op that its TARGET does not tell, so it is
// read by the two places that must know it: markStale (the container taken
// away by a REMOTE cascade) and pruneEntry (the container the entry itself
// no longer re-creates).
function requiredParent(op: Op): string | null {
  if (op.kind.case === "createNode") {
    const node = op.kind.value.node;
    return node ? node.parentId : null;
  }
  if (op.kind.case === "reparentNode") return op.kind.value.newParentId;
  return null;
}

// Removes from ONE entry the ops marked stale -- and with them the ops of the same
// entry that could no longer land.
//
// The op-by-op filter alone is not enough since the inverse of a delete is a
// CASCADE of createNode (history.ts): the entry that restores g1>c1>d1 is
// [createNode g1, createNode c1, createNode d1] and is only valid WHOLE, because every
// createNode requires its own parent to already exist. A remote op that touches only
// c1 marks its createNode stale and not that of d1 (different targets,
// see targetsOf): removing only c1 would leave an entry that violates
// exactly the invariant it was built to satisfy -- Ctrl+Z
// would send createNode d1 under a nonexistent parent, the server replies
// ErrParentNotFound and moreover invertChain, which on that entry returns null,
// records no redo entry: red banner and half-done document.
//
// Staleness therefore PROPAGATES downward: once a createNode is removed, everything that
// needed the node it created falls. A single forward pass
// is enough because a valid entry is already in dependency order (subtreeOf visits
// in pre-order, invertChain reverses the GROUPS and not the ops inside a group);
// an entry that was not would already be unacceptable to the server, and the pruning
// order does not make it worse.
function pruneEntry(entry: Op[], stale: WeakSet<Op>): Op[] {
  const out: Op[] = [];
  // The ids this entry will no longer make exist: those of the removed
  // createNodes, plus -- transitively -- those of the createNodes that fell with them.
  const missing = new Set<string>();
  for (const op of entry) {
    const parent = requiredParent(op);
    if (stale.has(op) || (parent !== null && missing.has(parent))) {
      const id = createdId(op);
      if (id !== null) missing.add(id);
      continue;
    }
    out.push(op);
  }
  return out;
}

// Removes from every entry the ops marked stale; an entry left empty disappears.
//
// It is applied at the BOUNDARY -- where a stack becomes the live one -- and never inside
// the marks: `applyMark` aligns the entry to the ops by POSITION (entry[i] inverts
// op n-1-i) and `findConsumed` recognizes an entry by reference identity,
// so filtering the history structures would break both. Filtering on the
// way out gives the same result without touching either.
//
// Returns the SAME array when there is nothing to remove: stacks are
// read by zustand selectors, and a new array on every remote record would wake
// the UI for nothing.
function pruneStale(stack: Op[][], stale: WeakSet<Op>): Op[][] {
  if (!stack.some((entry) => entry.some((op) => stale.has(op)))) return stack;
  const out: Op[][] = [];
  for (const entry of stack) {
    const kept = pruneEntry(entry, stale);
    if (kept.length === entry.length) out.push(entry);
    else if (kept.length > 0) out.push(kept);
  }
  return out;
}

// Where, in the stack, the entry CONSUMED by an undo/redo mark is.
//
// It is NOT "the top": the top is where the entry was when the undo started, and the
// replay replays the marks on stacks that the PREVIOUS marks have already reshuffled.
// If the gesture ahead was rewound, this undo's entry has dropped down in
// position (or was never there); taking the top would remove the
// WRONG entry -- or, on an empty stack, invent one.
//
// The entry is recognized by the OPs it contains, by reference identity: Ops
// are never cloned after construction, so `===` on an op is a
// stable name. The comparison is "tail of `ops`" and not equality because the
// replay of a previous mark may have NARROWED the entry to a tail of itself (a
// half-landed gesture leaves the inverses of the surviving ops, which are the
// tail of the entry) or may simply have rebuilt it (new array, same ops).
// Search from the top: between two compatible entries the most recent is the right one.
function findConsumed(stack: Op[][], ops: Op[]): number {
  for (let i = stack.length - 1; i >= 0; i--) {
    const slot = stack[i];
    const off = ops.length - slot.length;
    if (slot.length > 0 && off >= 0 && slot.every((op, k) => op === ops[off + k])) return i;
  }
  return -1;
}

// Replays ONE transition on the stacks, RESTRICTED to its first `kept` ops.
// kept === opIds.length is the whole transition (the one endGesture/undo/
// redo already applied); kept === 0 is the identity, that is "it never
// happened"; the values in between are the half-landed gesture.
//
// Every shape must be the IDENTITY at kept === 0 and composable with the others:
// the replay chains them, and a mark cannot know whether those ahead of it
// were rewound entirely, halfway or not at all.
function applyMark(
  m: HistoryMark,
  undoStack: Op[][],
  redoStack: Op[][],
): { undoStack: Op[][]; redoStack: Op[][] } {
  const shape = m.shape;
  const n = m.opIds.length;
  // The inverses of the surviving ops are the TAIL of the entry (entry[i]
  // inverts op n-1-i). Without an entry there is nothing to push; at kept === 0 the
  // tail is empty, so push is already the identity.
  //
  // The tail is taken on the GROUPS and flattened afterwards: a group is the inverse
  // (even multiple) of ONE direct op, so cutting on the flat list
  // would take away half a re-creation cascade.
  const kept = shape.entry.length === n ? shape.entry.slice(n - m.kept).flat() : [];
  const push = (stack: Op[][]) => (kept.length > 0 ? [...stack, kept] : stack);
  if (shape.kind === "gesture") {
    // Redo stays emptied as soon as ONE op of the gesture has passed: the document
    // really changed and the redo entries invert a state that no longer
    // exists (see the comment in endGesture). Only a fully
    // rejected gesture gets it back.
    return { undoStack: push(undoStack), redoStack: m.kept > 0 ? [] : redoStack };
  }
  // Removes from the stack the part of the entry that this undo/redo ACTUALLY
  // undid -- its first `kept` ops. What remains of the entry stays there:
  // a half-landed undo leaves to be undone only what is missing.
  //
  // At kept === 0 nothing was undone: the transition did not happen and
  // the stack is not touched. It is the most frequent case (the drain discards the tail from
  // the bottom, so an undo that does not start is rejected entirely) and it is the one
  // that, treated as "remove the top", deleted the entry of ANOTHER gesture --
  // or pushed a phantom one onto an empty stack.
  const done = new Set(shape.ops.slice(0, m.kept));
  const consume = (stack: Op[][]) => {
    if (done.size === 0) return stack;
    const i = findConsumed(stack, shape.ops);
    // The entry is gone (a mark ahead rewound it together with the gesture that
    // had produced it): there is nothing to consume, and certainly not the top.
    if (i < 0) return stack;
    const rest = stack[i].filter((op) => !done.has(op));
    return rest.length > 0
      ? [...stack.slice(0, i), rest, ...stack.slice(i + 1)]
      : [...stack.slice(0, i), ...stack.slice(i + 1)];
  };
  return shape.kind === "undo"
    ? { undoStack: consume(undoStack), redoStack: push(redoStack) }
    : { undoStack: push(undoStack), redoStack: consume(redoStack) };
}

// Recomputes the stacks by replaying EVERY transition still in doubt starting from
// how they were before the oldest. Same choice viewOf makes for the
// document: it REBUILDS instead of patching, so a partial
// repair need not know anything about the transitions around it and
// the order in which rejections arrive stops mattering.
// null = nothing in doubt, there is no base to restart from.
function replayHistory(history: HistoryMark[]): { undoStack: Op[][]; redoStack: Op[][] } | null {
  const head = history[0];
  if (!head) return null;
  let stacks = { undoStack: head.undoStack, redoStack: head.redoStack };
  for (const m of history) stacks = applyMark(m, stacks.undoStack, stacks.redoStack);
  return stacks;
}

// Removes from the HEAD the transitions that are now decided (no op in flight anymore): their
// effect is merged into the base of the next, which becomes the new
// head of the replay. From then on no rejection can touch them anymore -- it is what
// makes an undo entry definitively durable.
function settleHistory(history: HistoryMark[]): HistoryMark[] {
  let out = history;
  while (out.length > 0 && out[0].awaiting.length === 0) {
    const [head, ...rest] = out;
    if (rest.length === 0) return [];
    out = [{ ...rest[0], ...applyMark(head, head.undoStack, head.redoStack) }, ...rest.slice(1)];
  }
  return out;
}

// An authoritative echo removes the op from the waiting set of transitions still in doubt.
// When a transition has no ops in flight it is DURABLE (see settleHistory).
function confirmHistory(history: HistoryMark[], opId: string): HistoryMark[] {
  if (opId === "" || !history.some((m) => m.awaiting.includes(opId))) return history;
  return settleHistory(
    history.map((m) =>
      m.awaiting.includes(opId) ? { ...m, awaiting: m.awaiting.filter((id) => id !== opId) } : m,
    ),
  );
}

// Rejection of an op: the part of the transition starting from that op never
// happened on the server. `kept` drops to the position of the rejected op and the
// stacks are recomputed by replaying the history -- we do not go back to a snapshot.
// Going back to the PRE-transition state (as it was before) is correct only if
// the rejected op is the FIRST of the group; for a later op it would wipe out
// the undoability of the group's ops that instead went through, and would rearm a
// redo stack that the gesture had rightly emptied.
// null = this op produced no transition (submit outside a
// gesture/undo/redo, or transition already confirmed), or it had already been
// discarded: nothing to undo.
type HistoryPatch = Pick<SceneStore, "history" | "undoStack" | "redoStack" | "canUndo" | "canRedo">;
function revertHistory(history: HistoryMark[], opId: string, stale: WeakSet<Op>): HistoryPatch | null {
  const i = history.findIndex((m) => m.opIds.includes(opId));
  if (i < 0) return null;
  const m = history[i];
  const kept = Math.min(m.kept, m.opIds.indexOf(opId));
  // Already outside the surviving prefix: a previous rejection of the same
  // group already counted it. It happens on every burst -- the drain cancels the queue
  // FROM THE BOTTOM -- and recomputing would give the same result: better no set().
  if (kept === m.kept) return null;
  const patched: HistoryMark = {
    ...m,
    kept,
    // Ops beyond the prefix will never arrive: removing them from the waiting set is what
    // allows the mark to become DECIDED when the landed part
    // is confirmed, instead of staying hanging forever.
    awaiting: m.awaiting.filter((id) => m.opIds.indexOf(id) < kept),
  };
  const next = [...history.slice(0, i), patched, ...history.slice(i + 1)];
  const stacks = replayHistory(next);
  if (!stacks) return null;
  // The replay restarts from bases snapshotted BEFORE any remote op that arrived
  // in the meantime: without pruning, a rejection would put back on the stacks the ops
  // that remote op made stale (see pruneStale).
  const undoStack = pruneStale(stacks.undoStack, stale);
  const redoStack = pruneStale(stacks.redoStack, stale);
  return {
    history: settleHistory(next),
    undoStack,
    redoStack,
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
  };
}

// Puts back into the history machine the undo entry of a REVOKED
// rollback -- the late echo proved the op was durable (see apply).
//
// Writing it directly to `undoStack` is correct only when nothing is left
// in doubt. If a transition is still in flight, the LIVE stacks are not
// an autonomous state: they are the replay of `history` on the base of its
// HEAD (replayHistory), and the next rejection recomputes them from there -- from a base
// snapshotted BEFORE the revocation, which therefore erases it again. The window
// is the normal one, not an acrobatic one: the user keeps drawing while the
// pill says "reconnecting…", so when the backlog replays the disowned
// op there is almost always a gesture of theirs still in flight. The result would be
// a durable change, on screen and again not undoable: the exact state
// the revocation exists to remove.
//
// The entry therefore goes into the replay's BASE -- the head is the only one
// replayHistory reads, and settleHistory propagates it forward when it settles --
// and the live stacks are RECOMPUTED from there. The revoked op landed on the server
// before the transitions still in flight, so its entry ends up UNDER
// theirs: Ctrl+Z undoes the most recent first, which is the right order.
//
// `inv` null = the inverse does not exist (the node is gone): no entry to
// put back, but redo is emptied anyway -- the op really happened,
// so the redo entries invert a state that no longer exists (same rule
// applyMark applies to gestures). `inv` is a LIST (the inverse of a single op
// may be multiple, see history.ts) and forms ONE undo entry.
function restoreRevoked(
  history: HistoryMark[],
  undoStack: Op[][],
  redoStack: Op[][],
  inv: Op[] | null,
  stale: WeakSet<Op>,
): HistoryPatch {
  const entry = inv && inv.length > 0 ? inv : null;
  const head = history[0];
  if (!head) {
    const next = entry ? [...undoStack, entry] : undoStack;
    return { history, undoStack: next, redoStack: [], canUndo: next.length > 0, canRedo: false };
  }
  const patched: HistoryMark[] = [
    { ...head, undoStack: entry ? [...head.undoStack, entry] : head.undoStack, redoStack: [] },
    ...history.slice(1),
  ];
  // patched is not empty, so replayHistory cannot give null; the fallback
  // still keeps the current stacks instead of inventing empty ones. Pruned for
  // the same reason as revertHistory: the bases are older than the remote ops.
  const replayed = replayHistory(patched) ?? { undoStack, redoStack };
  const stacks = {
    undoStack: pruneStale(replayed.undoStack, stale),
    redoStack: pruneStale(replayed.redoStack, stale),
  };
  return {
    history: patched,
    ...stacks,
    canUndo: stacks.undoStack.length > 0,
    canRedo: stacks.redoStack.length > 0,
  };
}

// The selection can ONLY narrow: it contains only ids of nodes that
// still exist. If nothing changes it reuses the same array to avoid forcing
// useless re-renders.
function pruneSelection(selection: string[], scene: SceneState): string[] {
  return selection.every((id) => scene.nodes.has(id))
    ? selection
    : selection.filter((id) => scene.nodes.has(id));
}

// The selection pruned by PAGE: keeps only the ids REACHABLE from the
// current page, the same per-page scoping the renderer applies to drawing,
// hit-test and marquee (canvasRenderer.ts::rootsOf). It is the see-vs-
// select invariant carried over to the selection: a node that a remote op moves to
// another page STILL exists -- so pruning by existence alone would
// keep it -- but the canvas no longer draws it, and leaving it selected
// would draw a frame and 8 handles on empty space (overlayRenderer.ts) and would make
// the panel read/edit its properties blindly. setCurrentPage
// resets the selection on a LOCAL page change; this corrects it when the
// change comes from a REMOTE op (via rebuild).
//
// isReachableFrom subsumes existence (an absent id is not reachable from
// any page), so this replaces pruneSelection inside rebuild without a double
// filter. pageId is the one RESOLVED by validCurrentPage: null only for a
// document without pages (which the core does not produce), where nothing is reachable
// and the selection empties -- consistent with rootsOf, which without a page has no
// roots to draw. It reuses the same array when nothing changes, so as not to
// wake the zustand subscribers.
function pruneSelectionToPage(selection: string[], scene: SceneState, pageId: string | null): string[] {
  if (pageId === null) return selection.length === 0 ? selection : [];
  return selection.every((id) => isReachableFrom(scene, id, pageId))
    ? selection
    : selection.filter((id) => isReachableFrom(scene, id, pageId));
}

// Comparison by content: it serves to NOT call set() when the reconciled selection
// coincides with the one already in the store (a useless set wakes
// all the subscribers).
function sameSelection(a: string[], b: string[]): boolean {
  return a === b || (a.length === b.length && a.every((id, i) => id === b[i]));
}

// currentPageId is VIEW STATE (like camera and selection), NOT of the document:
// it does not travel on the wire. But it must ALWAYS stay valid -- the renderer draws the
// ONLY current page (canvasRenderer.ts::rootsOf), so an id that no longer points
// to any page would leave the canvas empty and the tools creating under a
// nonexistent parent. It must therefore be corrected on EVERY change of scene.pages, even
// when it comes from a remote op: if the current page disappears (DeletePage) we
// fall back to the FIRST remaining; if it is still there (someone else's CreatePage/RenamePage,
// resync) it is not touched. null only for a document without pages -- which the core
// does not produce (the last page is not deleted, ErrLastPage).
function validCurrentPage(pages: readonly PageLite[], currentPageId: string | null): string | null {
  if (currentPageId !== null && pages.some((p) => p.id === currentPageId)) return currentPageId;
  return pages[0]?.id ?? null;
}

// Primitive shared by endGesture/undo/redo: given the state BEFORE `ops`
// is applied, computes the inverse of EVERY op in sequence (the inverse of the
// second op must be computed on the state after the first, etc.) and returns the
// chain in REVERSE order -- so undoing the ops in stack order
// restores exactly the starting state, one op at a time.
// null if even a single op of the chain has no inverse (id vanished in the
// meantime, unknown kind...): a PARTIAL undo/redo would leave the scene
// halfway, worse than a gesture that simply cannot be undone.
//
// Returns one GROUP per direct op, not a flat list: the inverse of a
// single op can be made of several ops (a deleteNode deletes in cascade, and
// undoing it means re-creating the whole subtree -- see history.ts). The
// groups are in reverse order with respect to `ops`, while INSIDE each group
// the order is the one in which ops must be applied. It is the positional
// correspondence on which the repair of a half-landed gesture rests
// (see HistoryMark and applyMark): the i-th group inverts op n-1-i.
function invertChain(scene: SceneState, ops: Op[]): Op[][] | null {
  let state = scene;
  const inverses: Op[][] = [];
  for (const op of ops) {
    const inv = invertOp(state, op);
    if (!inv) return null;
    inverses.push(inv);
    state = applyOp(state, op);
  }
  return inverses.reverse();
}

interface SceneStore {
  // The rendered VIEW: confirmed + in-flight ops + gesture preview (see
  // viewOf). Nobody modifies it "by hand" except through one of the actions
  // below -- it is always a function of the other three.
  scene: SceneState | null;
  // The CONFIRMED document: what the server applied and re-emitted on
  // Subscribe. It advances ONLY from apply(), never from an optimistic op.
  confirmed: SceneState | null;
  // Ops submitted and not yet returned, in send order. They leave
  // here when their echo arrives (confirmed) or when the server rejects them
  // (rolled back). As long as they are here they are re-applied on top of every new
  // confirmed state: that is the rebase.
  pending: PendingOp[];
  // Last rejection to show the user. A SILENT rollback is almost
  // worse than no rollback: the change would vanish from the screen without
  // anyone knowing why.
  lastError: string | null;
  // NON-error notice to show the user: the revocation of a rollback
  // (see DisownedOp) and a paste rejected because the clipboard talks about a
  // node type this build does not know (tools/clipboard.ts, which
  // writes it with setState -- no dedicated action is needed for a channel the
  // UI only reads). It needs a channel separate from
  // `lastError` because the message says the OPPOSITE of that -- "it was saved" --
  // and reusing the red banner would mean announcing good news with the
  // word "undone" in front.
  notice: string | null;
  // Ops rolled back locally whose outcome on the server was unknown, in order of
  // rollback and with the message we showed. A late echo revokes them
  // (see apply). Bounded to MAX_DISOWNED.
  disowned: DisownedOp[];
  // State of the connection to the server, written by SyncClient. It is the Subscribe
  // stream that defines it: it is the ONLY thing that confirms ops and empties
  // `pending` (see apply), so when it is down every change stays
  // optimistic and the queue no longer drains. The server closes the stream on its own
  // initiative in two reachable cases -- subscriber too slow
  // (internal/server/hub.go) and since_seq older than the compacted history
  // (CodeOutOfRange) -- so it is not a hypothetical case, and is in fact the way
  // the backend ASKS the client to realign.
  connection: ConnectionStatus;
  // The reason for the last non-"connected" state: message to show,
  // null when the connection is healthy. Separate from `lastError` because the
  // consequence is different: `lastError` is a single undone change, this
  // is the whole document that stops advancing.
  syncError: string | null;
  camera: Camera;
  // The page DISPLAYED on the canvas, view state like camera and selection
  // (NOT document: it is not an op, it does not travel on the wire). The renderer draws
  // only the roots of this page; tools create under it. Invariant:
  // it ALWAYS points to an existing page (validCurrentPage corrects it on every
  // change of scene.pages, even remote). null only before the bootstrap
  // (scene === null).
  currentPageId: string | null;
  // Invariant: selection contains ONLY ids of nodes REACHABLE from the current
  // page (which is stronger than "still exist in scene.nodes"). When an op
  // (even remote, via apply) makes a selected node disappear OR moves it to
  // another page, it must be removed from the selection -- otherwise the frame and resize handles
  // stay "hanging" on a node the canvas does not draw (rebuild via
  // pruneSelectionToPage guarantees it, as setCurrentPage does for the local
  // page change). It is the same per-page scoping as drawing, hit-test and marquee
  // (canvasRenderer.ts::rootsOf): see-vs-select for the frame too.
  selection: string[];
  // Rectangle of the marquee in progress, in WORLD coordinates (like everything else
  // in the model). null when no marquee is being dragged.
  marquee: Bounds | null;
  // The alignment guides ACTIVE at this instant, in WORLD coordinates
  // (see selection/snap.ts). Empty outside a gesture, and empty during a gesture
  // that is not snapping to anything. It is purely VISUAL state -- the real snap
  // is already inside the ops the tool applies -- but it lives in the store like the
  // marquee, and for the same reason: the draw loop reads from there.
  snapGuides: SnapGuide[];
  // The preview of a REORDER in an auto layout (tools/layoutDrop.ts): the line
  // where the node would drop and its outline following the pointer. VIEW state
  // like snapGuides: it lives as long as the gesture and does not enter the document.
  layoutDrop: LayoutDropPreview | null;
  // The path the pen tool is drawing, in WORLD coordinates (see
  // store/vectorGeometry.ts::PenPreview). null when not drawing.
  //
  // It lives here for the same reason as the marquee: it is PREVIEW, not document. The
  // vector node does not exist until the path is finished -- the whole
  // creation is one gesture and produces a single op -- so the path in progress
  // cannot go through `scene`, and the overlay is the only place where it can be seen.
  penPreview: PenPreview | null;
  // The Link tool's rubber band (view state, like the marquee): from a node's box to the pointer.
  linkPreview: LinkPreview | null;
  // Transport to the server: null until SyncClient registers (isolated
  // tests, bootstrap not yet completed).
  sync: OpSink | null;
  // Gesture in progress (null = no open gesture).
  gesture: GestureSnapshot | null;
  // Id of the text node currently being edited (<textarea> overlay, Task 5), or
  // null outside editing. It is not in itself a gesture: the editing session opens
  // its OWN gesture (beginGesture) when the overlay mounts, not when
  // editingNodeId changes -- textTool sets it right after having created the
  // node (ITS creation gesture is already closed at that point).
  editingNodeId: string | null;
  // An UNDO/REDO stack, not of scenes: every entry is a whole gesture (the ops
  // that undo it, one or many), so a drag that moved ten nodes is
  // undone in one stroke. Filled ONLY by endGesture -- remote ops
  // (another client's Subscribe) arrive via apply() and never touch
  // these stacks, by construction: it is how "only your own ops" is guaranteed
  // without needing to label ops by origin.
  undoStack: Op[][];
  redoStack: Op[][];
  canUndo: boolean;
  canRedo: boolean;
  // Stack transitions still "in doubt", in send order: one per
  // gesture/undo/redo whose ops were submitted and not yet confirmed.
  // See HistoryMark: it is what makes a rollback able to repair the
  // history too, not just the view.
  history: HistoryMark[];
  // The undo/redo ops that a REMOTE record has made no longer valid (see
  // markStale). It is not state the UI reads: it is the filter that keeps those ops
  // out of the stacks even when a rejection replays them from a base older
  // than the remote record. WeakSet: membership lives as long as the op, not as long as the
  // session.
  stale: WeakSet<Op>;
  setScene: (s: SceneState | null, discardedReason?: string) => void;
  setCamera: (c: Camera) => void;
  setSync: (s: OpSink | null) => void;
  // `own` = "this record is OURS", and it only serves to decide whether it may invalidate
  // the history: a local op never invalidates it (by construction it keeps it
  // valid), an op from another client does. It is passed by SyncClient (which recognizes
  // its own records by clientId) and by the no-transport branch of
  // endGesture/undo/redo, where the op is local and becomes confirmed instantly.
  // The default is false: a record that arrives with no proof of being
  // ours must be treated as someone else's -- erring in that direction removes one
  // undo step, in the other it rewrites somebody else's work.
  apply: (op: Op, own?: boolean) => void;
  applyPending: (op: Op) => void;
  rejectPending: (opId: string, message: string, revocable?: boolean) => void;
  clearError: () => void;
  clearNotice: () => void;
  setConnection: (status: ConnectionStatus, message?: string | null) => void;
  applyLocal: (op: Op) => void;
  beginGesture: () => void;
  endGesture: (finalOps: Op[]) => void;
  cancelGesture: () => void;
  setSelection: (ids: string[]) => void;
  toggleSelection: (id: string) => void;
  clearSelection: () => void;
  setMarquee: (b: Bounds | null) => void;
  setSnapGuides: (g: SnapGuide[]) => void;
  setLayoutDrop: (d: LayoutDropPreview | null) => void;
  setPenPreview: (p: PenPreview | null) => void;
  setLinkPreview: (p: LinkPreview | null) => void;
  // Changes the displayed page. RESETS the selection (nodes of another
  // page do not stay selected) and is NOT an undo entry -- it is view
  // state, like moving the camera. No-op if the page is already the current one
  // (a re-click must not throw away the selection) or if the id does not exist (which
  // would break the "always valid" invariant).
  setCurrentPage: (id: string) => void;
  // Turns on the editing flag: textTool calls it right after creating the
  // node, selectTool's double click calls it on an existing text node.
  // If a session was already open on ANOTHER node, it closes/cleans it first
  // (same logic as endTextEditing, empty node included) -- never two
  // sessions silently open, never a phantom node abandoned halfway.
  beginTextEditing: (id: string) => void;
  // Turns off the flag and, if the node being edited is a text left
  // EMPTY, deletes it -- standard behavior (do not leave phantom nodes
  // by clicking on empty space, see Task 4 brief). The deletion goes through a gesture
  // like any other change, so it stays undoable.
  endTextEditing: () => void;
  undo: () => void;
  redo: () => void;
}

// Full recomputation of the view starting from a new confirmed base and a
// new queue. It is the only way `scene` changes when reconciliation
// comes into play (wire record, rejection): no differential adjustments.
// The preview of the gesture possibly open is put back on top, so a
// record that arrives mid-drag does not make the local feedback vanish.
function rebuild(st: SceneStore, confirmed: SceneState, pending: PendingOp[]): Partial<SceneStore> {
  const scene = viewOf(confirmed, pending, st.gesture?.preview.values() ?? []);
  // currentPageId is corrected HERE because every rebuild of the view (wire record
  // via apply, rejection via rejectPending) may have changed scene.pages
  // -- a remote DeletePage of the current page, say. It must be resolved BEFORE
  // the selection: the latter is pruned against the EFFECTIVE page (the one
  // it falls back to), not against the old one that has now vanished.
  const currentPageId = validCurrentPage(scene.pages, st.currentPageId);
  // Revalidates the selection to only the nodes REACHABLE from the current page
  // (isReachableFrom subsumes existence, so it also covers the old case:
  // any op that makes an id disappear, or a rollback that removes a just-
  // created node). Per-page scoping is what keeps the selection in agreement with
  // what the canvas draws: a node that a remote op moved to another
  // page, or that was on the just-deleted page, leaves here and does not leave
  // frame/handles/panel hanging in the void (see pruneSelectionToPage).
  return {
    confirmed,
    pending,
    scene,
    selection: pruneSelectionToPage(st.selection, scene, currentPageId),
    currentPageId,
  };
}

export const useScene = createStore<SceneStore>((set, get) => ({
  scene: null,
  confirmed: null,
  pending: [],
  lastError: null,
  notice: null,
  disowned: [],
  connection: "connecting",
  syncError: null,
  camera: { x: 0, y: 0, zoom: 1 },
  currentPageId: null,
  selection: [],
  marquee: null,
  snapGuides: [],
  layoutDrop: null,
  penPreview: null,
  linkPreview: null,
  sync: null,
  gesture: null,
  editingNodeId: null,
  undoStack: [],
  redoStack: [],
  canUndo: false,
  canRedo: false,
  history: [],
  stale: new WeakSet<Op>(),
  // Installs a document: it is the authoritative OpenDocument snapshot, so
  // view and confirmed COINCIDE and nothing is in flight. The only sane way to
  // put a scene in the store (and the only one that maintains the invariant
  // confirmed != null <=> scene != null).
  //
  // It is a WHOLESALE REPLACEMENT, and since mid-session resynchronization exists
  // (CodeOutOfRange -> rpc/syncClient.ts::open) it is no longer just the
  // bootstrap: everything that described the PREVIOUS document goes away along
  // with it, not just the queue.
  //  - `pending` and `history`: the marks reference opIds of that queue, and without the
  //    queue no echo could ever confirm them;
  //  - `undoStack`/`redoStack`: their entries are INVERSES computed on a state
  //    that the snapshot has just thrown away. Leaving them standing means a
  //    Ctrl+Z that sends the deleteNode of a node that does not exist here (or that
  //    puts back at (40,40) a node that the snapshot places elsewhere), moreover without
  //    the mark that allowed a rejection to rewind them;
  //  - `disowned`: the echoes that could revoke those rollbacks belong to
  //    a history that the server has compacted and will not resend.
  // The selection instead is PRUNED (not emptied): ids still REACHABLE
  // from the current page legitimately stay selected -- the same
  // per-page scoping as rebuild (pruneSelectionToPage), not mere existence,
  // otherwise a node that the snapshot shows on ANOTHER page would stay
  // selected with frame and handles drawn on the void.
  //
  // `discardedReason`, if passed, is the message to show when the
  // replacement throws away unconfirmed work: without it, optimistic
  // changes would vanish from the canvas with `lastError` null -- no banner,
  // no explanation.
  setScene: (s, discardedReason) =>
    set((st) => {
      // A new document may have other pages: the current one is kept if
      // it still exists, otherwise the first. At bootstrap (currentPageId null)
      // it becomes the first page of the document. Resolved BEFORE the selection,
      // exactly as in rebuild: the latter is pruned against the
      // EFFECTIVE page (the one the document falls back to), not against the
      // old one that has now vanished.
      const pageId = s ? validCurrentPage(s.pages, st.currentPageId) : null;
      return {
        scene: s,
        confirmed: s,
        pending: [],
        history: [],
        undoStack: [],
        redoStack: [],
        canUndo: false,
        canRedo: false,
        // The ops the filter knew belonged to entries that this
        // replacement has just thrown away: nothing to filter, and no
        // reason to keep them alive.
        stale: new WeakSet<Op>(),
        disowned: [],
        notice: null,
        // Per-page scoping as in rebuild (not mere existence): a resync snapshot
        // in which a selected node moved to another page leaves it
        // existing but no longer reachable from pageId, and it must be removed --
        // otherwise frame/handles/panel stay hanging in the void.
        selection: s ? pruneSelectionToPage(st.selection, s, pageId) : [],
        currentPageId: pageId,
        lastError: discardedReason !== undefined && st.pending.length > 0 ? discardedReason : null,
      };
    }),
  setCamera: (c) => set({ camera: c }),
  setSync: (s) => set({ sync: s }),

  // AUTHORITATIVE RECORD, arrived from Subscribe. It applies to remote ops AND to the
  // own echo: in both cases the confirmed document advances. Filtering
  // echoes by clientId (as in M0) means never adopting the
  // authoritative version of one's own ops, hence never knowing the ORDER
  // decided by the server.
  //
  // If the op is ours it leaves the queue: it is now inside `confirmed`, leaving it
  // also in `pending` would mean re-applying it on top of every subsequent record
  // (double application, and others' records on that node would no longer have
  // effect). The rest of the queue is re-applied on top of the new base: it is the
  // rebase, and it is what prevents a remote record from silently
  // erasing an optimistic change still in flight.
  apply: (op, own = false) =>
    set((st) => {
      if (!st.confirmed) return st;
      // The confirmed state AFTER the op, kept at hand: it is the scene on which
      // the next Ctrl+Z would land, and markStale needs it together with
      // the previous one.
      const confirmed = applyOp(st.confirmed, op);
      const next = {
        ...rebuild(st, confirmed, dropPending(st.pending, op.opId)),
        // The op is durable: the undo entry that produced it stops
        // being undoable by a rollback (see HistoryMark).
        history: confirmHistory(st.history, op.opId),
      };
      const i = st.disowned.findIndex((d) => d.opId === op.opId);
      if (i < 0) {
        // OURS in three ways: the caller tells us (`own`), it is still in
        // our queue (its echo), or -- further below -- it is an op we had
        // disowned and that comes back. Everything else comes from ANOTHER client and may
        // have made undo/redo entries stale (see markStale).
        // (The queue check comes before building the list of entries: an
        // echo is the NORMAL case, and must not pay for the history scan.)
        if (own || st.pending.some((p) => p.opId === op.opId)) return next;
        const entries = allEntries(st.undoStack, st.redoStack, next.history);
        if (!markStale(op, st.stale, entries, st.confirmed, confirmed)) {
          return next;
        }
        const undoStack = pruneStale(st.undoStack, st.stale);
        const redoStack = pruneStale(st.redoStack, st.stale);
        // Marked only things that live inside a mark: the entry has already been
        // consumed by an in-flight transition, so the LIVE stacks do not
        // change now and there is nothing to announce -- if a rejection
        // puts it back in play, it will put it back already pruned.
        if (undoStack === st.undoStack && redoStack === st.redoStack) return next;
        return {
          ...next,
          undoStack,
          redoStack,
          canUndo: undoStack.length > 0,
          canRedo: redoStack.length > 0,
          notice: STALE,
        };
      }
      // ROLLBACK REVOCATION. We had given this op up for lost and undone it
      // locally, but here it comes back from the op-log: it was durable all along (the
      // HTTP request died AFTER the broadcast). The view repairs itself --
      // the op enters `confirmed` above -- but the other two consequences of the
      // rollback do not:
      //  - the banner said "change not saved and undone": it must be withdrawn,
      //    and only if it is still THAT one (in the meantime a real
      //    rejection may have arrived, which must not be hidden);
      //  - the undo entry was rewound, so a change that is on screen
      //    and on the server is no longer undoable, and the next Ctrl+Z
      //    would silently undo the PREVIOUS gesture. We rebuild it
      //    from the inverse computed on the confirmed state BEFORE applying the op:
      //    it is exactly what endGesture would have put on the stack. The
      //    entry must NOT be written to the stacks by hand: as long as a transition is in
      //    doubt the stacks are the replay of `history`, and the next rejection
      //    would erase it again (see restoreRevoked).
      // Redo comes back empty: the op really went through, so the redo entries
      // invert a state that no longer exists (same rule as applyMark for
      // gestures). On the shape: the rebuilt entry is per-op, not per-gesture -- a
      // group revoked op by op leaves one entry per op instead of a single one.
      // Undoable in multiple steps, but undoable.
      const inv = invertOp(st.confirmed, op);
      return {
        ...next,
        ...restoreRevoked(next.history, st.undoStack, st.redoStack, inv, st.stale),
        disowned: [...st.disowned.slice(0, i), ...st.disowned.slice(i + 1)],
        lastError: st.lastError === st.disowned[i].message ? null : st.lastError,
        notice: REVOKED,
      };
    }),

  // OPTIMISTIC SUBMIT: the op goes to the server and enters the queue, the
  // view shows it immediately. It does not touch `confirmed` -- it will get there only when its
  // echo comes back (apply), or it will leave forever if the server
  // rejects it (rejectPending).
  applyPending: (op) =>
    set((st) => {
      if (!st.scene || !st.confirmed) return st;
      if (op.opId === "") {
        // Without an opId the echo is unrecognizable: the op would stay in the queue
        // forever and every rebase would re-apply it on top of the authoritative
        // document. We treat it as already confirmed -- we lose the rollback
        // on rejection, not the change. Unreachable from the constructors in
        // the repo: tools/ops.ts and store/history.ts always stamp a UUID.
        console.warn("opendesigner: submit of an op without opId — cannot be reconciled, applied as confirmed");
        return rebuild(st, applyOp(st.confirmed, op), st.pending);
      }
      // Incremental, not a recomputation: the view is already confirmed + queue and the op
      // is appended at the end. (A submit cannot arrive with a gesture open --
      // endGesture closes the gesture BEFORE sending and undo/redo are no-ops
      // during a drag -- so there is no preview to override.)
      const scene = applyOp(st.scene, op);
      // An OPTIMISTIC op may change pages (a local CreatePage/DeletePage
      // even before the echo): the current page is corrected immediately,
      // as rebuild does for authoritative records. Resolved BEFORE the selection,
      // which is pruned against it.
      const currentPageId = validCurrentPage(scene.pages, st.currentPageId);
      return {
        scene,
        pending: [...st.pending, { opId: op.opId, op }],
        // Per-page scoping as rebuild/setScene, not mere existence: a local
        // op that moves the selected node out of the current page
        // removes it from the selection. Makes the "selection ⊆ reachable
        // from currentPage" invariant airtight on the submit path too.
        selection: pruneSelectionToPage(st.selection, scene, currentPageId),
        currentPageId,
      };
    }),

  // REJECTION from the server: the op leaves the queue and the view is recomputed without
  // it, that is the optimistic change vanishes from the screen. In M0 it stayed there
  // forever, with a single console.error line, and only really vanished at the
  // next reload.
  //
  // `revocable` = "the server may have applied it anyway": it is true only
  // for the op that was TRULY in flight when the request died (see
  // DisownedOp). For everything else -- the queue behind it, which never left, and
  // the rejection due to a full outbox -- no echo is possible, so
  // nothing to revoke.
  rejectPending: (opId, message, revocable = false) =>
    set((st) => {
      const i = st.pending.findIndex((p) => p.opId === opId);
      // Not (anymore) in the queue = ALREADY CONFIRMED: the echo arrived before the
      // HTTP response failed (connection dropped after the append, say).
      // The op is durable: there is nothing to undo, and showing an error
      // would be a lie.
      if (i < 0 || !st.confirmed) return st;
      const pending = [...st.pending.slice(0, i), ...st.pending.slice(i + 1)];
      // It is not enough to remove the op from the view: the undo entry this gesture
      // had already pushed on the stack (and the redo it had emptied) describe
      // a change the server never saw. They must be rewound together
      // with the view, otherwise the next Ctrl+Z sends the inverse of something
      // that does not exist and burns the wrong entry. See HistoryMark.
      return {
        ...rebuild(st, st.confirmed, pending),
        ...(revertHistory(st.history, opId, st.stale) ?? {}),
        // At the tail (the oldest leaves first): an op truly rejected by the
        // server will never receive an echo, so its entry would stay here
        // forever without the cap.
        disowned: revocable
          ? [...st.disowned, { opId, message }].slice(-MAX_DISOWNED)
          : st.disowned,
        lastError: message,
      };
    }),

  clearError: () => set({ lastError: null }),
  clearNotice: () => set({ notice: null }),

  // State of the stream, written by SyncClient. State and reason move
  // TOGETHER (a single set): "connected" with an error message attached, or
  // "reconnecting" without a reason, would be two ways of lying to the UI.
  //
  // It does not reset `pending`: those ops may have reached the server (Hub.Submit
  // broadcasts BEFORE replying) -- throwing them away would invent a rollback
  // nobody asked for. They stay in the queue, waiting for the reconnection
  // to replay the backlog and confirm them (or for the user to reload).
  setConnection: (status, message = null) => set({ connection: status, syncError: message }),

  // Applies LOCALLY only: it is the immediate drag feedback, it does not go over the
  // wire. One pointermove = one applyLocal, and none of these becomes an op.
  // Inside a gesture it is also RECORDED among the previews, so a recomputation
  // of the view (wire record, rejection) can put it back on top instead of
  // switching off the preview mid-drag.
  applyLocal: (op) => {
    // Animation recording (animation/recordHook.ts): with "Record" on
    // the preview of x/y/rotation/opacity goes into the keyframe draft and the scene
    // is not touched. Off: the hook is null and this line does nothing.
    if (recordPreview(op)) return;
    set((st) => {
      if (!st.scene) return st;
      const scene = applyOp(st.scene, op);
      const next = { scene, selection: pruneSelection(st.selection, scene) };
      if (!st.gesture) return next;
      // COALESCED preview: the entry with the same key is replaced and
      // put back AT THE END (delete + set), so the replay order stays that
      // of the last write of each target -- the only thing that matters
      // when two masks partially overlap. See previewKey for
      // why replacing does not change the result.
      const preview = new Map(st.gesture.preview);
      const key = previewKey(op);
      preview.delete(key);
      preview.set(key, op);
      return { ...next, gesture: { ...st.gesture, preview } };
    });
  },

  // Opens a gesture by snapshotting the SELECTION (the Esc restore point) and
  // resetting the preview list. The scene must not be snapshotted: the base
  // of the gesture is "confirmed + in-flight ops", which is recomputed when needed.
  beginGesture: () =>
    set((st) => {
      if (!st.scene) return st;
      if (st.gesture) {
        // Misuse (gesture already open): resetting the accumulated previews and the
        // starting selection would lose the true state at gesture start -- a
        // subsequent cancelGesture would return to mid-drag instead of to the
        // starting point. We keep the FIRST gesture and flag the bug to the caller.
        console.warn("opendesigner: beginGesture() called with a gesture already open — initial snapshot kept");
        return st;
      }
      return { gesture: { selection: st.selection, preview: new Map() } };
    }),

  // Closes the gesture and sends the final ops over the wire ONCE: the document
  // returns to the base (confirmed + ops still in flight, without previews) and is
  // rebuilt from finalOps, so intermediate previews leave no
  // residue (e.g. a preview resize that the final op does not repeat).
  // empty finalOps = gesture with no effect.
  // Note: the SELECTION is not restored (unlike cancelGesture).
  // It is interface state, and a tool may want to change it during the gesture
  // (e.g. select the just-created node) without seeing it undone; it is
  // only pruned, ONCE and against the FINAL scene (see below).
  endGesture: (finalOpsIn) => {
    // Animation recording: ops on animatable properties become ONE SetClip.
    // With recording off `recordFinal` returns the same array.
    const finalOps = recordFinal(finalOpsIn);
    const snap = get().gesture;
    // The selection WANTED by the caller at gesture close. It may already
    // refer to nodes that will only exist AFTER finalOps -- it is exactly the
    // case of the draw tool that selects the node while creating it.
    // It must therefore be reconciled at the END, against the definitive scene: pruning it
    // against the rebuilt base (which does not have those nodes yet) would
    // empty it, and the intermediate prunings of apply() can only
    // narrow, never put an id back in.
    const intended = get().selection;
    // The restore and the sends are distinct, sequential set()s: submit
    // re-enters the store (optimistic apply), so it cannot sit inside
    // another set's updater.
    if (snap) {
      // The gesture's base is NOT a start-of-drag snapshot: it is the confirmed
      // document plus the ops still in flight, recomputed NOW. Authoritative
      // records that arrived during the drag are already in it (they entered
      // `confirmed` via apply), previews are not -- it is how they vanish without
      // leaving residue. An in-flight op rejected mid-gesture has already left
      // the queue, so it does not reappear here.
      const confirmed = get().confirmed;
      const scene = confirmed ? viewOf(confirmed, get().pending, []) : get().scene;
      // Transient pruning: maintains the selection ⊆ scene.nodes invariant
      // even mid-flush; the final reconciliation widens it back to
      // what the caller really wanted.
      if (scene) set((st) => ({ scene, selection: pruneSelection(st.selection, scene), gesture: null }));
      else set({ gesture: null });
    } else if (finalOps.length > 0) {
      // Misuse (endGesture without beginGesture): there is no clean base to
      // rebuild from, so the final ops add up to whatever preview
      // is left hanging. We send them anyway (losing the user's work
      // would be worse) but the caller must know.
      console.warn("opendesigner: endGesture() without an open gesture — ops sent without rebuild");
    }
    // Undo entry: the INVERSES of finalOps, computed on the base -- the same
    // state on which finalOps are about to land (get().scene here is already the
    // scene rebased by the set() above, or the current one in the case of
    // misuse) -- BEFORE submitting any op. Afterwards, that state does not
    // exist anymore. A gesture whose inverses do not all exist (e.g. an id vanished
    // in the meantime because a remote client deleted it mid-drag) does not
    // produce an entry: undoing halfway would leave the scene in a state that
    // no redo can recover.
    //
    // Emptying the REDO stack instead is NOT conditioned on the existence
    // of the undo entry (bug found in review): the final ops are
    // submitted below in any case, so any gesture with final ops
    // has already really changed the document and invalidated the "future"
    // recorded in the redo stack -- those entries are inverses computed on a
    // state that no longer exists. Leaving them there means a subsequent redo
    // silently rewrites properties the user has just modified (e.g.
    // puts back at (40,40) a node just dragged to (999,999)) without any
    // signal. The redo stack is therefore emptied as soon as the gesture has a
    // real effect, regardless of invertChain.
    const base = get().scene;
    const sync = get().sync;
    // The stacks BEFORE this transition: if one of the final ops is later
    // rejected, this is where we go back to (see HistoryMark).
    const prevUndo = get().undoStack;
    const prevRedo = get().redoStack;
    // `groups` keeps the op -> its inverses correspondence (see invertChain and
    // HistoryShape); `entry` is the same thing flattened, that is the undo entry
    // as the stacks see it.
    let groups: Op[][] = [];
    let entry: Op[] = [];
    let changedHistory = false;
    if (finalOps.length > 0) {
      groups = (base ? invertChain(base, finalOps) : null) ?? [];
      entry = groups.flat();
      // No entry to add and redo already empty: no state change,
      // so no set() (it would wake the subscribers for nothing).
      if (entry.length > 0 || prevRedo.length > 0) {
        changedHistory = true;
        set((st) => {
          const undoStack = entry.length > 0 ? [...st.undoStack, entry] : st.undoStack;
          return { undoStack, redoStack: [], canUndo: undoStack.length > 0, canRedo: false };
        });
      }
    }
    // The mark must be registered BEFORE submitting: a submit can fail
    // SYNCHRONOUSLY (full outbox, see rpc/syncClient.ts) and the rollback must
    // already find the transition to rewind. Without a transport it is not needed --
    // ops become confirmed instantly and there is nothing to reject.
    //
    // `opIds` keeps ALL the final ops, even those without an opId: it is a
    // POSITIONAL list, and its index is what aligns a rejection with the undo
    // entry. Only the recognizable ones go into the waiting set (an empty opId never
    // enters `pending`, so no echo could ever remove it).
    if (changedHistory && sync) {
      const opIds = finalOps.map((o) => o.opId);
      const awaiting = opIds.filter((id) => id !== "");
      if (awaiting.length > 0) {
        set((st) => ({
          history: [
            ...st.history,
            {
              opIds,
              awaiting,
              kept: opIds.length,
              undoStack: prevUndo,
              redoStack: prevRedo,
              shape: { kind: "gesture", entry: groups },
            },
          ],
        }));
      }
    }
    for (const op of finalOps) {
      // Without a registered transport we stay consistent locally anyway
      // instead of losing the gesture's result. apply() and not applyLocal():
      // without a wire there is no "confirmed by the server", so the op IS the
      // confirmed document -- a preview would be erased by the first
      // recomputation of the view.
      // `true` = the op is OURS: without this it would be mistaken for a
      // remote record and would invalidate the undo entry this very gesture
      // has just pushed (see apply).
      if (sync) sync.submit(op);
      else get().apply(op, true);
    }
    // Final reconciliation: the wanted selection, pruned against the scene
    // actually produced by the gesture. Ids created by finalOps are still there;
    // those that vanished (remote delete, or a preview that no final op
    // confirmed) stay out -- no handles on nonexistent nodes.
    const scene = get().scene;
    if (scene) {
      const next = pruneSelection(intended, scene);
      if (!sameSelection(next, get().selection)) set({ selection: next });
    }
  },

  // Esc / abandoned gesture: returns to the gesture-start state, selection
  // included (a delete gesture had pruned it), and sends nothing over the
  // wire. Undoing one's OWN gesture does not undo OTHERS' changes, however:
  // authoritative ops that arrived in the meantime stay applied.
  // cancelGesture without an open gesture is a legitimate no-op (Esc pressed outside
  // a drag), not a misuse: no warning.
  cancelGesture: () =>
    set((st) => {
      if (!st.gesture) return st;
      // Same base as endGesture: confirmed + in-flight ops, without previews.
      const scene = st.confirmed ? viewOf(st.confirmed, st.pending, []) : st.scene;
      if (!scene) return { gesture: null };
      return { scene, selection: pruneSelection(st.gesture.selection, scene), gesture: null };
    }),

  setSelection: (ids) => set({ selection: ids }),
  toggleSelection: (id) =>
    set((st) => ({
      selection: st.selection.includes(id)
        ? st.selection.filter((s) => s !== id)
        : [...st.selection, id],
    })),
  clearSelection: () => set({ selection: [] }),
  setMarquee: (b) => set({ marquee: b }),
  // The snap guides of the gesture in progress. Reuses the SAME array when there is
  // nothing to show and nothing was there: a long gesture calls this on every
  // pointermove, and a new array each time would wake the subscribers on
  // every pixel even when no snap is active.
  setSnapGuides: (g) =>
    set((st) => (g.length === 0 && st.snapGuides.length === 0 ? st : { snapGuides: g })),
  setLayoutDrop: (d) => set((st) => (d === null && st.layoutDrop === null ? st : { layoutDrop: d })),
  setPenPreview: (p) => set({ penPreview: p }),
  setLinkPreview: (p) => set({ linkPreview: p }),

  // Changes the displayed page. It is NOT an op and NOT an undo entry: it is
  // view state, like setCamera. Resets the selection (nodes of the other
  // page do not stay selected -- the properties panel and the overlay
  // would otherwise stay hanging on nodes the canvas no longer draws).
  setCurrentPage: (id) =>
    set((st) => {
      // Re-selecting the current page must not throw away the selection.
      if (id === st.currentPageId) return st;
      // Only a page that EXISTS: maintains the "always valid" invariant even
      // if a caller passes a wrong id. With a null scene (bootstrap not
      // yet arrived) it is accepted anyway -- validCurrentPage will correct it.
      if (st.scene && !st.scene.pages.some((p) => p.id === id)) return st;
      return { currentPageId: id, selection: [] };
    }),

  // Closes/cleans ANY session already open BEFORE opening a new one
  // (bug found in review): without this, a second beginTextEditing --
  // double click on ANOTHER text node while one stays in editing, or two consecutive
  // creations from textTool.ts -- overwrote editingNodeId silently,
  // and the previous node NEVER went through endTextEditing: if it had
  // been left empty it stayed on the scene forever, a permanent phantom node
  // (exactly what endTextEditing exists to avoid when the user
  // exits with Escape/click-on-empty). It reuses endTextEditing so every FUTURE
  // caller (the Task 5 overlay included) inherits it for free, instead of
  // having to remember it on their own.
  // Same id already in editing = no-op: do NOT call endTextEditing again (which
  // would delete a still-empty node only to reopen it on an id that has
  // vanished from the scene).
  beginTextEditing: (id) => {
    const current = get().editingNodeId;
    if (current === id) return;
    if (current !== null) get().endTextEditing();
    set({ editingNodeId: id });
  },

  // Exits editing and, if the node was a text left empty, deletes it.
  // The deletion goes through beginGesture/endGesture like ANY other
  // change (same principle as drawing in shapeTool.ts): submitting it
  // directly here would make it the only non-undoable action of the editor.
  //
  // The op does not go through tools/ops.ts::makeDeleteOp so as not to invert the
  // dependency between the two modules (tools/ imports from store/, never the reverse);
  // it is nonetheless the exact same construction, three fields.
  endTextEditing: () => {
    const id = get().editingNodeId;
    if (id === null) return;
    set({ editingNodeId: null });
    const scene = get().scene;
    const node = scene?.nodes.at(id);
    if (!node || node.kind !== "text" || (node.text?.content ?? "") !== "") return;
    const op: Op = create(OpSchema, {
      opId: crypto.randomUUID(),
      docId: scene?.id ?? "",
      kind: { case: "deleteNode", value: { id } },
    });
    get().beginGesture();
    get().endGesture([op]);
  },

  // Undo is NOT a rewind of the op-log: it is more forward work, as per
  // design (see history.ts). It sends the inverted ops through sync.submit
  // exactly as a normal gesture would (optimistic apply + send), and
  // moves the entry to the opposite stack -- recomputing ITS inverses BEFORE
  // submitting anything, on the same principle as endGesture: afterwards, the
  // pre-undo state no longer exists.
  //
  // Guard (bug found in review): if a gesture is open (drag in progress),
  // sync.submit would make the inverse enter the in-flight ops queue, that is
  // IN THE BASE of the gesture. At pointerup endGesture recomputes that base (now
  // with the inverse in the middle) and sends final ops that may refer to a node
  // just deleted by the undo: the drag evaporates leaving no undo entry and
  // the wrong node disappears. And the inverses are computed on the
  // VIEW anyway, which mid-drag contains the previews -- a state that will not
  // exist anymore as soon as the gesture closes. Deferred: the user redoes Ctrl/Cmd+Z
  // after the gesture closes (pointerup/Esc).
  // Second guard, same principle: a PATH in progress with the pen tool
  // (penPreview != null) is a long gesture that does not occupy the `gesture`
  // slot -- it does not touch the document until it finishes, so keeping it
  // open for minutes would prevent anyone else from opening their own (see
  // tools/penTool.ts::finish). Undo/redo stay deferred anyway: mid-
  // path Ctrl+Z would remove a PREVIOUS gesture while the user is looking at
  // the drawing in progress, that is it would undo something different from what is
  // in front of them. Just finish or abandon the path (Enter/Esc) and retry.
  undo: () => {
    if (get().gesture || get().penPreview) return;
    const prevUndo = get().undoStack;
    const prevRedo = get().redoStack;
    const entry = prevUndo[prevUndo.length - 1];
    if (!entry) return;
    const scene = get().scene;
    // Groups (one per undone op) for the mark, flattened for the stack: see
    // invertChain and HistoryShape.
    const redoGroups = scene ? invertChain(scene, entry) : null;
    const redoEntry = redoGroups?.flat() ?? null;
    // Pop of the undo and push of the redo in A SINGLE set, before any send:
    // the submit can re-enter the store (optimistic apply, and in case of
    // synchronous rejection also rejectPending, which rewinds the stacks). Pushing
    // the redo after the send, as it was before, would mean putting it on top of
    // already rewound stacks.
    set((st) => {
      const undoStack = st.undoStack.slice(0, -1);
      const redoStack = redoEntry && redoEntry.length > 0 ? [...st.redoStack, redoEntry] : st.redoStack;
      return { undoStack, redoStack, canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 };
    });
    const sync = get().sync;
    // Undo too is a transition in doubt until its inverses are
    // confirmed: if the server rejects them, the entry that went back to redo must be removed and
    // the one consumed by the undo put back where it was -- and if only a part
    // went through, only the NOT undone part must be put back (see HistoryMark).
    if (sync) {
      const opIds = entry.map((o) => o.opId);
      const awaiting = opIds.filter((id) => id !== "");
      if (awaiting.length > 0) {
        set((st) => ({
          history: [
            ...st.history,
            {
              opIds,
              awaiting,
              kept: opIds.length,
              undoStack: prevUndo,
              redoStack: prevRedo,
              shape: { kind: "undo", ops: entry, entry: redoGroups ?? [] },
            },
          ],
        }));
      }
    }
    for (const op of entry) {
      if (sync) sync.submit(op);
      else get().apply(op, true); // no wire: the op is directly the confirmed state (see endGesture)
    }
  },

  // Symmetric to undo: sends forward the ops the undo had undone, and
  // rebuilds a new undo entry to be able to undo them again.
  // Same guard as undo() above, same reason: redo() during a drag
  // would put its ops in the in-flight queue, that is in the gesture's base.
  redo: () => {
    if (get().gesture || get().penPreview) return;
    const prevUndo = get().undoStack;
    const prevRedo = get().redoStack;
    const entry = prevRedo[prevRedo.length - 1];
    if (!entry) return;
    const scene = get().scene;
    const undoGroups = scene ? invertChain(scene, entry) : null;
    const undoEntry = undoGroups?.flat() ?? null;
    // One set before the sends, same reason as undo().
    set((st) => {
      const redoStack = st.redoStack.slice(0, -1);
      const undoStack = undoEntry && undoEntry.length > 0 ? [...st.undoStack, undoEntry] : st.undoStack;
      return { undoStack, redoStack, canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 };
    });
    const sync = get().sync;
    if (sync) {
      const opIds = entry.map((o) => o.opId);
      const awaiting = opIds.filter((id) => id !== "");
      if (awaiting.length > 0) {
        set((st) => ({
          history: [
            ...st.history,
            {
              opIds,
              awaiting,
              kept: opIds.length,
              undoStack: prevUndo,
              redoStack: prevRedo,
              shape: { kind: "redo", ops: entry, entry: undoGroups ?? [] },
            },
          ],
        }));
      }
    }
    for (const op of entry) {
      if (sync) sync.submit(op);
      else get().apply(op, true); // no wire: the op is directly the confirmed state (see endGesture)
    }
  },
}));
