// Colour management, a basic grade, a screen keyer, matte refinement, equirectangular (VR) tools and a few
// remaining distortions/transitions (see kit.ts). Where EffectCraft's effect needs external data (OCIO configs,
// LUT files, other layers, masks) only the part that works on the node's own pixels is implemented.

import type { FxDef } from "@/animation/fx/library";
import { P, carrier, kern, lutKern } from "@/animation/fx/kit";
import { autoColorLut, autoContrastLut, autoLevelsLut, equalizeLut, type EqualizeMethod } from "@/animation/fx/stats";

const HUE = (id: string, label: string, def: number) => P(id, label, 0, 360, def, 1, "°");

// Linear-light primaries as 3x3 matrices to XYZ-free "RGB to RGB" conversions via Rec.709 linear.
const TO709 = `
float3 toLin709(float3 c, float sp) {
  if (sp < 0.5) { return mix(c / 12.92, pow((c + 0.055) / 1.055, float3(2.4)), step(0.04045, c)); }
  return c;
}
float3 fromLin709(float3 c, float sp) {
  if (sp < 0.5) { return mix(c * 12.92, 1.055 * pow(max(c, float3(0.0)), float3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
  return c;
}
float3 gamutToRec709(float3 c, float g) {
  if (g < 0.5) { return c; }
  if (g < 1.5) { return float3(dot(c, float3(1.7049500, -0.6217926, -0.0831576)), dot(c, float3(-0.1302477, 1.1408004, -0.0105526)), dot(c, float3(-0.0240019, -0.1289684, 1.1529702))); }
  if (g < 2.5) { return float3(dot(c, float3(1.6604910, -0.5876410, -0.0728499)), dot(c, float3(-0.1245505, 1.1328998, -0.0083494)), dot(c, float3(-0.0181507, -0.1005789, 1.1187296))); }
  return float3(dot(c, float3(1.2249400, -0.2249401, 0.0000000)), dot(c, float3(-0.0420568, 1.0420569, 0.0000000)), dot(c, float3(-0.0196377, -0.0786360, 1.0982736)));
}
float3 gamutFromRec709(float3 c, float g) {
  if (g < 0.5) { return c; }
  if (g < 1.5) { return float3(dot(c, float3(0.6131324, 0.3395381, 0.0473296)), dot(c, float3(0.0701934, 0.9163569, 0.0134497)), dot(c, float3(0.0206155, 0.1095697, 0.8698148))); }
  if (g < 2.5) { return float3(dot(c, float3(0.6274039, 0.3292830, 0.0433131)), dot(c, float3(0.0690973, 0.9195405, 0.0113623)), dot(c, float3(0.0163914, 0.0880133, 0.8955953))); }
  return float3(dot(c, float3(0.8224621, 0.1775380, 0.0000000)), dot(c, float3(0.0331941, 0.9668058, 0.0000000)), dot(c, float3(0.0170827, 0.0723974, 0.9105199)));
}
`;

const CLIPS = [P("blackClip", "Black Clip", 0, 50, 0.1, 0.05, "%"), P("whiteClip", "White Clip", 0, 50, 0.1, 0.05, "%"), P("blend", "Blend With Original", 0, 100, 0, 1, "%")];
const opts = (v: Record<string, number>) => ({ blackClip: v.blackClip, whiteClip: v.whiteClip, blend: 1 - v.blend / 100 });

