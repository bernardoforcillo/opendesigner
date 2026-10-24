import { describe, it, expect } from "vitest";
import { nodesOf } from "../store/nodeMap";
import { applyOp } from "../store/applyOp";
import { resolveScene } from "../store/variables";
import { emptyScene } from "../store/types";
import type { NodeLite, SceneState } from "../store/types";
import { makeSetPaintStyleDefOp } from "../tools/ops";
import { arcOps, arrowheadOps, cornerRadiiOps, cornerSmoothingOps, polygonSidesOps, starOps, strokeSidesOps } from "./shapeOps";
import {
  applyEffectStyleOps, applyPaintStyleOps, createEffectStyleOps, createPaintStyleOps, deleteEffectStyleOps, deletePaintStyleOps,
} from "./styleOps";

function base(over: Partial<NodeLite>): NodeLite {
  return {
    id: "a", parentId: "page1", orderKey: "a0", name: "a", visible: true, opacity: 1,
    x: 0, y: 0, width: 100, height: 100, rotation: 0,
    fills: [{ r: 1, g: 0, b: 0, a: 1 }], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false, ...over,
  };
}
const sceneOf = (n: NodeLite): SceneState => ({ ...emptyScene("d", "t"), nodes: nodesOf({ [n.id]: n }) });
const apply = (s: SceneState, ops: ReturnType<typeof polygonSidesOps>): SceneState => ops.reduce(applyOp, s);
const look = (s: SceneState) => (id: string) => s.nodes.at(id);
// A paint style redefined with one solid paint (the op a style editor would send).
const redefine = (s: SceneState, id: string, paint: { r: number; g: number; b: number; a: number }) =>
  makeSetPaintStyleDefOp({ id, name: s.paintStyles[id].name, paints: [paint] });
const stroke = { color: { r: 0, g: 0, b: 0, a: 1 }, weight: 2, align: "center" as const };

describe("polygon, star and arc ops", () => {
  it("polygon sides are clamped, written and skipped on other shapes", () => {
    let s = sceneOf(base({ kind: "polygon", sides: 6 }));
    s = apply(s, polygonSidesOps(["a"], look(s), 8));
    expect(s.nodes.at("a").sides).toBe(8);
    s = apply(s, polygonSidesOps(["a"], look(s), 1000));
    expect(s.nodes.at("a").sides).toBe(60);
    expect(polygonSidesOps(["a"], look(s), 60)).toEqual([]);
    const rect = sceneOf(base({}));
    expect(polygonSidesOps(["a"], look(rect), 5)).toEqual([]);
  });

  it("star points and inner ratio are separate ops", () => {
    let s = sceneOf(base({ kind: "star", points: 5, innerRatio: 0.5 }));
    const ops = starOps(["a"], look(s), { points: 7, innerRatio: 0.3 });
    expect(ops).toHaveLength(2);
    s = apply(s, ops);
    expect(s.nodes.at("a")).toMatchObject({ points: 7, innerRatio: 0.3 });
    s = apply(s, starOps(["a"], look(s), { innerRatio: 5 }));
    expect(s.nodes.at("a").innerRatio).toBe(0.95);
  });

  it("an ellipse takes an arc and a ring; a full sweep and no ring remove the fields", () => {
    let s = sceneOf(base({ kind: "ellipse" }));
    s = apply(s, arcOps(["a"], look(s), { start: -90, sweep: 270, innerRatio: 0.5 }));
    expect(s.nodes.at("a")).toMatchObject({ arcStart: -90, arcSweep: 270, innerRatio: 0.5 });
    s = apply(s, arcOps(["a"], look(s), { start: 0, sweep: 0, innerRatio: 0 }));
    const n = s.nodes.at("a");
    expect("arcStart" in n || "arcSweep" in n || "innerRatio" in n).toBe(false);
    expect(arcOps(["a"], look(sceneOf(base({}))), { sweep: 90 })).toEqual([]); // not an ellipse
  });
});

describe("corner ops", () => {
  it("smoothing is clamped to 0..1 and 0 removes it", () => {
    let s = sceneOf(base({ cornerRadius: 12 }));
    s = apply(s, cornerSmoothingOps(["a"], look(s), 2));
    expect(s.nodes.at("a").cornerSmoothing).toBe(1);
    s = apply(s, cornerSmoothingOps(["a"], look(s), 0));
    expect("cornerSmoothing" in s.nodes.at("a")).toBe(false);
  });

  it("independent corners start from the single radius, edit one corner, and fold back to the largest", () => {
    let s = sceneOf(base({ cornerRadius: 10 }));
    s = apply(s, cornerRadiiOps(["a"], look(s), {}));
    expect(s.nodes.at("a").radii).toEqual({ topLeft: 10, topRight: 10, bottomRight: 10, bottomLeft: 10 });
    s = apply(s, cornerRadiiOps(["a"], look(s), { bottomRight: 30 }));
    expect(s.nodes.at("a").radii).toEqual({ topLeft: 10, topRight: 10, bottomRight: 30, bottomLeft: 10 });
    s = apply(s, cornerRadiiOps(["a"], look(s), null));
    expect(s.nodes.at("a").radii).toBeUndefined();
    expect(s.nodes.at("a").cornerRadius).toBe(30);
    expect(cornerRadiiOps(["a"], look(s), null)).toEqual([]);
  });
});

