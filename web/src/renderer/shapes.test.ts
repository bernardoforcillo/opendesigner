import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { hitTestNode, isPaintable, vectorPaths, hasInk, VECTOR_HIT_PX } from "./shapes";
import type { NodeLite, SubPathLite, AnchorLite } from "../store/types";

function node(kind: "rect" | "ellipse"): NodeLite {
  return { id: "n", parentId: "page1", orderKey: "a0", name: kind, visible: true, opacity: 1,
    x: 0, y: 0, width: 100, height: 50, rotation: 0,
    fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind, cornerRadius: 0, clipsContent: false };
}

// Style with unspecified lineHeight (0): the default 1.2 is resolved by the
// renderer, so a line is 16 * 1.2 = 19.2 tall.
function textNode(over: Partial<NodeLite> = {}, content = "hi"): NodeLite {
  return {
    ...node("rect"), kind: "text",
    text: { content, style: { fontFamily: "", fontSize: 16, fontWeight: "", lineHeight: 0, align: "left" } },
    ...over,
  };
}

function anchor(a: Partial<AnchorLite>): AnchorLite {
  return { x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0, ...a };
}

function vectorNode(subpaths: SubPathLite[], over: Partial<NodeLite> = {}): NodeLite {
  return { ...node("rect"), kind: "vector", vector: { subpaths }, ...over };
}

// Zoom enters hit-test only to convert the grab tolerance from SCREEN px
// to world units: at zoom 1 the two values coincide, and that is what the
// tests that do not talk about zoom use.
const Z1 = 1;

