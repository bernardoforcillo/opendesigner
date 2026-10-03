import { NAMED_BEZIER, SPRING_BEZIER, easingFn, parseCubicBezier } from "./engine";

// L'editor di CURVE: logica pura (niente DOM) dietro la mini-curva di easing.
// Una curva è sempre una Bézier cubica (x1, y1, x2, y2) con le ascisse in [0,1]
// come in CSS; le ordinate possono uscire (overshoot) ma qui si limitano a un
// intervallo leggibile.

export type Bezier = [number, number, number, number];

/** Ordinate ammesse per i punti di controllo nell'editor (oltre: curve inutilizzabili in pratica). */
export const Y_MIN = -1;
export const Y_MAX = 2;

/** I nomi con cui il menu offre gli easing (parità con core.ValidEasing). */
export const EASING_PRESETS: readonly { id: string; label: string }[] = [
  { id: "linear", label: "Lineare" },
  { id: "easeIn", label: "Ease in" },
  { id: "easeOut", label: "Ease out" },
  { id: "easeInOut", label: "Ease in-out" },
  { id: "spring", label: "Molla" },
];

/** Una specifica di easing come voce del menu ("" -> lineare, una cubic-bezier -> "custom"). */
export function presetIdOf(spec: string): string {
  if (spec === "") return "linear";
  if (EASING_PRESETS.some((p) => p.id === spec)) return spec;
  return parseCubicBezier(spec) ? "custom" : "linear";
}

/** I punti di controllo della curva di una specifica (le curve con nome sono Bézier CSS; la molla ha la sua approssimazione). */
export function easingToBezier(spec: string): Bezier {
  if (spec === "" || spec === "linear") return [0, 0, 1, 1];
  if (spec === "spring") return [...SPRING_BEZIER];
  const named = NAMED_BEZIER[spec];
  if (named) return [...named];
  return parseCubicBezier(spec) ?? [0, 0, 1, 1];
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Limita i punti di controllo: ascisse in [0,1], ordinate in [Y_MIN, Y_MAX], arrotondati a 3 decimali. */
export function clampBezier(b: Bezier): Bezier {
  const cx = (v: number) => r3(Math.min(1, Math.max(0, v)));
  const cy = (v: number) => r3(Math.min(Y_MAX, Math.max(Y_MIN, v)));
  return [cx(b[0]), cy(b[1]), cx(b[2]), cy(b[3])];
}

/** La specifica "cubic-bezier(a,b,c,d)" (valida per `SetClip`: decimali, niente notazione scientifica). */
export function formatBezier(b: Bezier): string {
  const c = clampBezier(b);
  return `cubic-bezier(${c.map((v) => String(v)).join(",")})`;
}

/** Un'area di disegno della curva: la mappa fra [0,1]×[Y_MIN,Y_MAX] e pixel (y verso il basso). */
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

/** Il tracciato SVG della curva (`d` di un <path>) campionato in `steps` segmenti. */
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
 * Sposta UN punto di controllo (0 = il primo, 1 = il secondo) al punto `(px, py)`
 * in pixel dell'area: parte dalla curva di `spec` (qualunque, anche con nome) e ne
 * dà la specifica nuova, sempre cubic-bezier valida.
 */
export function dragControl(spec: string, which: 0 | 1, box: CurveBox, px: number, py: number): string {
  const b = easingToBezier(spec);
  const p = fromPx(box, px, py);
  const next: Bezier = which === 0 ? [p.x, p.y, b[2], b[3]] : [b[0], b[1], p.x, p.y];
  return formatBezier(next);
}

/** Sposta un punto di controllo con la tastiera (frecce): `dx`/`dy` in unità della curva. */
export function nudgeControl(spec: string, which: 0 | 1, dx: number, dy: number): string {
  const b = easingToBezier(spec);
  const next: Bezier = which === 0 ? [b[0] + dx, b[1] + dy, b[2], b[3]] : [b[0], b[1], b[2] + dx, b[3] + dy];
  return formatBezier(next);
}
