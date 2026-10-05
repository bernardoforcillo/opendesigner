import { describe, it, expect } from "vitest";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import {
  OpSchema, NodeSchema, SetTextSchema, SetVectorPathSchema, VectorNodeSchema, TextAlign,
  InstanceOverrideSchema,
} from "../gen/opendesigner/v1/opendesigner_pb";
import type { Node as PbNode } from "../gen/opendesigner/v1/opendesigner_pb";
import { applyOp } from "./applyOp";
import { emptyScene, toNodeLite, toPbNode } from "./types";

function createRectOp(id: string, x: number, y: number) {
  const node = create(NodeSchema, {
    id, parentId: "page1", orderKey: "a0", name: "Rect", visible: true, opacity: 1,
    x, y, width: 100, height: 80,
    shape: { case: "rect", value: { cornerRadius: 0 } },
  });
  return create(OpSchema, { opId: "op-" + id, docId: "doc1", kind: { case: "createNode", value: { node } } });
}

const HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function createImageOp(id: string) {
  const node = create(NodeSchema, {
    id, parentId: "page1", orderKey: "a0", name: "Image", visible: true, opacity: 1,
    x: 10, y: 20, width: 320, height: 180,
    shape: { case: "image", value: { assetHash: HASH } },
  });
  return create(OpSchema, { opId: "op-" + id, docId: "doc1", kind: { case: "createNode", value: { node } } });
}

describe("applyOp", () => {
  it("creates a rect node", () => {
    const s = applyOp(emptyScene("doc1", "Untitled"), createRectOp("n1", 10, 20));
    expect(s.nodes.at("n1").x).toBe(10);
    expect(s.nodes.at("n1").kind).toBe("rect");
  });

  it("creates an ellipse node", () => {
    const node = create(NodeSchema, {
      id: "n1", parentId: "page1", orderKey: "a0", name: "Ellipse", visible: true, opacity: 1,
      x: 10, y: 20, width: 100, height: 80,
      shape: { case: "ellipse", value: {} },
    });
    const op = create(OpSchema, { opId: "op-n1", docId: "doc1", kind: { case: "createNode", value: { node } } });
    const s = applyOp(emptyScene("doc1", "Untitled"), op);
    expect(s.nodes.at("n1").kind).toBe("ellipse");
  });

  // A group is a CONTAINER, not a shape: the `shape` oneof says what a
  // node is, and "group" sits inside it like the others (proto: GroupNode = 33).
  it("creates a group node", () => {
    const node = create(NodeSchema, {
      id: "g1", parentId: "page1", orderKey: "a0", name: "Group", visible: true, opacity: 1,
      shape: { case: "group", value: {} },
    });
    const op = create(OpSchema, { opId: "op-g1", docId: "doc1", kind: { case: "createNode", value: { node } } });
    const s = applyOp(emptyScene("doc1", "Untitled"), op);
    expect(s.nodes.at("g1").kind).toBe("group");
  });

  // Parity with core.applySetProps (Go), which replies ErrNotRectNode on a
  // group: a group has nothing to fill, so no corner to
  // round. The op is rejected as a WHOLE -- not even the "x" of the same mask
  // moves.
  it("rejects corner_radius on a group, x included", () => {
    const node = create(NodeSchema, {
      id: "g1", parentId: "page1", orderKey: "a0", name: "Group", visible: true, opacity: 1,
      shape: { case: "group", value: {} },
    });
    let s = applyOp(emptyScene("doc1", "Untitled"),
      create(OpSchema, { opId: "c", docId: "doc1", kind: { case: "createNode", value: { node } } }));
    const before = s;
    s = applyOp(s, create(OpSchema, { opId: "r", docId: "doc1", kind: { case: "setProps", value: {
      id: "g1",
      patch: create(NodeSchema, { x: 42, shape: { case: "rect", value: { cornerRadius: 12 } } }),
      mask: { paths: ["x", "corner_radius"] },
    } } }));
    expect(s).toBe(before);
    expect(s.nodes.at("g1").x).toBe(0);
    expect(s.nodes.at("g1").kind).toBe("group");
  });

  it("moves via setProperties + mask", () => {
    let s = applyOp(emptyScene("doc1", "Untitled"), createRectOp("n1", 0, 0));
    const move = create(OpSchema, { opId: "m", docId: "doc1", kind: { case: "setProps", value: {
      id: "n1", patch: create(NodeSchema, { x: 42, y: 7 }), mask: { paths: ["x", "y"] } } } });
    s = applyOp(s, move);
    expect(s.nodes.at("n1").x).toBe(42);
    expect(s.nodes.at("n1").y).toBe(7);
  });

  it("deletes a node", () => {
    let s = applyOp(emptyScene("doc1", "Untitled"), createRectOp("n1", 0, 0));
    const del = create(OpSchema, { opId: "d", docId: "doc1", kind: { case: "deleteNode", value: { id: "n1" } } });
    s = applyOp(s, del);
    expect(s.nodes.at("n1")).toBeUndefined();
  });

  it("rejects createNode on an id that already exists (parity with core.applyCreate: ErrNodeExists)", () => {
    const s = applyOp(emptyScene("doc1", "Untitled"), createRectOp("n1", 10, 20));
    // Go returns ErrNodeExists and mutates nothing, so the server would refuse
    // this op. Overwriting locally would silently diverge from the document
    // the server actually holds.
    const s2 = applyOp(s, createRectOp("n1", 999, 999));
    expect(s2).toEqual(s);
    expect(s2.nodes.at("n1").x).toBe(10);
  });

  it("rejects a createNode whose node has an empty id (parity with core.applyCreate: ErrNilNode)", () => {
    const node = create(NodeSchema, { id: "", parentId: "page1", shape: { case: "rect", value: { cornerRadius: 0 } } });
    const op = create(OpSchema, { opId: "op-empty", docId: "doc1", kind: { case: "createNode", value: { node } } });
    const s = applyOp(emptyScene("doc1", "Untitled"), op);
    expect([...s.nodes.ids()]).toEqual([]);
  });

  it("zeroes the masked fields when setProps carries no patch (parity with Go's nil-safe getters)", () => {
    const node = create(NodeSchema, {
      id: "n1", parentId: "page1", orderKey: "a0", name: "Rect", visible: true, opacity: 1,
      x: 10, y: 20, width: 100, height: 80,
      fills: [{ kind: { case: "solid", value: { color: { r: 0.5, g: 0.5, b: 0.5, a: 1 } } } }],
      shape: { case: "rect", value: { cornerRadius: 0 } },
    });
    let s = applyOp(emptyScene("doc1", "Untitled"),
      create(OpSchema, { opId: "op-n1", docId: "doc1", kind: { case: "createNode", value: { node } } }));
    expect(s.nodes.at("n1").fills.length).toBe(1);
    // Go reads the patch through p.GetX() & co., which return the field's zero
    // value on a nil *Node: applySetProps ZEROES x and fills here, it does not
    // skip the op.
    const noPatch = create(OpSchema, { opId: "np", docId: "doc1", kind: { case: "setProps", value: {
      id: "n1", mask: { paths: ["x", "fills"] } } } });
    s = applyOp(s, noPatch);
    expect(s.nodes.at("n1").x).toBe(0);
    expect(s.nodes.at("n1").fills).toEqual([]);
    expect(s.nodes.at("n1").y).toBe(20); // outside the mask: untouched
    expect(s.nodes.at("n1").width).toBe(100);
  });

  it("rejects the whole setProps op atomically when the mask has an unsupported path (parity with core.applySetProps in Go)", () => {
    let s = applyOp(emptyScene("doc1", "Untitled"), createRectOp("n1", 0, 0));
    const badMove = create(OpSchema, { opId: "m2", docId: "doc1", kind: { case: "setProps", value: {
      id: "n1", patch: create(NodeSchema, { x: 42, y: 7 }), mask: { paths: ["x", "someFutureField"] } } } });
    s = applyOp(s, badMove);
    // Go's applySetProps validates the entire mask before mutating anything,
    // so an unsupported path rejects the op as a whole -- "x" must NOT be
    // partially applied here.
    expect(s.nodes.at("n1").x).toBe(0);
    expect(s.nodes.at("n1").y).toBe(0);
  });
});

