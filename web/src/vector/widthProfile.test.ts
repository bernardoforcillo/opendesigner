import { describe, it, expect } from "vitest";
import polygonClipping from "polygon-clipping";
import type { MultiPolygon } from "polygon-clipping";
import { nodesOf } from "@/store/nodeMap";
import { applyOp } from "@/store/applyOp";
import { emptyScene } from "@/store/types";
import type { NodeLite, SceneState, WidthPointLite } from "@/store/types";
import { nodesToSvg } from "@/export/svg";
import { strokeOutsetOfNode } from "@/canvas/geometry";
import { outlineStrokeOps } from "@/vector/outlineStroke";
import type { WidthGeometry } from "@/vector/widthProfile";
import {
  WIDTH_PRESETS, hasVariableWidth, isValidWidthProfile, presetNameOf, variableStrokeCommands, variableStrokePolyline,
  variableStrokeRegion, widthAt,
} from "@/vector/widthProfile";

const anchor = (x: number, y: number) => ({ x, y, inX: 0, inY: 0, outX: 0, outY: 0 });
const black = { r: 0, g: 0, b: 0, a: 1 };
function line(profile: WidthPointLite[] | undefined, over: Partial<NodeLite> = {}): NodeLite {
  return {
    id: "v", parentId: "page1", orderKey: "a0", name: "Line", visible: true, opacity: 1, x: 10, y: 20, width: 100, height: 0, rotation: 0,
    fills: [], strokes: [{ color: black, weight: 10, align: "center", ...(profile ? { widthProfile: profile } : {}) }],
    kind: "vector", cornerRadius: 0, clipsContent: false,
    vector: { subpaths: [{ anchors: [anchor(0, 0), anchor(100, 0)], closed: false }] }, ...over,
  };
}
const area = (r: MultiPolygon) =>
  r.reduce((t, poly) => t + poly.reduce((s, ring, i) => {
    let a = 0;
    for (let k = 0; k < ring.length - 1; k++) a += ring[k][0] * ring[k + 1][1] - ring[k + 1][0] * ring[k][1];
    return s + (i === 0 ? 1 : -1) * Math.abs(a / 2);
  }, 0), 0);
const sceneOf = (n: NodeLite): SceneState => ({ ...emptyScene("d", "t"), nodes: nodesOf({ [n.id]: n }) });

describe("widthAt", () => {
  const p: WidthPointLite[] = [{ position: 0.2, left: 0, right: 2 }, { position: 0.6, left: 2, right: 0 }];
  it("holds the ends and interpolates linearly between points", () => {
    expect(widthAt(p, 0)).toEqual({ left: 0, right: 2 });
    expect(widthAt(p, 1)).toEqual({ left: 2, right: 0 });
    expect(widthAt(p, 0.4).left).toBeCloseTo(1, 9);
    expect(widthAt(p, 0.4).right).toBeCloseTo(1, 9);
    expect(widthAt([], 0.5)).toEqual({ left: 1, right: 1 });
  });
  it("a repeated position is a step", () => {
    const step: WidthPointLite[] = [{ position: 0.5, left: 1, right: 1 }, { position: 0.5, left: 3, right: 3 }];
    expect(widthAt(step, 0.5).left).toBe(1);
    expect(widthAt(step, 0.51).left).toBe(3);
  });
});

describe("profile validation and presets", () => {
  it("mirrors the Go limits", () => {
    expect(isValidWidthProfile(undefined)).toBe(true);
    expect(isValidWidthProfile(WIDTH_PRESETS.brush)).toBe(true);
    expect(isValidWidthProfile([{ position: 1.2, left: 1, right: 1 }])).toBe(false);
    expect(isValidWidthProfile([{ position: 0.5, left: 1, right: 1 }, { position: 0.2, left: 1, right: 1 }])).toBe(false);
    expect(isValidWidthProfile([{ position: 0, left: -1, right: 1 }])).toBe(false);
    expect(isValidWidthProfile([{ position: 0, left: 17, right: 1 }])).toBe(false);
    expect(isValidWidthProfile(Array.from({ length: 65 }, () => ({ position: 0.5, left: 1, right: 1 })))).toBe(false);
  });
  it("every preset is valid and names itself", () => {
    for (const [name, pts] of Object.entries(WIDTH_PRESETS)) {
      expect(isValidWidthProfile(pts)).toBe(true);
      expect(presetNameOf(pts)).toBe(name);
    }
    expect(presetNameOf(undefined)).toBe("uniform");
    expect(presetNameOf([{ position: 0, left: 5, right: 5 }])).toBe("custom");
  });
});

