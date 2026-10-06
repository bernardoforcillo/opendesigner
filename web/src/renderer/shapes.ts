import type { NodeLite, SubPathLite } from "../store/types";
import { boundsOfNode, inflateBounds, strokeOutsetOfNode } from "../canvas/geometry";
import { centerOf, worldToLocal, type Point } from "../canvas/transform";
import {
  anchorPoint, inHandlePoint, outHandlePoint, subpathFills, hitVectorGeometry,
  hasAnyAnchor,
} from "../store/vectorGeometry";
import { lineHeightOf } from "./text";

// The center around which the node ROTATES: the center of its UNROTATED box.
// A single function, used by the renderer (which applies ctx.rotate around it) and
// by hit-test (which applies the inverse rotation around it): the convention of
// canvas/transform.ts holds only if the two read it from the same place.
export function nodeCenter(n: NodeLite): Point {
  return centerOf(boundsOfNode(n));
}

// Builds the node's Path2D in world coordinates (no camera transform
// here: the camera is applied by the caller via ctx.setTransform).
//
// The path is the UNROTATED one: rotation is a context transform
// (drawScene applies it around nodeCenter), not a different geometry --
// so the path stays the same object for any angle and hit-test can
// mirror it by bringing the point into local space.
//
// The vector does NOT go through here: its geometry splits into two paths
// (see vectorPaths below) and drawScene diverts it earlier, as it already does with
// text. The fallback to the rectangle at the bottom applies to shapes whose
// ink is the box -- including the "unknown" ones from other tracks, which
// this side can only treat as a rectangle.
export function nodePath(n: NodeLite): Path2D {
  const path = new Path2D();
  if (n.kind === "ellipse") {
    const cx = n.x + n.width / 2;
    const cy = n.y + n.height / 2;
    const rx = n.width / 2;
    const ry = n.height / 2;
    path.ellipse(cx, cy, rx, ry, 0, 0, 2 * Math.PI);
  // The corner radius belongs to the RECTANGLE: a FRAME is rectangular by definition
  // (it is the artboard) and is drawn with sharp corners even if it carries a
  // cornerRadius -- written by someone who does not know, or by a document from another
  // version. The condition on kind keeps it explicit instead of relying on the
  // fact that a frame usually has cornerRadius 0.
  } else if (n.kind === "rect" && n.cornerRadius > 0) {
    path.roundRect(n.x, n.y, n.width, n.height, n.cornerRadius);
  } else {
    path.rect(n.x, n.y, n.width, n.height);
  }
  return path;
}

// "Does this node leave any pixels?" -- independently of `visible`, which is a
// user choice, while this is a property of the GEOMETRY. A degenerate
// shape (width or height <= 0) has nothing to fill.
//
// The guard does NOT apply to text: the height of a text node is produced by
// layout (and the width is only the wrap width), so a just-created text
// can have height 0 while being drawn.
//
// It lives here, in a single function, because the same rule is needed in three places
// that must stay in agreement: whoever draws (drawScene), whoever hits
// (hitTestNode) and whoever computes the region to export (export/region.ts). A
// third copy of the predicate would be the usual pair destined to diverge --
// and a divergence here shows up as "the export cropped the image around
// an invisible node".
export function isPaintable(n: NodeLite): boolean {
  return n.kind === "text" || (n.width > 0 && n.height > 0);
}

// True when the node's INK is its box, that is when a degenerate box
// truly means "nothing to draw and nothing to hit". It applies to rect and
// ellipse (and to an unknown shape, which this side can only treat as a
// rectangle), NOT to text and vector:
//   - text has its height produced by layout, so a just-created node has
//     height 0 and is drawn anyway;
//   - the vector has its ink in the anchors, and by the proto's
//     invariant the box is the EXACT bbox of the geometry -- so a single-point
//     path (the pen tool after the first click) or a horizontal segment
//     legitimately have a zero side. Discarding them here would make them invisible AND
//     unclickable: reachable only from the layers panel, deletable only
//     from there.
// Exported because drawScene (canvasRenderer.ts) must make the SAME choice: two
// lists of exceptions would diverge at the first type added.
export function inkIsBox(n: NodeLite): boolean {
  return n.kind !== "text" && n.kind !== "vector";
}

