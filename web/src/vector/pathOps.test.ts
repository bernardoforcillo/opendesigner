import { describe, expect, it } from "vitest";
import {
  cornerAll, deleteAnchor, insertAnchor, isSmooth, joinSubpaths, makeCorner, makeSmooth, moveHandle,
  nearestOnPath, offsetSubpaths, simplifySubpath, smoothAll, toggleClosed,
} from "./pathOps";
import { vectorBounds } from "../store/vectorGeometry";
import type { AnchorLite, SubPathLite } from "../store/types";

const pt = (x: number, y: number, h: Partial<AnchorLite> = {}): AnchorLite => ({ x, y, inX: 0, inY: 0, outX: 0, outY: 0, ...h });
const line = (...p: [number, number][]): SubPathLite => ({ anchors: p.map(([x, y]) => pt(x, y)), closed: false });
const square = (s: number): SubPathLite => ({ anchors: [pt(0, 0), pt(s, 0), pt(s, s), pt(0, s)], closed: true });

describe("insertAnchor", () => {
  it("splits a straight segment in the middle", () => {
    const sp = insertAnchor(line([0, 0], [10, 0]), 0, 0.5);
    expect(sp.anchors.map((a) => [a.x, a.y])).toEqual([[0, 0], [5, 0], [10, 0]]);
  });

  it("keeps the curve: the new point lies on the old one", () => {
    const curve: SubPathLite = { closed: false, anchors: [pt(0, 0, { outX: 0, outY: 10 }), pt(10, 0, { inX: 0, inY: 10 })] };
    const sp = insertAnchor(curve, 0, 0.5);
    expect(sp.anchors).toHaveLength(3);
    // The cubic at t=.5 is (5, 7.5).
    expect(sp.anchors[1].x).toBeCloseTo(5);
    expect(sp.anchors[1].y).toBeCloseTo(7.5);
    // Both halves still reach the same extremum as the original.
    expect(vectorBounds(sp.anchors.length ? [sp] : []).height).toBeCloseTo(vectorBounds([curve]).height, 5);
  });

  it("splits the closing segment of a closed path and keeps the order", () => {
    const sp = insertAnchor(square(10), 3, 0.5);
    expect(sp.anchors.map((a) => [a.x, a.y])).toEqual([[0, 0], [10, 0], [10, 10], [0, 10], [0, 5]]);
  });
});

describe("nearestOnPath", () => {
  it("finds the segment and parameter under a point, and nothing when far", () => {
    const hit = nearestOnPath(line([0, 0], [10, 0], [10, 10]), 10.4, 5, 2)!;
    expect(hit.seg).toBe(1);
    expect(hit.t).toBeCloseTo(0.5, 1);
    expect(nearestOnPath(line([0, 0], [10, 0]), 5, 20, 2)).toBeNull();
  });
});

describe("deleting and moving", () => {
  it("deletes an anchor, and the last one removes the path", () => {
    expect(deleteAnchor(square(10), 1)!.anchors).toHaveLength(3);
    expect(deleteAnchor(line([0, 0]), 0)).toBeNull();
    expect(deleteAnchor(line([0, 0], [1, 1]), 0)!.closed).toBe(false);
  });

  it("a handle on a smooth anchor turns the opposite one, keeping its length; Alt breaks it", () => {
    const a: SubPathLite = { closed: false, anchors: [pt(0, 0), pt(10, 0, { inX: -4, inY: 0, outX: 6, outY: 0 }), pt(20, 0)] };
    expect(isSmooth(a.anchors[1])).toBe(true);
    const turned = moveHandle(a, 1, "out", 10, 5);
    expect(turned.anchors[1]).toMatchObject({ outX: 0, outY: 5 });
    expect(turned.anchors[1].inX).toBeCloseTo(0);
    expect(turned.anchors[1].inY).toBeCloseTo(-4);
    const broken = moveHandle(a, 1, "out", 10, 5, true);
    expect(broken.anchors[1]).toMatchObject({ inX: -4, inY: 0 });
    expect(isSmooth(broken.anchors[1])).toBe(false);
  });
});

