import type { Camera } from "../canvas/camera";
import { type Bounds, worldAabbOfNode } from "../canvas/geometry";
import type { SceneState } from "../store/types";

// SNAP — AUTOMATIC ALIGNMENT DURING A GESTURE.
//
// The part that matters is a DECISION, not a drawing: given the candidates (the
// coordinates the moved box offers and those the other nodes expose),
// which snap to apply and where to draw the guide. It lives here, as a pure
// function, on purpose: it is where one-pixel errors live, and testing it through
// pointerdown/pointermove would mean not testing it at all.
//
// TWO DECLARED CHOICES, because both have a sensible alternative:
//
//  1. ROTATED NODES -> we snap to their AXIS-ALIGNED RECTANGLE (the AABB, see
//     canvas/geometry.ts::worldAabbOfNode), not to the slanted sides. It is what
//     editors do, and the reason is that a guide only makes sense if it is a
//     screen LINE: aligning the edge of a straight rectangle with the oblique side of
//     one rotated by 30° produces no visible alignment,
//     it produces an intersection. The AABB is also exactly what the selection
//     box shows for a multiple selection, so what the user
//     sees snapping is what they are looking at.
//
//  2. STROKE -> does NOT count. The targets are the GEOMETRY (worldAabbOfNode), not
//     the painted shape (worldVisualAabbOfNode): they are the same numbers the properties
//     panel shows in X/Y/W/H and that the selection box draws, so
//     "the edges match" stays true even after changing the thickness of a
//     stroke. Counting the protrusion would mean that two rectangles aligned at
//     x=100 stop being so as soon as one gets a border.

// Threshold in SCREEN px: at every zoom level the snap "clicks" at the same
// distance from the finger. In world coordinates the threshold tightens when zooming (see
// worldThreshold), which is the point: up close you position more finely.
export const SNAP_THRESHOLD_PX = 6;

export type SnapAxis = "x" | "y";

// A guide to draw: the line `pos` on the `axis` axis, extended from `from` to
// `to` on the OTHER axis. All in WORLD coordinates -- the conversion to screen belongs
// to the renderer, which goes through the camera like everyone else.
export interface SnapGuide {
  axis: SnapAxis;
  pos: number;
  from: number;
  to: number;
}

export interface SnapResult {
  dx: number;
  dy: number;
  guides: SnapGuide[];
}

// The WORLD coordinates corresponding to SNAP_THRESHOLD_PX screen px. The camera
// is a similarity (uniform scale), so the factor is the zoom and is
// identical on both axes.
export function worldThreshold(cam: Camera): number {
  return SNAP_THRESHOLD_PX / cam.zoom;
}

// The three coordinates a rectangle offers on an axis: min edge, CENTER,
// max edge. The center is there for both roles -- a box can snap with its
// own center, and can offer its own center to whoever is moving.
export function snapLines(b: Bounds, axis: SnapAxis): [number, number, number] {
  return axis === "x"
    ? [b.x, b.x + b.width / 2, b.x + b.width]
    : [b.y, b.y + b.height / 2, b.y + b.height];
}

export interface AxisSnap {
  // How much to move the box on this axis.
  delta: number;
  // The coordinates the snap lands on, increasing. There is more than one when
  // the SAME delta aligns two different lines (the left edge to one edge and
  // the right to another): they are two real alignments, and deserve two guides.
  positions: number[];
}

