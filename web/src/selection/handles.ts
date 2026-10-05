import { type Camera, worldToScreen } from "../canvas/camera";
import { type Bounds, inflateBounds, pointInBounds, worldBoundsToScreen } from "../canvas/geometry";
import {
  centerOf, localToWorld, normalizeDegrees, rotateAround, rotateVector, type Point,
} from "../canvas/transform";

const DEG_TO_RAD = Math.PI / 180;

export type HandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

// The only 4 handles that also carry a ROTATION zone (the editor
// convention: you rotate from the corners, not from the sides).
export type CornerId = "nw" | "ne" | "se" | "sw";
export const CORNER_IDS: readonly CornerId[] = ["nw", "ne", "se", "sw"];

// Side (SCREEN px) of the little square drawn by the overlay.
export const HANDLE_SIZE = 8;

// Grab area: slightly more generous than the drawn square (8px is
// hard to hit with the mouse). It is SCREEN px, so it stays constant at every
// zoom level -- which is the whole point of doing the hit-test in screen space
// instead of world space.
export const HANDLE_GRAB_PADDING = 2;

// Corners BEFORE sides: with a small bbox the grab areas overlap
// and the corner (which moves two axes) is almost always what the user wants.
export const HANDLE_IDS: readonly HandleId[] = ["nw", "ne", "se", "sw", "n", "e", "s", "w"];

// Which bbox edges each handle moves. All the resize math
// (flip included) descends from here.
const MOVES: Record<HandleId, { left: boolean; right: boolean; top: boolean; bottom: boolean }> = {
  nw: { left: true, right: false, top: true, bottom: false },
  n: { left: false, right: false, top: true, bottom: false },
  ne: { left: false, right: true, top: true, bottom: false },
  e: { left: false, right: true, top: false, bottom: false },
  se: { left: false, right: true, top: false, bottom: true },
  s: { left: false, right: false, top: false, bottom: true },
  sw: { left: true, right: false, top: false, bottom: true },
  w: { left: true, right: false, top: false, bottom: false },
};

// The coordinates a handle MOVES, read from the same MOVES table that
// the whole resize descends from -- a single source, not a parallel table.
//
// It serves snapping during a resize (see tools/selectTool.ts): only an edge
// that is really moving may snap. Snapping the FIXED edge
// would move the node instead of resizing it, which is exactly what the
// user did not ask for by dragging a handle. The center is not among the
// candidates for the same reason: it moves, but by half the delta -- aligning it
// would mean moving an edge that must stay still.
export function movingEdgeLines(b: Bounds, h: HandleId): { x: number[]; y: number[] } {
  const m = MOVES[h];
  const x: number[] = [];
  const y: number[] = [];
  if (m.left) x.push(b.x);
  if (m.right) x.push(b.x + b.width);
  if (m.top) y.push(b.y);
  if (m.bottom) y.push(b.y + b.height);
  return { x, y };
}

const CURSORS: Record<HandleId, string> = {
  nw: "nwse-resize", se: "nwse-resize",
  ne: "nesw-resize", sw: "nesw-resize",
  n: "ns-resize", s: "ns-resize",
  e: "ew-resize", w: "ew-resize",
};

export function cursorForHandle(h: HandleId): string {
  return CURSORS[h];
}

// Centers of the 8 handles around a bbox already in SCREEN space.
export function handlePositions(b: Bounds): Record<HandleId, { x: number; y: number }> {
  const midX = b.x + b.width / 2;
  const midY = b.y + b.height / 2;
  const right = b.x + b.width;
  const bottom = b.y + b.height;
  return {
    nw: { x: b.x, y: b.y },
    n: { x: midX, y: b.y },
    ne: { x: right, y: b.y },
    e: { x: right, y: midY },
    se: { x: right, y: bottom },
    s: { x: midX, y: bottom },
    sw: { x: b.x, y: bottom },
    w: { x: b.x, y: midY },
  };
}

