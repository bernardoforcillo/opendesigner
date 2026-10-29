// EFFECTS THAT USE A SECOND LAYER. The shader gets the node as `S(xy)` and the other layer as `O(xy)` (both premultiplied, in
// the same local space, so a layer that sits elsewhere in the document lines up with the node on screen). Which layer is the
// effect's `fx.<effect>.layer.<id>` track (animation/fx/props.ts), chosen in the editor; a missing layer is an empty image.
// CC Composite uses the node as it was before the effects ("original") instead.

import type { FxDef } from "@/animation/fx/library";
import { P, kern } from "@/animation/fx/kit";

// channel selectors shared by several effects: 0 luma, 1 R, 2 G, 3 B, 4 A (of an unpremultiplied colour `u` and alpha `a`)
const chan = (sel: string, u: string, a: string) =>
  `(${sel} < 0.5 ? lum(${u}) : ${sel} < 1.5 ? ${u}.r : ${sel} < 2.5 ? ${u}.g : ${sel} < 3.5 ? ${u}.b : ${a})`;
const CHANNELS = "0 Luminance, 1 Red, 2 Green, 3 Blue, 4 Alpha";

// blend of two scalars/colours by an operator index
const OPS = "0 Normal, 1 Add, 2 Subtract, 3 Multiply, 4 Screen, 5 Overlay, 6 Difference, 7 Min, 8 Max";
const op = (o: string, a: string, b: string) =>
  `(${o} < 0.5 ? ${b} : ${o} < 1.5 ? ${a} + ${b} : ${o} < 2.5 ? ${a} - ${b} : ${o} < 3.5 ? ${a} * ${b} : ${o} < 4.5 ? 1.0 - (1.0 - ${a}) * (1.0 - ${b}) : ${o} < 5.5 ? mix(2.0 * ${a} * ${b}, 1.0 - 2.0 * (1.0 - ${a}) * (1.0 - ${b}), step(0.5, ${a})) : ${o} < 6.5 ? abs(${a} - ${b}) : ${o} < 7.5 ? min(${a}, ${b}) : max(${a}, ${b}))`;

const LAYER = { other: "layer" as const };

