import { describe, it, expect } from "vitest";
import { create } from "@bufbuild/protobuf";
import { nodesOf } from "../store/nodeMap";
import { applyOp } from "../store/applyOp";
import { emptyScene, toPbStrokes, toStrokeLite } from "../store/types";
import type { BrushLite, NodeLite, SceneState } from "../store/types";
import { BrushKind, BrushSchema, BrushTip, StrokeSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import { makeSetPropsOp } from "../tools/ops";
import { isValidBrush } from "../store/shapes";
import { nodesToSvg } from "../export/svg";
import { strokeOutsetOfNode } from "../canvas/geometry";
import { brushPresetName, BRUSH_PRESETS, brushReach, hasBrushedStroke } from "./brushSpec";
import { MAX_BRUSH_STAMPS, brushStamps, brushStrokeCommands, seededRandom, tipCommands } from "./brush";
import { brushStrokeOf, clampBrush, setBrushOps } from "./brushEdit";

const anchor = (x: number, y: number) => ({ x, y, inX: 0, inY: 0, outX: 0, outY: 0 });
const black = { r: 0, g: 0, b: 0, a: 1 };
const scatter: BrushLite = { kind: "scatter", tip: "dot", spacing: 1, scatter: 0, sizeJitter: 0, angleJitter: 0, seed: 5 };
const stretch: BrushLite = { kind: "stretch", tip: "square", spacing: 1, scatter: 0, sizeJitter: 0, angleJitter: 0, seed: 5 };
function line(brush: BrushLite | undefined, over: Partial<NodeLite> = {}): NodeLite {
  return {
    id: "v", parentId: "page1", orderKey: "a0", name: "Line", visible: true, opacity: 1, x: 10, y: 20, width: 100, height: 0, rotation: 0,
    fills: [], strokes: [{ color: black, weight: 10, align: "center", ...(brush ? { brush } : {}) }],
    kind: "vector", cornerRadius: 0, clipsContent: false,
    vector: { subpaths: [{ anchors: [anchor(0, 0), anchor(100, 0)], closed: false }] }, ...over,
  };
}
const path100 = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
const sceneOf = (n: NodeLite): SceneState => ({ ...emptyScene("d", "t"), nodes: nodesOf({ [n.id]: n }) });

describe("seededRandom", () => {
  it("repeats for a seed and differs between seeds, within [0, 1)", () => {
    const a = seededRandom(7), b = seededRandom(7), c = seededRandom(8);
    const xs = Array.from({ length: 5 }, () => a());
    expect(xs).toEqual(Array.from({ length: 5 }, () => b()));
    expect(xs).not.toEqual(Array.from({ length: 5 }, () => c()));
    expect(xs.every((v) => v >= 0 && v < 1)).toBe(true);
  });
  it("is pinned: the first draws of seed 1 (a change would redraw every saved brush)", () => {
    const r = seededRandom(1);
    expect([r(), r()].map((v) => Math.round(v * 1e6))).toEqual([627074, 2736]);
  });
});

describe("brushStamps", () => {
  it("scatter places a stamp every spacing weights along the path", () => {
    const st = brushStamps(path100, false, 10, { ...scatter, spacing: 2 });
    expect(st.map((s) => s.x)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(st.every((s) => s.y === 0 && s.angle === 0 && s.sx === 10 && s.sy === 10)).toBe(true);
  });
  it("stretch fits whole tiles exactly: a 100 path at length 3 weights of 10 is 3 tiles of 33.3", () => {
    const st = brushStamps(path100, false, 10, { ...stretch, spacing: 3 });
    expect(st).toHaveLength(3);
    expect(st[0].x).toBeCloseTo(100 / 6, 9);
    expect(st[2].x).toBeCloseTo(500 / 6, 9);
    expect(st.every((s) => Math.abs(s.sx - 100 / 3) < 1e-9 && s.sy === 10)).toBe(true);
  });
  it("follows the heading of the path", () => {
    const st = brushStamps([{ x: 0, y: 0 }, { x: 0, y: 100 }], false, 10, scatter);
    expect(st[3].angle).toBeCloseTo(Math.PI / 2, 9);
    expect(st[3].y).toBeCloseTo(30, 9);
  });
  it("is deterministic and the seed changes the marks", () => {
    const b = { ...scatter, scatter: 1, sizeJitter: 0.5, angleJitter: 90 };
    expect(brushStamps(path100, false, 6, b)).toEqual(brushStamps(path100, false, 6, b));
    expect(brushStamps(path100, false, 6, { ...b, seed: 6 })).not.toEqual(brushStamps(path100, false, 6, b));
    expect(brushStamps(path100, false, 6, b, 1)).not.toEqual(brushStamps(path100, false, 6, b, 0));
  });
  it("jitters stay within their limits", () => {
    const b = { ...scatter, spacing: 0.05, scatter: 2, sizeJitter: 1, angleJitter: 45 };
    const st = brushStamps(path100, false, 10, b);
    expect(st.length).toBeGreaterThan(100);
    for (const s of st) {
      expect(Math.abs(s.y)).toBeLessThanOrEqual(10 + 1e-9); // scatter 2 weights of 10: +-10
      expect(Math.abs(s.angle)).toBeLessThanOrEqual(Math.PI / 4 + 1e-9);
      expect(s.sx).toBeGreaterThanOrEqual(5 - 1e-9);
      expect(s.sx).toBeLessThanOrEqual(15 + 1e-9);
    }
    expect(new Set(st.map((s) => s.y)).size).toBeGreaterThan(50);
  });
  it("changing one jitter does not reshuffle the others", () => {
    const a = brushStamps(path100, false, 10, { ...scatter, spacing: 0.5, scatter: 1, angleJitter: 0 });
    const b = brushStamps(path100, false, 10, { ...scatter, spacing: 0.5, scatter: 1, angleJitter: 90 });
    expect(a.map((s) => s.y)).toEqual(b.map((s) => s.y));
  });
  it("a closed path wraps: stamps are evenly spread and none repeats the start", () => {
    const sq = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }];
    const st = brushStamps(sq, true, 10, { ...scatter, spacing: 1 });
    expect(st).toHaveLength(16);
    expect(new Set(st.map((s) => `${s.x.toFixed(6)},${s.y.toFixed(6)}`)).size).toBe(16);
  });
  it("caps the stamps of a subpath and spreads them over the whole path", () => {
    const st = brushStamps([{ x: 0, y: 0 }, { x: 1e6, y: 0 }], false, 1, { ...scatter, spacing: 0.05 });
    expect(st).toHaveLength(MAX_BRUSH_STAMPS);
    expect(st[st.length - 1].x).toBeCloseTo(1e6, 3);
  });
  it("nothing for a path without length (stretch) and a single mark for a lone anchor (scatter)", () => {
    expect(brushStamps([{ x: 3, y: 4 }], false, 10, stretch)).toEqual([]);
    expect(brushStamps([{ x: 3, y: 4 }], false, 10, scatter)).toHaveLength(1);
    expect(brushStamps(path100, false, 0, scatter)).toEqual([]);
  });
});