describe("smooth and corner", () => {
  it("makes handles along the neighbours' line, and corner removes them", () => {
    const sp = makeSmooth(line([0, 0], [10, 10], [20, 0]), 1);
    const m = sp.anchors[1];
    expect(m.outX).toBeCloseTo(-m.inX);
    expect(m.outY).toBeCloseTo(-m.inY);
    expect(m.outY).toBeCloseTo(0);
    expect(isSmooth(m)).toBe(true);
    expect(isSmooth(makeCorner(sp, 1).anchors[1])).toBe(false);
    expect(cornerAll(smoothAll(square(10))).anchors.every((a) => !a.outX && !a.outY)).toBe(true);
  });

  it("an end of an open path gets a single handle", () => {
    const m = makeSmooth(line([0, 0], [10, 0], [20, 5]), 0).anchors[0];
    expect(m.inX).toBe(0);
    expect(m.outX).toBeGreaterThan(0);
  });

  it("closing and opening", () => {
    expect(toggleClosed(line([0, 0], [1, 1], [2, 0])).closed).toBe(true);
    expect(toggleClosed(line([0, 0])).closed).toBe(false);
  });
});

describe("simplifySubpath", () => {
  it("drops the collinear points and keeps the corners", () => {
    const sp = line([0, 0], [5, 0.01], [10, 0], [10, 5], [10, 10]);
    expect(simplifySubpath(sp, 0.5).anchors.map((a) => [a.x, a.y])).toEqual([[0, 0], [10, 0], [10, 10]]);
  });

  it("works on a closed shape and leaves a path with nothing to drop alone", () => {
    const many: SubPathLite = { closed: true, anchors: [pt(0, 0), pt(5, 0), pt(10, 0), pt(10, 5), pt(10, 10), pt(5, 10), pt(0, 10), pt(0, 5)] };
    const s = simplifySubpath(many, 0.5);
    expect(s.closed).toBe(true);
    expect(s.anchors).toHaveLength(4);
    const sq = square(10);
    expect(simplifySubpath(sq, 0.5)).toBe(sq);
  });
});

describe("joinSubpaths", () => {
  it("merges ends that touch into one anchor", () => {
    const j = joinSubpaths(line([0, 0], [10, 0]), line([10, 0], [10, 10]))!;
    expect(j.anchors.map((a) => [a.x, a.y])).toEqual([[0, 0], [10, 0], [10, 10]]);
  });

  it("connects the nearest ends, flipping a path if needed, and refuses closed ones", () => {
    const j = joinSubpaths(line([0, 0], [10, 0]), line([20, 0], [12, 0]))!;
    expect(j.anchors.map((a) => a.x)).toEqual([0, 10, 12, 20]);
    expect(joinSubpaths(square(5), line([0, 0], [1, 1]))).toBeNull();
  });
});

describe("offsetSubpaths", () => {
  const area = (sps: SubPathLite[]) => {
    let a = 0;
    for (const sp of sps) {
      for (let i = 0; i < sp.anchors.length; i++) {
        const p = sp.anchors[i], q = sp.anchors[(i + 1) % sp.anchors.length];
        a += p.x * q.y - q.x * p.y;
      }
    }
    return Math.abs(a) / 2;
  };

  it("grows a square outward and shrinks it inward", () => {
    const grown = offsetSubpaths([square(100)], 10)!;
    const b = vectorBounds(grown);
    expect(b.width).toBeCloseTo(120, 0);
    expect(b.height).toBeCloseTo(120, 0);
    const shrunk = offsetSubpaths([square(100)], -10)!;
    expect(area(shrunk)).toBeCloseTo(80 * 80, -1);
  });

  it("is null when shrunk away, for open paths and for a zero distance", () => {
    expect(offsetSubpaths([square(10)], -20)).toBeNull();
    expect(offsetSubpaths([line([0, 0], [10, 0])], 5)).toBeNull();
    expect(offsetSubpaths([square(10)], 0)).toBeNull();
  });
});
