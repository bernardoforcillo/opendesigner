import { describe, it, expect } from "vitest";
import { boundsOfNode, unionBounds, normalizeRect, boundsIntersect, intersectBounds, pointInBounds } from "./geometry";
import type { NodeLite } from "../store/types";

function rect(x: number, y: number, width: number, height: number): NodeLite {
  return { id: "n", parentId: "page1", orderKey: "a000000", name: "n", visible: true, opacity: 1,
    x, y, width, height, rotation: 0, fills: [], kind: "rect", cornerRadius: 0, clipsContent: false };
}

describe("boundsOfNode", () => {
  it("reads x/y/width/height straight off the node", () => {
    expect(boundsOfNode(rect(10, 20, 30, 40))).toEqual({ x: 10, y: 20, width: 30, height: 40 });
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

// intersectBounds è la parte VISIBILE di un box dentro un ritaglio: serve alla
// banda elastica quando scende dentro un frame che ritaglia i figli (vedi
// renderer/canvasRenderer.ts::collectIn). null = niente in comune, cioè niente
// da vedere e quindi niente da selezionare.
describe("intersectBounds", () => {
  it("returns the overlapping rectangle", () => {
    const a = { x: 0, y: 0, width: 100, height: 100 };
    const b = { x: 50, y: 60, width: 100, height: 100 };
    expect(intersectBounds(a, b)).toEqual({ x: 50, y: 60, width: 50, height: 40 });
  });

  it("returns the contained rectangle when one is inside the other", () => {
    const outer = { x: 0, y: 0, width: 100, height: 100 };
    const inner = { x: 10, y: 10, width: 20, height: 20 };
    expect(intersectBounds(outer, inner)).toEqual(inner);
    expect(intersectBounds(inner, outer)).toEqual(inner);
  });

  it("returns null for disjoint rectangles", () => {
    expect(intersectBounds({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 0, width: 10, height: 10 })).toBeNull();
  });

  // Coerente con boundsIntersect, che confronta i bordi opposti con < / >: due
  // rettangoli che si toccano su un bordo non si intersecano, e la loro
  // "intersezione" degenere (larghezza 0) non è area visibile.
  it("returns null when the rectangles only touch at an edge", () => {
    expect(intersectBounds({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 10, height: 10 })).toBeNull();
    expect(boundsIntersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 10, height: 10 })).toBe(false);
  });
});