describe("hitTestNode", () => {
  it("rect: inside and outside", () => {
    expect(hitTestNode(node("rect"), 50, 25, Z1)).toBe(true);
    expect(hitTestNode(node("rect"), 4, 2, Z1)).toBe(true);     // the corners belong to the rect
    expect(hitTestNode(node("rect"), 120, 25, Z1)).toBe(false);
  });

  // A group has no geometry of its own: it is not drawn and not hit. Selecting
  // it is the job of the group policy climbing from the hit CHILD
  // (store/groups.ts), not an invisible rectangle that would steal clicks from
  // what lies under it. The box is set on purpose: not even a group
  // with width/height on it must become hittable.
  it("group: never hit, whatever box it carries", () => {
    const g: NodeLite = { ...node("rect"), kind: "group" };
    expect(hitTestNode(g, 50, 25, Z1)).toBe(false);
    expect(hitTestNode({ ...g, width: 0, height: 0 }, 0, 0, Z1)).toBe(false);
  });

  // A FRAME has its OWN geometry (unlike the group): it is hit on its
  // box, like a rectangle. It is the artboard convention -- clicking the EMPTY part
  // of the frame selects it. The corner radius does not touch it: a frame is
  // rectangular.
  it("frame: hits its own box like a rect, ignoring corner radius", () => {
    const f: NodeLite = { ...node("rect"), kind: "frame" };
    expect(hitTestNode(f, 50, 25, Z1)).toBe(true);   // inside the box
    expect(hitTestNode(f, 0, 0, Z1)).toBe(true);      // l'angolo appartiene al box
    expect(hitTestNode(f, 100, 50, Z1)).toBe(true);   // l'angolo opposto
    expect(hitTestNode(f, 120, 25, Z1)).toBe(false);  // outside
    // Any corner radius does not shrink the frame's hit area.
    expect(hitTestNode({ ...f, cornerRadius: 40 }, 2, 2, Z1)).toBe(true);
  });

  it("frame: a degenerate box is not hittable, like any other shape", () => {
    const f: NodeLite = { ...node("rect"), kind: "frame", width: 0, height: 0 };
    expect(hitTestNode(f, 0, 0, Z1)).toBe(false);
  });

  it("ellipse: center hits, corner misses", () => {
    const e = node("ellipse");
    expect(hitTestNode(e, 50, 25, Z1)).toBe(true);
    expect(hitTestNode(e, 4, 2, Z1)).toBe(false);               // <- the case the AABB got wrong
    expect(hitTestNode(e, 99, 25, Z1)).toBe(true);              // estremo dell'asse maggiore
  });

  it("handles zero-size nodes without dividing by zero", () => {
    const z = { ...node("ellipse"), width: 0, height: 0 };
    expect(hitTestNode(z, 0, 0, Z1)).toBe(false);
    // A shape whose INK IS THE BOX (rect, ellipse) stays unhittable
    // when degenerate: there is nothing drawn to hit, and drawScene discards it
    // with the same guard. The exemptions below -- text and vector -- are
    // the two cases in which the ink is NOT the box.
    expect(hitTestNode({ ...node("rect"), height: 0 }, 50, 0, Z1)).toBe(false);
  });

  it("text: hits the whole bounding box, not the glyphs", () => {
    const t: NodeLite = {
      ...node("rect"), kind: "text",
      text: { content: "a  b", style: { fontFamily: "", fontSize: 16, fontWeight: "", lineHeight: 0, align: "left" } },
    };
    expect(hitTestNode(t, 50, 25, Z1)).toBe(true);   // inside the box, between two glyphs
    expect(hitTestNode(t, 99, 49, Z1)).toBe(true);   // corner of the box, well past the text
    expect(hitTestNode(t, 101, 25, Z1)).toBe(false); // outside the box
  });

  it("text: empty content is still hittable on its box", () => {
    // A just-created text node is empty: if it were not selectable
    // the user could no longer reach it from the canvas.
    const t: NodeLite = {
      ...node("rect"), kind: "text",
      text: { content: "", style: { fontFamily: "", fontSize: 0, fontWeight: "", lineHeight: 0, align: "left" } },
    };
    expect(hitTestNode(t, 50, 25, Z1)).toBe(true);
  });

  it("text: a node whose height the layout has not produced yet is hittable on one line", () => {
    // The same node that drawScene draws anyway (canvasRenderer.ts): if
    // hit-test discarded it for height 0, the just-created text would be
    // visible but impossible to click. The minimum is one line: 16 * 1.2.
    const t = textNode({ height: 0 });
    expect(hitTestNode(t, 50, 0, Z1)).toBe(true);
    expect(hitTestNode(t, 50, 19, Z1)).toBe(true);
    expect(hitTestNode(t, 50, 20, Z1)).toBe(false);   // below the line, outside again
  });

  it("text: a caret-sized node keeps a click target on both axes", () => {
    // width 0 = no wrap width: the model's box is a point, but
    // the caret on screen is not.
    const t = textNode({ width: 0, height: 0 }, "");
    expect(hitTestNode(t, 0, 0, Z1)).toBe(true);
    expect(hitTestNode(t, 19, 19, Z1)).toBe(true);
    expect(hitTestNode(t, 20, 19, Z1)).toBe(false);
  });

  it("text: a missing text payload falls back to the renderer defaults", () => {
    // State that toNodeLite does not produce, but hit-test must not blow up.
    const t: NodeLite = { ...node("rect"), kind: "text", width: 0, height: 0 };
    expect(hitTestNode(t, 5, 5, Z1)).toBe(true);
    expect(hitTestNode(t, 25, 5, Z1)).toBe(false);
  });

  it("text: a box larger than one line is not shrunk to it", () => {
    expect(hitTestNode(textNode(), 99, 49, Z1)).toBe(true);
  });
});

