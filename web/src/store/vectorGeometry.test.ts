import { describe, it, expect } from "vitest";
import { create } from "@bufbuild/protobuf";
import { NodeSchema, OpSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import { applyOp } from "./applyOp";
import { emptyScene } from "./types";
import type { AnchorLite, SubPathLite } from "./types";
import {
  anchorPoint, inHandlePoint, outHandlePoint,
  hasInHandle, hasOutHandle, vectorBounds, normalizeVector, resizeVector,
  flattenSubpath, distanceToPolyline, pointInRingsEvenOdd, subpathFills, hitVectorGeometry,
  hasAnyAnchor,
} from "./vectorGeometry";

// The TWO SPACES rule, which the proto (on `Anchor`) states and this file
// pins down: anchors LOCAL to the node, handles RELATIVE to the anchor. Renderer,
// hit-test, overlay and pen tool will all read from vectorGeometry.ts, so
// these tests are the place where the rule stops being a comment.

function anchor(a: Partial<AnchorLite>): AnchorLite {
  return { x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0, ...a };
}

// Origin, anchor and handles all DIFFERENT and non-zero: a sum
// forgotten (or done once too many) cannot fall by chance on the
// right value.
const ORIGIN = { x: 100, y: 50 };
const A = anchor({ x: 7, y: 3, inX: -2, inY: 5, outX: 11, outY: -4 });

describe("vectorGeometry: the two spaces", () => {
  it("the anchor is LOCAL to the node: the world point is origin + anchor", () => {
    expect(anchorPoint(ORIGIN, A)).toEqual({ x: 107, y: 53 });
  });

  it("handles are RELATIVE to the anchor: the control is origin + anchor + handle", () => {
    expect(inHandlePoint(ORIGIN, A)).toEqual({ x: 105, y: 58 });
    expect(outHandlePoint(ORIGIN, A)).toEqual({ x: 118, y: 49 });
  });

  // The case the model got wrong: with ABSOLUTE handles, an anchor
  // decoded without in_/out_ (the zeros proto3 omits from the wire) would have its
  // handles at the origin instead of on itself -- a curve that crashes
  // into the node's corner instead of the corner point the user drew.
  // Relative, zero tells the truth.
  it("an anchor without handles (proto3's zero) is a CORNER, not a curve toward the origin", () => {
    const corner = anchor({ x: 20, y: 30 });
    const p = anchorPoint(ORIGIN, corner);
    expect(p).toEqual({ x: 120, y: 80 });
    // The two controls COINCIDE with the anchor: a bezierCurveTo with the
    // controls on the endpoints draws exactly the straight line, so the renderer
    // needs no branch for "no handle".
    expect(inHandlePoint(ORIGIN, corner)).toEqual(p);
    expect(outHandlePoint(ORIGIN, corner)).toEqual(p);
    expect(hasInHandle(corner)).toBe(false);
    expect(hasOutHandle(corner)).toBe(false);
  });

  it("hasIn/hasOut look at the right handle (the two are independent)", () => {
    expect(hasInHandle(anchor({ x: 9, y: 9, outX: 3 }))).toBe(false);
    expect(hasOutHandle(anchor({ x: 9, y: 9, outX: 3 }))).toBe(true);
    expect(hasInHandle(anchor({ inY: -1 }))).toBe(true);
  });
});

// The other half of the rule: what binds Node.x/y to the geometry. With
// local anchors, moving the node moves the path FOR FREE -- the setProps{x,y}
// that selectTool already sends today for any node. It is the reason for the choice,
// so it is a test and not a note.
describe("vectorGeometry: moving the node moves the geometry", () => {
  const subpaths: SubPathLite[] = [{ anchors: [A, anchor({ x: 40, y: 12 })], closed: false }];

  function sceneWithVector() {
    const node = create(NodeSchema, {
      id: "v1", parentId: "page1", orderKey: "a0", name: "Path", visible: true, opacity: 1,
      x: ORIGIN.x, y: ORIGIN.y, width: 60, height: 40,
      shape: { case: "vector", value: { subpaths } },
    });
    return applyOp(emptyScene("doc1", "Untitled"),
      create(OpSchema, { opId: "op-v1", docId: "doc1", kind: { case: "createNode", value: { node } } }));
  }

  it("a setProps{x,y} moves the world points and does NOT touch the anchors", () => {
    const before = sceneWithVector();
    const moved = applyOp(before, create(OpSchema, {
      opId: "op-mv", docId: "doc1",
      kind: { case: "setProps", value: {
        id: "v1", patch: create(NodeSchema, { x: 300, y: 250 }), mask: { paths: ["x", "y"] },
      } },
    }));

    const n0 = before.nodes.at("v1");
    const n1 = moved.nodes.at("v1");
    // The geometry in the MODEL is identical: no op rewrites it, and it is
    // exactly the point -- with anchors in world coordinates, a
    // move that did not rewrite all the subpaths would leave the path
    // behind its box.
    expect(n1.vector).toEqual(n0.vector);
    // ...and the world points moved by the delta, all of them.
    const d = { x: 300 - ORIGIN.x, y: 250 - ORIGIN.y };
    for (const [i, a] of n1.vector!.subpaths[0].anchors.entries()) {
      const p0 = anchorPoint(n0, n0.vector!.subpaths[0].anchors[i]);
      expect(anchorPoint(n1, a)).toEqual({ x: p0.x + d.x, y: p0.y + d.y });
      const c0 = outHandlePoint(n0, n0.vector!.subpaths[0].anchors[i]);
      expect(outHandlePoint(n1, a)).toEqual({ x: c0.x + d.x, y: c0.y + d.y });
    }
  });
});

describe("vectorGeometry: bounds and normalization", () => {
  // The ratio's cubic: A=(0,0) out=(100,0) -> B=(0,100) in=(100,0). The two
  // anchors both sit on x=0, the controls push up to x=100, and the
  // curve reaches 75 (the extremum is at t=0.5).
  const CURVY: SubPathLite[] = [{
    anchors: [anchor({ x: 0, y: 0, outX: 100, outY: 0 }), anchor({ x: 0, y: 100, inX: 100, inY: 0 })],
    closed: false,
  }];

  it("the bbox is the curve's TRUE one, not the hull of the control points", () => {
    // The anchors' box (width 0) would be NARROWER than the ink,
    // the controls' hull (width 100) wider by a third. Neither of the
    // two is "the right way to be wrong": the proto declares this box the
    // local bbox of the geometry, and it is the 8 resize handles
    // (overlayRenderer) and the marquee (selectTool::nodesInMarquee) that read it --
    // erring on the large side means handles that do not touch the path and a
    // selection that grabs without grazing the ink.
    expect(vectorBounds(CURVY)).toEqual({ x: 0, y: 0, width: 75, height: 100 });
  });

  it("handles that NO segment uses do not inflate the box (open outline)", () => {
    // In an OPEN outline the incoming handle of the first anchor and the outgoing
    // one of the last belong to no curve. A pen tool that
    // keeps mirrored handles has set them anyway: taking them as
    // good would inflate the box for geometry that does not exist.
    const sp: SubPathLite[] = [{
      anchors: [
        anchor({ x: 0, y: 0, inX: -1000, inY: -1000 }),
        anchor({ x: 10, y: 10, outX: 1000, outY: 1000 }),
      ],
      closed: false,
    }];
    expect(vectorBounds(sp)).toEqual({ x: 0, y: 0, width: 10, height: 10 });
  });

  it("closing the outline those same handles count: the return segment uses them", () => {
    // The complement of the previous test: it is not "the endpoints' handles are
    // ignored", it is "only drawn segments count". Closed, the last
    // -> first segment exists and uses both.
    const sp: SubPathLite[] = [{
      anchors: [
        anchor({ x: 0, y: 0, inX: -1000, inY: -1000 }),
        anchor({ x: 10, y: 10, outX: 1000, outY: 1000 }),
      ],
      closed: true,
    }];
    const b = vectorBounds(sp);
    expect(b.x).toBeLessThan(0);
    expect(b.x + b.width).toBeGreaterThan(10);
    // ...and anyway well inside the controls' hull (-1000..1010): the
    // curve does not reach where its control points reach.
    expect(b.x).toBeGreaterThan(-1000);
    expect(b.x + b.width).toBeLessThan(1010);
  });

  it("an outline of A SINGLE anchor is its point: there is no curve that uses the handles", () => {
    const sp: SubPathLite[] = [
      { anchors: [anchor({ x: 5, y: 7, inX: -50, inY: -50, outX: 50, outY: 50 })], closed: true },
    ];
    expect(vectorBounds(sp)).toEqual({ x: 5, y: 7, width: 0, height: 0 });
  });

  it("an empty geometry gives a degenerate box at (0,0)", () => {
    expect(vectorBounds([])).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(vectorBounds([{ anchors: [], closed: true }])).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it("normalizeVector brings the local bbox to (0,0)-(width,height)", () => {
    const sp: SubPathLite[] = [{ anchors: [anchor({ x: -20, y: 5 }), anchor({ x: 30, y: 45 })], closed: true }];
    const { subpaths, box } = normalizeVector(ORIGIN, sp);

    expect(vectorBounds(subpaths)).toEqual({ x: 0, y: 0, width: 50, height: 40 });
    // The box is in WORLD coordinates and is what the gesture writes into the node.
    expect(box).toEqual({ x: 80, y: 55, width: 50, height: 40 });
  });

  it("normalizing moves NOTHING: the world points stay the same", () => {
    // The property on which the invariant's correctness hangs: the
    // anchors lose locally exactly what the origin gains in
    // world. If either of the two sums got the sign wrong, the path would jump by one
    // box on every edit.
    const sp: SubPathLite[] = [
      { anchors: [A, anchor({ x: -13, y: 27, inX: 4, inY: -6 })], closed: false },
      { anchors: [anchor({ x: 55, y: -9, outX: -3, outY: 2 })], closed: true },
    ];
    const { subpaths, box } = normalizeVector(ORIGIN, sp);

    for (const [i, before] of sp.entries()) {
      for (const [j, a0] of before.anchors.entries()) {
        const a1 = subpaths[i].anchors[j];
        expect(anchorPoint(box, a1)).toEqual(anchorPoint(ORIGIN, a0));
        expect(inHandlePoint(box, a1)).toEqual(inHandlePoint(ORIGIN, a0));
        expect(outHandlePoint(box, a1)).toEqual(outHandlePoint(ORIGIN, a0));
      }
      // `closed` is not geometry to translate, but it is lost just as
      // easily: a field-by-field copy that forgot it would open every
      // closed outline on every edit.
      expect(subpaths[i].closed).toBe(before.closed);
    }
  });
});

// The box invariant in the direction that costs: the BOX cannot change on its own. The
// 8 resize handles have already shipped since M1 and send a
// setProps{x,y,width,height} for every selected node, kind-agnostic; without
// this rewrite a vector node would end up with the path at the previous size inside a
// grown box -- the invariant violated by an ordinary gesture and
// with no SetVectorPath in sight.
describe("vectorGeometry: the resize rewrites the geometry", () => {
  // bbox = (0,0)-(75,100), see the cubic test above.
  const CURVY: SubPathLite[] = [{
    anchors: [anchor({ x: 0, y: 0, outX: 100, outY: 0 }), anchor({ x: 0, y: 100, inX: 100, inY: 0 })],
    closed: false,
  }];
  const FROM = { width: 75, height: 100 };

  it("scaling the box scales the ink: the local bbox stays (0,0)-(w',h')", () => {
    const out = resizeVector(CURVY, FROM, { signed: 150, start: 75 }, { signed: 50, start: 100 });
    expect(vectorBounds(out)).toEqual({ x: 0, y: 0, width: 150, height: 50 });
    // Handles are OFFSETS: they scale with the linear part only. If they did not,
    // the curvature would stay at the previous size inside a scaled path
    // -- and the bbox above would not come out right.
    expect(out[0].anchors[0].outX).toBe(200);
    expect(out[0].anchors[1].inX).toBe(200);
  });

  it("a FLIP mirrors the ink inside the box instead of sending it negative", () => {
    const out = resizeVector(CURVY, FROM, { signed: -75, start: 75 }, { signed: 100, start: 100 });
    // Same box (transformBounds normalizes width/height to >= 0)...
    expect(vectorBounds(out)).toEqual({ x: 0, y: 0, width: 75, height: 100 });
    // ...but the curve is mirrored: the anchors were on the LEFT edge of the
    // box (local x 0) and are now on the right one, with the handles flipped.
    expect(out[0].anchors[0].x).toBe(75);
    expect(out[0].anchors[0].outX).toBe(-100);
  });

  it("an axis with no defined scale factor (starting side 0) stays unchanged", () => {
    // Same rule as selection/handles.ts::mapAxis: a degenerate side has
    // no ratio, and producing Infinity/NaN would be worse than not scaling.
    const flat: SubPathLite[] = [{ anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 10, y: 0 })], closed: false }];
    const out = resizeVector(flat, { width: 10, height: 0 }, { signed: 20, start: 10 }, { signed: 0, start: 0 });
    expect(out[0].anchors.map((a) => [a.x, a.y])).toEqual([[0, 0], [20, 0]]);
  });

  it("does not touch `closed` nor invent anchors", () => {
    const sp: SubPathLite[] = [
      { anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 10, y: 10 })], closed: true },
      { anchors: [anchor({ x: 2, y: 2 })], closed: false },
    ];
    const out = resizeVector(sp, { width: 10, height: 10 }, { signed: 20, start: 10 }, { signed: 10, start: 10 });
    expect(out.map((s) => s.closed)).toEqual([true, false]);
    expect(out.map((s) => s.anchors.length)).toEqual([2, 1]);
  });
});

