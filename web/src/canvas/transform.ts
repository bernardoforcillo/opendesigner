import type { NodeLite, SceneState } from "../store/types";
import { ancestorsOf } from "../store/tree";
import { type Bounds, boundsOfNode } from "./geometry";

// ROTATION — THE CONVENTION, IN ONE PLACE ONLY.
//
// `Node.rotation` (proto: `double rotation = 14`) is in DEGREES and applies around the
// CENTER of the node's box -- never around its origin. World axes have
// y pointing DOWN (it is canvas 2D), so a POSITIVE angle takes the +x axis
// onto the +y axis: on screen it reads as a CLOCKWISE rotation, the same as
// `ctx.rotate` and the same one design editors show in the panel.
//
// Degrees (and not radians) because it is the form the user reads and writes; the
// conversion to radians stays confined in here, where the project's only rotation
// matrix lives. Renderer, hit-test, handles and tools all go through
// these functions: a second hand-written matrix elsewhere would be the
// usual pair destined to diverge (see canvas/camera.ts for screen<->world).
//
//   world = c + R(θ) · (local − c)      R(θ) = [[cos, −sin], [sin, cos]]
//   local = c + R(−θ) · (world − c)
//
// where c is the center of the node's UNROTATED box: the model keeps holding
// x/y/width/height in world coordinates, AXIS-ALIGNED, and rotation is a
// separate field applied on top. It is the reason resize can keep
// working on the bounds (local space) and only the anchor must be repositioned.

export interface Point { x: number; y: number }

const DEG_TO_RAD = Math.PI / 180;

// An angle that rotates nothing (0, 360, -720...) must leave the coordinates
// IDENTICAL, not "very close": the rest of the pipeline (resizeBounds, the
// handles, tests on integer coordinates) compares exact numbers, and a trip through
// cos/sin would turn 110 into 110.00000000000001.
function isUnrotated(deg: number): boolean {
  return deg % 360 === 0;
}

