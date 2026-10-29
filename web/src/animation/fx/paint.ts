// RECORDED STROKES (the Paint effect). A stroke is a brush size, a colour, an opacity and a polyline in fractions of the node's box. They
// live in one string parameter (fx/props.ts keeps it in a track name, so it is capped at MAX_FX_TEXT_BYTES) in a compact text form:
//   <size>.<rrggbb>.<opacity>:<points>;<next stroke>
// size is thousandths of the node's shorter side, opacity is a percent, and each coordinate is two base-36 digits over -0.25..1.25. A
// stroke is simplified when it is recorded so a few seconds of drawing fit. PURE: the renderer and the drawing pad share it.

import { MAX_FX_TEXT_BYTES } from "@/animation/fx/props";

export interface Pt { x: number; y: number }
export interface Stroke { size: number; color: string; opacity: number; points: Pt[] }

const LO = -0.25, SPAN = 1.5, STEPS = 1295;
const enc = (v: number) => Math.round((Math.max(LO, Math.min(LO + SPAN, v)) - LO) / SPAN * STEPS).toString(36).padStart(2, "0");
const dec = (s: string) => parseInt(s, 36) / STEPS * SPAN + LO;

export function encodeStrokes(strokes: readonly Stroke[]): string {
  return strokes
    .filter((s) => s.points.length > 0)
    .map((s) => `${Math.round(s.size * 1000)}.${s.color.replace("#", "").toLowerCase().padStart(6, "0").slice(0, 6)}.${Math.round(s.opacity * 100)}:${s.points.map((p) => enc(p.x) + enc(p.y)).join("")}`)
    .join(";");
}

export function parseStrokes(text: string): Stroke[] {
  const out: Stroke[] = [];
  for (const part of text.split(";")) {
    const m = /^(\d{1,4})\.([0-9a-f]{6})\.(\d{1,3}):([0-9a-z]*)$/.exec(part);
    if (!m || m[4].length % 4 !== 0) continue;
    const points: Pt[] = [];
    for (let i = 0; i < m[4].length; i += 4) points.push({ x: dec(m[4].slice(i, i + 2)), y: dec(m[4].slice(i + 2, i + 4)) });
    if (points.length === 0 || points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) continue;
    out.push({ size: Number(m[1]) / 1000, color: `#${m[2]}`, opacity: Math.min(1, Number(m[3]) / 100), points });
  }
  return out;
}

/** Whether `strokes` still fit the parameter. */
export const strokesFit = (strokes: readonly Stroke[]): boolean => encodeStrokes(strokes).length <= MAX_FX_TEXT_BYTES;

/** Ramer-Douglas-Peucker: the polyline with the points that move it by less than `eps` taken out. */
export function simplify(points: readonly Pt[], eps = 0.004): Pt[] {
  if (points.length < 3) return points.slice();
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [a, b] = stack.pop() as [number, number];
    let far = -1, worst = eps;
    const dx = points[b].x - points[a].x, dy = points[b].y - points[a].y, len = Math.hypot(dx, dy);
    for (let i = a + 1; i < b; i++) {
      const d = len === 0 ? Math.hypot(points[i].x - points[a].x, points[i].y - points[a].y) : Math.abs(dy * (points[i].x - points[a].x) - dx * (points[i].y - points[a].y)) / len;
      if (d > worst) { worst = d; far = i; }
    }
    if (far >= 0) { keep[far] = true; stack.push([a, far], [far, b]); }
  }
  return points.filter((_, i) => keep[i]);
}

const lengthOf = (pts: readonly Pt[]) => pts.slice(1).reduce((n, p, i) => n + Math.hypot(p.x - pts[i].x, p.y - pts[i].y), 0);

/** The strokes drawn so far when `fraction` (0..1) of all their length has been written, in the order they were recorded. */
export function writeOn(strokes: readonly Stroke[], fraction: number): Stroke[] {
  if (fraction >= 1) return strokes.slice();
  // a dot has no length: it counts as a small fixed amount so it still takes a moment to appear
  const lens = strokes.map((s) => Math.max(lengthOf(s.points), 0.01));
  let left = Math.max(0, fraction) * lens.reduce((a, b) => a + b, 0);
  const out: Stroke[] = [];
  for (let k = 0; k < strokes.length && left > 0; k++) {
    const s = strokes[k];
    if (left >= lens[k]) { out.push(s); left -= lens[k]; continue; }
    const pts: Pt[] = [s.points[0]];
    let run = left;
    for (let i = 1; i < s.points.length; i++) {
      const seg = Math.hypot(s.points[i].x - s.points[i - 1].x, s.points[i].y - s.points[i - 1].y);
      if (seg >= run) {
        const t = seg === 0 ? 0 : run / seg;
        pts.push({ x: s.points[i - 1].x + (s.points[i].x - s.points[i - 1].x) * t, y: s.points[i - 1].y + (s.points[i].y - s.points[i - 1].y) * t });
        break;
      }
      pts.push(s.points[i]);
      run -= seg;
    }
    out.push({ ...s, points: pts });
    left = 0;
  }
  return out;
}
