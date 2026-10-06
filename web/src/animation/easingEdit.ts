import { NAMED_BEZIER, SPRING_BEZIER, easingFn, parseCubicBezier } from "./engine";

// The CURVE editor: pure logic (no DOM) behind the mini easing curve.
// A curve is always a cubic Bézier (x1, y1, x2, y2) with x values in [0,1]
// as in CSS; the y values may go out (overshoot) but here they are limited to a
// readable range.

export type Bezier = [number, number, number, number];

/** Allowed y values for the control points in the editor (beyond: curves unusable in practice). */
export const Y_MIN = -1;
export const Y_MAX = 2;

/** The names the menu offers the easings under (parity with core.ValidEasing). */
export const EASING_PRESETS: readonly { id: string; label: string }[] = [
  { id: "linear", label: "Linear" },
  { id: "easeIn", label: "Ease in" },
  { id: "easeOut", label: "Ease out" },
  { id: "easeInOut", label: "Ease in-out" },
  { id: "spring", label: "Spring" },
];

/** An easing spec as a menu entry ("" -> linear, a cubic-bezier -> "custom"). */
export function presetIdOf(spec: string): string {
  if (spec === "") return "linear";
  if (EASING_PRESETS.some((p) => p.id === spec)) return spec;
  return parseCubicBezier(spec) ? "custom" : "linear";
}

/** The control points of a spec's curve (named curves are CSS Béziers; the spring has its own approximation). */
export function easingToBezier(spec: string): Bezier {
  if (spec === "" || spec === "linear") return [0, 0, 1, 1];
  if (spec === "spring") return [...SPRING_BEZIER];
  const named = NAMED_BEZIER[spec];
  if (named) return [...named];
  return parseCubicBezier(spec) ?? [0, 0, 1, 1];
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Clamps the control points: x values in [0,1], y values in [Y_MIN, Y_MAX], rounded to 3 decimals. */
export function clampBezier(b: Bezier): Bezier {
  const cx = (v: number) => r3(Math.min(1, Math.max(0, v)));
  const cy = (v: number) => r3(Math.min(Y_MAX, Math.max(Y_MIN, v)));
  return [cx(b[0]), cy(b[1]), cx(b[2]), cy(b[3])];
}

/** The "cubic-bezier(a,b,c,d)" spec (valid for `SetClip`: decimals, no scientific notation). */
export function formatBezier(b: Bezier): string {
  const c = clampBezier(b);
  return `cubic-bezier(${c.map((v) => String(v)).join(",")})`;
}

/** A curve drawing area: the map between [0,1]×[Y_MIN,Y_MAX] and pixels (y downwards). */
export interface CurveBox { width: number; height: number; pad: number }

export function toPx(box: CurveBox, x: number, y: number): { x: number; y: number } {
  const w = box.width - 2 * box.pad;
  const h = box.height - 2 * box.pad;
  return { x: box.pad + x * w, y: box.pad + (1 - (y - Y_MIN) / (Y_MAX - Y_MIN)) * h };
}

export function fromPx(box: CurveBox, px: number, py: number): { x: number; y: number } {
  const w = box.width - 2 * box.pad;
  const h = box.height - 2 * box.pad;
  return { x: (px - box.pad) / w, y: Y_MIN + (1 - (py - box.pad) / h) * (Y_MAX - Y_MIN) };
}

/** The SVG path of the curve (`d` of a <path>) sampled in `steps` segments. */
export function curvePath(spec: string, box: CurveBox, steps = 48): string {
  const f = easingFn(spec);
  let d = "";
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const p = toPx(box, t, f(t));
    d += `${i === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
  }
  return d;
}

/**
 * Moves ONE control point (0 = the first, 1 = the second) to the point `(px, py)`
 * in area pixels: starts from the curve of `spec` (any, even named) and
 * gives the new spec, always a valid cubic-bezier.
 */
export function dragControl(spec: string, which: 0 | 1, box: CurveBox, px: number, py: number): string {
  const b = easingToBezier(spec);
  const p = fromPx(box, px, py);
  const next: Bezier = which === 0 ? [p.x, p.y, b[2], b[3]] : [b[0], b[1], p.x, p.y];
  return formatBezier(next);
}

/** Moves a control point with the keyboard (arrows): `dx`/`dy` in curve units. */
export function nudgeControl(spec: string, which: 0 | 1, dx: number, dy: number): string {
  const b = easingToBezier(spec);
  const next: Bezier = which === 0 ? [b[0] + dx, b[1] + dy, b[2], b[3]] : [b[0], b[1], b[2] + dx, b[3] + dy];
  return formatBezier(next);
}