// --- flattening, distance, fill ----------------------------------------------
// The math on which the path's drawing (renderer/shapes.ts) and its
// hit-test rest. It lives here, with the other geometry reads, and is tested with
// KNOWN curves and KNOWN answers: shapes.ts just translates the point into
// local coordinates and picks the tolerances in SCREEN px.

describe("vectorGeometry: flattening", () => {
  // The usual ratio cubic: two anchors on x=0, controls up to
  // x=100, curve reaching 75.
  const CURVY: SubPathLite = {
    anchors: [anchor({ x: 0, y: 0, outX: 100, outY: 0 }), anchor({ x: 0, y: 100, inX: 100, inY: 0 })],
    closed: false,
  };

  it("a segment WITHOUT handles is not subdivided: just its two endpoints", () => {
    // The most common case of a pen tool (a polyline) must pay nothing:
    // the controls coincide with the anchors, so the chord IS the curve.
    const line: SubPathLite = { anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 100, y: 0 })], closed: false };
    expect(flattenSubpath(line, 0.25)).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }]);
  });

  it("a cubic degenerate into a LINE stays two points (the controls are on the chord)", () => {
    // P1 and P2 lie on the chord: the curve lies entirely on it, even though
    // its parametrization is not linear. The criterion "how far the
    // controls are from the chord" sees it; one based on the second derivative does not, and
    // would split a straight line into about twenty pieces.
    const straight: SubPathLite = {
      anchors: [anchor({ x: 0, y: 0, outX: 30, outY: 0 }), anchor({ x: 100, y: 0, inX: -30, inY: 0 })],
      closed: false,
    };
    expect(flattenSubpath(straight, 0.25)).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }]);
  });

  it("the EXTREMA are exact, and the polyline reaches where the true curve reaches", () => {
    const pts = flattenSubpath(CURVY, 0.01);
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[pts.length - 1]).toEqual({ x: 0, y: 100 });
    // 75 is the TRUE extremum (see vectorBounds above). If someone
    // flattened onto the control points, this number would be 100.
    const maxX = Math.max(...pts.map((p) => p.x));
    expect(maxX).toBeLessThanOrEqual(75);
    expect(maxX).toBeGreaterThan(75 - 0.01);
  });

  it("the tolerance is RESPECTED: every point of the true curve is closer than tol to the polyline", () => {
    // The actual flattening contract, sampled on the exact cubic.
    // It holds at every tolerance, which is what makes it safe to scale the
    // tolerance with the zoom.
    for (const tol of [1, 0.1, 0.01]) {
      const pts = flattenSubpath(CURVY, tol);
      let worst = 0;
      for (let i = 0; i <= 200; i++) {
        const t = i / 200;
        const u = 1 - t;
        // B(t) per P0=(0,0) P1=(100,0) P2=(100,100) P3=(0,100).
        const bx = 3 * u * u * t * 100 + 3 * u * t * t * 100;
        const by = 3 * u * t * t * 100 + t * t * t * 100;
        worst = Math.max(worst, distanceToPolyline(pts, bx, by));
      }
      expect(worst).toBeLessThanOrEqual(tol);
    }
  });

  it("a tighter tolerance produces more segments, not fewer", () => {
    expect(flattenSubpath(CURVY, 0.01).length).toBeGreaterThan(flattenSubpath(CURVY, 1).length);
  });

  it("a CLOSED outline includes the last -> first return segment", () => {
    const tri: SubPathLite = {
      anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 10, y: 0 }), anchor({ x: 10, y: 10 })],
      closed: true,
    };
    expect(flattenSubpath(tri, 0.25)).toEqual([
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 0 },
    ]);
  });

  it("an outline of ONE anchor is a point, an empty one is nothing", () => {
    expect(flattenSubpath({ anchors: [anchor({ x: 3, y: 4 })], closed: false }, 0.25)).toEqual([{ x: 3, y: 4 }]);
    // `closed` changes nothing: a point has no segments to close.
    expect(flattenSubpath({ anchors: [anchor({ x: 3, y: 4 })], closed: true }, 0.25)).toEqual([{ x: 3, y: 4 }]);
    expect(flattenSubpath({ anchors: [], closed: false }, 0.25)).toEqual([]);
  });
});