// THE DECISION, BARE. `moving` are the coordinates the moved box offers on an
// axis, `targets` those exposed by everything else; returns the best snap or
// null if no pair is within the threshold.
//
// "Best" = minimum distance. On an EXACT tie the smallest delta wins
// (i.e. the negative one): a rule is needed, and one that does not depend on the ORDER
// of the inputs -- the order of nodes in a scene is not stable
// (Object.values), so "the first one I met" would give different snaps
// for the same geometry.
//
// The threshold is INCLUSIVE: at a distance exactly equal to the threshold it snaps.
// The comparison is on the absolute value of the distance, without epsilon: an epsilon
// here would widen the threshold by an arbitrary amount, and the threshold is already
// expressed in a quantity the user perceives (screen px).
export function snapAxis(
  moving: readonly number[],
  targets: readonly number[],
  threshold: number,
): AxisSnap | null {
  if (!(threshold >= 0)) return null;
  let best: number | null = null;
  for (const m of moving) {
    for (const t of targets) {
      const d = t - m;
      const ad = Math.abs(d);
      if (ad > threshold) continue;
      if (best === null) {
        best = d;
        continue;
      }
      const ab = Math.abs(best);
      if (ad < ab || (ad === ab && d < best)) best = d;
    }
  }
  if (best === null) return null;
  const positions: number[] = [];
  for (const m of moving) {
    for (const t of targets) {
      // EXACT equality and not "within an epsilon": `best` is one of these
      // same t - m, so the pair that produced it is always found again. A
      // pair that gives the same value only up to floating-point error
      // is an alignment the user cannot tell apart: not showing its guide
      // removes a line, not a snap.
      if (t - m === best && !positions.includes(t)) positions.push(t);
    }
  }
  positions.sort((a, b) => a - b);
  return { delta: best, positions };
}

// The extent of the guide on the PERPENDICULAR axis: from the moved box to the
// farthest of the nodes it aligned with. It is the sign that says "these two are
// on the same line", so it must touch both.
function extentOf(b: Bounds, axis: SnapAxis): [number, number] {
  return axis === "x" ? [b.y, b.y + b.height] : [b.x, b.x + b.width];
}

function guidesFor(
  box: Bounds,
  targets: readonly Bounds[],
  axis: SnapAxis,
  snap: AxisSnap,
): SnapGuide[] {
  return snap.positions.map((pos) => {
    let [from, to] = extentOf(box, axis);
    for (const t of targets) {
      if (!snapLines(t, axis).includes(pos)) continue;
      const [f, e] = extentOf(t, axis);
      from = Math.min(from, f);
      to = Math.max(to, e);
    }
    return { axis, pos, from, to };
  });
}

// The snap of a rectangle of which ONLY certain lines can move. It is the general
// form: dragging offers all six lines (see
// snapBounds), resizing only the edges the handle really moves
// -- snapping the left edge while dragging the right would move the
// node instead of resizing it.
//
// The guides' extent is measured on `box` AS IT IS: the snap moves it at
// most by a threshold, i.e. a few screen pixels, and a guide a few
// pixels shorter is not a different guide.
export function snapMoving(
  box: Bounds,
  moving: { x: readonly number[]; y: readonly number[] },
  targets: readonly Bounds[] | SnapIndex,
  threshold: number,
): SnapResult {
  const guides: SnapGuide[] = [];
  let dx = 0;
  let dy = 0;
  // With an already prepared index (a drag gesture) the search is O(log n);
  // with a plain list (a test, an occasional caller) it scans.
  const index = targets instanceof SnapIndex ? targets : null;
  const list = targets instanceof SnapIndex ? targets.targets : targets;
  for (const axis of ["x", "y"] as const) {
    if (moving[axis].length === 0) continue;
    if (index) {
      const snap = index.axisSnap(axis, moving[axis], threshold);
      if (!snap) continue;
      if (axis === "x") dx = snap.delta;
      else dy = snap.delta;
      guides.push(...index.guides(box, axis, snap));
      continue;
    }
    const lines: number[] = [];
    for (const t of list) lines.push(...snapLines(t, axis));
    const snap = snapAxis(moving[axis], lines, threshold);
    if (!snap) continue;
    if (axis === "x") dx = snap.delta;
    else dy = snap.delta;
    guides.push(...guidesFor(box, list, axis, snap));
  }
  return { dx, dy, guides };
}

// The DRAG case: the rectangle moves as a whole, so it offers
// edges and centers on both axes.
export function snapBounds(box: Bounds, targets: readonly Bounds[] | SnapIndex, threshold: number): SnapResult {
  return snapMoving(box, { x: snapLines(box, "x"), y: snapLines(box, "y") }, targets, threshold);
}

