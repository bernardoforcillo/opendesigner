import { describe, it, expect, beforeEach } from "vitest";
import { create } from "@bufbuild/protobuf";
import { NodeSchema, OpSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "./store";
import { parentExists } from "./tree";
import { emptyScene } from "./types";
import { vectorBounds } from "./vectorGeometry";
import type { BoxLite } from "./vectorGeometry";

// Double of SyncClient (see rpc/syncClient.ts): records the ops that end up
// ON THE WIRE and models a server that accepts and ECHOES immediately -- applyPending (op
// in flight, visible immediately) followed by apply (the echo that confirms it). Without
// the echo every op would stay in the queue forever and the tests would talk about a
// state the server has never seen. The store depends only on the surface
// { submit }, so a real SyncClient is not needed (no network in tests).
class FakeSync {
  sent: Op[] = [];
  submit(op: Op) {
    this.sent.push(op);
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
}

// Double of the server that REJECTS: applyPending (the op shows up immediately, optimistically)
// followed by rejectPending (the rejection that removes it). It is
// exactly the pair of calls SyncClient.drain makes when the unary
// fails -- InvalidArgument from the server, request timed out, or op discarded
// because it was behind a failed one.
class RejectingSync {
  sent: Op[] = [];
  constructor(private message = "node already exists") {}
  submit(op: Op) {
    this.sent.push(op);
    useScene.getState().applyPending(op);
    useScene.getState().rejectPending(op.opId, this.message);
  }
}

// Double of a HAND-DRIVEN transport: submit only does the optimistic apply
// (like SyncClient, which enqueues and returns immediately) and the test decides op by op
// which one LANDS (`land`, the echo from Subscribe) and which is REJECTED
// (`reject`). It is needed to reproduce the case that neither FakeSync nor RejectingSync
// cover -- they accept/reject *everything* -- that is a group of ops submitted
// together of which only a PART reaches the server. It is exactly what
// SyncClient.drain produces: it sends one op at a time, and when one fails
// those ahead have already gone through and those behind are discarded.
class ManualSync {
  sent: Op[] = [];
  submit(op: Op) {
    this.sent.push(op);
    useScene.getState().applyPending(op);
  }
  land(op: Op) {
    useScene.getState().apply(op);
  }
  reject(op: Op, message = "connection closed") {
    useScene.getState().rejectPending(op.opId, message);
  }
  // Rejection with UNKNOWN outcome: the request died without a response, but the op may
  // very well already be in the op-log (Hub.Submit broadcasts BEFORE
  // replying). The rollback therefore stays REVOCABLE by a late echo --
  // `land` after a `disown` is exactly that proof. See store.ts::DisownedOp.
  disown(op: Op, message = "connection closed") {
    useScene.getState().rejectPending(op.opId, message, true);
  }
}

// Double of a server that VALIDATES the container like core.Apply: a createNode
// (or a reparent) toward a parent that the confirmed document does not contain
// is REJECTED with ErrParentNotFound (internal/core/apply.go); everything
// else lands and is echoed immediately, like FakeSync. It serves where the rejection must
// not be a choice of the test but a CONSEQUENCE of the tree: it is what
// happens when an undo entry re-creates a node inside a container that
// another client has just deleted.
class ValidatingSync {
  sent: Op[] = [];
  submit(op: Op) {
    this.sent.push(op);
    const confirmed = useScene.getState().confirmed!;
    // The same two dependencies that core.Apply validates against the tree (see
    // requiredParent in store.ts).
    const parent =
      op.kind.case === "createNode"
        ? (op.kind.value.node?.parentId ?? null)
        : op.kind.case === "reparentNode"
          ? op.kind.value.newParentId
          : null;
    useScene.getState().applyPending(op);
    if (parent !== null && !parentExists(confirmed, parent)) {
      useScene.getState().rejectPending(op.opId, "parent not found");
      return;
    }
    useScene.getState().apply(op);
  }
}

// The node a delete op targets (null if it is not a deleteNode):
// it serves to distinguish WHICH undo entry was consumed.
function deletedId(op: Op): string | null {
  return op.kind.case === "deleteNode" ? op.kind.value.id : null;
}

function rectNode(id: string, x: number, y: number, width = 100, height = 80) {
  return create(NodeSchema, {
    id, parentId: "page1", orderKey: "a0", name: "Rect", visible: true, opacity: 1,
    x, y, width, height,
    shape: { case: "rect", value: { cornerRadius: 0 } },
  });
}

function createOp(id: string, x: number, y: number): Op {
  return create(OpSchema, {
    opId: "new-" + id, docId: "doc1",
    kind: { case: "createNode", value: { node: rectNode(id, x, y) } },
  });
}

function moveOp(id: string, x: number, y: number): Op {
  return create(OpSchema, {
    opId: `mv-${id}-${x}-${y}`, docId: "doc1",
    kind: {
      case: "setProps",
      value: { id, patch: create(NodeSchema, { x, y }), mask: { paths: ["x", "y"] } },
    },
  });
}

function resizeOp(id: string, width: number, height: number): Op {
  return create(OpSchema, {
    opId: `rs-${id}-${width}`, docId: "doc1",
    kind: {
      case: "setProps",
      value: { id, patch: create(NodeSchema, { width, height }), mask: { paths: ["width", "height"] } },
    },
  });
}

function deleteOp(id: string): Op {
  return create(OpSchema, {
    opId: `del-${id}`, docId: "doc1",
    kind: { case: "deleteNode", value: { id } },
  });
}

// A node INSIDE another node: the scene is no longer flat, and a deleteNode
// on the ancestor takes this one away too (cascade).
function createChildOp(id: string, parentId: string, orderKey: string): Op {
  return create(OpSchema, {
    opId: "new-" + id, docId: "doc1",
    kind: { case: "createNode", value: { node: create(NodeSchema, {
      id, parentId, orderKey, name: id, visible: true, opacity: 1,
      x: 0, y: 0, width: 10, height: 10,
      shape: { case: "rect", value: { cornerRadius: 0 } },
    }) } },
  });
}

// Reorder among peers: a FIELD like the others ("order_key" mask), unlike
// reparenting, which has an op of its own.
function reorderOp(id: string, orderKey: string): Op {
  return create(OpSchema, {
    opId: `ord-${id}-${orderKey}`, docId: "doc1",
    kind: {
      case: "setProps",
      value: { id, patch: create(NodeSchema, { orderKey }), mask: { paths: ["order_key"] } },
    },
  });
}

function reparentOp(id: string, newParentId: string, orderKey: string): Op {
  return create(OpSchema, {
    opId: `rep-${id}`, docId: "doc1",
    kind: { case: "reparentNode", value: { id, newParentId, orderKey } },
  });
}

function createTextOp(id: string, content: string): Op {
  const node = create(NodeSchema, {
    id, parentId: "page1", orderKey: "a0", name: "Text", visible: true, opacity: 1,
    x: 0, y: 0, width: 200, height: 20,
    shape: { case: "text", value: { content } },
  });
  return create(OpSchema, {
    opId: "new-" + id, docId: "doc1",
    kind: { case: "createNode", value: { node } },
  });
}

function setTextOp(id: string, content: string): Op {
  return create(OpSchema, {
    opId: `txt-${id}-${content}`, docId: "doc1",
    kind: { case: "setText", value: { id, content } },
  });
}

function createVectorOp(id: string): Op {
  const node = create(NodeSchema, {
    id, parentId: "page1", orderKey: "a0", name: "Path", visible: true, opacity: 1,
    x: 0, y: 0, width: 100, height: 80,
    shape: { case: "vector", value: { subpaths: [{ anchors: [{ x: 0, y: 0 }], closed: false }] } },
  });
  return create(OpSchema, { opId: "new-" + id, docId: "doc1", kind: { case: "createNode", value: { node } } });
}

// `x` is the only thing that changes between one invocation and the next: it is enough to
// distinguish "the path is mine" from "the path is the other client's".
function setVectorPathOp(id: string, x: number): Op {
  return create(OpSchema, {
    opId: `vec-${id}-${x}`, docId: "doc1",
    kind: { case: "setVectorPath", value: { id, subpaths: [{ anchors: [{ x, y: 0 }], closed: false }] } },
  });
}

// --- a vector node that respects the BOX INVARIANT --------------------------
// Proto, on VectorNode: after a SetVectorPath the geometry's LOCAL bbox is
// (0,0)-(width,height). It is not a formality: that box is what
// overlayRenderer draws the 8 handles on and what selectTool::nodesInMarquee
// selects on, so when it detaches from the ink the handles no longer touch
// the path and the marquee grabs empty space. The tests below assert it
// as a property (boxAndInk), not as a count of stack entries: it is the VISIBLE
// damage, and it is what must hold whatever road the pruning takes.
type Anchors = { anchors: { x: number; y: number }[]; closed: boolean }[];

// A rectangular outline that fills exactly (0,0)-(w,h).
function boxPath(w: number, h: number): Anchors {
  return [{ anchors: [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }], closed: true }];
}

// Same bbox, DIFFERENT drawing: it is the path reshaped by another client
// (an inner anchor moved). Same bbox on purpose -- so the remote record
// counts on its own, without having to carry along a box change as well.
function triPath(w: number, h: number): Anchors {
  return [{ anchors: [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w / 2, y: h }], closed: true }];
}

function createVectorBoxOp(id: string, w: number, h: number): Op {
  const node = create(NodeSchema, {
    id, parentId: "page1", orderKey: "a0", name: "Path", visible: true, opacity: 1,
    x: 0, y: 0, width: w, height: h,
    shape: { case: "vector", value: { subpaths: boxPath(w, h) } },
  });
  return create(OpSchema, { opId: "new-" + id, docId: "doc1", kind: { case: "createNode", value: { node } } });
}

function vectorPathOp(id: string, subpaths: Anchors, tag: string): Op {
  return create(OpSchema, {
    opId: `vec-${id}-${tag}`, docId: "doc1",
    kind: { case: "setVectorPath", value: { id, subpaths } },
  });
}

