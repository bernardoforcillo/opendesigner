import { describe, it, expect } from "vitest";
import {
  resizeBounds,
  hitTestHandle,
  handleScreenRects,
  cursorForHandle,
  resizeTransform,
  transformBounds,
  HANDLE_SIZE,
  HANDLE_IDS,
} from "./handles";

const b = { x: 100, y: 100, width: 200, height: 100 };
const cam = { x: 0, y: 0, zoom: 1 };

describe("resizeBounds", () => {
  it("se grows width and height", () => {
    expect(resizeBounds(b, "se", 50, 25)).toEqual({ x: 100, y: 100, width: 250, height: 125 });
  });
  it("nw moves the origin and shrinks", () => {
    expect(resizeBounds(b, "nw", 20, 10)).toEqual({ x: 120, y: 110, width: 180, height: 90 });
  });
  it("edge handles touch one axis only", () => {
    expect(resizeBounds(b, "e", 30, 999)).toEqual({ x: 100, y: 100, width: 230, height: 100 });
    expect(resizeBounds(b, "n", 999, -10)).toEqual({ x: 100, y: 90, width: 200, height: 110 });
  });
  it("flips instead of producing a negative size", () => {
    // trascino la maniglia sinistra 250px a destra: supera il bordo destro (x=300)
    const r = resizeBounds(b, "w", 250, 0);
    expect(r.width).toBeGreaterThan(0);
    expect(r.x).toBeCloseTo(300, 6);
    expect(r.width).toBeCloseTo(50, 6);
  });
  it("keepAspect preserves the original ratio on corner handles", () => {
    const r = resizeBounds(b, "se", 100, 0, { keepAspect: true });
    expect(r.width / r.height).toBeCloseTo(b.width / b.height, 6);
  });
});

describe("hitTestHandle", () => {
  it("finds the corner handle near the corner", () => {
    expect(hitTestHandle(b, cam, 100, 100)).toBe("nw");
    expect(hitTestHandle(b, cam, 300, 200)).toBe("se");
  });
  it("returns null well inside the box", () => {
    expect(hitTestHandle(b, cam, 200, 150)).toBeNull();
  });
  it("keeps a constant screen-space grab area when zoomed", () => {
    const zoomed = { x: 0, y: 0, zoom: 4 };
    // la maniglia nw resta afferrabile entro ~HANDLE_SIZE px SCHERMO dall'angolo
    expect(hitTestHandle(b, zoomed, 400 + 3, 400 + 3)).toBe("nw");
  });
});

// --- copertura aggiuntiva oltre il minimo del brief ---------------------------

describe("resizeBounds, altri casi", () => {
  it("flips vertically too (n dragged past the bottom edge)", () => {
    const r = resizeBounds(b, "n", 0, 150); // top 100 -> 250, bottom fermo a 200
    expect(r).toEqual({ x: 100, y: 200, width: 200, height: 50 });
  });
  it("flips on both axes at once (nw dragged past the se corner)", () => {
    const r = resizeBounds(b, "nw", 250, 150);
    expect(r).toEqual({ x: 300, y: 200, width: 50, height: 50 });
  });
  it("a zero-delta drag leaves the bounds untouched, on every handle", () => {
    for (const h of HANDLE_IDS) expect(resizeBounds(b, h, 0, 0)).toEqual(b);
  });
  it("keepAspect on an edge handle scales the perpendicular axis too", () => {
    const r = resizeBounds(b, "e", 100, 0, { keepAspect: true });
    expect(r.width).toBeCloseTo(300, 6);
    expect(r.height).toBeCloseTo(150, 6);
    // il lato ancorato (sinistro/alto) non si muove
    expect(r.x).toBeCloseTo(100, 6);
    expect(r.y).toBeCloseTo(100, 6);
  });
  it("keepAspect on a corner SHRINKS when the drag goes inward", () => {
    // se trascinata 50px verso l'interno: senza keepAspect darebbe width 150.
    // Con keepAspect deve rimpicciolire in proporzione, NON restare ferma:
    // con la regola del max(|scale|) vinceva l'1.0 dell'asse y immobile.
    const r = resizeBounds(b, "se", -50, 0, { keepAspect: true });
    expect(r).toEqual({ x: 100, y: 100, width: 150, height: 75 });
  });
  it("keepAspect on a corner: the axis dragged MORE commands, also shrinking", () => {
    // dx porta x a scala 0.5, dy porta y a scala 0.9: comanda lo 0.5.
    const r = resizeBounds(b, "se", -100, -10, { keepAspect: true });
    expect(r).toEqual({ x: 100, y: 100, width: 100, height: 50 });
  });
  it("keepAspect on a corner: a shrink beats a smaller growth on the other axis", () => {
    // x cresce del 10% (scala 1.1), y si dimezza (scala 0.5): comanda y.
    const r = resizeBounds(b, "se", 20, -50, { keepAspect: true });
    expect(r).toEqual({ x: 100, y: 100, width: 100, height: 50 });
  });
  it("keepAspect on the nw corner shrinks toward the anchored se corner", () => {
    const r = resizeBounds(b, "nw", 50, 0, { keepAspect: true });
    expect(r).toEqual({ x: 150, y: 125, width: 150, height: 75 });
  });
  it("keepAspect on a corner still grows by the more-dragged axis", () => {
    const r = resizeBounds(b, "se", 100, 0, { keepAspect: true });
    expect(r).toEqual({ x: 100, y: 100, width: 300, height: 150 });
  });
  it("keepAspect keeps the ratio through a flip", () => {
    const r = resizeBounds(b, "se", -300, 0, { keepAspect: true });
    expect(r.width / r.height).toBeCloseTo(b.width / b.height, 6);
    expect(r.width).toBeGreaterThan(0);
    expect(r.height).toBeGreaterThan(0);
  });
  it("degenerate bounds do not produce NaN (no division by zero)", () => {
    const flat = { x: 0, y: 0, width: 0, height: 50 };
    const r = resizeBounds(flat, "se", 10, 10, { keepAspect: true });
    expect(Number.isFinite(r.x)).toBe(true);
    expect(Number.isFinite(r.y)).toBe(true);
    expect(Number.isFinite(r.width)).toBe(true);
    expect(Number.isFinite(r.height)).toBe(true);
  });
});

