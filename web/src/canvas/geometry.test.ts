import { describe, it, expect } from "vitest";
import {
  boundsOfNode, boundsIntersect, normalizeRect, pointInBounds, strokeOutset, strokeOutsetOfNode,
  unionBounds, visualBoundsOfNode, worldAabbOfNode, worldVisualAabbOfNode,
} from "./geometry";
import type { NodeLite, StrokeAlignLite, StrokeLite } from "../store/types";

function rect(x: number, y: number, width: number, height: number): NodeLite {
  return { id: "n", parentId: "page1", orderKey: "a000000", name: "n", visible: true, opacity: 1,
    x, y, width, height, rotation: 0, fills: [], strokes: [], kind: "rect", cornerRadius: 0 };
}

function stroke(weight: number, align: StrokeAlignLite): StrokeLite {
  return { color: { r: 0, g: 0, b: 0, a: 1 }, weight, align };
}

describe("boundsOfNode", () => {
  it("reads x/y/width/height straight off the node", () => {
    expect(boundsOfNode(rect(10, 20, 30, 40))).toEqual({ x: 10, y: 20, width: 30, height: 40 });
  });

  it("ignores the stroke: è il box del MODELLO, quello che il resize scrive", () => {
    const n = { ...rect(10, 20, 30, 40), strokes: [stroke(8, "outside")] };
    expect(boundsOfNode(n)).toEqual({ x: 10, y: 20, width: 30, height: 40 });
  });
});

// --- il TRATTO nei bounds ----------------------------------------------------
//
// Quanto sporge un tratto FUORI dal perimetro dipende dall'allineamento, e
// sbagliarlo si vede solo ai bordi: un mezzo peso non contato taglia la
// selezione, il marquee e (più avanti) l'export.

describe("strokeOutset", () => {
  it("center sporge di METÀ peso, outside di TUTTO, inside di NIENTE", () => {
    expect(strokeOutset(stroke(8, "center"))).toBe(4);
    expect(strokeOutset(stroke(8, "outside"))).toBe(8);
    expect(strokeOutset(stroke(8, "inside"))).toBe(0);
  });

  it("un peso nullo o negativo non sporge (non è un tratto sottilissimo: non c'è)", () => {
    expect(strokeOutset(stroke(0, "outside"))).toBe(0);
    expect(strokeOutset(stroke(-5, "center"))).toBe(0);
  });
});

describe("strokeOutsetOfNode", () => {
  it("è 0 su un nodo senza tratti -- il caso normale, e deve restare esatto", () => {
    expect(strokeOutsetOfNode(rect(0, 0, 10, 10))).toBe(0);
  });

  it("prende il MASSIMO fra i tratti: i tratti si sovrappongono, non si sommano", () => {
    const n = { ...rect(0, 0, 10, 10), strokes: [stroke(4, "center"), stroke(6, "outside"), stroke(20, "inside")] };
    expect(strokeOutsetOfNode(n)).toBe(6);
  });

  it("sul TESTO conta sempre METÀ peso, qualunque sia l'allineamento", () => {
    // strokeText è sempre centrato (un glifo non ha un Path2D da ritagliare):
    // la misura deve dire quello che il disegno fa davvero, o taglia da un lato
    // e avanza dall'altro.
    const t: NodeLite = { ...rect(0, 0, 10, 10), kind: "text" };
    expect(strokeOutsetOfNode({ ...t, strokes: [stroke(8, "outside")] })).toBe(4);
    expect(strokeOutsetOfNode({ ...t, strokes: [stroke(8, "inside")] })).toBe(4);
    expect(strokeOutsetOfNode({ ...t, strokes: [stroke(8, "center")] })).toBe(4);
    // ...ma su una FORMA l'allineamento conta eccome.
    expect(strokeOutsetOfNode({ ...rect(0, 0, 10, 10), strokes: [stroke(8, "outside")] })).toBe(8);
  });
});

describe("visualBoundsOfNode", () => {
  it("allarga il box del modello della sporgenza, su OGNI lato", () => {
    const n = { ...rect(10, 20, 30, 40), strokes: [stroke(8, "center")] };
    expect(visualBoundsOfNode(n)).toEqual({ x: 6, y: 16, width: 38, height: 48 });
  });

  it("un tratto INTERNO non allarga niente", () => {
    const n = { ...rect(10, 20, 30, 40), strokes: [stroke(8, "inside")] };
    expect(visualBoundsOfNode(n)).toEqual({ x: 10, y: 20, width: 30, height: 40 });
  });

  it("senza tratti è IDENTICO a boundsOfNode, numero per numero", () => {
    const n = rect(10, 20, 30, 40);
    expect(visualBoundsOfNode(n)).toEqual(boundsOfNode(n));
  });
});

