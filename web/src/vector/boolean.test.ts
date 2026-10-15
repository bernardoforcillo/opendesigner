import { describe, it, expect } from "vitest";
import { nodesOf } from "../store/nodeMap";
import { applyOp } from "../store/applyOp";
import { emptyScene } from "../store/types";
import type { NodeLite, SceneState, SubPathLite } from "../store/types";
import { vectorBounds } from "../store/vectorGeometry";
import { booleanOps, type BooleanOp } from "./boolean";

function rect(id: string, x: number, y: number, w: number, h: number, over: Partial<NodeLite> = {}): NodeLite {
  return {
    id, parentId: "page1", orderKey: `a${id}`, name: id, visible: true, opacity: 1, x, y, width: w, height: h, rotation: 0,
    fills: [{ r: 1, g: 0, b: 0, a: 1 }], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false, ...over,
  };
}
const sceneOf = (...ns: NodeLite[]): SceneState => ({ ...emptyScene("d", "t"), nodes: nodesOf(Object.fromEntries(ns.map((n) => [n.id, n]))) });

// Signed area of a closed ring.
function area(sp: SubPathLite): number {
  let s = 0;
  const a = sp.anchors;
  for (let i = 0; i < a.length; i++) { const p = a[i], q = a[(i + 1) % a.length]; s += p.x * q.y - q.x * p.y; }
  return s / 2;
}
// Even-odd area of the node: outer rings minus the rings inside them.
const total = (sps: SubPathLite[]) => sps.reduce((t, sp, i) => t + (i === 0 ? Math.abs(area(sp)) : 0), 0);

function run(s: SceneState, op: BooleanOp, ids: string[]) {
  const res = booleanOps(s, ids, op);
  if (!res) return null;
  const out = res.ops.reduce(applyOp, s);
  return { out, node: out.nodes.at(res.selection[0]) as NodeLite, res };
}

describe("boolean operations", () => {
  const s = sceneOf(rect("a", 0, 0, 100, 100), rect("b", 50, 50, 100, 100, { fills: [{ r: 0, g: 0, b: 1, a: 1 }] }));

  it("union covers both and replaces the sources by one vector with the bottom's style", () => {
    const r = run(s, "union", ["a", "b"])!;
    expect(r.out.nodes.at("a")).toBeUndefined();
    expect(r.out.nodes.at("b")).toBeUndefined();
    expect(r.node.kind).toBe("vector");
    expect(r.node.name).toBe("Union");
    expect(r.node.fills[0]).toMatchObject({ r: 1, g: 0, b: 0 });
    expect([r.node.x, r.node.y, r.node.width, r.node.height]).toEqual([0, 0, 150, 150]);
    expect(vectorBounds(r.node.vector!.subpaths)).toMatchObject({ x: 0, y: 0, width: 150, height: 150 });
  });

  it("intersect keeps only the overlap, in world position", () => {
    const r = run(s, "intersect", ["a", "b"])!;
    expect([r.node.x, r.node.y, r.node.width, r.node.height]).toEqual([50, 50, 50, 50]);
    expect(total(r.node.vector!.subpaths)).toBeCloseTo(2500);
  });

  it("subtract removes the upper nodes from the bottom one", () => {
    const r = run(s, "subtract", ["a", "b"])!;
    expect([r.node.x, r.node.y, r.node.width, r.node.height]).toEqual([0, 0, 100, 100]);
    expect(total(r.node.vector!.subpaths)).toBeCloseTo(10000 - 2500);
  });

  it("exclude leaves the two non-overlapping parts", () => {
    const r = run(s, "exclude", ["a", "b"])!;
    expect(r.node.vector!.subpaths.length).toBeGreaterThanOrEqual(1);
    expect(vectorBounds(r.node.vector!.subpaths)).toMatchObject({ width: 150, height: 150 });
  });

  it("a hole stays a hole: subtracting an inner rect adds a second ring", () => {
    const h = sceneOf(rect("a", 0, 0, 100, 100), rect("b", 25, 25, 50, 50));
    const r = run(h, "subtract", ["a", "b"])!;
    expect(r.node.vector!.subpaths).toHaveLength(2);
  });

  it("an ellipse and a rounded rect are flattened to rings", () => {
    const e = sceneOf(rect("a", 0, 0, 100, 100, { kind: "ellipse" }), rect("b", 0, 0, 100, 100, { cornerRadius: 30 }));
    const r = run(e, "intersect", ["a", "b"])!;
    const a = total(r.node.vector!.subpaths);
    expect(a).toBeLessThan(Math.PI * 2500 + 1);
    expect(a).toBeGreaterThan(Math.PI * 2500 * 0.95);
  });

  it("a rotated source is taken where it is drawn", () => {
    const rot = sceneOf(rect("a", 0, 0, 100, 100, { rotation: 90, width: 100, height: 100 }), rect("b", 200, 200, 10, 10));
    const r = run(rot, "union", ["a", "b"])!;
    expect(r.node.x).toBe(0);
  });

  it("needs two shapes and a non-empty result", () => {
    expect(booleanOps(s, ["a"], "union")).toBeNull();
    const far = sceneOf(rect("a", 0, 0, 10, 10), rect("b", 100, 100, 10, 10));
    expect(booleanOps(far, ["a", "b"], "intersect")).toBeNull();
  });

  it("text and images are not shapes: the operation ignores them", () => {
    const t = sceneOf(rect("a", 0, 0, 10, 10), rect("b", 5, 5, 10, 10, { kind: "text" }));
    expect(booleanOps(t, ["a", "b"], "union")).toBeNull();
  });
});