// --- tree: parent, cascade, reparenting ------------------------------------
// Mirrors of internal/core/tree_test.go. The fixtures in testdata/golden/
// (cascade_delete, reparent, reparent_cycle_rejected, create_orphan_rejected)
// run the SAME cases from both sides; these tests cover the TS side
// with the granularity a fixture lacks (which state stays unchanged).

function createChildOp(id: string, parentId: string, orderKey = "a1") {
  const node = create(NodeSchema, {
    id, parentId, orderKey, name: id, visible: true, opacity: 1,
    x: 0, y: 0, width: 10, height: 10,
    shape: { case: "rect", value: { cornerRadius: 0 } },
  });
  return create(OpSchema, { opId: "op-" + id, docId: "doc1", kind: { case: "createNode", value: { node } } });
}

function reparentOp(id: string, newParentId: string, orderKey: string) {
  return create(OpSchema, {
    opId: `rp-${id}`, docId: "doc1",
    kind: { case: "reparentNode", value: { id, newParentId, orderKey } },
  });
}

//   page1
//   ├── g1
//   │   ├── c1
//   │   │   └── d1
//   │   └── c2
//   └── other
function treeScene() {
  return [
    createChildOp("g1", "page1", "a1"),
    createChildOp("c1", "g1", "a1"),
    createChildOp("d1", "c1", "a1"),
    createChildOp("c2", "g1", "a2"),
    createChildOp("other", "page1", "a2"),
  ].reduce((s, op) => applyOp(s, op), emptyScene("doc1", "Untitled"));
}

describe("applyOp: createNode and the parent", () => {
  it("accepts a parent that is a NODE (nesting)", () => {
    const s = applyOp(applyOp(emptyScene("doc1", "Untitled"), createChildOp("g1", "page1")), createChildOp("c1", "g1"));
    expect(s.nodes.at("c1").parentId).toBe("g1");
  });

  it("rejects a nonexistent parent (parity with ErrParentNotFound in Go)", () => {
    const s = emptyScene("doc1", "Untitled");
    // The server rejects the op: creating it here would mean keeping locally a
    // node that no page reaches and that the authoritative document does not have.
    expect(applyOp(s, createChildOp("n1", "ghost"))).toEqual(s);
  });

  it("rejects an empty parent", () => {
    const s = emptyScene("doc1", "Untitled");
    expect(applyOp(s, createChildOp("n1", ""))).toEqual(s);
  });
});

describe("applyOp: deleteNode cascading", () => {
  it("deletes the node AND all descendants", () => {
    const s = applyOp(treeScene(), create(OpSchema, {
      opId: "del", docId: "doc1", kind: { case: "deleteNode", value: { id: "g1" } },
    }));
    expect([...s.nodes.ids()]).toEqual(["other"]);
  });

  it("deleting a leaf does not touch the siblings", () => {
    const s = applyOp(treeScene(), create(OpSchema, {
      opId: "del", docId: "doc1", kind: { case: "deleteNode", value: { id: "c2" } },
    }));
    expect([...s.nodes.ids()].sort()).toEqual(["c1", "d1", "g1", "other"]);
  });

  it("nonexistent id: scene unchanged (ErrNodeNotFound in Go)", () => {
    const s = treeScene();
    expect(applyOp(s, create(OpSchema, {
      opId: "del", docId: "doc1", kind: { case: "deleteNode", value: { id: "ghost" } },
    }))).toEqual(s);
  });
});