describe("resizeTransform / transformBounds", () => {
  it("scales a sub-box relative to the group box (multi-selection resize)", () => {
    const group = { x: 0, y: 0, width: 100, height: 100 };
    const t = resizeTransform(group, "se", 100, 100); // raddoppia
    expect(transformBounds(group, t)).toEqual({ x: 0, y: 0, width: 200, height: 200 });
    expect(transformBounds({ x: 50, y: 50, width: 50, height: 50 }, t))
      .toEqual({ x: 100, y: 100, width: 100, height: 100 });
  });
  it("mirrors sub-boxes when the group flips", () => {
    const group = { x: 0, y: 0, width: 100, height: 100 };
    const t = resizeTransform(group, "w", 200, 0); // il lato sinistro supera il destro
    // il figlio che stava a sinistra finisce a destra dell'ancora (x=100)
    expect(transformBounds({ x: 0, y: 0, width: 20, height: 100 }, t))
      .toEqual({ x: 180, y: 0, width: 20, height: 100 });
  });
});

describe("handleScreenRects", () => {
  it("returns 8 HANDLE_SIZE squares centred on the screen-space bbox", () => {
    const rects = handleScreenRects(b, cam);
    expect(Object.keys(rects)).toHaveLength(8);
    expect(rects.nw).toEqual({ x: 100 - HANDLE_SIZE / 2, y: 100 - HANDLE_SIZE / 2, width: HANDLE_SIZE, height: HANDLE_SIZE });
    expect(rects.se).toEqual({ x: 300 - HANDLE_SIZE / 2, y: 200 - HANDLE_SIZE / 2, width: HANDLE_SIZE, height: HANDLE_SIZE });
    expect(rects.e).toEqual({ x: 300 - HANDLE_SIZE / 2, y: 150 - HANDLE_SIZE / 2, width: HANDLE_SIZE, height: HANDLE_SIZE });
  });

  it("keeps the squares the same SCREEN size at any zoom (only their position moves)", () => {
    const zoomed = handleScreenRects(b, { x: 0, y: 0, zoom: 4 });
    expect(zoomed.nw).toEqual({ x: 400 - HANDLE_SIZE / 2, y: 400 - HANDLE_SIZE / 2, width: HANDLE_SIZE, height: HANDLE_SIZE });
    expect(zoomed.se.width).toBe(HANDLE_SIZE);
  });
});

describe("hitTestHandle, altri casi", () => {
  it("prefers a corner over an edge handle when both grab areas overlap (tiny box)", () => {
    const tiny = { x: 0, y: 0, width: 2, height: 2 };
    expect(hitTestHandle(tiny, cam, 0, 0)).toBe("nw");
  });
  it("finds the edge handles at the midpoints of the sides", () => {
    expect(hitTestHandle(b, cam, 200, 100)).toBe("n");
    expect(hitTestHandle(b, cam, 300, 150)).toBe("e");
    expect(hitTestHandle(b, cam, 200, 200)).toBe("s");
    expect(hitTestHandle(b, cam, 100, 150)).toBe("w");
  });
  it("returns null far outside the box", () => {
    expect(hitTestHandle(b, cam, 1000, 1000)).toBeNull();
  });
  it("accounts for the camera offset", () => {
    const panned = { x: 50, y: 20, zoom: 1 };
    expect(hitTestHandle(b, panned, 150, 120)).toBe("nw");
    expect(hitTestHandle(b, panned, 100, 100)).toBeNull();
  });
});

describe("cursorForHandle", () => {
  it("maps opposite handles to the same diagonal/axial cursor", () => {
    expect(cursorForHandle("nw")).toBe(cursorForHandle("se"));
    expect(cursorForHandle("ne")).toBe(cursorForHandle("sw"));
    expect(cursorForHandle("n")).toBe(cursorForHandle("s"));
    expect(cursorForHandle("e")).toBe(cursorForHandle("w"));
    expect(cursorForHandle("nw")).toBe("nwse-resize");
    expect(cursorForHandle("ne")).toBe("nesw-resize");
    expect(cursorForHandle("n")).toBe("ns-resize");
    expect(cursorForHandle("e")).toBe("ew-resize");
  });
});
