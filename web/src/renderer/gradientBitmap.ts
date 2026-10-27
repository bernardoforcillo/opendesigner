import type { GradientLite } from "@/store/types";

// ANGULAR and DIAMOND gradients, rasterized. The 2D canvas and CanvasKit have a native conic/sweep
// gradient, but a diamond (bands of constant |dx|+|dy|) has no native form anywhere, and an SVG file
// has neither. Whoever lacks the native form draws this bitmap stretched over the node's box, the same
// way a mesh paint is drawn (renderer/mesh.ts), so the three agree on the geometry written here.

export const GRADIENT_BITMAP_SIZE = 128;

type Rgba = { r: number; g: number; b: number; a: number };

/** The direction (radians, 0 = +x, growing clockwise on screen) the 0% of an angular gradient points to. */
export function angularStart(g: GradientLite, w: number, h: number): number {
  return Math.atan2((g.y2 - g.y1) * h, (g.x2 - g.x1) * w);
}

/** True when the gradient has a direction / extent to draw (a null axis falls back to the flat color). */
export function gradientDrawable(g: GradientLite, w: number, h: number): boolean {
  return g.stops.length >= 2 && Math.hypot((g.x2 - g.x1) * w, (g.y2 - g.y1) * h) > 0;
}

/**
 * The position (0..1 for angular, unclamped for a diamond) of the point (px, py) -- in WORLD units
 * relative to the node's top-left corner -- along an angular or diamond gradient on a w x h box.
 */
export function gradientPosition(g: GradientLite, px: number, py: number, w: number, h: number): number {
  const cx = g.x1 * w, cy = g.y1 * h;
  if (g.kind === "angular") {
    const a = Math.atan2(py - cy, px - cx) - angularStart(g, w, h);
    const t = (a / (2 * Math.PI)) % 1;
    return t < 0 ? t + 1 : t;
  }
  const len = Math.hypot((g.x2 - g.x1) * w, (g.y2 - g.y1) * h);
  return (Math.abs(px - cx) + Math.abs(py - cy)) / len;
}

/** The (non-premultiplied, like the canvas) color of the stops at `t`; the end colors extend. */
export function colorAtStops(stops: GradientLite["stops"], t: number): Rgba {
  const s = [...stops].sort((a, b) => a.position - b.position);
  if (t <= s[0].position) return s[0].color;
  const last = s[s.length - 1];
  if (t >= last.position) return last.color;
  for (let i = 0; i + 1 < s.length; i++) {
    const a = s[i], b = s[i + 1];
    if (t <= b.position) {
      const k = b.position > a.position ? (t - a.position) / (b.position - a.position) : 1;
      const mix = (x: number, y: number) => x + (y - x) * k;
      return { r: mix(a.color.r, b.color.r), g: mix(a.color.g, b.color.g), b: mix(a.color.b, b.color.b), a: mix(a.color.a, b.color.a) };
    }
  }
  return last.color;
}

/**
 * RGBA bytes (straight alpha) of an angular or diamond gradient over a w x h box at `size` x `size`,
 * plus `pad` pixels on every side repeating the nearest edge (so a texture stretched over a box does not
 * fade at its border). Pixel centers are sampled; the bitmap maps onto the box, whatever its aspect.
 */
export function gradientBitmap(g: GradientLite, w: number, h: number, size = GRADIENT_BITMAP_SIZE, pad = 0): Uint8ClampedArray {
  const total = size + pad * 2;
  const out = new Uint8ClampedArray(total * total * 4);
  const clamp = (x: number) => Math.min(size - 0.5, Math.max(0.5, x));
  for (let j = 0; j < total; j++) {
    const py = (clamp(j - pad + 0.5) / size) * h;
    for (let i = 0; i < total; i++) {
      const px = (clamp(i - pad + 0.5) / size) * w;
      const c = colorAtStops(g.stops, Math.min(1, Math.max(0, gradientPosition(g, px, py, w, h))));
      const o = (j * total + i) * 4;
      out[o] = c.r * 255; out[o + 1] = c.g * 255; out[o + 2] = c.b * 255; out[o + 3] = c.a * 255;
    }
  }
  return out;
}
