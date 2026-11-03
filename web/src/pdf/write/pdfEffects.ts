// BLUR AND INNER SHADOWS FOR THE PDF. A PDF has no blur, so these effects become a small RGBA bitmap
// (a soft mask carries the alpha) placed under or over the shape: the shape's coverage is rendered on a
// grid, blurred with three box passes (close to a Gaussian), and tinted. Only shapes with a closed-form
// outline (rectangle with radius, ellipse) are handled; vectors keep the old hard-edged stand-in.

export interface FxShape { kind: "rect" | "ellipse"; w: number; h: number; r: number }
export interface Rgba { r: number; g: number; b: number; a: number }
/** A bitmap and the box, relative to the shape's top-left, it covers (document units). */
export interface FxBitmap { width: number; height: number; rgba: Uint8ClampedArray; x: number; y: number; w: number; h: number }

export interface FxSpec {
  /** `drop`: the shape's silhouette, offset and blurred, in the colour. `inner`: what is NOT covered by the offset silhouette. `blur`: the shape itself, blurred. */
  mode: "drop" | "inner" | "blur";
  color: Rgba;
  dx?: number;
  dy?: number;
  /** Standard deviation in document units. */
  sigma: number;
}

const MAX_SIDE = 384;

/** Anti-aliased coverage of the shape at point (px, py), relative to the shape's centre; `s` = pixels per unit. */
function coverageAt(shape: FxShape, px: number, py: number, s: number): number {
  const hw = shape.w / 2, hh = shape.h / 2;
  let d: number;
  if (shape.kind === "ellipse") {
    const nx = px / hw, ny = py / hh;
    const len = Math.hypot(nx, ny);
    if (len === 0) return 1;
    const gx = px / (hw * hw), gy = py / (hh * hh);
    const g = Math.hypot(gx, gy) / len;
    d = g > 0 ? (len - 1) / g : 0;
  } else {
    const r = Math.min(shape.r, hw, hh);
    const qx = Math.abs(px) - (hw - r), qy = Math.abs(py) - (hh - r);
    d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  }
  return Math.min(1, Math.max(0, 0.5 - d * s));
}

function boxBlur(src: Float32Array, w: number, h: number, radius: number): Float32Array {
  if (radius < 1) return src;
  const win = radius * 2 + 1;
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = -radius; x <= radius; x++) if (x >= 0 && x < w) sum += src[y * w + x]!;
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = sum / win;
      const add = x + radius + 1, sub = x - radius;
      if (add < w) sum += src[y * w + add]!;
      if (sub >= 0) sum -= src[y * w + sub]!;
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -radius; y <= radius; y++) if (y >= 0 && y < h) sum += tmp[y * w + x]!;
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / win;
      const add = y + radius + 1, sub = y - radius;
      if (add < h) sum += tmp[add * w + x]!;
      if (sub >= 0) sum -= tmp[sub * w + x]!;
    }
  }
  return out;
}

/** Gaussian-like blur: three box passes sized from the standard deviation (in pixels). */
export function gaussianBlur(src: Float32Array, w: number, h: number, sigmaPx: number): Float32Array {
  if (!(sigmaPx > 0.3)) return src;
  const radius = Math.max(1, Math.round((Math.sqrt(4 * sigmaPx * sigmaPx + 1) - 1) / 2));
  let cur = src;
  for (let i = 0; i < 3; i++) cur = boxBlur(cur, w, h, radius);
  return cur;
}

/** The bitmap for one effect of a shape, or null when the shape is empty. */
export function effectBitmap(shape: FxShape, spec: FxSpec): FxBitmap | null {
  if (!(shape.w > 0) || !(shape.h > 0)) return null;
  const dx = spec.mode === "blur" ? 0 : spec.dx ?? 0, dy = spec.mode === "blur" ? 0 : spec.dy ?? 0;
  const pad = Math.ceil(spec.sigma * 3) + Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)));
  const tw = shape.w + pad * 2, th = shape.h + pad * 2;
  const s = Math.min(2, MAX_SIDE / Math.max(tw, th));
  const gw = Math.max(1, Math.ceil(tw * s)), gh = Math.max(1, Math.ceil(th * s));
  const cov = new Float32Array(gw * gh);
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      // Pixel centre in document units, relative to the shape's centre (the shape sits at the offset).
      const px = (i + 0.5) / s - tw / 2 - dx, py = (j + 0.5) / s - th / 2 - dy;
      cov[j * gw + i] = coverageAt(shape, px, py, s);
    }
  }
  const blurred = gaussianBlur(cov, gw, gh, spec.sigma * s);
  const rgba = new Uint8ClampedArray(gw * gh * 4);
  const c = spec.color;
  for (let k = 0; k < gw * gh; k++) {
    const v = spec.mode === "inner" ? 1 - blurred[k]! : blurred[k]!;
    rgba[k * 4] = Math.round(c.r * 255); rgba[k * 4 + 1] = Math.round(c.g * 255); rgba[k * 4 + 2] = Math.round(c.b * 255);
    rgba[k * 4 + 3] = Math.round(Math.min(1, Math.max(0, v * c.a)) * 255);
  }
  return { width: gw, height: gh, rgba, x: -pad, y: -pad, w: tw, h: th };
}