// The vector is the second case in which the ink is not the box, and for a
// different reason than text: the box is the EXACT bbox of the geometry
// (proto invariant), so a zero axis is not a transient state but
// the right value -- a horizontal segment, or the path of a single anchor
// just placed by the pen tool. The box is not the TARGET either: the
// ink is hit, that is the fill of a closed outline or the
// proximity to the curve of an open one.
describe("hitTestNode: vector", () => {
  const SEGMENT: SubPathLite[] = [{
    anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 40, y: 0 })], closed: false,
  }];
  const SQUARE: SubPathLite[] = [{
    anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 100, y: 0 }),
      anchor({ x: 100, y: 50 }), anchor({ x: 0, y: 50 })],
    closed: true,
  }];

  it("an OPEN outline is hit by proximity, even with a degenerate axis", () => {
    const line = vectorNode(SEGMENT, { width: 40, height: 0 });
    expect(hitTestNode(line, 20, 0, Z1)).toBe(true);
    expect(hitTestNode(line, 20, 4, Z1)).toBe(true);    // within the grab tolerance
    expect(hitTestNode(line, 20, -4, Z1)).toBe(true);   // it is grabbed from above as from below
    expect(hitTestNode(line, 20, 10, Z1)).toBe(false);
    // Beyond the segment's end: the grab wraps the curve, not its line.
    expect(hitTestNode(line, 60, 0, Z1)).toBe(false);
  });

  it("the tolerance is in SCREEN px: the same world distance changes outcome with the zoom", () => {
    // It is the reason hitTestNode knows the zoom. At zoom 4 a distance
    // of 2 world units is 8 px on screen, well beyond the 5 of the grab; at zoom
    // 1 it is 2 px and the line is grabbed. With a tolerance in world units the
    // same line would be impossible to hit at zoom 0.1 and half a
    // screen wide at zoom 64.
    const line = vectorNode(SEGMENT, { width: 40, height: 0 });
    expect(hitTestNode(line, 20, 2, 1)).toBe(true);
    expect(hitTestNode(line, 20, 2, 4)).toBe(false);
    expect(hitTestNode(line, 20, 15, 0.25)).toBe(true);   // 15 world units = 3.75 px
    expect(hitTestNode(line, 20, 25, 0.25)).toBe(false);  // 25 world units = 6.25 px
    // The threshold is exactly VECTOR_HIT_PX screen px, at any zoom.
    for (const zoom of [0.5, 1, 3]) {
      expect(hitTestNode(line, 20, (VECTOR_HIT_PX - 0.01) / zoom, zoom)).toBe(true);
      expect(hitTestNode(line, 20, (VECTOR_HIT_PX + 0.01) / zoom, zoom)).toBe(false);
    }
  });

  it("anchors are LOCAL: the target moves with the node's origin", () => {
    const line = vectorNode(SEGMENT, { x: 100, y: 50, width: 40, height: 0 });
    expect(hitTestNode(line, 120, 50, Z1)).toBe(true);
    expect(hitTestNode(line, 20, 0, Z1)).toBe(false);   // where it was before moving it
  });

  it("a CLOSED outline is hit on the fill AND on its stroke", () => {
    const v = vectorNode(SQUARE);
    expect(hitTestNode(v, 50, 25, Z1)).toBe(true);
    // A closed outline is also stroked, so it has the same grab as an
    // open one around the curve: the target is the INK, and the stroke extends
    // beyond the fill.
    expect(hitTestNode(v, 103, 25, Z1)).toBe(true);
    expect(hitTestNode(v, 50, 53, Z1)).toBe(true);
    // The grab remains a grab: beyond VECTOR_HIT_PX the click goes back to the shapes
    // underneath.
    expect(hitTestNode(v, 110, 25, Z1)).toBe(false);
    expect(hitTestNode(v, 50, 60, Z1)).toBe(false);
  });

  it("a CLOSED outline of ZERO AREA stays visible and hittable", () => {
    // The pen tool gets there in three clicks: A, B, A again to close. The
    // outline goes A->B->A, even-odd fills nothing, and without the stroke
    // the node would vanish from the canvas and stop being clickable at the
    // very instant the user closes it.
    const flat = vectorNode([{
      anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 40, y: 0 })], closed: true,
    }], { width: 40, height: 0 });
    expect(hitTestNode(flat, 20, 0, Z1)).toBe(true);
    expect(hitTestNode(flat, 20, 4, Z1)).toBe(true);
    expect(hitTestNode(flat, 20, 10, Z1)).toBe(false);
    // And the same for a closed outline of ALIGNED anchors, which has three
    // points but zero area anyway.
    const collinear = vectorNode([{
      anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 20, y: 0 }), anchor({ x: 40, y: 0 })],
      closed: true,
    }], { width: 40, height: 0 });
    expect(hitTestNode(collinear, 30, 0, Z1)).toBe(true);
    expect(hitTestNode(collinear, 30, 10, Z1)).toBe(false);
  });

  it("an OPEN outline does not fill: the interior stays with the shapes underneath", () => {
    const u = vectorNode([{ ...SQUARE[0], closed: false }]);
    expect(hitTestNode(u, 50, 25, Z1)).toBe(false);
    expect(hitTestNode(u, 50, 1, Z1)).toBe(true);   // on the top side, which does exist
  });

  it("an outline of ONE anchor (the pen tool's first click) is hittable", () => {
    const dot = vectorNode([{ anchors: [anchor({ x: 0, y: 0 })], closed: false }], { width: 0, height: 0 });
    expect(hitTestNode(dot, 0, 0, Z1)).toBe(true);
    expect(hitTestNode(dot, 3, 0, Z1)).toBe(true);
    expect(hitTestNode(dot, 10, 10, Z1)).toBe(false);
  });

  it("absent or empty geometry: no ink, nothing to hit", () => {
    // No fallback to the box: a node that draws nothing must not even
    // steal clicks from the shapes beneath. It stays reachable from the
    // layers panel, which is the only place where something is still left to touch.
    expect(hitTestNode(vectorNode([]), 50, 25, Z1)).toBe(false);
    const noPayload: NodeLite = { ...node("rect"), kind: "vector" };
    expect(hitTestNode(noPayload, 50, 25, Z1)).toBe(false);
  });
});