// Handle squares in SCREEN px for a bbox in WORLD coordinates: the
// bbox scales with zoom, the squares do NOT (they are always HANDLE_SIZE).
export function handleScreenRects(b: Bounds, cam: Camera): Record<HandleId, Bounds> {
  const box = worldBoundsToScreen(b, cam);
  const half = HANDLE_SIZE / 2;
  const out = {} as Record<HandleId, Bounds>;
  for (const [id, p] of Object.entries(handlePositions(box)) as [HandleId, { x: number; y: number }][]) {
    out[id] = { x: p.x - half, y: p.y - half, width: HANDLE_SIZE, height: HANDLE_SIZE };
  }
  return out;
}

// (sx, sy) are SCREEN px in the canvas space, like the rectangles
// above: no manual conversion, the camera enters only via
// handleScreenRects.
export function hitTestHandle(b: Bounds, cam: Camera, sx: number, sy: number): HandleId | null {
  const rects = handleScreenRects(b, cam);
  for (const id of HANDLE_IDS) {
    if (pointInBounds(inflateBounds(rects[id], HANDLE_GRAB_PADDING), sx, sy)) return id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// FRAME: the selection bbox PLUS its rotation
// ---------------------------------------------------------------------------
//
// Everything above reasons on an axis-aligned rectangle, and rightly so:
// the resize (flip and keepAspect included) is defined in that space, and
// is already tested there. Rotation does not rewrite it, it WRAPS it -- the frame is
// that same rectangle plus an angle, and every function below just
// brings points and deltas into or out of the frame's local space, ALWAYS going
// through canvas/transform.ts (degrees, clockwise, around the bbox center).
//
// A frame with rotation 0 goes through exactly the old code, number for
// number: rotateVector/rotateAround recognize the null angle and return
// identical coordinates, and the offset below is 0.

export interface SelectionFrame {
  bounds: Bounds;
  // Degrees, clockwise, around the CENTER of `bounds`.
  rotation: number;
}

export type FrameHit =
  | { kind: "resize"; handle: HandleId }
  | { kind: "rotate"; corner: CornerId };

// Side (SCREEN px) of the rotation grab square, centered on the corner.
// Bigger than the resize grab area on purpose: the part that sticks out is
// the RING outside the corner, which is all the rotation occupies (see
// hitTestFrame). 22 leaves ~5px of ring per side beyond the resize's 12.
export const ROTATE_GRAB_SIZE = 22;

// CSS has no "rotate" cursor: "grab"/"grabbing" is the closest pair to the
// gesture (grabbing the corner and turning it) and does not pretend a different operation, as
// "crosshair" would.
export const ROTATE_CURSOR = "grab";
export const ROTATING_CURSOR = "grabbing";

export function cursorForFrameHit(hit: FrameHit): string {
  return hit.kind === "rotate" ? ROTATE_CURSOR : cursorForHandle(hit.handle);
}

export function frameCenter(f: SelectionFrame): Point {
  return centerOf(f.bounds);
}

// Centers of the 8 handles in WORLD coordinates, rotation included.
export function handleWorldPoints(f: SelectionFrame): Record<HandleId, Point> {
  const c = centerOf(f.bounds);
  const flat = handlePositions(f.bounds);
  const out = {} as Record<HandleId, Point>;
  for (const id of HANDLE_IDS) out[id] = localToWorld(flat[id], c, f.rotation);
  return out;
}

// The same centers in SCREEN px: it is where the overlay draws the squares (which
// stay HANDLE_SIZE px at every zoom, see handleScreenRects).
export function handleScreenPoints(f: SelectionFrame, cam: Camera): Record<HandleId, Point> {
  const world = handleWorldPoints(f);
  const out = {} as Record<HandleId, Point>;
  for (const id of HANDLE_IDS) out[id] = worldToScreen(cam, world[id].x, world[id].y);
  return out;
}

// The screen point brought back into the frame's UNrotated screen space: from there
// on all the axis-aligned functions above apply. The camera is a
// similarity (uniform scale + translation), so the world rotation is
// the SAME rotation on screen -- it is enough to turn around the frame center
// converted to screen px.
function unrotateScreenPoint(f: SelectionFrame, cam: Camera, sx: number, sy: number): Point {
  if (f.rotation % 360 === 0) return { x: sx, y: sy };
  const c = centerOf(f.bounds);
  const screenCenter = worldToScreen(cam, c.x, c.y);
  return rotateAround({ x: sx, y: sy }, screenCenter, -f.rotation);
}

// The COMPLETE overlay hit-test: first the 8 resize handles, then the 4
// rotation zones. In this order because the rotation zone contains
// the corner, and on the corner the user wants to resize.
//
// The rotation zone is what remains of a ROTATE_GRAB_SIZE square
// centered on the corner once everything INSIDE the selection box is removed:
// you rotate by grabbing just OUTSIDE the corner, and a click inside the
// shape remains a click on the shape (move) as it has always been.
export function hitTestFrame(f: SelectionFrame, cam: Camera, sx: number, sy: number): FrameHit | null {
  const p = unrotateScreenPoint(f, cam, sx, sy);
  const handle = hitTestHandle(f.bounds, cam, p.x, p.y);
  if (handle) return { kind: "resize", handle };
  if (pointInBounds(worldBoundsToScreen(f.bounds, cam), p.x, p.y)) return null;
  const rects = handleScreenRects(f.bounds, cam);
  const pad = (ROTATE_GRAB_SIZE - HANDLE_SIZE) / 2;
  for (const id of CORNER_IDS) {
    if (pointInBounds(inflateBounds(rects[id], pad), p.x, p.y)) return { kind: "rotate", corner: id };
  }
  return null;
}

// THE DRAWN ROTATION HANDLE. The grab zone above is an AREA
// (the L-shaped ring around the corner); this is the point where the overlay
// draws its sign. A visible sign is the point: without it, the only affordance
// was the cursor, and a handle that is not drawn is a handle that
// cannot be found.
//
// The sign sits ENTIRELY inside its own grab zone, and the geometry is a
// single one (these constants) instead of two copies bound to drift apart. The two
// constraints, with a disc of radius R centered at distance D from the corner on the
// outgoing diagonal:
//
//   1. INSIDE the rotation zone: D + R <= 11 (the half-side of
//      ROTATE_GRAB_SIZE around the corner). 8 + 2.5 = 10.5, fits.
//   2. OUTSIDE the RESIZE grab square, which wins on the corner
//      (half-side HANDLE_SIZE/2 + HANDLE_GRAB_PADDING = 6): the point of the
//      square closest to the disc center is its corner (6, 6), at
//      distance sqrt((8−6)² + (8−6)²) = 2.83 > 2.5. They do not touch.
//
// It also follows that every drawn pixel falls OUTSIDE the selection box,
// where a click is a rotation and not a move. The test
// "draws only where it grabs" samples the disc and verifies it.

// OUTGOING direction of each corner's diagonal, in the screen space of the
// UNrotated frame (y down, like the canvas).
export const ROTATE_CORNER_DIRS: Record<CornerId, Point> = {
  nw: { x: -1, y: -1 },
  ne: { x: 1, y: -1 },
  se: { x: 1, y: 1 },
  sw: { x: -1, y: 1 },
};

// How far the sign sits OUTSIDE the corner, and how big it is (SCREEN px, like
// HANDLE_SIZE: constant at every zoom).
export const ROTATE_MARKER_OFFSET = 8;
export const ROTATE_MARKER_RADIUS = 2.5;

// Centers of the 4 signs, for a bbox already in SCREEN space (like handlePositions).
export function rotateMarkerPositions(b: Bounds): Record<CornerId, Point> {
  const corners = handlePositions(b);
  const out = {} as Record<CornerId, Point>;
  for (const id of CORNER_IDS) {
    const d = ROTATE_CORNER_DIRS[id];
    out[id] = {
      x: corners[id].x + d.x * ROTATE_MARKER_OFFSET,
      y: corners[id].y + d.y * ROTATE_MARKER_OFFSET,
    };
  }
  return out;
}

// Affine transformation (scale + anchor only) produced by a resize drag.
// Keeping it separate from resizeBounds serves the resize of a MULTIPLE selection:
// every node is mapped with the same transformation as the group bbox, and
// the flip mirrors the children instead of merely normalizing.
//
// The scale factor on X is signedW/startW, but we do NOT precompute it: we
// keep it as a fraction so mapAxis can multiply FIRST and divide AFTER.
// With early division even an exact case drifts ((100*(110/100)) gives
// 110.00000000000001), and the resize of a rectangle with integer coordinates must
// return integer coordinates.
export interface ResizeTransform {
  anchorX: number;
  anchorY: number;
  startW: number;
  startH: number;
  // SIGNED extents after the drag, measured from the anchor: negative = flip.
  signedW: number;
  signedH: number;
}

function signOf(v: number): number {
  return v < 0 ? -1 : 1;
}

// v mapped around the anchor with the signed/start ratio. start === 0 (degenerate
// bbox) has no defined scale factor: we leave the axis unchanged
// instead of producing Infinity/NaN.
function mapAxis(v: number, anchor: number, signed: number, start: number): number {
  return start === 0 ? v : anchor + ((v - anchor) * signed) / start;
}

export function resizeTransform(
  start: Bounds,
  h: HandleId,
  dxWorld: number,
  dyWorld: number,
  opts?: { keepAspect?: boolean },
): ResizeTransform {
  const m = MOVES[h];
  const movesH = m.left || m.right;
  const movesV = m.top || m.bottom;

  // The anchor is the edge OPPOSITE the handle: it is the only point the resize
  // never moves. On the axes the handle does not touch the anchor is the
  // initial edge (min), so that axis stays identical (scale 1).
  const anchorX = m.left ? start.x + start.width : start.x;
  const anchorY = m.top ? start.y + start.height : start.y;

  // SIGNED width/height after the drag, measured from the anchor: positive
  // as long as the moving edge stays on the initial side of the anchor, negative
  // when it crosses it (= flip).
  let signedW = m.left ? start.width - dxWorld : m.right ? start.width + dxWorld : start.width;
  let signedH = m.top ? start.height - dyWorld : m.bottom ? start.height + dyWorld : start.height;

  if (opts?.keepAspect && start.width !== 0 && start.height !== 0) {
    // Ratio preserved <=> |scaleX| === |scaleY| (uniform scale). The sign
    // stays independent, so the flip keeps working with shift held.
    const scaleX = signedW / start.width;
    const scaleY = signedH / start.height;
    if (movesH && movesV) {
      // Corner: the most-dragged axis rules, proportionally. "Most" is NOT
      // the largest |factor|: max(|scaleX|, |scaleY|) rewards the axis moved
      // LESS whenever the drag shrinks -- with dx=-50, dy=0 it gave
      // max(0.75, 1) = 1, i.e. the neutral of the still axis, and the resize
      // did nothing. It is the same mistake the sides below already avoid.
      //
      // The right measure is how far the moving edge has TRAVELED in proportion
      // to the side: |signedW - startW| / startW === |scaleX - 1|. It is 0 for a
      // still axis, grows both when widening and when narrowing, and exceeds 1 when the
      // drag has gone past the anchor (flip). Once the axis wins, the common factor is
      // its |scale|; the SIGNS stay per-axis, so shift + flip keeps
      // mirroring only the axis really dragged past the anchor.
      const travelX = Math.abs(scaleX - 1);
      const travelY = Math.abs(scaleY - 1);
      const s = travelX >= travelY ? Math.abs(scaleX) : Math.abs(scaleY);
      signedW = signOf(scaleX) * s * start.width;
      signedH = signOf(scaleY) * s * start.height;
    } else if (movesH) {
      // Vertical side (e/w): the horizontal axis is the only one dragged, so it
      // always rules -- even when shrinking (|scaleX| < 1).
      signedH = Math.abs(scaleX) * start.height;
    } else if (movesV) {
      signedW = Math.abs(scaleY) * start.width;
    }
  }

  return { anchorX, anchorY, startW: start.width, startH: start.height, signedW, signedH };
}

// Applies the transformation and NORMALIZES: width/height stay >= 0 even after
// a flip (the rectangle flips, x/y move to the other side of the anchor).
export function transformBounds(b: Bounds, t: ResizeTransform): Bounds {
  const x0 = mapAxis(b.x, t.anchorX, t.signedW, t.startW);
  const x1 = mapAxis(b.x + b.width, t.anchorX, t.signedW, t.startW);
  const y0 = mapAxis(b.y, t.anchorY, t.signedH, t.startH);
  const y1 = mapAxis(b.y + b.height, t.anchorY, t.signedH, t.startH);
  return {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    width: Math.abs(x1 - x0),
    height: Math.abs(y1 - y0),
  };
}

// dxWorld/dyWorld are the pointer displacement in WORLD coordinates
// from the start of the gesture (not the last incremental delta): the resize is always computed
// from the INITIAL bounds, so errors do not accumulate move after move.
export function resizeBounds(
  start: Bounds,
  h: HandleId,
  dxWorld: number,
  dyWorld: number,
  opts?: { keepAspect?: boolean },
): Bounds {
  return transformBounds(start, resizeTransform(start, h, dxWorld, dyWorld, opts));
}

// The resize of a ROTATED frame. Only two additions to resizeTransform, which stays
// intact (flip and keepAspect are already its own, and already tested):
//
//  1. the pointer delta enters the frame's LOCAL space, so the
//     `e` handle widens the node along ITS x axis -- which on screen can
//     point in any direction -- and ignores the transverse component;
//  2. an OFFSET that puts the anchor back in place. resizeTransform keeps the
//     edge opposite the handle still in LOCAL coordinates, but the node rotates
//     around its own CENTER, and the resize moves that center: without
//     correction the node would slide away while being resized.
//
//     Calling c and c' the center before and after, the anchor point A goes from
//     c + R(A − c) to c' + R(A − c'), so the correction is
//         (c + R(A − c)) − (c' + R(A − c')) = (c − c') − R(c − c')
//     which does not depend on A: a single translation for ALL the nodes of the frame.
export interface FrameResize {
  transform: ResizeTransform;
  offsetX: number;
  offsetY: number;
  // The FRAME's rotation (degrees). It serves whoever maps a node whose angle is
  // different from the frame's: the scale applies along the frame's axes, so
  // only the difference between the two angles matters (see applyFrameResizeToNode).
  rotation: number;
}

export function resizeFrame(
  f: SelectionFrame,
  h: HandleId,
  dxWorld: number,
  dyWorld: number,
  opts?: { keepAspect?: boolean },
): FrameResize {
  const d = rotateVector({ x: dxWorld, y: dyWorld }, -f.rotation);
  const transform = resizeTransform(f.bounds, h, d.x, d.y, opts);
  const c = centerOf(f.bounds);
  const after = centerOf(transformBounds(f.bounds, transform));
  const dc = { x: c.x - after.x, y: c.y - after.y };
  const rdc = rotateVector(dc, f.rotation);
  return { transform, offsetX: dc.x - rdc.x, offsetY: dc.y - rdc.y, rotation: f.rotation };
}

// Applies to the bbox of ONE node the frame transformation computed above. The
// branch without offset is not an optimization: it is the guarantee that an unrotated
// frame returns the very same numbers as transformBounds (a +0 on a
// -0 is not a no-op, and the resize tests compare exact numbers).
export function applyFrameResize(b: Bounds, r: FrameResize): Bounds {
  const out = transformBounds(b, r.transform);
  if (r.offsetX === 0 && r.offsetY === 0) return out;
  return { x: out.x + r.offsetX, y: out.y + r.offsetY, width: out.width, height: out.height };
}

// The same, for a node whose angle is NOT the frame's -- the case of a
// MULTIPLE selection (the group box is axis-aligned, see
// overlayRenderer::selectionFrame) that contains a rotated node.
//
// applyFrameResize alone gets it wrong, and visibly so: it scales the node's
// LOCAL box, i.e. stretches it along its own axes instead of along those
// of the screen the user is dragging on. A node at 90° inside a group
// pulled HORIZONTALLY grew VERTICALLY and stuck out of the box.
//
// What the group scale really does is map the node's AXES: the local
// x axis (cos θ, sin θ) becomes (kx·cos θ, ky·sin θ) and the y axis (−sin θ,
// cos θ) becomes (−kx·sin θ, ky·cos θ), where θ is the node's angle RELATIVE to the
// frame. From there the three needed things are read: the new width (the
// length of the first axis), the new height (that of the second) and the new
// angle (the direction of the first).
//
// It is EXACT for a uniform scale, for θ a multiple of 90° (the axes
// swap) and for a flip (kx·ky < 0: the angle mirrors itself,
// because atan2 reads the true direction of the axis).
//
// FOR ANY OTHER ANGLE with a NON-uniform scale the exact result is a
// PARALLELOGRAM, which the model (x/y/w/h + an angle) cannot represent, and
// the rectangle with those axes alone is NOT enough: it has the right directions but an
// AABB that is too big on one side. A 100x50 at 45° (AABB 106.07x106.07) inside a
// box pulled by the e handle (kx=2, ky=1) became 158.11x79.06 at
// 26.565°, i.e. an AABB of 176.78x141.42: 33% taller than a box the
// user NEVER dragged vertically. It stuck out above and below.
//
// Therefore the rectangle is SHRUNK, around the mapped center, by the factor
// that puts it back inside the place the group scale really reserves for
// this node -- the starting AABB scaled by (|kx|, |ky|), which fits in the
// box because the box is the union of the members' AABBs (see
// containScale). The factor is 1, exactly, in all the exact cases above:
// a similarity and an axis swap send the AABB exactly onto the
// scaled AABB, so there is nothing to shrink and the numbers are not touched.
//
// The price is that the member FILLS LESS than its place (at 45°, 132.58x106.07 in
// 212.13x106.07: it touches top and bottom, leaves room on the right). It is the right price:
// the alternative "fill exactly" -- solving w,h with the new angle so that the
// AABB coincides -- has a non-negative solution only for |θ| <= 45° and degenerates
// right there: at 44°, still with kx=2 and ky=1, a 100x50 would become 235x3.6,
// a sliver. A member a bit smaller than expected is fixed by
// dragging it; a member squashed to zero, or outside the box, is not.
export interface RotatedBounds {
  bounds: Bounds;
  rotation: number;
}

// A reduction smaller than this is floating-point noise, not an
// overflow: applying it would take away the exactness of the exact cases (cos(90°)
// is 6.1e-17, not 0) without moving anything visible -- 1e-12 in RELATIVE terms on a
// box of 1e6 units is a billionth of a unit.
const CONTAIN_EPS = 1e-12;

// By how much to shrink the rectangle from the mapped axes so that it fits in the place
// the group scale reserves for the node. All in FRAME space: (cos, sin)
// are those of θ, (cosN, sinN) the ABSOLUTE VALUES of those of the new angle
// (read from the mapped axis, without going back through atan2/cos/sin).
//
// The AABB of a w x h box at an angle of absolute cosine/sine (ca, sa) is
// (w·ca + h·sa) x (w·sa + h·ca) -- rotatedAabb, written in terms of sides instead of
// angles. It is needed first (to know which place the scale reserves for the node) and after
// (to know how much the mapped rectangle really occupies).
function containScale(
  b: Bounds, cos: number, sin: number, kx: number, ky: number,
  w: number, h: number, cosN: number, sinN: number,
): number {
  const ca = Math.abs(cos);
  const sa = Math.abs(sin);
  const roomW = Math.abs(kx) * (b.width * ca + b.height * sa);
  const roomH = Math.abs(ky) * (b.width * sa + b.height * ca);
  const gotW = w * cosN + h * sinN;
  const gotH = w * sinN + h * cosN;
  // Degenerate box (or null scale): nothing to contain, and no division by
  // zero to do.
  if (!(gotW > 0) || !(gotH > 0)) return 1;
  const s = Math.min(roomW / gotW, roomH / gotH);
  return s < 1 - CONTAIN_EPS ? s : 1;
}

export function applyFrameResizeToNode(b: Bounds, rotation: number, r: FrameResize): RotatedBounds {
  const theta = rotation - r.rotation;
  // Node ALIGNED to the frame (single selection, or group of unrotated nodes):
  // its axes are the frame's and the usual map is already exact. A separate branch
  // to guarantee the very same numbers, not for speed.
  if (theta % 360 === 0) return { bounds: applyFrameResize(b, r), rotation };

  const t = r.transform;
  const kx = t.startW === 0 ? 1 : t.signedW / t.startW;
  const ky = t.startH === 0 ? 1 : t.signedH / t.startH;
  const rad = theta * DEG_TO_RAD;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  // The CENTER follows the group transformation like any other point: it is
  // what keeps the node inside the box.
  const c = centerOf(b);
  const cx = mapAxis(c.x, t.anchorX, t.signedW, t.startW) + r.offsetX;
  const cy = mapAxis(c.y, t.anchorY, t.signedH, t.startH) + r.offsetY;

  // UNIFORM and positive scale: the rotated shape stays similar to itself,
  // the angle is untouched, the AABB scales by the same factor (so the
  // node is already inside its place: containScale would give 1) and the numbers stay
  // exact (no round trip through atan2).
  if (kx === ky && kx > 0) {
    const width = b.width * kx;
    const height = b.height * kx;
    return { bounds: { x: cx - width / 2, y: cy - height / 2, width, height }, rotation };
  }

  const ux = kx * cos;
  const uy = ky * sin;
  const vx = -kx * sin;
  const vy = ky * cos;
  const nu = Math.hypot(ux, uy);
  const nv = Math.hypot(vx, vy);
  // ABSOLUTE cosine and sine of the new angle, read directly from the mapped
  // axis: it is the same angle atan2 returns below, without the
  // degrees -> radians -> cos/sin round trip that would add error. nu === 0
  // means x axis mapped to zero (hence zero width): the node is
  // degenerate and there is no angle to read.
  const cosN = nu === 0 ? 1 : Math.abs(ux) / nu;
  const sinN = nu === 0 ? 0 : Math.abs(uy) / nu;
  const s = containScale(b, cos, sin, kx, ky, b.width * nu, b.height * nv, cosN, sinN);
  const width = b.width * nu * s;
  const height = b.height * nv * s;
  return {
    bounds: { x: cx - width / 2, y: cy - height / 2, width, height },
    rotation: normalizeDegrees(r.rotation + Math.atan2(uy, ux) / DEG_TO_RAD),
  };
}

// The "single node" case, in full: handy for tests and for callers that do not
// have a multiple selection to map.
export function resizeRotatedBounds(
  start: Bounds,
  rotation: number,
  h: HandleId,
  dxWorld: number,
  dyWorld: number,
  opts?: { keepAspect?: boolean },
): Bounds {
  const f: SelectionFrame = { bounds: start, rotation };
  return applyFrameResize(start, resizeFrame(f, h, dxWorld, dyWorld, opts));
}
