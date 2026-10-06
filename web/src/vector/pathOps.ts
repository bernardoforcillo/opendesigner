import polygonClipping from "polygon-clipping";
import type { MultiPolygon, Pair, Ring } from "polygon-clipping";
import { flattenSubpath, subpathFills } from "../store/vectorGeometry";
import type { PointLite } from "../store/vectorGeometry";
import type { AnchorLite, SubPathLite } from "../store/types";
import { BEZIER_TOLERANCE, booleanRegion } from "./regions";
import { strokePolyline } from "./outlineStroke";

// PATH EDITING, as pure functions over subpaths in the node's LOCAL space (the anchors' own
// coordinates, handles relative to their anchor). The tools and panels decide WHAT to edit; here is
// how a path changes. Every function returns new subpaths and never mutates its input.

const EPS = 1e-6;
const corner = (x: number, y: number): AnchorLite => ({ x, y, inX: 0, inY: 0, outX: 0, outY: 0 });
const lerp = (a: PointLite, b: PointLite, t: number): PointLite => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** The four control points of the segment from anchor `i` to the next one. */
function controls(sp: SubPathLite, i: number): [PointLite, PointLite, PointLite, PointLite] {
  const a = sp.anchors[i], b = sp.anchors[(i + 1) % sp.anchors.length];
  return [{ x: a.x, y: a.y }, { x: a.x + a.outX, y: a.y + a.outY }, { x: b.x + b.inX, y: b.y + b.inY }, { x: b.x, y: b.y }];
}

export function segmentCountOf(sp: SubPathLite): number {
  const n = sp.anchors.length;
  return n < 2 ? 0 : sp.closed ? n : n - 1;
}

const withAnchors = (sp: SubPathLite, anchors: AnchorLite[]): SubPathLite => ({ ...sp, anchors });
const replaceSub = (all: readonly SubPathLite[], i: number, sp: SubPathLite | null): SubPathLite[] =>
  sp ? all.map((s, k) => (k === i ? sp : s)) : all.filter((_, k) => k !== i);

// ---- reading -----------------------------------------------------------------

export interface PathHit { seg: number; t: number; dist: number; point: PointLite }

/** The point of a subpath nearest to (x, y), within `tol`; null if none is that close. */
export function nearestOnPath(sp: SubPathLite, x: number, y: number, tol: number): PathHit | null {
  let best: PathHit | null = null;
  const N = 40;
  for (let s = 0; s < segmentCountOf(sp); s++) {
    const [p0, p1, p2, p3] = controls(sp, s);
    const at = (t: number): PointLite => {
      const u = 1 - t;
      return {
        x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
        y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
      };
    };
    let lo = 0, hiT = 1, bestT = 0, bestD = Infinity;
    for (let k = 0; k <= N; k++) {
      const p = at(k / N);
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bestD) { bestD = d; bestT = k / N; }
    }
    // Refine around the best sample.
    lo = Math.max(0, bestT - 1 / N); hiT = Math.min(1, bestT + 1 / N);
    for (let k = 0; k <= 20; k++) {
      const t = lo + ((hiT - lo) * k) / 20;
      const p = at(t);
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bestD) { bestD = d; bestT = t; }
    }
    if (bestD <= tol && (best === null || bestD < best.dist)) best = { seg: s, t: bestT, dist: bestD, point: at(bestT) };
  }
  return best;
}

/** A smooth anchor: both handles exist and point in opposite directions. */
export function isSmooth(a: AnchorLite): boolean {
  const li = Math.hypot(a.inX, a.inY), lo = Math.hypot(a.outX, a.outY);
  if (li < EPS || lo < EPS) return false;
  return Math.abs((a.inX * a.outY - a.inY * a.outX) / (li * lo)) < 1e-3 && a.inX * a.outX + a.inY * a.outY < 0;
}

// ---- editing one path --------------------------------------------------------

