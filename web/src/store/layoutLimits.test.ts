import { describe, it, expect } from "vitest";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { Constraint, LayoutPositioning, LayoutSizing, NodeSchema, OpSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { applyOp } from "./applyOp";
import { invertOp } from "./history";
import { emptyScene, type SceneState } from "./types";

// Size limits and absolute children of an auto layout frame (the Go twin is
// internal/core/layout_limits_test.go; testdata/golden/layout_limits.json runs both).

type Init = MessageInitShape<typeof NodeSchema>;
const op = (kind: MessageInitShape<typeof OpSchema>["kind"]): Op => create(OpSchema, { opId: crypto.randomUUID(), docId: "d", kind });
const node = (id: string, parentId: string, shape: Init["shape"], over: Init = {}) =>
  op({ case: "createNode", value: { node: create(NodeSchema, { id, parentId, orderKey: id, name: id, visible: true, opacity: 1, x: 0, y: 0, width: 20, height: 10, shape, ...over }) } });
const set = (id: string, paths: string[], patch: Init) =>
  op({ case: "setProps", value: { id, mask: { paths }, patch: create(NodeSchema, patch) } });
const run = (ops: Op[], from: SceneState = emptyScene("d", "d")) => ops.reduce(applyOp, from);
const rect = { case: "rect", value: {} } as const;
const row = (extra: object = {}) => ({ case: "frame", value: { autoLayout: { spacing: 10, ...extra } } }) as const;

describe("size limits in an auto layout frame", () => {
  it("clamps a fixed child and the next one follows", () => {
    const s = run([
      node("F", "page1", row(), { width: 200, height: 100 }),
      node("a", "F", rect, { width: 80 }), node("b", "F", rect),
      set("a", ["max_width"], { maxWidth: 30 }),
    ]);
    expect(s.nodes.at("a").width).toBe(30);
    expect(s.nodes.at("b").x).toBe(40);
  });

  it("min wins over max", () => {
    const s = run([node("F", "page1", row(), { width: 200 }), node("a", "F", rect, { minWidth: 50, maxWidth: 40 })]);
    expect(s.nodes.at("a").width).toBe(50);
  });

  it("fill children share around the ones that hit a limit", () => {
    const fill = { layoutSizingX: LayoutSizing.FILL };
    const s = run([
      node("F", "page1", { case: "frame", value: { autoLayout: {} } }, { width: 100, height: 20 }),
      node("a", "F", rect, fill), node("b", "F", rect, fill), node("c", "F", rect, { ...fill, maxWidth: 20 }),
    ]);
    expect([s.nodes.at("a").width, s.nodes.at("b").width, s.nodes.at("c").width]).toEqual([40, 40, 20]);
    const grown = applyOp(s, set("c", ["min_width", "max_width"], { minWidth: 70, maxWidth: 0 }));
    expect([grown.nodes.at("a").width, grown.nodes.at("b").width, grown.nodes.at("c").width]).toEqual([15, 15, 70]);
  });

  it("a hugging frame stays within its own limits", () => {
    const s = run([
      node("F", "page1", row({ hugWidth: true }), { width: 10, height: 30, minWidth: 100 }),
      node("a", "F", rect), node("b", "F", rect),
    ]);
    expect(s.nodes.at("F").width).toBe(100);
    expect(applyOp(s, set("F", ["min_width", "max_width"], { minWidth: 0, maxWidth: 35 })).nodes.at("F").width).toBe(35);
  });

  it("rejects negative or non-finite limits and unknown positioning whole", () => {
    const s = run([node("F", "page1", row()), node("a", "F", rect)]);
    expect(applyOp(s, set("a", ["x", "min_width"], { x: 5, minWidth: -1 }))).toBe(s);
    expect(applyOp(s, set("a", ["max_height"], { maxHeight: Number.NaN }))).toBe(s);
    expect(applyOp(s, set("a", ["layout_positioning"], { layoutPositioning: 7 as LayoutPositioning }))).toBe(s);
  });

  it("undoes exactly", () => {
    const before = run([node("F", "page1", row(), { width: 200 }), node("a", "F", rect, { width: 80 }), node("b", "F", rect)]);
    const direct = set("a", ["max_width"], { maxWidth: 30 });
    const after = applyOp(before, direct);
    const back = run(invertOp(before, direct)!, after);
    for (const id of ["F", "a", "b"]) expect(back.nodes.at(id), id).toEqual(before.nodes.at(id));
  });
});

describe("absolute children", () => {
  const abs = { layoutPositioning: LayoutPositioning.ABSOLUTE };

  it("leave the flow and keep their position", () => {
    const s = run([
      node("F", "page1", row({ hugWidth: true }), { height: 30 }),
      node("a", "F", rect), node("b", "F", rect, { ...abs, x: 3, y: 4 }), node("c", "F", rect),
    ]);
    expect(s.nodes.at("F").width).toBe(50);
    expect(s.nodes.at("c").x).toBe(30);
    expect(s.nodes.at("b")).toMatchObject({ x: 3, y: 4 });
    const back = applyOp(s, set("b", ["layout_positioning"], { layoutPositioning: LayoutPositioning.AUTO }));
    expect(back.nodes.at("b").layoutPositioning).toBeUndefined();
    expect(back.nodes.at("c").x).toBe(60);
  });

  it("follow a resized frame by their constraints", () => {
    const s = run([
      node("F", "page1", row(), { width: 200, height: 100 }),
      node("a", "F", rect), node("b", "F", rect, { ...abs, x: 150, y: 80, constraintX: Constraint.MAX, constraintY: Constraint.MAX }),
    ]);
    const grown = applyOp(s, set("F", ["width", "height"], { width: 250, height: 120 }));
    expect(grown.nodes.at("b")).toMatchObject({ x: 200, y: 100 });
    expect(grown.nodes.at("a")).toMatchObject({ x: 0, y: 0 });
  });
});
