import { describe, it, expect } from "vitest";
import {
  arrowBetween, arrowFromRectToPoint, arrowhead, bezierBounds, bezierPoint, distanceToBezier,
  distanceToSegment, facingSide, inflate, laneShift, LANE_GAP, overlaps, sidePoint,
} from "./geometry";

const A = { x: 0, y: 0, width: 200, height: 300 };
const right = { x: 400, y: 0, width: 200, height: 300 };
const below = { x: 0, y: 500, width: 200, height: 300 };

describe("facingSide", () => {
  it("picks the side facing the other screen", () => {
    expect(facingSide(A, right)).toBe("right");
    expect(facingSide(right, A)).toBe("left");
    expect(facingSide(A, below)).toBe("bottom");
    expect(facingSide(below, A)).toBe("top");
  });

  it("normalizes on the dimensions: two tall side-by-side frames stay right/left even with a vertical offset", () => {
    const tall = { x: 0, y: 0, width: 100, height: 1000 };
    const next = { x: 200, y: 300, width: 100, height: 1000 };
    expect(facingSide(tall, next)).toBe("right");
  });
});

describe("arrowBetween", () => {
  it("starts at the midpoint of the side and arrives at the midpoint of the opposite side", () => {
    const c = arrowBetween(A, right);
    expect(c.p0).toEqual({ x: 200, y: 150 });
    expect(c.p3).toEqual({ x: 400, y: 150 });
  });

  it("the tangents are perpendicular to the sides (they leave straight from the edge)", () => {
    const c = arrowBetween(A, right);
    // c1 is to the right of p0 on the same row, c2 to the left of p3.
    expect(c.c1.y).toBe(c.p0.y);
    expect(c.c1.x).toBeGreaterThan(c.p0.x);
    expect(c.c2.y).toBe(c.p3.y);
    expect(c.c2.x).toBeLessThan(c.p3.x);
    const v = arrowBetween(A, below);
    expect(v.c1.x).toBe(v.p0.x);
    expect(v.c1.y).toBeGreaterThan(v.p0.y);
  });

  it("the lane shifts both ends along the side", () => {
    const c = arrowBetween(A, right, 20);
    expect(c.p0.y).toBe(170);
    expect(c.p3.y).toBe(170);
  });

  it("a self-loop leaves and re-enters from the right side, sticking out", () => {
    const c = arrowBetween(A, A, 0, true);
    expect(c.p0.x).toBe(200);
    expect(c.p3.x).toBe(200);
    expect(c.p0.y).not.toBe(c.p3.y);
    expect(bezierBounds(c).width).toBeGreaterThan(30);
  });
});

describe("bezier", () => {
  const c = arrowBetween(A, right);

  it("bezierPoint respects the ends and the midpoint", () => {
    expect(bezierPoint(c, 0)).toEqual(c.p0);
    expect(bezierPoint(c, 1)).toEqual(c.p3);
    const m = bezierPoint(c, 0.5);
    expect(m.x).toBeCloseTo(300);
    expect(m.y).toBeCloseTo(150);
  });

  it("bezierBounds contains the curve", () => {
    const wavy = arrowBetween(A, { x: 400, y: 200, width: 200, height: 300 });
    const b = bezierBounds(wavy);
    for (let t = 0; t <= 1; t += 0.05) {
      const p = bezierPoint(wavy, t);
      expect(p.x).toBeGreaterThanOrEqual(b.x - 1e-9);
      expect(p.x).toBeLessThanOrEqual(b.x + b.width + 1e-9);
      expect(p.y).toBeGreaterThanOrEqual(b.y - 1e-9);
      expect(p.y).toBeLessThanOrEqual(b.y + b.height + 1e-9);
    }
  });

  it("distanceToBezier: 0 on the curve, grows moving away", () => {
    expect(distanceToBezier(c, 300, 150)).toBeLessThan(0.5);
    expect(distanceToBezier(c, 300, 160)).toBeCloseTo(10, 0);
    expect(distanceToBezier(c, 300, 300)).toBeGreaterThan(100);
  });

  it("distanceToSegment handles the degenerate segment", () => {
    expect(distanceToSegment({ x: 5, y: 5 }, { x: 5, y: 5 }, 8, 9)).toBe(5);
    expect(distanceToSegment({ x: 0, y: 0 }, { x: 10, y: 0 }, 5, 3)).toBe(3);
    // past the end it is measured from the end, not from the line
    expect(distanceToSegment({ x: 0, y: 0 }, { x: 10, y: 0 }, 13, 4)).toBe(5);
  });
});

describe("arrowhead", () => {
  it("the tip sits at p3 and points along the entry tangent", () => {
    const c = arrowBetween(A, right);
    const [tip, l, r] = arrowhead(c, 10);
    expect(tip).toEqual(c.p3);
    // the base is BEFORE the tip (to the left, the arrow goes to the right)
    expect(l.x).toBeLessThan(tip.x);
    expect(r.x).toBeLessThan(tip.x);
    // symmetric about the axis
    expect(l.y + r.y).toBeCloseTo(2 * tip.y);
  });

  it("with a null tangent it falls back to the chord (no NaN)", () => {
    const p = { x: 10, y: 10 };
    const [tip, l, r] = arrowhead({ p0: { x: 0, y: 10 }, c1: p, c2: p, p3: p }, 10);
    expect(tip).toEqual(p);
    for (const q of [l, r]) expect(Number.isFinite(q.x) && Number.isFinite(q.y)).toBe(true);
  });
});

describe("arrowFromRectToPoint", () => {
  it("is born from the side facing the pointer and ends on the pointer", () => {
    const c = arrowFromRectToPoint(A, { x: 500, y: 100 });
    expect(c.p0).toEqual(sidePoint(A, "right"));
    expect(c.p3).toEqual({ x: 500, y: 100 });
  });
});

describe("laneShift", () => {
  it("a single arrow sits at the center; several arrows distribute symmetrically", () => {
    expect(laneShift(0, 1)).toBe(0);
    expect(laneShift(0, 2)).toBe(-LANE_GAP / 2);
    expect(laneShift(1, 2)).toBe(LANE_GAP / 2);
    expect(laneShift(1, 3)).toBe(0);
  });
});

describe("rettangoli", () => {
  it("inflate and overlaps", () => {
    expect(inflate({ x: 0, y: 0, width: 10, height: 10 }, 5)).toEqual({ x: -5, y: -5, width: 20, height: 20 });
    expect(overlaps(A, right)).toBe(false);
    expect(overlaps(A, inflate(right, 250))).toBe(true);
    // touching counts as overlapping (culling is conservative)
    expect(overlaps(A, { x: 200, y: 0, width: 10, height: 10 })).toBe(true);
  });
});