/** Splits the segment `seg` at `t` with a new anchor that keeps the curve's shape. */
export function insertAnchor(sp: SubPathLite, seg: number, t: number): SubPathLite {
  if (seg < 0 || seg >= segmentCountOf(sp)) return sp;
  const [p0, p1, p2, p3] = controls(sp, seg);
  const p01 = lerp(p0, p1, t), p12 = lerp(p1, p2, t), p23 = lerp(p2, p3, t);
  const p012 = lerp(p01, p12, t), p123 = lerp(p12, p23, t);
  const m = lerp(p012, p123, t);
  const n = sp.anchors.length;
  const a = sp.anchors[seg], bi = (seg + 1) % n, b = sp.anchors[bi];
  const left: AnchorLite = { ...a, outX: p01.x - a.x, outY: p01.y - a.y };
  const mid: AnchorLite = { x: m.x, y: m.y, inX: p012.x - m.x, inY: p012.y - m.y, outX: p123.x - m.x, outY: p123.y - m.y };
  const right: AnchorLite = { ...b, inX: p23.x - b.x, inY: p23.y - b.y };
  const anchors = sp.anchors.map((x) => ({ ...x }));
  anchors[seg] = left;
  anchors[bi] = right;
  anchors.splice(seg + 1, 0, mid);
  // When the split was the closing segment, `right` is anchor 0 and `mid` lands at the end: still in order.
  return withAnchors(sp, anchors);
}

/** Removes anchor `i`; null when nothing is left. The neighbours keep their own handles. */
export function deleteAnchor(sp: SubPathLite, i: number): SubPathLite | null {
  if (i < 0 || i >= sp.anchors.length) return sp;
  const anchors = sp.anchors.filter((_, k) => k !== i);
  if (anchors.length === 0) return null;
  return { ...sp, anchors, closed: sp.closed && anchors.length >= 2 };
}

export function moveAnchor(sp: SubPathLite, i: number, x: number, y: number): SubPathLite {
  return withAnchors(sp, sp.anchors.map((a, k) => (k === i ? { ...a, x, y } : a)));
}

/**
 * Drags a handle to the local point (x, y). On a smooth anchor the opposite handle turns with it
 * (keeping its own length) unless `independent` (Alt) is set.
 */
export function moveHandle(sp: SubPathLite, i: number, which: "in" | "out", x: number, y: number, independent = false): SubPathLite {
  const a = sp.anchors[i];
  if (!a) return sp;
  const dx = x - a.x, dy = y - a.y;
  const next: AnchorLite = which === "in" ? { ...a, inX: dx, inY: dy } : { ...a, outX: dx, outY: dy };
  if (!independent && isSmooth(a)) {
    const len = which === "in" ? Math.hypot(a.outX, a.outY) : Math.hypot(a.inX, a.inY);
    const d = Math.hypot(dx, dy);
    if (d > EPS) {
      const ox = (-dx / d) * len, oy = (-dy / d) * len;
      if (which === "in") { next.outX = ox; next.outY = oy; } else { next.inX = ox; next.inY = oy; }
    }
  }
  return withAnchors(sp, sp.anchors.map((q, k) => (k === i ? next : q)));
}

/** Corner point: no handles. */
export function makeCorner(sp: SubPathLite, i: number): SubPathLite {
  return withAnchors(sp, sp.anchors.map((a, k) => (k === i ? corner(a.x, a.y) : a)));
}

/**
 * Smooth point: handles along the line between its neighbours (a third of the way to each), as a
 * Catmull-Rom spline would put them. An end of an open path has one neighbour and gets one handle.
 */