// The setProps that ALWAYS accompanies a geometry rewrite (and that
// selectTool::resizeOps emits for every node of the resize): the whole box.
function boxOp(id: string, x: number, y: number, width: number, height: number): Op {
  return create(OpSchema, {
    opId: `box-${id}-${width}x${height}`, docId: "doc1",
    kind: {
      case: "setProps",
      value: { id, patch: create(NodeSchema, { x, y, width, height }), mask: { paths: ["x", "y", "width", "height"] } },
    },
  });
}

function renameOp(id: string, name: string): Op {
  return create(OpSchema, {
    opId: `nm-${id}-${name}`, docId: "doc1",
    kind: {
      case: "setProps",
      value: { id, patch: create(NodeSchema, { name }), mask: { paths: ["name"] } },
    },
  });
}

// The box and the ink in the form in which they must be compared. `toEqual` between the
// two states the whole invariant and, when it fails, prints BY HOW MUCH they detached
// -- which is the useful information.
function boxAndInk(id: string): { box: BoxLite; ink: BoxLite } {
  const n = useScene.getState().scene!.nodes.at(id);
  const b = vectorBounds(n.vector!.subpaths);
  return {
    box: { x: 0, y: 0, width: n.width, height: n.height },
    ink: { x: b.x, y: b.y, width: b.width, height: b.height },
  };
}

// --- page ops: the ROOT containers, not a node ------------------------------
function createPageOp(id: string, name: string): Op {
  return create(OpSchema, {
    opId: "cp-" + id, docId: "doc1",
    kind: { case: "createPage", value: { page: { id, name } } },
  });
}

function deletePageOp(id: string): Op {
  return create(OpSchema, {
    opId: "dp-" + id, docId: "doc1",
    kind: { case: "deletePage", value: { id } },
  });
}

function renamePageOp(id: string, name: string): Op {
  return create(OpSchema, {
    opId: `rp-${id}-${name}`, docId: "doc1",
    kind: { case: "renamePage", value: { id, name } },
  });
}

// The ids an entry RE-CREATES, in the order in which it re-creates them.
function createdIds(entry: readonly Op[]): string[] {
  return entry.flatMap((op) =>
    op.kind.case === "createNode" && op.kind.value.node ? [op.kind.value.node.id] : []);
}

// The INVARIANT a restore entry must satisfy to be
// applicable: every createNode finds its own parent already existing -- the
// page, a node the remote op did not touch, or a node re-created BEFORE
// in the same entry. It is exactly what core.applyCreate demands
// (ErrParentNotFound), so an entry that violates it is an entry the server
// will reject halfway.
function expectParentsSatisfied(entry: readonly Op[]) {
  const scene = useScene.getState().scene!;
  const exists = new Set<string>([...scene.nodes.ids()]);
  for (const p of scene.pages) exists.add(p.id);
  for (const op of entry) {
    if (op.kind.case !== "createNode") continue;
    const node = op.kind.value.node!;
    expect({ id: node.id, parent: node.parentId, esiste: exists.has(node.parentId) })
      .toEqual({ id: node.id, parent: node.parentId, esiste: true });
    exists.add(node.id);
  }
}

// Wrapper: opens and closes a gesture in one go, as a tool would at
// the end of a drag. It is the form in which tests build "a gesture" for the stack.
function gesture(finalOps: Op[]) {
  const st = useScene.getState();
  st.beginGesture();
  st.endGesture(finalOps);
}