describe("vectorGeometry: distance from a polyline", () => {
  const SEG = [{ x: 0, y: 0 }, { x: 10, y: 0 }];

  it("it is the perpendicular when the foot falls INSIDE the segment", () => {
    expect(distanceToPolyline(SEG, 5, 3)).toBe(3);
    expect(distanceToPolyline(SEG, 5, -3)).toBe(3);
    expect(distanceToPolyline(SEG, 5, 0)).toBe(0);
  });

  it("it is the distance from the ENDPOINT when the foot falls outside (segment, not line)", () => {
    // With the distance from the LINE this would be 0: the path would be grabbable
    // along its whole extension, to infinity.
    expect(distanceToPolyline(SEG, -4, 0)).toBe(4);
    expect(distanceToPolyline(SEG, 14, 0)).toBe(4);
    expect(distanceToPolyline(SEG, -3, 4)).toBe(5);
  });

  it("takes the MINIMUM over all segments", () => {
    const l = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
    expect(distanceToPolyline(l, 12, 5)).toBe(2);
  });

  it("a single point is the distance from the point; no points is infinite distance", () => {
    expect(distanceToPolyline([{ x: 2, y: 2 }], 5, 6)).toBe(5);
    expect(distanceToPolyline([], 0, 0)).toBe(Infinity);
  });
});