describe("hasInk", () => {
  it("is false ONLY for a vector with no anchors, and agrees with hit-test", () => {
    // The predicate the marquee uses to not take what is not seen
    // (tools/selectTool.ts::nodesInMarquee). The agreement with hitTestNode is the
    // property that matters: where hasInk is false, the click does not hit.
    const empty = vectorNode([]);
    expect(hasInk(empty)).toBe(false);
    expect(hitTestNode(empty, 50, 25, Z1)).toBe(false);
    expect(hasInk(vectorNode([{ anchors: [], closed: true }]))).toBe(false);
    const noPayload: NodeLite = { ...node("rect"), kind: "vector" };
    expect(hasInk(noPayload)).toBe(false);

    // A DEGENERATE path (a single anchor) has ink indeed: it is seen and
    // clicked, so the marquee must be able to take it.
    const dot = vectorNode([{ anchors: [anchor({ x: 0, y: 0 })], closed: false }],
      { width: 0, height: 0 });
    expect(hasInk(dot)).toBe(true);
    expect(hitTestNode(dot, 0, 0, Z1)).toBe(true);

    // Shapes whose ink IS the box do not go through here: their degenerate
    // case is M1 behavior and is not changed by this track.
    expect(hasInk(node("rect"))).toBe(true);
    expect(hasInk({ ...node("rect"), height: 0 })).toBe(true);
    expect(hasInk(textNode())).toBe(true);
  });
});

// Path2D does not exist under jsdom: a double that RECORDS the commands makes
// the exact shape of the path verifiable, which is the only thing that matters here.
class RecordingPath2D {
  calls: string[] = [];
  moveTo(x: number, y: number) { this.calls.push(`M ${x} ${y}`); }
  lineTo(x: number, y: number) { this.calls.push(`L ${x} ${y}`); }
  bezierCurveTo(a: number, b: number, c: number, d: number, e: number, f: number) {
    this.calls.push(`C ${a} ${b} ${c} ${d} ${e} ${f}`);
  }
  closePath() { this.calls.push("Z"); }
}

function callsOf(p: Path2D | null): string[] | null {
  return p ? (p as unknown as RecordingPath2D).calls : null;
}

