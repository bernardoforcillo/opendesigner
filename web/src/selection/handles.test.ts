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
  ROTATE_CURSOR,
  cursorForFrameHit,
  handleScreenPoints,
  hitTestFrame,
  resizeRotatedBounds,
  applyFrameResize,
  applyFrameResizeToNode,
  resizeFrame,
  rotateMarkerPositions,
  ROTATE_MARKER_OFFSET,
  ROTATE_MARKER_RADIUS,
  CORNER_IDS,
} from "./handles";
import { rotatedAabb } from "../canvas/transform";
import { unionBounds } from "../canvas/geometry";

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

// --- rotazione ---------------------------------------------------------------
// Un FRAME è il bbox della selezione PIÙ la sua rotazione (gradi, orari,
// attorno al centro -- vedi canvas/transform.ts). Le maniglie vivono nello
// spazio LOCALE del frame: disegnarle e colpirle vuol dire ruotarle con lui.

function expectPoint(p: { x: number; y: number }, x: number, y: number) {
  expect(p.x).toBeCloseTo(x, 9);
  expect(p.y).toBeCloseTo(y, 9);
}

function expectBounds(b: { x: number; y: number; width: number; height: number }, x: number, y: number, w: number, h: number) {
  expect(b.x).toBeCloseTo(x, 9);
  expect(b.y).toBeCloseTo(y, 9);
  expect(b.width).toBeCloseTo(w, 9);
  expect(b.height).toBeCloseTo(h, 9);
}

// 100x50 nell'origine: centro (50, 25). Con camera identità le coordinate
// schermo coincidono con quelle mondo.
const small = { x: 0, y: 0, width: 100, height: 50 };

describe("handleScreenPoints", () => {
  it("is the plain handle grid when the frame is not rotated", () => {
    const p = handleScreenPoints({ bounds: small, rotation: 0 }, cam);
    expect(p.nw).toEqual({ x: 0, y: 0 });
    expect(p.e).toEqual({ x: 100, y: 25 });
    expect(p.s).toEqual({ x: 50, y: 50 });
  });

  it("carries the handles around with the frame: at +90 the east handle is due SOUTH", () => {
    const p = handleScreenPoints({ bounds: small, rotation: 90 }, cam);
    expectPoint(p.e, 50, 75);
    expectPoint(p.nw, 75, -25);
    expectPoint(p.se, 25, 75);
  });

  it("still scales and offsets with the camera", () => {
    const p = handleScreenPoints({ bounds: small, rotation: 90 }, { x: 10, y: 20, zoom: 2 });
    expectPoint(p.e, 10 + 50 * 2, 20 + 75 * 2);
  });
});