describe("applyOp: reparentNode", () => {
  it("moves the node and rewrites the order key; the subtree follows it", () => {
    const s = applyOp(treeScene(), reparentOp("c1", "other", "a9"));
    expect(s.nodes.at("c1").parentId).toBe("other");
    expect(s.nodes.at("c1").orderKey).toBe("a9");
    // Children point to the node, not to the grandparent: nobody rewrites them.
    expect(s.nodes.at("d1").parentId).toBe("c1");
  });

  it("accepts a PAGE as the new parent", () => {
    const s = applyOp(treeScene(), reparentOp("d1", "page1", "a3"));
    expect(s.nodes.at("d1").parentId).toBe("page1");
  });

  it("same parent + new key = reorder among peers", () => {
    const s = applyOp(treeScene(), reparentOp("c1", "g1", "a3"));
    expect(s.nodes.at("c1").parentId).toBe("g1");
    expect(s.nodes.at("c1").orderKey).toBe("a3");
  });

  it.each([
    ["itself", "g1", "g1"],
    ["a direct child", "g1", "c1"],
    ["a deep descendant", "g1", "d1"],
  ])("rejects the cycle: %s (parity with ErrCycle in Go)", (_name, id, parent) => {
    const s = treeScene();
    // Rejection as a WHOLE: not even the order key moves.
    expect(applyOp(s, reparentOp(id, parent, "a9"))).toEqual(s);
  });

  it("rejects a nonexistent new parent", () => {
    const s = treeScene();
    expect(applyOp(s, reparentOp("c1", "ghost", "a9"))).toEqual(s);
  });

  it("rejects a nonexistent node", () => {
    const s = treeScene();
    expect(applyOp(s, reparentOp("ghost", "page1", "a9"))).toEqual(s);
  });
});

// --- corner_radius ---------------------------------------------------------
// Mirrors of internal/core/apply_test.go (TestApplySetPropertiesCornerRadius*).
// It is the only mask path that addresses a field INSIDE the `shape` oneof,
// so it is also the only one that can find a node of the WRONG shape -- and in
// that case Go replies ErrNotRectNode and rejects the op as a whole.

// optional `x` = "also carry an x in the SAME mask", to prove
// that the rejection is whole and not partial.
function setCornerRadiusOp(id: string, cornerRadius: number, x?: number) {
  return create(OpSchema, { opId: "op-cr", docId: "doc1", kind: { case: "setProps", value: {
    id,
    patch: create(NodeSchema, { x: x ?? 0, shape: { case: "rect", value: { cornerRadius } } }),
    mask: { paths: x === undefined ? ["corner_radius"] : ["x", "corner_radius"] },
  } } });
}

describe("applyOp: corner_radius", () => {
  it("writes the radius of a rectangle", () => {
    let s = applyOp(emptyScene("doc1", "Untitled"), createRectOp("n1", 0, 0));
    s = applyOp(s, setCornerRadiusOp("n1", 12));
    expect(s.nodes.at("n1").cornerRadius).toBe(12);
  });

  it("a patch without rect ZEROES the radius (parity with Go's nil-safe getters)", () => {
    let s = applyOp(emptyScene("doc1", "Untitled"), createRectOp("n1", 0, 0));
    s = applyOp(s, setCornerRadiusOp("n1", 8));
    const nilPatch = create(OpSchema, { opId: "op-cr2", docId: "doc1", kind: { case: "setProps", value: {
      id: "n1", mask: { paths: ["corner_radius"] } } } });
    s = applyOp(s, nilPatch);
    expect(s.nodes.at("n1").cornerRadius).toBe(0);
  });

  it("on an ellipse it rejects the WHOLE op (parity with ErrNotRectNode)", () => {
    const node = create(NodeSchema, {
      id: "n1", parentId: "page1", orderKey: "a0", name: "Ellipse", visible: true, opacity: 1,
      x: 0, y: 0, width: 100, height: 80, shape: { case: "ellipse", value: {} },
    });
    const s = applyOp(emptyScene("doc1", "Untitled"),
      create(OpSchema, { opId: "op-n1", docId: "doc1", kind: { case: "createNode", value: { node } } }));
    // "x" travels in the SAME mask: as for an unknown path, the rejection is
    // whole and not even x moves.
    const after = applyOp(s, setCornerRadiusOp("n1", 12, 42));
    expect(after).toEqual(s);
    expect(after.nodes.at("n1").x).toBe(0);
    expect(after.nodes.at("n1").kind).toBe("ellipse");
  });

  it("on a text node it rejects the WHOLE op", () => {
    const node = create(NodeSchema, {
      id: "t1", parentId: "page1", orderKey: "a0", name: "Text", visible: true, opacity: 1,
      x: 0, y: 0, width: 200, height: 24,
      shape: { case: "text", value: { content: "ciao" } },
    });
    const s = applyOp(emptyScene("doc1", "Untitled"),
      create(OpSchema, { opId: "op-t1", docId: "doc1", kind: { case: "createNode", value: { node } } }));
    expect(applyOp(s, setCornerRadiusOp("t1", 12, 42))).toEqual(s);
  });

  // The TS half of the "vector" row of TestApplySetPropertiesCornerRadiusOnNonRectFails.
  // This side already rejected (`cur.kind !== "rect"`); it was GO that accepted,
  // because its guard listed the shapes to reject ({Ellipse, Text}) and
  // a new shape slipped through it -- ending up in the branch that materializes
  // the implicit rectangle and REPLACING the node's shape. Result: the
  // client kept the path, the authoritative document became a rectangle. It is
  // the exact divergence this pair of tests exists to prevent, so
  // the case sits on BOTH sides even though only one of the two was broken.
  it("on a VECTOR node it rejects the WHOLE op and does not touch the geometry", () => {
    const s = applyOp(emptyScene("doc1", "Untitled"),
      createVectorOp("v1", [{ anchors: RICH_ANCHORS, closed: true }]));
    const after = applyOp(s, setCornerRadiusOp("v1", 12, 42));
    expect(after).toEqual(s);
    expect(after.nodes.at("v1").x).toBe(0);
    expect(after.nodes.at("v1").kind).toBe("vector");
    expect(after.nodes.at("v1").vector?.subpaths).toEqual([{ anchors: RICH_ANCHORS, closed: true }]);
  });
});

