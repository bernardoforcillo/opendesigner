import { describe, it, expect } from "vitest";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { NodeSchema, OpSchema, StrokeAlign, TextStyleSchema, SetVectorPathSchema, TextAlign } from "../gen/opendesigner/v1/opendesigner_pb";
import type { Node as PbNode, Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { applyOp } from "./applyOp";
import { emptyScene, toNodeLite, toPbNode, type NodeLite, type SceneState } from "./types";
import { invertOp } from "./history";

// "Rich" node: every field different from its zero, so an inverse that
// forgets one shows up right away in the round-trip. Color channels are float32 in the
// proto: exactly representable values (multiples of 1/4) so the test does not
// depend on rounding.
function richRect(id = "n1"): PbNode {
  return create(NodeSchema, {
    id, parentId: "page1", orderKey: "a3V", name: "Blob",
    visible: false, opacity: 0.25,
    x: 10, y: -20, width: 100, height: 80, rotation: 0.5,
    fills: [
      { kind: { case: "solid", value: { color: { r: 0.25, g: 0.5, b: 0.75, a: 1 } } } },
      { kind: { case: "solid", value: { color: { r: 1, g: 0, b: 0, a: 0.5 } } } },
    ],
    strokes: [
      { paint: { kind: { case: "solid", value: { color: { r: 0.5, g: 0, b: 0, a: 1 } } } },
        weight: 4, align: StrokeAlign.OUTSIDE },
      { paint: { kind: { case: "solid", value: { color: { r: 0, g: 0, b: 0.25, a: 0.5 } } } },
        weight: 1.5, align: StrokeAlign.INSIDE },
    ],
    shape: { case: "rect", value: { cornerRadius: 12 } },
  });
}

function richEllipse(id = "e1"): PbNode {
  return create(NodeSchema, {
    id, parentId: "page1", orderKey: "a7", name: "Round",
    visible: true, opacity: 1,
    x: 3, y: 4, width: 60, height: 30, rotation: 0,
    fills: [{ kind: { case: "solid", value: { color: { r: 0, g: 0.5, b: 1, a: 1 } } } }],
    shape: { case: "ellipse", value: {} },
  });
}

function richText(id = "t1"): PbNode {
  return create(NodeSchema, {
    id, parentId: "page1", orderKey: "a5", name: "Titolo",
    visible: true, opacity: 0.75,
    x: 8, y: 9, width: 320, height: 48, rotation: 0,
    fills: [{ kind: { case: "solid", value: { color: { r: 0, g: 0, b: 0, a: 1 } } } }],
    shape: { case: "text", value: {
      content: "ciao\nmondo",
      style: { fontFamily: "Inter", fontSize: 24, fontWeight: "700", lineHeight: 1.5, align: TextAlign.RIGHT },
    } },
  });
}

// A "rich" vector node: two subpaths that differ ONLY in `closed`, and
// asymmetric, never-zero bézier handles (they are OFFSETS relative to the anchor,
// see the proto: zero would mean "no handle"). A conversion
// that lost `closed`, discarded in/out or derived them by
// mirroring would produce a different round-trip here -- and in production
// would silently destroy the user's curves at the first undo.
function richVector(id = "v1"): PbNode {
  const anchors = [
    { x: 0, y: 0, inX: -4, inY: -3, outX: 5, outY: 2 },
    { x: 40, y: 12, inX: -5, inY: -6, outX: 6, outY: 7 },
  ];
  return create(NodeSchema, {
    id, parentId: "page1", orderKey: "a9", name: "Path",
    visible: true, opacity: 0.5,
    x: 1, y: 2, width: 80, height: 40, rotation: 0,
    fills: [{ kind: { case: "solid", value: { color: { r: 0.25, g: 0.5, b: 0.75, a: 1 } } } }],
    shape: { case: "vector", value: { subpaths: [
      { anchors, closed: true },
      { anchors, closed: false },
    ] } },
  });
}

function setVectorPathOp(id: string, subpaths: MessageInitShape<typeof SetVectorPathSchema>["subpaths"]): Op {
  return create(OpSchema, {
    opId: "op-setvector", docId: "doc1",
    kind: { case: "setVectorPath", value: { id, subpaths } },
  });
}

function setTextOp(id: string, content: string, style?: MessageInitShape<typeof TextStyleSchema>): Op {
  return create(OpSchema, {
    opId: "op-settext", docId: "doc1",
    kind: { case: "setText", value: { id, content, style, stylePresent: style !== undefined } },
  });
}

function createOp(node: PbNode): Op {
  return create(OpSchema, { opId: "op-create", docId: "doc1", kind: { case: "createNode", value: { node } } });
}

function deleteOp(id: string): Op {
  return create(OpSchema, { opId: "op-delete", docId: "doc1", kind: { case: "deleteNode", value: { id } } });
}

function setPropsOp(id: string, patch: MessageInitShape<typeof NodeSchema>, paths: string[]): Op {
  return create(OpSchema, {
    opId: "op-set", docId: "doc1",
    kind: { case: "setProps", value: { id, patch: create(NodeSchema, patch), mask: { paths } } },
  });
}

function sceneWith(...nodes: PbNode[]): SceneState {
  return nodes.reduce((s, n) => applyOp(s, createOp(n)), emptyScene("doc1", "Untitled"));
}

// --- page ops --------------------------------------------------------------
function createPageOp(id: string, name: string): Op {
  return create(OpSchema, { opId: "op-createpage", docId: "doc1", kind: { case: "createPage", value: { page: { id, name } } } });
}

function deletePageOp(id: string): Op {
  return create(OpSchema, { opId: "op-deletepage", docId: "doc1", kind: { case: "deletePage", value: { id } } });
}

function renamePageOp(id: string, name: string): Op {
  return create(OpSchema, { opId: "op-renamepage", docId: "doc1", kind: { case: "renamePage", value: { id, name } } });
}

// Scene with a SECOND page (page2, "Page 2") at the end and the nodes moved
// under it.
function sceneWithPage2(...nodes: PbNode[]): SceneState {
  const base = applyOp(emptyScene("doc1", "Untitled"), createPageOp("page2", "Page 2"));
  return nodes.reduce((s, n) => applyOp(s, createOp(n)), base);
}

// THE property: applying an op and then its inverse brings the scene back
// EXACTLY to the starting state. Asserting on the round-trip instead of on
// individual fields also catches the fields nobody remembered to check.
//
// The inverse is a LIST to apply in order: deleting a
// subtree is undone by re-creating every node, and in the right order (see
// invertOp). For all other ops it is a list of one.
function expectRoundTrip(scene: SceneState, op: Op): Op[] {
  const inv = invertOp(scene, op);
  expect(inv).not.toBeNull();
  const ops = inv as Op[];
  expect(ops.length).toBeGreaterThan(0);
  let after = applyOp(scene, op);
  for (const i of ops) after = applyOp(after, i);
  expect(after).toEqual(scene);
  return ops;
}

// Convenience for ops whose inverse is a SINGLE one.
function expectSingleRoundTrip(scene: SceneState, op: Op): Op {
  const ops = expectRoundTrip(scene, op);
  expect(ops.length).toBe(1);
  return ops[0];
}

describe("toPbNode", () => {
  it("is the inverse of toNodeLite (rect, all fields)", () => {
    const lite = toNodeLite(richRect());
    expect(toNodeLite(toPbNode(lite))).toEqual(lite);
  });

  it("is the inverse of toNodeLite (ellipse)", () => {
    const lite = toNodeLite(richEllipse());
    const back = toPbNode(lite);
    expect(back.shape.case).toBe("ellipse");
    expect(toNodeLite(back)).toEqual(lite);
  });

  it("is the inverse of toNodeLite (text: contenuto E stile)", () => {
    const lite = toNodeLite(richText());
    const back = toPbNode(lite);
    expect(back.shape.case).toBe("text");
    if (back.shape.case !== "text") throw new Error("wrong shape");
    expect(back.shape.value.content).toBe("ciao\nmondo");
    expect(back.shape.value.style?.fontSize).toBe(24);
    expect(back.shape.value.style?.fontWeight).toBe("700");
    expect(back.shape.value.style?.align).toBe(TextAlign.RIGHT);
    expect(toNodeLite(back)).toEqual(lite);
  });

  // The geometry conversion is the point where a loss makes no noise:
  // a forgotten field breaks nothing right away, it deletes the user's curves
  // at the first undo (the inverse of a delete is the create of the node as it was, and the
  // in-memory model keeps only NodeLite).
  it("is the inverse of toNodeLite (vector: subpaths, anchors AND handles)", () => {
    const lite = toNodeLite(richVector());
    const back = toPbNode(lite);
    expect(back.shape.case).toBe("vector");
    if (back.shape.case !== "vector") throw new Error("wrong shape");

    // Explicit before the round-trip: `toEqual` alone would pass even if
    // BOTH directions lost the same field in the same way.
    expect(back.shape.value.subpaths).toHaveLength(2);
    expect(back.shape.value.subpaths.map((sp) => sp.closed)).toEqual([true, false]);
    const a = back.shape.value.subpaths[0].anchors[1];
    expect([a.x, a.y, a.inX, a.inY, a.outX, a.outY]).toEqual([40, 12, -5, -6, 6, 7]);

    expect(toNodeLite(back)).toEqual(lite);
  });

  // An EMPTIED path stays a vector node: rebuilding it as a rectangle
  // would be a silent shape change inside an undo (same reason
  // the "text" branch does not fall back to rect when the content is missing).
  it("a vector without subpaths stays a vector (does not fall back to rect)", () => {
    const lite: NodeLite = { ...toNodeLite(richVector()), vector: { subpaths: [] } };
    const back = toPbNode(lite);
    expect(back.shape.case).toBe("vector");
    expect(toNodeLite(back)).toEqual(lite);
  });
});

describe("invertOp: createNode", () => {
  it("round-trips: create + inverse = empty starting scene", () => {
    const scene = emptyScene("doc1", "Untitled");
    const inv = expectSingleRoundTrip(scene, createOp(richRect()));
    expect(inv.kind.case).toBe("deleteNode");
    expect(inv.kind.case === "deleteNode" && inv.kind.value.id).toBe("n1");
  });

  it("null when the id already exists: the direct op is rejected (ErrNodeExists in Go)", () => {
    // core.applyCreate (Go) rejects an id already present and applyOp mirrors it:
    // the direct op changes NOTHING, so there is nothing to undo.
    // Generating an inverse here would send the server the undo of an op the
    // server rejected.
    const scene = sceneWith(richRect());
    const op = createOp(richEllipse("n1"));
    expect(applyOp(scene, op)).toEqual(scene);
    expect(invertOp(scene, op)).toBeNull();
  });
});

describe("invertOp: setProps", () => {
  it("round-trips on a multiple mask (x,y,width,height)", () => {
    const scene = sceneWith(richRect());
    const inv = expectSingleRoundTrip(
      scene,
      setPropsOp("n1", { x: 999, y: 888, width: 7, height: 6 }, ["x", "y", "width", "height"]),
    );
    expect(inv.kind.case).toBe("setProps");
    if (inv.kind.case !== "setProps") throw new Error("wrong kind");
    // same mask as the direct op: only what the op had changed changes.
    expect(inv.kind.value.mask?.paths).toEqual(["x", "y", "width", "height"]);
    expect(inv.kind.value.patch?.x).toBe(10);
    expect(inv.kind.value.patch?.y).toBe(-20);
  });

  it("round-trips su fills / name / visible / opacity / rotation", () => {
    const scene = sceneWith(richRect());
    expectRoundTrip(
      scene,
      setPropsOp(
        "n1",
        {
          name: "Other", visible: true, opacity: 1, rotation: 1.25,
          fills: [{ kind: { case: "solid", value: { color: { r: 0, g: 0, b: 0, a: 1 } } } }],
        },
        ["fills", "name", "visible", "opacity", "rotation"],
      ),
    );
  });

  // The REPEATED field on which the inverse is easiest to get wrong: the mask
  // replaces the whole list, so the inverse must bring back ALL the strokes
  // from before, not just the first -- and the direct op here removes one on purpose.
  it("round-trips on strokes: a shorter list comes back as long as it was", () => {
    const scene = sceneWith(richRect());
    const op = setPropsOp(
      "n1",
      { strokes: [{ paint: { kind: { case: "solid", value: { color: { r: 1, g: 1, b: 1, a: 1 } } } }, weight: 9, align: StrokeAlign.CENTER }] },
      ["strokes"],
    );
    const after = applyOp(scene, op);
    // The direct op really bites: without this, the round-trip would pass
    // falsely even on an applyOp that ignores the path.
    expect(after.nodes.at("n1").strokes).toHaveLength(1);
    expect(after.nodes.at("n1").strokes[0].weight).toBe(9);
    expectRoundTrip(scene, op);
  });

  it("round-trips a single-path mask without touching the rest", () => {
    const scene = sceneWith(richRect(), richEllipse());
    expectRoundTrip(scene, setPropsOp("e1", { x: 42 }, ["x"]));
  });

  it("round-trips an op WITHOUT a patch, which ZEROES the fields in the mask (Go nil-safe getter)", () => {
    // Go reads the patch with p.GetX() & co.: on a nil patch they return the zero
    // of the field, so the op zeroes x and fills instead of being a no-op.
    // I verify first that the direct op really bites -- if it were a no-op the
    // round-trip would pass falsely.
    const scene = sceneWith(richRect());
    const op = create(OpSchema, {
      opId: "op-set", docId: "doc1",
      kind: { case: "setProps", value: { id: "n1", mask: { paths: ["x", "fills"] } } },
    });
    const after = applyOp(scene, op);
    expect(after.nodes.at("n1").x).toBe(0);
    expect(after.nodes.at("n1").fills).toEqual([]);
    expect(after.nodes.at("n1").y).toBe(-20); // outside the mask: intact

    expectRoundTrip(scene, op);
  });
});

describe("invertOp: deleteNode", () => {
  it("restores ALL the rect's fields (fills, orderKey, kind, cornerRadius)", () => {
    const scene = sceneWith(richRect());
    const [inv] = expectRoundTrip(scene, deleteOp("n1"));
    expect(inv.kind.case).toBe("createNode");
    if (inv.kind.case !== "createNode") throw new Error("wrong kind");
    const restored = inv.kind.value.node as PbNode;
    expect(restored.orderKey).toBe("a3V");
    expect(restored.name).toBe("Blob");
    expect(restored.visible).toBe(false);
    expect(restored.opacity).toBe(0.25);
    expect(restored.rotation).toBe(0.5);
    expect(restored.fills.length).toBe(2);
    expect(restored.shape.case).toBe("rect");
    expect(restored.shape.case === "rect" && restored.shape.value.cornerRadius).toBe(12);
  });

  it("restores an ellipse keeping the shape discriminant", () => {
    const scene = sceneWith(richRect(), richEllipse());
    const inv = expectSingleRoundTrip(scene, deleteOp("e1"));
    expect(inv.kind.case === "createNode" && inv.kind.value.node?.shape.case).toBe("ellipse");
  });
});

// --- l'albero: cascata e riparentazione ------------------------------------

function childNode(id: string, parentId: string, orderKey = "a1"): PbNode {
  return create(NodeSchema, {
    id, parentId, orderKey, name: id, visible: true, opacity: 1,
    x: 1, y: 2, width: 10, height: 10,
    shape: { case: "rect", value: { cornerRadius: 3 } },
  });
}

function reparentOp(id: string, newParentId: string, orderKey: string): Op {
  return create(OpSchema, {
    opId: "op-reparent", docId: "doc1",
    kind: { case: "reparentNode", value: { id, newParentId, orderKey } },
  });
}

//   page1
//   ├── g1
//   │   ├── c1
//   │   │   └── d1
//   │   └── c2
//   └── other
function treeScene(): SceneState {
  return sceneWith(
    childNode("g1", "page1", "a1"),
    childNode("c1", "g1", "a1"),
    childNode("d1", "c1", "a1"),
    childNode("c2", "g1", "a2"),
    childNode("other", "page1", "a2"),
  );
}

describe("invertOp: deleteNode cascading", () => {
  it("restores the WHOLE subtree (exact round-trip)", () => {
    const scene = treeScene();
    const inv = expectRoundTrip(scene, deleteOp("g1"));
    expect(inv.length).toBe(4);
    expect(inv.every((o) => o.kind.case === "createNode")).toBe(true);
  });

  it("re-creates the PARENTs before the children (otherwise every child would be rejected)", () => {
    const scene = treeScene();
    const inv = invertOp(scene, deleteOp("g1")) as Op[];
    const ids = inv.map((o) => (o.kind.case === "createNode" ? o.kind.value.node?.id : undefined));
    expect(ids).toEqual(["g1", "c1", "d1", "c2"]);
    // The real proof is not the order itself but that the invariant holds at every
    // step: applied one by one, none is discarded.
    let s = applyOp(scene, deleteOp("g1"));
    for (const o of inv) {
      const before = s.nodes.size;
      s = applyOp(s, o);
      expect(s.nodes.size).toBe(before + 1);
    }
  });

  it("the REVERSE order would be rejected — it is the reason the order matters", () => {
    const scene = treeScene();
    const inv = (invertOp(scene, deleteOp("g1")) as Op[]).slice().reverse();
    let s = applyOp(scene, deleteOp("g1"));
    for (const o of inv) s = applyOp(s, o);
    // Only the root lands: the children, sent first, find the parent
    // still nonexistent (ErrParentNotFound in Go).
    expect([...s.nodes.ids()].sort()).toEqual(["g1", "other"]);
  });
});

describe("invertOp: reparentNode", () => {
  it("round-trips: puts the node back under the old parent with the old key", () => {
    const scene = treeScene();
    const inv = expectSingleRoundTrip(scene, reparentOp("c1", "other", "a9"));
    expect(inv.kind.case).toBe("reparentNode");
    if (inv.kind.case !== "reparentNode") throw new Error("wrong kind");
    expect(inv.kind.value.newParentId).toBe("g1");
    expect(inv.kind.value.orderKey).toBe("a1");
  });

  it("round-trips a reorder among peers (same parent, new key)", () => {
    expectRoundTrip(treeScene(), reparentOp("c1", "g1", "a5"));
  });

  it("null when the direct op would be rejected (cycle, nonexistent parent or node)", () => {
    const scene = treeScene();
    for (const op of [
      reparentOp("g1", "d1", "a9"),   // ciclo
      reparentOp("g1", "g1", "a9"),   // itself
      reparentOp("c1", "ghost", "a9"),
      reparentOp("ghost", "page1", "a9"),
    ]) {
      expect(applyOp(scene, op)).toEqual(scene);
      expect(invertOp(scene, op)).toBeNull();
    }
  });
});

describe("invertOp: setText", () => {
  it("round-trips a content-only change", () => {
    const scene = sceneWith(richText());
    const inv = expectSingleRoundTrip(scene, setTextOp("t1", "other content"));
    expect(inv.kind.case).toBe("setText");
    if (inv.kind.case !== "setText") throw new Error("wrong kind");
    expect(inv.kind.value.content).toBe("ciao\nmondo");
    // The inverse ALWAYS carries stylePresent=true: putting back the previous style is
    // a no-op when the direct op had not touched it, while omitting it
    // would leave the NEW style standing after the undo of an op that had
    // changed it. A single branch, always exact.
    expect(inv.kind.value.stylePresent).toBe(true);
    expect(inv.kind.value.style?.fontSize).toBe(24);
  });

  it("round-trips a style change (stylePresent=true)", () => {
    const scene = sceneWith(richText());
    const op = setTextOp("t1", "ciao\nmondo", { fontFamily: "Inter", fontSize: 12, fontWeight: "400", lineHeight: 1, align: TextAlign.CENTER });
    // The direct op really bites: without this, the round-trip would pass falsely.
    expect(applyOp(scene, op).nodes.at("t1").text?.style.fontSize).toBe(12);
    expectRoundTrip(scene, op);
  });

  it("null on a nonexistent id", () => {
    expect(invertOp(sceneWith(richText()), setTextOp("ghost", "x"))).toBeNull();
  });

  it("null on a NON-text node: the direct op is rejected (ErrNotTextNode in Go)", () => {
    const scene = sceneWith(richRect());
    const op = setTextOp("n1", "x");
    expect(applyOp(scene, op)).toEqual(scene);
    expect(invertOp(scene, op)).toBeNull();
  });
});

describe("invertOp: setVectorPath", () => {
  it("round-trips a path replacement carrying the PREVIOUS subpaths", () => {
    const scene = sceneWith(richVector());
    const op = setVectorPathOp("v1", [{ anchors: [{ x: 5, y: 5, inX: 1, inY: 1, outX: 9, outY: 9 }], closed: false }]);
    // The direct op really bites: without this, the round-trip would pass falsely.
    expect(applyOp(scene, op).nodes.at("v1").vector?.subpaths).toHaveLength(1);
    // The inverse of setVectorPath is a list of ONE element (invertOp returns
    // Op[] since the inverse of a delete is a cascade): expectSingleRoundTrip
    // asserts its length is 1 and returns the single op.
    const inv = expectSingleRoundTrip(scene, op);

    expect(inv.kind.case).toBe("setVectorPath");
    if (inv.kind.case !== "setVectorPath") throw new Error("wrong kind");
    // The two previous subpaths, `closed` included: it is the field that distinguishes the
    // two outlines of richVector, otherwise identical.
    expect(inv.kind.value.subpaths.map((sp) => sp.closed)).toEqual([true, false]);
    const a = inv.kind.value.subpaths[0].anchors[1];
    expect([a.x, a.y, a.inX, a.inY, a.outX, a.outY]).toEqual([40, 12, -5, -6, 6, 7]);
  });

  // The case the dedicated op makes trivial: EMPTYING a path is undoable
  // exactly like filling it, because the inverse is always "the subpaths from before".
  it("round-trips EMPTYING a path", () => {
    const scene = sceneWith(richVector());
    const op = setVectorPathOp("v1", []);
    expect(applyOp(scene, op).nodes.at("v1").vector?.subpaths).toEqual([]);
    expectRoundTrip(scene, op);
  });

  it("round-trips FILLING a previously empty path (inverse = empty list)", () => {
    const empty = create(NodeSchema, {
      id: "v0", parentId: "page1", orderKey: "a1", name: "Empty", visible: true, opacity: 1,
      shape: { case: "vector", value: {} },
    });
    const scene = sceneWith(empty);
    const inv = expectSingleRoundTrip(scene, setVectorPathOp("v0", [{ anchors: [{ x: 1, y: 2 }], closed: false }]));
    expect(inv.kind.case === "setVectorPath" && inv.kind.value.subpaths).toEqual([]);
  });

  it("null on a nonexistent id", () => {
    expect(invertOp(sceneWith(richVector()), setVectorPathOp("ghost", []))).toBeNull();
  });

  it("null on a NON-vector node: the direct op is rejected (ErrNotVectorNode in Go)", () => {
    const scene = sceneWith(richRect());
    const op = setVectorPathOp("n1", [{ anchors: [{ x: 1, y: 2 }], closed: true }]);
    expect(applyOp(scene, op)).toEqual(scene);
    expect(invertOp(scene, op)).toBeNull();
  });
});

// --- pages: creation, rename and cascading deletion ------------------------
// Pages are the ROOT containers. Their inverse mirrors that of
// nodes -- a create is undone with a delete, a rename by putting back the
// previous name -- except deletion, which like deleteNode takes away a whole
// subtree and undoing it means re-creating all of it, parent before children.

describe("invertOp: createPage", () => {
  it("round-trips: creates the page, the inverse removes it", () => {
    const scene = emptyScene("doc1", "Untitled");
    const inv = expectSingleRoundTrip(scene, createPageOp("page2", "Page 2"));
    expect(inv.kind.case).toBe("deletePage");
    expect(inv.kind.case === "deletePage" && inv.kind.value.id).toBe("page2");
  });

  it("null when the id is already taken by another page (ErrPageExists in Go)", () => {
    const scene = emptyScene("doc1", "Untitled");
    const op = createPageOp("page1", "Doppione");
    expect(applyOp(scene, op)).toEqual(scene);
    expect(invertOp(scene, op)).toBeNull();
  });

  it("null when the id collides with a NODE (parentExists covers both)", () => {
    const scene = sceneWith(richRect("n1"));
    const op = createPageOp("n1", "Same as the node");
    expect(applyOp(scene, op)).toEqual(scene);
    expect(invertOp(scene, op)).toBeNull();
  });

  it("null for a page with an empty id (ErrNilPage in Go)", () => {
    const scene = emptyScene("doc1", "Untitled");
    const op = createPageOp("", "No id");
    expect(applyOp(scene, op)).toEqual(scene);
    expect(invertOp(scene, op)).toBeNull();
  });
});

describe("invertOp: renamePage", () => {
  it("round-trips: puts back the PREVIOUS name (read from the pre-apply scene)", () => {
    const scene = emptyScene("doc1", "Untitled"); // page1 = "Page 1"
    const inv = expectSingleRoundTrip(scene, renamePageOp("page1", "New name"));
    expect(inv.kind.case).toBe("renamePage");
    if (inv.kind.case !== "renamePage") throw new Error("wrong kind");
    expect(inv.kind.value.id).toBe("page1");
    expect(inv.kind.value.name).toBe("Page 1");
  });

  it("round-trips a rename to an EMPTY name too", () => {
    expectRoundTrip(emptyScene("doc1", "Untitled"), renamePageOp("page1", ""));
  });

  it("null on a nonexistent page (ErrPageNotFound in Go)", () => {
    const scene = emptyScene("doc1", "Untitled");
    const op = renamePageOp("ghost", "x");
    expect(applyOp(scene, op)).toEqual(scene);
    expect(invertOp(scene, op)).toBeNull();
  });
});

describe("invertOp: deletePage cascading", () => {
  it("round-trips an EMPTY page: only the re-creation of the page", () => {
    const scene = sceneWithPage2();
    const inv = expectRoundTrip(scene, deletePageOp("page2"));
    expect(inv.length).toBe(1);
    expect(inv[0].kind.case).toBe("createPage");
    expect(inv[0].kind.case === "createPage" && inv[0].kind.value.page?.name).toBe("Page 2");
  });

  //   page2
  //   ├── g1
  //   │   ├── c1
  //   │   │   └── d1
  //   │   └── c2
  //   └── other
  function pageTree(): SceneState {
    return sceneWithPage2(
      childNode("g1", "page2", "a1"),
      childNode("c1", "g1", "a1"),
      childNode("d1", "c1", "a1"),
      childNode("c2", "g1", "a2"),
      childNode("other", "page2", "a2"),
    );
  }

  it("restores the page AND ITS WHOLE subtree (exact round-trip)", () => {
    const inv = expectRoundTrip(pageTree(), deletePageOp("page2"));
    // createPage + one createNode for each of the 5 nodes.
    expect(inv.length).toBe(6);
    expect(inv[0].kind.case).toBe("createPage");
    expect(inv.slice(1).every((o) => o.kind.case === "createNode")).toBe(true);
  });

  it("re-creates the PAGE before the nodes, and every parent before the children", () => {
    const scene = pageTree();
    const inv = invertOp(scene, deletePageOp("page2")) as Op[];
    expect(inv[0].kind.case).toBe("createPage");
    const ids = inv.slice(1).map((o) => (o.kind.case === "createNode" ? o.kind.value.node?.id : undefined));
    expect(ids).toEqual(["g1", "c1", "d1", "c2", "other"]);
    // The real proof is not the order itself but that the container invariant holds
    // at every step: applied one by one on the post-delete scene, none is
    // discarded (createPage adds the page, every createNode a node).
    let s = applyOp(scene, deletePageOp("page2"));
    for (const o of inv) {
      const before = s.pages.length + s.nodes.size;
      s = applyOp(s, o);
      expect(s.pages.length + s.nodes.size).toBe(before + 1);
    }
  });

  it("the REVERSE order would be rejected — it is the reason the order matters", () => {
    const scene = pageTree();
    const inv = (invertOp(scene, deletePageOp("page2")) as Op[]).slice().reverse();
    let s = applyOp(scene, deletePageOp("page2"));
    for (const o of inv) s = applyOp(s, o);
    // Nodes, sent before their page/parent, find the container
    // still nonexistent (ErrParentNotFound): only page1 and the re-created page2
    // land, no node.
    expect([...s.nodes.ids()]).toEqual([]);
    expect(s.pages.map((p) => p.id).sort()).toEqual(["page1", "page2"]);
  });

  it("null on the LAST page: the direct op is rejected (ErrLastPage in Go)", () => {
    const scene = emptyScene("doc1", "Untitled"); // only page1
    const op = deletePageOp("page1");
    expect(applyOp(scene, op)).toEqual(scene);
    expect(invertOp(scene, op)).toBeNull();
  });

  it("null on a nonexistent page (ErrPageNotFound in Go)", () => {
    const scene = sceneWithPage2();
    const op = deletePageOp("ghost");
    expect(applyOp(scene, op)).toEqual(scene);
    expect(invertOp(scene, op)).toBeNull();
  });
});

describe("invertOp: no inverse possible", () => {
  it("null for setProps on a nonexistent id", () => {
    expect(invertOp(sceneWith(richRect()), setPropsOp("ghost", { x: 1 }, ["x"]))).toBeNull();
  });

  it("null for deleteNode on a nonexistent id", () => {
    expect(invertOp(sceneWith(richRect()), deleteOp("ghost"))).toBeNull();
  });

  it("null for createNode without a node", () => {
    const op = create(OpSchema, { opId: "x", docId: "doc1", kind: { case: "createNode", value: {} } });
    expect(invertOp(emptyScene("doc1", "Untitled"), op)).toBeNull();
  });

  it("null for createNode with an empty id (ErrNilNode in Go)", () => {
    const op = createOp(create(NodeSchema, { id: "", parentId: "page1" }));
    expect(invertOp(emptyScene("doc1", "Untitled"), op)).toBeNull();
  });

  it("null for createNode with a nonexistent parent (ErrParentNotFound in Go)", () => {
    const scene = emptyScene("doc1", "Untitled");
    const op = createOp(childNode("n1", "ghost"));
    expect(applyOp(scene, op)).toEqual(scene);
    expect(invertOp(scene, op)).toBeNull();
  });

  it("null for an op without kind", () => {
    expect(invertOp(emptyScene("doc1", "Untitled"), create(OpSchema, { opId: "x", docId: "doc1" }))).toBeNull();
  });
});

describe("invertOp: identity of the op", () => {
  it("inherits the direct op's docId and gets a new unique opId", () => {
    const scene = sceneWith(richRect());
    const op = deleteOp("n1");
    const [a] = invertOp(scene, op) as Op[];
    const [b] = invertOp(scene, op) as Op[];
    expect(a.docId).toBe("doc1");
    expect(a.opId).not.toBe("");
    expect(a.opId).not.toBe(op.opId);
    expect(a.opId).not.toBe(b.opId);
  });

  it("does not mutate the scene or the ops passed", () => {
    const scene = sceneWith(richRect());
    const before: NodeLite = { ...scene.nodes.at("n1") };
    const op = setPropsOp("n1", { x: 5 }, ["x"]);
    invertOp(scene, op);
    expect(scene.nodes.at("n1")).toEqual(before);
    expect(op.kind.case === "setProps" && op.kind.value.patch?.x).toBe(5);
  });
});