describe("tips", () => {
  it("every tip stays inside the unit box and is wound clockwise (so stamps merge under the non-zero rule)", () => {
    for (const tip of ["dot", "dash", "square", "diamond", "leaf"] as const) {
      const pts: [number, number][] = [];
      for (const c of tipCommands(tip)) {
        if (c[0] === "C") { pts.push([c[1], c[2]], [c[3], c[4]], [c[5], c[6]]); } else if (c[0] !== "Z") pts.push([c[1], c[2]]);
      }
      expect(pts.every(([x, y]) => Math.abs(x) <= 0.5 + 1e-9 && Math.abs(y) <= 0.5 + 1e-9)).toBe(true);
      let a = 0;
      for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; }
      expect(a, tip).toBeGreaterThan(0); // positive in y-down = clockwise on screen
    }
  });
});

describe("brush on a node", () => {
  it("commands are stamps of the tip along the vector, in local space, and cached until the vector changes", () => {
    const n = line({ ...scatter, spacing: 2, tip: "square" });
    const cmds = brushStrokeCommands(n, n.strokes[0]);
    expect(cmds.filter((c) => c[0] === "M")).toHaveLength(6);
    expect(cmds.filter((c) => c[0] === "Z")).toHaveLength(6);
    expect(cmds[0]).toEqual(["M", -5, -5]); // the first square, centred on the start, 10 wide
    expect(brushStrokeCommands(n, n.strokes[0])).toBe(cmds);
    const moved = { ...n, vector: { subpaths: [{ anchors: [anchor(0, 0), anchor(50, 0)], closed: false }] } };
    expect(brushStrokeCommands(moved, n.strokes[0])).not.toBe(cmds);
  });
  it("only vectors with a positive weight are brushed", () => {
    expect(hasBrushedStroke(line(scatter))).toBe(true);
    expect(hasBrushedStroke(line(undefined))).toBe(false);
    expect(hasBrushedStroke(line(scatter, { kind: "rect" }))).toBe(false);
    const n = line(scatter);
    expect(brushStrokeCommands({ ...n, kind: "rect" }, n.strokes[0])).toEqual([]);
    expect(brushStrokeCommands(n, { ...n.strokes[0], weight: 0 })).toEqual([]);
  });
  it("the bounds overhang covers the stamps' stray and tips", () => {
    const b: BrushLite = { ...scatter, scatter: 2, sizeJitter: 0.5 };
    expect(strokeOutsetOfNode(line(b))).toBeCloseTo(brushReach(b, 10), 9);
    expect(brushReach(b, 10)).toBeGreaterThan(10); // 10 of stray plus the tip
    expect(strokeOutsetOfNode(line(undefined))).toBe(5);
    // Every stamp of a dense jittered brush stays inside the reach.
    const j: BrushLite = { ...scatter, spacing: 0.2, scatter: 3, sizeJitter: 1, angleJitter: 180, tip: "square" };
    const n = line(j);
    const reach = brushReach(j, 10);
    for (const c of brushStrokeCommands(n, n.strokes[0])) if (c[0] === "M" || c[0] === "L") expect(Math.abs(c[2])).toBeLessThanOrEqual(reach + 1e-9);
  });
  it("SVG export writes one non-zero filled path of the stamps, no stroke, the same every time", () => {
    const n = line({ ...scatter, spacing: 1, scatter: 1, sizeJitter: 0.3, angleJitter: 30 });
    const bounds = { x: 0, y: 0, width: 200, height: 200 };
    const out = nodesToSvg([n], bounds, (s) => s.length * 10);
    expect(out).toContain('fill-rule="nonzero"');
    expect(out).toContain('fill="rgb(0,0,0)"');
    expect(out).not.toContain("stroke-width");
    expect(out).toContain("C"); // the dots are cubics
    expect(nodesToSvg([n], bounds, (s) => s.length * 10)).toBe(out);
    const other = nodesToSvg([line({ ...n.strokes[0].brush!, seed: 99 })], bounds, (s) => s.length * 10);
    expect(other).not.toBe(out);
  });
  it("a brush wins over a width profile", () => {
    const n = line(scatter);
    const both = { ...n, strokes: [{ ...n.strokes[0], widthProfile: [{ position: 0, left: 0, right: 0 }, { position: 1, left: 1, right: 1 }] }] };
    const out = nodesToSvg([both], { x: 0, y: 0, width: 200, height: 200 }, (s) => s.length * 10);
    expect(out).toContain('fill-rule="nonzero"');
    expect(out).not.toContain("evenodd");
  });
});