// --- an UNKNOWN shape is not a rectangle -----------------------------------
//
// core.applySetProps (Go) accepts `nil` or `*opendesignerv1.Node_Rect` and rejects everything
// else: a WHITELIST, so a shape added tomorrow is rejected by default
// instead of ending up in the branch that materializes the implicit rectangle and
// destroys its geometry. This side had the mirror guard (`cur.kind !==
// "rect"`) but derived it from a `kind` that FELL BACK to "rect" for every
// unknown shape: the same divergence, simply mirrored -- op accepted
// here, ErrNotRectNode over there.
//
// After M4 EVERY branch of the generated `shape` oneof maps to a known kind (rect,
// ellipse, text, group, frame, image, vector, instance): "unknown" is no longer
// reachable from a shape that THIS build declares. It remains reachable however
// -- and it is what these tests defend -- from a shape that a NEWER server
// sends and that this build does not know yet: `shape.case` set to a
// name that store/types.ts does not list. It is forward compatibility, and it must be tested
// the only way to fabricate it today (a cast to a case the generated code lacks).
// kindOf falls back to "unknown" there and toNodeLite/toPbNode must preserve it
// OPAQUE, without flattening it onto a rectangle. (The `instance` branch, which BEFORE
// M4 these tests used as a fake unknown, is now a real shape: see the
// "instance and components" block further down.)
function nodeWithUnknownShape(id: string) {
  const n = create(NodeSchema, {
    id, parentId: "page1", orderKey: "a0", name: "Sconosciuto", visible: true, opacity: 1,
    x: 10, y: 20, width: 100, height: 80,
  });
  (n as unknown as { shape: unknown }).shape = { case: "reservedShape", value: { marker: "opaque" } };
  return n;
}

function createNodeOp(node: PbNode) {
  return create(OpSchema, {
    opId: "op-" + node.id, docId: "doc1", kind: { case: "createNode", value: { node } },
  });
}

describe("applyOp: unknown shape", () => {
  it("does not fall back to rect -- but an ABSENT shape does", () => {
    const s = applyOp(emptyScene("doc1", "Untitled"), createNodeOp(nodeWithUnknownShape("g1")));
    expect(s.nodes.at("g1").kind).toBe("unknown");
    // ABSENT shape stays "rect", and it is not an exception to the rule but the rule
    // itself: Go accepts it as an implicit rectangle (the `case nil` branch of the
    // whitelist), so treating it differently here would be the divergence.
    const noShape = create(NodeSchema, {
      id: "r1", parentId: "page1", orderKey: "a0", name: "Node", visible: true, opacity: 1,
      x: 0, y: 0, width: 10, height: 10,
    });
    const s2 = applyOp(s, createNodeOp(noShape));
    expect(s2.nodes.at("r1").kind).toBe("rect");
  });

  it("corner_radius on an unknown shape rejects the WHOLE op (parity with ErrNotRectNode)", () => {
    const s = applyOp(emptyScene("doc1", "Untitled"), createNodeOp(nodeWithUnknownShape("g1")));
    // "x" travels in the SAME mask: the rejection is whole, not even x
    // moves. Before the fix this op went through (kind fell back to "rect") and
    // wrote a cornerRadius on a node that Go rejects.
    const after = applyOp(s, setCornerRadiusOp("g1", 12, 42));
    expect(after).toEqual(s);
    expect(after.nodes.at("g1").x).toBe(10);
    expect(after.nodes.at("g1").cornerRadius).toBe(0);
  });

  it("setVectorPath and setText reject it as they reject a rectangle", () => {
    const s = applyOp(emptyScene("doc1", "Untitled"), createNodeOp(nodeWithUnknownShape("g1")));
    const setVector = create(OpSchema, {
      opId: "op-sv", docId: "doc1",
      kind: { case: "setVectorPath", value: { id: "g1", subpaths: [{ anchors: [], closed: true }] } },
    });
    expect(applyOp(s, setVector)).toEqual(s);
    const setText = create(OpSchema, {
      opId: "op-st", docId: "doc1", kind: { case: "setText", value: { id: "g1", content: "x" } },
    });
    expect(applyOp(s, setText)).toEqual(s);
  });

  it("toPbNode puts it back where it was: an undo does not convert an unknown shape into a rectangle", () => {
    // history.invertOp rebuilds the Node from NodeLite to invert a
    // delete. With the fallback to "rect" the node came back to life as a RECTANGLE
    // -- a silent shape change inside a Ctrl+Z, and no way to
    // notice it other than looking at the server's document. The opaque branch
    // (NodeLite.unknownShape) puts it back exactly where it was.
    const pb = nodeWithUnknownShape("g1");
    const back = toPbNode(toNodeLite(pb));
    expect(back.shape.case).toBe("reservedShape");
    expect(back.shape.value).toEqual({ marker: "opaque" });
    // ...and the rest of the node survives the round trip like for any other shape.
    expect(back).toMatchObject({ id: "g1", x: 10, y: 20, width: 100, height: 80 });
  });
});

// --- instance and components (M4) ------------------------------------------
// Mirrors of core.applyCreateComponent / applyCreate (instance branch) /
// applySetInstanceOverride (Go). The fixtures testdata/golden/components.json and
// component_rejections.json prove parity end-to-end from both sides;
// these tests pin down the TS side with the granularity a fixture lacks:
// which state stays UNCHANGED on a rejected op (same object, so
// selectors do not wake up), the node's kind, and the LOSSLESS round trip of
// overrides (which the goldens do not see, comparing both sides after the SAME
// toNodeLite).

const RED = { r: 1, g: 0, b: 0, a: 1 };

function createComponentOp(componentId: string, rootNodeId: string, name: string) {
  return create(OpSchema, {
    opId: "cc-" + componentId, docId: "doc1",
    kind: { case: "createComponent", value: { componentId, rootNodeId, name } },
  });
}

function createInstanceOp(id: string, componentId: string, parentId = "page1") {
  const node = create(NodeSchema, {
    id, parentId, orderKey: "a0", name: "Instance", visible: true, opacity: 1,
    x: 5, y: 6, width: 0, height: 0,
    shape: { case: "instance", value: { componentId } },
  });
  return create(OpSchema, { opId: "op-" + id, docId: "doc1", kind: { case: "createNode", value: { node } } });
}