describe("vectorGeometry: even-odd", () => {
  // Outer square and inner square traversed in the SAME direction: with the
  // NONZERO rule the hole would not be a hole (winding 2), with even-odd
  // it is. It is the test that pins down the choice of the rule.
  const OUTER = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  const HOLE = [{ x: 3, y: 3 }, { x: 7, y: 3 }, { x: 7, y: 7 }, { x: 3, y: 7 }];

  it("a single ring: inside is inside, outside is outside", () => {
    expect(pointInRingsEvenOdd([OUTER], 5, 5)).toBe(true);
    expect(pointInRingsEvenOdd([OUTER], 20, 5)).toBe(false);
    expect(pointInRingsEvenOdd([OUTER], 5, 20)).toBe(false);
    expect(pointInRingsEvenOdd([OUTER], -5, 5)).toBe(false);
  });

  it("two concentric rings in THE SAME DIRECTION make a hole", () => {
    expect(pointInRingsEvenOdd([OUTER, HOLE], 5, 5)).toBe(false);  // in the hole
    expect(pointInRingsEvenOdd([OUTER, HOLE], 1, 1)).toBe(true);   // in the ring
    expect(pointInRingsEvenOdd([OUTER, HOLE], 20, 20)).toBe(false);
  });

  it("the direction of traversal does not matter: it is the whole point of even-odd", () => {
    const reversed = [...HOLE].reverse();
    expect(pointInRingsEvenOdd([OUTER, reversed], 5, 5)).toBe(false);
    expect(pointInRingsEvenOdd([OUTER, reversed], 1, 1)).toBe(true);
  });

  it("no ring: no point is inside", () => {
    expect(pointInRingsEvenOdd([], 0, 0)).toBe(false);
  });
});

