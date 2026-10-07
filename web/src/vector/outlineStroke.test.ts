import { describe, it, expect } from "vitest";
import { nodesOf } from "../store/nodeMap";
import { applyOp } from "../store/applyOp";
import { emptyScene } from "../store/types";
import type { NodeLite, SceneState } from "../store/types";
import { outlineStrokeOps, strokePolyline, canOutlineStroke } from "./outlineStroke";

const stroke = (weight: number, align: "center" | "inside" | "outside" = "center") =>
  ({ color: { r: 0, g: 0, b: 1, a: 1 }, weight, align });
function rect(over: Partial<NodeLite> = {}): NodeLite {
  return {
    id: "r", parentId: "page1", orderKey: "a0", name: "R", visible: true, opacity: 1, x: 100, y: 50, width: 100, height: 60, rotation: 0,
    fills: [{ r: 1, g: 1, b: 1, a: 1 }], strokes: [stroke(10)], kind: "rect", cornerRadius: 0, clipsContent: false, ...over,
  };
}
const sceneOf = (n: NodeLite): SceneState => ({ ...emptyScene("d", "t"), nodes: nodesOf({ [n.id]: n }) });

function run(s: SceneState) {
  const res = outlineStrokeOps(s, "r")!;
  const out = res.ops.reduce(applyOp, s);
  return { out, node: out.nodes.at(res.selection[0]) as NodeLite };
}
const area = (n: NodeLite) => {
  // outer ring area minus the holes (rings fully inside): enough for these tests.
  const rings = n.vector!.subpaths.map((sp) => {
    let a = 0;
    for (let i = 0; i < sp.anchors.length; i++) { const p = sp.anchors[i], q = sp.anchors[(i + 1) % sp.anchors.length]; a += p.x * q.y - q.x * p.y; }
    return Math.abs(a / 2);
  }).sort((x, y) => y - x);
  return rings.reduce((t, r, i) => t + (i === 0 ? r : -r), 0);
};

describe("outline stroke", () => {
  it("a centred stroke around a rect: ring of width 10 around the edge, fill kept, stroke removed", () => {
    const { out, node } = run(sceneOf(rect()));
    // outer 110x70 (mitered corners) minus inner 90x50
    expect(area(node)).toBeCloseTo(110 * 70 - 90 * 50, 3);
    expect([node.x, node.y, node.width, node.height]).toEqual([95, 45, 110, 70]);
    expect(node.fills[0]).toMatchObject({ r: 0, g: 0, b: 1 });
    expect(out.nodes.at("r").strokes).toEqual([]);
  });

  it("inside / outside alignment clip the ring by the shape", () => {
    expect(area(run(sceneOf(rect({ strokes: [stroke(10, "inside")] }))).node)).toBeCloseTo(100 * 60 - 80 * 40, 3);
    expect(area(run(sceneOf(rect({ strokes: [stroke(10, "outside")] }))).node)).toBeCloseTo(120 * 80 - 100 * 60, 3);
  });

  it("a node without a fill is replaced by its outline", () => {
    const { out } = run(sceneOf(rect({ fills: [] })));
    expect(out.nodes.at("r")).toBeUndefined();
  });

  it("an open line: butt vs square caps and round joins", () => {
    const line = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
    const ring = (m: ReturnType<typeof strokePolyline>) => m.length;
    expect(ring(strokePolyline(line, false, 10, { cap: "butt", join: "miter", miter: 4 }))).toBe(1);
    expect(ring(strokePolyline(line, false, 10, { cap: "square", join: "miter", miter: 4 }))).toBe(3);
    const elbow = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }];
    expect(ring(strokePolyline(elbow, false, 10, { cap: "butt", join: "round", miter: 4 }))).toBe(3);
  });

  it("nothing to outline without a positive stroke", () => {
    expect(canOutlineStroke(rect({ strokes: [] }))).toBe(false);
    expect(outlineStrokeOps(sceneOf(rect({ strokes: [stroke(0)] })), "r")).toBeNull();
  });
});
