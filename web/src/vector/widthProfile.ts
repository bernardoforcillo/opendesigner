import polygonClipping from "polygon-clipping";
import type { MultiPolygon, Pair, Ring } from "polygon-clipping";
import type { NodeLite, StrokeLite, WidthPointLite } from "../store/types";
import { vectorStyleOf } from "../renderer/vectorStyle";
import type { PathCmd } from "../renderer/shapeGeometry";
export { isValidWidthProfile, MAX_WIDTH_POINTS, MAX_WIDTH_SCALE } from "../store/shapes";
import { BEZIER_TOLERANCE, localOutlines } from "./boolean";

// VARIABLE-WIDTH STROKES (docs/vector.md): a stroke whose width changes along the path. The profile is a
// list of points {position 0..1, left, right} per subpath; `left` / `right` are the half-widths on each
// side of the direction of travel as MULTIPLES of half the weight, so the weight still scales the whole
// stroke. Between points the widths are linear; before the first and after the last they stay.
//
// The stroke is the union of one trapezoid per segment plus a wedge per outer join (and the caps), the
// same construction as vector/outlineStroke.ts but with a width per vertex. The result is a filled
// region: the canvas, the GPU renderer and the SVG export FILL it with the stroke's paint instead of
// stroking, and Outline stroke turns it into a vector.

type Pt = { x: number; y: number };

/** The presets of the Variable width panel; the same names and numbers as internal/mcp/widthprofile.go. */
export const WIDTH_PRESETS: Readonly<Record<string, readonly WidthPointLite[]>> = {
  uniform: [],
  taper: [{ position: 0, left: 1, right: 1 }, { position: 1, left: 0, right: 0 }],
  "taper-start": [{ position: 0, left: 0, right: 0 }, { position: 1, left: 1, right: 1 }],
  lens: [{ position: 0, left: 0, right: 0 }, { position: 0.5, left: 1, right: 1 }, { position: 1, left: 0, right: 0 }],
  bulge: [{ position: 0, left: 0.4, right: 0.4 }, { position: 0.5, left: 1.6, right: 1.6 }, { position: 1, left: 0.4, right: 0.4 }],
  pinch: [{ position: 0, left: 1, right: 1 }, { position: 0.5, left: 0.3, right: 0.3 }, { position: 1, left: 1, right: 1 }],
  brush: [
    { position: 0, left: 0.1, right: 0.1 }, { position: 0.15, left: 1.2, right: 1.2 },
    { position: 0.7, left: 0.8, right: 0.8 }, { position: 1, left: 0, right: 0 },
  ],
};

/** The name of the preset a profile equals, or "custom" (uniform for an empty one). */
export function presetNameOf(profile: readonly WidthPointLite[] | undefined): string {
  const p = profile ?? [];
  for (const [name, pts] of Object.entries(WIDTH_PRESETS)) {
    if (pts.length === p.length && pts.every((q, i) => q.position === p[i].position && q.left === p[i].left && q.right === p[i].right)) return name;
  }
  return "custom";
}

/** The left / right multiples at `t` (0..1): linear between points, held before the first and after the last. */
export function widthAt(profile: readonly WidthPointLite[], t: number): { left: number; right: number } {
  if (profile.length === 0) return { left: 1, right: 1 };
  if (t <= profile[0].position) return { left: profile[0].left, right: profile[0].right };
  const last = profile[profile.length - 1];
  if (t >= last.position) return { left: last.left, right: last.right };
  for (let i = 1; i < profile.length; i++) {
    const a = profile[i - 1], b = profile[i];
    if (t <= b.position) {
      const k = b.position === a.position ? 1 : (t - a.position) / (b.position - a.position);
      return { left: a.left + (b.left - a.left) * k, right: a.right + (b.right - a.right) * k };
    }
  }
  return { left: last.left, right: last.right };
}

/** True if the node strokes with a variable width (vectors only). */
export function hasVariableWidth(n: Pick<NodeLite, "kind" | "strokes">): boolean {
  return n.kind === "vector" && n.strokes.some((s) => s.weight > 0 && !!s.widthProfile && s.widthProfile.length > 0);
}

/** How far the profile reaches from the path, in multiples of half the weight (for the bounds overhang). */
export function maxReach(profile: readonly WidthPointLite[]): number {
  return profile.reduce((m, p) => Math.max(m, p.left, p.right), 0);
}

export interface WidthGeometry { cap: "butt" | "round" | "square"; join: "miter" | "round" | "bevel" }

