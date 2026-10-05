// ANIMATION ENGINE -- PURE functions (no DOM, no renderer) that
// sample a document clip. They are consumed by the editor's playback and,
// with the same formulas, by the code generator (internal/codegen) and the
// validator (web/src/animation/validate.ts, internal/core/animation.go).
//
// Time is always in MILLISECONDS. Three levels:
//   clipTimeline(clip, elapsed) -> {t, done}   real time -> time INSIDE the clip
//                                              (delay, repeats, yoyo)
//   sampleClip(clip, t)         -> Map          value of every (node, property)
//   sampleTrack(track, t)       -> number       value of a track
// with easingFn(spec) giving the curve of a single segment.

import type { ClipLite, TrackLite } from "../store/types";

// The closed sets of the model: repeated in Go (core.TrackProps/ClipTriggers).
export const TRACK_PROPS = ["opacity", "x", "y", "scale", "rotation", "draw"] as const;
export type TrackProp = (typeof TRACK_PROPS)[number];
export const CLIP_TRIGGERS = ["enter", "hover", "tap", "loop", "manual"] as const;
export type ClipTrigger = (typeof CLIP_TRIGGERS)[number];

export type EasingFn = (p: number) => number;

// --- easing ----------------------------------------------------------------

// Same regex as core.cubicBezierRe (Go): strict decimal numbers, no
// inf/nan/hexadecimal.
const NUM = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?`;
const CUBIC_RE = new RegExp(String.raw`^cubic-bezier\(\s*(${NUM})\s*,\s*(${NUM})\s*,\s*(${NUM})\s*,\s*(${NUM})\s*\)$`);

/** The four control points of "cubic-bezier(a,b,c,d)", or null if invalid
 *  (non-finite or x values outside [0,1], as in CSS). Parity with core.ParseCubicBezier. */
export function parseCubicBezier(spec: string): [number, number, number, number] | null {
  const m = CUBIC_RE.exec(spec);
  if (!m) return null;
  const p = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] as [number, number, number, number];
  if (p.some((v) => !Number.isFinite(v))) return null;
  if (p[0] < 0 || p[0] > 1 || p[2] < 0 || p[2] > 1) return null;
  return p;
}

/** Parity with core.ValidEasing. */
export function isValidEasing(spec: string): boolean {
  switch (spec) {
    case "": case "linear": case "easeIn": case "easeOut": case "easeInOut": case "spring": return true;
  }
  return parseCubicBezier(spec) !== null;
}

// The named curves are those of CSS (ease-in, ease-out, ease-in-out) so the
// exported code (CSS/Motion) matches the editor's playback.
export const NAMED_BEZIER: Record<string, [number, number, number, number]> = {
  easeIn: [0.42, 0, 1, 1],
  easeOut: [0, 0, 0.58, 1],
  easeInOut: [0.42, 0, 0.58, 1],
};

/**
 * CSS cubic Bézier: x(s) = 3(1-s)^2 s a + 3(1-s) s^2 c + s^3, y(s) analogous;
 * given p = x we look for s with Newton-Raphson (fast) and, if the derivative is too
 * flat or Newton does not converge, with bisection (always safe because x(s) is
 * monotonic with x values in [0,1]).
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): EasingFn {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const X = (s: number) => ((ax * s + bx) * s + cx) * s;
  const Y = (s: number) => ((ay * s + by) * s + cy) * s;
  const dX = (s: number) => (3 * ax * s + 2 * bx) * s + cx;
  return (p) => {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    let s = p;
    for (let i = 0; i < 8; i++) {
      const err = X(s) - p;
      if (Math.abs(err) < 1e-7) return Y(s);
      const d = dX(s);
      if (Math.abs(d) < 1e-6) break;
      s -= err / d;
    }
    let lo = 0, hi = 1;
    s = p;
    for (let i = 0; i < 60; i++) {
      const x = X(s);
      if (Math.abs(x - p) < 1e-7) break;
      if (x < p) lo = s; else hi = s;
      s = (lo + hi) / 2;
    }
    return Y(s);
  };
}

// CRITICALLY DAMPED spring (no bounce): x(t) = 1 - (1 + wt) e^(-wt).
// It never reaches exactly 1: w is chosen so that at p = 1 the residual is
// 0.1% and the curve is RESCALED on that value (SPRING_END) so it starts at 0, reaches
// 1 and stays monotonic -- the "settle".
const SPRING_W = 9.2;
const springRaw = (p: number) => 1 - (1 + SPRING_W * p) * Math.exp(-SPRING_W * p);
const SPRING_END = springRaw(1);
export const springEasing: EasingFn = (p) => (p <= 0 ? 0 : p >= 1 ? 1 : springRaw(p) / SPRING_END);

/**
 * A Bézier approximating `spring` for targets that have no per-segment springs
 * (CSS, Motion with per-segment ease). Found by least squares on the true
 * curve (see engine.test.ts, which bounds its error).
 */
export const SPRING_BEZIER: [number, number, number, number] = [0.32, 0.66, 0.1, 1];

const LINEAR: EasingFn = (p) => (p <= 0 ? 0 : p >= 1 ? 1 : p);

/** The easing function of a spec (an already validated string; an invalid one
 *  falls back to linear, like "" -- the engine must never throw). */
export function easingFn(spec: string): EasingFn {
  switch (spec) {
    case "": case "linear": return LINEAR;
    case "spring": return springEasing;
  }
  const named = NAMED_BEZIER[spec];
  if (named) return cubicBezier(...named);
  const p = parseCubicBezier(spec);
  return p ? cubicBezier(...p) : LINEAR;
}

// --- campionamento ---------------------------------------------------------

// Function cache: sampleClip runs on every frame and the regex/closures must
// not be rebuilt. Key = the easing string.
const easeCache = new Map<string, EasingFn>();
function cachedEasing(spec: string): EasingFn {
  let f = easeCache.get(spec);
  if (!f) { f = easingFn(spec); if (easeCache.size < 256) easeCache.set(spec, f); }
  return f;
}

/**
 * Value of a track at time `tMs`: BEFORE the first keyframe it is the first,
 * AFTER the last it is the last (hold); in between it interpolates with the easing of the
 * keyframe that OPENS the segment. Keyframes with the same time are a step: at
 * that time the last one wins. A track without keyframes (invalid) gives NaN.
 */
export function sampleTrack(track: Pick<TrackLite, "keyframes">, tMs: number): number {
  const k = track.keyframes;
  if (k.length === 0) return NaN;
  if (!(tMs > k[0].time)) return k[0].value;
  const last = k[k.length - 1];
  if (tMs >= last.time) return last.value;
  // last keyframe with time <= tMs (binary search: tracks are sorted)
  let lo = 0, hi = k.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (k[mid].time <= tMs) lo = mid; else hi = mid - 1;
  }
  const a = k[lo], b = k[lo + 1];
  const span = b.time - a.time;
  if (span <= 0) return b.value;
  return a.value + (b.value - a.value) * cachedEasing(a.easing)((tMs - a.time) / span);
}

export interface NodeAnim { opacity?: number; x?: number; y?: number; scale?: number; rotation?: number; draw?: number }

/** Values of all the clip's tracks at time `tMs` (inside the clip): nodeId -> animated properties. */
export function sampleClip(clip: Pick<ClipLite, "tracks">, tMs: number): Map<string, NodeAnim> {
  const out = new Map<string, NodeAnim>();
  for (const tr of clip.tracks) {
    const v = sampleTrack(tr, tMs);
    if (Number.isNaN(v)) continue;
    let a = out.get(tr.nodeId);
    if (!a) { a = {}; out.set(tr.nodeId, a); }
    a[tr.prop as TrackProp] = v;
  }
  return out;
}

/**
 * Real time -> time INSIDE the clip.
 *  - before the `delay` the clip is still at time 0;
 *  - then it runs for `duration`, `repeat` more times (-1 = forever);
 *  - with `yoyo` odd cycles go backwards;
 *  - `done` is true only when the finite repeats are exhausted: `t` stays
 *    at the end point (duration, or 0 if the last cycle is a yoyo return).
 */
export function clipTimeline(
  clip: Pick<ClipLite, "duration" | "delay" | "repeat" | "yoyo">, elapsedMs: number,
): { t: number; done: boolean } {
  const { duration, delay, repeat, yoyo } = clip;
  if (!(duration > 0) || !(elapsedMs > delay)) return { t: 0, done: false };
  const local = elapsedMs - delay;
  const cycles = repeat < 0 ? Infinity : repeat + 1;
  if (local >= duration * cycles) {
    const lastReverse = yoyo && (cycles - 1) % 2 === 1;
    return { t: lastReverse ? 0 : duration, done: true };
  }
  const idx = Math.floor(local / duration);
  const phase = local - idx * duration;
  return { t: yoyo && idx % 2 === 1 ? duration - phase : phase, done: false };
}
