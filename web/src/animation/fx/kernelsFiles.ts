// THE EFFECTS THAT READ A FILE: Apply Color LUT, OCIO File Transform, OCIO Look Transform and PS Arbitrary Map. The file is chosen in a
// dialog (a string parameter holding the asset hash, fx/props.ts), parsed once (fx/files.ts) and handed to the shader as a small data
// image: a 1D table is `size x 1`, a cube is `size² x size`. Until the file has arrived, or if it cannot be read, the node is drawn
// without the effect.

import type { FxDef, FxKernel, FxValues } from "@/animation/fx/library";
import { fxData, packImage, type FxData } from "@/animation/fx/files";
import { P, pad, KHEAD } from "@/animation/fx/kit";

// p: 0 kind (0 1D, 1 cube), 1 size, 2 interpolation (0 linear, 1 nearest, 2 tetrahedral), 3 inverse, 4 amount, 5 saturation,
// 6 keep luminance, 7 process space (0 as is, 1 linear light), 8 domain minimum, 9 domain span
const HEAD = `uniform shader img;
float3 s2l(float3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, float3(2.4)), step(0.04045, c)); }
float3 l2s(float3 c) { c = max(c, float3(0.0)); return mix(c * 12.92, 1.055 * pow(c, float3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
float tap1(float i, int ch) { half4 v = img.eval(float2(i + 0.5, 0.5)); return ch == 0 ? float(v.r) : (ch == 1 ? float(v.g) : float(v.b)); }
float lerp1(float x, int ch) {
  float n = p[1]; float t = clamp(x, 0.0, 1.0) * (n - 1.0);
  if (p[2] > 0.5 && p[2] < 1.5) { return tap1(floor(t + 0.5), ch); }
  float i0 = floor(t); float i1 = min(i0 + 1.0, n - 1.0);
  return mix(tap1(i0, ch), tap1(i1, ch), t - i0);
}
float3 tap3(float3 i) { float n = p[1]; return float3(img.eval(float2(i.x + i.z * n + 0.5, i.y + 0.5)).rgb); }
float3 lerp3(float3 x) {
  float n = p[1]; float3 t = clamp(x, 0.0, 1.0) * (n - 1.0);
  if (p[2] > 0.5 && p[2] < 1.5) { return tap3(floor(t + 0.5)); }
  float3 a = floor(t); float3 f = t - a; float3 b = min(a + 1.0, n - 1.0);
  float3 c000 = tap3(a);
  float3 c111 = tap3(b);
  float3 c100 = tap3(float3(b.x, a.y, a.z)); float3 c010 = tap3(float3(a.x, b.y, a.z)); float3 c001 = tap3(float3(a.x, a.y, b.z));
  float3 c110 = tap3(float3(b.x, b.y, a.z)); float3 c101 = tap3(float3(b.x, a.y, b.z)); float3 c011 = tap3(float3(a.x, b.y, b.z));
  if (p[2] > 1.5) {
    if (f.x > f.y) {
      if (f.y > f.z) { return c000 + f.x * (c100 - c000) + f.y * (c110 - c100) + f.z * (c111 - c110); }
      if (f.x > f.z) { return c000 + f.x * (c100 - c000) + f.z * (c101 - c100) + f.y * (c111 - c101); }
      return c000 + f.z * (c001 - c000) + f.x * (c101 - c001) + f.y * (c111 - c101);
    }
    if (f.z > f.y) { return c000 + f.z * (c001 - c000) + f.y * (c011 - c001) + f.x * (c111 - c011); }
    if (f.z > f.x) { return c000 + f.y * (c010 - c000) + f.z * (c011 - c010) + f.x * (c111 - c011); }
    return c000 + f.y * (c010 - c000) + f.x * (c110 - c010) + f.z * (c111 - c110);
  }
  float3 x00 = mix(c000, c100, f.x); float3 x10 = mix(c010, c110, f.x); float3 x01 = mix(c001, c101, f.x); float3 x11 = mix(c011, c111, f.x);
  return mix(mix(x00, x10, f.y), mix(x01, x11, f.y), f.z);
}
float3 table(float3 c) {
  float3 x = (c - p[8]) / p[9]; float3 o;
  if (p[0] < 0.5) { o = float3(lerp1(x.r, 0), lerp1(x.g, 1), lerp1(x.b, 2)); } else { o = lerp3(x); }
  return o * p[9] + p[8];
}
float3 sat(float3 c, float s) { float l = lum(c); return max(float3(l) + (c - float3(l)) * s, float3(0.0)); }`;

