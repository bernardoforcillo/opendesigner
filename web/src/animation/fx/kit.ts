// BUILDING BLOCKS for the effects that read or generate pixels with SkSL (fx/kernels*.ts).
// Type-only imports from library.ts: no runtime cycle.

import type { FxDef, FxParam, FxValues } from "@/animation/fx/library";

export const P = (id: string, label: string, min: number, max: number, def: number, step = 1, unit?: string): FxParam => ({
  id, label, min, max, step, default: def, unit,
});

export const pad = (n: readonly number[]): number[] => {
  const o = n.slice(0, 12);
  while (o.length < 12) o.push(0);
  return o;
};

export function hsvRgb(h: number, s: number, v: number): [number, number, number] {
  const k = (n: number) => (((n + h / 60) % 6) + 6) % 6;
  const f = (n: number) => v - v * s * Math.max(0, Math.min(k(n), 4 - k(n), 1));
  return [f(5), f(3), f(1)];
}

// Shared SkSL. `p[i]` is the i-th parameter in declaration order; `box` is the node's box in its local space.
const COMMON = `uniform float4 box; uniform float p[12];
const float PI = 3.14159265;
float2 ctr() { return box.xy + box.zw * 0.5; }
float2 uv(float2 xy) { return (xy - box.xy) / max(box.zw, float2(1.0)); }
float hash21(float2 q) { return fract(sin(dot(q, float2(127.1, 311.7))) * 43758.5453); }
float2 hash22(float2 q) { return float2(hash21(q), hash21(q + 19.19)); }
float vnoise(float2 q) {
  float2 i = floor(q), f = fract(q); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + float2(1, 0)), f.x), mix(hash21(i + float2(0, 1)), hash21(i + float2(1, 1)), f.x), f.y);
}
float fbm(float2 q) { float n = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { n += a * vnoise(q); q *= 2.0; a *= 0.5; } return n; }
float2 rot(float2 v, float a) { float c = cos(a), s = sin(a); return float2(c * v.x - s * v.y, s * v.x + c * v.y); }
float3 hsv2rgb(float3 c) {
  float3 k = mod(float3(5.0, 3.0, 1.0) + c.x * 6.0, 6.0);
  return c.z - c.z * c.y * clamp(min(k, 4.0 - k), 0.0, 1.0);
}
float3 rgb2hsv(float3 c) {
  float4 K = float4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  float4 q1 = c.g < c.b ? float4(c.bg, K.wz) : float4(c.gb, K.xy);
  float4 q2 = c.r < q1.x ? float4(q1.xyw, c.r) : float4(c.r, q1.yzx);
  float d = q2.x - min(q2.w, q2.y);
  return float3(abs(q2.z + (q2.w - q2.y) / (6.0 * d + 1e-10)), d / (q2.x + 1e-10), q2.x);
}
float hdist(float a, float b) { float d = abs(a - b); return min(d, 1.0 - d); }
float lum(float3 c) { return dot(c, float3(0.2126, 0.7152, 0.0722)); }
half4 tint(float3 c, float a) { return half4(half3(c * a), half(a)); }
`;
const KHEAD = `uniform shader src;\n${COMMON}
half4 S(float2 q) { return src.eval(q); }
// A Vogel spiral of n taps in the unit disk: ring(i, n) is the i-th offset.
float2 ring(float i, float n) { float r = sqrt((i + 0.5) / n); float a = i * 2.39996323; return r * float2(cos(a), sin(a)); }
float3 unp(half4 c) { return c.a > 0.0 ? float3(c.rgb) / float(c.a) : float3(0.0); }
half4 pre(float3 c, float a) { return half4(half3(c * a), half(a)); }
`;

type Body = string;

/** An effect that reads the node's pixels: `half4 main(float2 xy)` with `S(point)` sampling the node. */
export function kern(
  id: string, params: readonly FxParam[], body: Body,
  opts: { outset?: (v: FxValues) => number; uniforms?: (v: FxValues) => number[]; head?: string } = {},
): FxDef {
  const sksl = `${KHEAD}${opts.head ?? ""}\nhalf4 main(float2 xy) {\n${body}\n}`;
  return {
    id, params, outset: opts.outset,
    kernel: (v) => ({ sksl, uniforms: pad(opts.uniforms ? opts.uniforms(v) : params.map((q) => v[q.id])) }),
  };
}

/** An effect that draws a shader over the node (only where it has pixels, or as a mask). */
export function over(
  id: string, params: readonly FxParam[], body: Body, blend: "srcatop" | "dstin" = "srcatop",
  opts: { uniforms?: (v: FxValues) => number[] } = {},
): FxDef {
  const sksl = `${COMMON}half4 main(float2 xy) {\n${body}\n}`;
  return {
    id, params,
    overlay: () => ({
      sksl, blend,
      uniforms: (w) => pad(opts.uniforms ? opts.uniforms(w) : params.map((q) => w[q.id])),
    }),
  };
}

/** A mask: the body sets `float m` (1 keeps the node). */
export const wipeBody = (body: Body): Body => `${body}\n  return half4(half(clamp(m, 0.0, 1.0)));`;

/** An effect that only carries values (EffectCraft's Expression Controls). */
export const carrier = (id: string, params: readonly FxParam[], outset?: (v: FxValues) => number): FxDef => ({ id, params, carrier: true, outset });

/** A time effect (see timeFx.ts). */
export const time = (id: string, params: readonly FxParam[], t: NonNullable<FxDef["time"]>): FxDef => ({ id, params, time: t });