describe("stroke ops", () => {
  it("arrowheads go on a vector's first stroke; a vector with no stroke gets one", () => {
    const vec = base({ kind: "vector", vector: { subpaths: [] } });
    let s = sceneOf(vec);
    s = apply(s, arrowheadOps(["a"], look(s), { end: "triangle" }));
    expect(s.nodes.at("a").strokes[0]).toMatchObject({ weight: 1, endCap: "triangle" });
    s = apply(s, arrowheadOps(["a"], look(s), { start: "circle", end: null }));
    const st = s.nodes.at("a").strokes[0];
    expect(st.startCap).toBe("circle");
    expect("endCap" in st).toBe(false);
    expect(arrowheadOps(["a"], look(s), { start: "circle" })).toEqual([]);
    expect(arrowheadOps(["a"], look(sceneOf(base({}))), { end: "arrow" })).toEqual([]); // not a vector
  });

  it("per-side weights start from the weight, keep `weight` at the widest side, and fold back", () => {
    let s = sceneOf(base({ strokes: [stroke] }));
    s = apply(s, strokeSidesOps(["a"], look(s), { bottom: 8 }));
    expect(s.nodes.at("a").strokes[0]).toMatchObject({ weight: 8, sides: { top: 2, right: 2, bottom: 8, left: 2 } });
    s = apply(s, strokeSidesOps(["a"], look(s), null));
    expect(s.nodes.at("a").strokes[0].sides).toBeUndefined();
    expect(s.nodes.at("a").strokes[0].weight).toBe(8);
    expect(strokeSidesOps(["a"], look(s), null)).toEqual([]);
  });
});

describe("paint and effect styles", () => {
  it("creates a paint style from the fills, resolves it, and detaching keeps what is drawn", () => {
    let s = sceneOf(base({}));
    const made = createPaintStyleOps(s.nodes.at("a"), "fill", "Brand")!;
    s = apply(s, made.ops);
    expect(s.paintStyles[made.id]).toMatchObject({ name: "Brand", paints: [{ r: 1, g: 0, b: 0, a: 1 }] });
    expect(s.nodes.at("a").fillStyleId).toBe(made.id);
    // The style is redefined: the node follows without touching its own fills.
    s = applyOp(s, redefine(s, made.id, { r: 0, g: 0, b: 1, a: 1 }));
    expect(resolveScene(s).nodes.at("a").fills[0]).toMatchObject({ b: 1 });
    expect(s.nodes.at("a").fills[0]).toMatchObject({ r: 1 });
    // Detach: the node gets the style's paints.
    s = apply(s, applyPaintStyleOps(s, ["a"], "fill", ""));
    expect(s.nodes.at("a").fillStyleId).toBeUndefined();
    expect(s.nodes.at("a").fills[0]).toMatchObject({ b: 1 });
  });

  it("a stroke style recolors the strokes but keeps weight and arrowheads", () => {
    let s = sceneOf(base({ strokes: [{ ...stroke, weight: 5 }] }));
    const made = createPaintStyleOps(s.nodes.at("a"), "stroke", "Ink")!;
    s = apply(s, made.ops);
    const node = resolveScene(s).nodes.at("a");
    expect(node.strokes[0]).toMatchObject({ weight: 5, color: { r: 0, g: 0, b: 0 } });
    s = apply(s, deletePaintStyleOps(s, made.id));
    expect(s.paintStyles[made.id]).toBeUndefined();
    expect(s.nodes.at("a").strokeStyleId).toBeUndefined();
  });

  it("applying an unknown style or one a node already has writes nothing", () => {
    let s = sceneOf(base({}));
    const made = createPaintStyleOps(s.nodes.at("a"), "fill", "Brand")!;
    s = apply(s, made.ops);
    expect(applyPaintStyleOps(s, ["a"], "fill", "nope")).toEqual([]);
    expect(applyPaintStyleOps(s, ["a"], "fill", made.id)).toEqual([]);
    expect(createPaintStyleOps(base({ fills: [] }), "fill", "x")).toBeNull();
  });

  it("effect styles apply, resolve and detach", () => {
    let s = sceneOf(base({ effects: [{ kind: "layerBlur", radius: 4 }] }));
    const made = createEffectStyleOps(s.nodes.at("a"), "Blurry")!;
    s = apply(s, made.ops);
    expect(resolveScene(s).nodes.at("a").effects).toEqual([{ kind: "layerBlur", radius: 4 }]);
    s = apply(s, applyEffectStyleOps(s, ["a"], ""));
    expect(s.nodes.at("a").effectStyleId).toBeUndefined();
    s = apply(s, applyEffectStyleOps(s, ["a"], made.id));
    s = apply(s, deleteEffectStyleOps(s, made.id));
    expect(s.nodes.at("a").effectStyleId).toBeUndefined();
    expect(createEffectStyleOps(base({}), "x")).toBeNull();
  });
});