export const LAYER_FX: FxDef[] = [
  kern("ec.channel.setmatte", [
    P("channel", `Take Matte From (${CHANNELS})`, 0, 4, 4), P("invert", "Invert Matte", 0, 1, 0), P("mode", "Composite Matte With Original (0 Replace Alpha, 1 Multiply)", 0, 1, 1),
    P("premultiply", "Premultiply Matte Layer", 0, 1, 0), P("opacity", "Opacity", 0, 100, 100, 1, "%"),
  ], `
  half4 c = S(xy); half4 m = O(xy); float3 mu = unp(m);
  float v = ${chan("p[0]", "mu", "float(m.a)")};
  if (p[1] > 0.5) { v = 1.0 - v; }
  if (p[3] > 0.5) { v *= float(m.a); }
  float a = p[2] < 0.5 ? v : float(c.a) * v;
  return pre(unp(c), mix(float(c.a), a, p[4] / 100.0));`, LAYER),

  kern("ec.channel.setchannels", [
    P("red", "Take Red From (0 This R, 1 This G, 2 This B, 3 This A, 4 This Luma, 5 Layer R, 6 Layer G, 7 Layer B, 8 Layer A, 9 Layer Luma, 10 Off, 11 On)", 0, 11, 0),
    P("green", "Take Green From", 0, 11, 1), P("blue", "Take Blue From", 0, 11, 2), P("alpha", "Take Alpha From", 0, 11, 3), P("premultiply", "Premultiply Result", 0, 1, 0),
  ], `
  half4 c = S(xy); half4 m = O(xy); float3 u = unp(c); float3 mu = unp(m);
  float ca = float(c.a), ma = float(m.a), cl = lum(u), ml = lum(mu);
  float r = (p[0] < 0.5 ? u.r : p[0] < 1.5 ? u.g : p[0] < 2.5 ? u.b : p[0] < 3.5 ? ca : p[0] < 4.5 ? cl : p[0] < 5.5 ? mu.r : p[0] < 6.5 ? mu.g : p[0] < 7.5 ? mu.b : p[0] < 8.5 ? ma : p[0] < 9.5 ? ml : p[0] < 10.5 ? 0.0 : 1.0);
  float g = (p[1] < 0.5 ? u.r : p[1] < 1.5 ? u.g : p[1] < 2.5 ? u.b : p[1] < 3.5 ? ca : p[1] < 4.5 ? cl : p[1] < 5.5 ? mu.r : p[1] < 6.5 ? mu.g : p[1] < 7.5 ? mu.b : p[1] < 8.5 ? ma : p[1] < 9.5 ? ml : p[1] < 10.5 ? 0.0 : 1.0);
  float b = (p[2] < 0.5 ? u.r : p[2] < 1.5 ? u.g : p[2] < 2.5 ? u.b : p[2] < 3.5 ? ca : p[2] < 4.5 ? cl : p[2] < 5.5 ? mu.r : p[2] < 6.5 ? mu.g : p[2] < 7.5 ? mu.b : p[2] < 8.5 ? ma : p[2] < 9.5 ? ml : p[2] < 10.5 ? 0.0 : 1.0);
  float a = (p[3] < 0.5 ? u.r : p[3] < 1.5 ? u.g : p[3] < 2.5 ? u.b : p[3] < 3.5 ? ca : p[3] < 4.5 ? cl : p[3] < 5.5 ? mu.r : p[3] < 6.5 ? mu.g : p[3] < 7.5 ? mu.b : p[3] < 8.5 ? ma : p[3] < 9.5 ? ml : p[3] < 10.5 ? 0.0 : 1.0);
  return p[4] > 0.5 ? pre(float3(r, g, b), clamp(a, 0.0, 1.0)) : half4(half3(float3(r, g, b)), half(clamp(a, 0.0, 1.0)));`, LAYER),

  kern("ec.channel.blend", [
    P("ratio", "Blend With Layer", 0, 100, 50, 1, "%"), P("mode", "If Layer Sizes Differ / Mode (0 Crossfade, 1 Color Only, 2 Tint Only, 3 Darken Only, 4 Lighten Only)", 0, 4, 0),
  ], `
  half4 c = S(xy); half4 m = O(xy); float3 u = unp(c), mu = unp(m);
  float k = p[0] / 100.0;
  float3 o;
  if (p[1] < 0.5) { o = mix(u, mu, k); }
  else if (p[1] < 1.5) { float3 ch = mu - lum(mu); o = lum(u) + mix(u - lum(u), ch, k); }
  else if (p[1] < 2.5) { float l = lum(mu); o = mix(u, float3(lum(u)) * (mu / max(l, 0.001)), k); }
  else if (p[1] < 3.5) { o = mix(u, min(u, mu), k); }
  else { o = mix(u, max(u, mu), k); }
  float a = p[1] < 0.5 ? mix(float(c.a), float(m.a), k) : float(c.a);
  return pre(clamp(o, 0.0, 1.0), a);`, LAYER),

  kern("ec.channel.cccomposite", [
    P("composite", "Composite Original (0 In Front, 1 Behind, 2 None)", 0, 2, 0), P("rgbOnly", "RGB Only", 0, 1, 0), P("opacity", "Opacity", 0, 100, 100, 1, "%"),
  ], `
  half4 c = S(xy); half4 o = O(xy);
  half4 orig = p[1] > 0.5 ? half4(o.rgb * (o.a > 0.0 ? c.a / o.a : 0.0), c.a) : o;
  orig *= half(p[2] / 100.0);
  if (p[0] > 1.5) { return c; }
  return p[0] < 0.5 ? orig + c * (1.0 - orig.a) : c + orig * (1.0 - c.a);`, { other: "original" }),

  kern("ec.channel.calculations", [
    P("input", `Input Channel (${CHANNELS})`, 0, 4, 1), P("invertInput", "Invert Input", 0, 1, 0), P("second", `Second Channel (${CHANNELS})`, 0, 4, 1), P("invertSecond", "Invert Second", 0, 1, 0),
    P("opacity", "Second Opacity", 0, 100, 100, 1, "%"), P("op", `Blending Mode (${OPS})`, 0, 8, 3), P("output", "Output Channel (0 All, 1 Red, 2 Green, 3 Blue, 4 Alpha)", 0, 4, 0), P("preserve", "Preserve Underlying Transparency", 0, 1, 1), P("clip", "Clip Result", 0, 1, 1),
  ], `
  half4 c = S(xy); half4 m = O(xy); float3 u = unp(c), mu = unp(m);
  float a = ${chan("p[0]", "u", "float(c.a)")}; if (p[1] > 0.5) { a = 1.0 - a; }
  float b = ${chan("p[2]", "mu", "float(m.a)")}; if (p[3] > 0.5) { b = 1.0 - b; }
  float r = mix(a, ${op("p[5]", "a", "b")}, p[4] / 100.0);
  if (p[8] > 0.5) { r = clamp(r, 0.0, 1.0); }
  float3 o = u; float al = float(c.a);
  if (p[6] < 0.5) { o = float3(r); }
  else if (p[6] < 1.5) { o.r = r; } else if (p[6] < 2.5) { o.g = r; } else if (p[6] < 3.5) { o.b = r; } else { al = r; }
  return pre(clamp(o, 0.0, 1.0), p[7] > 0.5 && p[6] < 3.5 ? float(c.a) : clamp(al, 0.0, 1.0));`, LAYER),

  kern("ec.channel.compoundarithmetic", [
    P("op", `Operation (${OPS})`, 0, 8, 1), P("blend", "Blend With Original", 0, 100, 0, 1, "%"), P("preserve", "Preserve Transparency", 0, 1, 1), P("clip", "Clip Result", 0, 1, 1), P("opacity", "Second Layer Opacity", 0, 100, 100, 1, "%"), P("alphaToo", "Operate on Alpha Too", 0, 1, 0),
  ], `
  half4 c = S(xy); half4 m = O(xy); float3 u = unp(c); float3 mu = unp(m) * float(p[4] / 100.0);
  float3 r = ${op("p[0]", "u", "mu")};
  if (p[3] > 0.5) { r = clamp(r, 0.0, 1.0); }
  float a = p[5] > 0.5 ? clamp(${op("p[0]", "float(c.a)", "float(m.a)")}, 0.0, 1.0) : float(c.a);
  if (p[2] > 0.5 && p[5] < 0.5) { a = float(c.a); } else if (p[2] < 0.5 && p[5] < 0.5) { a = max(float(c.a), float(m.a) * p[4] / 100.0); }
  return pre(mix(clamp(r, 0.0, 1.0), u, p[1] / 100.0), a);`, LAYER),

  kern("ec.key.differencematte", [
    P("tolerance", "Matching Tolerance", 0, 100, 10), P("softness", "Matching Softness", 0, 100, 10), P("blur", "Blur Hi-Lo", 0, 20, 0, 0.5), P("view", "View (0 Final Output, 1 Matte Only)", 0, 1, 0), P("invert", "Invert", 0, 1, 0), P("cleanup", "Difference Cleanup", 0, 100, 0),
  ], `
  half4 c = S(xy); float3 u = unp(c);
  float d = 0.0; float n = 1.0;
  d = length(u - unp(O(xy))) / 1.7320508 + abs(float(c.a) - float(O(xy).a)) * 0.5;
  if (p[2] > 0.0) {
    d = 0.0;
    for (int i = 0; i < 12; i++) { float2 o = ring(float(i), 12.0) * p[2]; d += length(unp(S(xy + o)) - unp(O(xy + o))) / 1.7320508; }
    d /= 12.0;
  }
  float t = p[0] / 100.0 * 0.5, s = p[1] / 100.0 * 0.5 + 0.001;
  float m = smoothstep(t, t + s, d);
  m = clamp((m - p[5] / 100.0 * 0.3) / max(1.0 - p[5] / 100.0 * 0.3, 0.1), 0.0, 1.0);
  if (p[4] > 0.5) { m = 1.0 - m; }
  return p[3] > 0.5 ? pre(float3(m), 1.0) : pre(u, float(c.a) * m);`, LAYER),

  kern("ec.matte.objectmatte", [
    P("channel", `Matte From (${CHANNELS})`, 0, 4, 4), P("invert", "Invert", 0, 1, 0), P("shrink", "Shrink/Grow", -50, 50, 0, 0.5), P("feather", "Feather", 0, 50, 0, 0.5), P("threshold", "Threshold", 0, 100, 50),
    P("mode", "Composite (0 Replace Alpha, 1 Multiply)", 0, 1, 1), P("contrast", "Contrast", 0, 4, 1, 0.05), P("opacity", "Opacity", 0, 100, 100, 1, "%"),
  ], `
  half4 c = S(xy);
  float v = 0.0, mx = 0.0, mn = 1.0;
  float r = max(abs(p[2]), p[3]);
  for (int i = 0; i < 16; i++) {
    half4 m = O(xy + ring(float(i), 16.0) * r);
    float s = ${chan("p[0]", "unp(m)", "float(m.a)")};
    v += s; mx = max(mx, s); mn = min(mn, s);
  }
  v /= 16.0;
  float cen = ${chan("p[0]", "unp(O(xy))", "float(O(xy).a)")};
  float edge = p[2] > 0.0 ? mix(v, mn, 0.8) : p[2] < 0.0 ? mix(v, mx, 0.8) : (p[3] > 0.0 ? v : cen);
  float m = smoothstep(p[4] / 100.0 - 0.15 - p[3] / 100.0, p[4] / 100.0 + 0.15 + p[3] / 100.0, edge);
  m = clamp((m - 0.5) * p[6] + 0.5, 0.0, 1.0);
  if (p[1] > 0.5) { m = 1.0 - m; }
  float a = p[5] > 0.5 ? float(c.a) * m : m;
  return pre(unp(c), mix(float(c.a), a, p[7] / 100.0));`, { ...LAYER, outset: (v) => Math.max(v.feather, Math.abs(v.shrink)) }),

  kern("ec.noise.matchgrain", [
    P("amount", "Match Amount", 0, 300, 100, 1, "%"), P("size", "Grain Size", 0.5, 10, 1, 0.1), P("seed", "Seed", 0, 1000, 1), P("mono", "Monochromatic", 0, 1, 0), P("radius", "Sample Radius", 1, 30, 4, 0.5), P("highlights", "Highlight Protection", 0, 100, 30),
  ], `
  // the grain of the other layer: how much it differs from its own neighbourhood, taken as the noise amplitude
  float energy = 0.0;
  float3 mean = float3(0.0);
  for (int i = 0; i < 12; i++) { mean += unp(O(xy + ring(float(i), 12.0) * p[4])); }
  mean /= 12.0;
  for (int i = 0; i < 12; i++) { float3 d = unp(O(xy + ring(float(i), 12.0) * p[4])) - mean; energy += dot(d, d); }
  float amp = sqrt(energy / 12.0) * p[0] / 100.0 * 1.5;
  half4 c = S(xy); float3 u = unp(c);
  float2 g = floor(xy / p[1]) + p[2];
  float3 n = p[3] > 0.5 ? float3(hash21(g) - 0.5) : float3(hash21(g), hash21(g + 7.7), hash21(g + 13.3)) - 0.5;
  float prot = 1.0 - smoothstep(0.7, 1.0, lum(u)) * p[5] / 100.0;
  return pre(clamp(u + n * 2.0 * amp * prot, 0.0, 1.0), float(c.a));`, LAYER),

  kern("ec.color.colorstabilizer", [
    P("x", "Sample Point X", 0, 100, 50, 0.5, "%"), P("y", "Sample Point Y", 0, 100, 50, 0.5, "%"), P("radius", "Sample Radius", 0, 50, 4, 0.5), P("method", "Stabilize (0 Brightness, 1 Levels, 2 Curves)", 0, 2, 1), P("amount", "Amount", 0, 100, 100, 1, "%"), P("limit", "Max Gain", 1, 8, 3, 0.1),
  ], `
  // gain that makes the colour at the sample point match the same point of the other layer (the reference)
  float2 pt = box.xy + box.zw * float2(p[0], p[1]) / 100.0;
  float3 a = float3(0.0), b = float3(0.0);
  for (int i = 0; i < 9; i++) {
    float2 q = pt + (float2(mod(float(i), 3.0), floor(float(i) / 3.0)) - 1.0) * p[2];
    a += unp(S(q)); b += unp(O(q));
  }
  a /= 9.0; b /= 9.0;
  float3 gain = clamp(b / max(a, float3(0.01)), float3(1.0 / p[5]), float3(p[5]));
  if (p[3] < 0.5) { float g = clamp(lum(b) / max(lum(a), 0.01), 1.0 / p[5], p[5]); gain = float3(g); }
  half4 c = S(xy); float3 u = unp(c);
  float3 o = p[3] > 1.5 ? pow(u, 1.0 / gain) : u * gain;
  return pre(clamp(mix(u, o, p[4] / 100.0), 0.0, 1.0), float(c.a));`, LAYER),

  kern("ec.perspective.ccenvironment", [
    P("amount", "Reflection", 0, 100, 60, 1, "%"), P("bump", "Bump From Brightness", 0, 20, 4, 0.1), P("rotation", "Rotation", -3600, 3600, 0, 1, "°"), P("mapping", "Mapping (0 Spherical, 1 Planar)", 0, 1, 0),
  ], `
  // the node's own relief (its luminance) bends a view of the other layer, as an environment, over it
  half4 c = S(xy);
  float gx = lum(float3(S(xy + float2(1, 0)).rgb)) - lum(float3(S(xy - float2(1, 0)).rgb));
  float gy = lum(float3(S(xy + float2(0, 1)).rgb)) - lum(float3(S(xy - float2(0, 1)).rgb));
  float2 u = (xy - ctr()) / max(min(box.z, box.w) * 0.5, 1.0);
  float3 n = normalize(float3(u.x * 0.6 - gx * p[1], u.y * 0.6 - gy * p[1], 1.0));
  float2 e = p[3] < 0.5 ? n.xy * 0.5 + 0.5 : u * 0.5 + 0.5 + float2(gx, gy) * p[1] * 0.2;
  e = rot(e - 0.5, radians(p[2])) + 0.5;
  half4 env = O(box.xy + e * box.zw);
  half4 o = half4(mix(c.rgb, env.rgb * c.a, half(p[0] / 100.0)), c.a);
  return o;`, LAYER),
];