describe("vectorPaths", () => {
  beforeEach(() => { vi.stubGlobal("Path2D", RecordingPath2D); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("an OPEN outline goes into the STROKE path, without closePath", () => {
    // Origin (100, 50), local anchors, handles relative to the anchor:
    // all different and non-zero, so a skipped sum does not fall by chance on the
    // right value.
    const n = vectorNode([{
      anchors: [anchor({ x: 10, y: 0, outX: 5, outY: -3 }), anchor({ x: 30, y: 20, inX: -7, inY: 2 })],
      closed: false,
    }], { x: 100, y: 50 });
    const { fill, stroke } = vectorPaths(n);
    expect(fill).toBeNull();
    expect(callsOf(stroke)).toEqual([
      "M 110 50",
      // outgoing control = origin + anchor + handle = (115, 47);
      // incoming control = (123, 72); arrival = (130, 70).
      "C 115 47 123 72 130 70",
    ]);
  });

  it("a CLOSED outline goes into BOTH paths, with the return and the closePath", () => {
    const n = vectorNode([{
      anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 10, y: 0 }), anchor({ x: 10, y: 10 })],
      closed: true,
    }]);
    const { fill, stroke } = vectorPaths(n);
    // The last -> first return segment is a CURVE like the others (its
    // handles exist), so it is drawn explicitly; closePath after it adds no
    // length -- it serves to close the outline for the fill.
    const shape = [
      "M 0 0",
      "C 0 0 10 0 10 0",
      "C 10 0 10 10 10 10",
      "C 10 10 0 0 0 0",
      "Z",
    ];
    expect(callsOf(fill)).toEqual(shape);
    // ...and into the STROKE too: a closed outline does not necessarily have area, and the
    // stroke is what keeps it from vanishing when it does not.
    expect(callsOf(stroke)).toEqual(shape);
  });

  it("a CLOSED outline of ZERO AREA is stroked anyway", () => {
    // A -> B -> A: the fill paints nothing (even-odd contains
    // no point), the stroke does. Without it, the pen tool would make the node vanish
    // at the click that closes it.
    const n = vectorNode([{
      anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 40, y: 0 })], closed: true,
    }]);
    const { fill, stroke } = vectorPaths(n);
    const shape = ["M 0 0", "C 0 0 40 0 40 0", "C 40 0 0 0 0 0", "Z"];
    // The fill is there (the predicate is true) but paints nothing: it is the stroke that
    // makes the path visible, and that is why it must be there.
    expect(callsOf(fill)).toEqual(shape);
    expect(callsOf(stroke)).toEqual(shape);
  });

  it("an anchor without handles gives a bezier with the controls on the endpoints (the straight line)", () => {
    const n = vectorNode([{
      anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 40, y: 0 })], closed: false,
    }]);
    // No branch for "absent handle": it is the reason handles are
    // relative, and the canvas draws exactly the segment.
    expect(callsOf(vectorPaths(n).stroke)).toEqual(["M 0 0", "C 0 0 40 0 40 0"]);
  });

  it("open and closed outlines in the same node end up in DIFFERENT paths", () => {
    const n = vectorNode([
      { anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 10, y: 0 }), anchor({ x: 0, y: 10 })], closed: true },
      { anchors: [anchor({ x: 50, y: 0 }), anchor({ x: 50, y: 30 })], closed: false },
    ]);
    const { fill, stroke } = vectorPaths(n);
    // Only one of the two fills: if the open one ended up in the FILL path the
    // canvas would implicitly close it and fill it. In the stroke instead
    // both are there, and the order is that of the outlines.
    expect(callsOf(fill)?.filter((c) => c === "Z")).toEqual(["Z"]);
    expect(callsOf(stroke)).toEqual([
      "M 0 0", "C 0 0 10 0 10 0", "C 10 0 0 10 0 10", "C 0 10 0 0 0 0", "Z",
      "M 50 0", "C 50 0 50 30 50 30",
    ]);
  });

  it("a single-anchor outline is a POINT in the outline path", () => {
    // The lineTo onto itself has no length but with a round lineCap the canvas draws
    // it: it is the dot the pen tool leaves after the first click. Without it,
    // the just-born node would be invisible until the second arrives.
    const n = vectorNode([{ anchors: [anchor({ x: 7, y: 9 })], closed: false }]);
    expect(callsOf(vectorPaths(n).stroke)).toEqual(["M 7 9", "L 7 9"]);
    // `closed` changes nothing: a point has no area to fill.
    const c = vectorNode([{ anchors: [anchor({ x: 7, y: 9 })], closed: true }]);
    expect(vectorPaths(c).fill).toBeNull();
    expect(callsOf(vectorPaths(c).stroke)).toEqual(["M 7 9", "L 7 9"]);
  });

  it("absent or empty geometry: no path (not an empty path)", () => {
    expect(vectorPaths(vectorNode([]))).toEqual({ fill: null, stroke: null });
    expect(vectorPaths(vectorNode([{ anchors: [], closed: true }]))).toEqual({ fill: null, stroke: null });
    const noPayload: NodeLite = { ...node("rect"), kind: "vector" };
    expect(vectorPaths(noPayload)).toEqual({ fill: null, stroke: null });
  });
});