describe("hitTestFrame", () => {
  it("finds the resize handles of an unrotated frame exactly like hitTestHandle", () => {
    const f = { bounds: b, rotation: 0 };
    expect(hitTestFrame(f, cam, 100, 100)).toEqual({ kind: "resize", handle: "nw" });
    expect(hitTestFrame(f, cam, 300, 150)).toEqual({ kind: "resize", handle: "e" });
    expect(hitTestFrame(f, cam, 200, 150)).toBeNull(); // ben dentro il box
  });

  it("finds the resize handles WHERE THE ROTATION PUT THEM, not where the bbox says", () => {
    const f = { bounds: small, rotation: 90 };
    expect(hitTestFrame(f, cam, 50, 75)).toEqual({ kind: "resize", handle: "e" });
    // dove la maniglia e stava da fermo ora non c'è più niente
    expect(hitTestFrame(f, cam, 100, 25)).toBeNull();
  });

  it("gives the corner a rotate zone JUST OUTSIDE it", () => {
    const f = { bounds: b, rotation: 0 }; // se a (300, 200)
    expect(hitTestFrame(f, cam, 308, 208)).toEqual({ kind: "rotate", corner: "se" });
    expect(hitTestFrame(f, cam, 92, 92)).toEqual({ kind: "rotate", corner: "nw" });
    expect(hitTestFrame(f, cam, 308, 92)).toEqual({ kind: "rotate", corner: "ne" });
    expect(hitTestFrame(f, cam, 92, 208)).toEqual({ kind: "rotate", corner: "sw" });
  });

  it("the resize handle wins on the corner itself", () => {
    expect(hitTestFrame({ bounds: b, rotation: 0 }, cam, 300, 200))
      .toEqual({ kind: "resize", handle: "se" });
  });

  it("never steals a click from INSIDE the shape, however near the corner", () => {
    // 10px dentro il box in diagonale: fuori dall'area di presa del resize, ma
    // dentro il riquadro -- deve restare un click sul nodo, non una rotazione.
    expect(hitTestFrame({ bounds: b, rotation: 0 }, cam, 290, 190)).toBeNull();
  });

  it("stops well before the empty canvas", () => {
    expect(hitTestFrame({ bounds: b, rotation: 0 }, cam, 330, 230)).toBeNull();
  });

  it("carries the rotate zone around with the frame too", () => {
    // Frame ruotato di 90°: l'angolo se (locale (100,50)) sta a (25, 75), e la
    // sua diagonale uscente punta in (-1, +1) invece che in (+1, +1).
    const f = { bounds: small, rotation: 90 };
    expect(hitTestFrame(f, cam, 25 - 8, 75 + 8)).toEqual({ kind: "rotate", corner: "se" });
    // nella direzione in cui la diagonale puntava da fermo non c'è più niente
    expect(hitTestFrame(f, cam, 25 + 12, 75 + 12)).toBeNull();
  });

  it("keeps both zones constant in SCREEN px at any zoom", () => {
    const zoomed = { x: 0, y: 0, zoom: 4 };
    const f = { bounds: b, rotation: 0 }; // se schermo a (1200, 800)
    expect(hitTestFrame(f, zoomed, 1200, 800)).toEqual({ kind: "resize", handle: "se" });
    expect(hitTestFrame(f, zoomed, 1208, 808)).toEqual({ kind: "rotate", corner: "se" });
    expect(hitTestFrame(f, zoomed, 1230, 830)).toBeNull();
  });
});

describe("cursorForFrameHit", () => {
  it("keeps the resize cursors and gives rotation one of its own", () => {
    expect(cursorForFrameHit({ kind: "resize", handle: "nw" })).toBe(cursorForHandle("nw"));
    expect(cursorForFrameHit({ kind: "rotate", corner: "nw" })).toBe(ROTATE_CURSOR);
  });
});

describe("resizeRotatedBounds", () => {
  it("is resizeBounds, number for number, when the rotation is zero", () => {
    for (const h of HANDLE_IDS) {
      expect(resizeRotatedBounds(b, 0, h, 37, -11)).toEqual(resizeBounds(b, h, 37, -11));
      expect(resizeRotatedBounds(b, 0, h, 37, -11, { keepAspect: true }))
        .toEqual(resizeBounds(b, h, 37, -11, { keepAspect: true }));
    }
  });

  it("widens a 90-degree node along its OWN axis: the drag that counts is the one down the screen", () => {
    // Maniglia e su un nodo ruotato di 90°: il suo asse x locale punta in giù
    // sullo schermo, quindi è un trascinamento VERTICALE ad allargarlo.
    expectBounds(resizeRotatedBounds(small, 90, "e", 0, 30), -15, 15, 130, 50);
  });

  it("ignores the component of the drag across that axis", () => {
    // Stesso nodo, trascinamento ORIZZONTALE: sull'asse locale della maniglia e
    // non c'è nessuno spostamento, quindi la larghezza non cambia.
    const r = resizeRotatedBounds(small, 90, "e", 30, 0);
    expect(r.width).toBeCloseTo(100, 9);
    expect(r.height).toBeCloseTo(50, 9);
  });

  it("keeps the anchored edge nailed where it is IN THE WORLD", () => {
    // L'ancora della maniglia e è il lato ovest: in coordinate mondo, per un
    // nodo a 90°, il punto (50, -25). Il resize non deve muoverlo.
    const before = { x: 50, y: -25 };
    const after = resizeRotatedBounds(small, 90, "e", 0, 30);
    // punto medio del lato ovest del nuovo box, riportato nel mondo
    const c = { x: after.x + after.width / 2, y: after.y + after.height / 2 };
    const dx = after.x - c.x;
    const dy = after.y + after.height / 2 - c.y;
    // rotazione di +90 di (dx, dy) attorno a c: (x,y) -> (-y, x)
    expectPoint({ x: c.x - dy, y: c.y + dx }, before.x, before.y);
  });

  it("still flips and still keeps the aspect ratio once rotated", () => {
    const flipped = resizeRotatedBounds(small, 90, "w", 0, 300); // oltre l'ancora
    expect(flipped.width).toBeGreaterThan(0);
    expect(flipped.height).toBeGreaterThan(0);
    const kept = resizeRotatedBounds(small, 90, "se", 0, 100, { keepAspect: true });
    expect(kept.width / kept.height).toBeCloseTo(small.width / small.height, 9);
  });
});