// True when the node paints something, that is when a target exists to
// select. It serves the MARQUEE (tools/selectTool.ts::nodesInMarquee), which
// works on bounds and would not notice on its own: a vector with
// no anchors still keeps the width/height it had, so a
// selection rectangle would take it even though it is the only state in which the
// node produces no Path2D (vectorPaths) and no hit (hitTestNode).
// Selecting with the marquee something that is not seen and cannot be clicked is
// exactly the surprise to avoid.
//
// It discriminates the VECTOR only, on purpose: for shapes whose ink IS
// the box the analogous case is the degenerate box, which is M1 behavior shared
// with the other tracks and is not changed from here.
export function hasInk(n: NodeLite): boolean {
  if (n.kind !== "vector") return true;
  return hasAnyAnchor(n.vector?.subpaths ?? []);
}

// --- the vector path ---------------------------------------------------------

// Grab distance from an OPEN outline, in SCREEN px: a thin line
// must be equally easy to grab at every zoom, so the tolerance
// lives in px and is divided by the zoom at the time of use.
//
// 5 px is in the same family as the project's other pointing thresholds
// -- a resize handle's little square is grabbed within 6 px of the center
// (HANDLE_SIZE/2 + HANDLE_GRAB_PADDING, selection/handles.ts) and a marquee
// becomes a click under 3 px -- and it is the measure that is needed: generous
// enough to catch a 1.5 px line without hunting for the pixel,
// narrow enough that two strokes 10 px from each other remain
// separately selectable.
export const VECTOR_HIT_PX = 5;

// Maximum deviation (SCREEN px) between the true curve and the polyline on which the
// distance is measured. A quarter of a pixel: below the threshold of what is seen and of what
// can be pointed at, and twenty times finer than the grab above --
// so flattening cannot perceptibly move the boundary between
// "hit" and "missed". Finer than that and we would pay for more segments for a
// difference nobody can observe.
export const VECTOR_FLATTEN_PX = 0.25;

// Thickness (SCREEN px) with which EVERY outline is stroked. The model has no
// stroke paint: the color is that of the node's fill, the only tint it
// knows, so on an outline that fills the stroke is invisible (half a
// thickness more of shape, of the same color) and on one that does not fill --
// open, or closed but of zero area -- it is all there is on screen.
export const VECTOR_STROKE_PX = 1.5;

// The fill rule, EVEN-ODD, and the reason for the choice.
//
// With nonzero an inner outline is a hole only if traversed in the OPPOSITE DIRECTION
// from the outer one. This model has no way to control the direction:
// there is no "reverse outline" op, and the pen tool produces the order in which the
// user clicked. A hole that depends on an invisible, uneditable property is a
// hole you cannot make on purpose -- and, worse, one that
// appears or vanishes depending on how you went around the shape.
//
// With even-odd only CONTAINMENT decides: an outline inside another is always
// a hole, and to remove it just move it outside. Predictable with the tools
// that exist.
//
// The value is ONE and it is shared by ctx.fill (canvasRenderer) and hit-test
// (vectorGeometry::pointInRingsEvenOdd): two different rules would give a hole
// that is seen but clicked.
export const VECTOR_FILL_RULE: CanvasFillRule = "evenodd";

// The two paths of a vector node, in WORLD coordinates. `stroke` contains
// ALL of them (every outline is stroked); `fill` only those that fill. They are two
// Path2Ds and not one because the canvas implicitly closes every outline that
// fills: an open outline put in the fill path would be filled
// as if it were closed, which is exactly what must not happen. `null`
// (not an empty Path2D) when there is nothing in that bucket, so the
// caller does not pay for an empty fill or stroke.
export interface VectorPaths { fill: Path2D | null; stroke: Path2D | null }