const ARC_STEPS = 12;
const ringOf = (pts: Pt[]): Ring => pts.map((p) => [p.x, p.y] as Pair);
const poly = (pts: Pt[]): MultiPolygon => [[ringOf(pts)]];

function dedupe(pts: Pt[], closed: boolean): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const l = out[out.length - 1];
    if (!l || Math.hypot(p.x - l.x, p.y - l.y) > 1e-9) out.push(p);
  }
  if (closed && out.length > 1) {
    const f = out[0], l = out[out.length - 1];
    if (Math.hypot(f.x - l.x, f.y - l.y) <= 1e-9) out.pop();
  }
  return out;
}

// A fan of points on the circle of radius r around c from angle a0 sweeping `sweep` radians.
function arc(c: Pt, r: number, a0: number, sweep: number): Pt[] {
  const steps = Math.max(2, Math.ceil((Math.abs(sweep) / Math.PI) * ARC_STEPS));
  return Array.from({ length: steps + 1 }, (_, i) => ({ x: c.x + r * Math.cos(a0 + (sweep * i) / steps), y: c.y + r * Math.sin(a0 + (sweep * i) / steps) }));
}

// The widths are sampled at the polyline's vertices, so a segment that a profile point falls inside is split
// there: the profile's corners are then exact however few anchors the path has.
function splitAtProfile(pts: Pt[], closed: boolean, profile: readonly WidthPointLite[]): Pt[] {
  const n = pts.length;
  const segs = closed ? n : n - 1;
  const len = (i: number) => Math.hypot(pts[(i + 1) % n].x - pts[i].x, pts[(i + 1) % n].y - pts[i].y);
  let total = 0;
  for (let i = 0; i < segs; i++) total += len(i);
  const out: Pt[] = [];
  let at = 0;
  for (let i = 0; i < segs; i++) {
    const a = pts[i], b = pts[(i + 1) % n], l = len(i);
    out.push(a);
    const cuts = [...new Set(profile.map((p) => p.position))]
      .filter((t) => t * total > at + 1e-9 && t * total < at + l - 1e-9).sort((x, y) => x - y);
    for (const t of cuts) {
      const k = (t * total - at) / l;
      out.push({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k });
    }
    at += l;
  }
  if (!closed) out.push(pts[n - 1]);
  return out;
}

