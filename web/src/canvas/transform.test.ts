import { describe, it, expect } from "vitest";
import {
  angleOf,
  centerOf,
  localToWorld,
  normalizeDegrees,
  rotateVector,
  rotatedAabb,
  rotatedCorners,
  snapDegrees,
  worldToLocal,
} from "./transform";

// Box di riferimento: 100x50 nell'origine, quindi CENTRO (50, 25) -- il solo
// punto attorno a cui questo modulo ruota (vedi il commento in transform.ts).
const box = { x: 0, y: 0, width: 100, height: 50 };
const c = { x: 50, y: 25 };

function expectPoint(p: { x: number; y: number }, x: number, y: number) {
  expect(p.x).toBeCloseTo(x, 9);
  expect(p.y).toBeCloseTo(y, 9);
}

describe("centerOf", () => {
  it("is the centre of the bounds, not its origin", () => {
    expect(centerOf(box)).toEqual(c);
    expect(centerOf({ x: 10, y: 20, width: 200, height: 100 })).toEqual({ x: 110, y: 70 });
  });
});

describe("localToWorld", () => {
  // Il caso che fissa il SEGNO della convenzione: assi mondo con y verso il
  // basso, quindi +90° porta l'asse +x sull'asse +y, che sullo schermo si legge
  // come una rotazione ORARIA.
  it("+90 degrees turns the east edge midpoint into the south edge midpoint (clockwise on screen)", () => {
    expectPoint(localToWorld({ x: 100, y: 25 }, c, 90), 50, 75);
  });

  it("+90 degrees turns the nw corner into the ne corner", () => {
    expectPoint(localToWorld({ x: 0, y: 0 }, c, 90), 75, -25);
  });

  it("180 degrees maps a corner onto the opposite one", () => {
    expectPoint(localToWorld({ x: 0, y: 0 }, c, 180), 100, 50);
  });

  it("leaves the centre itself where it is, at any angle", () => {
    expectPoint(localToWorld(c, c, 37), c.x, c.y);
  });
});

describe("worldToLocal", () => {
  // Il punto NOTO dell'andata, letto al contrario: (50,75) sul mondo è il punto
  // (100,25) dello spazio LOCALE del nodo ruotato di 90°. È esattamente la
  // trasformazione che l'hit-test applica al punto prima di testare la forma.
  it("maps a known world point back to its known local coordinate", () => {
    expectPoint(worldToLocal({ x: 50, y: 75 }, c, 90), 100, 25);
  });

  it("round-trips with localToWorld at an arbitrary angle", () => {
    const p = { x: 17, y: -3 };
    const w = localToWorld(p, c, 37);
    expectPoint(worldToLocal(w, c, 37), p.x, p.y);
    // e nell'altro verso
    const l = worldToLocal(p, c, -113.5);
    expectPoint(localToWorld(l, c, -113.5), p.x, p.y);
  });
});

describe("rotation of 0 (and full turns)", () => {
  // Non "quasi" identità: ESATTA. cos(0)=1 e sin(0)=0 sarebbero già esatti, ma
  // il resto della pipeline (resize, maniglie) confronta numeri interi -- una
  // moltiplicazione in più basterebbe a trasformare 110 in 110.00000000000001.
  it("returns the very same numbers, not merely close ones", () => {
    expect(localToWorld({ x: 3, y: 7 }, c, 0)).toEqual({ x: 3, y: 7 });
    expect(worldToLocal({ x: 3, y: 7 }, c, 0)).toEqual({ x: 3, y: 7 });
    expect(localToWorld({ x: 3, y: 7 }, c, 360)).toEqual({ x: 3, y: 7 });
    expect(rotateVector({ x: 110, y: -55 }, 0)).toEqual({ x: 110, y: -55 });
    expect(rotatedAabb(box, 0)).toEqual(box);
  });
});

describe("rotateVector", () => {
  it("rotates a direction without translating it (no centre involved)", () => {
    expectPoint(rotateVector({ x: 10, y: 0 }, 90), 0, 10);
    expectPoint(rotateVector({ x: 0, y: 10 }, 90), -10, 0);
    expectPoint(rotateVector({ x: 10, y: 0 }, -90), 0, -10);
  });
});

describe("rotatedCorners", () => {
  it("returns the 4 corners in nw, ne, se, sw order, rotated about the centre", () => {
    const [nw, ne, se, sw] = rotatedCorners(box, 90);
    expectPoint(nw, 75, -25);
    expectPoint(ne, 75, 75);
    expectPoint(se, 25, 75);
    expectPoint(sw, 25, -25);
  });
});

describe("rotatedAabb", () => {
  it("swaps the axes for a quarter turn, keeping the centre", () => {
    const a = rotatedAabb(box, 90);
    expect(a.x).toBeCloseTo(25, 9);
    expect(a.y).toBeCloseTo(-25, 9);
    expect(a.width).toBeCloseTo(50, 9);
    expect(a.height).toBeCloseTo(100, 9);
  });

  it("grows a square by sqrt(2) at 45 degrees", () => {
    const a = rotatedAabb({ x: 0, y: 0, width: 100, height: 100 }, 45);
    expect(a.width).toBeCloseTo(100 * Math.SQRT2, 9);
    expect(a.height).toBeCloseTo(100 * Math.SQRT2, 9);
  });
});

describe("normalizeDegrees", () => {
  it("brings any angle into [0, 360)", () => {
    expect(normalizeDegrees(-90)).toBeCloseTo(270, 9);
    expect(normalizeDegrees(450)).toBeCloseTo(90, 9);
    expect(normalizeDegrees(360)).toBeCloseTo(0, 9);
    expect(normalizeDegrees(-720.5)).toBeCloseTo(359.5, 9);
    expect(normalizeDegrees(12)).toBe(12);
  });
});

describe("snapDegrees", () => {
  it("rounds to the nearest multiple of the step (15 degrees with shift held)", () => {
    expect(snapDegrees(7, 15)).toBeCloseTo(0, 9);
    expect(snapDegrees(8, 15)).toBeCloseTo(15, 9);
    expect(snapDegrees(22, 15)).toBeCloseTo(15, 9);
    expect(snapDegrees(23, 15)).toBeCloseTo(30, 9);
    expect(snapDegrees(-8, 15)).toBeCloseTo(-15, 9);
    expect(snapDegrees(359, 15)).toBeCloseTo(360, 9);
  });
});

describe("angleOf", () => {
  // Stessa convenzione oraria di localToWorld: da un centro, il punto a destra
  // è 0°, quello SOTTO è +90°.
  it("measures the clockwise angle from the +x axis", () => {
    expect(angleOf(c, { x: 60, y: 25 })).toBeCloseTo(0, 9);
    expect(angleOf(c, { x: 50, y: 35 })).toBeCloseTo(90, 9);
    expect(angleOf(c, { x: 40, y: 25 })).toBeCloseTo(180, 9);
    expect(angleOf(c, { x: 50, y: 15 })).toBeCloseTo(-90, 9);
  });

  it("is the inverse of localToWorld on a known radius", () => {
    // Il punto a est del centro, ruotato di 30°, si rilegge a 30°.
    const p = localToWorld({ x: 100, y: 25 }, c, 30);
    expect(angleOf(c, p)).toBeCloseTo(30, 9);
  });
});