// Traces ONE outline on `p`: moveTo on the first anchor, then a
// bezierCurveTo for every DRAWN segment. The handles come from
// vectorGeometry (the two-space rule has a single implementation) and
// need no branches: an absent handle is (0,0), the control falls
// on the anchor and the bezier is the straight line.
export function traceSubpath(p: Path2D, n: NodeLite, sp: SubPathLite): void {
  const count = sp.anchors.length;
  const first = anchorPoint(n, sp.anchors[0]);
  p.moveTo(first.x, first.y);
  if (count === 1) {
    // A single anchor (the pen tool after the first click): a segment of
    // zero length, which with a round lineCap the canvas draws as a
    // dot. A bare moveTo would paint nothing, and the just-born node
    // would be invisible until the second click arrives.
    p.lineTo(first.x, first.y);
    return;
  }
  // Closed: there is also the last -> first return segment, and it is a curve
  // like the others (its handles exist), so it is drawn. The closePath
  // that follows adds no length: it closes the outline.
  const segments = sp.closed ? count : count - 1;
  for (let i = 0; i < segments; i++) {
    const a = sp.anchors[i];
    const b = sp.anchors[(i + 1) % count];
    const c1 = outHandlePoint(n, a);
    const c2 = inHandlePoint(n, b);
    const to = anchorPoint(n, b);
    p.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, to.x, to.y);
  }
  if (sp.closed) p.closePath();
}

export function vectorPaths(n: NodeLite): VectorPaths {
  let fill: Path2D | null = null;
  let stroke: Path2D | null = null;
  for (const sp of n.vector?.subpaths ?? []) {
    if (sp.anchors.length === 0) continue;
    // EVERY outline is stroked, closed or open. For an open outline it is
    // the only way to exist on screen; for a closed one it is what
    // keeps it from vanishing when the fill paints nothing -- and
    // `closed` does NOT imply area: two closed anchors go A->B->A and three
    // aligned anchors a squashed polyline, two states the pen tool
    // reaches with three clicks. Without a stroke that path would become invisible and
    // unclickable the instant the user closes it.
    stroke ??= new Path2D();
    traceSubpath(stroke, n, sp);
    // IN ADDITION, a closed outline with at least two anchors goes into the fill. The
    // predicate lives in vectorGeometry because it shares it with hit-test:
    // fill and hittable area must be the same thing.
    if (subpathFills(sp)) {
      fill ??= new Path2D();
      traceSubpath(fill, n, sp);
    }
  }
  return { fill, stroke };
}

// Minimum side (WORLD units) of the box on which the MARQUEE grabs a vector
// node. It is a SELECTION TOLERANCE, not a fact about the geometry: the
// model keeps telling the truth (vectorBounds is exact, and a horizontal
// segment really has height 0), but a zero-area box intersects nothing
// and would escape any marquee that does not strictly cross it.
//
// The CLICK no longer goes through here: since the path is actually drawn,
// hitTestNode hits the ink (proximity to the stroke, plus the fill of
// a closed outline) and has its own tolerance in screen px, VECTOR_HIT_PX.
// This one stays in world units because nodesInMarquee (tools/selectTool.ts)
// works on bounds and does not know the camera -- and it is the reason the two
// tolerances are, and must remain, two different numbers.
export const VECTOR_MIN_GRAB = 4;