// --- images (track 3) --------------------------------------------------------
//
// An image is hit and drawn on its BOX, exactly like a
// rectangle: no dedicated branch in shapes.ts, and it is intended -- but it must be ASSERTED,
// because it is the reason adding a node type did not require
// touching either hit-test or the geometry.

function imageNode(over: Partial<NodeLite> = {}): NodeLite {
  return { ...node("rect"), kind: "image", image: { assetHash: "abc" }, ...over };
}

describe("hitTestNode: images", () => {
  it("hits on the box, edges included", () => {
    expect(hitTestNode(imageNode(), 50, 25, Z1)).toBe(true);
    expect(hitTestNode(imageNode(), 0, 0, Z1)).toBe(true);
    expect(hitTestNode(imageNode(), 100, 50, Z1)).toBe(true);
    expect(hitTestNode(imageNode(), 101, 25, Z1)).toBe(false);
  });

  it("an image without area is neither hit nor painted", () => {
    // Text is the only exception (its height is produced by layout):
    // an image without area leaves no pixels, so it must not steal clicks.
    expect(isPaintable(imageNode({ height: 0 }))).toBe(false);
    expect(hitTestNode(imageNode({ height: 0 }), 50, 0, Z1)).toBe(false);
    expect(isPaintable(imageNode())).toBe(true);
  });

  it("a MISSING asset stays selectable: the placeholder is a node like the others", () => {
    // Without this, an image whose file has vanished would become impossible
    // to select and therefore to delete.
    expect(hitTestNode(imageNode({ image: { assetHash: "" } }), 50, 25, Z1)).toBe(true);
  });
});

// --- the STROKE is hittable --------------------------------------------------
//
// The stroke is painted pixels like the fill: what is seen must be
// clickable. An OUTSIDE stroke of 20 on a rectangle draws a band
// 20 wide all around, and without this the only way to grab it would be
// to hit the shape -- precisely the edge, which is the part one aims at when
// wanting to move a shape without a fill, would remain clickable on empty space.
describe("hitTestNode with the stroke", () => {
  function withStroke(n: NodeLite, weight: number, align: "center" | "inside" | "outside"): NodeLite {
    return { ...n, strokes: [{ color: { r: 0, g: 0, b: 0, a: 1 }, weight, align }] };
  }

  it("rect: an OUTSIDE stroke is hit across its whole width", () => {
    const r = withStroke(node("rect"), 20, "outside");
    expect(hitTestNode(r, -19, 25, Z1)).toBe(true);   // inside the band
    expect(hitTestNode(r, -20, 25, Z1)).toBe(true);   // on its outer edge
    expect(hitTestNode(r, -21, 25, Z1)).toBe(false);  // just beyond
  });

  it("rect: a CENTERED stroke overhangs by half the weight", () => {
    const r = withStroke(node("rect"), 20, "center");
    expect(hitTestNode(r, -10, 25, Z1)).toBe(true);
    expect(hitTestNode(r, -11, 25, Z1)).toBe(false);
  });

  it("rect: an INSIDE stroke does not widen the target by a pixel", () => {
    const r = withStroke(node("rect"), 20, "inside");
    expect(hitTestNode(r, -1, 25, Z1)).toBe(false);
    expect(hitTestNode(r, 0, 25, Z1)).toBe(true);
  });

  it("ellipse: the band grows on the RADII, not on the AABB (the corner stays a miss)", () => {
    const e = withStroke(node("ellipse"), 20, "outside");
    // End of the major axis + the whole weight.
    expect(hitTestNode(e, 119, 25, Z1)).toBe(true);
    expect(hitTestNode(e, 121, 25, Z1)).toBe(false);
    // And the corner of the WIDENED containing rectangle stays outside: an ellipse's
    // stroke is a ring, not a square frame.
    expect(hitTestNode(e, -19, -9, Z1)).toBe(false);
  });

  it("takes the stroke that overhangs the most, not the last one nor the sum", () => {
    const r: NodeLite = { ...node("rect"), strokes: [
      { color: { r: 0, g: 0, b: 0, a: 1 }, weight: 20, align: "outside" },
      { color: { r: 0, g: 0, b: 0, a: 1 }, weight: 2, align: "center" },
    ] };
    expect(hitTestNode(r, -20, 25, Z1)).toBe(true);
    expect(hitTestNode(r, -21, 25, Z1)).toBe(false);
  });

  it("the band turns with the node (it is in LOCAL space, not the screen's)", () => {
    const r = { ...withStroke(node("rect"), 20, "outside"), rotation: 90 };
    // At rest the rect occupies x∈[0,100], y∈[0,50] and the stroke reaches x=-20.
    // At 90° around the center (50,25) that band ends up BELOW: y=95.
    expect(hitTestNode(r, 50, 94, Z1)).toBe(true);
    expect(hitTestNode(r, 50, 96, Z1)).toBe(false);
    expect(hitTestNode(r, -19, 25, Z1)).toBe(false); // where it was at rest: now it is empty
  });

  it("a zero weight leaves the target exactly as it was", () => {
    const r = withStroke(node("rect"), 0, "outside");
    expect(hitTestNode(r, -1, 25, Z1)).toBe(false);
    expect(hitTestNode(r, 0, 25, Z1)).toBe(true);
  });

  it("a DEGENERATE shape with a stroke stays unhittable", () => {
    // No perimeter to stroke: the renderer discards it with the same
    // guard, and hit-test must not invent a 40x40 target around
    // a node that is not seen.
    const z = withStroke({ ...node("rect"), width: 0, height: 0 }, 20, "outside");
    expect(hitTestNode(z, 0, 0, Z1)).toBe(false);
  });
});