describe("vectorGeometry: subpathFills", () => {
  it("goes ALSO into the fill if and only if it is closed and has at least two anchors", () => {
    const two = [anchor({ x: 0, y: 0 }), anchor({ x: 1, y: 1 })];
    expect(subpathFills({ anchors: two, closed: true })).toBe(true);
    expect(subpathFills({ anchors: two, closed: false })).toBe(false);
    // A point has no area: `closed` does not give it one, and the canvas that fills
    // it draws nothing. Drawing and hit-test must say the same thing.
    expect(subpathFills({ anchors: [anchor({ x: 0, y: 0 })], closed: true })).toBe(false);
    expect(subpathFills({ anchors: [], closed: true })).toBe(false);
  });

  it("`true` does NOT mean 'it is only seen if it fills': the stroke is there anyway", () => {
    // This predicate says "goes also into the fill bucket", not "is
    // visible". The case above -- two closed anchors -- is the proof: the
    // predicate is true but the fill paints nothing (the outline
    // goes A->B->A and even-odd contains no point), so what is
    // seen and what is hit is the STROKE. Proven below in
    // hitVectorGeometry and in renderer/shapes.test.ts on vectorPaths.
    const two: SubPathLite[] = [{
      anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 100, y: 0 })], closed: true,
    }];
    expect(subpathFills(two[0])).toBe(true);
    expect(pointInRingsEvenOdd([flattenSubpath(two[0], 0.25)], 50, 0)).toBe(false);
    expect(hitVectorGeometry(two, 50, 0, 5, 0.25)).toBe(true);
  });
});