// The box on which the MARQUEE grabs a node, which is not always the
// model's box. It is NOT (any longer) the click's target: since the path is drawn
// for real, hitTestNode hits the ink -- even-odd fill and
// proximity to the stroke -- and does not go through here.
//
// The two doors CANNOT be the same function: the click's grab is in
// SCREEN px (VECTOR_HIT_PX) because a line must be grabbed the same way at
// every zoom, while the marquee compares bounds in WORLD coordinates and does not
// know the camera. They stay in agreement where it matters, though -- which is "a node that is not
// seen and not clicked must not even be taken by the marquee": it is
// guaranteed by the `hasInk` filter in tools/selectTool.ts::nodesInMarquee, not
// by this box. Below there is only the tolerance for the degenerate axis, which is a
// case in which the node does have ink.
export function selectionBoundsOfNode(n: NodeLite): Box {
  if (n.kind !== "vector") return { x: n.x, y: n.y, width: n.width, height: n.height };
  // Only the DEGENERATE axis widens, centered on the ink: a normal path
  // stays as it is (and does not steal clicks from shapes beneath), a horizontal segment
  // becomes grabbable from above as from below.
  const dw = Math.max(0, VECTOR_MIN_GRAB - n.width);
  const dh = Math.max(0, VECTOR_MIN_GRAB - n.height);
  return { x: n.x - dw / 2, y: n.y - dh / 2, width: n.width + dw, height: n.height + dh };
}

// Pure geometric hit-test (no ctx / DOM), so it stays testable in Node.
//
// (wx, wy) is the point in the SAME space as the node's coordinates, that is
// that of its PARENT: for a child of a page it is the world, for a
// nested node it is not. It is the caller (renderer/canvasRenderer.ts::hitTest) that
// brings it here by descending the tree -- there is no transform in here,
// exactly as nodePath draws in the ctx's current space.
//
// rect: inclusive AABB of the edges. ellipse: normalized equation
// ((wx-cx)/rx)^2 + ((wy-cy)/ry)^2 <= 1, which is the correct test (the ellipse's
// AABB includes the corners, which are outside the ellipse itself).
// The point arrives in WORLD coordinates and is brought into the node's LOCAL space
// (inverse rotation around nodeCenter) BEFORE testing the shape: it is
// the only way for a rotated ellipse to be hit as an ellipse instead of
// by its containing rectangle -- the same error that the normalized test
// below exists to avoid, but introduced by rotation.
//
// `zoom` serves the vector only, and it truly serves: the grab around an
// open outline is in SCREEN px (VECTOR_HIT_PX), so it must be converted to
// world units, and this is the only function that knows which node requires it.
// MANDATORY parameter and not with a default of 1: a default would make silent the
// case where a new caller forgets about the camera, and the
// symptom (a line that is badly grabbed only outside zoom 1) is one that
// nobody connects to the cause.
export function hitTestNode(n: NodeLite, wx: number, wy: number, zoom: number): boolean {
  // A GROUP is never hit directly: it has no geometry of its own (its
  // bounds are the union of the children, see store/groups.ts) and draws
  // nothing, so there is no pixel of its own under the pointer. Selecting it
  // is the job of the selection POLICY, which climbs the tree from the hit child
  // (groups.ts::selectionTargetOf) -- and it must be able to do so from a child, not from
  // an invisible rectangle that would steal clicks from what lies beneath.
  if (n.kind === "group") return false;
  // An INSTANCE is never hit on its own box: like a group it has no
  // geometry of its own (its content is the master, store/instances.ts). Hitting
  // it is the job of the virtual descent in canvasRenderer.ts::hitInstance, which
  // tries the master's subtree and answers with the instance's id. Without
  // this branch, an instance with the default (or inherited) box would steal clicks.
  if (n.kind === "instance") return false;
  // The size guard only applies to shapes whose ink IS the box
  // (see inkIsBox): text and vector pass through it even with a zero
  // side, exactly as in drawScene (canvasRenderer.ts).
  if (inkIsBox(n) && (n.width <= 0 || n.height <= 0)) return false;
  // Rotation (track 2): the point arrives in WORLD coordinates and must be brought
  // into the node's LOCAL space (inverse rotation around the center) before
  // testing the shape, or a rotated ellipse would be hit by its rectangle.
  const local = worldToLocal({ x: wx, y: wy }, nodeCenter(n), n.rotation);
  return hitTestLocal(n, local.x, local.y, zoom);
}

