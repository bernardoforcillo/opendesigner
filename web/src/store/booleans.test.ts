import { describe, it, expect } from "vitest";
import { nodesOf } from "./nodeMap";
import { emptyScene } from "./types";
import type { NodeLite, SceneState } from "./types";
import { deriveBooleans } from "./booleans";
import { resolveScene } from "./variables";
import { vectorBounds } from "./vectorGeometry";

const rect = (id: string, parentId: string, x: number, y: number, w: number, h: number, order = "a0"): NodeLite => ({
  id, parentId, orderKey: order, name: id, visible: true, opacity: 1, x, y, width: w, height: h, rotation: 0,
  fills: [{ r: 1, g: 0, b: 0, a: 1 }], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false,
});
const group = (id: string, op: string, over: Partial<NodeLite> = {}): NodeLite => ({
  ...rect(id, "page1", 0, 0, 0, 0), kind: "group", fills: [{ r: 0, g: 0, b: 1, a: 1 }], meta: { "boolean.op": op }, ...over,
});
const sceneOf = (...ns: NodeLite[]): SceneState => ({ ...emptyScene("d", "t"), nodes: nodesOf(Object.fromEntries(ns.map((n) => [n.id, n]))) });
const two = (op: string) => sceneOf(group("g", op), rect("a", "g", 0, 0, 100, 100, "a0"), rect("b", "g", 50, 50, 100, 100, "a1"));

describe("live boolean groups (derived)", () => {
  it("a scene without booleans is returned as is", () => {
    const s = sceneOf(rect("a", "page1", 0, 0, 10, 10));
    expect(deriveBooleans(s)).toBe(s);
    expect(resolveScene(s)).toBe(s);
  });

  it("the group draws as a vector of the result, in the group's style, and its children are hidden", () => {
    const s = two("union");
    const d = deriveBooleans(s);
    const g = d.nodes.at("g");
    expect(g.kind).toBe("vector");
    expect(g.fills[0]).toMatchObject({ b: 1 });
    expect([g.x, g.y, g.width, g.height]).toEqual([0, 0, 150, 150]);
    expect(vectorBounds(g.vector!.subpaths)).toMatchObject({ width: 150, height: 150 });
    expect(d.nodes.at("a").visible).toBe(false);
    expect(d.nodes.at("b").visible).toBe(false);
    // The real scene is untouched.
    expect(s.nodes.at("g").kind).toBe("group");
    expect(s.nodes.at("a").visible).toBe(true);
  });

  it("it is live: moving a child changes the result, and each operation gives its own region", () => {
    const moved = sceneOf(group("g", "intersect"), rect("a", "g", 0, 0, 100, 100, "a0"), rect("b", "g", 80, 80, 100, 100, "a1"));
    const g = deriveBooleans(moved).nodes.at("g");
    expect([g.x, g.y, g.width, g.height]).toEqual([80, 80, 20, 20]);
    const sub = deriveBooleans(two("subtract")).nodes.at("g");
    expect([sub.width, sub.height]).toEqual([100, 100]);
  });

  it("an empty result hides the group; nested groups under a live one are derived from the outer one only", () => {
    const empty = sceneOf(group("g", "intersect"), rect("a", "g", 0, 0, 10, 10, "a0"), rect("b", "g", 100, 100, 10, 10, "a1"));
    expect(deriveBooleans(empty).nodes.at("g").visible).toBe(false);
    const nested = sceneOf(
      group("g", "union"), group("h", "subtract", { parentId: "g", orderKey: "a0" }),
      rect("a", "h", 0, 0, 100, 100, "a0"), rect("b", "h", 0, 0, 50, 50, "a1"), rect("c", "g", 200, 0, 10, 10, "a1"),
    );
    const d = deriveBooleans(nested);
    expect(d.nodes.at("g").kind).toBe("vector");
    expect(d.nodes.at("h").visible).toBe(false);
    expect(d.nodes.at("g").width).toBe(210);
  });
});