describe("presets and spec", () => {
  it("each preset is valid, named back, and pinned (mirrors internal/mcp/brush.go)", () => {
    for (const [name, b] of Object.entries(BRUSH_PRESETS)) {
      expect(brushPresetName(b), name).toBe(name);
      expect(clampBrush(b), name).toEqual(b);
    }
    expect(Object.keys(BRUSH_PRESETS)).toEqual(["chalk", "marker", "dots", "leaves"]);
    expect(BRUSH_PRESETS.leaves).toEqual({ kind: "scatter", tip: "leaf", spacing: 1.5, scatter: 0.8, sizeJitter: 0.4, angleJitter: 60, seed: 4 });
    expect(brushPresetName(undefined)).toBe("none");
    expect(brushPresetName({ ...BRUSH_PRESETS.chalk, seed: 99 })).toBe("custom");
  });
});

const pb = (over: Record<string, number> = {}) =>
  create(BrushSchema, { kind: BrushKind.SCATTER, tip: BrushTip.LEAF, spacing: 1.5, scatter: 0.8, sizeJitter: 0.4, angleJitter: 60, seed: 4, ...over } as never);

describe("validation and the wire", () => {
  it("isValidBrush mirrors core.validateBrush", () => {
    expect(isValidBrush(undefined)).toBe(true);
    expect(isValidBrush(pb())).toBe(true);
    expect(isValidBrush(create(BrushSchema, { kind: BrushKind.NONE, spacing: -5 }))).toBe(true);
    for (const bad of [
      pb({ kind: 9 }), pb({ tip: 9 }), pb({ spacing: 0 }), pb({ spacing: 0.01 }), pb({ spacing: 65 }), pb({ scatter: -1 }), pb({ scatter: 9 }),
      pb({ sizeJitter: 1.5 }), pb({ angleJitter: 181 }), pb({ spacing: NaN }), pb({ scatter: Infinity }),
    ]) expect(isValidBrush(bad)).toBe(false);
  });
  it("a stroke round-trips through the proto, and NONE reads back as no brush", () => {
    const strokes = [{ color: black, weight: 4, align: "center" as const, brush: BRUSH_PRESETS.leaves }];
    const back = toStrokeLite(create(StrokeSchema, toPbStrokes(strokes)[0] as never));
    expect(back.brush).toEqual(BRUSH_PRESETS.leaves);
    const none = toStrokeLite(create(StrokeSchema, { weight: 4, brush: create(BrushSchema, {}) }));
    expect(none.brush).toBeUndefined();
  });
  it("a setProps with an invalid brush leaves the scene unchanged", () => {
    const s = sceneOf(line(scatter));
    const write = (spacing: number) => makeSetPropsOp("v", { strokes: toPbStrokes([{ color: black, weight: 4, align: "center", brush: { ...scatter, spacing } }]) }, ["strokes"]);
    expect(applyOp(s, write(0))).toBe(s);
    expect(applyOp(s, write(1))).not.toBe(s);
  });
});