function hitTestLocal(n: NodeLite, wx: number, wy: number, zoom: number): boolean {
  // The stroke overhang WIDENS the target: what is seen must be
  // clickable, and a 20 outer stroke is a band 20 wide all around
  // the shape -- exactly the part one aims at to grab a shape by its
  // edge. The measure is canvas/geometry.ts's, the same that marquee
  // and export use: two different notions of "how far it overhangs" would give a
  // target that does not coincide with what is painted. The vector does not use it
  // (it has its own grab in VECTOR_HIT_PX), but the other shapes do.
  const outset = strokeOutsetOfNode(n);
  // Text is hit on its BOUNDING BOX, never on the glyphs: it is the
  // expected behavior in an editor (clicking between two letters, or in the
  // empty space right of a short line, selects the node anyway) and it is also
  // the only possible test without measuring the font. An explicit branch and not
  // implicit in the fallback: if one day the "rect" branch learned corner
  // radii, text must not follow it.
  if (n.kind === "text") return insideBox(inflateBounds(textHitBox(n), outset), wx, wy);
  // The vector is hit on the INK, never on the box: every outline by
  // proximity to the stroke within VECTOR_HIT_PX screen px (because every outline is
  // stroked), and in addition a closed outline over its whole fill -- with the
  // same even-odd rule with which it is painted, so a hole is a hole for the
  // click too. The box would be the wrong target in both directions: a "C"
  // half a screen wide would be hit by clicking in its void -- stealing the
  // click from everything inside it -- and a degenerate path would not be
  // hit at all.
  //
  // The point goes into LOCAL coordinates (a single subtraction, here): the
  // anchors are, and bringing them to world one by one would cost a sum for
  // every point of the polyline.
  if (n.kind === "vector") {
    return hitVectorGeometry(
      n.vector?.subpaths ?? [],
      wx - n.x, wy - n.y,
      VECTOR_HIT_PX / zoom,
      VECTOR_FLATTEN_PX / zoom,
    );
  }
  if (n.kind === "ellipse") {
    // The overhang is added to the RADII, not to the AABB: an ellipse's stroke is
    // a ring, not a square frame, so the corner of the widened
    // containing rectangle must remain a miss as the box's was.
    const cx = n.x + n.width / 2;
    const cy = n.y + n.height / 2;
    const rx = n.width / 2 + outset;
    const ry = n.height / 2 + outset;
    const nx = (wx - cx) / rx;
    const ny = (wy - cy) / ry;
    return nx * nx + ny * ny <= 1;
  }
  return insideBox(inflateBounds(boundsOfNode(n), outset), wx, wy);
}

export interface Box { x: number; y: number; width: number; height: number }

// The box on which a text node is hit, which does NOT always coincide with the model's
// box: height is produced by layout and width is only the wrap width,
// so a just-created node can have them at 0 while being drawn. A
// degenerate box is hit by no click (it would take wy exactly
// equal to n.y), so text gets the minimum that can be computed without a
// ctx: a line lineHeight tall and as wide -- the caret target of a
// still-empty text.
//
// It is on purpose an UNDERestimate when the text overflows its box: without
// measuring the font hit-test can err on the low side (the node stays
// reachable from the layers panel) but not on the high side, or it would steal clicks
// from the shapes beneath it.
function textHitBox(n: NodeLite): Box {
  const min = lineHeightOf(n.text?.style);
  return { x: n.x, y: n.y, width: Math.max(n.width, min), height: Math.max(n.height, min) };
}

function insideBox(b: Box, wx: number, wy: number): boolean {
  return wx >= b.x && wx <= b.x + b.width && wy >= b.y && wy <= b.y + b.height;
}