// --- rotation ----------------------------------------------------------------
// The test point is brought into the node's LOCAL space (inverse rotation
// around the box CENTER, see canvas/transform.ts) BEFORE
// testing the shape: so a rotated ellipse keeps being hit as an ellipse, and
// not by its containing rectangle. The nodes here are 100x50 at the origin,
// center (50, 25).
describe("hitTestNode with rotation", () => {
  it("ellipse: the rotated end of the major axis hits, its own AABB corner still misses", () => {
    const e = { ...node("ellipse"), rotation: 90 };
    // (99,25) was the major axis's end at rest: at 90° that local point
    // ends up at (50,74) and the extremity is NO longer where it was.
    expect(hitTestNode(e, 50, 74, Z1)).toBe(true);
    expect(hitTestNode(e, 99, 25, Z1)).toBe(false);
    // The case the AABB got wrong, rotated: the corner of the containing
    // rectangle of the rotated shape (which is now 100 tall and 50 wide) stays
    // outside the ellipse.
    expect(hitTestNode(e, 27, -23, Z1)).toBe(false);
    expect(hitTestNode(e, 50, 25, Z1)).toBe(true); // the center is fixed, always
  });

  it("ellipse: a 45 degree rotation still misses the four corners of its AABB", () => {
    const e = { ...node("ellipse"), width: 100, height: 100, rotation: 45 };
    // A rotated circle is itself: the box's corners stay outside.
    expect(hitTestNode(e, 4, 2, Z1)).toBe(false);
    expect(hitTestNode(e, 96, 98, Z1)).toBe(false);
    expect(hitTestNode(e, 50, 50, Z1)).toBe(true);
  });

  it("rect: hits where the shape actually IS, not where its unrotated box was", () => {
    const r = { ...node("rect"), rotation: 90 };
    // At 90° the rectangle occupies x in [25,75] and y in [-25,75].
    expect(hitTestNode(r, 50, 70, Z1)).toBe(true);   // outside the resting box, inside the rotated one
    expect(hitTestNode(r, 90, 25, Z1)).toBe(false);  // inside the resting box, outside the rotated one
  });

  it("text: its box rotates with the node too", () => {
    const t = textNode({ rotation: 90 });
    expect(hitTestNode(t, 50, 70, Z1)).toBe(true);
    expect(hitTestNode(t, 90, 25, Z1)).toBe(false);
  });

  it("a full turn is indistinguishable from no rotation", () => {
    expect(hitTestNode({ ...node("ellipse"), rotation: 360 }, 99, 25, Z1)).toBe(true);
    expect(hitTestNode({ ...node("ellipse"), rotation: 360 }, 4, 2, Z1)).toBe(false);
  });

  it("a degenerate shape stays unhittable however it is rotated", () => {
    expect(hitTestNode({ ...node("ellipse"), width: 0, height: 0, rotation: 30 }, 0, 0, Z1)).toBe(false);
  });
});