export const MORE3_FX: FxDef[] = [
  // Whole-node statistics: the node is read back, counted, and mapped through a lookup table -------------------
  lutKern("ec.color.autolevels", CLIPS, (v, h) => autoLevelsLut(h, opts(v))),
  lutKern("ec.color.autocontrast", CLIPS, (v, h) => autoContrastLut(h, opts(v))),
  lutKern("ec.color.autocolor", [...CLIPS, P("snapNeutral", "Snap Neutral Midtones", 0, 1, 1)], (v, h) => autoColorLut(h, { ...opts(v), snapNeutral: v.snapNeutral > 0.5 })),
  lutKern("ec.color.equalize", [P("method", "Equalize (0 RGB, 1 Brightness, 2 Photoshop Style)", 0, 2, 2), P("amount", "Amount to Equalize", 0, 100, 100, 1, "%")],
    (v, h) => equalizeLut(h, (["rgb", "brightness", "photoshop"] as EqualizeMethod[])[Math.round(v.method)], v.amount / 100),
    (v) => (Math.round(v.method) === 0 ? 0 : 1)),


  // Colour management ---------------------------------------------------------------------------------
  kern("ec.color.ociocdl", [
    P("slopeR", "Slope Red", 0, 4, 1, 0.01), P("slopeG", "Slope Green", 0, 4, 1, 0.01), P("slopeB", "Slope Blue", 0, 4, 1, 0.01),
    P("offR", "Offset Red", -1, 1, 0, 0.005), P("offG", "Offset Green", -1, 1, 0, 0.005), P("offB", "Offset Blue", -1, 1, 0, 0.005),
    P("powR", "Power Red", 0.1, 4, 1, 0.01), P("powG", "Power Green", 0.1, 4, 1, 0.01), P("powB", "Power Blue", 0.1, 4, 1, 0.01), P("sat", "Saturation", 0, 4, 1, 0.01),
  ], `
  half4 c = S(xy); float3 u = unp(c);
  float3 o = pow(max(u * float3(p[0], p[1], p[2]) + float3(p[3], p[4], p[5]), float3(0.0)), float3(p[6], p[7], p[8]));
  float l = lum(o);
  o = l + (o - l) * p[9];
  return pre(clamp(o, 0.0, 1.0), float(c.a));`),

  kern("ec.color.ociocolorspace", [
    P("from", "Input Space (0 sRGB, 1 Linear Rec.709, 2 ACEScg, 3 Linear Rec.2020, 4 Linear Display P3)", 0, 4, 0),
    P("to", "Output Space", 0, 4, 2),
  ], `
  half4 c = S(xy); float3 u = unp(c);
  float fromGamut = p[0] < 1.5 ? 0.0 : p[0] - 1.0;
  float toGamut = p[1] < 1.5 ? 0.0 : p[1] - 1.0;
  float3 lin = gamutToRec709(toLin709(u, p[0] < 0.5 ? 0.0 : 1.0), fromGamut);
  float3 o = fromLin709(gamutFromRec709(lin, toGamut), p[1] < 0.5 ? 0.0 : 1.0);
  return pre(clamp(o, 0.0, 1.0), float(c.a));`, { head: TO709 }),

  kern("ec.color.lumetri", [
    P("exposure", "Exposure", -5, 5, 0, 0.05), P("contrast", "Contrast", -100, 100, 0), P("highlights", "Highlights", -100, 100, 0), P("shadows", "Shadows", -100, 100, 0),
    P("whites", "Whites", -100, 100, 0), P("blacks", "Blacks", -100, 100, 0), P("temperature", "Temperature", -100, 100, 0), P("tint", "Tint", -100, 100, 0),
    P("saturation", "Saturation", 0, 200, 100), P("vibrance", "Vibrance", -100, 100, 0), P("fade", "Faded Film", 0, 100, 0), P("sharpen", "Sharpen", 0, 100, 0),
  ], `
  half4 c = S(xy); float3 u = unp(c) * pow(2.0, p[0]);
  float l = lum(u);
  u += p[2] / 100.0 * 0.25 * smoothstep(0.5, 1.0, l) + p[3] / 100.0 * 0.25 * (1.0 - smoothstep(0.0, 0.5, l));
  u += p[4] / 100.0 * 0.15 * smoothstep(0.75, 1.0, l) + p[5] / 100.0 * 0.15 * (1.0 - smoothstep(0.0, 0.25, l));
  u = (u - 0.5) * (1.0 + p[1] / 100.0) + 0.5;
  u *= float3(1.0 + p[6] / 300.0, 1.0 - p[7] / 400.0, 1.0 - p[6] / 300.0);
  float3 h = rgb2hsv(clamp(u, 0.0, 1.0));
  h.y = clamp(h.y * (p[8] / 100.0) * (1.0 + p[9] / 100.0 * (1.0 - h.y)), 0.0, 1.0);
  u = hsv2rgb(h);
  u = mix(u, float3(0.5), p[10] / 300.0) + p[10] / 600.0;
  if (p[11] > 0.0) {
    half4 b = (S(xy + float2(1, 0)) + S(xy - float2(1, 0)) + S(xy + float2(0, 1)) + S(xy - float2(0, 1))) * 0.25;
    u += (unp(c) - unp(b)) * p[11] / 25.0;
  }
  return pre(clamp(u, 0.0, 1.0), float(c.a));`),

  kern("ec.color.curves", [
    P("black", "Black Point", 0, 1, 0, 0.005), P("shadow", "Shadows (output at 25%)", 0, 1, 0.25, 0.005), P("mid", "Midtones (output at 50%)", 0, 1, 0.5, 0.005),
    P("light", "Highlights (output at 75%)", 0, 1, 0.75, 0.005), P("white", "White Point", 0, 1, 1, 0.005), P("channel", "Channel (0 RGB, 1 Red, 2 Green, 3 Blue, 4 Luma)", 0, 4, 0),
  ], `
  half4 c = S(xy); float3 u = unp(c);
  float3 o = u;
  float3 x = u;
  float3 y = x;
  // piecewise linear through (0,p0) (.25,p1) (.5,p2) (.75,p3) (1,p4)
  float4 k0 = float4(p[0], p[1], p[2], p[3]);
  float4 k1 = float4(p[1], p[2], p[3], p[4]);
  float3 seg = clamp(floor(x * 4.0), float3(0.0), float3(3.0));
  float3 f = x * 4.0 - seg;
  float3 s = f;
  float3 a = float3(seg.x < 0.5 ? k0.x : seg.x < 1.5 ? k0.y : seg.x < 2.5 ? k0.z : k0.w, seg.y < 0.5 ? k0.x : seg.y < 1.5 ? k0.y : seg.y < 2.5 ? k0.z : k0.w, seg.z < 0.5 ? k0.x : seg.z < 1.5 ? k0.y : seg.z < 2.5 ? k0.z : k0.w);
  float3 b = float3(seg.x < 0.5 ? k1.x : seg.x < 1.5 ? k1.y : seg.x < 2.5 ? k1.z : k1.w, seg.y < 0.5 ? k1.x : seg.y < 1.5 ? k1.y : seg.y < 2.5 ? k1.z : k1.w, seg.z < 0.5 ? k1.x : seg.z < 1.5 ? k1.y : seg.z < 2.5 ? k1.z : k1.w);
  y = mix(a, b, s);
  if (p[5] < 0.5) { o = y; }
  else if (p[5] < 1.5) { o.r = y.r; } else if (p[5] < 2.5) { o.g = y.g; } else if (p[5] < 3.5) { o.b = y.b; }
  else { float l = lum(u); float ly = mix(0.0, 1.0, 0.0); float sl = clamp(floor(l * 4.0), 0.0, 3.0); float fl = l * 4.0 - sl; float ss = fl; float aa = sl < 0.5 ? k0.x : sl < 1.5 ? k0.y : sl < 2.5 ? k0.z : k0.w; float bb = sl < 0.5 ? k1.x : sl < 1.5 ? k1.y : sl < 2.5 ? k1.z : k1.w; ly = mix(aa, bb, ss); o = l > 0.0 ? u * (ly / l) : float3(ly); }
  return pre(clamp(o, 0.0, 1.0), float(c.a));`),

  // Keying and mattes ---------------------------------------------------------------------------------
  kern("ec.keying.keylight", [
    HUE("hue", "Screen Colour (hue)", 120), P("gain", "Screen Gain", 0, 200, 100), P("balance", "Screen Balance", 0, 100, 50), P("clipBlack", "Clip Black", 0, 100, 0),
    P("clipWhite", "Clip White", 0, 100, 100), P("softness", "Screen Shrink/Grow", -20, 20, 0), P("despill", "Despill Bias", 0, 100, 100), P("view", "View (0 Final, 1 Screen Matte)", 0, 1, 0),
  ], `
  half4 c = S(xy); float3 u = unp(c);
  float3 h = rgb2hsv(u);
  float3 r = hsv2rgb(float3(fract(h.x + (120.0 - p[0]) / 360.0), h.y, h.z));
  float bal = p[2] / 100.0;
  float screen = r.g - mix(r.r, r.b, bal);
  float a = 1.0 - clamp(screen * p[1] / 100.0 * 2.0, 0.0, 1.0);
  a = clamp((a - p[3] / 100.0) / max(p[4] / 100.0 - p[3] / 100.0, 0.001), 0.0, 1.0);
  float3 s = u;
  float3 hs = rgb2hsv(s);
  float spill = (1.0 - smoothstep(0.0, 0.25, hdist(hs.x, p[0] / 360.0))) * hs.y * p[6] / 100.0;
  hs.y *= 1.0 - spill;
  s = hsv2rgb(hs);
  if (p[7] > 0.5) { return pre(float3(a), float(c.a)); }
  return pre(s, float(c.a) * a);`),

  kern("ec.key.screen", [HUE("hue", "Screen Colour (hue)", 120), P("gain", "Gain", 0, 200, 100), P("shrink", "Shrink", 0, 100, 0), P("despill", "Despill", 0, 100, 80)], `
  half4 c = S(xy); float3 u = unp(c);
  float3 h = rgb2hsv(u);
  float d = hdist(h.x, p[0] / 360.0);
  float scr = (1.0 - smoothstep(0.05, 0.2, d)) * h.y * h.z * p[1] / 100.0;
  float a = 1.0 - clamp(scr * 1.4 - p[2] / 100.0 * 0.5, 0.0, 1.0);
  h.y *= 1.0 - (1.0 - smoothstep(0.0, 0.25, d)) * p[3] / 100.0;
  return pre(hsv2rgb(h), float(c.a) * a);`),

  kern("ec.matte.refinehard", [P("shrink", "Shrink/Grow", -50, 50, 0, 0.5), P("feather", "Feather", 0, 50, 0, 0.5), P("threshold", "Threshold", 0, 100, 50), P("decontaminate", "Decontaminate Edge Colors", 0, 100, 0)], `
  half4 c = S(xy);
  float acc = 0.0, best = p[0] >= 0.0 ? 0.0 : 1.0;
  float r = max(abs(p[0]), p[1]);
  for (int i = 0; i < 16; i++) {
    float a = float(S(xy + ring(float(i), 16.0) * r).a);
    acc += a;
    if (p[0] >= 0.0) { best = max(best, a); } else { best = min(best, a); }
  }
  float soft = acc / 16.0;
  float a = p[0] == 0.0 ? soft : mix(soft, best, 0.7);
  float t = p[2] / 100.0;
  a = smoothstep(t - 0.15 - p[1] / 100.0, t + 0.15 + p[1] / 100.0, a);
  // decontaminate: pull edge pixels' colour toward the fully opaque neighbours
  float3 u = unp(c);
  float3 core = u;
  float wsum = 0.0; float3 acc3 = float3(0.0);
  for (int i = 0; i < 8; i++) { half4 s = S(xy + ring(float(i), 8.0) * max(r, 2.0)); float w = float(s.a) * float(s.a); acc3 += unp(s) * w; wsum += w; }
  if (wsum > 0.0) { core = mix(u, acc3 / wsum, p[3] / 100.0 * (1.0 - float(c.a))); }
  return pre(core, a);`, { outset: (v) => Math.max(0, v.shrink) + v.feather }),

  kern("ec.matte.refinesoft", [P("shrink", "Shrink/Grow", -50, 50, 0, 0.5), P("softness", "Edge Softness", 0, 50, 4, 0.5), P("contrast", "Contrast", 0, 4, 1.5, 0.05), P("choke", "Choke Edge Detail", 0, 100, 0)], `
  half4 c = S(xy);
  float acc = 0.0;
  for (int i = 0; i < 16; i++) { acc += float(S(xy + ring(float(i), 16.0) * max(p[1], 0.5)).a); }
  float a = acc / 16.0 + p[0] / 200.0;
  a = clamp((a - 0.5) * p[2] + 0.5, 0.0, 1.0);
  a = mix(a, float(c.a), p[3] / 100.0);
  return pre(unp(c), a);`, { outset: (v) => v.softness }),

  // Equirectangular (VR) ------------------------------------------------------------------------------
  kern("ec.vr.spheretoplane", [P("fov", "Field of View", 10, 170, 90, 1, "°"), P("yaw", "Pan", -360, 360, 0, 1, "°"), P("pitch", "Tilt", -90, 90, 0, 1, "°"), P("roll", "Roll", -180, 180, 0, 1, "°"), P("zoom", "Zoom", 0.2, 5, 1, 0.05)], `
  float2 u = (uv(xy) - 0.5) * float2(box.z / max(box.w, 1.0), 1.0) * 2.0 / p[4];
  float f = 1.0 / tan(radians(p[0]) * 0.5);
  float3 d = normalize(float3(rot(u, radians(p[3])), f));
  float cp = cos(radians(p[2])), sp = sin(radians(p[2]));
  d = float3(d.x, d.y * cp - d.z * sp, d.y * sp + d.z * cp);
  float lon = atan(d.x, d.z) + radians(p[1]);
  float lat = asin(clamp(d.y, -1.0, 1.0));
  return S(box.xy + float2(fract(lon / (2.0 * PI) + 0.5), lat / PI + 0.5) * box.zw);`),

  kern("ec.vr.planetosphere", [P("fov", "Field of View", 20, 180, 120, 1, "°"), P("yaw", "Pan", -360, 360, 0, 1, "°"), P("pitch", "Tilt", -90, 90, 0, 1, "°"), P("scale", "Scale", 0.2, 5, 1, 0.05), P("curve", "Curvature", 0, 1, 0.7, 0.01)], `
  float2 q = (uv(xy) - 0.5) * float2(box.z / max(box.w, 1.0), 1.0) * 2.0 / p[3];
  float r = length(q);
  float ang = atan(q.y, q.x);
  // pitch the sphere from a stereographic projection: the "little planet" look
  float theta = r * radians(p[0]) * 0.5 * (1.0 + p[4] * r * 0.4);
  float3 d = float3(sin(theta) * cos(ang), sin(theta) * sin(ang), cos(theta));
  float cp = cos(radians(p[2])), sp = sin(radians(p[2]));
  d = float3(d.x, d.y * cp - d.z * sp, d.y * sp + d.z * cp);
  float lon = atan(d.x, d.z) + radians(p[1]);
  float lat = asin(clamp(d.y, -1.0, 1.0));
  return S(box.xy + float2(fract(lon / (2.0 * PI) + 0.5), lat / PI + 0.5) * box.zw);`),

  kern("ec.vr.rotatesphere", [P("yaw", "Pan", -360, 360, 0, 1, "°"), P("pitch", "Tilt", -90, 90, 0, 1, "°"), P("roll", "Roll", -180, 180, 0, 1, "°")], `
  float2 u = uv(xy);
  float lon = (u.x - 0.5) * 2.0 * PI, lat = (u.y - 0.5) * PI;
  float3 d = float3(cos(lat) * sin(lon), sin(lat), cos(lat) * cos(lon));
  float cr = cos(radians(p[2])), sr = sin(radians(p[2]));
  d = float3(d.x * cr - d.y * sr, d.x * sr + d.y * cr, d.z);
  float cp = cos(radians(p[1])), sp = sin(radians(p[1]));
  d = float3(d.x, d.y * cp - d.z * sp, d.y * sp + d.z * cp);
  float lo = atan(d.x, d.z) + radians(p[0]);
  float la = asin(clamp(d.y, -1.0, 1.0));
  return S(box.xy + float2(fract(lo / (2.0 * PI) + 0.5), la / PI + 0.5) * box.zw);`),

  kern("ec.vr.converter", [P("from", "Convert (0 Equirectangular to Mirror Ball, 1 Mirror Ball to Equirectangular)", 0, 1, 0), P("size", "Size", 0.2, 2, 1, 0.01)], `
  float2 q = (uv(xy) - 0.5) * 2.0 / p[1];
  if (p[0] < 0.5) {
    float r = length(q);
    if (r > 1.0) { return half4(0.0); }
    float z = sqrt(1.0 - r * r);
    float3 n = float3(q.x, -q.y, z);
    float3 d = reflect(float3(0.0, 0.0, -1.0), n);
    float lon = atan(d.x, -d.z), lat = asin(clamp(d.y, -1.0, 1.0));
    return S(box.xy + float2(fract(lon / (2.0 * PI) + 0.5), lat / PI + 0.5) * box.zw);
  }
  float2 u = uv(xy);
  float lon = (u.x - 0.5) * 2.0 * PI, lat = (0.5 - u.y) * PI;
  float3 d = float3(cos(lat) * sin(lon), sin(lat), cos(lat) * cos(lon));
  float3 n = normalize(d + float3(0.0, 0.0, 1.0));
  float2 m = float2(n.x, -n.y) * p[1];
  return S(ctr() + m * box.zw * 0.5);`),

  kern("ec.vr.chromaticaberrations", [P("amount", "Amount", 0, 50, 4, 0.5), P("angle", "Direction", -360, 360, 0, 1, "°"), P("radial", "Radial (0 Linear, 1 Radial)", 0, 1, 1), P("falloff", "Center Falloff", 0, 1, 0.3, 0.01)], `
  float2 q = (xy - ctr());
  float2 dir = p[2] > 0.5 ? normalize(q + 1e-4) * length(q) / max(length(box.zw) * 0.5, 1.0) : float2(cos(radians(p[1])), sin(radians(p[1])));
  float k = p[2] > 0.5 ? max(0.0, 1.0 - p[3] + p[3] * length(q) / max(length(box.zw) * 0.5, 1.0)) : 1.0;
  float2 o = dir * p[0] * k;
  half4 r = S(xy + o), g = S(xy), b = S(xy - o);
  return half4(r.r, g.g, b.b, max(max(r.a, g.a), b.a));`, { outset: (v) => v.amount }),

  kern("ec.vr.digitalglitch", [P("amount", "Glitch Amount", 0, 100, 40), P("block", "Block Height", 1, 200, 12), P("shift", "Max Shift", 0, 400, 40), P("rgb", "RGB Split", 0, 50, 6), P("seed", "Seed (animate for motion)", 0, 100000, 1)], `
  float row = floor((xy.y - box.xy.y) / max(p[1], 1.0));
  float g = hash21(float2(row, p[4]));
  float on = step(1.0 - p[0] / 100.0, g);
  float dx = (hash21(float2(row + 17.0, p[4])) - 0.5) * 2.0 * p[2] * on;
  float split = p[3] * on;
  half4 r = S(xy + float2(dx + split, 0)), gr = S(xy + float2(dx, 0)), b = S(xy + float2(dx - split, 0));
  return half4(r.r, gr.g, b.b, max(max(r.a, gr.a), b.a));`, { outset: (v) => v.shift + v.rgb }),

  // Remaining distortions / transitions -----------------------------------------------------------------
  kern("ec.obsolete.basic3d", [P("swivel", "Swivel", -90, 90, 0, 1, "°"), P("tilt", "Tilt", -90, 90, 0, 1, "°"), P("distance", "Distance to Image", 0, 2000, 400), P("specular", "Specular Highlight", 0, 1, 0)], `
  float2 q = xy - ctr();
  float sw = radians(p[0]), ti = radians(p[1]);
  // inverse of a rotation of the plane about the y then x axes with a pinhole camera at p[2]
  float z0 = p[2];
  float3 o = float3(0.0, 0.0, -z0);
  float3 d = normalize(float3(q, z0));
  float3 n = float3(sin(sw) * cos(ti), -sin(ti), -cos(sw) * cos(ti));
  float den = dot(d, n);
  if (abs(den) < 1e-4) { return half4(0.0); }
  float t = dot(-o, n) / den;
  float3 hit = o + d * t;
  float3 ax = float3(cos(sw), 0.0, sin(sw));
  float3 ay = float3(sin(sw) * sin(ti), cos(ti), -cos(sw) * sin(ti));
  float2 lp = float2(dot(hit, ax), dot(hit, ay));
  if (t < 0.0) { return half4(0.0); }
  half4 c = S(ctr() + lp);
  float spec = p[3] * pow(clamp(dot(reflect(d, n), float3(0.0, 0.0, -1.0)), 0.0, 1.0), 20.0);
  return half4(c.rgb + half3(spec) * c.a, c.a);`, { outset: (v) => v.distance }),

  kern("ec.distort.ccpageturn", [P("fold", "Fold Position", 0, 100, 50, 1, "%"), P("angle", "Fold Direction", -360, 360, 0, 1, "°"), P("radius", "Curl Radius", 4, 300, 40), P("back", "Back Opacity", 0, 100, 70)], `
  float2 n = float2(cos(radians(p[1])), sin(radians(p[1])));
  float2 q = xy - ctr();
  float ext = abs(box.z * n.x) + abs(box.w * n.y);
  float s = dot(q, n) - (p[0] / 100.0 - 0.5) * ext;
  float R = p[2];
  if (s <= 0.0) { return S(xy); }
  // the page rolls over a cylinder of radius R: the first half turn shows the front, then the back mirrored
  if (s < R * PI) {
    float th = s / R;
    half4 front = S(xy + n * (R * sin(th) - s));
    float shade = 0.7 + 0.3 * cos(th);
    return half4(front.rgb * half(shade), front.a);
  }
  half4 b = S(xy - n * 2.0 * (s - R * PI));
  float k = p[3] / 100.0;
  return half4(b.rgb * half(0.55 * k), b.a * half(k));`, { outset: (v) => v.radius * 4 }),

  kern("ec.transition.ccglasswipe", [P("completion", "Completion", 0, 100, 50), P("direction", "Direction", -360, 360, 90, 1, "°"), P("thickness", "Glass Thickness", 1, 300, 40), P("refraction", "Refraction", 0, 100, 40), P("shine", "Shine", 0, 100, 40)], `
  float a = radians(p[1]); float2 d = float2(sin(a), -cos(a));
  float2 q = xy - ctr();
  float ext = abs(box.z * d.x) + abs(box.w * d.y);
  float t = dot(q, d) + ext * 0.5;
  float thr = (ext + p[2]) * p[0] / 100.0 - p[2] * 0.5;
  float inGlass = 1.0 - smoothstep(0.0, p[2] * 0.5, abs(t - thr) - p[2] * 0.5);
  float side = clamp((t - thr) / max(p[2] * 0.5, 1.0), -1.0, 1.0);
  half4 c = S(xy + d * side * p[3] / 100.0 * p[2] * 0.6 * inGlass);
  float keep = p[0] <= 0.0 ? 1.0 : smoothstep(thr - p[2] * 0.5, thr + p[2] * 0.5, t);
  float edge = inGlass * (1.0 - abs(side)) * p[4] / 100.0;
  half4 o = c * half(keep);
  return half4(clamp(o.rgb + half3(edge * 0.5) * half(max(float(c.a), keep * 0.5)), 0.0, 1.0), clamp(o.a + half(edge * 0.3), 0.0, 1.0));`),

  carrier("ec.control.stereo3d", [P("separation", "Separation", -100, 100, 0), P("convergence", "Convergence", -100, 100, 0), P("eye", "Eye (0 Left, 1 Right)", 0, 1, 0), P("depth", "Depth", 0, 100, 50), P("enabled", "Enabled", 0, 1, 1)]),
];
