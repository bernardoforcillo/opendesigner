import type { BrushLite, BrushTipLite, NodeLite, StrokeLite } from "@/store/types";
import type { PathCmd } from "@/renderer/shapeGeometry";
import { BEZIER_TOLERANCE, localOutlines } from "@/vector/boolean";
import { dedupe } from "@/vector/widthProfile";

export { BRUSH_PRESETS, BRUSH_TIPS, brushPresetName, brushReach, hasBrush, hasBrushedStroke } from "@/vector/brushSpec";

// BRUSHES (docs/vector.md): a vector's stroke drawn as a row of tips stamped along the path instead of a
// line. Two kinds: STRETCH lays tiles of one tip end to end (each `spacing` weights long, one weight wide)
// and SCATTER stamps tips of one weight every `spacing` weights, strayed across the path, resized and turned
// by a seeded RNG, so the same document draws the same marks on every client and in the SVG export.
//
// The stamps are placed by ARC LENGTH on the flattened path. The result is plain filled geometry (M / C / L
// / Z commands in the node's local space): the canvas and the GPU renderer fill it, the SVG export writes
// it as a <path>. Every tip is wound the same way, so the fill is NON-ZERO: overlapping stamps merge
// instead of cancelling (chalk overlaps by design).

type Pt = { x: number; y: number };

/** At most this many stamps per subpath: a closer spacing is widened (a huge path with a tiny spacing). */
export const MAX_BRUSH_STAMPS = 5000;

/** One stamp: its centre, the turn of its tip (radians) and the scale of the unit tip along and across the path. */
export interface Stamp { x: number; y: number; angle: number; sx: number; sy: number }

/** mulberry32: a small seeded generator, the same sequence everywhere. Returns numbers in [0, 1). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The tips, in a unit box centred on the origin: x runs along the path, y across it, both within -0.5..0.5.
// All wound clockwise on a y-down screen (see the note on the fill rule above).
const K = 0.5523; // the cubic circle constant
const DASH_H = 0.25; // half the height of the dash: a bar twice as long as wide
const TIPS: Record<BrushTipLite, readonly PathCmd[]> = {
  dot: [
    ["M", 0.5, 0], ["C", 0.5, 0.5 * K, 0.5 * K, 0.5, 0, 0.5], ["C", -0.5 * K, 0.5, -0.5, 0.5 * K, -0.5, 0],
    ["C", -0.5, -0.5 * K, -0.5 * K, -0.5, 0, -0.5], ["C", 0.5 * K, -0.5, 0.5, -0.5 * K, 0.5, 0], ["Z"],
  ],
  dash: [
    ["M", -0.25, -DASH_H], ["L", 0.25, -DASH_H], ["C", 0.25 + DASH_H * K, -DASH_H, 0.5, -DASH_H * K, 0.5, 0],
    ["C", 0.5, DASH_H * K, 0.25 + DASH_H * K, DASH_H, 0.25, DASH_H], ["L", -0.25, DASH_H],
    ["C", -0.25 - DASH_H * K, DASH_H, -0.5, DASH_H * K, -0.5, 0], ["C", -0.5, -DASH_H * K, -0.25 - DASH_H * K, -DASH_H, -0.25, -DASH_H], ["Z"],
  ],
  square: [["M", -0.5, -0.5], ["L", 0.5, -0.5], ["L", 0.5, 0.5], ["L", -0.5, 0.5], ["Z"]],
  diamond: [["M", 0.5, 0], ["L", 0, 0.5], ["L", -0.5, 0], ["L", 0, -0.5], ["Z"]],
  leaf: [["M", -0.5, 0], ["C", -0.25, -0.4, 0.25, -0.4, 0.5, 0], ["C", 0.25, 0.4, -0.25, 0.4, -0.5, 0], ["Z"]],
};

/** The height of each tip's own box (a dash is half as tall as the others): a stretch tile is scaled to fill the weight. */
const TIP_HEIGHT: Record<BrushTipLite, number> = { dot: 1, dash: 2 * DASH_H, square: 1, diamond: 1, leaf: 0.6 };

/** The tip as commands, for tests and for previews. */
export function tipCommands(tip: BrushTipLite): readonly PathCmd[] {
  return TIPS[tip];
}

// The point and heading at distance d along a polyline (closed ones wrap). `i` is the segment to start from
// (d only increases), kept by the caller so a walk is linear.
function walker(pts: Pt[], closed: boolean) {
  const n = pts.length;
  const segs = closed ? n : n - 1;
  const cum = [0];
  for (let i = 0; i < segs; i++) cum.push(cum[i] + Math.hypot(pts[(i + 1) % n].x - pts[i].x, pts[(i + 1) % n].y - pts[i].y));
  const total = cum[segs] ?? 0;
  let i = 0;
  return {
    total,
    at(d: number): { x: number; y: number; angle: number } {
      while (i < segs - 1 && cum[i + 1] < d) i++;
      const a = pts[i], b = pts[(i + 1) % n];
      const l = cum[i + 1] - cum[i];
      const k = l > 0 ? Math.min(1, Math.max(0, (d - cum[i]) / l)) : 0;
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, angle: Math.atan2(b.y - a.y, b.x - a.x) };
    },
  };
}

