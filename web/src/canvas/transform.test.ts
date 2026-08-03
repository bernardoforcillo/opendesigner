import { describe, it, expect } from "vitest";
import {
  IDENTITY,
  applyTransform,
  compose,
  invertTransform,
  localToWorld,
  mapBounds,
  mapVector,
  translation,
  worldBoundsOfNode,
  worldToLocal,
  worldTransformOf,
} from "./transform";
import { emptyScene } from "../store/types";
import type { NodeLite, SceneState } from "../store/types";

function node(id: string, parentId: string, x: number, y: number, w = 50, h = 50): NodeLite {
  return {
    id, parentId, orderKey: "a0", name: id, visible: true, opacity: 1,
    x, y, width: w, height: h, rotation: 0, fills: [], kind: "rect", cornerRadius: 0, clipsContent: false,
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
