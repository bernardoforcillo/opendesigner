import { describe, it, expect } from "vitest";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { GridTrackKind, LayoutAlign, LayoutMode, LayoutSizing, NodeSchema, OpSchema } from "@/gen/opendesigner/v1/opendesigner_pb";
import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";
import { applyOp } from "@/store/applyOp";
import { invertOp } from "@/store/history";
import { isValidGridCell, isValidGridLayout } from "@/store/layoutGrid";
import { emptyScene, type SceneState } from "@/store/types";

// GRID mode and groups as auto layout children (the Go twin is internal/core/layout_grid_test.go;
// testdata/golden/layout_grid.json and layout_group.json run both on the same numbers).

type Init = MessageInitShape<typeof NodeSchema>;
const op = (kind: MessageInitShape<typeof OpSchema>["kind"]): Op => create(OpSchema, { opId: crypto.randomUUID(), docId: "d", kind });
const node = (id: string, parentId: string, shape: Init["shape"], over: Init = {}) =>
  op({ case: "createNode", value: { node: create(NodeSchema, { id, parentId, orderKey: id, name: id, visible: true, opacity: 1, x: 0, y: 0, width: 20, height: 10, shape, ...over }) } });
const set = (id: string, paths: string[], patch: Init) =>
  op({ case: "setProps", value: { id, mask: { paths }, patch: create(NodeSchema, patch) } });
const run = (ops: Op[], from: SceneState = emptyScene("d", "d")) => ops.reduce(applyOp, from);
const rect = { case: "rect", value: {} } as const;
const group = { case: "group", value: {} } as const;
const fixed = (size: number) => ({ kind: GridTrackKind.FIXED, size });
const fr = (size: number) => ({ kind: GridTrackKind.FR, size });
const hug = { kind: GridTrackKind.HUG, size: 0 };
const grid = (extra: object = {}) => ({ case: "frame", value: { autoLayout: { mode: LayoutMode.GRID, ...extra } } }) as const;
const at = (s: SceneState, id: string) => { const n = s.nodes.at(id); return [n.x, n.y, n.width, n.height]; };

describe("grid layout", () => {
  it("sizes fixed and fr tracks and flows the children row by row", () => {
    const s = run([
      node("G", "page1", grid({ columns: [fixed(50), fr(1), fr(3)], rows: [fixed(30)], columnGap: 10, rowGap: 5 }), { width: 250, height: 100 }),
      node("a", "G", rect, { width: 20, height: 10 }), node("b", "G", rect), node("c", "G", rect), node("d", "G", rect),
    ]);
    // fr share: 250 - 50 - 20 = 180 -> 45 and 135.
    expect(at(s, "a")).toEqual([0, 0, 20, 10]);
    expect(at(s, "b")).toEqual([60, 0, 20, 10]);
    expect(at(s, "c")).toEqual([115, 0, 20, 10]);
    // The implicit second row hugs its content and starts after the 30px row and the gap.
    expect(at(s, "d")).toEqual([0, 35, 20, 10]);
  });

  it("honours explicit cells, spans, fill and the in-cell alignment", () => {
    const s = run([
      node("G", "page1", grid({ columns: [fixed(40), fixed(60)], rows: [fixed(20), fixed(20)], mainAlign: LayoutAlign.END, crossAlign: LayoutAlign.CENTER }), { width: 200, height: 100 }),
      node("a", "G", rect, { gridCell: { column: 2, row: 2 }, width: 10, height: 10 }),
      node("b", "G", rect, { gridCell: { column: 1, row: 1, columnSpan: 2 }, layoutSizingX: LayoutSizing.FILL, layoutSizingY: LayoutSizing.FILL }),
    ]);
    expect(at(s, "a")).toEqual([90, 25, 10, 10]); // end of column 2 (40 + 60 - 10), centered in row 2
    expect(at(s, "b")).toEqual([0, 0, 100, 20]);
  });

  it("hug tracks and a hugging frame take their content, fr tracks too", () => {
    const s = run([
      node("G", "page1", grid({ columns: [hug, fr(1)], rows: [hug], columnGap: 4, hugWidth: true, hugHeight: true, paddingLeft: 3, paddingRight: 3, paddingTop: 3, paddingBottom: 3 })),
      node("a", "G", rect, { width: 30, height: 12 }), node("b", "G", rect, { width: 20, height: 18 }),
    ]);
    expect(at(s, "G").slice(2)).toEqual([3 + 30 + 4 + 20 + 3, 3 + 18 + 3]);
  });

  it("re-lays out when a child changes cell, and undo restores the old cell", () => {
    const s0 = run([
      node("G", "page1", grid({ columns: [fixed(50), fixed(50)] }), { width: 100, height: 100 }),
      node("a", "G", rect), node("b", "G", rect),
    ]);
    const patch = set("a", ["grid_cell"], { gridCell: { column: 2, row: 1 } });
    const s1 = applyOp(s0, patch);
    expect(at(s1, "a")[0]).toBe(50);
    expect(s1.nodes.at("a").gridCell).toEqual({ column: 2, row: 1 });
    const undo = invertOp(s0, patch);
    expect(undo).not.toBeNull();
    expect(undo!.reduce(applyOp, s1).nodes.at("a").gridCell).toBeUndefined();
  });

  it("rejects bad tracks, gaps and cells whole", () => {
    const s = run([node("G", "page1", grid({ columns: [fixed(10)] })), node("a", "G", rect)]);
    const bad = (autoLayout: object) => set("G", ["auto_layout"], { shape: { case: "frame", value: { autoLayout: { mode: LayoutMode.GRID, ...autoLayout } } } });
    expect(applyOp(s, bad({ columns: [{ kind: 9, size: 1 }] }))).toBe(s);
    expect(applyOp(s, bad({ rows: [fixed(-1)] }))).toBe(s);
    expect(applyOp(s, bad({ rowGap: -2 }))).toBe(s);
    expect(applyOp(s, set("a", ["grid_cell"], { gridCell: { column: 1001 } }))).toBe(s);
    expect(isValidGridCell({ column: 1, columnSpan: 0, row: 0, rowSpan: 2 })).toBe(true);
    expect(isValidGridLayout({ columns: [], rows: [], columnGap: 0, rowGap: 0, mode: 1 })).toBe(true);
  });
});

