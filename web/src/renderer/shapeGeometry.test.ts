import { describe, it, expect } from "vitest";
import {
  arcCommands, clampedRadii, commandsToD, flattenCommands, hasComputedOutline, outlineCommands, pointInRings, polygonVertices, roundedRectCommands, starVertices,
} from "@/renderer/shapeGeometry";
import { arrowEnds, arrowHead, hasArrowheads, strokeHeads } from "@/renderer/arrowheads";
import { sideBandRects } from "@/renderer/strokeSides";
import { hitTestNode } from "@/renderer/shapes";
import { strokeOutset } from "@/canvas/geometry";
import type { NodeLite } from "@/store/types";

function node(over: Partial<NodeLite>): NodeLite {
  return {
    id: "a", parentId: "p", orderKey: "a0", name: "a", visible: true, opacity: 1,
    x: 0, y: 0, width: 100, height: 100, rotation: 0,
    fills: [], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false, ...over,
  };
}

const rings = (n: NodeLite) => flattenCommands(outlineCommands(n) ?? []);

describe("polygon and star", () => {
  it("a hexagon has six vertices on the ellipse, the first at the top", () => {
    const v = polygonVertices(node({ kind: "polygon", sides: 6 }), 6);
    expect(v).toHaveLength(6);
    expect(v[0][0]).toBeCloseTo(50, 6);
    expect(v[0][1]).toBeCloseTo(0, 6);
    for (const [x, y] of v) expect(Math.hypot(x - 50, y - 50)).toBeCloseTo(50, 6);
  });

  it("a star alternates outer and inner vertices at the ratio", () => {
    const v = starVertices(node({ kind: "star", points: 5, innerRatio: 0.4 }), 5, 0.4);
    expect(v).toHaveLength(10);
    v.forEach(([x, y], i) => expect(Math.hypot(x - 50, y - 50)).toBeCloseTo(i % 2 === 0 ? 50 : 20, 6));
  });

  it("fits a non-square box (the vertices lie on the box's ellipse)", () => {
    const v = polygonVertices(node({ kind: "polygon", width: 200, height: 100 }), 4);
    expect(v[0]).toEqual([expect.closeTo(100, 6), expect.closeTo(0, 6)]);
    expect(v[1][0]).toBeCloseTo(200, 6);
  });

  it("the outline is a closed polyline", () => {
    const d = commandsToD(outlineCommands(node({ kind: "polygon", sides: 3 }))!);
    expect(d.startsWith("M50 0L")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
  });

  it("hit-testing follows the true outline, not the box", () => {
    const tri = node({ kind: "polygon", sides: 3 });
    expect(hitTestNode(tri, 50, 60, 1)).toBe(true);
    expect(hitTestNode(tri, 5, 5, 1)).toBe(false);
    expect(hitTestNode(tri, 50, -2, 1)).toBe(false);
  });
});

describe("ellipse arcs and rings", () => {
  it("a plain ellipse is not computed; a partial sweep or a ring is", () => {
    expect(hasComputedOutline(node({ kind: "ellipse" }))).toBe(false);
    expect(hasComputedOutline(node({ kind: "ellipse", arcStart: 40 }))).toBe(false); // a full sweep, start is moot
    expect(hasComputedOutline(node({ kind: "ellipse", arcSweep: 360 }))).toBe(false);
    expect(hasComputedOutline(node({ kind: "ellipse", arcSweep: 90 }))).toBe(true);
    expect(hasComputedOutline(node({ kind: "ellipse", innerRatio: 0.5 }))).toBe(true);
  });

  it("a quarter pie covers the first quadrant (clockwise from +x) and not the others", () => {
    const pie = node({ kind: "ellipse", arcStart: 0, arcSweep: 90 });
    const r = rings(pie);
    expect(pointInRings(r, 70, 70)).toBe(true); // bottom-right of the centre
    expect(pointInRings(r, 30, 30)).toBe(false);
    expect(pointInRings(r, 70, 30)).toBe(false);
    expect(pointInRings(r, 30, 70)).toBe(false);
  });

  it("a negative sweep goes counter-clockwise", () => {
    const r = rings(node({ kind: "ellipse", arcStart: 0, arcSweep: -90 }));
    expect(pointInRings(r, 70, 30)).toBe(true); // top-right
    expect(pointInRings(r, 70, 70)).toBe(false);
  });

  it("a ring leaves a hole of the inner ratio", () => {
    const r = rings(node({ kind: "ellipse", innerRatio: 0.5 }));
    expect(pointInRings(r, 50, 50)).toBe(false);
    expect(pointInRings(r, 50, 20)).toBe(true); // radius 30, between 25 and 50
    expect(pointInRings(r, 50, 80)).toBe(true);
  });

  it("an arc ring keeps the sweep and the hole", () => {
    const r = rings(node({ kind: "ellipse", arcStart: 0, arcSweep: 180, innerRatio: 0.5 }));
    expect(pointInRings(r, 50, 80)).toBe(true); // lower half, radius 30
    expect(pointInRings(r, 50, 20)).toBe(false); // upper half
    expect(pointInRings(r, 50, 55)).toBe(false); // the hole
  });

  it("arcCommands ends in a closed contour", () => {
    const c = arcCommands(node({ kind: "ellipse", arcSweep: 120 }));
    expect(c[0][0]).toBe("M");
    expect(c[c.length - 1][0]).toBe("Z");
  });
});

describe("rectangle corners", () => {
  it("a plain rectangle (no smoothing, no radii) is not computed", () => {
    expect(hasComputedOutline(node({ cornerRadius: 12 }))).toBe(false);
    expect(hasComputedOutline(node({ cornerSmoothing: 0.5, cornerRadius: 12 }))).toBe(true);
    expect(hasComputedOutline(node({ radii: { topLeft: 1, topRight: 2, bottomRight: 3, bottomLeft: 4 } }))).toBe(true);
  });

  it("independent radii: a big corner cuts the rectangle there only", () => {
    const n = node({ radii: { topLeft: 40, topRight: 0, bottomRight: 0, bottomLeft: 0 } });
    const r = flattenCommands(roundedRectCommands(n));
    expect(pointInRings(r, 2, 2)).toBe(false); // the rounded corner
    expect(pointInRings(r, 98, 2)).toBe(true); // the sharp one
    expect(pointInRings(r, 98, 98)).toBe(true);
    expect(pointInRings(r, 2, 98)).toBe(true);
  });

  it("radii that do not fit are scaled down together (CSS rule)", () => {
    const [tl, tr] = clampedRadii({ width: 100, height: 100, cornerRadius: 0, radii: { topLeft: 80, topRight: 80, bottomRight: 0, bottomLeft: 0 } });
    expect(tl + tr).toBeCloseTo(100, 6);
  });

  it("smoothing 0 reproduces a circular corner (ends on the edges at the radius)", () => {
    const cmds = roundedRectCommands(node({ cornerRadius: 20, cornerSmoothing: 0.0001 }));
    expect(cmds[0]).toEqual(["M", expect.closeTo(80, 2), expect.closeTo(0, 2)]); // the top edge ends r before the corner
  });

  it("smoothing pushes the curve further along the edges than the radius", () => {
    const smooth = roundedRectCommands(node({ cornerRadius: 20, cornerSmoothing: 1 }));
    expect(smooth[0][0]).toBe("M");
    // start of the top-right curve: (100 - (1 + s) r, 0) = (60, 0)
    expect((smooth[0] as readonly ["M", number, number])[1]).toBeCloseTo(60, 4);
  });

  it("a smoothed corner stays inside the box and is still convex-ish: the centre is inside, the vertex is cut", () => {
    const r = flattenCommands(roundedRectCommands(node({ cornerRadius: 30, cornerSmoothing: 0.8 })));
    expect(pointInRings(r, 50, 50)).toBe(true);
    expect(pointInRings(r, 99, 1)).toBe(false);
    for (const ring of r) for (const [x, y] of ring) {
      expect(x).toBeGreaterThanOrEqual(-1e-6);
      expect(x).toBeLessThanOrEqual(100 + 1e-6);
      expect(y).toBeGreaterThanOrEqual(-1e-6);
      expect(y).toBeLessThanOrEqual(100 + 1e-6);
    }
  });
});

describe("arrowheads", () => {
  const line = node({
    kind: "vector", x: 10, y: 10, width: 100, height: 0,
    vector: { subpaths: [{ closed: false, anchors: [{ x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 }, { x: 100, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 }] }] },
    strokes: [{ color: { r: 0, g: 0, b: 0, a: 1 }, weight: 2, align: "center", endCap: "triangle" }],
  });

  it("finds the two ends of an open path and the direction it leaves them", () => {
    const e = arrowEnds(line);
    expect(e.start?.tip).toEqual({ x: 10, y: 10 });
    expect(e.start?.out).toEqual({ x: -1, y: 0 });
    expect(e.end?.tip).toEqual({ x: 110, y: 10 });
    expect(e.end?.out).toEqual({ x: 1, y: 0 });
  });

  it("a closed subpath has no ends", () => {
    const closed = node({ kind: "vector", vector: { subpaths: [{ closed: true, anchors: line.vector!.subpaths[0].anchors }] } });
    expect(arrowEnds(closed)).toEqual({});
  });

  it("only the asked ends get a head, sized by the weight", () => {
    expect(hasArrowheads(line)).toBe(true);
    const heads = strokeHeads(line, undefined, "triangle", 2);
    expect(heads).toHaveLength(1);
    expect(heads[0].filled[0]).toEqual(["M", 110, 10]); // the tip is the end point
    expect(strokeHeads(line, "circle", "arrow", 2)).toHaveLength(2);
    expect(strokeHeads(line, undefined, undefined, 2)).toHaveLength(0);
  });

  it("every kind sits behind the tip (no overhang) and the arrow is an open V", () => {
    for (const kind of ["triangle", "circle", "square", "diamond"] as const) {
      const g = arrowHead(kind, { x: 0, y: 0 }, { x: 1, y: 0 }, 3);
      expect(g.open).toEqual([]);
      const xs = flattenCommands(g.filled).flat().map((p) => p[0]);
      expect(Math.max(...xs)).toBeLessThanOrEqual(1e-6);
    }
    const v = arrowHead("arrow", { x: 0, y: 0 }, { x: 1, y: 0 }, 3);
    expect(v.filled).toEqual([]);
    expect(v.open.map((c) => c[0])).toEqual(["M", "L", "L"]);
  });
});

describe("per-side stroke weights", () => {
  const sides = { top: 1, right: 2, bottom: 6, left: 4 };
  const n = { x: 10, y: 10, width: 100, height: 50 };

  it("inside: the outer rectangle is the box, the inner one is shrunk by each side", () => {
    const { outer, inner } = sideBandRects(n, { align: "inside", sides });
    expect(outer).toEqual({ x: 10, y: 10, width: 100, height: 50 });
    expect(inner).toEqual({ x: 14, y: 11, width: 94, height: 43 });
  });

  it("outside: the inner rectangle is the box, the outer one grows", () => {
    const { outer, inner } = sideBandRects(n, { align: "outside", sides });
    expect(inner).toEqual({ x: 10, y: 10, width: 100, height: 50 });
    expect(outer).toEqual({ x: 6, y: 9, width: 106, height: 57 });
  });

  it("center straddles the edge", () => {
    const { outer, inner } = sideBandRects(n, { align: "center", sides: { top: 2, right: 2, bottom: 2, left: 2 } });
    expect(outer).toEqual({ x: 9, y: 9, width: 102, height: 52 });
    expect(inner).toEqual({ x: 11, y: 11, width: 98, height: 48 });
  });

  it("the stroke overhang uses the widest side", () => {
    const s = { color: { r: 0, g: 0, b: 0, a: 1 }, weight: 6, align: "outside" as const, sides };
    expect(strokeOutset(s)).toBe(6);
    expect(strokeOutset({ ...s, align: "center" })).toBe(3);
    expect(strokeOutset({ ...s, align: "inside" })).toBe(0);
  });
});
