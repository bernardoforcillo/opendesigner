import { nodesFromEntries } from "../store/nodeMap";
import { describe, it, expect } from "vitest";
import { wrapInFrameOps } from "./grouping";
import { applyOp } from "../store/applyOp";
import { emptyScene } from "../store/types";
import type { NodeLite, SceneState } from "../store/types";

function rect(id: string, x: number, y: number, w: number, h: number, key: string, parentId = "page1"): NodeLite {
  return {
    id, parentId, orderKey: key, name: id, visible: true, opacity: 1, x, y, width: w, height: h, rotation: 0,
    fills: [], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false,
  };
}

function sceneOf(...nodes: NodeLite[]): SceneState {
  const s = emptyScene("d", "t");
  return { ...s, nodes: nodesFromEntries(nodes.map((n) => [n.id, n])) };
}

function run(scene: SceneState, sel: string[], auto: boolean) {
  const res = wrapInFrameOps(scene, sel, auto);
  if (!res) throw new Error("nothing to wrap");
  return { next: res.ops.reduce(applyOp, scene), res };
}

describe("wrapInFrameOps", () => {
  it("nothing to wrap: null", () => {
    expect(wrapInFrameOps(sceneOf(rect("a", 0, 0, 10, 10, "a0")), [], true)).toBeNull();
    expect(wrapInFrameOps(sceneOf(rect("a", 0, 0, 10, 10, "a0")), ["ghost"], false)).toBeNull();
  });

  it("without auto layout: the frame takes the box and the children do not move in the world", () => {
    const s = sceneOf(rect("a", 100, 50, 20, 10, "a0"), rect("b", 160, 80, 30, 40, "a1"));
    const { next, res } = run(s, ["a", "b"], false);
    const frameId = res.selection[0];
    const f = next.nodes.at(frameId);
    expect(f).toMatchObject({ kind: "frame", x: 100, y: 50, width: 90, height: 70, parentId: "page1" });
    expect(f.autoLayout).toBeUndefined();
    expect(f.fills).toEqual([]);
    // Coordinates are now RELATIVE to the frame: same position in the world.
    expect(next.nodes.at("a")).toMatchObject({ parentId: frameId, x: 0, y: 0 });
    expect(next.nodes.at("b")).toMatchObject({ parentId: frameId, x: 60, y: 30 });
  });

  it("with auto layout: a row of rectangles becomes horizontal, with the spacing it had", () => {
    // Three 20x10 boxes 10 apart from each other, OUT OF ORDER by z-order.
    const s = sceneOf(
      rect("c", 100, 0, 20, 10, "a0"), rect("a", 0, 0, 20, 10, "a1"), rect("b", 50, 0, 20, 10, "a2"),
    );
    const { next, res } = run(s, ["a", "b", "c"], true);
    const f = next.nodes.at(res.selection[0]);
    expect(f.autoLayout).toMatchObject({ direction: "horizontal", spacing: 30, hugWidth: true, hugHeight: true });
    // The order in the row is the SPATIAL one (a, b, c), not the draw one.
    expect([next.nodes.at("a").x, next.nodes.at("b").x, next.nodes.at("c").x]).toEqual([0, 50, 100]);
    expect(f).toMatchObject({ x: 0, y: 0, width: 120, height: 10 });
  });

  it("a column becomes vertical", () => {
    const s = sceneOf(rect("a", 0, 0, 40, 10, "a0"), rect("b", 5, 25, 30, 20, "a1"), rect("c", 0, 60, 40, 10, "a2"));
    const { next, res } = run(s, ["a", "b", "c"], true);
    const f = next.nodes.at(res.selection[0]);
    expect(f.autoLayout?.direction).toBe("vertical");
    // Gaps: 25-10 = 15, 60-45 = 15 -> average 15.
    expect(f.autoLayout?.spacing).toBe(15);
    expect([next.nodes.at("a").y, next.nodes.at("b").y, next.nodes.at("c").y]).toEqual([0, 25, 60]);
  });

  it("overlapping children: spacing 0, never negative", () => {
    const s = sceneOf(rect("a", 0, 0, 30, 10, "a0"), rect("b", 10, 0, 30, 10, "a1"));
    const { next, res } = run(s, ["a", "b"], true);
    expect(next.nodes.at(res.selection[0]).autoLayout?.spacing).toBe(0);
  });

  it("the frame is born above the topmost node of the selection, among its siblings", () => {
    const s = sceneOf(rect("a", 0, 0, 10, 10, "a0"), rect("b", 0, 0, 10, 10, "a1"), rect("top", 0, 0, 10, 10, "a2"));
    const { next, res } = run(s, ["a", "b"], false);
    const f = next.nodes.at(res.selection[0]);
    expect(f.orderKey > "a1").toBe(true);
    expect(f.orderKey < "a2").toBe(true);
  });

  it("inside another frame the coordinates stay in the right space", () => {
    const outer: NodeLite = { ...rect("outer", 1000, 500, 400, 400, "a0"), kind: "frame", clipsContent: true };
    const s = sceneOf(outer, rect("a", 10, 20, 30, 30, "a0", "outer"), rect("b", 60, 20, 30, 30, "a1", "outer"));
    const { next, res } = run(s, ["a", "b"], false);
    const f = next.nodes.at(res.selection[0]);
    expect(f).toMatchObject({ parentId: "outer", x: 10, y: 20, width: 80, height: 30 });
    expect(next.nodes.at("b")).toMatchObject({ x: 50, y: 0 });
  });

  it("selected nodes inside a selected container are not reparented separately", () => {
    const g: NodeLite = { ...rect("g", 0, 0, 100, 100, "a0"), kind: "frame" };
    const s = sceneOf(g, rect("kid", 5, 5, 10, 10, "a0", "g"));
    const { next, res } = run(s, ["g", "kid"], false);
    expect(next.nodes.at("g").parentId).toBe(res.selection[0]);
    expect(next.nodes.at("kid").parentId).toBe("g");
  });
});