describe("undo/redo", () => {
  let sync: FakeSync;

  beforeEach(() => {
    sync = new FakeSync();
    useScene.setState({
      selection: [],
      marquee: null,
      gesture: null,
      undoStack: [],
      redoStack: [],
    });
    // setScene and not setState({scene}): installs a COHERENT scene (view and
    // confirmed aligned, empty queue) -- the invariant confirmed/pending
    // reconciliation rests on (see store.ts).
    useScene.getState().setScene(emptyScene("doc1", "Untitled"));
    useScene.getState().setSync(sync);
  });

  it("create -> move -> resize: three undos empty the scene, three redos rebuild it identical", () => {
    const st = useScene.getState();

    gesture([createOp("n1", 0, 0)]);
    gesture([moveOp("n1", 40, 40)]);
    gesture([resizeOp("n1", 200, 160)]);

    const finalScene = useScene.getState().scene;
    expect(finalScene!.nodes.at("n1")).toMatchObject({ x: 40, y: 40, width: 200, height: 160 });
    expect(useScene.getState().undoStack).toHaveLength(3);
    expect(useScene.getState().canUndo).toBe(true);
    expect(useScene.getState().redoStack).toHaveLength(0);
    expect(useScene.getState().canRedo).toBe(false);

    st.undo();
    st.undo();
    st.undo();

    expect(useScene.getState().scene!.nodes.at("n1")).toBeUndefined();
    expect(useScene.getState().undoStack).toHaveLength(0);
    expect(useScene.getState().canUndo).toBe(false);
    expect(useScene.getState().redoStack).toHaveLength(3);
    expect(useScene.getState().canRedo).toBe(true);

    st.redo();
    st.redo();
    st.redo();

    expect(useScene.getState().scene).toEqual(finalScene);
    expect(useScene.getState().redoStack).toHaveLength(0);
    expect(useScene.getState().undoStack).toHaveLength(3);
  });

  it("undo sends the inverse through sync.submit and moves the entry to the redo stack", () => {
    gesture([createOp("n1", 0, 0)]);
    sync.sent = [];

    useScene.getState().undo();

    expect(sync.sent).toHaveLength(1);
    expect(sync.sent[0].kind.case).toBe("deleteNode");
    expect(useScene.getState().scene!.nodes.at("n1")).toBeUndefined();
    expect(useScene.getState().undoStack).toHaveLength(0);
    expect(useScene.getState().redoStack).toHaveLength(1);
  });

  it("an op received from another client does not alter the stacks", () => {
    gesture([createOp("n1", 0, 0)]);
    expect(useScene.getState().undoStack).toHaveLength(1);

    // arrives via apply() (equivalent to SyncClient.consume() for a REMOTE op):
    // it does not go through endGesture, so it must not touch the stack.
    useScene.getState().apply(createOp("n2", 500, 500));

    expect(useScene.getState().undoStack).toHaveLength(1);
    expect(useScene.getState().redoStack).toHaveLength(0);
    expect(useScene.getState().scene!.nodes.at("n2")).toBeDefined();
  });

  it("a new gesture after an undo empties the redo stack", () => {
    gesture([createOp("n1", 0, 0)]);
    gesture([createOp("n2", 100, 100)]);

    useScene.getState().undo(); // undoes the creation of n2
    expect(useScene.getState().redoStack).toHaveLength(1);

    gesture([createOp("n3", 200, 200)]);

    expect(useScene.getState().redoStack).toHaveLength(0);
    expect(useScene.getState().canRedo).toBe(false);
    expect(useScene.getState().undoStack).toHaveLength(2);
  });

  it("undo/redo on an empty stack are silent no-ops", () => {
    useScene.getState().undo();
    useScene.getState().redo();

    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().undoStack).toHaveLength(0);
    expect(useScene.getState().redoStack).toHaveLength(0);
  });

  it("a gesture without final ops leaves no entry on the undo stack", () => {
    const st = useScene.getState();
    st.beginGesture();
    st.applyLocal(moveOp("n1", 7, 7));
    st.endGesture([]);

    expect(useScene.getState().undoStack).toHaveLength(0);
  });

  // --- redo stack emptied even without an undo entry (bug found in review) --
  // invertChain() aborts with null at the FIRST op of the chain that cannot be
  // inverted, but the final ops are submitted anyway: the document has
  // already really changed. If in that case the redo stack stayed full, a
  // subsequent redo would bring back into play inverses computed on a state that
  // no longer exists, silently rewriting the work just done.

  it("a gesture with real effect empties the redo stack even when the undo entry cannot be built", () => {
    const st = useScene.getState();
    gesture([createOp("n1", 0, 0), createOp("n2", 300, 0)]);
    gesture([moveOp("n1", 40, 40)]);

    st.undo(); // n1 goes back to (0,0); the redo stack contains "put n1 back at (40,40)"
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 0, y: 0 });
    expect(useScene.getState().redoStack).toHaveLength(1);
    expect(useScene.getState().undoStack).toHaveLength(1);
    sync.sent = [];

    // New gesture: drag n1 and n2 together. Mid-drag a remote client
    // deletes n2 -> the op arrives via apply() and advances the CONFIRMED state,
    // so the base recomputed at gesture end no longer has n2.
    st.beginGesture();
    st.apply(deleteOp("n2"));
    st.endGesture([moveOp("n1", 999, 999), moveOp("n2", 999, 0)]);

    // The move of n1 really happened (it was submitted).
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 999, y: 999 });
    expect(sync.sent).toHaveLength(2);
    // The chain of inverses cannot be built (n2 is gone): no new undo
    // entry -- undoing halfway would be worse.
    expect(useScene.getState().undoStack).toHaveLength(1);
    // ...but the redo stack MUST be empty all the same.
    expect(useScene.getState().redoStack).toHaveLength(0);
    expect(useScene.getState().canRedo).toBe(false);

    // And a redo() must not be able to bring n1 back to (40,40).
    st.redo();
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 999, y: 999 });
    expect(useScene.getState().redoStack).toHaveLength(0);
  });

  // --- undo/redo with an open gesture (bug found in review) ----------------
  // sync.submit would make the inverse enter the gesture's BASE (the confirmed
  // plus the in-flight ops), the one from which endGesture rebuilds the scene at
  // pointerup, corrupting both the drag in progress and the stack.
  // undo()/redo() must therefore be no-ops until
  // the gesture closes.

  it("undo() during an open gesture is a no-op: it touches neither the stack nor sends anything", () => {
    gesture([createOp("n1", 0, 0)]); // E1 = deleteNode, on top of the stack
    sync.sent = [];

    const st = useScene.getState();
    st.beginGesture(); // selectTool's drag opens the gesture
    st.applyLocal(moveOp("n1", 999, 999)); // mid-drag preview

    st.undo(); // Ctrl+Z pressed while the mouse is still down

    expect(sync.sent).toHaveLength(0); // nothing sent: neither the inverse nor anything else
    expect(useScene.getState().undoStack).toHaveLength(1); // E1 still there
    expect(useScene.getState().redoStack).toHaveLength(0);
    expect(useScene.getState().gesture).not.toBeNull(); // the gesture stays open
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 999, y: 999 }); // anteprima intatta

    // the drag continues and closes normally: it must produce a correct
    // undo entry for the MOVE, not for the creation (E1 is still fine).
    st.endGesture([moveOp("n1", 40, 40)]);

    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 40, y: 40 });
    expect(useScene.getState().undoStack).toHaveLength(2);
    expect(sync.sent).toHaveLength(1);
    expect(sync.sent[0].kind.case).toBe("setProps");

    // and the two undos work in the right order: first it undoes the move, then the creation.
    st.undo();
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 0, y: 0 });
    st.undo();
    expect(useScene.getState().scene!.nodes.at("n1")).toBeUndefined();
  });

  it("redo() during an open gesture is a no-op: it touches neither the stack nor sends anything", () => {
    gesture([createOp("n1", 0, 0)]);
    useScene.getState().undo(); // n1 disappears, E1 goes to the redo stack
    sync.sent = [];

    const st = useScene.getState();
    st.beginGesture(); // another gesture (e.g. on a different node) is open
    st.redo(); // Ctrl+Shift+Z pressed mid-drag

    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().redoStack).toHaveLength(1); // entry still there
    expect(useScene.getState().undoStack).toHaveLength(0);
    expect(useScene.getState().gesture).not.toBeNull();

    st.cancelGesture();
    st.redo(); // outside the gesture it works again
    expect(useScene.getState().scene!.nodes.at("n1")).toBeDefined();
    expect(useScene.getState().redoStack).toHaveLength(0);
  });

  it("a multi-node gesture (drag of two nodes) is undone in A SINGLE undo", () => {
    gesture([createOp("n1", 0, 0), createOp("n2", 300, 0)]);
    gesture([moveOp("n1", 10, 10), moveOp("n2", 310, 10)]);

    expect(useScene.getState().undoStack).toHaveLength(2);

    useScene.getState().undo(); // undoes the drag of BOTH nodes in one stroke

    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 0, y: 0 });
    expect(useScene.getState().scene!.nodes.at("n2")).toMatchObject({ x: 300, y: 0 });
  });

  // --- rollback and history (bug found in review) ----------------------------
  // endGesture pushes the undo entry and empties redo BEFORE the ops are
  // accepted -- it must, otherwise Ctrl+Z right after a drag would have to
  // wait for the network round trip. If the server then rejects them, that entry stays
  // on the stack with inverses computed on a state the server NEVER
  // reached: the rollback removed the change from the view and left the history
  // intact.

  it("a REJECTED gesture leaves no phantom undo entry", () => {
    gesture([createOp("n1", 0, 0)]); // REAL gesture, accepted and echoed
    expect(useScene.getState().undoStack).toHaveLength(1);

    useScene.getState().setSync(new RejectingSync());
    gesture([createOp("n5", 10, 10)]); // the server rejects it

    // The change vanishes from the view (already so) AND from the history (the fix): its
    // entry would be [deleteNode n5], and n5 never existed on the server.
    expect(useScene.getState().scene!.nodes.at("n5")).toBeUndefined();
    expect(useScene.getState().undoStack).toHaveLength(1);
    expect(useScene.getState().canUndo).toBe(true);
    expect(useScene.getState().lastError).toContain("node already exists");

    // The next Ctrl+Z must undo the REAL gesture. Without the repair it
    // would consume the phantom entry by sending deleteNode n5 -> ErrNodeNotFound
    // -> InvalidArgument -> another rollback and another banner, and the
    // previous gesture would remain NOT undone.
    useScene.getState().setSync(sync);
    sync.sent = [];
    useScene.getState().undo();

    expect(sync.sent).toHaveLength(1);
    expect(deletedId(sync.sent[0])).toBe("n1");
    expect(useScene.getState().scene!.nodes.at("n1")).toBeUndefined();
  });

  it("the redo emptied by a REJECTED gesture becomes available again", () => {
    gesture([createOp("n1", 0, 0)]);
    useScene.getState().undo(); // the "future" (re-creates n1) enters the redo stack
    expect(useScene.getState().redoStack).toHaveLength(1);

    useScene.getState().setSync(new RejectingSync());
    gesture([createOp("n5", 10, 10)]); // empties the redo... and is rejected

    // The redo had been invalidated by a change that NEVER happened: it must come back.
    expect(useScene.getState().scene!.nodes.at("n5")).toBeUndefined();
    expect(useScene.getState().redoStack).toHaveLength(1);
    expect(useScene.getState().canRedo).toBe(true);

    useScene.getState().setSync(sync);
    useScene.getState().redo();
    expect(useScene.getState().scene!.nodes.at("n1")).toBeDefined();
  });

  it("a REJECTED undo does not consume its entry", () => {
    gesture([createOp("n1", 0, 0)]);

    useScene.getState().setSync(new RejectingSync("disk full"));
    useScene.getState().undo(); // the inverse never reaches the document

    // The view went back (n1 is still there), so the history must too:
    // the entry must be put back where it was and the redo has gained nothing.
    expect(useScene.getState().scene!.nodes.at("n1")).toBeDefined();
    expect(useScene.getState().undoStack).toHaveLength(1);
    expect(useScene.getState().canUndo).toBe(true);
    expect(useScene.getState().redoStack).toHaveLength(0);
    expect(useScene.getState().canRedo).toBe(false);

    // ...and retrying must work: the rejection does not burn the undo.
    useScene.getState().setSync(sync);
    useScene.getState().undo();
    expect(useScene.getState().scene!.nodes.at("n1")).toBeUndefined();
  });

  it("a CONFIRMED gesture is no longer undoable by a later rejection", () => {
    gesture([createOp("n1", 0, 0)]); // confermato dall'eco di FakeSync

    useScene.getState().setSync(new RejectingSync());
    gesture([moveOp("n1", 40, 40)]); // rifiutato

    // Only the rejected transition is rewound: the confirmed one stays.
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 0, y: 0 });
    expect(useScene.getState().undoStack).toHaveLength(1);
    expect(useScene.getState().canUndo).toBe(true);
  });

  // --- MULTI-OP gestures landed halfway (bug found in review round 2) --------
  // A gesture is the undo's unit piece, but NOT the transport's: the outbox
  // sends one op at a time and a failure discards only the tail behind it
  // (rpc/syncClient.ts). And multi-op gestures are the norm, not an edge case:
  // selectTool emits one setProps per selected node on drag and on resize, and
  // one deleteNode per node on Delete. Rewinding the WHOLE undo entry because
  // the group's last op fell wipes out the undoability of the half that
  // was instead persisted.

  it("a multi-op gesture landed HALFWAY keeps the undo entry for the part that went through", () => {
    gesture([createOp("n1", 0, 0), createOp("n2", 300, 0)]);
    expect(useScene.getState().undoStack).toHaveLength(1);

    // Drag of n1+n2: two setProps, one gesture, one undo entry.
    const manual = new ManualSync();
    useScene.getState().setSync(manual);
    const mv1 = moveOp("n1", 40, 40);
    const mv2 = moveOp("n2", 340, 40);
    gesture([mv1, mv2]);
    expect(useScene.getState().undoStack).toHaveLength(2);

    // mv1 goes through (200 OK) but its echo has not arrived yet; mv2 dies.
    manual.reject(mv2);

    // The view: n1 stayed moved (optimistic, in flight), n2 came back.
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 40, y: 40 });
    expect(useScene.getState().scene!.nodes.at("n2")).toMatchObject({ x: 300, y: 0 });
    // The undo entry does NOT vanish: it would cover a move that on the server
    // really happened, and without it n1 stays moved and not undoable.
    // It remains, however, narrowed to the landed half only.
    expect(useScene.getState().undoStack).toHaveLength(2);
    expect(useScene.getState().undoStack[1]).toHaveLength(1);
    expect(useScene.getState().canUndo).toBe(true);

    // ...and the echo that arrives AFTER the rejection does not erase it (before the fix the
    // mark was already gone and confirmHistory was a no-op).
    manual.land(mv1);
    expect(useScene.getState().undoStack).toHaveLength(2);
    expect(useScene.getState().pending).toHaveLength(0);

    // Ctrl+Z undoes exactly the half that went through: a single op on the wire,
    // n1 goes back to the starting point, n2 is not touched.
    useScene.getState().setSync(sync);
    sync.sent = [];
    useScene.getState().undo();

    expect(sync.sent).toHaveLength(1);
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 0, y: 0 });
    expect(useScene.getState().scene!.nodes.at("n2")).toMatchObject({ x: 300, y: 0 });
  });

  it("a multi-node DELETE landed halfway stays undoable for the deleted node", () => {
    gesture([createOp("n1", 0, 0), createOp("n2", 300, 0)]);

    // Delete with two nodes selected: one deleteNode per node, one gesture.
    const manual = new ManualSync();
    useScene.getState().setSync(manual);
    const del1 = deleteOp("n1");
    const del2 = deleteOp("n2");
    gesture([del1, del2]);

    manual.land(del1); // the first is in the op-log: n1 is really deleted
    manual.reject(del2); // the second is not

    expect(useScene.getState().scene!.nodes.at("n1")).toBeUndefined();
    expect(useScene.getState().scene!.nodes.at("n2")).toBeDefined();
    // Without the repair the entry [createNode n1, createNode n2] was
    // thrown away whole: n1 deleted forever, no Ctrl+Z possible.
    expect(useScene.getState().undoStack).toHaveLength(2);
    expect(useScene.getState().undoStack[1]).toHaveLength(1);

    useScene.getState().setSync(sync);
    sync.sent = [];
    useScene.getState().undo();

    expect(sync.sent).toHaveLength(1);
    expect(sync.sent[0].kind.case).toBe("createNode");
    expect(useScene.getState().scene!.nodes.at("n1")).toBeDefined();
  });

  it("a gesture landed halfway does NOT rearm the redo stack it had emptied", () => {
    gesture([createOp("n1", 0, 0), createOp("n2", 300, 0)]);
    gesture([moveOp("n1", 40, 40)]);
    useScene.getState().undo(); // n1 goes back to (0,0); the redo has "put it back at (40,40)"
    expect(useScene.getState().redoStack).toHaveLength(1);

    const manual = new ManualSync();
    useScene.getState().setSync(manual);
    const mv1 = moveOp("n1", 999, 999);
    const mv2 = moveOp("n2", 999, 0);
    gesture([mv1, mv2]); // empties the redo; mv1 goes through, mv2 does not
    manual.land(mv1);
    manual.reject(mv2);

    // The document really changed (n1 is at 999,999 on the server): the redo
    // entry inverts a state that no longer exists. Rearming it is the same
    // silent overwrite that the unconditional emptying exists to
    // prevent (see endGesture) -- a redo would put n1 back at (40,40).
    expect(useScene.getState().redoStack).toHaveLength(0);
    expect(useScene.getState().canRedo).toBe(false);

    useScene.getState().setSync(sync);
    useScene.getState().redo();
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 999, y: 999 });
  });

  it("a multi-op gesture rejected from the FIRST op rewinds the whole entry", () => {
    gesture([createOp("n1", 0, 0)]);

    const manual = new ManualSync();
    useScene.getState().setSync(manual);
    const c2 = createOp("n2", 300, 0);
    const c3 = createOp("n3", 600, 0);
    gesture([c2, c3]);
    expect(useScene.getState().undoStack).toHaveLength(2);

    // Neither of the two landed: the drain cancels the queue FROM THE BOTTOM.
    manual.reject(c3);
    manual.reject(c2);

    // Here the total rewind is the right one: the transition never
    // happened, so the entry vanishes and the redo is back as it was.
    expect(useScene.getState().scene!.nodes.at("n2")).toBeUndefined();
    expect(useScene.getState().scene!.nodes.at("n3")).toBeUndefined();
    expect(useScene.getState().undoStack).toHaveLength(1);

    useScene.getState().setSync(sync);
    sync.sent = [];
    useScene.getState().undo();
    expect(deletedId(sync.sent[0])).toBe("n1"); // the REAL gesture
  });

  it("an undo landed halfway leaves on the stack only the part not undone", () => {
    gesture([createOp("n1", 0, 0), createOp("n2", 300, 0)]);
    // The entry is [deleteNode n2, deleteNode n1]: it is undone in reverse order.
    expect(useScene.getState().undoStack[0]).toHaveLength(2);

    const manual = new ManualSync();
    useScene.getState().setSync(manual);
    useScene.getState().undo();
    const [first, second] = manual.sent;

    manual.land(first); // n2 is deleted on the server
    manual.reject(second); // n1 no

    expect(useScene.getState().scene!.nodes.at("n2")).toBeUndefined();
    expect(useScene.getState().scene!.nodes.at("n1")).toBeDefined();
    // Putting the WHOLE entry back (as it was before the fix) would mean that the
    // next Ctrl+Z resends deleteNode n2 on a node the server has already
    // deleted -> ErrNodeNotFound -> another rollback, burned entry.
    expect(useScene.getState().undoStack).toHaveLength(1);
    expect(useScene.getState().undoStack[0]).toHaveLength(1);
    // ...and the UNDONE half has become redoable again.
    expect(useScene.getState().redoStack).toHaveLength(1);
    expect(useScene.getState().redoStack[0]).toHaveLength(1);

    useScene.getState().setSync(sync);
    sync.sent = [];
    useScene.getState().undo();
    expect(sync.sent).toHaveLength(1);
    expect(deletedId(sync.sent[0])).toBe("n1");
    expect(useScene.getState().scene!.nodes.at("n1")).toBeUndefined();
  });

  // --- MORE transitions in doubt TOGETHER (bug found in review round 3) -------
  // Every test above keeps only ONE transition in doubt at a time, so
  // `history` always has at most one mark and the COMPOSITION between marks is
  // never exercised -- and composition is precisely the property the replay
  // exists to guarantee ("the repair does not depend on the order in which
  // rejections arrive"). Two marks together are not an edge case: a slow
  // SubmitOp is enough (10s deadline, see rpc/syncClient.ts) for everything
  // the user does in the meantime to queue up behind it, still in doubt.

  it("a gesture and its undo both in doubt, both rejected: no phantom entry", () => {
    gesture([createOp("n0", 0, 0)]); // REAL gesture, confirmed by the echo
    expect(useScene.getState().undoStack).toHaveLength(1);

    // Draw a rectangle and immediately hit Ctrl+Z, with the create still in
    // flight: two transitions in doubt together, [gesture, undo].
    const manual = new ManualSync();
    useScene.getState().setSync(manual);
    const c1 = createOp("n1", 100, 100);
    gesture([c1]);
    useScene.getState().undo();
    const [, undoOp] = manual.sent;
    expect(useScene.getState().undoStack).toHaveLength(1); // n1's entry consumed
    expect(useScene.getState().redoStack).toHaveLength(1);

    // The create fails; the drain discards the queue FROM THE BOTTOM, so the rejection
    // of the undo's op arrives first.
    manual.reject(undoOp);
    manual.reject(c1);

    // n1 never existed on the server: neither its undo entry nor its redo
    // must survive, and the entry of the REAL gesture must still be there.
    expect(useScene.getState().scene!.nodes.at("n1")).toBeUndefined();
    expect(useScene.getState().undoStack).toHaveLength(1);
    expect(deletedId(useScene.getState().undoStack[0][0])).toBe("n0");
    expect(useScene.getState().redoStack).toHaveLength(0);
    expect(useScene.getState().canRedo).toBe(false);

    // The next Ctrl+Z undoes the real gesture. With the phantom entry it would send
    // deleteNode n1 -> ErrNodeNotFound -> another rollback and another banner, and n0
    // would remain not undone.
    useScene.getState().setSync(sync);
    sync.sent = [];
    useScene.getState().undo();

    expect(sync.sent).toHaveLength(1);
    expect(deletedId(sync.sent[0])).toBe("n0");
    expect(useScene.getState().scene!.nodes.at("n0")).toBeUndefined();
  });

  it("two undos in doubt, both rejected: no entry lost or duplicated", () => {
    gesture([createOp("n1", 0, 0)]);
    gesture([createOp("n2", 300, 0)]);
    expect(useScene.getState().undoStack).toHaveLength(2);

    // Two Ctrl+Z while the transport is stalled: two undo marks together, the
    // second consumes the entry that sits UNDER the one consumed by the first.
    const manual = new ManualSync();
    useScene.getState().setSync(manual);
    useScene.getState().undo(); // consuma E2 (deleteNode n2)
    useScene.getState().undo(); // consuma E1 (deleteNode n1)
    const [first, second] = manual.sent;
    expect(useScene.getState().undoStack).toHaveLength(0);

    // The transport dies: both rejected, from the bottom.
    manual.reject(second);
    manual.reject(first);

    expect(useScene.getState().scene!.nodes.at("n1")).toBeDefined();
    expect(useScene.getState().scene!.nodes.at("n2")).toBeDefined();
    // The stacks go back EXACTLY as they were: two DIFFERENT entries, in the
    // right order. With the repair broken you got [E1, E1] -- the entry of the more
    // recent gesture lost, the older one duplicated.
    const stack = useScene.getState().undoStack;
    expect(stack).toHaveLength(2);
    expect(stack.map((e) => deletedId(e[0]))).toEqual(["n1", "n2"]);
    expect(useScene.getState().redoStack).toHaveLength(0);
    expect(useScene.getState().canRedo).toBe(false);

    // And retrying undoes the two gestures, not the same one twice: with the duplicated
    // stack the second Ctrl+Z resent deleteNode n1 on an already
    // deleted node, and n2 stayed forever.
    useScene.getState().setSync(sync);
    sync.sent = [];
    useScene.getState().undo();
    useScene.getState().undo();

    expect(sync.sent.map(deletedId)).toEqual(["n2", "n1"]);
    expect(useScene.getState().scene!.nodes.at("n1")).toBeUndefined();
    expect(useScene.getState().scene!.nodes.at("n2")).toBeUndefined();
  });

  it("a gesture rewound only HALFWAY while its undo is in doubt keeps the landed half", () => {
    gesture([createOp("n1", 0, 0), createOp("n2", 300, 0)]); // confermato

    // Drag of n1+n2 (two setProps, one entry) and immediately Ctrl+Z: the gesture's
    // mark and the undo's are in doubt together.
    const manual = new ManualSync();
    useScene.getState().setSync(manual);
    const mv1 = moveOp("n1", 40, 40);
    const mv2 = moveOp("n2", 340, 40);
    gesture([mv1, mv2]);
    useScene.getState().undo();
    const [, , inv2, inv1] = manual.sent;

    // The undo does not go through at all; of the gesture only the first op goes through.
    manual.reject(inv1);
    manual.reject(inv2);
    manual.land(mv1);
    manual.reject(mv2);

    // On the server only mv1 happened: n1 is moved and must still be undone, n2 must not.
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 40, y: 40 });
    expect(useScene.getState().scene!.nodes.at("n2")).toMatchObject({ x: 300, y: 0 });
    expect(useScene.getState().undoStack).toHaveLength(2);
    // The gesture's entry stays NARROWED to the landed half: the undo's replay
    // must not be able to bring it back whole (it would resend the inverse of an mv2 that never
    // happened).
    expect(useScene.getState().undoStack[1]).toHaveLength(1);
    expect(useScene.getState().redoStack).toHaveLength(0);

    useScene.getState().setSync(sync);
    sync.sent = [];
    useScene.getState().undo();

    expect(sync.sent).toHaveLength(1);
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 0, y: 0 });
    expect(useScene.getState().scene!.nodes.at("n2")).toMatchObject({ x: 300, y: 0 });
  });

  it("an undo landed halfway finds its entry even under the replay of the gesture that had produced it", () => {
    gesture([createOp("n1", 0, 0), createOp("n2", 300, 0)]); // confermato

    const manual = new ManualSync();
    useScene.getState().setSync(manual);
    const mv1 = moveOp("n1", 40, 40);
    const mv2 = moveOp("n2", 340, 40);
    gesture([mv1, mv2]);
    manual.land(mv1); // the gesture stays in doubt (mv2 is not decided yet)
    useScene.getState().undo(); // undo mark: consumes the gesture's entry
    const [, , inv2, inv1] = manual.sent;

    // The undo lands halfway: the replay must find the consumed entry again even
    // if the gesture's mark has just REBUILT it (it is no longer the same array).
    manual.land(inv2);
    manual.reject(inv1);

    // Only the undo of mv2 happened: mv1 remains to be undone, that is ONE
    // single op.
    expect(useScene.getState().undoStack).toHaveLength(2);
    expect(useScene.getState().undoStack[1]).toHaveLength(1);

    useScene.getState().setSync(sync);
    sync.sent = [];
    useScene.getState().undo();

    expect(sync.sent).toHaveLength(1);
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 0, y: 0 });
  });

  // --- entries made STALE by a REMOTE op (finding parked at the end of M1a) ---
  // An undo/redo entry is made of ABSOLUTE inverses -- a setProps carries the
  // values in full, not a delta -- computed on a precise state. It stays
  // valid as long as the nodes it touches are not changed by SOMEONE ELSE. Afterwards there is
  // no sensible rebase: two absolute writes on the same field do not
  // merge, one of the two wins. And sending it anyway has two outcomes, both
  // silent -- it rewrites the remote change (the node is still there) or is
  // discarded by the server (the node is gone) and the entry evaporates without
  // anyone knowing why. So the stale op leaves the entry, and the user
  // reads it from the banner.

  it("a REMOTE move invalidates the queued redo: redo does not rewrite someone else's change", () => {
    gesture([createOp("n1", 0, 0)]);
    gesture([moveOp("n1", 40, 40)]);

    useScene.getState().undo(); // n1 goes back to (0,0); the redo has "put it back at (40,40)"
    expect(useScene.getState().redoStack).toHaveLength(1);
    expect(useScene.getState().canRedo).toBe(true);

    // Another client moves n1 to (500,500): it arrives via apply(), like every
    // Subscribe record that is not an echo of ours.
    useScene.getState().apply(moveOp("n1", 500, 500));
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 500, y: 500 });

    // The redo entry wrote x,y of the SAME node: it is no longer valid.
    expect(useScene.getState().redoStack).toHaveLength(0);
    expect(useScene.getState().canRedo).toBe(false);
    // And neither is the creation's undo entry: undoing it means
    // deleting the node, that is throwing away the remote change entirely.
    expect(useScene.getState().undoStack).toHaveLength(0);
    expect(useScene.getState().canUndo).toBe(false);
    // Vanishing silently would be the other half of the bug: it must be said.
    expect(useScene.getState().notice).not.toBeNull();

    // Ctrl+Shift+Z now sends nothing, and above all does not bring n1 back to
    // (40,40) on top of someone else's change.
    sync.sent = [];
    useScene.getState().redo();
    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 500, y: 500 });
  });

  it("a REMOTE DELETE invalidates the entry: redo does not evaporate silently", () => {
    gesture([createOp("n1", 0, 0)]);
    gesture([moveOp("n1", 40, 40)]);
    useScene.getState().undo();
    expect(useScene.getState().redoStack).toHaveLength(1);

    // Another client deletes n1.
    useScene.getState().apply(deleteOp("n1"));

    // The redo was [setProps n1 x=40,y=40]: on the server ErrNodeNotFound, locally
    // a no-op of applyOp. Sent anyway, the entry would have vanished
    // from the stack without doing anything and without saying anything.
    expect(useScene.getState().redoStack).toHaveLength(0);
    expect(useScene.getState().canRedo).toBe(false);
    expect(useScene.getState().undoStack).toHaveLength(0);
    expect(useScene.getState().notice).not.toBeNull();

    sync.sent = [];
    useScene.getState().redo();
    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().scene!.nodes.at("n1")).toBeUndefined();
  });

  // setText is a DEDICATED op (the content lives inside the `shape` oneof, not in
  // a mask path), so it needs its own target: without it, a remote
  // setText would make NOTHING stale and an undo entry containing
  // a setText would NEVER be invalidated -- the next Ctrl+Z
  // would silently rewrite the text just written by someone else.
  it("a REMOTE setText invalidates the undo entry of an edit on the same node", () => {
    gesture([createTextOp("t1", "ciao")]);
    gesture([setTextOp("t1", "hello world")]); // an editing session = one entry
    expect(useScene.getState().undoStack).toHaveLength(2);

    // Another client rewrites t1's text.
    useScene.getState().apply(setTextOp("t1", "written by someone else"));

    // The editing entry wrote the content of the SAME node; the creation's
    // would delete t1 (and with it the remote change).
    expect(useScene.getState().undoStack).toHaveLength(0);
    expect(useScene.getState().canUndo).toBe(false);
    expect(useScene.getState().notice).not.toBeNull();

    sync.sent = [];
    useScene.getState().undo();
    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().scene!.nodes.at("t1").text!.content).toBe("written by someone else");
  });

  // Same reason as setText, on the field this track introduces: without a
  // target for setVectorPath, a remote op on the geometry would make nothing
  // stale and the next Ctrl+Z would silently delete the path
  // just drawn by someone else.
  it("a REMOTE setVectorPath invalidates the undo entry of an edit on the same path", () => {
    gesture([createVectorOp("v1")]);
    gesture([setVectorPathOp("v1", 1)]); // an anchor drag = one entry
    expect(useScene.getState().undoStack).toHaveLength(2);

    useScene.getState().apply(setVectorPathOp("v1", 2));

    expect(useScene.getState().undoStack).toHaveLength(0);
    expect(useScene.getState().canUndo).toBe(false);
    expect(useScene.getState().notice).not.toBeNull();

    sync.sent = [];
    useScene.getState().undo();
    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().scene!.nodes.at("v1").vector!.subpaths[0].anchors[0].x).toBe(2);
  });

  // --- the box and the geometry are TWO HALVES OF THE SAME VALUE ------------
  // For a vector node the box IS the path's bbox (proto invariant on
  // VectorNode), so width/height/x/y and subpaths are not independent
  // fields. But a resize is ONE gesture with TWO ops, and the pruning of stale
  // ops works per op: if a remote record prunes only one of them, the entry
  // survives halfway and the next Ctrl+Z puts back ONE of the two halves --
  // the ink in the wrong box, or the box around the wrong ink.
  // The two tests below are the two directions of the same defect.

  it("a remote DRAG does not allow undoing HALF of a vector resize (the geometry without the box)", () => {
    gesture([createVectorBoxOp("v1", 100, 80)]);
    // ONE gesture, TWO ops: it is exactly what selectTool::resizeOps emits for
    // a vector node (the box + the geometry rewritten so it keeps
    // filling it). Entry: [inv(setVectorPath), inv(setProps x,y,width,height)].
    gesture([boxOp("v1", 0, 0, 200, 160), vectorPathOp("v1", boxPath(200, 160), "resize")]);
    expect(boxAndInk("v1").ink).toEqual(boxAndInk("v1").box);

    // Another client merely MOVES the same node: writes only x,y.
    // It touches neither the geometry nor the box size, so the invariant
    // holds -- and it is the local undo entry that must keep respecting it.
    useScene.getState().apply(moveOp("v1", 40, 40));

    sync.sent = [];
    useScene.getState().undo();

    // THE DAMAGE: before the fix inv(setProps) was pruned (it shares x,y) and
    // inv(setVectorPath) stayed (target "subpaths", disjoint), so
    // Ctrl+Z put the 100x80 geometry inside the 200x160 box -- resize
    // handles that do not touch the path and a marquee that grabs empty space.
    const g = boxAndInk("v1");
    expect(g.ink).toEqual(g.box);
    // ...and the shape in which we get there: the resize's entry falls WHOLE (and with
    // it the creation's, which would delete the node). Nothing to
    // undo, so nothing on the wire.
    expect(useScene.getState().undoStack).toHaveLength(0);
    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().notice).not.toBeNull();
  });

  it("a remote setVectorPath does not allow undoing the OTHER half of the resize (the box without the geometry)", () => {
    gesture([createVectorBoxOp("v1", 100, 80)]);
    gesture([boxOp("v1", 0, 0, 200, 160), vectorPathOp("v1", boxPath(200, 160), "resize")]);

    // Another client reshapes the path by moving an INNER anchor: the
    // bbox does not change, so the record counts on its own. (Even when the remote
    // gesture also carries its setProps, Subscribe records arrive ONE
    // AT A TIME and markStale runs per record: the window between the two is
    // observable by a Ctrl+Z.)
    useScene.getState().apply(vectorPathOp("v1", triPath(200, 160), "other"));

    sync.sent = [];
    useScene.getState().undo();

    // THE MIRROR DAMAGE: before the fix the remote record pruned
    // inv(setVectorPath) and left inv(setProps), so Ctrl+Z put the
    // 100x80 box around the other's 200x160 ink.
    const g = boxAndInk("v1");
    expect(g.ink).toEqual(g.box);
    expect(useScene.getState().undoStack).toHaveLength(0);
    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().notice).not.toBeNull();
  });

  // This test used to say "a remote setVectorPath does not touch an entry that writes
  // DISJOINT fields" and proved it on a MOVE -- the only setProps for
  // which box and geometry are truly independent (anchors are local,
  // so the ink travels with the node) -- while generalizing it to ALL
  // setProps, resize included, where they are not independent. It was the wrong
  // assumption written as a guarantee, and it is the reason the two tests above
  // passed unnoticed.
  //
  // The right version is this one, and it does not cost an undo step that was not
  // already about to fall: whoever rewrites the subpaths sends in the SAME gesture the
  // setProps{x,y,width,height} that renormalizes the box (the invariant belongs to the
  // writer), so that record would have pruned the move's entry an
  // instant later anyway. Anticipating the pruning removes nothing more --
  // it removes the WINDOW in which half an entry survives.
  it("a remote setVectorPath ALSO invalidates the entry that only MOVED the node", () => {
    gesture([createVectorBoxOp("v1", 100, 80)]);
    gesture([moveOp("v1", 40, 40)]); // entry: [setProps x,y]

    useScene.getState().apply(vectorPathOp("v1", triPath(100, 80), "other"));

    expect(useScene.getState().undoStack).toHaveLength(0);
    expect(useScene.getState().canUndo).toBe(false);

    sync.sent = [];
    useScene.getState().undo();
    expect(sync.sent).toHaveLength(0);
    // The node stays where the LAST write of each half left it:
    // moved by us, redrawn by the other. Neither of the two silently overwrites
    // the other.
    expect(useScene.getState().scene!.nodes.at("v1")).toMatchObject({ x: 40, y: 40 });
    expect(useScene.getState().scene!.nodes.at("v1").vector!.subpaths[0].anchors).toHaveLength(3);
  });

  // The complement of the test above, and the LEGITIMATE half of the one it
  // replaced: the per-field cut still exists. Widening the target of
  // setVectorPath to the box does not degrade it into "a remote op on this node
  // burns its whole history" -- a rename remains a rename.
  it("a remote setVectorPath does NOT touch an entry that writes truly disjoint fields", () => {
    gesture([createVectorBoxOp("v1", 100, 80)]);
    gesture([renameOp("v1", "Outline")]); // entry: [setProps name]

    useScene.getState().apply(vectorPathOp("v1", triPath(100, 80), "other"));

    // Only the creation's entry falls, which would delete the node (and with it
    // the other's path).
    expect(useScene.getState().undoStack).toHaveLength(1);
    useScene.getState().undo();
    expect(useScene.getState().scene!.nodes.at("v1").name).toBe("Path");
    // ...without touching the remote geometry.
    expect(useScene.getState().scene!.nodes.at("v1").vector!.subpaths[0].anchors).toHaveLength(3);
  });

  it("a remote setText does not touch an entry that writes DISJOINT fields", () => {
    gesture([createTextOp("t1", "ciao")]);
    gesture([moveOp("t1", 40, 40)]); // entry: [setProps x,y]

    useScene.getState().apply(setTextOp("t1", "other"));

    // Moving a node and rewriting its content do not overwrite each
    // other: undoing the move remains legitimate. Only the creation's
    // entry falls, which would delete the node entirely.
    expect(useScene.getState().undoStack).toHaveLength(1);
    useScene.getState().undo();
    expect(useScene.getState().scene!.nodes.at("t1")).toMatchObject({ x: 0, y: 0 });
    expect(useScene.getState().scene!.nodes.at("t1").text!.content).toBe("other");
  });

  it("a remote op on DISJOINT fields (or on another node) does not touch the entry", () => {
    gesture([createOp("n1", 0, 0)]);
    gesture([createOp("n2", 300, 0)]);
    gesture([moveOp("n1", 40, 40)]);
    useScene.getState().undo(); // redo = [setProps n1 x=40,y=40]
    expect(useScene.getState().undoStack).toHaveLength(2);

    // Another client RESIZES n1: writes width/height, not x/y.
    useScene.getState().apply(resizeOp("n1", 300, 300));

    // The redo entry writes only x,y: it keeps holding -- invalidating it
    // would mean throwing away the history on every remote change of any
    // field, and there is no overwrite to avoid.
    expect(useScene.getState().redoStack).toHaveLength(1);
    expect(useScene.getState().canRedo).toBe(true);
    // Only the entry that would delete n1 falls; n2's has nothing to do with it.
    expect(useScene.getState().undoStack).toHaveLength(1);
    expect(deletedId(useScene.getState().undoStack[0][0])).toBe("n2");

    // ...and the redo puts x,y back WITHOUT undoing the remote resize.
    useScene.getState().redo();
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({
      x: 40, y: 40, width: 300, height: 300,
    });
  });

  it("without a transport a gesture does not invalidate its OWN entry", () => {
    // Wire-less branch of endGesture/undo/redo: the op is not submitted, it is
    // applied with apply() -- the same door the remote records come in from.
    // It is ours, so it cannot make stale the entry the gesture has just
    // pushed: without the distinction, every gesture would cancel itself.
    useScene.getState().setSync(null);

    gesture([createOp("n1", 0, 0)]);
    expect(useScene.getState().undoStack).toHaveLength(1);
    expect(useScene.getState().notice).toBeNull();

    useScene.getState().undo();
    expect(useScene.getState().scene!.nodes.at("n1")).toBeUndefined();
    expect(useScene.getState().redoStack).toHaveLength(1);

    useScene.getState().redo();
    expect(useScene.getState().scene!.nodes.at("n1")).toBeDefined();
    expect(useScene.getState().undoStack).toHaveLength(1);
    expect(useScene.getState().notice).toBeNull();
  });

  it("a stale op does not come back onto the stacks when a rejection replays the history", () => {
    gesture([createOp("n1", 0, 0), createOp("n2", 300, 0)]);
    // The entry is [deleteNode n2, deleteNode n1].
    expect(useScene.getState().undoStack[0]).toHaveLength(2);

    // A gesture on n2 stays IN FLIGHT: its transition is in doubt, so the live
    // stacks are the replay of `history` on the base of its head --
    // a base snapshotted BEFORE the remote op.
    const manual = new ManualSync();
    useScene.getState().setSync(manual);
    const mv = moveOp("n2", 340, 40);
    gesture([mv]);
    expect(useScene.getState().undoStack).toHaveLength(2);

    // Another client deletes n1: the op [deleteNode n1] inside the first entry
    // is no longer valid (the server would reply ErrNodeNotFound), but the rest
    // of the entry is -- n2 still exists and is still ours to undo.
    useScene.getState().apply(deleteOp("n1"));
    expect(useScene.getState().undoStack[0]).toHaveLength(1);
    expect(deletedId(useScene.getState().undoStack[0][0])).toBe("n2");

    // The in-flight gesture is rejected: the history is replayed from the base. The
    // stale op must not re-enter from there.
    manual.reject(mv);

    expect(useScene.getState().undoStack).toHaveLength(1);
    expect(useScene.getState().undoStack[0]).toHaveLength(1);
    expect(deletedId(useScene.getState().undoStack[0][0])).toBe("n2");

    // And the only op that goes out on the wire is the one that is still valid.
    useScene.getState().setSync(sync);
    sync.sent = [];
    useScene.getState().undo();
    expect(sync.sent.map(deletedId)).toEqual(["n2"]);
  });

  it("a stale op does not come back even from the REVOCATION of a rollback", () => {
    gesture([createOp("n1", 0, 0), createOp("n2", 300, 0)]); // confermato

    const manual = new ManualSync();
    useScene.getState().setSync(manual);

    // Gesture A on n1: the request dies without a response, so the rollback is
    // visible but REVOCABLE (the op may already be in the op-log).
    const mvA = moveOp("n1", 40, 40);
    gesture([mvA]);
    manual.disown(mvA);
    expect(useScene.getState().undoStack).toHaveLength(1);

    // The user keeps working while the client reconnects: gesture B
    // on n2 stays in flight, so its transition is in doubt.
    const mvB = moveOp("n2", 340, 40);
    gesture([mvB]);
    expect(useScene.getState().undoStack).toHaveLength(2);

    // Another client deletes n2: B's entry falls (it would put n2 back at (300,0))
    // and the [deleteNode n2] op falls inside the creation's entry.
    useScene.getState().apply(deleteOp("n2"));
    expect(useScene.getState().undoStack).toHaveLength(1);
    expect(useScene.getState().undoStack[0]).toHaveLength(1);

    // The backlog replays mvA: the rollback was a lie, and its undo entry
    // goes back into the history's BASE (restoreRevoked). That replay restarts from
    // stacks snapshotted before the remote delete: stale ops must
    // not re-enter from there.
    manual.land(mvA);

    const stack = useScene.getState().undoStack;
    expect(stack).toHaveLength(2); // the creation (reduced) + the revoked entry
    expect(stack.flat().some((op) => op.kind.case === "setProps" && op.kind.value.id === "n2")).toBe(false);
    expect(stack.flat().some((op) => deletedId(op) === "n2")).toBe(false);

    // ...and the two Ctrl+Z that remain do only still-valid things: they put n1
    // back in its place and then delete it. n2 is never touched.
    useScene.getState().setSync(sync);
    sync.sent = [];
    useScene.getState().undo();
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 0, y: 0 });
    useScene.getState().undo();
    expect(useScene.getState().scene!.nodes.at("n1")).toBeUndefined();
    expect(sync.sent).toHaveLength(2);
  });

  it("a redo landed halfway leaves on the stack only the part not redone", () => {
    gesture([createOp("n1", 0, 0), createOp("n2", 300, 0)]);
    useScene.getState().undo(); // both disappear; the redo re-creates them
    expect(useScene.getState().redoStack[0]).toHaveLength(2);

    const manual = new ManualSync();
    useScene.getState().setSync(manual);
    useScene.getState().redo();
    const [first, second] = manual.sent;

    manual.land(first); // the first node is back in the op-log
    manual.reject(second); // the second does not

    expect(useScene.getState().redoStack).toHaveLength(1);
    expect(useScene.getState().redoStack[0]).toHaveLength(1);
    // ...and the redone half is undoable again.
    expect(useScene.getState().undoStack).toHaveLength(1);
    expect(useScene.getState().undoStack[0]).toHaveLength(1);

    useScene.getState().setSync(sync);
    useScene.getState().redo();
    expect([...useScene.getState().scene!.nodes.ids()].sort()).toEqual(["n1", "n2"]);
  });
  // --- the tree: cascade and history ----------------------------------------
  // deleteNode deletes a SUBTREE (core.applyDelete / applyOp), so
  // the inverse of ONE op is many createNodes. It is the only case where the undo
  // entry is longer than the gesture that produced it, and the place where the
  // "one direct op, one inverse" hypothesis that invertChain rested on broke.

  it("a gesture that deletes a group is undone in ONE entry, with the whole subtree", () => {
    gesture([
      createChildOp("g1", "page1", "a1"),
      createChildOp("c1", "g1", "a1"),
      createChildOp("d1", "c1", "a1"),
      createChildOp("c2", "g1", "a2"),
    ]);
    const before = useScene.getState().scene;

    gesture([deleteOp("g1")]); // a single op: the server cascades on its own
    expect([...useScene.getState().scene!.nodes.ids()]).toEqual([]);

    // A single entry (one gesture = one Ctrl+Z), made of four createNodes.
    const entry = useScene.getState().undoStack[1];
    expect(entry).toHaveLength(4);
    expect(entry.every((op) => op.kind.case === "createNode")).toBe(true);

    useScene.getState().undo();
    expect(useScene.getState().scene).toEqual(before);

    // ...and the redo deletes everything again with the starting single op.
    useScene.getState().redo();
    expect([...useScene.getState().scene!.nodes.ids()]).toEqual([]);
  });

  it("a REMOTE cascading delete also invalidates the entries that touch the DESCENDANTS", () => {
    gesture([
      createChildOp("g1", "page1", "a1"),
      createChildOp("c1", "g1", "a1"),
    ]);
    gesture([moveOp("c1", 40, 40)]); // entry: [setProps c1 x,y]
    expect(useScene.getState().undoStack).toHaveLength(2);

    // Another client deletes the GROUP: the op names g1, but takes c1 away.
    useScene.getState().apply(deleteOp("g1"));

    // Without the cascade expansion the entry on c1 would stay there, and the
    // next Ctrl+Z would send a setProps on a node that no longer exists
    // (server rejection, red banner, burned entry).
    expect(useScene.getState().undoStack).toHaveLength(0);
    expect(useScene.getState().canUndo).toBe(false);
    expect(useScene.getState().notice).not.toBeNull();

    sync.sent = [];
    useScene.getState().undo();
    expect(sync.sent).toHaveLength(0);
  });

  // An entry that RESTORES a cascade ([createNode g1, c1, d1]) is valid only
  // as long as every createNode finds its own parent already re-created. Filtering it
  // op by op against the ops made stale breaks it: a remote op touches ONE node,
  // so it marks its createNode and not those of its children. See pruneEntry
  // in store.ts.

  it("a remote op on a DESCENDANT also takes its children away from the restore entry", () => {
    gesture([
      createChildOp("g1", "page1", "a1"),
      createChildOp("c1", "g1", "a1"),
      createChildOp("d1", "c1", "a1"),
    ]);
    gesture([deleteOp("g1")]); // entry: [createNode g1, createNode c1, createNode d1]
    expect(useScene.getState().undoStack[1]).toHaveLength(3);

    // Another client had moved c1 BEFORE our delete: the op arrives
    // now and makes c1's createNode stale -- but not d1's, which has a
    // different target and would stay in the entry as an ORPHAN.
    useScene.getState().apply(moveOp("c1", 5, 5));

    const stack = useScene.getState().undoStack;
    const entry = stack[stack.length - 1];
    expect(createdIds(entry)).toEqual(["g1"]);
    expectParentsSatisfied(entry);

    // And the undo goes through WHOLE: a single op on the wire, landed, with its
    // redo entry. Without the pruning invertChain returned null on createNode
    // d1 (no redo recorded) and the server rejected the op with
    // ErrParentNotFound -- red banner and half-done document.
    sync.sent = [];
    useScene.getState().undo();
    expect(sync.sent).toHaveLength(1);
    expect([...useScene.getState().scene!.nodes.ids()]).toEqual(["g1"]);
    expect(useScene.getState().canRedo).toBe(true);
  });

  it("a remote op on the ROOT of the cascade takes away the whole restore entry", () => {
    gesture([
      createChildOp("g1", "page1", "a1"),
      createChildOp("c1", "g1", "a1"),
      createChildOp("d1", "c1", "a1"),
    ]);
    gesture([deleteOp("g1")]);
    const before = useScene.getState().undoStack.length;

    // Stale on g1's createNode only: c1 and d1 are not targets of the remote
    // op, and without propagation the entry would stay made of two createNodes
    // without their container.
    useScene.getState().apply(moveOp("g1", 5, 5));

    const stack = useScene.getState().undoStack;
    expect(stack).toHaveLength(before - 1);
    for (const entry of stack) expectParentsSatisfied(entry);

    // Nothing to undo for that delete: the next Ctrl+Z touches
    // the PREVIOUS gesture (the creation), it does not send half a subtree to the server.
    sync.sent = [];
    useScene.getState().undo();
    expect(sync.sent.every((op) => op.kind.case === "deleteNode")).toBe(true);
  });

  it("a REMOTE reparent invalidates a local reorder of the same node, not a move", () => {
    gesture([
      createChildOp("g1", "page1", "a1"),
      createChildOp("c1", "g1", "a1"),
    ]);
    gesture([moveOp("c1", 40, 40)]);        // entry: [setProps c1 x,y]
    gesture([reorderOp("c1", "a5")]);       // entry: [setProps c1 order_key]
    expect(useScene.getState().undoStack).toHaveLength(3);

    useScene.getState().apply(reparentOp("c1", "page1", "a7"));

    // The reorder falls (it writes order_key, which the reparent rewrites) and the
    // [deleteNode c1] of the creation entry falls (it would delete the node just
    // moved by another). The move stays -- x/y have nothing to do with
    // reparenting -- and the creation's [deleteNode g1]: AFTER the reparent
    // the group is empty, so deleting it no longer takes c1 away.
    const stack = useScene.getState().undoStack;
    expect(stack).toHaveLength(2);
    expect(stack[0].map(deletedId)).toEqual(["g1"]);
    expect(stack[1][0].kind.case === "setProps" && stack[1][0].kind.value.mask?.paths).toEqual(["x", "y"]);
  });

  // The cascade looks in TWO directions, and the two want two different scenes
  // (see markStale). A remote op that INSERTS a node into a subtree does not
  // touch any node the previous document contained: measured on
  // that, an entry that deletes the container conflicts with nothing and
  // survives -- and the next Ctrl+Z silently takes away the other client's node,
  // without even the STALE banner.

  it("a REMOTE createNode inside a group invalidates the entry that would delete the group", () => {
    gesture([createChildOp("g1", "page1", "a1")]); // entry: [deleteNode g1]
    expect(useScene.getState().undoStack.map((e) => e.map(deletedId))).toEqual([["g1"]]);

    // Another client creates a node INSIDE g1.
    useScene.getState().apply(createChildOp("c1", "g1", "a1"));
    expect(useScene.getState().scene!.nodes.at("c1")).toBeDefined();

    // From now on [deleteNode g1] cascades onto c1: it is no longer undoable.
    expect(useScene.getState().undoStack).toHaveLength(0);
    expect(useScene.getState().canUndo).toBe(false);
    expect(useScene.getState().notice).not.toBeNull();

    // Ctrl+Z sends nothing, and above all does not destroy the other's node.
    sync.sent = [];
    useScene.getState().undo();
    expect(sync.sent).toHaveLength(0);
    expect([...useScene.getState().scene!.nodes.ids()].sort()).toEqual(["c1", "g1"]);
  });

  it("a REMOTE reparent that INSERTS a node into the group invalidates the entry that would delete it", () => {
    gesture([createChildOp("g1", "page1", "a1")]); // entry: [deleteNode g1]

    // The other client's node is born OUTSIDE g1: our entry deletes an
    // empty group and stays legitimate (invalidating it here would be throwing away an
    // undo step for nothing).
    useScene.getState().apply(createChildOp("c1", "page1", "a9"));
    expect(useScene.getState().undoStack.map((e) => e.map(deletedId))).toEqual([["g1"]]);
    expect(useScene.getState().notice).toBeNull();

    // ...then INSERTS it inside g1, and from there the entry would destroy its work.
    useScene.getState().apply(reparentOp("c1", "g1", "a1"));
    expect(useScene.getState().undoStack).toHaveLength(0);
    expect(useScene.getState().notice).not.toBeNull();

    sync.sent = [];
    useScene.getState().undo();
    expect(sync.sent).toHaveLength(0);
    expect([...useScene.getState().scene!.nodes.ids()].sort()).toEqual(["c1", "g1"]);
  });

  it("a REMOTE reparent that TAKES a node AWAY from the group leaves standing the entry that deletes it", () => {
    gesture([createChildOp("g1", "page1", "a1")]);
    gesture([createChildOp("c1", "g1", "a1")]);
    expect(useScene.getState().undoStack.map((e) => e.map(deletedId))).toEqual([["g1"], ["c1"]]);

    // The opposite direction: another client pulls c1 OUT of g1.
    useScene.getState().apply(reparentOp("c1", "page1", "a7"));

    // The entry on c1 dies (the reparent rewrites its parent and order_key), the one
    // on g1 does not: on the NEW document deleting g1 no longer touches c1, so there is
    // no one else's work to rewrite and the undo step stays.
    expect(useScene.getState().undoStack.map((e) => e.map(deletedId))).toEqual([["g1"]]);

    useScene.getState().undo();
    expect(useScene.getState().scene!.nodes.at("g1")).toBeUndefined();
    expect(useScene.getState().scene!.nodes.at("c1")).toMatchObject({ parentId: "page1" });
  });

  it("a REDO entry that re-deletes a group falls if a remote put something inside it", () => {
    gesture([createChildOp("g1", "page1", "a1")]);
    gesture([deleteOp("g1")]);   // undo entry: [createNode g1]
    useScene.getState().undo();  // g1 comes back; the redo has "delete it again"
    expect(useScene.getState().redoStack.map((e) => e.map(deletedId))).toEqual([["g1"]]);

    // Another client works inside g1 while the redo is queued.
    useScene.getState().apply(createChildOp("c1", "g1", "a1"));

    expect(useScene.getState().redoStack).toHaveLength(0);
    expect(useScene.getState().canRedo).toBe(false);
    expect(useScene.getState().notice).not.toBeNull();

    sync.sent = [];
    useScene.getState().redo();
    expect(sync.sent).toHaveLength(0);
    expect([...useScene.getState().scene!.nodes.ids()].sort()).toEqual(["c1", "g1"]);
  });

  // --- the remote cascade takes away the DEPENDENCIES too, not just the targets --
  // The comparison by target looks at the node an op NAMES. Since the
  // scene became a tree, an op can depend on a node it does not name: a
  // createNode requires its own CONTAINER to exist (ErrParentNotFound), and
  // that container may have ended up inside the cascade of a remote delete
  // without any target saying so. See requiredParent/markStale in
  // store.ts.

  it("a remote deletion of the PARENT invalidates the entry that would re-create the child", () => {
    const strict = new ValidatingSync();
    useScene.getState().setSync(strict);

    gesture([createChildOp("g1", "page1", "a1")]); // A: entry [deleteNode g1]
    gesture([createChildOp("c1", "g1", "a1")]);    // B: entry [deleteNode c1]
    gesture([deleteOp("c1")]);                     // C: entry [createNode c1 UNDER g1]
    expect(useScene.getState().undoStack).toHaveLength(3);
    expect(useScene.getState().undoStack.flatMap(createdIds)).toEqual(["c1"]);

    // Another client deletes the GROUP. The cascade, measured on the document on
    // which the remote op lands, is only g1: c1 is no longer in there
    // (we deleted it), so no target of the remote op NAMES
    // c1 -- and entry C names g1 nowhere.
    useScene.getState().apply(deleteOp("g1"));

    // ...but C re-creates c1 INSIDE g1, and g1 no longer exists: the entry can no longer
    // land, so it must not stay on the stack.
    expect(useScene.getState().undoStack.flatMap(createdIds)).toEqual([]);
    for (const entry of useScene.getState().undoStack) expectParentsSatisfied(entry);
    expect(useScene.getState().notice).not.toBeNull();

    // And the stack DRAINS. Without the invalidation, Ctrl+Z sent createNode c1
    // under a nonexistent g1: the server rejected (ErrParentNotFound), the red
    // banner appeared, invertOp returned null (no redo recorded)
    // and revertHistory put C back on the stack -- the next Ctrl+Z
    // picked it up again, forever.
    strict.sent = [];
    for (let i = 0; i < 5 && useScene.getState().canUndo; i++) useScene.getState().undo();
    expect(useScene.getState().undoStack).toEqual([]);
    expect(useScene.getState().lastError).toBeNull();
  });

  // The opposite direction of the same rule: pruning an entry WITHOUT cause silently loses
  // an undo step of the user, which is a defect equal to the other.
  // Only a delete makes nodes DISAPPEAR; a reparent leaves them all standing,
  // only elsewhere, so every container an entry requires is still there.

  it("a REMOTE reparent that moves the container does not invalidate the entry that re-creates the child", () => {
    const strict = new ValidatingSync();
    useScene.getState().setSync(strict);

    gesture([
      createChildOp("g1", "page1", "a1"),
      createChildOp("f1", "page1", "a2"),
      createChildOp("c1", "g1", "a1"),
    ]);
    gesture([deleteOp("c1")]); // entry: [createNode c1 under g1]

    // Another client puts g1 inside f1: the entry's container still
    // exists, it has just changed home.
    useScene.getState().apply(reparentOp("g1", "f1", "a1"));

    const stack = useScene.getState().undoStack;
    expect(stack.flatMap(createdIds)).toEqual(["c1"]);
    for (const entry of stack) expectParentsSatisfied(entry);

    // ...and Ctrl+Z re-creates c1 for real, under g1, where g1 is NOW.
    useScene.getState().undo();
    expect(useScene.getState().scene!.nodes.at("c1")).toMatchObject({ parentId: "g1" });
    expect(useScene.getState().lastError).toBeNull();
  });

  it("a remote deletion ELSEWHERE does not touch the entry that re-creates under another container", () => {
    const strict = new ValidatingSync();
    useScene.getState().setSync(strict);

    gesture([
      createChildOp("g1", "page1", "a1"),
      createChildOp("g2", "page1", "a2"),
      createChildOp("c1", "g1", "a1"),
    ]);
    gesture([deleteOp("c1")]); // entry: [createNode c1 under g1]

    // The remote cascade takes away g2, which has nothing to do with c1: the entry
    // stays exactly as it was.
    useScene.getState().apply(deleteOp("g2"));

    expect(useScene.getState().undoStack.flatMap(createdIds)).toEqual(["c1"]);

    useScene.getState().undo();
    expect(useScene.getState().scene!.nodes.at("c1")).toMatchObject({ parentId: "g1" });
    expect(useScene.getState().lastError).toBeNull();
  });
});

