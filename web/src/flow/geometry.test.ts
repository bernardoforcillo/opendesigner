import { describe, it, expect } from "vitest";
import {
  arrowBetween, arrowFromRectToPoint, arrowhead, bezierBounds, bezierPoint, distanceToBezier,
  distanceToSegment, facingSide, inflate, laneShift, LANE_GAP, overlaps, sidePoint,
} from "./geometry";

const A = { x: 0, y: 0, width: 200, height: 300 };
const right = { x: 400, y: 0, width: 200, height: 300 };
const below = { x: 0, y: 500, width: 200, height: 300 };

describe("facingSide", () => {
  it("sceglie il lato rivolto verso l'altra schermata", () => {
    expect(facingSide(A, right)).toBe("right");
    expect(facingSide(right, A)).toBe("left");
    expect(facingSide(A, below)).toBe("bottom");
    expect(facingSide(below, A)).toBe("top");
  });

  it("normalizza sulle dimensioni: due frame alti affiancati restano right/left anche con scarto verticale", () => {
    const tall = { x: 0, y: 0, width: 100, height: 1000 };
    const next = { x: 200, y: 300, width: 100, height: 1000 };
    expect(facingSide(tall, next)).toBe("right");
  });
});

describe("arrowBetween", () => {
  it("parte dal punto medio del lato e arriva al punto medio del lato opposto", () => {
    const c = arrowBetween(A, right);
    expect(c.p0).toEqual({ x: 200, y: 150 });
    expect(c.p3).toEqual({ x: 400, y: 150 });
  });

  it("le tangenti sono perpendicolari ai lati (escono dritte dal bordo)", () => {
    const c = arrowBetween(A, right);
    // c1 sta alla destra di p0 sulla stessa riga, c2 alla sinistra di p3.
    expect(c.c1.y).toBe(c.p0.y);
    expect(c.c1.x).toBeGreaterThan(c.p0.x);
    expect(c.c2.y).toBe(c.p3.y);
    expect(c.c2.x).toBeLessThan(c.p3.x);
    const v = arrowBetween(A, below);
    expect(v.c1.x).toBe(v.p0.x);
    expect(v.c1.y).toBeGreaterThan(v.p0.y);
  });

  it("la corsia sposta entrambi gli estremi lungo il lato", () => {
    const c = arrowBetween(A, right, 20);
    expect(c.p0.y).toBe(170);
    expect(c.p3.y).toBe(170);
  });

  it("un auto-anello esce e rientra dal lato destro, sporgendo", () => {
    const c = arrowBetween(A, A, 0, true);
    expect(c.p0.x).toBe(200);
    expect(c.p3.x).toBe(200);
    expect(c.p0.y).not.toBe(c.p3.y);
    expect(bezierBounds(c).width).toBeGreaterThan(30);
  });
});

describe("bezier", () => {
  const c = arrowBetween(A, right);

  it("bezierPoint rispetta gli estremi e il punto medio", () => {
    expect(bezierPoint(c, 0)).toEqual(c.p0);
    expect(bezierPoint(c, 1)).toEqual(c.p3);
    const m = bezierPoint(c, 0.5);
    expect(m.x).toBeCloseTo(300);
    expect(m.y).toBeCloseTo(150);
  });

  it("bezierBounds contiene la curva", () => {
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

  it("distanceToBezier: 0 sulla curva, cresce allontanandosi", () => {
    expect(distanceToBezier(c, 300, 150)).toBeLessThan(0.5);
    expect(distanceToBezier(c, 300, 160)).toBeCloseTo(10, 0);
    expect(distanceToBezier(c, 300, 300)).toBeGreaterThan(100);
  });

  it("distanceToSegment gestisce il segmento degenere", () => {
    expect(distanceToSegment({ x: 5, y: 5 }, { x: 5, y: 5 }, 8, 9)).toBe(5);
    expect(distanceToSegment({ x: 0, y: 0 }, { x: 10, y: 0 }, 5, 3)).toBe(3);
    // oltre l'estremo si misura dall'estremo, non dalla retta
    expect(distanceToSegment({ x: 0, y: 0 }, { x: 10, y: 0 }, 13, 4)).toBe(5);
  });
});

describe("arrowhead", () => {
  it("la punta sta in p3 e guarda lungo la tangente d'ingresso", () => {
    const c = arrowBetween(A, right);
    const [tip, l, r] = arrowhead(c, 10);
    expect(tip).toEqual(c.p3);
    // la base sta PRIMA della punta (a sinistra, la freccia va verso destra)
    expect(l.x).toBeLessThan(tip.x);
    expect(r.x).toBeLessThan(tip.x);
    // simmetrica rispetto all'asse
    expect(l.y + r.y).toBeCloseTo(2 * tip.y);
  });

  it("con tangente nulla ripiega sulla corda (nessun NaN)", () => {
    const p = { x: 10, y: 10 };
    const [tip, l, r] = arrowhead({ p0: { x: 0, y: 10 }, c1: p, c2: p, p3: p }, 10);
    expect(tip).toEqual(p);
    for (const q of [l, r]) expect(Number.isFinite(q.x) && Number.isFinite(q.y)).toBe(true);
  });
});

describe("arrowFromRectToPoint", () => {
  it("nasce dal lato rivolto al puntatore e finisce sul puntatore", () => {
    const c = arrowFromRectToPoint(A, { x: 500, y: 100 });
    expect(c.p0).toEqual(sidePoint(A, "right"));
    expect(c.p3).toEqual({ x: 500, y: 100 });
  });
});

describe("laneShift", () => {
  it("una freccia sola sta al centro; più frecce si distribuiscono simmetriche", () => {
    expect(laneShift(0, 1)).toBe(0);
    expect(laneShift(0, 2)).toBe(-LANE_GAP / 2);
    expect(laneShift(1, 2)).toBe(LANE_GAP / 2);
    expect(laneShift(1, 3)).toBe(0);
  });
});

describe("rettangoli", () => {
  it("inflate e overlaps", () => {
    expect(inflate({ x: 0, y: 0, width: 10, height: 10 }, 5)).toEqual({ x: -5, y: -5, width: 20, height: 20 });
    expect(overlaps(A, right)).toBe(false);
    expect(overlaps(A, inflate(right, 250))).toBe(true);
    // a contatto conta come sovrapposto (il culling è conservativo)
    expect(overlaps(A, { x: 200, y: 0, width: 10, height: 10 })).toBe(true);
  });
});
