import { describe, it, expect } from "vitest";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { Constraint, LayoutSizing, NodeSchema, OpSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { buildIndex, sceneIndexOf } from "../renderer/sceneIndex";
import { applyOp } from "./applyOp";
import { invertOp } from "./history";
import { emptyScene, type SceneState } from "./types";

type Init = MessageInitShape<typeof NodeSchema>;
const op = (kind: MessageInitShape<typeof OpSchema>["kind"]): Op => create(OpSchema, { opId: crypto.randomUUID(), docId: "d", kind });
const node = (id: string, parentId: string, shape: Init["shape"], over: Init = {}) =>
  op({ case: "createNode", value: { node: create(NodeSchema, { id, parentId, orderKey: id, name: id, visible: true, opacity: 1, x: 0, y: 0, width: 50, height: 20, shape, ...over }) } });
const resize = (id: string, width: number, height: number) =>
  op({ case: "setProps", value: { id, mask: { paths: ["width", "height"] }, patch: create(NodeSchema, { width, height }) } });
const run = (ops: Op[], from: SceneState = emptyScene("d", "d")) => ops.reduce(applyOp, from);
const rect = { case: "rect", value: {} } as const;
const frame = { case: "frame", value: {} } as const;

const tree = () => run([
  node("F", "page1", frame, { width: 200, height: 100 }),
  node("scale", "F", rect, { x: 7, y: 3, width: 33, height: 17, constraintX: Constraint.SCALE, constraintY: Constraint.SCALE }),
  node("stretch", "F", rect, { x: 10, y: 10, width: 60, height: 20, constraintX: Constraint.STRETCH, constraintY: Constraint.STRETCH }),
  node("inner", "F", frame, { x: 20, y: 20, width: 100, height: 40, constraintX: Constraint.STRETCH }),
  node("deep", "inner", rect, { x: 5, y: 5, width: 10, height: 10, constraintX: Constraint.SCALE }),
]);

describe("resizing a frame applies the constraints of its children", () => {
  it("moves, stretches and scales, recursively", () => {
    const s = applyOp(tree(), resize("F", 300, 150));
    expect(s.nodes.at("scale")).toMatchObject({ x: 10.5, y: 4.5, width: 49.5, height: 25.5 });
    expect(s.nodes.at("stretch")).toMatchObject({ x: 10, y: 10, width: 160, height: 70 });   // both margins kept on both axes
    expect(s.nodes.at("inner").width).toBe(200);
    expect(s.nodes.at("deep")).toMatchObject({ x: 10, width: 20 });                   // scaled with the inner frame (100 -> 200)
  });

  it("a frame with auto layout ignores them, and so does a move", () => {
    const al = run([
      node("A", "page1", { case: "frame", value: { autoLayout: { spacing: 4 } } }, { width: 100, height: 50 }),
      node("k", "A", rect, { constraintX: Constraint.STRETCH }),
    ]);
    expect(applyOp(al, resize("A", 200, 50)).nodes.at("k").width).toBe(50);
    const moved = applyOp(tree(), op({ case: "setProps", value: { id: "F", mask: { paths: ["x", "y"] }, patch: create(NodeSchema, { x: 9, y: 9 }) } }));
    expect(moved.nodes.at("scale")).toEqual(tree().nodes.at("scale"));
  });

  it("a stretch never goes below zero, and undo still restores the EXACT numbers", () => {
    const before = tree();
    const direct = resize("F", 20, 10);                                              // a big shrink: stretch clamps at 0
    const after = applyOp(before, direct);
    expect(after.nodes.at("stretch").width).toBe(0);
    const back = run(invertOp(before, direct)!, after);
    for (const id of ["F", "scale", "stretch", "inner", "deep"]) expect(back.nodes.at(id), id).toEqual(before.nodes.at(id));
  });

  it("the scene index follows the children moved by a resize (no stale extents)", () => {
    const before = tree();
    sceneIndexOf(before);
    const after = applyOp(before, resize("F", 300, 150));
    const inc = sceneIndexOf(after);
    const fresh = buildIndex(after);
    expect([...inc.extent].sort()).toEqual([...fresh.extent].sort());
  });
});

describe("layout sizing and constraints are validated", () => {
  it("rejects out-of-range enums, also inside a mixed mask", () => {
    const s = tree();
    const bad = (paths: string[], patch: Init) => applyOp(s, op({ case: "setProps", value: { id: "scale", mask: { paths }, patch: create(NodeSchema, patch) } }));
    // Out-of-range numbers are what a malformed or newer client could put on the wire.
    expect(bad(["constraint_x"], { constraintX: 99 as unknown as Constraint })).toBe(s);
    expect(bad(["layout_sizing_y"], { layoutSizingY: 5 as unknown as LayoutSizing })).toBe(s);
    expect(bad(["x", "constraint_y"], { x: 77, constraintY: 42 as unknown as Constraint })).toBe(s);
    expect(bad(["constraint_x"], { constraintX: Constraint.MAX }).nodes.at("scale").constraintX).toBe("max");
    expect(bad(["constraint_x"], { constraintX: Constraint.UNSPECIFIED }).nodes.at("scale").constraintX).toBeUndefined();
  });

  it("fill takes the free space; hug turns it back into fixed; the filled child frame follows up", () => {
    const row = run([
      node("L", "page1", { case: "frame", value: { autoLayout: { spacing: 10 } } }, { width: 300, height: 100 }),
      node("fixed", "L", rect, { width: 50, height: 30 }),
      node("grow", "L", rect, { width: 10, height: 30, layoutSizingX: LayoutSizing.FILL, layoutSizingY: LayoutSizing.FILL }),
      node("sub", "L", { case: "frame", value: { autoLayout: { crossAlign: 3 } } }, { width: 10, height: 10, layoutSizingX: LayoutSizing.FILL, layoutSizingY: LayoutSizing.FILL }),
      node("subk", "sub", rect, { width: 15, height: 15 }),
    ]);
    // free = 300 - 50 - 20 (two gaps) = 230 -> 115 each; the cross-fill child spans the 100 height.
    expect(row.nodes.at("grow")).toMatchObject({ x: 60, width: 115, height: 100 });
    expect(row.nodes.at("sub")).toMatchObject({ x: 185, width: 115 });
    expect(row.nodes.at("subk").y).toBe(85);                                            // sub was re-laid-out at its new height (100 - 15)
  });
});