describe("variable stroke geometry", () => {
  const straight = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  const g: WidthGeometry = { cap: "butt", join: "miter" };
  const region = (profile: WidthPointLite[], pts = straight, closed = false, w = 10, geo = g) =>
    polygonClipping.union(...(variableStrokePolyline(pts, closed, w, profile, geo) as [MultiPolygon, ...MultiPolygon[]]));

  it("a flat profile of 1 is the uniform stroke", () => {
    expect(area(region([{ position: 0, left: 1, right: 1 }]))).toBeCloseTo(100 * 10, 6);
  });
  it("a taper to zero is a triangle: half the area", () => {
    expect(area(region(WIDTH_PRESETS.taper as WidthPointLite[]))).toBeCloseTo(100 * 10 / 2, 6);
  });
  it("left and right are independent: only the left side, which is north on a y-down screen", () => {
    const r = region([{ position: 0, left: 2, right: 0 }]);
    expect(area(r)).toBeCloseTo(100 * 10, 6);
    const ys = r[0][0].map((p) => p[1]);
    expect(Math.min(...ys)).toBeCloseTo(-10, 6);
    expect(Math.max(...ys)).toBeCloseTo(0, 6);
  });
  it("a lens narrows to nothing at both ends and is the full width in the middle", () => {
    const r = region(WIDTH_PRESETS.lens as WidthPointLite[]);
    expect(area(r)).toBeCloseTo(100 * 10 / 2, 6);
    expect(Math.max(...r[0][0].map((p) => p[1]))).toBeCloseTo(5, 6);
  });
  it("round caps add a half disc at an end that has width", () => {
    const flat = [{ position: 0, left: 1, right: 1 }];
    const round = area(region(flat, straight, false, 10, { cap: "round", join: "miter" }));
    // two half discs of radius 5 (a polygonal arc is a little under the true area)
    expect(round).toBeGreaterThan(1000 + Math.PI * 25 - 3);
    expect(round).toBeLessThan(1000 + Math.PI * 25 + 0.01);
    // ...and none at a tip.
    expect(area(region(WIDTH_PRESETS.lens as WidthPointLite[], straight, false, 10, { cap: "round", join: "miter" }))).toBeCloseTo(500, 6);
  });
  it("a corner has no gap on its outer side", () => {
    const elbow = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }];
    const r = region([{ position: 0, left: 1, right: 1 }], elbow);
    // two 50 x 10 strokes overlapping in a 5 x 5 corner plus the 5 x 5 wedge halves: area 1000 - 25 + 12.5 (bevel).
    expect(area(r)).toBeCloseTo(1000 - 25 + 12.5, 6);
  });
  it("a closed path ring stays a ring with a hole", () => {
    const sq = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
    const r = region([{ position: 0, left: 1, right: 1 }], sq, true);
    expect(r).toHaveLength(1);
    expect(r[0]).toHaveLength(2);
  });
  it("a zero weight or a single point draws nothing", () => {
    expect(variableStrokePolyline(straight, false, 0, WIDTH_PRESETS.lens as WidthPointLite[], g)).toEqual([]);
    expect(variableStrokePolyline([{ x: 1, y: 1 }], false, 4, WIDTH_PRESETS.lens as WidthPointLite[], g)).toEqual([]);
  });
});

describe("variable stroke on a node", () => {
  it("only a vector with a profile is variable", () => {
    expect(hasVariableWidth(line(WIDTH_PRESETS.taper as WidthPointLite[]))).toBe(true);
    expect(hasVariableWidth(line(undefined))).toBe(false);
    expect(hasVariableWidth(line(WIDTH_PRESETS.taper as WidthPointLite[], { kind: "rect" }))).toBe(false);
  });
  it("the cached commands are reused until the vector changes", () => {
    const n = line(WIDTH_PRESETS.lens as WidthPointLite[]);
    const a = variableStrokeCommands(n, n.strokes[0]);
    expect(a.length).toBeGreaterThan(0);
    expect(variableStrokeCommands(n, n.strokes[0])).toBe(a);
    const moved = { ...n, vector: { subpaths: [{ anchors: [anchor(0, 0), anchor(50, 0)], closed: false }] } };
    expect(variableStrokeCommands(moved, n.strokes[0])).not.toBe(a);
  });
  it("the bounds overhang follows the widest side", () => {
    expect(strokeOutsetOfNode(line([{ position: 0, left: 3, right: 1 }]))).toBe(15);
    expect(strokeOutsetOfNode(line(undefined))).toBe(5);
  });
  it("SVG export fills the region instead of stroking", () => {
    const n = line(WIDTH_PRESETS.lens as WidthPointLite[]);
    const out = nodesToSvg([n], { x: 0, y: 0, width: 200, height: 200 }, (s) => s.length * 10);
    expect(out).toContain('fill="rgb(0,0,0)"');
    expect(out).toContain('fill-rule="evenodd"');
    expect(out).not.toContain("stroke-width");
    expect(out).toContain("M10 ");
  });
  it("outline stroke keeps the profile: a lens outlines to half the uniform area", () => {
    const n = line(WIDTH_PRESETS.lens as WidthPointLite[], { x: 0, y: 0 });
    const s = sceneOf(n);
    const res = outlineStrokeOps(s, "v")!;
    const out = res.ops.reduce(applyOp, s);
    const node = out.nodes.at(res.selection[0]) as NodeLite;
    const ring = node.vector!.subpaths[0].anchors;
    let a = 0;
    for (let i = 0; i < ring.length; i++) { const p = ring[i], q = ring[(i + 1) % ring.length]; a += p.x * q.y - q.x * p.y; }
    expect(Math.abs(a / 2)).toBeCloseTo(500, 6);
  });
  it("the region of a curved path is one piece", () => {
    const n = line(WIDTH_PRESETS.bulge as WidthPointLite[], {
      vector: { subpaths: [{ anchors: [{ x: 0, y: 0, inX: 0, inY: 0, outX: 30, outY: -40 }, { x: 100, y: 0, inX: -30, inY: -40, outX: 0, outY: 0 }], closed: false }] },
    });
    const r = variableStrokeRegion(n, n.strokes[0]);
    expect(r).toHaveLength(1);
    expect(area(r)).toBeGreaterThan(300);
  });
});
