import { describe, it, expect } from "vitest";
import {
  IDENTITY,
  angleOf,
  applyTransform,
  centerOf,
  compose,
  invertTransform,
  localToWorld,
  mapBounds,
  mapVector,
  normalizeDegrees,
  rotateVector,
  rotatedAabb,
  rotatedCorners,
  snapDegrees,
  translation,
  worldBoundsOfNode,
  worldToLocal,
  worldTransformOf,
} from "./transform";
import { emptyScene } from "../store/types";
import type { NodeLite, SceneState } from "../store/types";

// Box di riferimento: 100x50 nell'origine, quindi CENTRO (50, 25) -- il solo
// punto attorno a cui questo modulo ruota (vedi il commento in transform.ts).
const box = { x: 0, y: 0, width: 100, height: 50 };
const c = { x: 50, y: 25 };

function expectPoint(p: { x: number; y: number }, x: number, y: number) {
  expect(p.x).toBeCloseTo(x, 9);
  expect(p.y).toBeCloseTo(y, 9);
}

function node(id: string, parentId: string, x: number, y: number, w = 50, h = 50): NodeLite {
  return {
    id, parentId, orderKey: "a0", name: id, visible: true, opacity: 1,
    x, y, width: w, height: h, rotation: 0, fills: [], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false,
  };
}

// page1 > a(100,50) > b(10,20) > c(3,4): tre livelli di annidamento, ognuno
// con uno scostamento diverso da zero su entrambi gli assi, così un errore di
// segno o un livello saltato si vede subito nel numero.
function nested(): SceneState {
  const s = emptyScene("d", "n");
  s.nodes["a"] = node("a", "page1", 100, 50);
  s.nodes["b"] = node("b", "a", 10, 20);
  s.nodes["c"] = node("c", "b", 3, 4);
  return s;
}

describe("centerOf", () => {
  it("is the centre of the bounds, not its origin", () => {
    expect(centerOf(box)).toEqual(c);
    expect(centerOf({ x: 10, y: 20, width: 200, height: 100 })).toEqual({ x: 110, y: 70 });
  });
});

