import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import type { NodeLite, StrokeLite, SubPathLite, WidthPointLite } from "../store/types";
import { toPbStrokes } from "../store/types";
import { flattenSubpath } from "../store/vectorGeometry";
import { makeSetPropsOp } from "../tools/ops";
import { BEZIER_TOLERANCE } from "./boolean";
import { MAX_WIDTH_POINTS, MAX_WIDTH_SCALE, dedupe, widthAt } from "./widthProfile";

// The EDITING half of variable-width strokes: where a width point sits on the path, which handle the
// pointer grabs, and the profile after a drag, an insert or a delete. Pure functions on a node and its
// profile; the Variable width tool (tools/widthTool.ts) and the panel (ui/WidthControls.tsx) turn them
// into ops.

type Pt = { x: number; y: number };

/** A point on a subpath: its fraction of the length, its position and the unit LEFT normal of travel there. */
export interface PathSample { sub: number; t: number; x: number; y: number; nx: number; ny: number }

const DEFAULT_STROKE: StrokeLite = { color: { r: 0, g: 0, b: 0, a: 1 }, weight: 4, align: "center" };

/** The stroke whose profile is edited: the first with a positive weight. */
export function widthStrokeOf(n: NodeLite): StrokeLite | undefined {
  return n.strokes.find((s) => s.weight > 0);
}

export function profileOf(n: NodeLite): readonly WidthPointLite[] {
  return widthStrokeOf(n)?.widthProfile ?? [];
}

// The subpath as the polyline the stroke is built from (the same dedupe, so the fractions agree).
function polylineOf(sp: SubPathLite): Pt[] {
  return dedupe(flattenSubpath(sp, BEZIER_TOLERANCE), sp.closed);
}

function lengthsOf(pts: Pt[], closed: boolean): number[] {
  const n = pts.length;
  const cum = [0];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) cum.push(cum[i] + Math.hypot(pts[(i + 1) % n].x - pts[i].x, pts[(i + 1) % n].y - pts[i].y));
  return cum;
}

/** The point at fraction `t` of subpath `sub` (null for a path too short to have a direction). */
export function sampleAt(subpaths: readonly SubPathLite[], sub: number, t: number): PathSample | null {
  const sp = subpaths[sub];
  if (!sp) return null;
  const pts = polylineOf(sp);
  if (pts.length < 2) return null;
  const cum = lengthsOf(pts, sp.closed);
  const total = cum[cum.length - 1];
  if (!(total > 0)) return null;
  const want = Math.min(1, Math.max(0, t)) * total;
  let i = 0;
  while (i < cum.length - 2 && cum[i + 1] < want) i++;
  const a = pts[i], b = pts[(i + 1) % pts.length];
  const l = cum[i + 1] - cum[i];
  const k = l > 0 ? (want - cum[i]) / l : 0;
  const dx = (b.x - a.x) / l, dy = (b.y - a.y) / l;
  return { sub, t, x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, nx: dy, ny: -dx };
}

/** The nearest point of any subpath to (lx, ly) within `tol`, with its fraction of the path. */
export function locateOnPath(subpaths: readonly SubPathLite[], lx: number, ly: number, tol: number): (PathSample & { dist: number }) | null {
  let best: (PathSample & { dist: number }) | null = null;
  subpaths.forEach((sp, sub) => {
    const pts = polylineOf(sp);
    if (pts.length < 2) return;
    const cum = lengthsOf(pts, sp.closed);
    const total = cum[cum.length - 1];
    if (!(total > 0)) return;
    for (let i = 0; i < cum.length - 1; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const l = cum[i + 1] - cum[i];
      const ux = (b.x - a.x) / l, uy = (b.y - a.y) / l;
      const along = Math.min(l, Math.max(0, (lx - a.x) * ux + (ly - a.y) * uy));
      const px = a.x + ux * along, py = a.y + uy * along;
      const dist = Math.hypot(lx - px, ly - py);
      if (dist <= tol && (!best || dist < best.dist)) best = { sub, t: (cum[i] + along) / total, x: px, y: py, nx: uy, ny: -ux, dist };
    }
  });
  return best;
}

/** A grabbable end of a width point: one side of the stroke at one profile point of one subpath. */
export interface WidthHandle { sub: number; index: number; side: "left" | "right"; x: number; y: number }

/** Where every profile point's two handles sit (distance = multiple * weight / 2 off the path). */
export function widthHandles(n: NodeLite): WidthHandle[] {
  const s = widthStrokeOf(n);
  const subpaths = n.vector?.subpaths ?? [];
  if (!s?.widthProfile?.length) return [];
  const out: WidthHandle[] = [];
  subpaths.forEach((_, sub) => s.widthProfile!.forEach((p, index) => {
    const at = sampleAt(subpaths, sub, p.position);
    if (!at) return;
    const half = s.weight / 2;
    out.push({ sub, index, side: "left", x: at.x + at.nx * p.left * half, y: at.y + at.ny * p.left * half });
    out.push({ sub, index, side: "right", x: at.x - at.nx * p.right * half, y: at.y - at.ny * p.right * half });
  }));
  return out;
}