function setInstanceOverrideOp(instanceId: string, override: MessageInitShape<typeof InstanceOverrideSchema>) {
  return create(OpSchema, {
    opId: "sio-" + instanceId, docId: "doc1",
    kind: { case: "setInstanceOverride", value: { instanceId, override } },
  });
}

describe("applyOp: instance and components", () => {
  it("registers a component and creates an instance that references it", () => {
    let s = applyOp(emptyScene("doc1", "Untitled"), createRectOp("m1", 0, 0));
    s = applyOp(s, createComponentOp("cmp1", "m1", "Button"));
    expect(s.components["cmp1"]).toEqual({ rootNodeId: "m1", name: "Button" });
    s = applyOp(s, createInstanceOp("inst1", "cmp1"));
    expect(s.nodes.at("inst1").kind).toBe("instance");
    // No children in `nodes`: the subtree is VIRTUAL (derived from the master).
    expect(s.nodes.at("inst1").instance).toEqual({ componentId: "cmp1", overrides: [] });
  });

  it("rejects createComponent with empty id, already-taken id or nonexistent root (parity with Go)", () => {
    let s = applyOp(emptyScene("doc1", "Untitled"), createRectOp("m1", 0, 0));
    s = applyOp(s, createComponentOp("cmp1", "m1", "Button"));
    // id already taken = ErrComponentExists; root not in nodes = ErrNodeNotFound;
    // empty id = rejected in Go. Same OBJECT on every rejection.
    expect(applyOp(s, createComponentOp("cmp1", "m1", "Doppione"))).toBe(s);
    expect(applyOp(s, createComponentOp("cmp2", "ghost", "X"))).toBe(s);
    expect(applyOp(s, createComponentOp("", "m1", "Empty"))).toBe(s);
  });

  it("rejects an instance of a nonexistent component (parity: ErrComponentNotFound)", () => {
    const s = applyOp(emptyScene("doc1", "Untitled"), createRectOp("m1", 0, 0));
    // The server rejects it: it would render nothing and no page would
    // notice. Same object, scene unchanged.
    expect(applyOp(s, createInstanceOp("inst1", "ghost"))).toBe(s);
  });

  it("sets, replaces and removes an override (upsert by master_node_id)", () => {
    let s = applyOp(emptyScene("doc1", "Untitled"), createRectOp("m1", 0, 0));
    s = applyOp(s, createComponentOp("cmp1", "m1", "Button"));
    s = applyOp(s, createInstanceOp("inst1", "cmp1"));
    // fill: `fills` present <=> fillsPresent, so the override carries only fills.
    s = applyOp(s, setInstanceOverrideOp("inst1", { masterNodeId: "m1", fills: [{ kind: { case: "solid", value: { color: RED } } }], fillsPresent: true }));
    expect(s.nodes.at("inst1").instance?.overrides).toEqual([{ masterNodeId: "m1", fills: [RED] }]);
    // replacement with text: the upsert REMOVES the fill with the same master and
    // puts back only the new one -- no residue, and `text` present <=> textPresent.
    s = applyOp(s, setInstanceOverrideOp("inst1", { masterNodeId: "m1", text: "Ciao", textPresent: true }));
    expect(s.nodes.at("inst1").instance?.overrides).toEqual([{ masterNodeId: "m1", text: "Ciao" }]);
    // removal: neither fills nor text present => the override disappears, the node stays
    // an instance (goes back to inheriting from the master).
    s = applyOp(s, setInstanceOverrideOp("inst1", { masterNodeId: "m1" }));
    expect(s.nodes.at("inst1").instance?.overrides).toEqual([]);
    expect(s.nodes.at("inst1").kind).toBe("instance");
  });

  it("rejects an override on a non-instance, on a nonexistent id, and with empty master_node_id (parity with Go)", () => {
    let s = applyOp(emptyScene("doc1", "Untitled"), createRectOp("m1", 0, 0));
    // m1 is a rectangle: ErrNotInstanceNode. A nonexistent id: ErrNodeNotFound.
    expect(applyOp(s, setInstanceOverrideOp("m1", { masterNodeId: "x", text: "y", textPresent: true }))).toBe(s);
    expect(applyOp(s, setInstanceOverrideOp("ghost", { masterNodeId: "x", text: "y", textPresent: true }))).toBe(s);
    s = applyOp(s, createComponentOp("cmp1", "m1", "Button"));
    s = applyOp(s, createInstanceOp("inst1", "cmp1"));
    // empty master_node_id: Go rejects it explicitly.
    expect(applyOp(s, setInstanceOverrideOp("inst1", { masterNodeId: "", text: "y", textPresent: true }))).toBe(s);
  });

  // The part the goldens do NOT see: the round trip of overrides. `fills`
  // present <=> fills_present and `text` present <=> text_present in BOTH
  // directions, so an undo of a delete (history.invertOp goes through toPbNode)
  // neither degrades an instance nor loses/invents overrides.
  it("an instance with overrides survives the toNodeLite/toPbNode round trip (LOSSLESS)", () => {
    const node = create(NodeSchema, {
      id: "inst1", parentId: "page1", orderKey: "a0", name: "Instance", visible: true, opacity: 1,
      x: 5, y: 6, width: 0, height: 0,
      shape: { case: "instance", value: { componentId: "cmp1", overrides: [
        { masterNodeId: "m1", fills: [{ kind: { case: "solid", value: { color: RED } } }], fillsPresent: true },
        { masterNodeId: "lbl", text: "Etichetta", textPresent: true },
      ] } },
    });
    const lite = toNodeLite(node);
    expect(lite.kind).toBe("instance");
    // A fill-only override does NOT carry an empty text; a text-only one does NOT
    // carry an empty fill: it is the *_present flags distinction rendered as absence.
    expect(lite.instance).toEqual({
      componentId: "cmp1",
      overrides: [
        { masterNodeId: "m1", fills: [RED] },
        { masterNodeId: "lbl", text: "Etichetta" },
      ],
    });
    const back = toPbNode(lite);
    if (back.shape.case !== "instance") throw new Error("atteso instance");
    expect(back.shape.value.componentId).toBe("cmp1");
    // The *_present flags are rebuilt from the presence of the Lite field.
    expect(back.shape.value.overrides).toMatchObject([
      { masterNodeId: "m1", fillsPresent: true, textPresent: false, text: "" },
      { masterNodeId: "lbl", fillsPresent: false, textPresent: true, text: "Etichetta" },
    ]);
    expect(back.shape.value.overrides[0].fills[0]?.kind).toMatchObject({ case: "solid" });
  });
});

