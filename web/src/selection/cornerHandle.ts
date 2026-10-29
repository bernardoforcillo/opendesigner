import { applyTransform, invertTransform, worldTransformOf } from "@/canvas/transform";
import { isCustomRect } from "@/renderer/shapeGeometry";
import { makeSetPropsOp } from "@/tools/ops";
import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";
import type { SceneState } from "@/store/types";

// LIVE CORNERS: a round handle inside the selected rectangle, near its top-left corner. Dragging it along the
// diagonal sets the corner radius of all four corners at once, and the rectangle rounds as the pointer moves.
//
// It sits `radius` in from the corner (so it rides the curve) but never closer than INSET_PX on screen, so a
// square-cornered rectangle still has a handle to grab. It shows only on a single selected plain rectangle that
// is at least 80 px on screen (a smaller one would put the handle in the way of an ordinary drag): with smoothed or independent corners the radius is not one number, and a small
// rectangle has no room for a handle apart from the resize ones.
export const CORNER_MIN_PX = 80;
export const CORNER_INSET_PX = 14;
export const CORNER_HIT_PX = 7;

export interface CornerHandle {
  id: string;
  /** In the node's own space (origin at its top-left). */
  local: { x: number; y: number };
  /** In the world. */
  world: { x: number; y: number };
  /** The largest radius: half the shorter side. */
  max: number;
  radius: number;
}

export function cornerHandleOf(scene: SceneState, selection: readonly string[], zoom: number): CornerHandle | null {
  if (selection.length !== 1 || !(zoom > 0)) return null;
  const n = scene.nodes.at(selection[0]);
  if (!n || n.kind !== "rect" || !n.visible || isCustomRect(n)) return null;
  const max = Math.min(n.width, n.height) / 2;
  if (max * 2 * zoom < CORNER_MIN_PX) return null;
  const inset = Math.min(max, Math.max(n.cornerRadius, CORNER_INSET_PX / zoom));
  const local = { x: inset, y: inset };
  return { id: n.id, local, world: applyTransform(worldTransformOf(scene, n.id), local.x, local.y), max, radius: n.cornerRadius };
}

/** Is the world point on the handle? */
export function cornerHandleHit(h: CornerHandle, world: { x: number; y: number }, zoom: number): boolean {
  return Math.hypot(world.x - h.world.x, world.y - h.world.y) <= CORNER_HIT_PX / zoom;
}

/** The radius the pointer asks for: how far along the diagonal it is from the corner, kept between 0 and the maximum. */
export function cornerRadiusAt(scene: SceneState, id: string, world: { x: number; y: number }, step = 0.5): number {
  const n = scene.nodes.at(id);
  if (!n) return 0;
  const p = applyTransform(invertTransform(worldTransformOf(scene, id)), world.x, world.y);
  const max = Math.min(n.width, n.height) / 2;
  const r = Math.min(max, Math.max(0, (p.x + p.y) / 2));
  return Math.round(r / step) * step;
}

/** The op that sets the radius of rectangle `id`. */
export function cornerRadiusOp(id: string, radius: number): Op {
  return makeSetPropsOp(id, { shape: { case: "rect" as const, value: { cornerRadius: radius } } }, ["corner_radius"]);
}