// La maniglia di rotazione DISEGNATA. Prima non si disegnava affatto: l'unica
// affordance era il cursore su un anello invisibile, cioè nessuna affordance.
describe("rotateMarkerPositions", () => {
  const box = { x: 0, y: 0, width: 100, height: 50 };

  it("puts one marker outside each corner, along its outgoing diagonal", () => {
    const m = rotateMarkerPositions(box);
    const d = ROTATE_MARKER_OFFSET;
    expect(m.nw).toEqual({ x: -d, y: -d });
    expect(m.ne).toEqual({ x: 100 + d, y: -d });
    expect(m.se).toEqual({ x: 100 + d, y: 50 + d });
    expect(m.sw).toEqual({ x: -d, y: 50 + d });
    expect(Object.keys(m)).toHaveLength(4);
  });

  // L'invariante che tiene insieme il disegno e l'hit-test: se un giorno una
  // delle costanti cambia, è QUI che si rompe -- non in mano all'utente, che
  // vedrebbe un segno che, cliccato, ridimensiona o non fa niente.
  it("draws only where it grabs: every pixel of every marker is that corner's rotate zone", () => {
    const f = { bounds: b, rotation: 0 };
    const m = rotateMarkerPositions(b); // camera identità: schermo === mondo
    for (const id of CORNER_IDS) {
      expect(hitTestFrame(f, cam, m[id].x, m[id].y)).toEqual({ kind: "rotate", corner: id });
      for (let k = 0; k < 16; k++) {
        const a = (k * Math.PI) / 8;
        const x = m[id].x + Math.cos(a) * ROTATE_MARKER_RADIUS;
        const y = m[id].y + Math.sin(a) * ROTATE_MARKER_RADIUS;
        expect(hitTestFrame(f, cam, x, y)).toEqual({ kind: "rotate", corner: id });
      }
    }
  });
});