// --- setText ---------------------------------------------------------------
// Mirrors of internal/core/apply_test.go (TestApplySetText*): same scene,
// same assertions. applyOp and core.applySetText must remain semantically
// identical, and this is the TS half of the guard (the other is testdata/golden/text.json).

function createTextOp(id: string, content: string) {
  const node = create(NodeSchema, {
    id, parentId: "page1", orderKey: "a0", name: "Text", visible: true, opacity: 1,
    x: 0, y: 0, width: 200, height: 24,
    shape: { case: "text", value: {
      content,
      style: { fontFamily: "Inter", fontSize: 16, fontWeight: "400", lineHeight: 1.2, align: TextAlign.LEFT },
    } },
  });
  return create(OpSchema, { opId: "op-" + id, docId: "doc1", kind: { case: "createNode", value: { node } } });
}

function setTextOp(value: MessageInitShape<typeof SetTextSchema>) {
  return create(OpSchema, { opId: "op-settext", docId: "doc1", kind: { case: "setText", value } });
}

describe("applyOp: setText", () => {
  it("creates a text node", () => {
    const s = applyOp(emptyScene("doc1", "Untitled"), createTextOp("t1", "ciao"));
    expect(s.nodes.at("t1").kind).toBe("text");
    expect(s.nodes.at("t1").text).toEqual({
      content: "ciao",
      style: { fontFamily: "Inter", fontSize: 16, fontWeight: "400", lineHeight: 1.2, align: "left" },
    });
  });

  it("changes the content of a text node", () => {
    let s = applyOp(emptyScene("doc1", "Untitled"), createTextOp("t1", "ciao"));
    s = applyOp(s, setTextOp({ id: "t1", content: "new text" }));
    expect(s.nodes.at("t1").text?.content).toBe("new text");
  });

  it("is a no-op on a non-text node (parity with core.applySetText: ErrNotTextNode)", () => {
    const s = applyOp(emptyScene("doc1", "Untitled"), createRectOp("n1", 10, 20));
    const s2 = applyOp(s, setTextOp({ id: "n1", content: "x" }));
    // Go rejects the op and does not touch the document: writing a `text` here inside
    // a rectangle would turn it into a node the server does not have.
    expect(s2).toEqual(s);
    expect(s2.nodes.at("n1").kind).toBe("rect");
    expect(s2.nodes.at("n1").text).toBeUndefined();
  });

  it("is a no-op on a missing id (parity with core.applySetText: ErrNodeNotFound)", () => {
    const s = applyOp(emptyScene("doc1", "Untitled"), createTextOp("t1", "ciao"));
    expect(applyOp(s, setTextOp({ id: "ghost", content: "x" }))).toEqual(s);
  });

  it("leaves the existing style alone when stylePresent is false", () => {
    let s = applyOp(emptyScene("doc1", "Untitled"), createTextOp("t1", "ciao"));
    s = applyOp(s, setTextOp({ id: "t1", content: "other" }));
    expect(s.nodes.at("t1").text?.style.fontSize).toBe(16);
    expect(s.nodes.at("t1").text?.style.fontFamily).toBe("Inter");
    // It is the FLAG that decides, not the presence of the sub-message: an explicit `style`
    // with stylePresent=false must be ignored all the same.
    s = applyOp(s, setTextOp({ id: "t1", content: "third", style: { fontSize: 99 } }));
    expect(s.nodes.at("t1").text?.style.fontSize).toBe(16);
    expect(s.nodes.at("t1").text?.content).toBe("third");
  });

  it("replaces the style when stylePresent is true", () => {
    let s = applyOp(emptyScene("doc1", "Untitled"), createTextOp("t1", "ciao"));
    s = applyOp(s, setTextOp({
      id: "t1", content: "ciao", stylePresent: true,
      style: { fontFamily: "Inter", fontSize: 32, fontWeight: "700", lineHeight: 1.5, align: TextAlign.CENTER },
    }));
    expect(s.nodes.at("t1").text?.style).toEqual({
      fontFamily: "Inter", fontSize: 32, fontWeight: "700", lineHeight: 1.5, align: "center",
    });
  });

  it("clears the style when stylePresent is true and no style is carried (parity with Go's nil style)", () => {
    let s = applyOp(emptyScene("doc1", "Untitled"), createTextOp("t1", "ciao"));
    s = applyOp(s, setTextOp({ id: "t1", content: "ciao", stylePresent: true }));
    // Go assigns nil and then reads the fields with nil-safe getters (all zero);
    // NodeLite flattens, so the counterpart is an all-zero style.
    expect(s.nodes.at("t1").text?.style).toEqual({
      fontFamily: "", fontSize: 0, fontWeight: "", lineHeight: 0, align: "left",
    });
  });

});

