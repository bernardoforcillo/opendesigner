import type { Bounds } from "../canvas/geometry";
import { worldBoundsOfNode } from "../canvas/transform";
import type { SceneState, TransitionLite } from "../store/types";
import {
  arrowBetween, bezierBounds, bezierPoint, distanceToBezier, inflate, laneShift, overlaps,
  type Bezier, type Pt,
} from "./geometry";

// THE ARROW LAYOUT: from the document's transitions to curves in the world.
// It depends only on scene.nodes and scene.transitions, so it is memoized on those
// two references: as long as they do not change (camera moving, hover, selection)
// the renderer and the hit-test reuse the SAME array, without allocating.

export interface Arrow {
  id: string;
  flowId: string;
  fromId: string;
  toId: string;
  curve: Bezier;
  /** The rectangle that contains the curve (for culling). */
  bounds: Bounds;
  /** The midpoint, where the label pill sits. */
  mid: Pt;
  /** The hotspot (world bounds of the element that triggers), if the transition has one. */
  hotspot: Bounds | null;
  label: string;
  trigger: string;
  guarded: boolean;
}

export interface FlowLayout {
  arrows: Arrow[];
  byId: Map<string, Arrow>;
}

// Half-sides (SCREEN px) of the grab on the label pill: the pill is
// clicked like the arrow. The hit-test divides them by the zoom.
export const LABEL_HIT = { w: 40, h: 11 };

const EMPTY: FlowLayout = { arrows: [], byId: new Map() };

let memo: { nodes: unknown; transitions: unknown; layout: FlowLayout } | null = null;

function boundsOf(scene: SceneState, id: string): Bounds | null {
  const n = scene.nodes.at(id);
  return n ? worldBoundsOfNode(scene, n) : null;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

/** The pill text: the label, otherwise the trigger (the "what" of the transition). */
export function arrowLabel(t: Pick<TransitionLite, "label" | "trigger">): string {
  return t.label.trim() !== "" ? t.label.trim() : t.trigger;
}

/** Computes the layout of ALL the document's transitions (memoized). */
export function flowLayout(scene: SceneState): FlowLayout {
  if (memo && memo.nodes === scene.nodes && memo.transitions === scene.transitions) return memo.layout;
  const all = Object.values(scene.transitions);
  if (all.length === 0) {
    memo = { nodes: scene.nodes, transitions: scene.transitions, layout: EMPTY };
    return EMPTY;
  }
  // Stable order (by id): an arrow's lane must not change when
  // another one arrives from a peer.
  all.sort((a, b) => (a.id < b.id ? -1 : 1));
  // How many arrows share each pair of screens (in either direction).
  const counts = new Map<string, number>();
  for (const t of all) {
    const k = pairKey(t.fromId, t.toId);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  const arrows: Arrow[] = [];
  const byId = new Map<string, Arrow>();
  for (const t of all) {
    const fromScreen = boundsOf(scene, t.fromId);
    const toScreen = boundsOf(scene, t.toId);
    if (!fromScreen || !toScreen) continue;
    const k = pairKey(t.fromId, t.toId);
    const lane = seen.get(k) ?? 0;
    seen.set(k, lane + 1);
    const hotspot = t.elementId !== "" ? boundsOf(scene, t.elementId) : null;
    // With a hotspot the arrow is born from the element (the button), not from the edge
    // of the screen: that is where the user would read it.
    const start = hotspot ?? fromScreen;
    const count = counts.get(k) ?? 1;
    const curve = arrowBetween(start, toScreen, laneShift(lane, count), t.fromId === t.toId);
    const arrow: Arrow = {
      id: t.id,
      flowId: t.flowId,
      fromId: t.fromId,
      toId: t.toId,
      curve,
      bounds: bezierBounds(curve),
      // The pill sits at mid-curve; with several arrows on the same pair it
      // is staggered along the curve, so the labels do not cover each other.
      mid: bezierPoint(curve, count <= 1 ? 0.5 : Math.min(0.72, Math.max(0.28, 0.5 + (lane - (count - 1) / 2) * 0.16))),
      hotspot,
      label: arrowLabel(t),
      trigger: t.trigger,
      guarded: t.guard.trim() !== "",
    };
    arrows.push(arrow);
    byId.set(arrow.id, arrow);
  }
  const layout = { arrows, byId };
  memo = { nodes: scene.nodes, transitions: scene.transitions, layout };
  return layout;
}

/** The arrows that touch the view (world): culling for large documents. */
export function arrowsInView(layout: FlowLayout, view: Bounds, pad: number): Arrow[] {
  const v = inflate(view, pad);
  return layout.arrows.filter((a) => overlaps(a.bounds, v));
}

/**
 * The arrow under (x, y) (world), the closest within `tol` world units, with
 * priority to the arrows of flow `preferFlowId`. null if none. Label
 * pill included: `labelHalf` is the half-side (world) of its grab box
 * around the midpoint.
 */
export function hitArrow(
  layout: FlowLayout,
  x: number,
  y: number,
  tol: number,
  labelHalf: { w: number; h: number },
  allowed?: (a: Arrow) => boolean,
): Arrow | null {
  let best: Arrow | null = null;
  let bestD = Infinity;
  for (const a of layout.arrows) {
    if (allowed && !allowed(a)) continue;
    // The prefilter also lets the pill through, which sticks out of the rectangle of the
    // control points (a straight arrow has zero height).
    const px = Math.max(tol, labelHalf.w);
    const py = Math.max(tol, labelHalf.h);
    if (x < a.bounds.x - px || x > a.bounds.x + a.bounds.width + px) continue;
    if (y < a.bounds.y - py || y > a.bounds.y + a.bounds.height + py) continue;
    let d = distanceToBezier(a.curve, x, y);
    // Inside the label pill it counts as a full hit.
    if (Math.abs(x - a.mid.x) <= labelHalf.w && Math.abs(y - a.mid.y) <= labelHalf.h) d = 0;
    if (d <= tol && d < bestD) {
      best = a;
      bestD = d;
    }
  }
  return best;
}