/**
 * The stamps of ONE polyline for `brush` at `weight`. `salt` (the subpath's index) is mixed into the seed so
 * two subpaths of a node do not repeat each other's marks. Deterministic: the same inputs give the same stamps.
 */
export function brushStamps(raw: Pt[], closed: boolean, weight: number, brush: BrushLite, salt = 0): Stamp[] {
  const pts = dedupe(raw, closed);
  if (!(weight > 0) || pts.length === 0) return [];
  const rand = seededRandom((brush.seed + Math.imul(salt, 0x9e3779b1)) >>> 0);
  const w = walker(pts.length >= 2 ? pts : [pts[0], pts[0]], closed && pts.length >= 2);
  const total = w.total;
  const want = brush.spacing * weight;
  // Where the stamps go along the path, and the length of one tile (stretch).
  let centres: number[];
  let tile = want;
  if (brush.kind === "stretch") {
    if (!(total > 0)) return [];
    const count = Math.min(MAX_BRUSH_STAMPS, Math.max(1, Math.round(total / want)));
    tile = total / count; // the tiles fill the path exactly
    centres = Array.from({ length: count }, (_, i) => (i + 0.5) * tile);
  } else if (!(total > 0)) {
    centres = [0]; // a lone anchor: one mark
  } else if (closed) {
    const count = Math.min(MAX_BRUSH_STAMPS, Math.max(1, Math.round(total / want)));
    centres = Array.from({ length: count }, (_, i) => (i * total) / count);
  } else {
    const fit = Math.floor(total / want) + 1;
    const count = Math.min(MAX_BRUSH_STAMPS, fit);
    // The asked spacing when it fits (the last stamp then sits short of the end); only the cap widens it,
    // and then the stamps spread over the whole path.
    const step = count < fit ? total / (count - 1) : want;
    centres = Array.from({ length: count }, (_, i) => i * step);
  }
  const out: Stamp[] = [];
  const turn = (brush.angleJitter * Math.PI) / 180;
  for (const d of centres) {
    // Four draws per stamp in a fixed order, whatever the jitters are: changing one parameter never
    // reshuffles the others.
    const r1 = rand(), r2 = rand(), r3 = rand();
    rand(); // spare, so a later parameter can join without moving the existing marks
    const p = w.at(d);
    const scale = Math.max(0.05, 1 + brush.sizeJitter * (2 * r1 - 1) * 0.5);
    const angle = p.angle + turn * (2 * r2 - 1);
    const across = brush.scatter * weight * (r3 - 0.5);
    const x = p.x - Math.sin(p.angle) * across;
    const y = p.y + Math.cos(p.angle) * across;
    if (brush.kind === "stretch") out.push({ x, y, angle, sx: tile, sy: (weight * scale) / TIP_HEIGHT[brush.tip] });
    else out.push({ x, y, angle, sx: weight * scale, sy: weight * scale });
  }
  return out;
}

/** The tip of `stamp` as commands, moved to its place. */
function placed(tip: BrushTipLite, s: Stamp, out: PathCmd[]): void {
  const cos = Math.cos(s.angle), sin = Math.sin(s.angle);
  const px = (u: number, v: number): [number, number] => [s.x + u * s.sx * cos - v * s.sy * sin, s.y + u * s.sx * sin + v * s.sy * cos];
  for (const c of TIPS[tip]) {
    if (c[0] === "Z") out.push(["Z"]);
    else if (c[0] === "C") out.push(["C", ...px(c[1], c[2]), ...px(c[3], c[4]), ...px(c[5], c[6])]);
    else out.push([c[0], ...px(c[1], c[2])]);
  }
}

/** The fill commands of a node's brushed stroke `s`, in the node's LOCAL space (fill them NON-ZERO). [] if there is none. */
export function brushStrokeCommandsUncached(n: NodeLite, s: StrokeLite): PathCmd[] {
  const brush = s.brush;
  if (n.kind !== "vector" || !brush || !(s.weight > 0)) return [];
  const cmds: PathCmd[] = [];
  localOutlines(n, BEZIER_TOLERANCE).forEach((o, i) => {
    for (const st of brushStamps(o.points, o.closed, s.weight, brush, i)) placed(brush.tip, st, cmds);
  });
  return cmds;
}

// A node is drawn every frame and the stamps are many: keep them per stroke object, and per the vector they
// were made from (an edit replaces either).
const cache = new WeakMap<StrokeLite, { vector: unknown; meta: unknown; cmds: PathCmd[] }>();

/** The fill commands of a brushed stroke, cached; [] for a stroke that is not brushed. */
export function brushStrokeCommands(n: NodeLite, s: StrokeLite): PathCmd[] {
  const hit = cache.get(s);
  if (hit && hit.vector === n.vector && hit.meta === n.meta) return hit.cmds;
  const cmds = brushStrokeCommandsUncached(n, s);
  cache.set(s, { vector: n.vector, meta: n.meta, cmds });
  return cmds;
}