describe("localToWorld (rotation)", () => {
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

describe("worldToLocal (rotation)", () => {
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

describe("affine transforms", () => {
  it("IDENTITY leaves a point where it is", () => {
    expect(applyTransform(IDENTITY, 7, -3)).toEqual({ x: 7, y: -3 });
  });

  it("compose applies the INNER transform first", () => {
    // Con due sole traslazioni l'ordine non si vedrebbe (sono commutative):
    // serve una scala per distinguere le due direzioni.
    const scale2 = { a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 };
    const move10 = translation(10, 0);
    expect(applyTransform(compose(scale2, move10), 1, 0)).toEqual({ x: 22, y: 0 });
    expect(applyTransform(compose(move10, scale2), 1, 0)).toEqual({ x: 12, y: 0 });
  });

  it("invertTransform undoes a transform on any point", () => {
    const t = compose({ a: 2, b: 0, c: 0, d: 4, e: 0, f: 0 }, translation(10, -5));
    const p = applyTransform(t, 3, 7);
    expect(applyTransform(invertTransform(t), p.x, p.y)).toEqual({ x: 3, y: 7 });
  });

  it("invertTransform of a singular transform is the identity (never NaN)", () => {
    // Una scala 0 non ha inversa: meglio l'identità che degli Infinity/NaN che
    // si propagherebbero nel renderer o nell'hit-test.
    expect(invertTransform({ a: 0, b: 0, c: 0, d: 0, e: 5, f: 5 })).toEqual(IDENTITY);
  });
});

describe("worldTransformOf", () => {
  it("is the identity for a page, so an existing flat document does not move", () => {
    // MIGRAZIONE: ogni documento esistente ha tutti i nodi sotto una pagina.
    // Se una pagina contribuisse qualcosa di diverso dall'identità, l'intera
    // opera d'arte di tutti si sposterebbe in silenzio.
    const s = nested();
    expect(worldTransformOf(s, "page1")).toEqual(IDENTITY);
    expect(worldTransformOf(s, "")).toEqual(IDENTITY);
    expect(worldTransformOf(s, "ghost")).toEqual(IDENTITY);
  });

  it("maps a node under a page: world == local", () => {
    const s = nested();
    expect(localToWorld(s, "page1", 10, 20)).toEqual({ x: 10, y: 20 });
    expect(worldToLocal(s, "page1", 10, 20)).toEqual({ x: 10, y: 20 });
  });

  it("accumulates the ancestors' translations, three levels deep", () => {
    const s = nested();
    expect(worldTransformOf(s, "a")).toEqual(translation(100, 50));
    expect(worldTransformOf(s, "b")).toEqual(translation(110, 70));
    expect(worldTransformOf(s, "c")).toEqual(translation(113, 74));
  });

  it("maps a known world point to a known local point AND back (three levels)", () => {
    const s = nested();
    // (5, 5) nello spazio di "c" -> (118, 79) nel mondo.
    expect(localToWorld(s, "c", 5, 5)).toEqual({ x: 118, y: 79 });
    expect(worldToLocal(s, "c", 118, 79)).toEqual({ x: 5, y: 5 });
    // Andata e ritorno su un punto qualunque, per ognuno dei tre livelli.
    for (const id of ["a", "b", "c"]) {
      const w = localToWorld(s, id, -12.5, 33.25);
      expect(worldToLocal(s, id, w.x, w.y)).toEqual({ x: -12.5, y: 33.25 });
    }
  });

  it("terminates on a malformed document with a parent cycle", () => {
    const s = emptyScene("d", "n");
    s.nodes["x"] = node("x", "y", 1, 1);
    s.nodes["y"] = node("y", "x", 2, 2);
    // Nessun ciclo infinito: ciò che conta è che RITORNI (il valore su un
    // documento impossibile non è specificato oltre a essere finito).
    expect(Number.isFinite(worldTransformOf(s, "x").e)).toBe(true);
  });
});

describe("mapBounds / mapVector", () => {
  it("mapBounds keeps the rectangle that CONTAINS the transformed corners", () => {
    // Un quarto di giro: il rettangolo 10x4 in (1,1) finisce con i lati
    // scambiati, e i bounds sono quelli del rettangolo ruotato.
    const quarterTurn = { a: 0, b: 1, c: -1, d: 0, e: 0, f: 0 };
    expect(mapBounds(quarterTurn, { x: 1, y: 1, width: 10, height: 4 }))
      .toEqual({ x: -5, y: 1, width: 4, height: 10 });
  });

  it("mapVector ignores the translation: uno spostamento non si trasla", () => {
    const t = compose(translation(1000, -1000), { a: 2, b: 0, c: 0, d: 3, e: 0, f: 0 });
    expect(mapVector(t, 5, 5)).toEqual({ x: 10, y: 15 });
    // Un punto, invece, la traslazione se la prende tutta.
    expect(applyTransform(t, 5, 5)).toEqual({ x: 1010, y: -985 });
  });

  it("mapVector through the inverse turns a WORLD delta into a local one", () => {
    // Il caso vero: il puntatore si muove nel mondo, il modello scrive
    // coordinate locali. Con un parent scalato x2, 20px di mondo sono 10
    // unità locali.
    const parent = { a: 2, b: 0, c: 0, d: 2, e: 300, f: 300 };
    expect(mapVector(invertTransform(parent), 20, 0)).toEqual({ x: 10, y: 0 });
  });
});

describe("worldBoundsOfNode", () => {
  it("is the node's own box for a node under a page", () => {
    const s = nested();
    expect(worldBoundsOfNode(s, s.nodes["a"])).toEqual({ x: 100, y: 50, width: 50, height: 50 });
  });

  it("offsets a nested node's box by the transform of its ANCESTORS, not its own", () => {
    const s = nested();
    // "c" sta a (3,4) dentro "b", che sta a (10,20) dentro "a", che sta a
    // (100,50): il suo box mondo parte da (113,74) e conserva le dimensioni.
    expect(worldBoundsOfNode(s, s.nodes["c"])).toEqual({ x: 113, y: 74, width: 50, height: 50 });
  });
});