describe("vectorGeometry: hasAnyAnchor", () => {
  it("distinguishes 'no geometry' from 'degenerate geometry'", () => {
    // It is the distinction the marquee needs (tools/selectTool.ts): a squashed
    // path is seen and clicked, one without anchors is not.
    expect(hasAnyAnchor([])).toBe(false);
    expect(hasAnyAnchor([{ anchors: [], closed: true }])).toBe(false);
    expect(hasAnyAnchor([{ anchors: [], closed: false }, { anchors: [], closed: true }])).toBe(false);
    expect(hasAnyAnchor([{ anchors: [anchor({ x: 0, y: 0 })], closed: false }])).toBe(true);
    // ONE anchor in ANY one outline is enough.
    expect(hasAnyAnchor([
      { anchors: [], closed: false },
      { anchors: [anchor({ x: 5, y: 5 })], closed: true },
    ])).toBe(true);
  });
});

describe("vectorGeometry: hitVectorGeometry", () => {
  const GRAB = 5;
  const FLAT = 0.25;
  const open = (anchors: AnchorLite[]): SubPathLite[] => [{ anchors, closed: false }];

  it("an OPEN outline is hit by PROXIMITY to the curve", () => {
    const seg = open([anchor({ x: 0, y: 0 }), anchor({ x: 100, y: 0 })]);
    expect(hitVectorGeometry(seg, 50, 0, GRAB, FLAT)).toBe(true);
    expect(hitVectorGeometry(seg, 50, 4.9, GRAB, FLAT)).toBe(true);
    expect(hitVectorGeometry(seg, 50, -4.9, GRAB, FLAT)).toBe(true);
    expect(hitVectorGeometry(seg, 50, 5.1, GRAB, FLAT)).toBe(false);
    // Beyond the endpoint: the grab is around the segment, not its line.
    expect(hitVectorGeometry(seg, 110, 0, GRAB, FLAT)).toBe(false);
  });

  it("an open outline is NOT filled: its interior is not hittable", () => {
    // Three sides of a square, not closed: the center is not ink, and the
    // canvas does not paint it. If the hit-test hit it, a U-shaped path would steal
    // the clicks from everything inside it.
    const u = open([
      anchor({ x: 0, y: 0 }), anchor({ x: 0, y: 100 }),
      anchor({ x: 100, y: 100 }), anchor({ x: 100, y: 0 }),
    ]);
    expect(hitVectorGeometry(u, 50, 50, GRAB, FLAT)).toBe(false);
    expect(hitVectorGeometry(u, 50, 98, GRAB, FLAT)).toBe(true); // near the bottom side
  });

  it("a CLOSED outline is hit on the FILL and on its STROKE", () => {
    const square: SubPathLite[] = [{
      anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 100, y: 0 }),
        anchor({ x: 100, y: 100 }), anchor({ x: 0, y: 100 })],
      closed: true,
    }];
    expect(hitVectorGeometry(square, 50, 50, GRAB, FLAT)).toBe(true);
    // The closed outline is also STROKED (shapes.ts::vectorPaths), so it is
    // picked by proximity like an open one: the target is the ink, and the
    // stroke extends beyond the fill. The grab is the same `grab` as ever.
    expect(hitVectorGeometry(square, 103, 50, GRAB, FLAT)).toBe(true);
    expect(hitVectorGeometry(square, 104.9, 50, GRAB, FLAT)).toBe(true);
    // Beyond the grab it is outside: the tolerance is a grab, not an infinite halo.
    expect(hitVectorGeometry(square, 105.1, 50, GRAB, FLAT)).toBe(false);
    expect(hitVectorGeometry(square, 50, 110, GRAB, FLAT)).toBe(false);
  });

  it("a CLOSED outline of ZERO AREA stays hittable: it is the stroke that keeps it alive", () => {
    // The case the pen tool reaches in three clicks (A, B, A again to
    // close): `closed` is true and subpathFills says `true`, but the outline
    // goes A->B->A and even-odd contains NO point. If the fill
    // were the only target the node would become unclickable the instant
    // the user closes it -- and invisible, since drawing and hit-test
    // follow the same rule.
    const twoPoint: SubPathLite[] = [{
      anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 100, y: 0 })], closed: true,
    }];
    expect(hitVectorGeometry(twoPoint, 50, 0, GRAB, FLAT)).toBe(true);
    expect(hitVectorGeometry(twoPoint, 50, 4.9, GRAB, FLAT)).toBe(true);
    expect(hitVectorGeometry(twoPoint, 50, 5.1, GRAB, FLAT)).toBe(false);
    // Same story for a closed outline of ALIGNED anchors: they are three
    // points, but the area is zero anyway.
    const collinear: SubPathLite[] = [{
      anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 50, y: 0 }), anchor({ x: 100, y: 0 })],
      closed: true,
    }];
    expect(hitVectorGeometry(collinear, 75, 0, GRAB, FLAT)).toBe(true);
    expect(hitVectorGeometry(collinear, 75, 4.9, GRAB, FLAT)).toBe(true);
    expect(hitVectorGeometry(collinear, 75, 5.1, GRAB, FLAT)).toBe(false);
  });

  it("two closed outlines COMPOSE: the inner one is a hole", () => {
    const ring: SubPathLite[] = [
      { anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 100, y: 0 }),
        anchor({ x: 100, y: 100 }), anchor({ x: 0, y: 100 })], closed: true },
      { anchors: [anchor({ x: 30, y: 30 }), anchor({ x: 70, y: 30 }),
        anchor({ x: 70, y: 70 }), anchor({ x: 30, y: 70 })], closed: true },
    ];
    expect(hitVectorGeometry(ring, 10, 10, GRAB, FLAT)).toBe(true);
    expect(hitVectorGeometry(ring, 50, 50, GRAB, FLAT)).toBe(false);
    // The hole's edge is still INK (it is stroked), so it is
    // hit there: the hole is the void, not its outline.
    expect(hitVectorGeometry(ring, 50, 32, GRAB, FLAT)).toBe(true);
  });

  it("the fill follows the TRUE curve, not the polygon of the anchors", () => {
    // Two anchors on x=0 with handles pushing right: the curve,
    // closed by the return segment, encloses an area reaching x=75. The
    // polygon of the anchors alone would be degenerate and would contain nothing.
    const lens: SubPathLite[] = [{
      anchors: [anchor({ x: 0, y: 0, outX: 100, outY: 0 }), anchor({ x: 0, y: 100, inX: 100, inY: 0 })],
      closed: true,
    }];
    expect(hitVectorGeometry(lens, 40, 50, GRAB, FLAT)).toBe(true);
    // 85 and not 80: the curve reaches x=75 and the STROKE is hit within GRAB=5,
    // so 80 would be on the edge of the grab and would say nothing about the
    // fill, which is what this test measures.
    expect(hitVectorGeometry(lens, 85, 50, GRAB, FLAT)).toBe(false);
  });

  it("an outline of ONE anchor is hit like a point", () => {
    // The pen tool after the first click: without this the just-born node would be
    // reachable only from the layers panel.
    const dot = open([anchor({ x: 10, y: 20 })]);
    expect(hitVectorGeometry(dot, 10, 20, GRAB, FLAT)).toBe(true);
    expect(hitVectorGeometry(dot, 13, 20, GRAB, FLAT)).toBe(true);
    expect(hitVectorGeometry(dot, 20, 20, GRAB, FLAT)).toBe(false);
  });

  it("a CLOSED outline of a single anchor fills nothing", () => {
    const dot: SubPathLite[] = [{ anchors: [anchor({ x: 10, y: 20 })], closed: true }];
    expect(hitVectorGeometry(dot, 12, 20, GRAB, FLAT)).toBe(true);
    expect(hitVectorGeometry(dot, 40, 20, GRAB, FLAT)).toBe(false);
  });

  it("EMPTY geometry: no ink, nothing to hit", () => {
    // The node draws nothing (filling an empty Path2D paints nothing),
    // so it must not even steal clicks from the shapes underneath. It stays
    // reachable from the layers panel, which is the only place where something
    // is still left to touch.
    expect(hitVectorGeometry([], 0, 0, GRAB, FLAT)).toBe(false);
    expect(hitVectorGeometry([{ anchors: [], closed: true }], 0, 0, GRAB, FLAT)).toBe(false);
  });

  it("open and closed in the same node: either the one OR the other is hit", () => {
    const mixed: SubPathLite[] = [
      { anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 10, y: 0 }),
        anchor({ x: 10, y: 10 }), anchor({ x: 0, y: 10 })], closed: true },
      { anchors: [anchor({ x: 50, y: 0 }), anchor({ x: 50, y: 100 })], closed: false },
    ];
    expect(hitVectorGeometry(mixed, 5, 5, GRAB, FLAT)).toBe(true);    // fill
    expect(hitVectorGeometry(mixed, 52, 50, GRAB, FLAT)).toBe(true);  // vicinanza
    expect(hitVectorGeometry(mixed, 30, 50, GRAB, FLAT)).toBe(false);
  });
});
