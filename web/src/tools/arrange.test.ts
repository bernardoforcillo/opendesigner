import { describe, it, expect } from "vitest";
import { applyOp } from "../store/applyOp";
import { nodesOf } from "../store/nodeMap";
import { childrenOf } from "../store/tree";
import { emptyScene } from "../store/types";
import type { NodeLite, SceneState } from "../store/types";
import { arrangeOps } from "./arrange";

const rect = (id: string, key: string, parentId = "page1"): NodeLite => ({
  id, parentId, orderKey: key, name: id, visible: true, opacity: 1, x: 0, y: 0, width: 10, height: 10,
  rotation: 0, fills: [], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false,
});
const scene = (...nodes: NodeLite[]): SceneState => ({ ...emptyScene("d", "t"), nodes: nodesOf(Object.fromEntries(nodes.map((n) => [n.id, n]))) });
const order = (s: SceneState, parent = "page1") => childrenOf(s, parent).map((n) => n.id).join("");
const arrange = (s: SceneState, ids: string[], mode: Parameters<typeof arrangeOps>[2]) => arrangeOps(s, ids, mode).reduce(applyOp, s);

describe("arrangeOps", () => {
  const s = scene(rect("a", "a1"), rect("b", "a2"), rect("c", "a3"), rect("d", "a4"));

  it("brings forward and sends backward one step", () => {
    expect(order(arrange(s, ["b"], "forward"))).toBe("acbd");
    expect(order(arrange(s, ["c"], "backward"))).toBe("acbd");
  });

  it("goes to the front and to the back, keeping the relative order of a multiple selection", () => {
    expect(order(arrange(s, ["b", "a"], "front"))).toBe("cdab");
    expect(order(arrange(s, ["c", "d"], "back"))).toBe("cdab");
  });

  it("moves adjacent selected nodes together", () => {
    expect(order(arrange(s, ["a", "b"], "forward"))).toBe("cabd");
    expect(order(arrange(s, ["b", "c"], "backward"))).toBe("bcad");
  });

  it("does nothing at the end of the line", () => {
    expect(arrangeOps(s, ["d"], "front")).toEqual([]);
    expect(arrangeOps(s, ["d"], "forward")).toEqual([]);
    expect(arrangeOps(s, ["a"], "back")).toEqual([]);
    expect(arrangeOps(s, ["a", "b"], "backward")).toEqual([]);
    expect(arrangeOps(s, ["c", "d"], "front")).toEqual([]);
  });

  it("arranges each parent on its own and only touches the nodes that moved", () => {
    const nested = scene(
      { ...rect("g", "a1"), kind: "group" }, rect("x", "a1", "g"), rect("y", "a2", "g"), rect("z", "a2"),
    );
    const next = arrange(nested, ["x", "z"], "front");
    expect(order(next, "g")).toBe("yx");
    expect(order(next)).toBe("gz");
    expect(arrangeOps(nested, ["x", "z"], "front")).toHaveLength(1);
  });
});
