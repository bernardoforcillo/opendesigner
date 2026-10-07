import { describe, it, expect } from "vitest";
import { nodesOf } from "../store/nodeMap";
import { applyOp } from "../store/applyOp";
import { emptyScene } from "../store/types";
import type { NodeLite, SceneState } from "../store/types";
import { addGridOps, editGridOps, removeGridOps } from "./layoutGridOps";

const scene = (over: Partial<NodeLite> = {}): SceneState => ({
  ...emptyScene("d", "t"),
  nodes: nodesOf({
    f: {
      id: "f", parentId: "page1", orderKey: "a0", name: "f", visible: true, opacity: 1, x: 0, y: 0, width: 400, height: 300, rotation: 0,
      fills: [], strokes: [], kind: "frame", cornerRadius: 0, clipsContent: false, ...over,
    },
    r: {
      id: "r", parentId: "page1", orderKey: "a1", name: "r", visible: true, opacity: 1, x: 0, y: 0, width: 10, height: 10, rotation: 0,
      fills: [], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false,
    },
  }),
});
const L = (s: SceneState) => (id: string) => s.nodes.at(id);
const run = (s: SceneState, ops: ReturnType<typeof addGridOps>) => ops.reduce(applyOp, s);

describe("layoutGridOps", () => {
  it("adds a default columns grid, edits it, switches its kind and removes it", () => {
    let s = run(scene(), addGridOps(["f"], L(scene()), "columns"));
    expect(s.nodes.at("f").layoutGrids).toHaveLength(1);
    s = run(s, editGridOps(["f"], L(s), 0, { count: 4, gutter: 8, margin: 16 }));
    expect(s.nodes.at("f").layoutGrids![0]).toMatchObject({ kind: "columns", count: 4, gutter: 8, margin: 16 });
    s = run(s, editGridOps(["f"], L(s), 0, { kind: "grid" }));
    expect(s.nodes.at("f").layoutGrids![0]).toMatchObject({ kind: "grid", size: 8 });
    s = run(s, removeGridOps(["f"], L(s), 0));
    expect(s.nodes.at("f").layoutGrids).toBeUndefined();
  });

  it("brings numbers to what the core accepts", () => {
    let s = run(scene(), addGridOps(["f"], L(scene()), "columns"));
    s = run(s, editGridOps(["f"], L(s), 0, { count: 0, gutter: -5 }));
    expect(s.nodes.at("f").layoutGrids![0]).toMatchObject({ count: 1, gutter: 0 });
  });

  it("only frames take grids", () => {
    expect(addGridOps(["r"], L(scene()), "columns")).toEqual([]);
  });
});
