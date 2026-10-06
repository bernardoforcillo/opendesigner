import type { AnchorLite, NodeLite, SubPathLite } from "./types";

// The ONLY reading of vector geometry. Renderer, hit-test, overlay and pen
// tool all go through here: the two-space rule (anchors LOCAL to the node,
// handles RELATIVE to the anchor) is written out in full in the proto on `Anchor`,
// and a second hand-written implementation somewhere is exactly how
// two sides of the same editor end up drawing two different paths.
//
// The module is pure and touches neither the camera nor the ctx: it only talks about
// WORLD coordinates, like the rest of the model. The camera remains canvas/camera.ts's business.

export interface PointLite { x: number; y: number }
export interface BoxLite { x: number; y: number; width: number; height: number }

// The node's origin: the zero of the anchors' local coordinates.
type Origin = Pick<NodeLite, "x" | "y">;

// L'ancoraggio in coordinate mondo.
export function anchorPoint(o: Origin, a: AnchorLite): PointLite {
  return { x: o.x + a.x, y: o.y + a.y };
}

// The two control points in world coordinates. Handles are OFFSETS
// relative to the anchor, so they add up twice: node origin +
// anchor + handle.
//
// No branch for "absent handle": (0,0) gives the control point
// COINCIDENT with the anchor, and a bezierCurveTo with the controls on the
// endpoints draws the straight line. It is the reason handles are relative --
// the most common case (a corner point) is the proto3 default and requires
// neither a flag nor a special case in the renderer.
export function inHandlePoint(o: Origin, a: AnchorLite): PointLite {
  return { x: o.x + a.x + a.inX, y: o.y + a.y + a.inY };
}

export function outHandlePoint(o: Origin, a: AnchorLite): PointLite {
  return { x: o.x + a.x + a.outX, y: o.y + a.y + a.outY };
}

// The path the PEN TOOL is drawing, in WORLD coordinates -- the node does not
// exist yet (the whole creation is ONE gesture and produces a SINGLE op at the end),
// so there is no origin to which the anchors could be local.
//
// It is the channel through which the tool talks to the OVERLAY: tools/penTool.ts writes it, the
// store keeps it next to the marquee (same shape: preview state in
// world coordinates that the overlay draws) and renderer/overlayRenderer.ts
// reads it. The geometry lives here and not in the tool because two modules
// read it, and this module is already the only place where a path is read.
export interface PenPreview {
  // The anchors already placed.
  readonly anchors: readonly AnchorLite[];
  // The RETURN segment (last -> first) is part of the preview: the
  // pointer is pressed on the first anchor and release will close the
  // outline. It is not a cosmetic detail -- that segment is drawn by the
  // INCOMING handle of the first anchor, which is exactly what the
  // closing drag is pulling (and which may have been decided
  // many clicks earlier, placing the first anchor with a drag):
  // without it, the user shapes a curve they cannot see until the node exists.
  readonly closed: boolean;
  // Where the next anchor would land: the overlay draws the segment that
  // follows the cursor there. null during a drag (the cursor is defining
  // a HANDLE, not a new point: drawing the pending segment would say
  // something false).
  readonly next: PointLite | null;
  // The index of the anchor whose handles are being dragged, or null
  // outside a drag. Only ITS handles are drawn: those of the
  // anchors already placed are decided geometry, and showing them all
  // would turn the preview into a spiderweb.
  readonly active: number | null;
}

// "Has a handle" = the offset is non-zero. It serves the overlay (a nonexistent
// handle is not drawn and cannot be grabbed) and the pen tool, not the
// path renderer -- see above: drawing does not need to distinguish.
export function hasInHandle(a: AnchorLite): boolean {
  return a.inX !== 0 || a.inY !== 0;
}

export function hasOutHandle(a: AnchorLite): boolean {
  return a.outX !== 0 || a.outY !== 0;
}