describe("brushEdit", () => {
  it("writes the brush on the first stroke, and a vector without one gets a black stroke", () => {
    const n = line(undefined);
    const ops = setBrushOps(n, BRUSH_PRESETS.chalk);
    expect(ops).toHaveLength(1);
    const out = ops.reduce(applyOp, sceneOf(n));
    expect((out.nodes.at("v") as NodeLite).strokes[0].brush).toEqual(BRUSH_PRESETS.chalk);
    const bare = { ...n, strokes: [] };
    const added = setBrushOps(bare, BRUSH_PRESETS.dots).reduce(applyOp, sceneOf(bare));
    expect((added.nodes.at("v") as NodeLite).strokes[0]).toMatchObject({ weight: 4, brush: BRUSH_PRESETS.dots });
  });
  it("undefined goes back to the plain stroke; no ops when nothing changes or for other shapes", () => {
    const n = line(BRUSH_PRESETS.marker);
    const out = setBrushOps(n, undefined).reduce(applyOp, sceneOf(n));
    expect((out.nodes.at("v") as NodeLite).strokes[0].brush).toBeUndefined();
    expect(setBrushOps(n, BRUSH_PRESETS.marker)).toEqual([]);
    expect(setBrushOps(line(undefined, { kind: "rect" }), BRUSH_PRESETS.chalk)).toEqual([]);
    expect(brushStrokeOf(line(undefined))?.weight).toBe(10);
  });
  it("clamps what a panel field could write beyond the limits", () => {
    const c = clampBrush({ ...scatter, spacing: 0, scatter: 99, sizeJitter: 2, angleJitter: 999, seed: -3 });
    expect(c).toMatchObject({ spacing: 0.05, scatter: 8, sizeJitter: 1, angleJitter: 180, seed: 0 });
    expect(isValidBrush(pb({ spacing: c.spacing, scatter: c.scatter, sizeJitter: c.sizeJitter, angleJitter: c.angleJitter, seed: c.seed }))).toBe(true);
  });
});
