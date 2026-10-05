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

// Reference box: 100x50 at the origin, so CENTER (50, 25) -- the only
// point around which this module rotates (see the comment in transform.ts).
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

// page1 > a(100,50) > b(10,20) > c(3,4): three levels of nesting, each
// with a non-zero offset on both axes, so a sign error or a skipped level shows up
// right away in the number.
function nested(): SceneState {
  const s = emptyScene("d", "n");
  s.nodes = s.nodes.set("a", node("a", "page1", 100, 50));
  s.nodes = s.nodes.set("b", node("b", "a", 10, 20));
  s.nodes = s.nodes.set("c", node("c", "b", 3, 4));
  return s;
}

describe("centerOf", () => {
  it("is the centre of the bounds, not its origin", () => {
    expect(centerOf(box)).toEqual(c);
    expect(centerOf({ x: 10, y: 20, width: 200, height: 100 })).toEqual({ x: 110, y: 70 });
  });
});

describe("localToWorld (rotation)", () => {
  // The case that fixes the SIGN of the convention: world axes with y pointing
  // down, so +90° takes the +x axis onto the +y axis, which on screen reads
  // as a CLOCKWISE rotation.
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
  // The KNOWN point of the forward trip, read backwards: (50,75) in the world is the point
  // (100,25) of the LOCAL space of the node rotated by 90°. It is exactly the
  // transformation hit-test applies to the point before testing the shape.
  it("maps a known world point back to its known local coordinate", () => {
    expectPoint(worldToLocal({ x: 50, y: 75 }, c, 90), 100, 25);
  });

  it("round-trips with localToWorld at an arbitrary angle", () => {
    const p = { x: 17, y: -3 };
    const w = localToWorld(p, c, 37);
    expectPoint(worldToLocal(w, c, 37), p.x, p.y);
    // and in the other direction
    const l = worldToLocal(p, c, -113.5);
    expectPoint(localToWorld(l, c, -113.5), p.x, p.y);
  });
});

describe("rotation of 0 (and full turns)", () => {
  // Not "almost" identity: EXACT. cos(0)=1 and sin(0)=0 would already be exact, but
  // the rest of the pipeline (resize, handles) compares integer numbers -- one
  // extra multiplication would be enough to turn 110 into 110.00000000000001.
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
  // Same clockwise convention as localToWorld: from a center, the point on the right
  // is 0°, the one BELOW is +90°.
  it("measures the clockwise angle from the +x axis", () => {
    expect(angleOf(c, { x: 60, y: 25 })).toBeCloseTo(0, 9);
    expect(angleOf(c, { x: 50, y: 35 })).toBeCloseTo(90, 9);
    expect(angleOf(c, { x: 40, y: 25 })).toBeCloseTo(180, 9);
    expect(angleOf(c, { x: 50, y: 15 })).toBeCloseTo(-90, 9);
  });

  it("is the inverse of localToWorld on a known radius", () => {
    // The point east of the center, rotated by 30°, reads back as 30°.
    const p = localToWorld({ x: 100, y: 25 }, c, 30);
    expect(angleOf(c, p)).toBeCloseTo(30, 9);
  });
});

describe("affine transforms", () => {
  it("IDENTITY leaves a point where it is", () => {
    expect(applyTransform(IDENTITY, 7, -3)).toEqual({ x: 7, y: -3 });
  });

  it("compose applies the INNER transform first", () => {
    // With only two translations the order would not show (they are commutative):
    // a scale is needed to distinguish the two directions.
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
    // A scale of 0 has no inverse: better the identity than Infinity/NaN that
    // would propagate into the renderer or hit-test.
    expect(invertTransform({ a: 0, b: 0, c: 0, d: 0, e: 5, f: 5 })).toEqual(IDENTITY);
  });
});

describe("worldTransformOf", () => {
  it("is the identity for a page, so an existing flat document does not move", () => {
    // MIGRATION: every existing document has all nodes under a page.
    // If a page contributed anything other than the identity, everyone's
    // entire artwork would silently shift.
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
    // (5, 5) in the space of "c" -> (118, 79) in the world.
    expect(localToWorld(s, "c", 5, 5)).toEqual({ x: 118, y: 79 });
    expect(worldToLocal(s, "c", 118, 79)).toEqual({ x: 5, y: 5 });
    // Round trip on any point, for each of the three levels.
    for (const id of ["a", "b", "c"]) {
      const w = localToWorld(s, id, -12.5, 33.25);
      expect(worldToLocal(s, id, w.x, w.y)).toEqual({ x: -12.5, y: 33.25 });
    }
  });

  it("terminates on a malformed document with a parent cycle", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("x", node("x", "y", 1, 1));
    s.nodes = s.nodes.set("y", node("y", "x", 2, 2));
    // No infinite loop: what matters is that it RETURNS (the value on an
    // impossible document is unspecified besides being finite).
    expect(Number.isFinite(worldTransformOf(s, "x").e)).toBe(true);
  });
});

describe("mapBounds / mapVector", () => {
  it("mapBounds keeps the rectangle that CONTAINS the transformed corners", () => {
    // A quarter turn: the 10x4 rectangle at (1,1) ends up with the sides
    // swapped, and the bounds are those of the rotated rectangle.
    const quarterTurn = { a: 0, b: 1, c: -1, d: 0, e: 0, f: 0 };
    expect(mapBounds(quarterTurn, { x: 1, y: 1, width: 10, height: 4 }))
      .toEqual({ x: -5, y: 1, width: 4, height: 10 });
  });

  it("mapVector ignores the translation: a displacement is not translated", () => {
    const t = compose(translation(1000, -1000), { a: 2, b: 0, c: 0, d: 3, e: 0, f: 0 });
    expect(mapVector(t, 5, 5)).toEqual({ x: 10, y: 15 });
    // A point, instead, takes the whole translation.
    expect(applyTransform(t, 5, 5)).toEqual({ x: 1010, y: -985 });
  });

  it("mapVector through the inverse turns a WORLD delta into a local one", () => {
    // The real case: the pointer moves in the world, the model writes
    // local coordinates. With a parent scaled x2, 20px of world are 10
    // local units.
    const parent = { a: 2, b: 0, c: 0, d: 2, e: 300, f: 300 };
    expect(mapVector(invertTransform(parent), 20, 0)).toEqual({ x: 10, y: 0 });
  });
});

describe("worldBoundsOfNode", () => {
  it("is the node's own box for a node under a page", () => {
    const s = nested();
    expect(worldBoundsOfNode(s, s.nodes.at("a"))).toEqual({ x: 100, y: 50, width: 50, height: 50 });
  });

  it("offsets a nested node's box by the transform of its ANCESTORS, not its own", () => {
    const s = nested();
    // "c" sits at (3,4) inside "b", which sits at (10,20) inside "a", which sits at
    // (100,50): its world box starts at (113,74) and keeps its dimensions.
    expect(worldBoundsOfNode(s, s.nodes.at("c"))).toEqual({ x: 113, y: 74, width: 50, height: 50 });
  });
});
