// MOTORE DI ANIMAZIONE -- funzioni PURE (niente DOM, niente renderer) che
// campionano una clip del documento. Lo consumano il playback dell'editor e,
// in parità di formule, il generatore di codice (internal/codegen) e il
// validatore (web/src/animation/validate.ts, internal/core/animation.go).
//
// Il tempo è sempre in MILLISECONDI. Tre livelli:
//   clipTimeline(clip, elapsed) -> {t, done}   tempo reale -> tempo DENTRO la clip
//                                              (ritardo, ripetizioni, yoyo)
//   sampleClip(clip, t)         -> Map          valore di ogni (nodo, proprietà)
//   sampleTrack(track, t)       -> number       valore di una traccia
// con easingFn(spec) che dà la curva del singolo segmento.

import type { ClipLite, TrackLite } from "../store/types";

// Gli insiemi chiusi del modello: ripetuti in Go (core.TrackProps/ClipTriggers).
export const TRACK_PROPS = ["opacity", "x", "y", "scale", "rotation", "draw"] as const;
export type TrackProp = (typeof TRACK_PROPS)[number];
export const CLIP_TRIGGERS = ["enter", "hover", "tap", "loop", "manual"] as const;
export type ClipTrigger = (typeof CLIP_TRIGGERS)[number];

export type EasingFn = (p: number) => number;

// --- easing ----------------------------------------------------------------

// Stessa regex di core.cubicBezierRe (Go): numeri decimali stretti, niente
// inf/nan/esadecimali.
const NUM = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?`;
const CUBIC_RE = new RegExp(String.raw`^cubic-bezier\(\s*(${NUM})\s*,\s*(${NUM})\s*,\s*(${NUM})\s*,\s*(${NUM})\s*\)$`);

/** I quattro punti di controllo di "cubic-bezier(a,b,c,d)", o null se non valido
 *  (non finiti o ascisse fuori da [0,1], come in CSS). Parità con core.ParseCubicBezier. */
export function parseCubicBezier(spec: string): [number, number, number, number] | null {
  const m = CUBIC_RE.exec(spec);
  if (!m) return null;
  const p = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] as [number, number, number, number];
  if (p.some((v) => !Number.isFinite(v))) return null;
  if (p[0] < 0 || p[0] > 1 || p[2] < 0 || p[2] > 1) return null;
  return p;
}

/** Parità con core.ValidEasing. */
export function isValidEasing(spec: string): boolean {
  switch (spec) {
    case "": case "linear": case "easeIn": case "easeOut": case "easeInOut": case "spring": return true;
  }
  return parseCubicBezier(spec) !== null;
}

// Le curve con nome sono quelle di CSS (ease-in, ease-out, ease-in-out) così il
// codice esportato (CSS/Motion) coincide con il playback dell'editor.
export const NAMED_BEZIER: Record<string, [number, number, number, number]> = {
  easeIn: [0.42, 0, 1, 1],
  easeOut: [0, 0, 0.58, 1],
  easeInOut: [0.42, 0, 0.58, 1],
};

/**
 * Bézier cubica CSS: x(s) = 3(1-s)^2 s a + 3(1-s) s^2 c + s^3, y(s) analoga;
 * dato p = x si cerca s con Newton-Raphson (veloce) e, se la derivata è troppo
 * piatta o Newton non converge, con la bisezione (sempre sicura perché x(s) è
 * monotona con le ascisse in [0,1]).
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

// Molla SMORZATA CRITICAMENTE (nessun rimbalzo): x(t) = 1 - (1 + wt) e^(-wt).
// Non arriva mai esattamente a 1: w è scelto perché a p = 1 il residuo sia
// 0.1% e la curva si RISCALA su quel valore (SPRING_END) così parte da 0, arriva
// a 1 e resta monotona -- il "settle".
const SPRING_W = 9.2;
const springRaw = (p: number) => 1 - (1 + SPRING_W * p) * Math.exp(-SPRING_W * p);
const SPRING_END = springRaw(1);
export const springEasing: EasingFn = (p) => (p <= 0 ? 0 : p >= 1 ? 1 : springRaw(p) / SPRING_END);

/**
 * Bézier che approssima `spring` per i target che non hanno molle per segmento
 * (CSS, Motion con ease per segmento). Trovata per minimi quadrati sulla curva
 * vera (vedi engine.test.ts, che ne limita lo scarto).
 */
export const SPRING_BEZIER: [number, number, number, number] = [0.32, 0.66, 0.1, 1];

const LINEAR: EasingFn = (p) => (p <= 0 ? 0 : p >= 1 ? 1 : p);

/** La funzione di easing di una specifica (stringa già validata; una non valida
 *  ripiega su linear, come "" -- il motore non deve mai lanciare). */
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

// Cache delle funzioni: sampleClip gira a ogni frame e la regex/le closure non
// vanno rifatte. Chiave = la stringa dell'easing.
const easeCache = new Map<string, EasingFn>();
function cachedEasing(spec: string): EasingFn {
  let f = easeCache.get(spec);
  if (!f) { f = easingFn(spec); if (easeCache.size < 256) easeCache.set(spec, f); }
  return f;
}

/**
 * Valore di una traccia al tempo `tMs`: PRIMA del primo keyframe vale il primo,
 * DOPO l'ultimo vale l'ultimo (hold); in mezzo si interpola con l'easing del
 * keyframe che APRE il segmento. Keyframe con lo stesso tempo sono uno scatto: a
 * quel tempo vince l'ultimo. Una traccia senza keyframe (non valida) dà NaN.
 */
export function sampleTrack(track: Pick<TrackLite, "keyframes">, tMs: number): number {
  const k = track.keyframes;
  if (k.length === 0) return NaN;
  if (!(tMs > k[0].time)) return k[0].value;
  const last = k[k.length - 1];
  if (tMs >= last.time) return last.value;
  // ultimo keyframe con time <= tMs (ricerca binaria: le tracce sono ordinate)
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

/** Valori di tutte le tracce della clip al tempo `tMs` (dentro la clip): nodeId -> proprietà animate. */
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
 * Tempo reale -> tempo DENTRO la clip.
 *  - prima del `delay` la clip è ferma al tempo 0;
 *  - poi gira per `duration`, `repeat` volte in più (-1 = per sempre);
 *  - con `yoyo` i cicli dispari vanno al contrario;
 *  - `done` è true solo quando le ripetizioni finite sono esaurite: `t` resta
 *    sul punto d'arrivo (duration, o 0 se l'ultimo ciclo è un ritorno yoyo).
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