/** The solid region of a variable-width stroke along ONE polyline (a list of pieces to union). */
export function variableStrokePolyline(raw: Pt[], closed: boolean, weight: number, profile: readonly WidthPointLite[], g: WidthGeometry): MultiPolygon[] {
  const base = dedupe(raw, closed);
  const out: MultiPolygon[] = [];
  if (base.length < 2 || !(weight > 0)) return out;
  const pts = splitAtProfile(base, closed, profile);
  const n = pts.length;
  const segs = closed ? n : n - 1;
  const half = weight / 2;
  // Cumulative length at each vertex (the closing segment included for closed paths).
  const cum = [0];
  for (let i = 0; i < segs; i++) cum.push(cum[i] + Math.hypot(pts[(i + 1) % n].x - pts[i].x, pts[(i + 1) % n].y - pts[i].y));
  const total = cum[segs];
  const wAt = (i: number) => {
    const w = widthAt(profile, cum[i] / total);
    return { l: w.left * half, r: w.right * half };
  };
  const dir = (i: number): Pt => {
    const a = pts[i], b = pts[(i + 1) % n];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    return { x: (b.x - a.x) / d, y: (b.y - a.y) / d };
  };
  // The left normal of travel (on a y-down screen: heading east, left is north).
  const left = (d: Pt): Pt => ({ x: d.y, y: -d.x });
  for (let i = 0; i < segs; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const wa = wAt(i), wb = wAt(i + 1);
    if (wa.l + wa.r + wb.l + wb.r <= 0) continue;
    const nl = left(dir(i));
    out.push(poly([
      { x: a.x + nl.x * wa.l, y: a.y + nl.y * wa.l }, { x: b.x + nl.x * wb.l, y: b.y + nl.y * wb.l },
      { x: b.x - nl.x * wb.r, y: b.y - nl.y * wb.r }, { x: a.x - nl.x * wa.r, y: a.y - nl.y * wa.r },
    ]));
  }
  // The wedge on the outer side of a turn, so a corner has no gap.
  const joinAt = (i: number, d0: Pt, d1: Pt) => {
    const cross = d0.x * d1.y - d0.y * d1.x;
    if (Math.abs(cross) < 1e-9) return;
    const w = wAt(i);
    // cross > 0 turns toward +normal side (right of travel): the outer side is the left one, and vice versa.
    const outerLeft = cross > 0;
    const h = outerLeft ? w.l : w.r;
    if (!(h > 0)) return;
    const s = outerLeft ? 1 : -1;
    const n0 = left(d0), n1 = left(d1);
    const v = pts[i];
    const A = { x: v.x + s * n0.x * h, y: v.y + s * n0.y * h };
    const B = { x: v.x + s * n1.x * h, y: v.y + s * n1.y * h };
    if (g.join === "round") {
      const a0 = Math.atan2(A.y - v.y, A.x - v.x);
      let sweep = Math.atan2(B.y - v.y, B.x - v.x) - a0;
      while (sweep > Math.PI) sweep -= 2 * Math.PI;
      while (sweep < -Math.PI) sweep += 2 * Math.PI;
      out.push(poly([v, ...arc(v, h, a0, sweep)]));
    } else {
      out.push(poly([v, A, B]));
    }
  };
  if (closed) for (let i = 0; i < n; i++) joinAt(i, dir((i + n - 1) % n), dir(i));
  else for (let i = 1; i < n - 1; i++) joinAt(i, dir(i - 1), dir(i));
  // Caps of an open polyline. The end's cross-section runs from -r to +l along the left normal.
  if (!closed && g.cap !== "butt") {
    const cap = (i: number, d: Pt) => {
      const w = wAt(i);
      const nl = left(d);
      const v = pts[i];
      if (w.l + w.r <= 0) return;
      if (g.cap === "round") {
        const c = { x: v.x + (nl.x * (w.l - w.r)) / 2, y: v.y + (nl.y * (w.l - w.r)) / 2 };
        const a0 = Math.atan2(nl.y, nl.x);
        // Half a turn from the left corner, through the direction of travel (the left normal turned a
        // quarter back), to the right corner.
        out.push(poly(arc(c, (w.l + w.r) / 2, a0, Math.PI)));
      } else {
        const ext = (w.l + w.r) / 2;
        out.push(poly([
          { x: v.x + nl.x * w.l, y: v.y + nl.y * w.l }, { x: v.x + nl.x * w.l + d.x * ext, y: v.y + nl.y * w.l + d.y * ext },
          { x: v.x - nl.x * w.r + d.x * ext, y: v.y - nl.y * w.r + d.y * ext }, { x: v.x - nl.x * w.r, y: v.y - nl.y * w.r },
        ]));
      }
    };
    const d0 = dir(0), dN = dir(segs - 1);
    cap(0, { x: -d0.x, y: -d0.y });
    cap(n - 1, dN);
  }
  return out;
}

/** The filled region of a node's variable-width stroke `s`, in the node's LOCAL space. Empty if there is none. */
export function variableStrokeRegion(n: NodeLite, s: StrokeLite): MultiPolygon {
  const profile = s.widthProfile;
  if (n.kind !== "vector" || !profile || profile.length === 0 || !(s.weight > 0)) return [];
  const vs = vectorStyleOf(n);
  const g: WidthGeometry = { cap: vs.cap, join: vs.join };
  const pieces: MultiPolygon[] = [];
  for (const o of localOutlines(n, BEZIER_TOLERANCE)) pieces.push(...variableStrokePolyline(o.points, o.closed, s.weight, profile, g));
  if (pieces.length === 0) return [];
  return polygonClipping.union(pieces[0], ...pieces.slice(1));
}

/** A region as closed M / L / Z commands (fill it even-odd: holes are rings of their own). */
export function regionToCommands(region: MultiPolygon): PathCmd[] {
  const cmds: PathCmd[] = [];
  for (const polygon of region) {
    for (const ring of polygon) {
      const pts = ring.slice(0, ring.length - 1);
      if (pts.length < 3) continue;
      pts.forEach(([x, y], i) => cmds.push([i === 0 ? "M" : "L", x, y]));
      cmds.push(["Z"]);
    }
  }
  return cmds;
}

// The region is expensive (a polygon union) and a node is drawn every frame: keep it per stroke object, and
// per the vector it was made from (an edit replaces either).
const cache = new WeakMap<StrokeLite, { vector: unknown; meta: unknown; cmds: PathCmd[] }>();

/** The fill commands of a variable-width stroke, cached; [] for a stroke that is not variable. */
export function variableStrokeCommands(n: NodeLite, s: StrokeLite): PathCmd[] {
  const hit = cache.get(s);
  if (hit && hit.vector === n.vector && hit.meta === n.meta) return hit.cmds;
  const cmds = regionToCommands(variableStrokeRegion(n, s));
  cache.set(s, { vector: n.vector, meta: n.meta, cmds });
  return cmds;
}