const BODY = `
  half4 c = S(xy); float3 u = unp(c); float3 x = p[7] > 0.5 ? s2l(u) : u; float3 o;
  if (p[3] > 0.5 && p[0] < 0.5) {
    o = table(sat(x, p[5]));
  } else {
    o = table(x);
    if (p[5] != 1.0) { o = sat(o, p[5]); }
  }
  if (p[7] > 0.5) { o = l2s(o); }
  if (p[6] > 0.5) { float lo = lum(o); o = lo > 0.0001 ? o * (lum(u) / lo) : o; }
  return pre(clamp(mix(u, o, p[4]), 0.0, 1.0), float(c.a));`;

const sksl = `${KHEAD}${HEAD}\nhalf4 main(float2 xy) {${BODY}\n}`;

interface Use { interpolation?: number; inverse?: boolean; amount: number; saturation?: number; keepLuma?: boolean; linear?: boolean }

function fileFx(id: string, params: FxDef["params"], label: string, accept: string, use: (v: FxValues) => Use): FxDef {
  return {
    id, params, strings: [{ id: "file", label, default: "", file: accept }],
    kernel: (v, s): FxKernel => {
      const d: FxData | null = s.file ? fxData(s.file) : null;
      const none: FxKernel = { sksl, uniforms: pad([]), skip: true };
      if (!d) return none;
      const u = use(v);
      const inverse = !!u.inverse;
      const image = packImage(d, inverse);
            const sat = (u.saturation ?? 1) * (d.kind === "lut1d" ? image.sat : 1);
      return {
        sksl, image,
        uniforms: pad([d.kind === "lut3d" ? 1 : 0, d.size, u.interpolation ?? 0, inverse ? 1 : 0, u.amount, sat, u.keepLuma ? 1 : 0, u.linear ? 1 : 0, d.domain[0], d.domain[1] - d.domain[0]]),
      };
    },
  };
}

const INTERP = P("interpolation", "Interpolation (0 Linear, 1 Nearest, 2 Tetrahedral)", 0, 2, 0);
const AMOUNT = P("amount", "Amount", 0, 100, 100, 1, "%");

export const FILE_FX: FxDef[] = [
  fileFx("ec.utility.applylut", [AMOUNT], "Color LUT file (.cube, .3dl)", ".cube,.3dl", (v) => ({ amount: v.amount / 100 })),
  fileFx(
    "ec.color.ociofile",
    [INTERP, P("direction", "Direction (0 Forward, 1 Inverse)", 0, 1, 0), AMOUNT, P("linear", "Process in Linear Light", 0, 1, 0)],
    "Transform file (.cube, .3dl, .cdl)", ".cube,.3dl,.cdl,.cc,.ccc",
    (v) => ({ interpolation: Math.round(v.interpolation), inverse: v.direction > 0.5, amount: v.amount / 100, linear: v.linear > 0.5 }),
  ),
  fileFx(
    "ec.color.ociolook",
    [P("direction", "Direction (0 Forward, 1 Inverse)", 0, 1, 0), INTERP, AMOUNT, P("linear", "Process in Linear Light", 0, 1, 0), P("saturation", "Saturation", 0, 200, 100, 1, "%"), P("keepLuma", "Preserve Luminance", 0, 1, 0)],
    "Look file (.cube, .3dl, .cdl, .cc, .ccc)", ".cube,.3dl,.cdl,.cc,.ccc",
    (v) => ({ interpolation: Math.round(v.interpolation), inverse: v.direction > 0.5, amount: v.amount / 100, linear: v.linear > 0.5, saturation: v.saturation / 100, keepLuma: v.keepLuma > 0.5 }),
  ),
  fileFx(
    "ec.color.psarbitrarymap",
    [AMOUNT, P("keepLuma", "Preserve Luminosity", 0, 1, 0)],
    "Curves file (.acv, .amp)", ".acv,.amp",
    (v) => ({ amount: v.amount / 100, keepLuma: v.keepLuma > 0.5 }),
  ),
];