// --- ImageNode (track 3) -----------------------------------------------------
describe("applyOp: image", () => {
  //
  // The golden fixtures do NOT cover this: they compare `scene.nodes` with
  // `fromDocument(expected).nodes`, that is they pass both sides through the
  // SAME toNodeLite -- an image degraded to a rectangle by both
  // sides compares equal to itself. The node's type and its hash must
  // therefore be asserted here, explicitly.

  it("creates an image node keeping the asset hash (and NOT the bytes)", () => {
    const node = create(NodeSchema, {
      id: "i1", parentId: "page1", orderKey: "a0", name: "logo.png", visible: true, opacity: 1,
      x: 10, y: 20, width: 320, height: 180,
      shape: { case: "image", value: { assetHash: HASH } },
    });
    const op = create(OpSchema, { opId: "op-i1", docId: "doc1", kind: { case: "createNode", value: { node } } });
    const s = applyOp(emptyScene("doc1", "Untitled"), op);
    expect(s.nodes.at("i1").kind).toBe("image");
    expect(s.nodes.at("i1").image?.assetHash).toBe(HASH);
  });

  it("moves and resizes an image without touching the hash", () => {
    let s = applyOp(emptyScene("doc1", "Untitled"), createImageOp("i1"));
    const move = create(OpSchema, { opId: "m", docId: "doc1", kind: { case: "setProps", value: {
      id: "i1", patch: create(NodeSchema, { x: 300, y: 400 }), mask: { paths: ["x", "y"] } } } });
    s = applyOp(s, move);
    expect(s.nodes.at("i1").x).toBe(300);
    expect(s.nodes.at("i1").image?.assetHash).toBe(HASH);
    expect(s.nodes.at("i1").kind).toBe("image");
  });

  // Parity with core.applySetProps: the image is in the list of shapes that
  // reject corner_radius, and for the strongest reason -- the branch that applies
  // the radius REPLACES the shape with a rectangle, that is it would throw away the
  // reference to the asset.
  it("rejects corner_radius on an image, mixed mask included (parity: ErrNotRectNode)", () => {
    const s = applyOp(emptyScene("doc1", "Untitled"), createImageOp("i1"));
    const op = create(OpSchema, { opId: "r", docId: "doc1", kind: { case: "setProps", value: {
      id: "i1",
      patch: create(NodeSchema, { x: 42, shape: { case: "rect", value: { cornerRadius: 12 } } }),
      mask: { paths: ["x", "corner_radius"] },
    } } });
    const after = applyOp(s, op);
    expect(after).toEqual(s);
    expect(after.nodes.at("i1").kind).toBe("image");
    expect(after.nodes.at("i1").image?.assetHash).toBe(HASH);
    expect(after.nodes.at("i1").x).toBe(10);
  });

  it("rejects a setText on an image (parity: ErrNotTextNode)", () => {
    const s = applyOp(emptyScene("doc1", "Untitled"), createImageOp("i1"));
    const after = applyOp(s, setTextOp({ id: "i1", content: "x" }));
    expect(after).toEqual(s);
    expect(after.nodes.at("i1").kind).toBe("image");
  });
});

// --- setVectorPath ---------------------------------------------------------
// Mirrors of internal/core/apply_test.go (TestApplySetVectorPath*): same
// scene, same assertions. applyOp and core.applySetVectorPath must remain
// semantically identical, and this is the TS half of the guard (the other is
// testdata/golden/vector_path.json).

// ASYMMETRIC and never-zero bézier handles: a side that discarded them (or
// derived them by mirroring) cannot pass by chance. They are OFFSETS relative
// to the anchor (see the proto), so small and centered on zero: zero
// would mean "no handle".
const RICH_ANCHORS = [
  { x: 10, y: 20, inX: -2, inY: -1, outX: 4, outY: 6 },
  { x: 60, y: 70, inX: -5, inY: -8, outX: 6, outY: 1 },
];

function createVectorOp(id: string, subpaths: MessageInitShape<typeof VectorNodeSchema>["subpaths"]) {
  const node = create(NodeSchema, {
    id, parentId: "page1", orderKey: "a0", name: "Path", visible: true, opacity: 1,
    x: 0, y: 0, width: 100, height: 80,
    shape: { case: "vector", value: { subpaths } },
  });
  return create(OpSchema, { opId: "op-" + id, docId: "doc1", kind: { case: "createNode", value: { node } } });
}

function setVectorPathOp(value: MessageInitShape<typeof SetVectorPathSchema>) {
  return create(OpSchema, { opId: "op-setvector", docId: "doc1", kind: { case: "setVectorPath", value } });
}

describe("applyOp: setVectorPath", () => {
  const base = () =>
    applyOp(emptyScene("doc1", "Untitled"), createVectorOp("v1", [{ anchors: RICH_ANCHORS, closed: false }]));

  it("creates a vector node carrying anchors and bezier handles", () => {
    const n = base().nodes.at("v1");
    expect(n.kind).toBe("vector");
    expect(n.vector?.subpaths).toEqual([{ anchors: RICH_ANCHORS, closed: false }]);
  });

  it("replaces the subpaths wholesale (no merge, no append)", () => {
    const next = [
      { anchors: RICH_ANCHORS, closed: true },
      { anchors: [{ x: 1, y: 2, inX: 0, inY: 0, outX: 0, outY: 0 }], closed: false },
    ];
    const s = applyOp(base(), setVectorPathOp({ id: "v1", subpaths: next }));
    expect(s.nodes.at("v1").vector?.subpaths).toEqual(next);
  });

  // An EMPTY list is legitimate: it is the path the user emptied, not an
  // "unspecified" to ignore (unlike setText without stylePresent).
  it("an empty subpath list empties the path and keeps the node a vector", () => {
    const s = applyOp(base(), setVectorPathOp({ id: "v1" }));
    expect(s.nodes.at("v1").vector?.subpaths).toEqual([]);
    expect(s.nodes.at("v1").kind).toBe("vector");
  });

  it("is a no-op on a non-vector node (parity with core: ErrNotVectorNode)", () => {
    const s = applyOp(emptyScene("doc1", "Untitled"), createRectOp("n1", 0, 0));
    const after = applyOp(s, setVectorPathOp({ id: "n1", subpaths: [{ anchors: RICH_ANCHORS, closed: true }] }));
    expect(after).toEqual(s);
    // In particular the SHAPE does not change: writing into it would turn the
    // rectangle into a path locally while the server rejected the op.
    expect(after.nodes.at("n1").kind).toBe("rect");
  });

  it("is a no-op on a missing id (parity with core: ErrNodeNotFound)", () => {
    const s = base();
    expect(applyOp(s, setVectorPathOp({ id: "ghost" }))).toEqual(s);
  });

  it("does not mutate the previous state (applyOp is pure)", () => {
    const s = base();
    const before = s.nodes.at("v1").vector?.subpaths;
    applyOp(s, setVectorPathOp({ id: "v1", subpaths: [{ anchors: [], closed: true }] }));
    expect(s.nodes.at("v1").vector?.subpaths).toBe(before);
    expect(before).toEqual([{ anchors: RICH_ANCHORS, closed: false }]);
  });
});

