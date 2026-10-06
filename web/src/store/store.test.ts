import { nodesOf } from "./nodeMap";
import { describe, it, expect, beforeEach } from "vitest";
import { create } from "@bufbuild/protobuf";
import { OpSchema, NodeSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "./store";
import { emptyScene } from "./types";
import type { NodeLite, SceneState } from "./types";

function createRectOp(id: string) {
  const node = create(NodeSchema, {
    id, parentId: "page1", orderKey: "a0", name: "Rect", visible: true, opacity: 1,
    x: 0, y: 0, width: 100, height: 80,
    shape: { case: "rect", value: { cornerRadius: 0 } },
  });
  return create(OpSchema, { opId: "op-" + id, docId: "doc1", kind: { case: "createNode", value: { node } } });
}

function deleteOp(id: string) {
  return create(OpSchema, { opId: "del-" + id, docId: "doc1", kind: { case: "deleteNode", value: { id } } });
}

describe("selection state", () => {
  beforeEach(() => {
    useScene.setState({ selection: [], marquee: null, gesture: null });
    // setScene and not setState({scene}): installs a COHERENT scene (view and
    // confirmed aligned, empty queue), which is the invariant reconciliation
    // rests on (see store.ts).
    useScene.getState().setScene(emptyScene("doc1", "Untitled"));
  });

  it("setSelection replaces the current selection", () => {
    useScene.getState().setSelection(["a", "b"]);
    expect(useScene.getState().selection).toEqual(["a", "b"]);
    useScene.getState().setSelection(["c"]);
    expect(useScene.getState().selection).toEqual(["c"]);
  });

  it("toggleSelection adds an id when absent and removes it when present", () => {
    useScene.getState().toggleSelection("a");
    expect(useScene.getState().selection).toEqual(["a"]);
    useScene.getState().toggleSelection("b");
    expect(useScene.getState().selection).toEqual(["a", "b"]);
    useScene.getState().toggleSelection("a");
    expect(useScene.getState().selection).toEqual(["b"]);
  });

  it("clearSelection empties the selection", () => {
    useScene.getState().setSelection(["a", "b"]);
    useScene.getState().clearSelection();
    expect(useScene.getState().selection).toEqual([]);
  });

  it("setMarquee stores and clears the marquee bounds", () => {
    const b = { x: 0, y: 0, width: 10, height: 10 };
    useScene.getState().setMarquee(b);
    expect(useScene.getState().marquee).toEqual(b);
    useScene.getState().setMarquee(null);
    expect(useScene.getState().marquee).toBeNull();
  });

  it("setSnapGuides stores and clears the active guides", () => {
    const g = [{ axis: "x" as const, pos: 100, from: 0, to: 50 }];
    useScene.getState().setSnapGuides(g);
    expect(useScene.getState().snapGuides).toEqual(g);
    useScene.getState().setSnapGuides([]);
    expect(useScene.getState().snapGuides).toEqual([]);
  });

  it("setSnapGuides reuses the same array when there is nothing to show and nothing was shown", () => {
    // A drag calls it on every pointermove: a new array each time
    // would wake the subscribers at every pixel even with no snap.
    useScene.getState().setSnapGuides([]);
    const before = useScene.getState().snapGuides;
    useScene.getState().setSnapGuides([]);
    expect(useScene.getState().snapGuides).toBe(before);
  });

  it("REGRESSION: applying a deleteNode op for a selected node also removes it from the selection", () => {
    useScene.getState().apply(createRectOp("n1"));
    useScene.getState().apply(createRectOp("n2"));
    useScene.getState().setSelection(["n1", "n2"]);
    useScene.getState().apply(deleteOp("n1"));
    // Otherwise the resize handles stay hanging on a nonexistent node.
    expect(useScene.getState().selection).toEqual(["n2"]);
    expect(useScene.getState().scene?.nodes.at("n1")).toBeUndefined();
  });

  it("leaves the selection untouched when the deleted node was not selected", () => {
    useScene.getState().apply(createRectOp("n1"));
    useScene.getState().apply(createRectOp("n2"));
    useScene.getState().setSelection(["n2"]);
    useScene.getState().apply(deleteOp("n1"));
    expect(useScene.getState().selection).toEqual(["n2"]);
  });

  it("removes a deleted node from a multi-id selection while keeping the rest, in order", () => {
    useScene.getState().apply(createRectOp("n1"));
    useScene.getState().apply(createRectOp("n2"));
    useScene.getState().apply(createRectOp("n3"));
    useScene.getState().setSelection(["n1", "n2", "n3"]);
    useScene.getState().apply(deleteOp("n2"));
    expect(useScene.getState().selection).toEqual(["n1", "n3"]);
  });
});

function createPageOp(id: string, name: string) {
  return create(OpSchema, { opId: "op-page-" + id, docId: "doc1", kind: { case: "createPage", value: { page: { id, name } } } });
}
function deletePageOp(id: string) {
  return create(OpSchema, { opId: "op-delpage-" + id, docId: "doc1", kind: { case: "deletePage", value: { id } } });
}
function renamePageOp(id: string, name: string) {
  return create(OpSchema, { opId: "op-renpage-" + id, docId: "doc1", kind: { case: "renamePage", value: { id, name } } });
}

// currentPageId is VIEW STATE (like camera and selection), NOT document:
// it is not an op, it does not travel on the wire, and stays ALWAYS valid -- it must be corrected when
// a page is created/deleted, even by a remote op.
describe("currentPageId (view state)", () => {
  beforeEach(() => {
    useScene.setState({ selection: [], marquee: null, gesture: null });
    useScene.getState().setScene(emptyScene("doc1", "Untitled"));
  });

  it("setScene defaults to the first page", () => {
    expect(useScene.getState().currentPageId).toBe("page1");
  });

  it("setCurrentPage changes page and RESETS the selection, with no undo entry", () => {
    useScene.getState().apply(createPageOp("page2", "Page 2")); // remote: brings a second page
    useScene.getState().setSelection(["x"]);
    const undoBefore = useScene.getState().undoStack.length;
    useScene.getState().setCurrentPage("page2");
    expect(useScene.getState().currentPageId).toBe("page2");
    expect(useScene.getState().selection).toEqual([]);
    // Changing page is NOT an undo entry.
    expect(useScene.getState().undoStack.length).toBe(undoBefore);
    expect(useScene.getState().canUndo).toBe(false);
  });

  it("re-selecting the current page is a no-op that does not touch the selection", () => {
    useScene.getState().setSelection(["x"]);
    useScene.getState().setCurrentPage("page1");
    expect(useScene.getState().selection).toEqual(["x"]);
  });

  it("does not switch to a nonexistent page (the invariant holds)", () => {
    useScene.getState().setCurrentPage("nope");
    expect(useScene.getState().currentPageId).toBe("page1");
  });

  it("deleting the current page (even from a remote op) falls back to another", () => {
    useScene.getState().apply(createPageOp("page2", "Page 2"));
    useScene.getState().setCurrentPage("page2");
    expect(useScene.getState().currentPageId).toBe("page2");
    useScene.getState().apply(deletePageOp("page2")); // op remoto
    expect(useScene.getState().currentPageId).toBe("page1");
  });

  it("a remote op that creates/renames pages keeps the current page valid", () => {
    useScene.getState().apply(createPageOp("page2", "Page 2"));
    expect(useScene.getState().currentPageId).toBe("page1"); // unchanged: it was and is valid
    expect(useScene.getState().scene!.pages.map((p) => p.id)).toEqual(["page1", "page2"]);
    useScene.getState().apply(renamePageOp("page1", "Cover"));
    expect(useScene.getState().currentPageId).toBe("page1");
    expect(useScene.getState().scene!.pages.find((p) => p.id === "page1")!.name).toBe("Cover");
  });
});

function reparentOp(id: string, newParentId: string, orderKey: string) {
  return create(OpSchema, {
    opId: "op-rep-" + id, docId: "doc1",
    kind: { case: "reparentNode", value: { id, newParentId, orderKey } },
  });
}

function createGroupOp(id: string) {
  const node = create(NodeSchema, {
    id, parentId: "page1", orderKey: "a0", name: "Group", visible: true, opacity: 1,
    shape: { case: "group", value: {} },
  });
  return create(OpSchema, { opId: "op-" + id, docId: "doc1", kind: { case: "createNode", value: { node } } });
}

// SEE-vs-SELECT on the frame side: the selection is view state
// per-page scoped like drawing/hit-test/marquee (canvasRenderer.ts::rootsOf).
// A REMOTE op that moves the selected node to another page leaves it
// existing but no longer reachable from the current page: keeping it selected
// would draw a frame and 8 handles on empty space (overlayRenderer.ts) and the properties
// panel would edit it blindly. setCurrentPage resets the selection on a
// LOCAL page change; this covers the REMOTE arrival, which goes through rebuild.
describe("per-page selection scoping (rebuild from remote op)", () => {
  beforeEach(() => {
    useScene.setState({ selection: [], marquee: null, gesture: null });
    useScene.getState().setScene(emptyScene("doc1", "Untitled"));
  });

  it("REGRESSION: a remote reparent of the selected node to another page removes it from the selection", () => {
    useScene.getState().apply(createPageOp("page2", "Page 2"));
    useScene.getState().apply(createRectOp("n1")); // child of page1
    useScene.getState().setSelection(["n1"]);
    // client B moves n1 to page2 while A is looking at page1
    useScene.getState().apply(reparentOp("n1", "page2", "a0"));
    // n1 STILL exists (it is not a delete), but is no longer reachable from page1:
    // the canvas does not draw it, so frame/handles/panel must no longer
    // point at it.
    expect(useScene.getState().scene?.nodes.at("n1")).toBeDefined();
    expect(useScene.getState().currentPageId).toBe("page1");
    expect(useScene.getState().selection).toEqual([]);
  });

  it("a remote reparent INSIDE the current page (into a group) keeps the selection", () => {
    useScene.getState().apply(createGroupOp("g1")); // child of page1
    useScene.getState().apply(createRectOp("n1")); // child of page1
    useScene.getState().setSelection(["n1"]);
    // n1 ends up under g1: parent changes but it stays reachable from page1.
    useScene.getState().apply(reparentOp("n1", "g1", "a0"));
    expect(useScene.getState().selection).toEqual(["n1"]);
  });

  it("removes ONLY the nodes that ended up off-page from a multiple selection, keeping the rest in order", () => {
    useScene.getState().apply(createPageOp("page2", "Page 2"));
    useScene.getState().apply(createRectOp("n1"));
    useScene.getState().apply(createRectOp("n2"));
    useScene.getState().apply(createRectOp("n3"));
    useScene.getState().setSelection(["n1", "n2", "n3"]);
    useScene.getState().apply(reparentOp("n2", "page2", "a0"));
    expect(useScene.getState().selection).toEqual(["n1", "n3"]);
  });
});

// A full NodeLite, to hand-build setScene snapshots without going through
// an op: mirrors createRectOp (same fields) but with a free parentId.
function rectLite(id: string, parentId: string): NodeLite {
  return {
    id, parentId, orderKey: "a0", name: "Rect", visible: true, opacity: 1,
    x: 0, y: 0, width: 100, height: 80, rotation: 0,
    fills: [], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false,
  };
}

// SEE-vs-SELECT from rebuild's TWIN branch: setScene is the
// RESYNC/snapshot path (rpc/syncClient.ts, CodeOutOfRange branch) and by design
// KEEPS the selection instead of emptying it. But "keeping" must mean the
// same per-page scoping as rebuild: a snapshot in which the selected node
// moved to ANOTHER page leaves it existing but no longer reachable from the
// current page, and keeping it selected would draw a frame and 8 handles on the
// void (overlayRenderer.ts) and make the panel edit blindly.
describe("per-page selection scoping (setScene: resync/snapshot)", () => {
  beforeEach(() => {
    useScene.setState({ selection: [], marquee: null, gesture: null });
    useScene.getState().setScene(emptyScene("doc1", "Untitled"));
  });

  it("REGRESSION: a resync snapshot in which the selected node moved to another page removes it from the selection", () => {
    useScene.getState().apply(createPageOp("page2", "Page 2"));
    useScene.getState().apply(createRectOp("n1")); // child of page1
    useScene.getState().setSelection(["n1"]);
    expect(useScene.getState().currentPageId).toBe("page1");
    // The connection drops and reopens; in the meantime another client moved n1
    // to page2. The authoritative snapshot now shows it UNDER page2: n1 STILL
    // EXISTS (pruning by existence alone would keep it) but is no longer
    // reachable from page1, which remains the current page.
    const snapshot: SceneState = {
      id: "doc1", name: "Untitled", schemaVersion: 1,
      pages: [{ id: "page1", name: "Page 1" }, { id: "page2", name: "Page 2" }],
      nodes: nodesOf({ n1: rectLite("n1", "page2") }), flows: {}, transitions: {}, clips: {}, collections: {}, variables: {}, components: {},
    };
    useScene.getState().setScene(snapshot);
    expect(useScene.getState().scene?.nodes.at("n1")).toBeDefined();
    expect(useScene.getState().currentPageId).toBe("page1");
    expect(useScene.getState().selection).toEqual([]);
  });

  it("a snapshot that KEEPS the selected node on the current page preserves the selection", () => {
    useScene.getState().apply(createRectOp("n1")); // child of page1
    useScene.getState().setSelection(["n1"]);
    const snapshot: SceneState = {
      id: "doc1", name: "Untitled", schemaVersion: 1,
      pages: [{ id: "page1", name: "Page 1" }],
      nodes: nodesOf({ n1: rectLite("n1", "page1") }), flows: {}, transitions: {}, clips: {}, collections: {}, variables: {}, components: {},
    };
    useScene.getState().setScene(snapshot);
    expect(useScene.getState().selection).toEqual(["n1"]);
  });
});

// The "selection ⊆ reachable from currentPage" invariant airtight on the
// optimistic submit path too: a local op that moves the selected node
// out of the current page removes it from the selection, as rebuild does for
// remote ops and setScene for snapshots.
describe("per-page selection scoping (applyPending: optimistic local op)", () => {
  beforeEach(() => {
    useScene.setState({ selection: [], marquee: null, gesture: null });
    useScene.getState().setScene(emptyScene("doc1", "Untitled"));
  });

  it("an optimistic local op that moves the selected node off-page removes it from the selection", () => {
    useScene.getState().apply(createPageOp("page2", "Page 2"));
    useScene.getState().apply(createRectOp("n1")); // child of page1
    useScene.getState().setSelection(["n1"]);
    // OPTIMISTIC submit of a reparent toward page2: the view shows it immediately,
    // n1 still exists but is no longer reachable from page1.
    useScene.getState().applyPending(reparentOp("n1", "page2", "a0"));
    expect(useScene.getState().scene?.nodes.at("n1")).toBeDefined();
    expect(useScene.getState().currentPageId).toBe("page1");
    expect(useScene.getState().selection).toEqual([]);
  });
});