describe("groups in an auto layout frame", () => {
  const row = { case: "frame", value: { autoLayout: { spacing: 10 } } } as const;

  it("is one box of the union of its children, placed by translating the group", () => {
    const s = run([
      node("F", "page1", row, { width: 300, height: 60 }),
      node("a", "F", rect, { width: 20, height: 10 }),
      node("b-group", "F", group, { width: 0, height: 0 }),
      node("g1", "b-group", rect, { x: 5, y: 7, width: 30, height: 10 }),
      node("g2", "b-group", rect, { x: 50, y: 30, width: 20, height: 10 }),
      node("c", "F", rect, { width: 20, height: 10 }),
    ]);
    // The group's box is x 5..70, y 7..40: 65 x 33, so it starts at 30 and its translation is 30 - 5.
    expect(at(s, "b-group")).toEqual([25, -7, 65, 33]);
    expect(at(s, "c")[0]).toBe(105);
    // The children did not move inside the group.
    expect(at(s, "g1").slice(0, 2)).toEqual([5, 7]);
  });

  it("follows a child that grows, hides or leaves", () => {
    const s0 = run([
      node("F", "page1", row, { width: 300, height: 60 }),
      node("a", "F", group), node("g1", "a", rect, { width: 30, height: 10 }), node("g2", "a", rect, { x: 40, width: 20, height: 10 }),
      node("b", "F", rect),
    ]);
    expect(at(s0, "b")[0]).toBe(70);
    const grown = applyOp(s0, set("g2", ["width"], { width: 40 }));
    expect(at(grown, "b")[0]).toBe(90);
    const hidden = applyOp(grown, set("g2", ["visible"], { visible: false }));
    expect(at(hidden, "b")[0]).toBe(40);
    // Moving the child out of the group takes its box with it.
    const left = applyOp(grown, op({ case: "reparentNode", value: { id: "g2", newParentId: "page1", orderKey: "z" } }));
    expect(at(left, "b")[0]).toBe(40);
  });

  it("stays put when empty and never fills", () => {
    const s = run([
      node("F", "page1", row, { width: 300, height: 60 }),
      node("a", "F", group, { x: 7, y: 8 }),
      node("b", "F", group, { layoutSizingX: LayoutSizing.FILL }), node("g1", "b", rect, { width: 30, height: 10 }),
    ]);
    expect(at(s, "a").slice(0, 2)).toEqual([7, 8]);
    expect(at(s, "b")[2]).toBe(30);
  });

  it("is a grid cell too", () => {
    const s = run([
      node("F", "page1", grid({ columns: [fixed(80), hug], rows: [hug], columnGap: 5 }), { width: 200, height: 100 }),
      node("G", "F", group, { gridCell: { column: 2, row: 1 } }), node("g1", "G", rect, { x: 3, y: 4, width: 10, height: 10 }),
    ]);
    expect(at(s, "G")).toEqual([82, -4, 10, 10]);
  });
});