// Il resize di una selezione MULTIPLA che contiene un nodo RUOTATO. Il riquadro
// di gruppo è asse-allineato (vedi overlayRenderer::selectionFrame): la scala
// vale lungo gli assi dello SCHERMO, e un membro girato va mappato per assi,
// non scalando il suo box locale.
describe("applyFrameResizeToNode", () => {
  it("is applyFrameResize, number for number, when the node is aligned with the frame", () => {
    const f = { bounds: b, rotation: 0 };
    for (const h of HANDLE_IDS) {
      const r = resizeFrame(f, h, 37, -11);
      const node = { x: 120, y: 110, width: 40, height: 20 };
      expect(applyFrameResizeToNode(node, 0, r)).toEqual({ bounds: applyFrameResize(node, r), rotation: 0 });
    }
  });

  // Il caso della review, numero per numero. Gruppo = A (0,0,100,50) a 90° +
  // B (200,0,50,50): il riquadro sta su x [25,250], y [-25,75]. Si tira la
  // maniglia e di +225 (scala x2 in orizzontale, 1 in verticale).
  it("grows a 90-degree member along the axis the pointer is really dragging", () => {
    const group = { x: 25, y: -25, width: 225, height: 100 };
    const r = resizeFrame({ bounds: group, rotation: 0 }, "e", 225, 0);
    const out = applyFrameResizeToNode({ x: 0, y: 0, width: 100, height: 50 }, 90, r);

    // il box del modello: 100x50 diventa 100x100 (la larghezza segue l'asse
    // VERTICALE dello schermo, che il drag non ha toccato; l'altezza segue
    // quello orizzontale, raddoppiato)
    expectBounds(out.bounds, 25, -25, 100, 100);
    expect(out.rotation).toBeCloseTo(90, 9);
  });

  it("keeps that member INSIDE the resized group frame (it used to overflow it)", () => {
    const group = { x: 25, y: -25, width: 225, height: 100 };
    const r = resizeFrame({ bounds: group, rotation: 0 }, "e", 225, 0);
    const after = transformBounds(group, r.transform);
    const out = applyFrameResizeToNode({ x: 0, y: 0, width: 100, height: 50 }, 90, r);
    const aabb = rotatedAabb(out.bounds, out.rotation);

    expect(aabb.x).toBeGreaterThanOrEqual(after.x - 1e-9);
    expect(aabb.y).toBeGreaterThanOrEqual(after.y - 1e-9);
    expect(aabb.x + aabb.width).toBeLessThanOrEqual(after.x + after.width + 1e-9);
    expect(aabb.y + aabb.height).toBeLessThanOrEqual(after.y + after.height + 1e-9);

    // e quello che occupa DAVVERO è cresciuto in orizzontale, non in verticale:
    // 50x100 -> 100x100 (prima diventava 50 largo e 200 alto)
    expect(aabb.width).toBeCloseTo(100, 9);
    expect(aabb.height).toBeCloseTo(100, 9);
  });

  // 90° è il caso FACILE: gli assi si scambiano e il rettangolo mappato cade
  // esattamente sull'AABB scalato, quindi il contenimento veniva da sé. A 45°
  // no, ed è lì che il giro 1 usciva ancora dal riquadro. Il caso della review,
  // numero per numero: 100x50 a 45° (AABB 106.07x106.07) + un vicino dritto,
  // maniglia e, kx=2, ky=1 (l'altezza del riquadro NON viene mai trascinata).
  const at45 = () => {
    const node = { x: 0, y: 0, width: 100, height: 50 };
    const group = unionBounds([rotatedAabb(node, 45), { x: 200, y: 0, width: 50, height: 50 }])!;
    const r = resizeFrame({ bounds: group, rotation: 0 }, "e", group.width, 0);
    return { node, group, r, after: transformBounds(group, r.transform) };
  };

  it("keeps a 45-degree member inside the frame under a NON-uniform scale", () => {
    const { node, r, after } = at45();
    const out = applyFrameResizeToNode(node, 45, r);
    const aabb = rotatedAabb(out.bounds, out.rotation);

    expect(aabb.x).toBeGreaterThanOrEqual(after.x - 1e-9);
    expect(aabb.y).toBeGreaterThanOrEqual(after.y - 1e-9);
    expect(aabb.x + aabb.width).toBeLessThanOrEqual(after.x + after.width + 1e-9);
    expect(aabb.y + aabb.height).toBeLessThanOrEqual(after.y + after.height + 1e-9);

    // Il vincolo VERO, quello che il giro 1 rompeva: la maniglia e non ha
    // toccato l'altezza del riquadro, quindi non deve toccare nemmeno quella
    // del membro. Prima: 141.42 dentro un riquadro alto 106.07 (+33%).
    expect(aabb.height).toBeCloseTo(rotatedAabb(node, 45).height, 9);
    expect(aabb.height).toBeCloseTo(after.height, 9);
  });

  // Il PREZZO del contenimento, messo nero su bianco: il membro riempie MENO
  // del suo posto lungo l'asse trascinato. Se un giorno si trova di meglio,
  // questi numeri devono cambiare a mano -- non in silenzio.
  it("pins what a 45-degree member becomes: contained, and under-filling the dragged axis", () => {
    const { node, r } = at45();
    const out = applyFrameResizeToNode(node, 45, r);

    // gli ASSI restano quelli mappati (26.565° = atan(1/2)): cambiano solo le
    // lunghezze, ridotte del fattore 0.75 che rimette l'AABB nel suo posto
    expect(out.rotation).toBeCloseTo(26.56505117707799, 9);
    expect(out.bounds.width).toBeCloseTo(158.11388300841898 * 0.75, 9);
    expect(out.bounds.height).toBeCloseTo(79.05694150420948 * 0.75, 9);

    const aabb = rotatedAabb(out.bounds, out.rotation);
    // il posto riservato è largo 212.13: ne occupa 132.58, e li tocca in alto
    // e in basso (dove il posto è 106.07)
    expect(aabb.width).toBeCloseTo(132.58252147247765, 9);
    expect(aabb.height).toBeCloseTo(106.06601717798212, 9);
    // il centro resta quello mappato dalla trasformazione di gruppo, intatto
    expect(aabb.x + aabb.width / 2).toBeCloseTo(103.03300858899107, 9);
    expect(aabb.y + aabb.height / 2).toBeCloseTo(25, 9);
  });

  // L'invariante, non un caso fortunato: QUALUNQUE angolo, QUALUNQUE scala
  // (ribaltamenti compresi). Un membro che parte dentro il riquadro ci resta.
  it("never lets a member escape the frame, at any angle and any scale", () => {
    // Il riquadro è ESATTAMENTE l'AABB del nodo (il membro che tocca tutti e
    // quattro i bordi del gruppo -- il caso più stretto, e l'unico che
    // distingue davvero: un nodo piccolo al centro resta dentro anche quando la
    // mappa sbaglia).
    const node = { x: 0, y: 0, width: 100, height: 50 };
    for (let deg = 0; deg < 360; deg += 5) {
      const group = rotatedAabb(node, deg);
      // Frazioni del lato, non px: il riquadro cambia misura a ogni angolo, e
      // un delta fisso finirebbe per posare un bordo ESATTAMENTE sull'ancora
      // (scala 0, cioè un nodo schiacciato per davvero e non per colpa della
      // mappa). Con la maniglia se: kx = 1 + fx, ky = 1 + fy.
      for (const [fx, fy] of [
        [1, 0], [0, 1], [3, -0.5], [-0.5, 3], [-2.5, 0], [0, -2.5], [-2.5, -4], [0.5, 0.5],
      ]) {
        const r = resizeFrame({ bounds: group, rotation: 0 }, "se", fx * group.width, fy * group.height);
        const after = transformBounds(group, r.transform);
        const out = applyFrameResizeToNode(node, deg, r);
        const aabb = rotatedAabb(out.bounds, out.rotation);
        const where = `deg=${deg} k=(${1 + fx},${1 + fy})`;
        expect(aabb.x, where).toBeGreaterThanOrEqual(after.x - 1e-6);
        expect(aabb.y, where).toBeGreaterThanOrEqual(after.y - 1e-6);
        expect(aabb.x + aabb.width, where).toBeLessThanOrEqual(after.x + after.width + 1e-6);
        expect(aabb.y + aabb.height, where).toBeLessThanOrEqual(after.y + after.height + 1e-6);
        // e non si annulla: contenere non vuol dire sparire
        expect(out.bounds.width, where).toBeGreaterThan(0);
        expect(out.bounds.height, where).toBeGreaterThan(0);
      }
    }
  });

  it("leaves the angle alone (exactly) under a uniform scale", () => {
    const group = { x: 0, y: 0, width: 100, height: 100 };
    const r = resizeFrame({ bounds: group, rotation: 0 }, "se", 100, 100, { keepAspect: true });
    const out = applyFrameResizeToNode({ x: 0, y: 0, width: 40, height: 20 }, 30, r);

    expect(out.rotation).toBe(30); // non 29.999999999999996
    expectBounds(out.bounds, 0, 0, 80, 40);
  });

  it("MIRRORS the angle when the group flips: 30 degrees becomes 150", () => {
    const group = { x: 0, y: 0, width: 100, height: 100 };
    // maniglia e trascinata 200px a sinistra: supera l'ancora (x=0) e ribalta
    const r = resizeFrame({ bounds: group, rotation: 0 }, "e", -200, 0);
    const out = applyFrameResizeToNode({ x: 0, y: 0, width: 40, height: 20 }, 30, r);

    expect(out.rotation).toBeCloseTo(150, 9);
    // uno specchio non deforma: le misure restano quelle
    expect(out.bounds.width).toBeCloseTo(40, 9);
    expect(out.bounds.height).toBeCloseTo(20, 9);
    // e il centro passa dall'altra parte dell'ancora
    expect(out.bounds.x + out.bounds.width / 2).toBeCloseTo(-20, 9);
  });

  it("swaps the axes at 90 degrees whichever handle is dragged", () => {
    const group = { x: 0, y: 0, width: 100, height: 100 };
    const r = resizeFrame({ bounds: group, rotation: 0 }, "s", 0, 100); // scala y x2
    const out = applyFrameResizeToNode({ x: 0, y: 0, width: 40, height: 20 }, 90, r);
    // a 90° l'asse x locale punta lungo lo schermo IN GIÙ: è la larghezza a
    // raddoppiare, non l'altezza
    expect(out.bounds.width).toBeCloseTo(80, 9);
    expect(out.bounds.height).toBeCloseTo(20, 9);
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