// THE PREPARED TARGET. A drag gesture asks for the snap on EVERY
// pointer move, against the same targets: rebuilding every time the
// list of all their lines (with 20,000 nodes, 60,000 numbers per axis) and
// searching it linearly cost ~5 ms per move. Here the lines are
// sorted ONCE, and each request does a binary search in the window
// [m - threshold, m + threshold]. The result is IDENTICAL to that of the linear
// scan (same snap, same guides): a test against it pins this down.
export class SnapIndex {
  readonly targets: readonly Bounds[];
  private readonly lines: Record<SnapAxis, Float64Array>;
  // position -> indices of the targets that have a line EXACTLY there, for
  // the guides' extent (guidesFor looks them up by exact equality).
  private readonly byPos: Record<SnapAxis, Map<number, number[]>>;

  constructor(targets: readonly Bounds[]) {
    this.targets = targets;
    const mk = (axis: SnapAxis) => {
      const lines = new Float64Array(targets.length * 3);
      const byPos = new Map<number, number[]>();
      targets.forEach((t, i) => {
        const l = snapLines(t, axis);
        for (let k = 0; k < 3; k++) {
          lines[i * 3 + k] = l[k];
          const list = byPos.get(l[k]);
          if (list) {
            if (list[list.length - 1] !== i) list.push(i);
          } else byPos.set(l[k], [i]);
        }
      });
      lines.sort();
      return { lines, byPos };
    };
    const x = mk("x");
    const y = mk("y");
    this.lines = { x: x.lines, y: y.lines };
    this.byPos = { x: x.byPos, y: y.byPos };
  }

  // The same result as snapAxis(moving, allTheLines, threshold).
  axisSnap(axis: SnapAxis, moving: readonly number[], threshold: number): AxisSnap | null {
    if (!(threshold >= 0)) return null;
    const lines = this.lines[axis];
    // The window widens by an epsilon: |t - m| <= threshold is then decided with the
    // SAME expression as the linear scan, so an edge that floating-point
    // arithmetic puts inside or outside is put identically.
    const slack = (m: number) => threshold + 1e-9 * (1 + Math.abs(m));
    const lowerBound = (v: number): number => {
      let lo = 0;
      let hi = lines.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (lines[mid] < v) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    let best: number | null = null;
    for (const m of moving) {
      const w = slack(m);
      for (let i = lowerBound(m - w); i < lines.length && lines[i] <= m + w; i++) {
        const d = lines[i] - m;
        const ad = Math.abs(d);
        if (ad > threshold) continue;
        if (best === null) {
          best = d;
          continue;
        }
        const ab = Math.abs(best);
        if (ad < ab || (ad === ab && d < best)) best = d;
      }
    }
    if (best === null) return null;
    const positions: number[] = [];
    for (const m of moving) {
      const t = m + best;
      // The lines t with t - m === best (exact equality): they are those at
      // distance `best`, i.e. in the neighborhood of m + best.
      const w = 1e-9 * (1 + Math.abs(t));
      for (let i = lowerBound(t - w); i < lines.length && lines[i] <= t + w; i++) {
        if (lines[i] - m === best && !positions.includes(lines[i])) positions.push(lines[i]);
      }
    }
    positions.sort((a, b) => a - b);
    return { delta: best, positions };
  }

  guides(box: Bounds, axis: SnapAxis, snap: AxisSnap): SnapGuide[] {
    return snap.positions.map((pos) => {
      let [from, to] = extentOf(box, axis);
      for (const i of this.byPos[axis].get(pos) ?? []) {
        const [f, e] = extentOf(this.targets[i], axis);
        from = Math.min(from, f);
        to = Math.max(to, e);
      }
      return { axis, pos, from, to };
    });
  }
}

/** Prepares the targets for a gesture: repeated snap requests cost O(log n). */
export function prepareSnapTargets(targets: readonly Bounds[]): SnapIndex {
  return new SnapIndex(targets);
}

// The rectangles that can be snapped to: every VISIBLE node that is not being
// moved. Invisible means not seen, and snapping to a line that
// is not there is indistinguishable from a snap for no reason.
export function snapTargets(scene: SceneState, exclude: readonly string[]): Bounds[] {
  const skip = new Set(exclude);
  const out: Bounds[] = [];
  for (const n of [...scene.nodes.values()]) {
    if (!n.visible || skip.has(n.id)) continue;
    out.push(worldAabbOfNode(n));
  }
  return out;
}
