// Blur, sharpen, convolution and edge effects (fx/kit.ts::kern): they average or compare a pixel
// with its neighbours, so they need the node's pixels offscreen.

import type { FxDef } from "@/animation/fx/library";
import { P, kern } from "@/animation/fx/kit";

const CX = P("centerX", "Center X", -100, 200, 50, 0.5, "%");
const CY = P("centerY", "Center Y", -100, 200, 50, 0.5, "%");

// 16-sample radial/zoom accumulation toward or around a center.
const radial = (spin: boolean) => `
  float2 c = box.xy + box.zw * float2(p[1], p[2]) / 100.0;
  float2 q = xy - c;
  half4 acc = half4(0.0);
  for (int i = 0; i < 24; i++) {
    float t = float(i) / 23.0 - 0.5;
    ${spin ? "acc += S(c + rot(q, radians(p[0]) * t));" : "acc += S(c + q * (1.0 - p[0] / 100.0 * (t + 0.5)));"}
  }
  return acc / 24.0;`;

export const BLUR_FX: FxDef[] = [
  kern("ec.blur.radial", [P("amount", "Amount", 0, 360, 10), CX, CY, P("type", "Type (0 Spin, 1 Zoom)", 0, 1, 0)], `
  float2 c = box.xy + box.zw * float2(p[1], p[2]) / 100.0;
  float2 q = xy - c;
  half4 acc = half4(0.0);
  for (int i = 0; i < 24; i++) {
    float t = float(i) / 23.0 - 0.5;
    float2 pt = p[3] < 0.5 ? c + rot(q, radians(p[0]) * t) : c + q * (1.0 - p[0] / 360.0 * (t + 0.5));
    acc += S(pt);
  }
  return acc / 24.0;`, { outset: (v) => v.amount * 2 }),

  kern("ec.blur.ccradial", [P("amount", "Amount", 0, 100, 20), CX, CY, P("type", "Type (0 Spin, 1 Zoom)", 0, 1, 1)], `
  float2 c = box.xy + box.zw * float2(p[1], p[2]) / 100.0;
  float2 q = xy - c;
  half4 acc = half4(0.0);
  for (int i = 0; i < 24; i++) {
    float t = float(i) / 23.0;
    float2 pt = p[3] < 0.5 ? c + rot(q, radians(p[0]) * (t - 0.5)) : c + q * (1.0 - p[0] / 100.0 * t);
    acc += S(pt);
  }
  return acc / 24.0;`),

  kern("ec.blur.ccradialfast", [P("amount", "Amount", 0, 100, 25), CX, CY], radial(false)),

  kern("ec.blur.cccross", [P("h", "Horizontal Scale", 0, 400, 20), P("v", "Vertical Scale", 0, 400, 20), P("shading", "Shading", 0, 100, 0)], `
  half4 acc = half4(0.0);
  for (int i = 0; i < 17; i++) {
    float t = float(i) / 16.0 - 0.5;
    acc += S(xy + float2(t * p[0], 0.0)) + S(xy + float2(0.0, t * p[1]));
  }
  return acc / 34.0;`, { outset: (v) => Math.max(v.h, v.v) }),

  kern("ec.blur.sharpen", [P("amount", "Sharpen Amount", 0, 100, 10)], `
  half4 c = S(xy);
  half4 b = (S(xy + float2(1, 0)) + S(xy - float2(1, 0)) + S(xy + float2(0, 1)) + S(xy - float2(0, 1))) * 0.25;
  float k = p[0] / 25.0;
  half4 o = c + (c - b) * half(k);
  float a = clamp(float(o.a), 0.0, 1.0);
  return half4(clamp(o.rgb, half3(0.0), half3(a)), half(a));`),

  kern("ec.blur.unsharp", [P("amount", "Amount", 0, 500, 50, 1, "%"), P("radius", "Radius", 0.5, 250, 3, 0.5), P("threshold", "Threshold", 0, 255, 0)], `
  half4 c = S(xy);
  half4 b = half4(0.0);
  for (int i = 0; i < 16; i++) { b += S(xy + ring(float(i), 16.0) * p[1]); }
  b /= 16.0;
  half4 d = c - b;
  if (abs(lum(float3(d.rgb))) * 255.0 < p[2]) { return c; }
  half4 o = c + d * half(p[0] / 100.0);
  float a = clamp(float(o.a), 0.0, 1.0);
  return half4(clamp(o.rgb, half3(0.0), half3(a)), half(a));`, { outset: (v) => v.radius }),

  kern("ec.blur.bilateral", [P("radius", "Radius", 0.5, 100, 6, 0.5), P("threshold", "Threshold", 1, 100, 20), P("sat", "Saturation", 0, 1, 1)], `
  half4 c = S(xy);
  half4 acc = c; float wsum = 1.0;
  for (int i = 0; i < 20; i++) {
    half4 s = S(xy + ring(float(i), 20.0) * p[0]);
    float d = length(float4(s) - float4(c)) * 255.0;
    float w = exp(-d * d / (2.0 * p[1] * p[1]));
    acc += s * half(w); wsum += w;
  }
  return acc / half(wsum);`, { outset: (v) => v.radius }),

  kern("ec.blur.smart", [P("radius", "Radius", 0.5, 100, 6, 0.5), P("threshold", "Threshold", 1, 100, 25)], `
  half4 c = S(xy);
  half4 acc = c; float wsum = 1.0;
  for (int i = 0; i < 20; i++) {
    half4 s = S(xy + ring(float(i), 20.0) * p[0]);
    float d = length(float4(s) - float4(c)) * 255.0;
    float w = d < p[1] ? 1.0 : 0.0;
    acc += s * half(w); wsum += w;
  }
  return acc / half(wsum);`, { outset: (v) => v.radius }),

  kern("ec.blur.channel", [P("red", "Red Blurriness", 0, 200, 0, 0.5), P("green", "Green Blurriness", 0, 200, 0, 0.5), P("blue", "Blue Blurriness", 0, 200, 0, 0.5), P("alpha", "Alpha Blurriness", 0, 200, 0, 0.5)], `
  half4 r = half4(0.0), g = half4(0.0), b = half4(0.0), a = half4(0.0);
  for (int i = 0; i < 24; i++) {
    float2 o = ring(float(i), 24.0);
    r += S(xy + o * p[0]); g += S(xy + o * p[1]); b += S(xy + o * p[2]); a += S(xy + o * p[3]);
  }
  r /= 24.0; g /= 24.0; b /= 24.0; a /= 24.0;
  return half4(r.r, g.g, b.b, a.a);`, { outset: (v) => Math.max(v.red, v.green, v.blue, v.alpha) }),

  kern("ec.blur.cameralens", [P("radius", "Blur Radius", 0, 200, 10, 0.5), P("highlight", "Highlight Gain", 0, 5, 0.5, 0.05), P("rotation", "Iris Rotation", -360, 360, 0, 1, "°")], `
  half4 acc = half4(0.0); float wsum = 0.0;
  for (int i = 0; i < 40; i++) {
    float2 o = rot(ring(float(i), 40.0), radians(p[2])) * p[0];
    half4 s = S(xy + o);
    float w = 1.0 + p[1] * lum(float3(s.rgb)) * 4.0;
    acc += s * half(w); wsum += w;
  }
  return acc / half(wsum);`, { outset: (v) => v.radius }),

  kern("ec.stylize.findedges", [P("invert", "Invert", 0, 1, 0), P("blend", "Blend With Original", 0, 100, 0)], `
  float a00 = lum(float3(S(xy + float2(-1, -1)).rgb)), a10 = lum(float3(S(xy + float2(0, -1)).rgb)), a20 = lum(float3(S(xy + float2(1, -1)).rgb));
  float a01 = lum(float3(S(xy + float2(-1, 0)).rgb)), a21 = lum(float3(S(xy + float2(1, 0)).rgb));
  float a02 = lum(float3(S(xy + float2(-1, 1)).rgb)), a12 = lum(float3(S(xy + float2(0, 1)).rgb)), a22 = lum(float3(S(xy + float2(1, 1)).rgb));
  float gx = (a20 + 2.0 * a21 + a22) - (a00 + 2.0 * a01 + a02);
  float gy = (a02 + 2.0 * a12 + a22) - (a00 + 2.0 * a10 + a20);
  float e = clamp(length(float2(gx, gy)), 0.0, 1.0);
  float v = p[0] > 0.5 ? e : 1.0 - e;
  half4 c = S(xy);
  float3 o = mix(float3(v), unp(c), p[1] / 100.0);
  return pre(o, float(c.a));`),

  kern("ec.stylize.emboss", [P("direction", "Direction", -360, 360, 135, 1, "°"), P("relief", "Relief", 0, 10, 1, 0.1), P("contrast", "Contrast", 0, 100, 100), P("blend", "Blend With Original", 0, 100, 0)], `
  float2 d = float2(cos(radians(p[0])), -sin(radians(p[0])));
  half4 c = S(xy);
  float diff = lum(float3(S(xy + d).rgb)) - lum(float3(S(xy - d).rgb));
  float v = clamp(0.5 + diff * p[1] * p[2] / 25.0, 0.0, 1.0);
  float3 o = mix(float3(v), unp(c), p[3] / 100.0);
  return pre(o, float(c.a));`),

  kern("ec.stylize.coloremboss", [P("direction", "Direction", -360, 360, 135, 1, "°"), P("relief", "Relief", 0, 10, 1, 0.1), P("contrast", "Contrast", 0, 100, 100), P("blend", "Blend With Original", 0, 100, 0)], `
  float2 d = float2(cos(radians(p[0])), -sin(radians(p[0])));
  half4 c = S(xy);
  float diff = lum(float3(S(xy + d).rgb)) - lum(float3(S(xy - d).rgb));
  float3 o = clamp(unp(c) + diff * p[1] * p[2] / 25.0, 0.0, 1.0);
  return pre(mix(o, unp(c), p[3] / 100.0), float(c.a));`),

  kern("ec.stylize.posterize", [P("level", "Level", 2, 255, 6)], `
  half4 c = S(xy);
  float n = max(p[0] - 1.0, 1.0);
  float3 u = floor(unp(c) * n + 0.5) / n;
  return pre(u, float(c.a));`),

  kern("ec.stylize.cartoon", [P("steps", "Shading Steps", 2, 16, 5), P("threshold", "Edge Threshold", 0, 1, 0.2, 0.01), P("darkness", "Edge Darkness", 0, 1, 1, 0.01), P("radius", "Detail Radius", 0.5, 20, 1, 0.5)], `
  half4 c = S(xy);
  float r = p[3];
  float a = lum(float3(S(xy + float2(-r, -r)).rgb)), b = lum(float3(S(xy + float2(r, -r)).rgb));
  float d = lum(float3(S(xy + float2(-r, r)).rgb)), e = lum(float3(S(xy + float2(r, r)).rgb));
  float edge = smoothstep(p[1], p[1] + 0.1, length(float2(e - a, d - b)));
  float n = max(p[0] - 1.0, 1.0);
  float3 u = floor(unp(c) * n + 0.5) / n;
  u *= 1.0 - edge * p[2];
  return pre(u, float(c.a));`),

  kern("ec.stylize.ccthreshold", [P("level", "Threshold", 0, 255, 128), P("channel", "Channel (0 Luma, 1 R, 2 G, 3 B, 4 Alpha)", 0, 4, 0)], `
  half4 c = S(xy); float3 u = unp(c);
  float v = p[1] < 0.5 ? lum(u) : p[1] < 1.5 ? u.r : p[1] < 2.5 ? u.g : p[1] < 3.5 ? u.b : float(c.a);
  float o = v * 255.0 >= p[0] ? 1.0 : 0.0;
  return pre(float3(o), float(c.a));`),

  kern("ec.stylize.ccthresholdrgb", [P("red", "Red Threshold", 0, 255, 128), P("green", "Green Threshold", 0, 255, 128), P("blue", "Blue Threshold", 0, 255, 128)], `
  half4 c = S(xy); float3 u = unp(c) * 255.0;
  return pre(float3(u.r >= p[0] ? 1.0 : 0.0, u.g >= p[1] ? 1.0 : 0.0, u.b >= p[2] ? 1.0 : 0.0), float(c.a));`),

  kern("ec.stylize.brushstrokes", [P("angle", "Stroke Angle", -360, 360, 45, 1, "°"), P("length", "Stroke Length", 0, 100, 12, 0.5), P("size", "Brush Size", 0, 20, 2, 0.5), P("random", "Stroke Randomness", 0, 1, 0.5, 0.01)], `
  float2 d = float2(cos(radians(p[0])), sin(radians(p[0])));
  float j = (hash21(floor(xy / max(p[2], 0.5))) - 0.5) * p[3];
  half4 acc = half4(0.0);
  for (int i = 0; i < 12; i++) {
    float t = float(i) / 11.0 - 0.5 + j * 0.5;
    acc += S(xy + d * t * p[1]);
  }
  return acc / 12.0;`, { outset: (v) => v.length }),

  kern("ec.color.cckernel", [
    P("m0", "Row 1, Column 1", -10, 10, 0, 0.1), P("m1", "Row 1, Column 2", -10, 10, 0, 0.1), P("m2", "Row 1, Column 3", -10, 10, 0, 0.1),
    P("m3", "Row 2, Column 1", -10, 10, 0, 0.1), P("m4", "Row 2, Column 2", -10, 10, 1, 0.1), P("m5", "Row 2, Column 3", -10, 10, 0, 0.1),
    P("m6", "Row 3, Column 1", -10, 10, 0, 0.1), P("m7", "Row 3, Column 2", -10, 10, 0, 0.1), P("m8", "Row 3, Column 3", -10, 10, 0, 0.1),
    P("scale", "Scale", 0.1, 20, 1, 0.1), P("offset", "Offset", -1, 1, 0, 0.01),
  ], `
  half4 acc = half4(0.0);
  acc += S(xy + float2(-1, -1)) * half(p[0]); acc += S(xy + float2(0, -1)) * half(p[1]); acc += S(xy + float2(1, -1)) * half(p[2]);
  acc += S(xy + float2(-1, 0)) * half(p[3]);  acc += S(xy) * half(p[4]);                 acc += S(xy + float2(1, 0)) * half(p[5]);
  acc += S(xy + float2(-1, 1)) * half(p[6]);  acc += S(xy + float2(0, 1)) * half(p[7]);  acc += S(xy + float2(1, 1)) * half(p[8]);
  half4 o = acc / half(max(p[9], 0.1)) + half4(half3(p[10]), 0.0) * S(xy).a;
  float a = float(S(xy).a);
  return half4(clamp(o.rgb, half3(0.0), half3(a)), half(a));`),

  kern("ec.noise.median", [P("radius", "Radius", 0.5, 20, 1, 0.5)], `
  float l[9]; half4 s[9];
  for (int y = 0; y < 3; y++) { for (int x = 0; x < 3; x++) {
    half4 c = S(xy + float2(float(x) - 1.0, float(y) - 1.0) * p[0]);
    s[y * 3 + x] = c; l[y * 3 + x] = lum(float3(c.rgb));
  } }
  half4 chosen = s[4]; float bestd = 99.0;
  for (int i = 0; i < 9; i++) {
    float rank = 0.0;
    for (int j = 0; j < 9; j++) { if (l[j] < l[i]) { rank += 1.0; } }
    float d = abs(rank - 4.0);
    if (d < bestd) { bestd = d; chosen = s[i]; }
  }
  return chosen;`, { outset: (v) => v.radius }),

  kern("ec.matte.simplechoker", [P("choke", "Choke Matte", -100, 100, 0, 0.5)], `
  half4 c = S(xy);
  float r = abs(p[0]);
  if (r < 0.01) { return c; }
  float best = p[0] > 0.0 ? 1.0 : float(c.a); half4 pick = c;
  for (int i = 0; i < 16; i++) {
    half4 s = S(xy + ring(float(i), 16.0) * r);
    if (p[0] > 0.0) { best = min(best, float(s.a)); }
    else if (float(s.a) > best) { best = float(s.a); pick = s; }
  }
  if (p[0] > 0.0) { return c.a > 0.0 ? c * half(best / float(c.a)) : c; }
  return pick.a > 0.0 ? half4(pick.rgb * half(best / float(pick.a)), half(best)) : c;`, { outset: (v) => (v.choke < 0 ? -v.choke : 0) }),
];
