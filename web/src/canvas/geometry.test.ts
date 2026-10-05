import { describe, it, expect } from "vitest";
import {
  boundsOfNode, boundsIntersect, intersectBounds, normalizeRect, pointInBounds, strokeOutset,
  strokeOutsetOfNode, unionBounds, visualBoundsOfNode, worldAabbOfNode, worldVisualAabbOfNode,
} from "./geometry";
import type { NodeLite, StrokeAlignLite, StrokeLite } from "../store/types";

function rect(x: number, y: number, width: number, height: number): NodeLite {
  return { id: "n", parentId: "page1", orderKey: "a000000", name: "n", visible: true, opacity: 1,
    x, y, width, height, rotation: 0, fills: [], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false };
}

function stroke(weight: number, align: StrokeAlignLite): StrokeLite {
  return { color: { r: 0, g: 0, b: 0, a: 1 }, weight, align };
}

describe("boundsOfNode", () => {
  it("reads x/y/width/height straight off the node", () => {
    expect(boundsOfNode(rect(10, 20, 30, 40))).toEqual({ x: 10, y: 20, width: 30, height: 40 });
  });

  it("ignores the stroke: it is the MODEL's box, the one resize writes", () => {
    const n = { ...rect(10, 20, 30, 40), strokes: [stroke(8, "outside")] };
    expect(boundsOfNode(n)).toEqual({ x: 10, y: 20, width: 30, height: 40 });
  });
});

// --- the STROKE in the bounds ------------------------------------------------
//
// How much a stroke overhangs OUTSIDE the perimeter depends on alignment, and
// getting it wrong shows only at the edges: an uncounted half weight crops the
// selection, the marquee and (later) the export.

describe("strokeOutset", () => {
  it("center overhangs by HALF the weight, outside by ALL of it, inside by NOTHING", () => {
    expect(strokeOutset(stroke(8, "center"))).toBe(4);
    expect(strokeOutset(stroke(8, "outside"))).toBe(8);
    expect(strokeOutset(stroke(8, "inside"))).toBe(0);
  });

  it("a zero or negative weight does not overhang (it is not a very thin stroke: it does not exist)", () => {
    expect(strokeOutset(stroke(0, "outside"))).toBe(0);
    expect(strokeOutset(stroke(-5, "center"))).toBe(0);
  });
});

describe("strokeOutsetOfNode", () => {
  it("is 0 on a node without strokes -- the normal case, and it must stay exact", () => {
    expect(strokeOutsetOfNode(rect(0, 0, 10, 10))).toBe(0);
  });

  it("takes the MAXIMUM among the strokes: strokes overlap, they do not add up", () => {
    const n = { ...rect(0, 0, 10, 10), strokes: [stroke(4, "center"), stroke(6, "outside"), stroke(20, "inside")] };
    expect(strokeOutsetOfNode(n)).toBe(6);
  });

  it("on TEXT it always counts HALF the weight, whatever the alignment", () => {
    // strokeText is always centered (a glyph has no Path2D to clip):
    // the measure must say what the drawing really does, or it crops on one side
    // and has spare on the other.
    const t: NodeLite = { ...rect(0, 0, 10, 10), kind: "text" };
    expect(strokeOutsetOfNode({ ...t, strokes: [stroke(8, "outside")] })).toBe(4);
    expect(strokeOutsetOfNode({ ...t, strokes: [stroke(8, "inside")] })).toBe(4);
    expect(strokeOutsetOfNode({ ...t, strokes: [stroke(8, "center")] })).toBe(4);
    // ...but on a SHAPE alignment matters indeed.
    expect(strokeOutsetOfNode({ ...rect(0, 0, 10, 10), strokes: [stroke(8, "outside")] })).toBe(8);
  });
});

describe("visualBoundsOfNode", () => {
  it("widens the model's box by the overhang, on EVERY side", () => {
    const n = { ...rect(10, 20, 30, 40), strokes: [stroke(8, "center")] };
    expect(visualBoundsOfNode(n)).toEqual({ x: 6, y: 16, width: 38, height: 48 });
  });

  it("an INSIDE stroke widens nothing", () => {
    const n = { ...rect(10, 20, 30, 40), strokes: [stroke(8, "inside")] };
    expect(visualBoundsOfNode(n)).toEqual({ x: 10, y: 20, width: 30, height: 40 });
  });

  it("without strokes it is IDENTICAL to boundsOfNode, number by number", () => {
    const n = rect(10, 20, 30, 40);
    expect(visualBoundsOfNode(n)).toEqual(boundsOfNode(n));
  });
});

describe("worldVisualAabbOfNode", () => {
  it("widens BEFORE and rotates AFTER: the stroke lives in the node's local space", () => {
    // 100x50 at 90°: the box's AABB is 50x100 around the center (50,25).
    // With a 20 center stroke the local box is 120x70, so the rotated
    // AABB is 70x120 -- not 50+20 x 100+20, which would be "rotate and then
    // widen" and would give the overhang on the wrong axis for an
    // elliptical stroke or a future non-uniform overhang.
    //
    // toBeCloseTo and not toEqual: at 90° cos is 6.1e-17 in double precision,
    // so rotatedAabb (which is already so for rotation alone) carries dust
    // on the last digit. Exactness is guaranteed only for NULL angles --
    // see the case below and canvas/transform.ts::isUnrotated.
    const n = { ...rect(0, 0, 100, 50), rotation: 90, strokes: [stroke(20, "center")] };
    const b = worldVisualAabbOfNode(n);
    expect(b.x).toBeCloseTo(15, 10);
    expect(b.y).toBeCloseTo(-35, 10);
    expect(b.width).toBeCloseTo(70, 10);
    expect(b.height).toBeCloseTo(120, 10);
  });

  it("without strokes it coincides with worldAabbOfNode", () => {
    const n = { ...rect(10, 20, 30, 40), rotation: 33 };
    expect(worldVisualAabbOfNode(n)).toEqual(worldAabbOfNode(n));
  });

  it("worldAabbOfNode stays the rotated MODEL's box: it is the resize's space", () => {
    // The selection frame and the group resize work on the GEOMETRY (it is
    // what ops write in x/y/w/h). If worldAabbOfNode started to
    // include the stroke, dragging a handle would write an inflated box
    // and the node would grow by an overhang on every resize.
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

// intersectBounds is the VISIBLE part of a box inside a clip: it serves the
// rubber band when it descends into a frame that clips its children (see
// renderer/canvasRenderer.ts::collectIn). null = nothing in common, that is nothing
// to see and therefore nothing to select.
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

  // Consistent with boundsIntersect, which compares opposite edges with < / >: two
  // rectangles touching on an edge do not intersect, and their degenerate
  // "intersection" (width 0) is not visible area.
  it("returns null when the rectangles only touch at an edge", () => {
    expect(intersectBounds({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 10, height: 10 })).toBeNull();
    expect(boundsIntersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 10, height: 10 })).toBe(false);
  });
});