describe("worldVisualAabbOfNode", () => {
  it("allarga PRIMA e ruota DOPO: il tratto vive nello spazio locale del nodo", () => {
    // 100x50 a 90°: l'AABB del box è 50x100 attorno al centro (50,25).
    // Con un tratto center da 20 il box locale è 120x70, quindi l'AABB
    // ruotato è 70x120 -- non 50+20 x 100+20, che sarebbe "ruota e poi
    // allarga" e darebbe la sporgenza sull'asse sbagliato per un tratto
    // ellittico o per una futura sporgenza non uniforme.
    //
    // toBeCloseTo e non toEqual: a 90° cos vale 6.1e-17 in doppia precisione,
    // quindi rotatedAabb (che è già così per la sola rotazione) porta polvere
    // sull'ultima cifra. L'esattezza è garantita solo per gli angoli NULLI --
    // vedi il caso qui sotto e canvas/transform.ts::isUnrotated.
    const n = { ...rect(0, 0, 100, 50), rotation: 90, strokes: [stroke(20, "center")] };
    const b = worldVisualAabbOfNode(n);
    expect(b.x).toBeCloseTo(15, 10);
    expect(b.y).toBeCloseTo(-35, 10);
    expect(b.width).toBeCloseTo(70, 10);
    expect(b.height).toBeCloseTo(120, 10);
  });

  it("senza tratti coincide con worldAabbOfNode", () => {
    const n = { ...rect(10, 20, 30, 40), rotation: 33 };
    expect(worldVisualAabbOfNode(n)).toEqual(worldAabbOfNode(n));
  });

  it("worldAabbOfNode resta il box del MODELLO ruotato: è lo spazio del resize", () => {
    // Il frame di selezione e il resize di gruppo lavorano sulla GEOMETRIA (è
    // quella che gli op scrivono in x/y/w/h). Se worldAabbOfNode cominciasse a
    // includere il tratto, trascinare una maniglia scriverebbe un box gonfiato
    // e il nodo crescerebbe di una sporgenza a ogni resize.
    const n = { ...rect(0, 0, 100, 50), strokes: [stroke(20, "outside")] };
    expect(worldAabbOfNode(n)).toEqual({ x: 0, y: 0, width: 100, height: 50 });
  });
});

describe("unionBounds", () => {
  it("returns null for an empty list", () => {
    expect(unionBounds([])).toBeNull();
  });

  it("returns the single bounds unchanged for a list of one", () => {
    const b = { x: 5, y: 5, width: 10, height: 10 };
    expect(unionBounds([b])).toEqual(b);
  });

  it("computes the tight bounding box of several rects", () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    const b = { x: 20, y: -5, width: 10, height: 10 };
    const c = { x: 5, y: 5, width: 2, height: 2 };
    expect(unionBounds([a, b, c])).toEqual({ x: 0, y: -5, width: 30, height: 15 });
  });
});

describe("normalizeRect", () => {
  it("handles a forward drag (down-right)", () => {
    expect(normalizeRect(0, 0, 10, 20)).toEqual({ x: 0, y: 0, width: 10, height: 20 });
  });

  it("handles a backward drag (up-left)", () => {
    expect(normalizeRect(10, 20, 0, 0)).toEqual({ x: 0, y: 0, width: 10, height: 20 });
  });

  it("handles a drag that only flips x (up-right to down-left, i.e. right-to-left)", () => {
    expect(normalizeRect(10, 0, 0, 20)).toEqual({ x: 0, y: 0, width: 10, height: 20 });
  });

  it("handles a drag that only flips y (bottom-left to top-right, i.e. bottom-to-top)", () => {
    expect(normalizeRect(0, 20, 10, 0)).toEqual({ x: 0, y: 0, width: 10, height: 20 });
  });

  it("handles a zero-size drag (click without moving)", () => {
    expect(normalizeRect(5, 5, 5, 5)).toEqual({ x: 5, y: 5, width: 0, height: 0 });
  });
});

describe("boundsIntersect", () => {
  it("is true for overlapping rects", () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    const b = { x: 5, y: 5, width: 10, height: 10 };
    expect(boundsIntersect(a, b)).toBe(true);
  });

  it("is false for disjoint rects", () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    const b = { x: 20, y: 20, width: 10, height: 10 };
    expect(boundsIntersect(a, b)).toBe(false);
  });

  it("is false for rects that only touch at an edge", () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    const b = { x: 10, y: 0, width: 10, height: 10 };
    expect(boundsIntersect(a, b)).toBe(false);
  });

  it("is symmetric", () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    const b = { x: 5, y: 5, width: 10, height: 10 };
    expect(boundsIntersect(a, b)).toBe(boundsIntersect(b, a));
  });
});

describe("pointInBounds", () => {
  const b = { x: 10, y: 10, width: 20, height: 20 };

  it("is true for a point inside", () => {
    expect(pointInBounds(b, 15, 15)).toBe(true);
  });

  it("is true for a point exactly on the boundary", () => {
    expect(pointInBounds(b, 10, 10)).toBe(true);
    expect(pointInBounds(b, 30, 30)).toBe(true);
  });

  it("is false for a point outside", () => {
    expect(pointInBounds(b, 5, 5)).toBe(false);
    expect(pointInBounds(b, 31, 15)).toBe(false);
  });
});