export function makeSmooth(sp: SubPathLite, i: number): SubPathLite {
  const n = sp.anchors.length;
  const a = sp.anchors[i];
  if (!a || n < 2) return sp;
  const hasPrev = sp.closed || i > 0, hasNext = sp.closed || i < n - 1;
  const prev = sp.anchors[(i - 1 + n) % n], next = sp.anchors[(i + 1) % n];
  let tx: number, ty: number;
  if (hasPrev && hasNext) { tx = next.x - prev.x; ty = next.y - prev.y; }
  else if (hasNext) { tx = next.x - a.x; ty = next.y - a.y; }
  else { tx = a.x - prev.x; ty = a.y - prev.y; }
  const tl = Math.hypot(tx, ty);
  if (tl < EPS) return sp;
  const ux = tx / tl, uy = ty / tl;
  const lenIn = hasPrev ? Math.hypot(a.x - prev.x, a.y - prev.y) / 3 : 0;
  const lenOut = hasNext ? Math.hypot(next.x - a.x, next.y - a.y) / 3 : 0;
  const nz = (v: number) => (v === 0 ? 0 : v); // no negative zero in the document
  const m: AnchorLite = { x: a.x, y: a.y, inX: nz(-ux * lenIn), inY: nz(-uy * lenIn), outX: nz(ux * lenOut), outY: nz(uy * lenOut) };
  return withAnchors(sp, sp.anchors.map((q, k) => (k === i ? m : q)));
}

export function smoothAll(sp: SubPathLite): SubPathLite {
  let out = sp;
  for (let i = 0; i < sp.anchors.length; i++) out = makeSmooth(out, i);
  return out;
}

export function cornerAll(sp: SubPathLite): SubPathLite {
  return withAnchors(sp, sp.anchors.map((a) => corner(a.x, a.y)));
}

export function toggleClosed(sp: SubPathLite): SubPathLite {
  return sp.anchors.length < 2 ? sp : { ...sp, closed: !sp.closed };
}

// ---- simplification ------------------------------------------------------------

function distToSeg(p: PointLite, a: PointLite, b: PointLite): number {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Ramer-Douglas-Peucker: the subset of `pts` that keeps every dropped point within `tol` of the line. */
function rdp(pts: PointLite[], tol: number): PointLite[] {
  if (pts.length < 3) return pts;
  const keep = new Array<boolean>(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length > 0) {
    const [s, e] = stack.pop()!;
    let worst = -1, wi = -1;
    for (let k = s + 1; k < e; k++) {
      const d = distToSeg(pts[k], pts[s], pts[e]);
      if (d > worst) { worst = d; wi = k; }
    }
    if (worst > tol && wi >= 0) { keep[wi] = true; stack.push([s, wi], [wi, e]); }
  }
  return pts.filter((_, k) => keep[k]);
}

/**
 * Fewer anchors for the same shape within `tol` (local units): the curve is flattened, thinned with
 * Ramer-Douglas-Peucker and, if the path had curves, smoothed again. A path with nothing to drop
 * comes back unchanged.
 */
export function simplifySubpath(sp: SubPathLite, tol: number): SubPathLite {
  if (sp.anchors.length < 3 || !(tol > 0)) return sp;
  const hadCurves = sp.anchors.some((a) => a.inX !== 0 || a.inY !== 0 || a.outX !== 0 || a.outY !== 0);
  let pts = flattenSubpath(sp, Math.min(BEZIER_TOLERANCE, tol / 4));
  if (sp.closed && pts.length > 1 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) < EPS) pts = pts.slice(0, -1);
  // A closed ring is cut at its two farthest-apart points so RDP has two stable ends.
  let kept: PointLite[];
  if (sp.closed && pts.length >= 4) {
    let bi = 1, bd = -1;
    for (let k = 1; k < pts.length; k++) { const d = Math.hypot(pts[k].x - pts[0].x, pts[k].y - pts[0].y); if (d > bd) { bd = d; bi = k; } }
    const first = rdp(pts.slice(0, bi + 1), tol);
    const second = rdp([...pts.slice(bi), pts[0]], tol);
    kept = [...first, ...second.slice(1, -1)];
  } else {
    kept = rdp(pts, tol);
  }
  if (kept.length >= sp.anchors.length) return sp;
  const simpler: SubPathLite = { closed: sp.closed, anchors: kept.map((p) => corner(p.x, p.y)) };
  return hadCurves ? smoothAll(simpler) : simpler;
}

// ---- joining -------------------------------------------------------------------