// --- undo/redo of PAGE ACTIONS ---------------------------------------------
// Pages are the ROOT containers (a parentId can be the id of a node or
// that of a Page): creating, renaming and deleting them goes through the same
// gesture path as the tools (PageBar -> beginGesture/endGesture), so the
// same rule as all the other panels holds -- one gesture = one undo entry.
// Deletion is the most insidious: like deleteNode it takes away a whole
// subtree in CASCADE, and without an undo entry the page and its nodes would vanish
// forever.
describe("undo/redo of page actions", () => {
  let sync: FakeSync;

  beforeEach(() => {
    sync = new FakeSync();
    useScene.setState({
      selection: [],
      marquee: null,
      gesture: null,
      undoStack: [],
      redoStack: [],
    });
    useScene.getState().setScene(emptyScene("doc1", "Untitled"));
    useScene.getState().setSync(sync);
  });

  it("deleting a page is undoable: Ctrl+Z restores the page AND its nodes", () => {
    const st = useScene.getState();
    // page2 with 3 rectangles, exactly the finding's scenario.
    gesture([createPageOp("page2", "Page 2")]);
    gesture([createChildOp("r1", "page2", "a1")]);
    gesture([createChildOp("r2", "page2", "a2")]);
    gesture([createChildOp("r3", "page2", "a3")]);

    const before = useScene.getState().scene;
    expect(before!.pages.map((p) => p.id)).toEqual(["page1", "page2"]);
    expect(["r1", "r2", "r3"].every((id) => before!.nodes.at(id))).toBe(true);
    expect(useScene.getState().undoStack).toHaveLength(4);

    // Delete page2: the cascade takes away page2 and its 3 nodes.
    gesture([deletePageOp("page2")]);
    expect(useScene.getState().scene!.pages.map((p) => p.id)).toEqual(["page1"]);
    for (const id of ["r1", "r2", "r3"]) expect(useScene.getState().scene!.nodes.at(id)).toBeUndefined();
    // The gesture's undo entry EXISTS: before the fix invertChain fell to null
    // and the gesture left no entry, while the op went out anyway.
    expect(useScene.getState().undoStack).toHaveLength(5);

    // Ctrl+Z: page2 and the 3 rectangles come back, identical to how they were.
    st.undo();
    expect(useScene.getState().scene).toEqual(before);
    expect(useScene.getState().lastError).toBeNull();

    // ...and the redo deletes them again (gesture symmetry).
    st.redo();
    expect(useScene.getState().scene!.pages.map((p) => p.id)).toEqual(["page1"]);
    for (const id of ["r1", "r2", "r3"]) expect(useScene.getState().scene!.nodes.at(id)).toBeUndefined();
  });

  it("the inverse of a deletion re-creates the PAGE before the nodes, every parent before the children", () => {
    gesture([createPageOp("page2", "Page 2")]);
    gesture([createChildOp("g1", "page2", "a1")]);
    gesture([createChildOp("c1", "g1", "a1")]);
    gesture([createChildOp("d1", "c1", "a1")]);

    gesture([deletePageOp("page2")]);
    // The undo entry is createPage + 3 createNode, in parent-first order:
    // applying it, every createNode finds its own container already re-created.
    // (expectParentsSatisfied is not needed here: it presupposes the page already present
    // in the scene, while this entry RE-CREATES it -- the proof that the parents hold
    // is the real Ctrl+Z of the test above, which recomposes the scene without errors.)
    const entry = useScene.getState().undoStack[useScene.getState().undoStack.length - 1];
    expect(entry[0].kind.case).toBe("createPage");
    expect(createdIds(entry)).toEqual(["g1", "c1", "d1"]);
  });

  it("creating a page is undoable: Ctrl+Z removes it", () => {
    gesture([createPageOp("page2", "Page 2")]);
    expect(useScene.getState().scene!.pages.map((p) => p.id)).toEqual(["page1", "page2"]);
    expect(useScene.getState().undoStack).toHaveLength(1);

    useScene.getState().undo();
    expect(useScene.getState().scene!.pages.map((p) => p.id)).toEqual(["page1"]);
    expect(useScene.getState().redoStack).toHaveLength(1);

    useScene.getState().redo();
    expect(useScene.getState().scene!.pages.map((p) => p.id)).toEqual(["page1", "page2"]);
  });

  it("renaming a page is undoable: Ctrl+Z restores the previous name", () => {
    gesture([renamePageOp("page1", "Cover")]);
    expect(useScene.getState().scene!.pages[0].name).toBe("Cover");

    useScene.getState().undo();
    expect(useScene.getState().scene!.pages[0].name).toBe("Page 1");

    useScene.getState().redo();
    expect(useScene.getState().scene!.pages[0].name).toBe("Cover");
  });
});
