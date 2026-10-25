import { describe, it, expect } from "vitest";
import { applyOp } from "../store/applyOp";
import { nodesOf } from "../store/nodeMap";
import { emptyScene } from "../store/types";
import type { NodeLite, SceneState } from "../store/types";
import { autoLayoutOps } from "./autoLayoutOps";
import { cellOf, cellOps, withTrackAdded, withTrackChanged } from "./gridTrackOps";

function scene(autoLayout?: NodeLite["autoLayout"]): SceneState {
  const frame: NodeLite = {
    id: "f", parentId: "page1", orderKey: "a0", name: "f", visible: true, opacity: 1,
    x: 0, y: 0, width: 200, height: 100, rotation: 0, fills: [], strokes: [], kind: "frame",
    cornerRadius: 0, clipsContent: true, ...(autoLayout ? { autoLayout } : {}),
  };
  const kid = (id: string): NodeLite => {
    const { autoLayout: _a, ...rest } = frame;
    void _a;
    return { ...rest, id, parentId: "f", orderKey: id, kind: "rect", clipsContent: false, width: 20, height: 10 };
  };
  return { ...emptyScene("d", "t"), nodes: nodesOf({ f: frame, a: kid("a"), b: kid("b"), c: kid("c") }) };
}
const look = (s: SceneState) => (id: string) => s.nodes.at(id);
const run = (s: SceneState, ops: ReturnType<typeof autoLayoutOps>) => ops.reduce(applyOp, s);

describe("grid mode in the Auto layout panel ops", () => {
  it("switching a flex layout to grid starts from two equal columns and a hug row", () => {
    const s0 = scene();
    const flex = run(s0, autoLayoutOps(["f"], look(s0), { enabled: true }));
    const grid = run(flex, autoLayoutOps(["f"], look(flex), { mode: "grid" }));
    expect(grid.nodes.at("f").autoLayout).toMatchObject({
      mode: "grid", columns: [{ kind: "fr", size: 1 }, { kind: "fr", size: 1 }], rows: [{ kind: "hug", size: 0 }], columnGap: 8, rowGap: 8,
    });
    // 200 wide, 8 gap: two columns of 96; the third child goes to the next row.
    expect(grid.nodes.at("b").x).toBe(104);
    expect(grid.nodes.at("c")).toMatchObject({ x: 0, y: 18 });
  });

  it("back to flex drops the mode (the tracks stay for the way back) and a no-op patch makes no op", () => {
    const s0 = scene();
    const flex = run(s0, autoLayoutOps(["f"], look(s0), { enabled: true }));
    const grid = run(flex, autoLayoutOps(["f"], look(flex), { mode: "grid" }));
    const back = run(grid, autoLayoutOps(["f"], look(grid), { mode: "flex" }));
    expect(back.nodes.at("f").autoLayout!.mode).toBeUndefined();
    expect(back.nodes.at("f").autoLayout!.columns).toHaveLength(2);
    expect(back.nodes.at("b").x).toBe(flex.nodes.at("b").x);
    expect(run(back, autoLayoutOps(["f"], look(back), { mode: "grid" })).nodes.at("f").autoLayout).toEqual(grid.nodes.at("f").autoLayout);
    expect(autoLayoutOps(["f"], look(grid), { mode: "grid" })).toEqual([]);
  });

  it("edits the tracks and the gaps", () => {
    const s0 = scene();
    const grid = run(s0, autoLayoutOps(["f"], look(s0), { mode: "grid" }));
    const al = grid.nodes.at("f").autoLayout!;
    const edited = run(grid, autoLayoutOps(["f"], look(grid), {
      columns: withTrackChanged(al, "columns", 0, { kind: "fixed", size: 60 }), columnGap: -5, rowGap: 4,
    }));
    const next = edited.nodes.at("f").autoLayout!;
    expect(next.columns![0]).toEqual({ kind: "fixed", size: 60 });
    expect(next.columnGap).toBeUndefined(); // negative clamps to 0, which the model does not keep
    expect(next.rowGap).toBe(4);
    expect(withTrackAdded(next, "rows")).toHaveLength(2);
    expect(withTrackChanged(next, "columns", 1, null)).toHaveLength(1);
    expect(withTrackChanged(next, "columns", 0, { kind: "hug" })[0]).toEqual({ kind: "hug", size: 0 });
  });
});

describe("cellOps", () => {
  it("writes the whole cell, keeping the other numbers, and skips unchanged nodes", () => {
    const s0 = scene();
    const grid = run(s0, autoLayoutOps(["f"], look(s0), { mode: "grid" }));
    const placed = cellOps(grid, ["a", "b"], "column", 2).reduce(applyOp, grid);
    expect(placed.nodes.at("a").gridCell).toEqual({ column: 2 });
    const spanned = cellOps(placed, ["a"], "columnSpan", 2).reduce(applyOp, placed);
    expect(spanned.nodes.at("a").gridCell).toEqual({ column: 2, columnSpan: 2 });
    expect(cellOps(spanned, ["a"], "column", 2)).toEqual([]);
    expect(cellOf([spanned.nodes.at("a"), spanned.nodes.at("b")], "columnSpan")).toBeUndefined();
    // Out-of-range input is brought to what the core accepts; 0 clears.
    expect(cellOps(spanned, ["c"], "row", 5000).reduce(applyOp, spanned).nodes.at("c").gridCell).toEqual({ row: 1000 });
    expect(cellOps(spanned, ["a"], "columnSpan", 0).reduce(applyOp, spanned).nodes.at("a").gridCell).toEqual({ column: 2 });
  });
});
