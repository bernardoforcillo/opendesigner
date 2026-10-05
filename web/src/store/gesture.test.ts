import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { create } from "@bufbuild/protobuf";
import { NodeSchema, OpSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "./store";
import { emptyScene } from "./types";

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

function rectNode(id: string, x: number, y: number) {
  return create(NodeSchema, {
    id, parentId: "page1", orderKey: "a0", name: "Rect", visible: true, opacity: 1,
    x, y, width: 100, height: 80,
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
  return create(OpSchema, { opId: "del-" + id, docId: "doc1", kind: { case: "deleteNode", value: { id } } });
}

function createTextOp(id: string, content: string): Op {
  const node = create(NodeSchema, {
    id, parentId: "page1", orderKey: "a1", name: "Text", visible: true, opacity: 1,
    x: 0, y: 0, width: 200, height: 20,
    shape: { case: "text", value: { content } },
  });
  return create(OpSchema, {
    opId: "new-" + id, docId: "doc1", kind: { case: "createNode", value: { node } },
  });
}

// `fontSize` present => the op also carries the STYLE (style_present), as the
// properties panel of Task 10 will; absent => content only, like the
// editing overlay's textarea.
function setTextOp(id: string, content: string, fontSize?: number): Op {
  return create(OpSchema, {
    opId: `txt-${id}-${content}-${fontSize ?? ""}`, docId: "doc1",
    kind: {
      case: "setText",
      value: fontSize === undefined
        ? { id, content }
        : { id, content, style: { fontSize }, stylePresent: true },
    },
  });
}

function createVectorOp(id: string): Op {
  const node = create(NodeSchema, {
    id, parentId: "page1", orderKey: "a2", name: "Path", visible: true, opacity: 1,
    x: 0, y: 0, width: 100, height: 80,
    shape: { case: "vector", value: { subpaths: [{ anchors: [{ x: 0, y: 0 }], closed: false }] } },
  });
  return create(OpSchema, {
    opId: "new-" + id, docId: "doc1", kind: { case: "createNode", value: { node } },
  });
}

// An anchor drag: the op carries the WHOLE geometry on every
// pointermove (setVectorPath is wholesale), not the delta of the moved point.
function setVectorPathOp(id: string, x: number, y: number): Op {
  return create(OpSchema, {
    opId: `vec-${id}-${x}-${y}`, docId: "doc1",
    kind: {
      case: "setVectorPath",
      value: { id, subpaths: [{ anchors: [{ x: 0, y: 0 }, { x, y }], closed: false }] },
    },
  });
}

describe("gesture coalescing", () => {
  let sync: FakeSync;

  beforeEach(() => {
    sync = new FakeSync();
    useScene.setState({ selection: [], marquee: null, gesture: null });
    // setScene and not setState({scene}): installs a COHERENT scene (view and
    // confirmed aligned, empty queue) -- the invariant confirmed/pending
    // reconciliation rests on (see store.ts).
    useScene.getState().setScene(emptyScene("doc1", "Untitled"));
    useScene.getState().setSync(sync);
    // two starting nodes, created outside the gesture
    sync.submit(createOp("n1", 0, 0));
    sync.submit(createOp("n2", 300, 0));
    sync.sent = [];
  });

  it("sends A SINGLE op for a drag of 20 pointermoves (M0 debt: it used to send ~20)", () => {
    const st = useScene.getState();
    st.beginGesture();
    for (let i = 1; i <= 20; i++) st.applyLocal(moveOp("n1", i * 10, i * 5));

    // during the gesture: local preview updated, but nothing on the wire
    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 200, y: 100 });

    st.endGesture([moveOp("n1", 200, 100)]);

    expect(sync.sent).toHaveLength(1);
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 200, y: 100 });
  });

  it("a gesture on several nodes sends one op PER NODE, not one per pointermove", () => {
    const st = useScene.getState();
    st.beginGesture();
    for (let i = 1; i <= 20; i++) {
      st.applyLocal(moveOp("n1", i, i));
      st.applyLocal(moveOp("n2", 300 + i, i));
    }
    st.endGesture([moveOp("n1", 20, 20), moveOp("n2", 320, 20)]);

    expect(sync.sent).toHaveLength(2);
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 20, y: 20 });
    expect(useScene.getState().scene!.nodes.at("n2")).toMatchObject({ x: 320, y: 20 });
  });

  it("the final state is snapshot + final ops: previews do not stay attached", () => {
    const st = useScene.getState();
    st.beginGesture();
    // preview touching width/height, fields the final op does NOT contain
    st.applyLocal(resizeOp("n1", 999, 999));
    st.endGesture([moveOp("n1", 50, 60)]);

    const n1 = useScene.getState().scene!.nodes.at("n1");
    expect(n1).toMatchObject({ x: 50, y: 60, width: 100, height: 80 });
  });

  it("cancelGesture brings the scene back to the gesture-start state without sending anything", () => {
    const before = useScene.getState().scene;
    const st = useScene.getState();
    st.beginGesture();
    for (let i = 1; i <= 20; i++) st.applyLocal(moveOp("n1", i * 10, i * 5));
    st.cancelGesture();

    expect(useScene.getState().scene).toEqual(before);
    expect(sync.sent).toHaveLength(0);
  });

  it("cancelGesture also restores the selection (delete gesture cancelled)", () => {
    useScene.getState().setSelection(["n1", "n2"]);
    const st = useScene.getState();
    st.beginGesture();
    st.applyLocal(deleteOp("n1"));
    expect(useScene.getState().selection).toEqual(["n2"]); // selection invariant

    st.cancelGesture();
    expect(useScene.getState().selection).toEqual(["n1", "n2"]);
    expect(useScene.getState().scene!.nodes.at("n1")).toBeDefined();
  });

  it("a gesture without final ops changes nothing and sends nothing", () => {
    const before = useScene.getState().scene;
    const st = useScene.getState();
    st.beginGesture();
    st.applyLocal(moveOp("n1", 7, 7));
    st.endGesture([]);

    expect(useScene.getState().scene).toEqual(before);
    expect(sync.sent).toHaveLength(0);
  });

  it("endGesture closes the gesture: a subsequent cancelGesture restores nothing", () => {
    const st = useScene.getState();
    st.beginGesture();
    st.applyLocal(moveOp("n1", 40, 40));
    st.endGesture([moveOp("n1", 40, 40)]);
    st.cancelGesture();

    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 40, y: 40 });
    expect(sync.sent).toHaveLength(1);
  });

  it("consecutive gestures each start from their own snapshot", () => {
    const st = useScene.getState();
    st.beginGesture();
    st.applyLocal(moveOp("n1", 40, 40));
    st.endGesture([moveOp("n1", 40, 40)]);

    st.beginGesture();
    st.applyLocal(moveOp("n1", 900, 900));
    st.cancelGesture();

    // goes back to the result of the FIRST gesture, not to the initial state
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 40, y: 40 });
  });

  it("applyLocal outside a gesture updates only the local state", () => {
    useScene.getState().applyLocal(moveOp("n1", 12, 34));
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 12, y: 34 });
    expect(sync.sent).toHaveLength(0);
  });

  // --- authoritative ops that arrived WHILE the gesture was open -----------
  // apply() is the entry point of the remote stream (rpc/syncClient.ts): it makes the
  // CONFIRMED document advance, which is also the base from which endGesture and
  // cancelGesture rebuild the scene. Those records therefore survive by
  // construction: SyncClient advances its own seq as soon as it consumes them and will
  // never see them again, so discarding them would be a permanent desync until reload.

  it("a remote op that arrived during the gesture survives endGesture", () => {
    const st = useScene.getState();
    st.beginGesture();
    st.applyLocal(moveOp("n1", 5, 5)); // anteprima del drag locale

    // the other tab creates a node and moves another: arrives via apply()
    st.apply(createOp("n3", 700, 700));
    st.apply(moveOp("n2", 333, 44));

    st.applyLocal(moveOp("n1", 200, 100)); // the drag continues

    st.endGesture([moveOp("n1", 200, 100)]);

    const scene = useScene.getState().scene!;
    expect(scene.nodes.at("n1")).toMatchObject({ x: 200, y: 100 }); // local gesture
    expect(scene.nodes.at("n3")).toBeDefined(); // creazione remota NON persa
    expect(scene.nodes.at("n2")).toMatchObject({ x: 333, y: 44 }); // modifica remota NON persa
    expect(sync.sent).toHaveLength(1); // and always a single op on the wire
  });

  it("a remote op that arrived during the gesture survives cancelGesture", () => {
    const st = useScene.getState();
    st.beginGesture();
    st.applyLocal(moveOp("n1", 900, 900));
    st.apply(createOp("n3", 700, 700));
    st.cancelGesture();

    const scene = useScene.getState().scene!;
    // undoing one's OWN gesture does not undo OTHERS' changes
    expect(scene.nodes.at("n1")).toMatchObject({ x: 0, y: 0 });
    expect(scene.nodes.at("n3")).toBeDefined();
    expect(sync.sent).toHaveLength(0);
  });

  it("a remote delete during the gesture does not resurrect the node with cancelGesture", () => {
    useScene.getState().setSelection(["n1", "n2"]);
    const st = useScene.getState();
    st.beginGesture();
    st.applyLocal(moveOp("n1", 40, 40));
    st.apply(deleteOp("n2")); // the other tab deletes n2

    st.cancelGesture();

    const scene = useScene.getState().scene!;
    expect(scene.nodes.at("n2")).toBeUndefined();
    // the restored selection stays pruned: no handles on a dead node
    expect(useScene.getState().selection).toEqual(["n1"]);
  });

  it("a remote delete during the gesture prunes the selection even after endGesture", () => {
    useScene.getState().setSelection(["n1", "n2"]);
    const st = useScene.getState();
    st.beginGesture();
    st.apply(deleteOp("n2"));
    st.endGesture([moveOp("n1", 40, 40)]);

    expect(useScene.getState().scene!.nodes.at("n2")).toBeUndefined();
    expect(useScene.getState().selection).toEqual(["n1"]);
  });

  // --- selection of nodes created BY the gesture itself --------------------
  // The "draw and select" flow of Tasks 8/9: the tool creates the node as a
  // preview with applyLocal, selects it immediately (handles follow the
  // drag) and at gesture end sends the definitive createNode. The selection must
  // survive: at gesture close the node EXISTS.

  it("a node created by the gesture's final ops stays selected", () => {
    const st = useScene.getState();
    st.beginGesture();
    st.applyLocal(createOp("n9", 10, 10)); // preview of the node being drawn
    st.setSelection(["n9"]); // the tool selects it immediately, mid-drag
    expect(useScene.getState().selection).toEqual(["n9"]);

    st.endGesture([createOp("n9", 10, 10)]);

    expect(useScene.getState().scene!.nodes.at("n9")).toBeDefined();
    expect(useScene.getState().selection).toEqual(["n9"]);
  });

  it("the node created by a NON-first final op also stays selected", () => {
    // Pruning cannot happen op by op: after the first createNode the
    // second node does not exist yet and would be thrown out forever.
    const st = useScene.getState();
    st.beginGesture();
    st.applyLocal(createOp("n9", 10, 10));
    st.applyLocal(createOp("n10", 20, 20));
    st.setSelection(["n9", "n10"]);

    st.endGesture([createOp("n9", 10, 10), createOp("n10", 20, 20)]);

    expect(useScene.getState().selection).toEqual(["n9", "n10"]);
  });

  it("a preview-only node, not confirmed by the final ops, leaves the selection", () => {
    const st = useScene.getState();
    st.beginGesture();
    st.applyLocal(createOp("n9", 10, 10));
    st.setSelection(["n1", "n9"]);

    st.endGesture([]); // aborted gesture: no final ops, n9 does not really exist

    expect(useScene.getState().scene!.nodes.at("n9")).toBeUndefined();
    expect(useScene.getState().selection).toEqual(["n1"]); // no hanging handles
  });

  it("a selection changed mid-gesture to existing nodes survives endGesture", () => {
    useScene.getState().setSelection(["n1"]);
    const st = useScene.getState();
    st.beginGesture();
    st.setSelection(["n2"]); // the tool changes selection during the gesture
    st.endGesture([moveOp("n2", 44, 44)]);

    expect(useScene.getState().selection).toEqual(["n2"]);
  });

  // --- preview cost --------------------------------------------------------
  // Preview ops do not end up on the wire, but stay in the gesture's state
  // as long as the gesture is open: viewOf REPLAYS them all (with a full
  // clone of the nodes map per op) on every recomputation of the view, that is on
  // every authoritative record that lands mid-drag. Accumulating one per
  // pointermove PER NODE makes the drag quadratic in its own duration --
  // 50 nodes for 5s at 60Hz = 15,000 entries. By coalescing per target the preview
  // stays as large as the selection, forever.

  it("a long drag does NOT accumulate a preview per pointermove", () => {
    const st = useScene.getState();
    st.beginGesture();
    for (let i = 1; i <= 200; i++) st.applyLocal(moveOp("n1", i * 10, i * 5));

    expect(useScene.getState().gesture!.preview.size).toBe(1);
    // ...and the last position is still the right one.
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 2000, y: 1000 });
  });

  it("a drag on several nodes keeps ONE preview entry per node", () => {
    const st = useScene.getState();
    st.beginGesture();
    for (let i = 1; i <= 50; i++) {
      st.applyLocal(moveOp("n1", i, i));
      st.applyLocal(moveOp("n2", 300 + i, i));
    }

    expect(useScene.getState().gesture!.preview.size).toBe(2);
    const scene = useScene.getState().scene!;
    expect(scene.nodes.at("n1")).toMatchObject({ x: 50, y: 50 });
    expect(scene.nodes.at("n2")).toMatchObject({ x: 350, y: 50 });
  });

  it("previews with DIFFERENT masks on the same node do not squash each other", () => {
    const st = useScene.getState();
    st.beginGesture();
    st.applyLocal(resizeOp("n1", 500, 400)); // mask {width,height}
    for (let i = 1; i <= 10; i++) st.applyLocal(moveOp("n1", i, i)); // mask {x,y}

    expect(useScene.getState().gesture!.preview.size).toBe(2);
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({
      x: 10, y: 10, width: 500, height: 400,
    });
  });

  it("CREATION previews do not coalesce with each other", () => {
    const st = useScene.getState();
    st.beginGesture();
    st.applyLocal(createOp("n9", 10, 10));
    st.applyLocal(createOp("n10", 20, 20));

    expect(useScene.getState().gesture!.preview.size).toBe(2);
    const scene = useScene.getState().scene!;
    expect(scene.nodes.at("n9")).toBeDefined();
    expect(scene.nodes.at("n10")).toBeDefined();
  });

  // Same problem as the drag, different source: a text editing session
  // (ui/TextEditorOverlay.tsx) does ONE applyLocal per KEY and lasts as long as
  // the writing does. Without coalescing, a thousand characters = a thousand preview
  // ops, all replayed on every authoritative record that lands while
  // typing. Two setTexts on the same node are ABSOLUTE (they carry the whole
  // content, not a delta), so the last makes the previous irrelevant --
  // exactly like two setProps with the same mask.
  it("setText previews coalesce per node: an editing session does not accumulate one op per key", () => {
    sync.submit(createTextOp("t1", ""));
    const st = useScene.getState();
    st.beginGesture();
    for (const s of ["c", "ci", "cia", "ciao"]) st.applyLocal(setTextOp("t1", s));

    expect(useScene.getState().gesture!.preview.size).toBe(1);
    expect(useScene.getState().scene!.nodes.at("t1").text!.content).toBe("ciao");
  });

  it("a CONTENT-only setText does not squash one that also carries the STYLE", () => {
    sync.submit(createTextOp("t1", ""));
    const st = useScene.getState();
    st.beginGesture();
    // The properties panel (style) and the textarea (content) are two
    // different sources within the same gesture: the second must not make
    // the first's font vanish.
    st.applyLocal(setTextOp("t1", "ciao", 42));
    st.applyLocal(setTextOp("t1", "ciao mondo"));

    expect(useScene.getState().gesture!.preview.size).toBe(2);
    const t = useScene.getState().scene!.nodes.at("t1").text!;
    expect(t.content).toBe("ciao mondo");
    expect(t.style.fontSize).toBe(42);
  });

  // Third source, the densest of all: the pen tool and dragging an
  // anchor do one applyLocal per POINTERMOVE, and every setVectorPath carries
  // the WHOLE subpaths (it is wholesale, not incremental). Without coalescing a single
  // drag leaves hundreds of preview ops, each with all the
  // geometry inside, copied on every applyLocal and replayed by viewOf on every
  // authoritative record.
  it("setVectorPath previews coalesce per node: a drag does not accumulate one op per pointermove", () => {
    sync.submit(createVectorOp("v1"));
    const st = useScene.getState();
    st.beginGesture();
    for (let i = 1; i <= 200; i++) st.applyLocal(setVectorPathOp("v1", i * 3, i * 2));

    expect(useScene.getState().gesture!.preview.size).toBe(1);
    // ...and the last geometry is still the right one.
    expect(useScene.getState().scene!.nodes.at("v1").vector!.subpaths).toEqual([
      { anchors: [
        { x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 },
        { x: 600, y: 400, inX: 0, inY: 0, outX: 0, outY: 0 },
      ], closed: false },
    ]);
  });

  // Geometry and BOX are two independent writes of the same gesture (the pen
  // tool keeps x/y/width/height aligned to the path's bbox while drawing):
  // squashing one with the other would lose one or the other.
  it("a setVectorPath does not squash the setProps preview on the same node", () => {
    sync.submit(createVectorOp("v1"));
    const st = useScene.getState();
    st.beginGesture();
    for (let i = 1; i <= 10; i++) {
      st.applyLocal(setVectorPathOp("v1", i * 3, i * 2));
      st.applyLocal(resizeOp("v1", i * 3, i * 2));
    }

    expect(useScene.getState().gesture!.preview.size).toBe(2);
    const n = useScene.getState().scene!.nodes.at("v1");
    expect(n).toMatchObject({ width: 30, height: 20 });
    expect(n.vector!.subpaths[0].anchors[1]).toMatchObject({ x: 30, y: 20 });
  });

  it("an authoritative record mid long drag replays the coalesced preview", () => {
    const st = useScene.getState();
    st.beginGesture();
    st.applyLocal(resizeOp("n1", 500, 400));
    for (let i = 1; i <= 100; i++) st.applyLocal(moveOp("n1", i, i));

    st.apply(moveOp("n2", 333, 44)); // the other tab moves n2: the view is recomputed

    const scene = useScene.getState().scene!;
    expect(scene.nodes.at("n2")).toMatchObject({ x: 333, y: 44 }); // remoto applicato
    // ...and the local preview is still all there, both masks included.
    expect(scene.nodes.at("n1")).toMatchObject({ x: 100, y: 100, width: 500, height: 400 });
    expect(useScene.getState().gesture!.preview.size).toBe(2);
  });

  // --- guards on the state machine -----------------------------------------

  describe("misuses of the state machine", () => {
    // The misuse must be LOUD: the warning is verified, not just the state.
    const silenceWarn = () => vi.spyOn(console, "warn").mockImplementation(() => {});
    let warn: ReturnType<typeof silenceWarn>;
    beforeEach(() => {
      warn = silenceWarn();
    });
    afterEach(() => {
      warn.mockRestore();
    });

    it("beginGesture with a gesture already open reports and keeps the INITIAL snapshot", () => {
      const st = useScene.getState();
      st.beginGesture();
      st.applyLocal(moveOp("n1", 40, 40));
      st.beginGesture(); // misuse: the tool forgot to close the first
      st.applyLocal(moveOp("n1", 90, 90));
      st.cancelGesture();

      // must go back to the true start (0,0), not to the mid-drag state (40,40)
      expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 0, y: 0 });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("beginGesture");
    });

    it("repeated beginGesture does not lose the remote ops already recorded", () => {
      const st = useScene.getState();
      st.beginGesture();
      st.apply(createOp("n3", 700, 700));
      st.beginGesture(); // misuso
      st.cancelGesture();

      expect(useScene.getState().scene!.nodes.at("n3")).toBeDefined();
    });

    it("endGesture without an open gesture reports but still sends the ops", () => {
      const st = useScene.getState();
      st.endGesture([moveOp("n1", 40, 40)]); // misuse: no beginGesture

      expect(sync.sent).toHaveLength(1);
      expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 40, y: 40 });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("endGesture");
    });

    it("endGesture([]) without an open gesture is a silent no-op", () => {
      const before = useScene.getState().scene;
      useScene.getState().endGesture([]);

      expect(useScene.getState().scene).toEqual(before);
      expect(sync.sent).toHaveLength(0);
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