// The value of a Bézier cubic on ONE axis, at parameter t.
function cubicAt(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

// The TRUE extrema of a cubic on an axis: the two endpoints, plus the points where the
// derivative vanishes INSIDE the segment.
//
// B'(t)/3 = a·t² + b·t + c with a = -p0+3p1-3p2+p3, b = 2(p0-2p1+p2), c = p1-p0.
// a === 0 is not an edge case to tolerate but the COMMON case (a handle
// mirrored to the other makes the derivative linear), so it has its own branch instead
// of dividing by zero. Only roots in (0,1) count: outside the interval
// the cubic is not drawn, and it is exactly the control-point-hull error --
// taking as good an extremum the curve does not reach.
function addCubicExtrema(
  p0: number, p1: number, p2: number, p3: number,
  push: (v: number) => void,
): void {
  push(p0);
  push(p3);
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const roots: number[] = [];
  if (a === 0) {
    if (b !== 0) roots.push(-c / b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      roots.push((-b + s) / (2 * a), (-b - s) / (2 * a));
    }
  }
  for (const t of roots) if (t > 0 && t < 1) push(cubicAt(p0, p1, p2, p3, t));
}

// The bbox of the geometry in LOCAL coordinates (same space as the anchors).
//
// It is the TRUE bbox of the ink, not the control-point hull. The
// difference is not cosmetic: for A=(0,0) out=(100,0) -> B=(0,100) in=(100,0)
// the hull gives maxX=100 while the curve reaches 75, 33% of empty box. And the
// node's box is what the overlay draws the 8 handles on and what the marquee
// selects on (tools/selectTool.ts::nodesInMarquee), so erring on the side of excess
// is NOT the harmless direction: it means handles that do not touch the path and a marquee that
// grabs a node without ever grazing its ink. The proto declares this box
// "the local bbox of the geometry" and now it truly is.
//
// Only DRAWN segments count: in an open outline the incoming handle of the
// first anchor and the outgoing one of the last belong to no
// segment (a pen tool that keeps mirrored handles at the ends has them
// set anyway), so they do not enter the box. In a closed outline instead the
// last->first return segment exists, and then both count.
//
// An outline with a SINGLE anchor has no segments: only the point contributes,
// not its handles -- there is no curve that uses them.
//
// Empty geometry => degenerate box at (0,0): a path without anchors has no
// position, and inventing one for it would be worse. The degenerate box is a
// legitimate value and must not be falsified here: the CLICK does not go through this box (it hits
// the ink, renderer/shapes.ts::hitTestNode), and whoever needs a MARQUEE to pass
// over it widens it on their own
// (renderer/shapes.ts::selectionBoundsOfNode), which is a selection
// tolerance and not a fact about the geometry.
export function vectorBounds(subpaths: readonly SubPathLite[]): BoxLite {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const pushX = (v: number) => { if (v < minX) minX = v; if (v > maxX) maxX = v; };
  const pushY = (v: number) => { if (v < minY) minY = v; if (v > maxY) maxY = v; };
  for (const sp of subpaths) {
    const n = sp.anchors.length;
    if (n === 0) continue;
    if (n === 1) {
      pushX(sp.anchors[0].x);
      pushY(sp.anchors[0].y);
      continue;
    }
    // Closed: there is also the last -> first return segment.
    const segments = sp.closed ? n : n - 1;
    for (let i = 0; i < segments; i++) {
      const a = sp.anchors[i];
      const b = sp.anchors[(i + 1) % n];
      addCubicExtrema(a.x, a.x + a.outX, b.x + b.inX, b.x, pushX);
      addCubicExtrema(a.y, a.y + a.outY, b.y + b.inY, b.y, pushY);
    }
  }
  if (minX === Infinity) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// --- appiattimento e hit-test ------------------------------------------------

// The control points of the segment going from anchor i to the next, in
// LOCAL coordinates. It is the same reading vectorBounds does (and that shapes.ts
// translates into a bezierCurveTo): the order of the four points is the canvas's
// -- anchor, OUTGOING handle of the first, INCOMING handle of the second,
// anchor.
function segmentControls(a: AnchorLite, b: AnchorLite): [PointLite, PointLite, PointLite, PointLite] {
  return [
    { x: a.x, y: a.y },
    { x: a.x + a.outX, y: a.y + a.outY },
    { x: b.x + b.inX, y: b.y + b.inY },
    { x: b.x, y: b.y },
  ];
}

// How many DRAWN segments an outline has. Closed: there is also the
// last -> first return. Same rule as vectorBounds, and it is no accident -- the box
// must contain exactly what is drawn and what is hit.
function segmentCount(sp: SubPathLite): number {
  const n = sp.anchors.length;
  if (n < 2) return 0;
  return sp.closed ? n : n - 1;
}

// An outline ALSO ends up in the fill bucket if and only if it is closed and
// has at least two anchors: a single point has no area, and `closed` does not
// give it one (the canvas that fills it paints nothing).
//
// "ALSO" is the important word: this predicate does NOT decide whether the outline is
// drawn: EVERY outline is stroked (shapes.ts::vectorPaths), closed or open, and
// EVERY outline is picked by proximity (hitVectorGeometry). The fill is an
// EXTRA target, not an alternative -- see hitVectorGeometry below for the
// reason: `closed` does not imply area, and a closed outline of zero area (two
// anchors, or three collinear) is a REACHABLE case with the pen tool. If the
// fill were the only target, that path would vanish from the canvas and
// become unclickable at the very moment the user closes it.
//
// A SINGLE predicate because drawing and hit-test must classify the same
// way: two separate lists would give a path that is seen filled and is
// hit only by proximity, or vice versa.
export function subpathFills(sp: SubPathLite): boolean {
  return sp.closed && sp.anchors.length >= 2;
}

// True if there is AT LEAST one anchor in the whole geometry, that is if the node
// paints something. It is the only state in which a vector produces no
// Path2D (shapes.ts::vectorPaths) and no hit (hitVectorGeometry), and whoever
// selects must be able to distinguish it from a degenerate path -- which on the contrary is seen
// and clicked just fine.
export function hasAnyAnchor(subpaths: readonly SubPathLite[]): boolean {
  return subpaths.some((sp) => sp.anchors.length > 0);
}

// Distance of (px,py) from the SEGMENT ab -- not from the line containing it: with
// the line a short path would be grabbable along its whole extension.
function distanceToSegment(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  // Zero-length segment (two coincident anchors): it is a point.
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function distanceToPolyline(pts: readonly PointLite[], px: number, py: number): number {
  if (pts.length === 0) return Infinity;
  // A single point (an outline of one anchor) is the distance from the point: the
  // loop does not run and this is the right value, not a fallback.
  let best = Math.hypot(px - pts[0].x, py - pts[0].y);
  for (let i = 1; i < pts.length; i++) {
    const d = distanceToSegment(pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y, px, py);
    if (d < best) best = d;
  }
  return best;
}

// Maximum subdivision depth. Every level HALVES the chord and
// divides the deviation by ~4, so 10 levels are 1024 segments and a
// deviation reduction of 4^10 ≈ 10^6: a curve a million world units wide
// would still fall under a quarter of a pixel. The cap exists only
// because bottomless recursion on NaN/Infinite coordinates (a state the
// wire can always deliver) would hang the UI thread.
const MAX_FLATTEN_DEPTH = 10;

// "Flat" = both control points are less than `tol` from the CHORD
// p0-p3. The cubic lies within the convex hull of its four control
// points, so if p1 and p2 lie in a band of half-width tol
// around the chord the whole curve does too: the criterion is a true UPPER
// bound on the deviation, not an estimate.
//
// The distance is from the SEGMENT and not from the line, on purpose: two controls aligned
// with the chord but very far along it (p1 a thousand units past p3) make a
// curve that leaves the endpoints and comes back, and replacing it with the chord would lose
// all that back and forth. From the line they would be at distance zero, and the criterion
// would say "flat" to a curve that is not.
//
// The common case -- no handles, so p1 = p0 and p2 = p3 -- gives distance
// zero at the first shot: a pen tool polyline flattens into itself,
// without an extra point. A criterion based on the second derivative (which is
// large even when the curve is a line traversed non-uniformly) would
// split it into twenty pieces for nothing.
function isFlat(p0: PointLite, p1: PointLite, p2: PointLite, p3: PointLite, tol: number): boolean {
  return distanceToSegment(p0.x, p0.y, p3.x, p3.y, p1.x, p1.y) <= tol
    && distanceToSegment(p0.x, p0.y, p3.x, p3.y, p2.x, p2.y) <= tol;
}

function mid(a: PointLite, b: PointLite): PointLite {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

// de Casteljau at t = 0.5, recursive until the piece is flat. It pushes ONLY
// the points after the first (which the caller has already put), and pushes p3
// exactly instead of recomputing it: the endpoints of every segment remain the model's
// points, with no floating-point drift.
function flattenCubic(
  p0: PointLite, p1: PointLite, p2: PointLite, p3: PointLite,
  tol: number, depth: number, out: PointLite[],
): void {
  if (depth >= MAX_FLATTEN_DEPTH || isFlat(p0, p1, p2, p3, tol)) {
    out.push(p3);
    return;
  }
  const p01 = mid(p0, p1);
  const p12 = mid(p1, p2);
  const p23 = mid(p2, p3);
  const p012 = mid(p01, p12);
  const p123 = mid(p12, p23);
  const m = mid(p012, p123);
  flattenCubic(p0, p01, p012, m, tol, depth + 1, out);
  flattenCubic(m, p123, p23, p3, tol, depth + 1, out);
}

// The outline reduced to a polyline, in LOCAL coordinates, with deviation from the true
// curve less than `tol`. A CLOSED outline includes the return segment,
// so the last point coincides with the first: the polygon is already closed and whoever
// uses it need not remember to close it.
//
// The tolerance is in WORLD units. The caller derives it from SCREEN px
// by dividing by the zoom (renderer/shapes.ts): flattening in world units
// would mean a visibly angular polyline at high zoom and thousands
// of useless points at low zoom.
export function flattenSubpath(sp: SubPathLite, tol: number): PointLite[] {
  const n = sp.anchors.length;
  if (n === 0) return [];
  const out: PointLite[] = [{ x: sp.anchors[0].x, y: sp.anchors[0].y }];
  const segments = segmentCount(sp);
  for (let i = 0; i < segments; i++) {
    const [p0, p1, p2, p3] = segmentControls(sp.anchors[i], sp.anchors[(i + 1) % n]);
    flattenCubic(p0, p1, p2, p3, tol, 0, out);
  }
  return out;
}

// The point is inside the fill of these rings according to the EVEN-ODD rule:
// count of intersections of a ray with ALL rings together,
// inside if the total is odd.
//
// The choice of even-odd over nonzero is deliberate and also lives in
// renderer/shapes.ts (VECTOR_FILL_RULE), which passes it to ctx.fill: drawing and
// hit-test must use the SAME rule, or you end up with a hole that is seen
// but clicked. The reason: with nonzero an inner outline is a hole only if
// it is traversed in the OPPOSITE DIRECTION from the outer one, and this model has
// no way to control the direction -- no "reverse outline" among the ops,
// and the pen tool produces the direction in which the user clicked. A hole that
// depends on an invisible, uneditable property is a hole you cannot
// make on purpose. With even-odd only CONTAINMENT decides: an outline
// inside another is always a hole, and to remove it just move it outside.
//
// A point exactly ON the edge is indeterminate (it depends on how the
// floating-point comparison falls). It is not a practical problem: that case requires
// bit-exact coordinates, and the edge of a closed outline is anyway
// surrounded by its fill on one side.
export function pointInRingsEvenOdd(
  rings: readonly (readonly PointLite[])[], px: number, py: number,
): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const yi = ring[i].y, yj = ring[j].y;
      // The side crosses the py level (one of the two endpoints above, the other not):
      // the asymmetric > / <= comparison counts every vertex ONCE only, which
      // is what avoids double counting when py falls exactly on a
      // vertex.
      if ((yi > py) === (yj > py)) continue;
      const xi = ring[i].x, xj = ring[j].x;
      // X of the intersection with the horizontal ray toward the right.
      if (px < xi + ((py - yi) * (xj - xi)) / (yj - yi)) inside = !inside;
    }
  }
  return inside;
}

// The geometry hit-test, in LOCAL coordinates (the caller subtracts
// the node's origin once).
//
// The rule is the exact reflection of what is PAINTED (shapes.ts::vectorPaths,
// canvasRenderer.ts::drawVector):
//   - EVERY outline is stroked, so every outline is picked by PROXIMITY
//     to the curve, within `grab`;
//   - in addition, an outline that fills is picked over its whole AREA, with the
//     same even-odd rule with which it is painted (a hole is a hole for the
//     click too).
//
// The stroke on CLOSED outlines too is not cosmetics. `closed` does not imply area:
// a closed outline of two anchors goes A->B->A and an outline of three
// collinear anchors goes along a squashed polyline -- in both cases
// even-odd paints nothing and contains no point. They are states
// REACHABLE with the pen tool (click, click, click on the first to close), and
// with the fill alone the node would vanish from the canvas and become unclickable
// at the very moment the user closes it, remaining
// reachable only from the layers panel. Stroking it keeps it visible, and
// proximity keeps it grabbable: drawing and hit-test remain the same thing.
//
// The price is a grab of `grab` around the perimeter of a closed outline.
// It is the same one that already applies to an open outline and the same one expected by whoever
// has used a vector editor (the edge can be grabbed), and the stroke truly EXTENDS
// beyond the fill by half its thickness: without the grab the target would
// no longer coincide with the ink.
//
// The tolerance is measured by the caller in SCREEN px -- a line must be
// equally easy to grab at every zoom, and in world units it would become
// impossible to hit at zoom 0.1 and half a screen wide at zoom 64.
//
// `grab` and `flatten` are already in WORLD units: the conversion from px lives in a
// single place (renderer/shapes.ts), which is also the only one that knows the zoom.
export function hitVectorGeometry(
  subpaths: readonly SubPathLite[],
  lx: number, ly: number,
  grab: number, flatten: number,
): boolean {
  const rings: PointLite[][] = [];
  for (const sp of subpaths) {
    const pts = flattenSubpath(sp, flatten);
    if (pts.length === 0) continue;
    if (subpathFills(sp)) rings.push(pts);
    if (distanceToPolyline(pts, lx, ly) <= grab) return true;
  }
  return pointInRingsEvenOdd(rings, lx, ly);
}

export interface NormalizedVector {
  // The geometry translated so that its local bbox starts at (0,0).
  subpaths: SubPathLite[];
  // The node's box, in WORLD coordinates, corresponding to that geometry.
  box: BoxLite;
}

// The box invariant (proto, on VectorNode) made executable: after a
// SetVectorPath the geometry's local bbox is (0,0)-(width,height).
//
// Whoever rewrites the subpaths calls this function with the node's CURRENT origin
// and sends, in the SAME gesture, the setVectorPath with `subpaths` and the setProps
// {x,y,width,height} with `box`. The result is a vector node
// indistinguishable from a rectangle for the rest of the editor: the selection
// encloses it and the resize has a box to work on.
//
// The invariant holds in BOTH DIRECTIONS, and it is the second that costs something: if the box
// can change without the geometry following, a trivial drag of a resize
// handle (which sends only setProps{x,y,width,height}) would violate it at once --
// a path of the same size inside a grown box. That is why
// resizeVector exists below, and why selectTool emits it IN THE SAME gesture.
//
// The translation moves NOTHING on screen: the anchors lose locally exactly what the origin
// gains in world. It is the property on which correctness hangs, and it is tested as such.
//
// applyOp/core.Apply do not do it because a cubic's bbox is not a two-line
// copy: two "identical" implementations of that math would diverge
// at the first edge case, that is on the invariant this track defends.
export function normalizeVector(o: Origin, subpaths: readonly SubPathLite[]): NormalizedVector {
  const b = vectorBounds(subpaths);
  return {
    subpaths: subpaths.map((sp) => ({
      anchors: sp.anchors.map((a) => ({
        x: a.x - b.x, y: a.y - b.y,
        // Handles are RELATIVE to the anchor: a translation does not
        // touch them. Touching them would be this function's silent bug.
        inX: a.inX, inY: a.inY, outX: a.outX, outY: a.outY,
      })),
      closed: sp.closed,
    })),
    box: { x: o.x + b.x, y: o.y + b.y, width: b.width, height: b.height },
  };
}

// The scale of ONE axis as a FRACTION, not as an already-divided factor: `signed` is
// the signed extent after the drag (negative = flip) and `start` the starting
// one. Same shape as selection/handles.ts::ResizeTransform, and for the
// same numeric reason -- multiply first and divide after, otherwise a
// path with integer coordinates does not come back integer after an exact resize.
export interface AxisScale { signed: number; start: number }

// v (LOCAL coordinate, so in 0..extent by the box invariant) mapped
// into the new box. `extent` is the box side BEFORE the resize: it only serves the
// flip, where the ink is mirrored inside the box instead of ending up
// negative. start === 0 has no defined scale factor: axis unchanged, as
// mapAxis does in selection/handles.ts.
function scaleLocal(v: number, s: AxisScale, extent: number): number {
  if (s.start === 0) return v;
  return s.signed < 0 ? ((v - extent) * s.signed) / s.start : (v * s.signed) / s.start;
}

// Handles are OFFSETS: they scale with the LINEAR part only (no
// translation), and a flip reverses their direction -- which is what mirrors the
// curvature along with the path.
function scaleDelta(v: number, s: AxisScale): number {
  return s.start === 0 ? v : (v * s.signed) / s.start;
}

// The geometry rewritten so it keeps filling the box while the resize changes
// it. `from` is the node's box at the START of the gesture (not the group's: in a
// multiple selection the scale factor is common, the box is not).
//
// It is needed because anchors are lengths in local coordinates and NOT fractions
// of the box: without this rewrite the M1 8 handles (tools/selectTool.ts,
// makeSetPropsOp with ["x","y","width","height"] for every selected node)
// would change the box and leave the ink at its size, violating
// the proto's invariant with an ordinary gesture and with no SetVectorPath in
// sight. The alternative -- anchors normalized to 0..1 of the box -- makes
// every path with a degenerate axis undefined (division by zero) and forces
// renormalizing all the geometry at every point added by the pen tool.
//
// An affine transformation on every control point transforms the cubic
// exactly the same way (Béziers are affine-covariant), so if before
// bbox = (0,0)-(w,h) held, after bbox = (0,0)-(w',h') holds: the
// rewrite PRESERVES the invariant, it does not recompute it.
export function resizeVector(
  subpaths: readonly SubPathLite[],
  from: { width: number; height: number },
  sx: AxisScale,
  sy: AxisScale,
): SubPathLite[] {
  return subpaths.map((sp) => ({
    anchors: sp.anchors.map((a) => ({
      x: scaleLocal(a.x, sx, from.width),
      y: scaleLocal(a.y, sy, from.height),
      inX: scaleDelta(a.inX, sx), inY: scaleDelta(a.inY, sy),
      outX: scaleDelta(a.outX, sx), outY: scaleDelta(a.outY, sy),
    })),
    closed: sp.closed,
  }));
}