/** The handle nearest to (lx, ly) within `tol`. */
export function pickWidthHandle(handles: readonly WidthHandle[], lx: number, ly: number, tol: number): WidthHandle | null {
  let best: { h: WidthHandle; d: number } | null = null;
  for (const h of handles) {
    const d = Math.hypot(h.x - lx, h.y - ly);
    if (d <= tol && (!best || d < best.d)) best = { h, d };
  }
  return best?.h ?? null;
}

const POSITION_EPS = 0.005;
const clampScale = (v: number) => Math.min(MAX_WIDTH_SCALE, Math.max(0, v));

/**
 * The profile with a point at `t` (its widths read off the current profile, so the stroke does not change
 * shape), and its index. A point already there is reused; null if the profile is full.
 */
export function insertWidthPoint(profile: readonly WidthPointLite[], t: number): { profile: WidthPointLite[]; index: number } | null {
  const near = profile.findIndex((p) => Math.abs(p.position - t) < POSITION_EPS);
  if (near >= 0) return { profile: profile.map((p) => ({ ...p })), index: near };
  if (profile.length >= MAX_WIDTH_POINTS) return null;
  const w = widthAt(profile, t);
  const at = profile.findIndex((p) => p.position > t);
  const index = at < 0 ? profile.length : at;
  const next = profile.map((p) => ({ ...p }));
  next.splice(index, 0, { position: t, left: w.left, right: w.right });
  return { profile: next, index };
}

export function removeWidthPoint(profile: readonly WidthPointLite[], index: number): WidthPointLite[] {
  return profile.filter((_, i) => i !== index).map((p) => ({ ...p }));
}

/**
 * The profile after dragging a handle to a distance `d` off the path (world units): the side takes
 * d / (weight / 2) as its multiple, both sides with `both`.
 */
export function dragWidth(profile: readonly WidthPointLite[], index: number, side: "left" | "right", d: number, weight: number, both: boolean): WidthPointLite[] {
  const v = clampScale(weight > 0 ? Math.max(0, d) / (weight / 2) : 0);
  return profile.map((p, i) => (i !== index ? { ...p } : {
    ...p, left: side === "left" || both ? v : p.left, right: side === "right" || both ? v : p.right,
  }));
}

/** Moves a point along the path to `t`, between its neighbours (it never passes them). */
export function movePointAlong(profile: readonly WidthPointLite[], index: number, t: number): WidthPointLite[] {
  const lo = index > 0 ? profile[index - 1].position : 0;
  const hi = index < profile.length - 1 ? profile[index + 1].position : 1;
  const pos = Math.min(hi, Math.max(lo, t));
  return profile.map((p, i) => (i === index ? { ...p, position: pos } : { ...p }));
}

/**
 * Writes `profile` on the node's first stroke (a node with none gets a 4 unit black one, so there is a line
 * to vary); an empty profile goes back to the uniform stroke. No ops if nothing changes or it is not a vector.
 */
export function setWidthProfileOps(n: NodeLite, profile: readonly WidthPointLite[]): Op[] {
  if (n.kind !== "vector") return [];
  const at = n.strokes.findIndex((s) => s.weight > 0);
  const base = at >= 0 ? n.strokes[at] : DEFAULT_STROKE;
  const next: StrokeLite = { ...base };
  if (profile.length > 0) next.widthProfile = profile.map((p) => ({ ...p })); else delete next.widthProfile;
  if (at >= 0 && JSON.stringify(next) === JSON.stringify(base)) return [];
  const strokes = at >= 0 ? n.strokes.map((s, i) => (i === at ? next : s)) : [next, ...n.strokes];
  return [makeSetPropsOp(n.id, { strokes: toPbStrokes(strokes) }, ["strokes"])];
}

/** The profile with point `index` changed: its position stays between its neighbours, its widths within range. */
export function setWidthPoint(profile: readonly WidthPointLite[], index: number, patch: Partial<WidthPointLite>): WidthPointLite[] {
  const moved = patch.position === undefined ? profile : movePointAlong(profile, index, patch.position);
  return moved.map((p, i) => (i !== index ? { ...p } : {
    ...p, left: patch.left === undefined ? p.left : clampScale(patch.left), right: patch.right === undefined ? p.right : clampScale(patch.right),
  }));
}

/** A new point in the middle of the widest gap between points (the ends 0 and 1 included), keeping the stroke's shape. Null if full. */
export function addWidthPointInGap(profile: readonly WidthPointLite[]): { profile: WidthPointLite[]; index: number } | null {
  const marks = [0, ...profile.map((p) => p.position), 1];
  let best = 0;
  for (let i = 1; i < marks.length; i++) if (marks[i] - marks[i - 1] > marks[best + 1] - marks[best]) best = i - 1;
  return insertWidthPoint(profile, (marks[best] + marks[best + 1]) / 2);
}