export function centerOf(b: Bounds): Point {
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

// Rotates a VECTOR (a direction, a displacement): no center, no
// translation. It is what is needed to bring a drag's delta from world space
// to the node's local space.
export function rotateVector(v: Point, deg: number): Point {
  if (isUnrotated(deg)) return { x: v.x, y: v.y };
  const r = deg * DEG_TO_RAD;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return { x: v.x * cos - v.y * sin, y: v.x * sin + v.y * cos };
}

export function rotateAround(p: Point, c: Point, deg: number): Point {
  if (isUnrotated(deg)) return { x: p.x, y: p.y };
  const v = rotateVector({ x: p.x - c.x, y: p.y - c.y }, deg);
  return { x: c.x + v.x, y: c.y + v.y };
}

// The 4 corners in WORLD coordinates, in order nw, ne, se, sw (the same clockwise
// loop as the corner handles, see selection/handles.ts).
export function rotatedCorners(b: Bounds, deg: number): [Point, Point, Point, Point] {
  const c = centerOf(b);
  const r = b.x + b.width;
  const bottom = b.y + b.height;
  return [
    rotateAround({ x: b.x, y: b.y }, c, deg),
    rotateAround({ x: r, y: b.y }, c, deg),
    rotateAround({ x: r, y: bottom }, c, deg),
    rotateAround({ x: b.x, y: bottom }, c, deg),
  ];
}

// The AXIS-ALIGNED rectangle that contains the rotated shape: it is what is needed by
// anyone reasoning in rectangles (union of a multiple selection,
// intersection with the marquee) on a node that, once rotated, no longer is one.
export function rotatedAabb(b: Bounds, deg: number): Bounds {
  if (isUnrotated(deg)) return { x: b.x, y: b.y, width: b.width, height: b.height };
  const corners = rotatedCorners(b, deg);
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

// Brings an angle back into [0, 360). It serves what gets WRITTEN into the model: after
// three handle turns a rotation of 1080° and one of 0° are the same thing,
// and the properties panel (and anyone comparing two nodes) must not see the
// difference.
export function normalizeDegrees(deg: number): number {
  const m = deg % 360;
  return m < 0 ? m + 360 : m;
}

export function snapDegrees(deg: number, step: number): number {
  return Math.round(deg / step) * step;
}

// The angle (in degrees, same clockwise convention) of the ray going from `c` to
// `p`. It is the measure by which a rotation-handle drag
// translates into an angular delta.
export function angleOf(c: Point, p: Point): number {
  return Math.atan2(p.y - c.y, p.x - c.x) / DEG_TO_RAD;
}

// COMPOSED TRANSFORMS — a node's coordinates are RELATIVE TO THE PARENT.
//
// Up to here the scene was flat and x/y were WORLD coordinates: the renderer
// could draw every node where it was written and hit-test compare the pointer
// point with the box as it was. With the tree this is no longer true: a node's
// coordinates live in the LOCAL space of its parent, and the world
// is obtained by accumulating transforms descending from the page.
//
// BOTH directions are needed, and it is the only reason
// `invertTransform` exists:
//   local -> world    drawing (renderer), the selection's bounds, the text
//                     field's origin: everything that must end up on screen.
//   world -> local    the pointer: hit-test compares the point with the node's box,
//                     which is written in local coordinates, and the resize
//                     rewrites x/y/width/height which are local too.
//
// MIGRATION: in an existing document every node sits directly under a
// page, and a page contributes the IDENTITY (see worldTransformOf). World and
// local still coincide, so no work moves.

// 2x3 affine matrix in the canvas 2D convention (the same six numbers, and
// in the same order, as ctx.setTransform/DOMMatrix):
//   x' = a*x + c*y + e
//   y' = b*x + d*y + f
export interface Transform { a: number; b: number; c: number; d: number; e: number; f: number }

export const IDENTITY: Transform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function translation(tx: number, ty: number): Transform {
  return { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty };
}

// `outer` AFTER `inner`: the point goes first through inner, then through outer -- that is
// the matrix product outer*inner. It is the direction in which the
// tree is descended: a child's transform is its parent's composed on top
// of its own.
export function compose(outer: Transform, inner: Transform): Transform {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    e: outer.a * inner.e + outer.c * inner.f + outer.e,
    f: outer.b * inner.e + outer.d * inner.f + outer.f,
  };
}

export function applyTransform(t: Transform, x: number, y: number): { x: number; y: number } {
  return { x: t.a * x + t.c * y + t.e, y: t.b * x + t.d * y + t.f };
}

// Inverse. With determinant 0 the transform has collapsed the plane onto a
// line and an inverse does not exist: the IDENTITY is returned instead of dividing by
// zero, because the return value ends up in the rendering loop and in
// hit-test, where Infinity/NaN would propagate silently into every
// coordinate.
export function invertTransform(t: Transform): Transform {
  const det = t.a * t.d - t.b * t.c;
  if (det === 0) return IDENTITY;
  return {
    a: t.d / det,
    b: -t.b / det,
    c: -t.c / det,
    d: t.a / det,
    e: (t.c * t.f - t.d * t.e) / det,
    f: (t.b * t.e - t.a * t.f) / det,
  };
}

// The rotation (in degrees, same clockwise convention as rotateVector) around
// a center `c`, as a Transform: T(c) · R(θ) · T(-c). It is the piece that
// `localTransformOf` composes on top of the translation so that the children of a rotated
// container rotate with it.
function rotationAround(c: Point, deg: number): Transform {
  if (isUnrotated(deg)) return IDENTITY;
  const r = deg * DEG_TO_RAD;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const rot: Transform = { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
  return compose(translation(c.x, c.y), compose(rot, translation(-c.x, -c.y)));
}

// What a node contributes to ITS OWN children: the origin of their space is
// the node's top-left corner, rotated with it. One place only, so the
// renderer, hit-test and bounds cannot diverge.
//
// It composes TWO things (nesting track + rotation track): the parent-relative
// translation (from x/y) and the node's rotation around the center of its box
// UNROTATED. First it translates into the parent's box, then it rotates around the
// center: compose(rotationAround(center), translation(x, y)). A still node
// (rotation ≡ 0) falls back to the translation only, IDENTICAL to before.
//
// Exported because the renderer applies it to the ctx while descending (ctx.transform with
// the same six numbers) and hit-test applies its INVERSE to the point: they are the
// two directions of the same thing, and must remain the same thing.
export function localTransformOf(n: NodeLite): Transform {
  const t = translation(n.x, n.y);
  // `animScale` exists only in playback-derived scenes
  // (animation/pose.ts): a real scene never has it, and the branch below costs
  // nothing to a still node (same translation as before, numbers included).
  const scaled = n.animScale !== undefined && n.animScale !== 1;
  if (!scaled && isUnrotated(n.rotation)) return t;
  const c: Point = n.animPivot ?? { x: n.x + n.width / 2, y: n.y + n.height / 2 };
  const rotated = isUnrotated(n.rotation) ? t : compose(rotationAround(c, n.rotation), t);
  if (!scaled) return rotated;
  // UNIFORM scale around the same center as the rotation: the two commute.
  const s = n.animScale as number;
  const scale: Transform = { a: s, b: 0, c: 0, d: s, e: c.x - s * c.x, f: c.y - s * c.y };
  return compose(scale, rotated);
}

// From the LOCAL space of `id` -- the one in which its CHILDREN's coordinates are
// written -- to the WORLD.
//
// `id` is a CONTAINER: a node's id or a page's. A
// page (like an unknown id or the empty string) contributes the IDENTITY:
// it is what keeps existing documents unchanged, in which every node sits
// directly under a page.
//
// CAUTION on the direction, it is the delicate point of the track: a node n's
// OWN coordinates do not live in its local space but in that of its
// parent, so whoever works on n's box (hit-test, bounds, resize) uses
// `worldTransformOf(scene, n.parentId)`, not `worldTransformOf(scene, n.id)`.
export function worldTransformOf(scene: SceneState, id: string): Transform {
  const node = scene.nodes.at(id);
  if (!node) return IDENTITY;
  let t = localTransformOf(node);
  // ancestorsOf: from nearest to farthest, it stops at the page and is already
  // cycle-proof (store/tree.ts). Every ancestor composes ON TOP of what
  // has accumulated, which is exactly the order in which the tree is descended.
  for (const a of ancestorsOf(scene, id)) t = compose(localTransformOf(a), t);
  return t;
}

// A transformed rectangle. The four CORNERS are transformed and the
// rectangle containing them is taken, instead of transforming origin and size: with
// a translation the two coincide, but this stays correct for
// any affine transform (with a rotation the result is the AABB of the
// rotated rectangle, which is the right meaning of "bounds" there).
export function mapBounds(t: Transform, b: Bounds): Bounds {
  const corners = [
    applyTransform(t, b.x, b.y),
    applyTransform(t, b.x + b.width, b.y),
    applyTransform(t, b.x + b.width, b.y + b.height),
    applyTransform(t, b.x, b.y + b.height),
  ];
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

// A DELTA (a displacement), not a point: it only goes through the LINEAR part
// of the transform, translation does not touch it. It is the difference between
// "where this point is" and "how much the pointer moved": transforming
// a displacement like a point would move it a second time.
export function mapVector(t: Transform, dx: number, dy: number): { x: number; y: number } {
  return { x: t.a * dx + t.c * dy, y: t.b * dx + t.d * dy };
}

// A node's box in WORLD coordinates. The model's box (x, y, width,
// height) is written in the PARENT's space, so the transform to
// apply is the parent's -- see the warning on worldTransformOf.
export function worldBoundsOfNode(scene: SceneState, n: NodeLite): Bounds {
  return mapBounds(worldTransformOf(scene, n.parentId), boundsOfNode(n));
}

// Point from the local space of the container `spaceId` to the world, and back --
// OR the ROTATION version (rotateAround around a center), depending on the
// second argument. The two live under the same name because they are the same
// question ("bring this point from local to world") asked at two different layers:
//   - (scene, spaceId, x, y)  descends/climbs the container tree (nesting);
//   - (point, center, deg)    rotates a point around a box's center (T2).
// The discriminant is the second argument: a string is a spaceId, a Point is
// a rotation center.
export function localToWorld(p: Point, c: Point, deg: number): Point;
export function localToWorld(scene: SceneState, spaceId: string, x: number, y: number): { x: number; y: number };
export function localToWorld(
  a: Point | SceneState,
  b: Point | string,
  c: number,
  d?: number,
): { x: number; y: number } {
  if (typeof b === "string") return applyTransform(worldTransformOf(a as SceneState, b), c, d as number);
  return rotateAround(a as Point, b, c);
}

export function worldToLocal(p: Point, c: Point, deg: number): Point;
export function worldToLocal(scene: SceneState, spaceId: string, wx: number, wy: number): { x: number; y: number };
export function worldToLocal(
  a: Point | SceneState,
  b: Point | string,
  c: number,
  d?: number,
): { x: number; y: number } {
  if (typeof b === "string") {
    return applyTransform(invertTransform(worldTransformOf(a as SceneState, b)), c, d as number);
  }
  return rotateAround(a as Point, b, -c);
}
