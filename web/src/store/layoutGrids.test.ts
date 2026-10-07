import { describe, it, expect } from "vitest";
import { create } from "@bufbuild/protobuf";
import { LayoutGridKind, LayoutGridSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import { nodesOf } from "./nodeMap";
import { emptyScene } from "./types";
import type { LayoutGridLite, NodeLite } from "./types";
import { areValidLayoutGrids, gridBands, gridLines, snapPositions } from "./layoutGrids";
import { snapBounds, snapTargets } from "../selection/snap";

const cols = (over: Partial<LayoutGridLite> = {}): LayoutGridLite => ({
  kind: "columns", size: 0, count: 4, gutter: 20, margin: 10, color: { r: 1, g: 0, b: 0, a: 0.1 }, ...over,
});
const frame = (grids: LayoutGridLite[]): NodeLite => ({
  id: "f", parentId: "page1", orderKey: "a0", name: "f", visible: true, opacity: 1, x: 100, y: 50, width: 400, height: 300, rotation: 0,
  fills: [], strokes: [], kind: "frame", cornerRadius: 0, clipsContent: false, layoutGrids: grids,
});

describe("layout grid geometry", () => {
  it("columns: count bands of equal width between the margins", () => {
    const b = gridBands(cols(), 400);
    // (400 - 2*10 - 3*20) / 4 = 80
    expect(b).toEqual([{ start: 10, end: 90 }, { start: 110, end: 190 }, { start: 210, end: 290 }, { start: 310, end: 390 }]);
  });
  it("bands that do not fit give nothing", () => {
    expect(gridBands(cols({ margin: 300 }), 400)).toEqual([]);
  });
  it("a square grid has a line every `size`, capped", () => {
    expect(gridLines({ ...cols(), kind: "grid", size: 100 }, 250)).toEqual([0, 100, 200]);
    expect(gridLines({ ...cols(), kind: "grid", size: 1 }, 1e9).length).toBe(5000);
  });
  it("snap positions are both edges of every column / row and the grid lines", () => {
    const f = frame([cols(), { ...cols(), kind: "rows", count: 2, gutter: 0, margin: 0 }, { ...cols(), kind: "grid", size: 200 }]);
    const p = snapPositions(f);
    expect(p.x).toEqual([10, 90, 110, 190, 210, 290, 310, 390, 0, 200, 400]);
    expect(p.y).toEqual([0, 150, 150, 300, 0, 200]);
  });
});

describe("layout grid validation (parity with core.validateLayoutGrids)", () => {
  const g = (o: Partial<{ kind: LayoutGridKind; size: number; count: number; gutter: number; margin: number }>) =>
    create(LayoutGridSchema, { kind: LayoutGridKind.COLUMNS, count: 3, ...o });
  it("accepts good grids and rejects the bad ones", () => {
    expect(areValidLayoutGrids([g({}), g({ kind: LayoutGridKind.GRID, size: 8 })])).toBe(true);
    expect(areValidLayoutGrids([g({ count: 0 })])).toBe(false);
    expect(areValidLayoutGrids([g({ count: 1001 })])).toBe(false);
    expect(areValidLayoutGrids([g({ kind: LayoutGridKind.GRID, size: 0 })])).toBe(false);
    expect(areValidLayoutGrids([g({ gutter: -1 })])).toBe(false);
    expect(areValidLayoutGrids([g({ kind: LayoutGridKind.UNSPECIFIED })])).toBe(false);
    expect(areValidLayoutGrids([g({ margin: NaN })])).toBe(false);
  });
});

describe("layout grids as snap targets", () => {
  it("a box dragged near a column edge snaps to it, with a guide along the frame", () => {
    const s = { ...emptyScene("d", "t"), nodes: nodesOf({ f: frame([cols()]) }) };
    const targets = snapTargets(s, []);
    // The column starts at frame.x + 10 = 110. A box at x = 113 (6px threshold) snaps by -3.
    const r = snapBounds({ x: 113, y: 500, width: 20, height: 20 }, targets.filter((t) => t.width === 0), 6);
    expect(r.dx).toBe(-3);
    expect(r.guides.some((gd) => gd.axis === "x" && gd.pos === 110)).toBe(true);
  });
});