// ---------------------------------------------------------------------------
// FRAME (proto: FrameNode = 34) — a container WITH its own geometry.
// ---------------------------------------------------------------------------

function createFrameOp(id: string, clipsContent: boolean, parentId = "page1") {
  const node = create(NodeSchema, {
    id, parentId, orderKey: "a0", name: "Frame", visible: true, opacity: 1,
    x: 10, y: 10, width: 200, height: 150,
    shape: { case: "frame", value: { clipsContent } },
  });
  return create(OpSchema, { opId: "op-" + id, docId: "doc1", kind: { case: "createNode", value: { node } } });
}

describe("applyOp — frame", () => {
  it("creates a frame with its box and its clipping", () => {
    const s = applyOp(emptyScene("doc1", "Untitled"), createFrameOp("f1", true));
    expect(s.nodes.at("f1").kind).toBe("frame");
    expect(s.nodes.at("f1").clipsContent).toBe(true);
    // The box is ITS OWN (unlike a group, whose bounds are the union of the
    // children): it comes from the createNode and stays there.
    expect(s.nodes.at("f1").width).toBe(200);
  });

  it("clipsContent false is a legitimate value, not 'unset'", () => {
    const s = applyOp(emptyScene("doc1", "Untitled"), createFrameOp("f1", false));
    expect(s.nodes.at("f1").kind).toBe("frame");
    expect(s.nodes.at("f1").clipsContent).toBe(false);
  });

  // Parity with core.applySetProps (Go), which replies ErrNotRectNode: a frame is
  // drawn like a shape but its shape is the FrameNode, and corner_radius
  // lives inside RectNode. The op is rejected as a WHOLE, "x" included.
  it("rejects corner_radius on a frame, x included", () => {
    const before = applyOp(emptyScene("doc1", "Untitled"), createFrameOp("f1", true));
    const after = applyOp(before, create(OpSchema, { opId: "r", docId: "doc1", kind: { case: "setProps", value: {
      id: "f1",
      patch: create(NodeSchema, { x: 999, shape: { case: "rect", value: { cornerRadius: 12 } } }),
      mask: { paths: ["x", "corner_radius"] },
    } } }));
    expect(after).toEqual(before);
    expect(after.nodes.at("f1").kind).toBe("frame");
  });
});

// ---------------------------------------------------------------------------
// PAGES — the document's ROOT containers (parity with core.applyCreatePage /
// applyDeletePage / applyRenamePage). The golden fixtures prove parity
// end-to-end; these tests pin down the behavior seen by the client, including
// the identity of the object returned on a rejected op (a new object
// would wake the selectors for nothing).
// ---------------------------------------------------------------------------

function createPageOp(id: string, name: string) {
  return create(OpSchema, { opId: "op-" + id, docId: "doc1", kind: { case: "createPage", value: { page: { id, name } } } });
}

function deletePageOp(id: string) {
  return create(OpSchema, { opId: "del-" + id, docId: "doc1", kind: { case: "deletePage", value: { id } } });
}

function renamePageOp(id: string, name: string) {
  return create(OpSchema, { opId: "ren-" + id, docId: "doc1", kind: { case: "renamePage", value: { id, name } } });
}

describe("applyOp — pages", () => {
  it("adds the page AT THE END and makes it a valid parent", () => {
    let s = applyOp(emptyScene("doc1", "Untitled"), createPageOp("page2", "Page 2"));
    expect(s.pages).toEqual([{ id: "page1", name: "Page 1" }, { id: "page2", name: "Page 2" }]);
    s = applyOp(s, createChildOp("n1", "page2"));
    expect(s.nodes.at("n1")?.parentId).toBe("page2");
  });

  it("rejects an id already taken by a page or by a NODE (parity: ErrPageExists)", () => {
    const base = applyOp(applyOp(emptyScene("doc1", "Untitled"), createPageOp("page2", "Page 2")), createChildOp("n1", "page1"));
    // Same OBJECT, not just same content: a rejected op must not
    // wake the store's subscribers.
    expect(applyOp(base, createPageOp("page2", "Doppione"))).toBe(base);
    expect(applyOp(base, createPageOp("n1", "Id of a node"))).toBe(base);
    expect(applyOp(base, createPageOp("", "No id"))).toBe(base);
  });

  it("deletes the page and ALL its nodes in cascade, leaving the others alone", () => {
    let s = applyOp(emptyScene("doc1", "Untitled"), createPageOp("page2", "Page 2"));
    s = applyOp(s, createChildOp("g1", "page1"));
    s = applyOp(s, createChildOp("c1", "g1"));
    s = applyOp(s, createChildOp("d1", "c1"));
    s = applyOp(s, createChildOp("keep", "page2"));
    s = applyOp(s, deletePageOp("page1"));
    expect(s.pages).toEqual([{ id: "page2", name: "Page 2" }]);
    expect([...s.nodes.ids()]).toEqual(["keep"]);
  });

  it("does not delete the LAST page (parity: ErrLastPage) nor a nonexistent one", () => {
    const base = applyOp(emptyScene("doc1", "Untitled"), createChildOp("n1", "page1"));
    expect(applyOp(base, deletePageOp("page1"))).toBe(base);
    expect(applyOp(base, deletePageOp("ghost"))).toBe(base);
  });

  it("renames a page, and ignores a nonexistent id (parity: ErrPageNotFound)", () => {
    const base = applyOp(emptyScene("doc1", "Untitled"), createPageOp("page2", "Page 2"));
    const renamed = applyOp(base, renamePageOp("page2", "Cover"));
    expect(renamed.pages).toEqual([{ id: "page1", name: "Page 1" }, { id: "page2", name: "Cover" }]);
    expect(applyOp(base, renamePageOp("ghost", "x"))).toBe(base);
    // An empty name is a value like any other: the fallback belongs to the UI.
    expect(applyOp(base, renamePageOp("page2", "")).pages[1].name).toBe("");
  });
});