/**
 * Joins two open paths end to end: the closest pair of ends is connected, and ends that already
 * touch (within `eps`) are merged into one anchor. Null when either is closed or empty.
 */
export function joinSubpaths(a: SubPathLite, b: SubPathLite, eps = 0.5): SubPathLite | null {
  if (a.closed || b.closed || a.anchors.length === 0 || b.anchors.length === 0) return null;
  const rev = (sp: SubPathLite): AnchorLite[] => [...sp.anchors].reverse().map((q) => ({ ...q, inX: q.outX, inY: q.outY, outX: q.inX, outY: q.inY }));
  const ends = (sp: SubPathLite) => [sp.anchors[0], sp.anchors[sp.anchors.length - 1]];
  const [a0, a1] = ends(a), [b0, b1] = ends(b);
  const d = (p: AnchorLite, q: AnchorLite) => Math.hypot(p.x - q.x, p.y - q.y);
  // Orient so `left` ends where `right` begins.
  const options: { left: AnchorLite[]; right: AnchorLite[]; gap: number }[] = [
    { left: a.anchors, right: b.anchors, gap: d(a1, b0) },
    { left: a.anchors, right: rev(b), gap: d(a1, b1) },
    { left: rev(a), right: b.anchors, gap: d(a0, b0) },
    { left: rev(a), right: rev(b), gap: d(a0, b1) },
  ];
  const best = options.reduce((x, y) => (y.gap < x.gap ? y : x));
  const left = best.left.map((q) => ({ ...q })), right = best.right.map((q) => ({ ...q }));
  if (best.gap <= eps) {
    const l = left[left.length - 1], r = right[0];
    left[left.length - 1] = { ...l, outX: r.outX, outY: r.outY };
    return { closed: false, anchors: [...left, ...right.slice(1)] };
  }
  return { closed: false, anchors: [...left, ...right] };
}

// ---- offset ------------------------------------------------------------------------

const ring = (pts: PointLite[]): Ring => {
  const r: Pair[] = pts.map((p) => [p.x, p.y] as Pair);
  const f = r[0], l = r[r.length - 1];
  if (f && l && f[0] === l[0] && f[1] === l[1]) r.pop();
  return r;
};

/**
 * Grows (`distance` > 0) or shrinks (< 0) the area the closed subpaths fill, with round corners. The
 * result is polygons (corner anchors), like any boolean result. Null when there is nothing to
 * offset or the result is empty (shrunk away).
 */
export function offsetSubpaths(subpaths: readonly SubPathLite[], distance: number): SubPathLite[] | null {
  if (distance === 0 || !Number.isFinite(distance)) return null;
  const closed = subpaths.filter(subpathFills);
  if (closed.length === 0) return null;
  const rings = closed.map((sp) => ring(flattenSubpath(sp, BEZIER_TOLERANCE))).filter((r) => r.length >= 3);
  if (rings.length === 0) return null;
  const region: MultiPolygon = polygonClipping.xor([rings[0]], ...rings.slice(1).map((r) => [r] as [Ring]));
  const pieces: MultiPolygon[] = [];
  const g = { cap: "round" as const, join: "round" as const, miter: 4 };
  for (const sp of closed) {
    pieces.push(...strokePolyline(flattenSubpath(sp, BEZIER_TOLERANCE), true, Math.abs(distance) * 2, g));
  }
  if (pieces.length === 0) return null;
  // polygon-clipping can lose a segment among near-coincident arc vertices: a coarse grid keeps them apart.
  const snapped = pieces.map((mp) => mp.map((poly) => poly.map((r) => r.map(([x, y]) => [Math.round(x * 1e3) / 1e3, Math.round(y * 1e3) / 1e3] as Pair))));
  const band: MultiPolygon = polygonClipping.union(snapped[0], ...snapped.slice(1));
  const result = distance > 0 ? polygonClipping.union(region, band) : polygonClipping.difference(region, band);
  const out = booleanRegion("union", [result]);
  return out.length > 0 ? out : null;
}

export { replaceSub };
