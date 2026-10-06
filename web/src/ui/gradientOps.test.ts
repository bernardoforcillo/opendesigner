import { nodesOf } from "../store/nodeMap";
import { describe, it, expect } from "vitest";
import { applyOp } from "../store/applyOp";
import { emptyScene } from "../store/types";
import type { NodeLite, SceneState } from "../store/types";
import {
  fillKindOf, fillKindOps, gradientAngleOf, gradientAngleOps, gradientStopOps, addGradientStopOps, removeGradientStopOps, gradientStopPositionOps,
} from "./gradientOps";

function sceneWith(over: Partial<NodeLite> = {}): SceneState {
  const n: NodeLite = {
    id: "a", parentId: "page1", orderKey: "a0", name: "a", visible: true, opacity: 1,
    x: 0, y: 0, width: 100, height: 100, rotation: 0,
    fills: [{ r: 1, g: 0, b: 0, a: 1 }], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false,
    ...over,
  };
  const s = emptyScene("d", "t");
  return { ...s, nodes: nodesOf({ a: n }) };
}

function run(s: SceneState, ops: ReturnType<typeof fillKindOps>): NodeLite {
  return ops.reduce(applyOp, s).nodes.at("a");
}

describe("gradientOps", () => {
  it("solid -> linear: starts from the color and ends transparent", () => {
    const s = sceneWith();
    const n = run(s, fillKindOps(["a"], (id) => s.nodes.at(id), "linear"));
    expect(fillKindOf(n.fills[0])).toBe("linear");
    expect(n.fills[0].gradient?.stops.map((st) => st.color.a)).toEqual([1, 0]);
    expect(n.fills[0].gradient).toMatchObject({ x1: 0.5, y1: 0, x2: 0.5, y2: 1 });
  });

  it("linear -> radial keeps the stops and redoes the geometry", () => {
    let s = sceneWith();
    s = { ...s, nodes: nodesOf({ a: run(s, fillKindOps(["a"], (id) => s.nodes.at(id), "linear")) }) };
    const n = run(s, fillKindOps(["a"], (id) => s.nodes.at(id), "radial"));
    expect(n.fills[0].gradient?.kind).toBe("radial");
    expect(n.fills[0].gradient?.stops).toHaveLength(2);
    expect(n.fills[0].gradient).toMatchObject({ x1: 0.5, y1: 0.5, x2: 1, y2: 0.5 });
  });

  it("gradient -> solid keeps the first stop; same type = no op", () => {
    let s = sceneWith();
    s = { ...s, nodes: nodesOf({ a: run(s, fillKindOps(["a"], (id) => s.nodes.at(id), "linear")) }) };
    expect(fillKindOps(["a"], (id) => s.nodes.at(id), "linear")).toEqual([]);
    const n = run(s, fillKindOps(["a"], (id) => s.nodes.at(id), "solid"));
    expect(n.fills[0]).toEqual({ r: 1, g: 0, b: 0, a: 1 });
  });

  it("the node's other fills survive", () => {
    const extra = { r: 0, g: 1, b: 0, a: 1 };
    const s = sceneWith({ fills: [{ r: 1, g: 0, b: 0, a: 1 }, extra] });
    const n = run(s, fillKindOps(["a"], (id) => s.nodes.at(id), "linear"));
    expect(n.fills).toHaveLength(2);
    expect(n.fills[1]).toEqual(extra);
  });

  it("a stop's color: changes RGB and keeps the stop's alpha", () => {
    let s = sceneWith();
    s = { ...s, nodes: nodesOf({ a: run(s, fillKindOps(["a"], (id) => s.nodes.at(id), "linear")) }) };
    const n = run(s, gradientStopOps(["a"], (id) => s.nodes.at(id), 1, { r: 0, g: 0, b: 1 }));
    expect(n.fills[0].gradient?.stops[1].color).toEqual({ r: 0, g: 0, b: 1, a: 0 });
    expect(gradientStopOps(["a"], (id) => s.nodes.at(id), 5, { r: 0, g: 0, b: 1 })).toEqual([]);
  });

  it("angle: 0 = left->right, 90 = top->bottom, and reads back the same", () => {
    let s = sceneWith();
    s = { ...s, nodes: nodesOf({ a: run(s, fillKindOps(["a"], (id) => s.nodes.at(id), "linear")) }) };
    const h = run(s, gradientAngleOps(["a"], (id) => s.nodes.at(id), 0));
    expect(h.fills[0].gradient?.x1).toBeCloseTo(0);
    expect(h.fills[0].gradient?.x2).toBeCloseTo(1);
    expect(h.fills[0].gradient?.y1).toBeCloseTo(0.5);
    expect(gradientAngleOf(h.fills[0])).toBe(0);
    const d = run(s, gradientAngleOps(["a"], (id) => s.nodes.at(id), 45));
    expect(gradientAngleOf(d.fills[0])).toBe(45);
  });

  it("several stops: add, move and remove keep them sorted, and a gradient keeps two", () => {
    let s = sceneWith();
    s = { ...s, nodes: nodesOf({ a: run(s, fillKindOps(["a"], (id) => s.nodes.at(id), "linear")) }) };
    const L = (st: typeof s) => (id: string) => st.nodes.at(id);
    let n = run(s, addGradientStopOps(["a"], L(s)));
    expect(n.fills[0].gradient?.stops.map((x) => x.position)).toEqual([0, 0.5, 1]);
    s = { ...s, nodes: nodesOf({ a: n }) };
    n = run(s, gradientStopPositionOps(["a"], L(s), 1, 2));
    expect(n.fills[0].gradient?.stops.map((x) => x.position)).toEqual([0, 1, 1]);
    n = run(s, removeGradientStopOps(["a"], L(s), 1));
    expect(n.fills[0].gradient?.stops).toHaveLength(2);
    s = { ...s, nodes: nodesOf({ a: n }) };
    expect(removeGradientStopOps(["a"], L(s), 0)).toEqual([]);
  });

  it("the same ops edit the first STROKE's paint, keeping its weight and alignment", () => {
    let s = sceneWith();
    const withStroke = { ...s.nodes.at("a"), strokes: [{ color: { r: 1, g: 0, b: 0, a: 1 }, weight: 6, align: "inside" as const }] };
    s = { ...s, nodes: nodesOf({ a: withStroke }) };
    const L = (st: typeof s) => (id: string) => st.nodes.at(id);
    let n = run(s, fillKindOps(["a"], L(s), "linear", "stroke"));
    expect(n.strokes[0]).toMatchObject({ weight: 6, align: "inside" });
    expect(n.strokes[0].color.gradient?.kind).toBe("linear");
    expect(n.fills).toEqual(s.nodes.at("a").fills);
    s = { ...s, nodes: nodesOf({ a: n }) };
    n = run(s, addGradientStopOps(["a"], L(s), "stroke"));
    expect(n.strokes[0].color.gradient?.stops).toHaveLength(3);
    s = { ...s, nodes: nodesOf({ a: n }) };
    n = run(s, gradientAngleOps(["a"], L(s), 90, "stroke"));
    expect(n.strokes[0].color.gradient).toMatchObject({ y2: expect.closeTo(1, 5) });
  });
});
