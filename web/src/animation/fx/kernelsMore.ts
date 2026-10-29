// More colour, channel, keying, utility and blur effects (see kit.ts).

import type { FxDef } from "@/animation/fx/library";
import { P, kern, time } from "@/animation/fx/kit";

const HUE = (id: string, label: string, def: number) => P(id, label, 0, 360, def, 1, "°");

export const MORE_FX: FxDef[] = [
  // Keying -------------------------------------------------------------------------------------------
  kern("ec.key.colorkey", [HUE("hue", "Key Color (hue)", 120), P("sat", "Key Saturation", 0, 100, 100), P("val", "Key Brightness", 0, 100, 100), P("tolerance", "Color Tolerance", 0, 255, 60), P("thin", "Edge Thin", -10, 10, 0), P("feather", "Edge Feather", 0, 50, 0)], `
  half4 c = S(xy); float3 u = unp(c);
  float3 k = hsv2rgb(float3(p[0] / 360.0, p[1] / 100.0, p[2] / 100.0));
  float d = length(u - k) * 255.0 / 1.7320508;
  float f = max(p[5], 0.001) * 2.0;
  float m = smoothstep(p[3] + p[4] * 4.0 - f, p[3] + p[4] * 4.0 + f, d);
  return pre(u, float(c.a) * m);`),

  kern("ec.key.luma", [P("type", "Key Type (0 Key Out Brighter, 1 Key Out Darker, 2 Key Out Similar, 3 Key Out Dissimilar)", 0, 3, 1), P("threshold", "Threshold", 0, 255, 128), P("tolerance", "Tolerance", 0, 255, 40), P("feather", "Edge Feather", 0, 50, 0)], `
  half4 c = S(xy); float3 u = unp(c);
  float l = lum(u) * 255.0;
  float f = max(p[3], 0.001) * 2.0;
  float m;
  if (p[0] < 0.5) { m = 1.0 - smoothstep(p[1] - f, p[1] + f, l); }
  else if (p[0] < 1.5) { m = smoothstep(p[1] - f, p[1] + f, l); }
  else if (p[0] < 2.5) { m = smoothstep(p[2] - f, p[2] + f + 0.001, abs(l - p[1])); }
  else { m = 1.0 - smoothstep(p[2] - f, p[2] + f + 0.001, abs(l - p[1])); }
  return pre(u, float(c.a) * m);`),

  kern("ec.key.colorrange", [P("hueMin", "Hue Min", 0, 360, 80, 1, "°"), P("hueMax", "Hue Max", 0, 360, 160, 1, "°"), P("satMin", "Saturation Min", 0, 100, 25), P("satMax", "Saturation Max", 0, 100, 100), P("valMin", "Brightness Min", 0, 100, 10), P("valMax", "Brightness Max", 0, 100, 100), P("soft", "Softness", 0, 100, 10), P("invert", "Keep Inside", 0, 1, 0)], `
  half4 c = S(xy); float3 u = unp(c); float3 h = rgb2hsv(u);
  float s = max(p[6] / 100.0, 0.001) * 0.2;
  float hd = h.x * 360.0;
  float hm = smoothstep(p[0] - s * 360.0, p[0], hd) * (1.0 - smoothstep(p[1], p[1] + s * 360.0, hd));
  float sm = smoothstep(p[2] / 100.0 - s, p[2] / 100.0, h.y) * (1.0 - smoothstep(p[3] / 100.0, p[3] / 100.0 + s, h.y));
  float vm = smoothstep(p[4] / 100.0 - s, p[4] / 100.0, h.z) * (1.0 - smoothstep(p[5] / 100.0, p[5] / 100.0 + s, h.z));
  float inside = hm * sm * vm;
  float m = p[7] > 0.5 ? inside : 1.0 - inside;
  return pre(u, float(c.a) * m);`),

  kern("ec.key.colordifference", [HUE("hue", "Key Color (hue)", 120), P("white", "Alpha White In", 0, 100, 100), P("black", "Alpha Black In", 0, 100, 10), P("gamma", "Alpha Gamma", 0.1, 4, 1, 0.05)], `
  half4 c = S(xy); float3 u = unp(c);
  // rotate hues so the key colour is green, then the classic difference matte: g - max(r, b)
  float3 h = rgb2hsv(u);
  float3 r = hsv2rgb(float3(fract(h.x + (120.0 - p[0]) / 360.0), h.y, h.z));
  float diff = clamp(r.g - max(r.r, r.b), 0.0, 1.0);
  float a = 1.0 - clamp((diff - p[2] / 100.0) / max(p[1] / 100.0 - p[2] / 100.0, 0.001), 0.0, 1.0);
  a = pow(a, 1.0 / p[3]);
  return pre(u, float(c.a) * a);`),

  // Blur ---------------------------------------------------------------------------------------------
  kern("ec.blur.compound", [P("maxBlur", "Maximum Blur", 0, 100, 20, 0.5), P("invert", "Invert Blur", 0, 1, 0)], `
  // the node's own luminance is the blur map
  float l = lum(float3(S(xy).rgb)); if (p[1] > 0.5) { l = 1.0 - l; }
  float r = p[0] * l;
  half4 acc = half4(0.0);
  for (int i = 0; i < 20; i++) { acc += S(xy + ring(float(i), 20.0) * r); }
  return acc / 20.0;`, { outset: (v) => v.maxBlur }),

  kern("ec.blur.ccvector", [P("amount", "Amount", 0, 200, 20, 0.5), P("angle", "Angle Offset", -360, 360, 0, 1, "°"), P("smooth", "Ridge Smoothness", 0.5, 20, 2, 0.5)], `
  float s = p[2];
  float gx = lum(float3(S(xy + float2(s, 0)).rgb)) - lum(float3(S(xy - float2(s, 0)).rgb));
  float gy = lum(float3(S(xy + float2(0, s)).rgb)) - lum(float3(S(xy - float2(0, s)).rgb));
  float2 d = rot(normalize(float2(gx, gy) + 1e-5), radians(p[1] + 90.0)) * p[0];
  half4 acc = half4(0.0);
  for (int i = 0; i < 16; i++) { acc += S(xy + d * (float(i) / 15.0 - 0.5)); }
  return acc / 16.0;`, { outset: (v) => v.amount }),

  kern("ec.noise.dustscratches", [P("radius", "Radius", 0.5, 20, 2, 0.5), P("threshold", "Threshold", 0, 255, 30)], `
  half4 c = S(xy);
  half4 b = half4(0.0);
  for (int i = 0; i < 12; i++) { b += S(xy + ring(float(i), 12.0) * p[0]); }
  b /= 12.0;
  return abs(lum(float3(c.rgb)) - lum(float3(b.rgb))) * 255.0 > p[1] ? b : c;`),

  time("ec.blur.reduceflicker", [P("strength", "Strength", 0, 1, 0.5, 0.01), P("fps", "Frame Rate", 1, 120, 30)], (v) => ({
    samples: [{ dt: -1000 / v.fps, weight: v.strength / 2 }, { dt: 0, weight: 1 - v.strength / 2 }], mode: "plus",
  })),

  // Channel ------------------------------------------------------------------------------------------
  kern("ec.channel.arithmetic", [P("operator", "Operator (0 Add, 1 Subtract, 2 Multiply, 3 Difference, 4 Min, 5 Max, 6 Screen, 7 Inverse Difference)", 0, 7, 0), P("red", "Red Value", 0, 255, 0), P("green", "Green Value", 0, 255, 0), P("blue", "Blue Value", 0, 255, 0), P("clip", "Clip Result Values", 0, 1, 1)], `
  half4 c = S(xy); float3 u = unp(c); float3 v = float3(p[1], p[2], p[3]) / 255.0;
  float3 o;
  if (p[0] < 0.5) { o = u + v; } else if (p[0] < 1.5) { o = u - v; } else if (p[0] < 2.5) { o = u * v; }
  else if (p[0] < 3.5) { o = abs(u - v); } else if (p[0] < 4.5) { o = min(u, v); } else if (p[0] < 5.5) { o = max(u, v); }
  else if (p[0] < 6.5) { o = 1.0 - (1.0 - u) * (1.0 - v); } else { o = 1.0 - abs(u - v); }
  if (p[4] > 0.5) { o = clamp(o, 0.0, 1.0); }
  return pre(o, float(c.a));`),

  kern("ec.channel.removecolormatting", [HUE("hue", "Matting Color (hue)", 0), P("brightness", "Matting Brightness", 0, 100, 0)], `
  half4 c = S(xy);
  float3 bg = hsv2rgb(float3(p[0] / 360.0, p[1] > 0.0 ? 0.5 : 0.0, p[1] / 100.0));
  float a = float(c.a);
  float3 u = a > 0.0 ? clamp((float3(c.rgb) - bg * (1.0 - a)) / a, 0.0, 1.0) : float3(0.0);
  return pre(u, a);`),

  kern("ec.channel.combiner", [P("conversion", "Conversion (0 None, 1 RGB to HLS, 2 HLS to RGB, 3 RGB to YUV, 4 YUV to RGB)", 0, 4, 1)], `
  half4 c = S(xy); float3 u = unp(c); float3 o = u;
  if (p[0] > 0.5 && p[0] < 1.5) { float3 h = rgb2hsv(u); o = float3(h.x, h.z * (1.0 - h.y * 0.5), h.y); }
  else if (p[0] > 1.5 && p[0] < 2.5) { float l = u.y; float s = u.z; float v = l / max(1.0 - s * 0.5, 0.0001); o = hsv2rgb(float3(u.x, s, clamp(v, 0.0, 1.0))); }
  else if (p[0] > 2.5 && p[0] < 3.5) { float y = lum(u); o = float3(y, 0.5 + (u.b - y) * 0.565, 0.5 + (u.r - y) * 0.713); }
  else if (p[0] > 3.5) { float y = u.x; float cb = u.y - 0.5, cr = u.z - 0.5; o = float3(y + 1.403 * cr, y - 0.344 * cb - 0.714 * cr, y + 1.770 * cb); }
  return pre(clamp(o, 0.0, 1.0), float(c.a));`),

  // Colour -------------------------------------------------------------------------------------------
  kern("ec.color.cccoloroffset", [P("red", "Red Phase", -360, 360, 0, 1, "°"), P("green", "Green Phase", -360, 360, 0, 1, "°"), P("blue", "Blue Phase", -360, 360, 0, 1, "°"), P("overflow", "Overflow (0 Wrap, 1 Clip)", 0, 1, 0)], `
  half4 c = S(xy); float3 u = unp(c);
  float3 ph = float3(p[0], p[1], p[2]) / 360.0;
  float3 o = u + ph;
  // wrapping: a channel with no offset is left alone (1.0 must not wrap to 0.0)
  float3 wrapped = fract(o + 1.0);
  o = p[3] > 0.5 ? clamp(o, 0.0, 1.0) : float3(abs(ph.x) < 1e-5 ? u.x : wrapped.x, abs(ph.y) < 1e-5 ? u.y : wrapped.y, abs(ph.z) < 1e-5 ? u.z : wrapped.z);
  return pre(o, float(c.a));`),

  kern("ec.color.levelsic", [
    P("rIn", "Red Input Black", 0, 255, 0), P("rW", "Red Input White", 0, 255, 255), P("rG", "Red Gamma", 0.1, 10, 1, 0.01),
    P("gIn", "Green Input Black", 0, 255, 0), P("gW", "Green Input White", 0, 255, 255), P("gG", "Green Gamma", 0.1, 10, 1, 0.01),
    P("bIn", "Blue Input Black", 0, 255, 0), P("bW", "Blue Input White", 0, 255, 255), P("bG", "Blue Gamma", 0.1, 10, 1, 0.01),
    P("outBlack", "Output Black", 0, 255, 0), P("outWhite", "Output White", 0, 255, 255),
  ], `
  half4 c = S(xy); float3 u = unp(c) * 255.0;
  float3 lo = float3(p[0], p[3], p[6]), hi = float3(p[1], p[4], p[7]), g = float3(p[2], p[5], p[8]);
  float3 t = clamp((u - lo) / max(hi - lo, float3(1.0)), 0.0, 1.0);
  t = pow(t, 1.0 / g);
  return pre(mix(float3(p[9]), float3(p[10]), t) / 255.0, float(c.a));`),

  kern("ec.color.colorama", [P("phase", "Phase", -3600, 3600, 0, 1, "°"), P("cycles", "Cycles", 0.1, 10, 1, 0.05), HUE("hueA", "Palette Start (hue)", 0), HUE("hueB", "Palette End (hue)", 300), P("sat", "Saturation", 0, 100, 80), P("blend", "Blend With Original", 0, 100, 0)], `
  half4 c = S(xy); float3 u = unp(c);
  float t = fract(lum(u) * p[1] + p[0] / 360.0);
  float3 pal = hsv2rgb(float3(mix(p[2], p[3], t) / 360.0, p[4] / 100.0, 1.0));
  return pre(mix(pal, u, p[5] / 100.0), float(c.a));`),

  kern("ec.color.selectivecolor", [
    P("colors", "Colors (0 Reds, 1 Yellows, 2 Greens, 3 Cyans, 4 Blues, 5 Magentas, 6 Whites, 7 Neutrals, 8 Blacks)", 0, 8, 0),
    P("cyan", "Cyan", -100, 100, 0), P("magenta", "Magenta", -100, 100, 0), P("yellow", "Yellow", -100, 100, 0), P("black", "Black", -100, 100, 0), P("absolute", "Method (0 Relative, 1 Absolute)", 0, 1, 0),
  ], `
  half4 c = S(xy); float3 u = unp(c); float3 h = rgb2hsv(u);
  float g = floor(p[0] + 0.5);
  float member;
  if (g < 5.5) { float center = g * 60.0 / 360.0; member = (1.0 - smoothstep(0.0, 1.0 / 6.0, hdist(h.x, center))) * h.y * h.z; }
  else if (g < 6.5) { member = smoothstep(0.7, 1.0, h.z) * (1.0 - h.y); }
  else if (g < 7.5) { member = (1.0 - abs(h.z - 0.5) * 2.0) * (1.0 - h.y); }
  else { member = (1.0 - smoothstep(0.0, 0.3, h.z)); }
  float k = p[5] > 0.5 ? 1.0 : (1.0 - h.z * 0.5);
  float3 cmy = 1.0 - u;
  cmy += float3(p[1], p[2], p[3]) / 100.0 * member * k;
  float3 o = 1.0 - cmy;
  o *= 1.0 - clamp(p[4] / 100.0 * member * k, -1.0, 1.0) * 0.6;
  return pre(clamp(o, 0.0, 1.0), float(c.a));`),

  kern("ec.color.videolimiter", [P("min", "Minimum Signal (IRE)", 0, 100, 0), P("max", "Maximum Signal (IRE)", 0, 100, 100), P("method", "Method (0 Clamp Luma, 1 Scale)", 0, 1, 0)], `
  half4 c = S(xy); float3 u = unp(c); float l = lum(u);
  float3 o;
  if (p[2] < 0.5) { float nl = clamp(l, p[0] / 100.0, p[1] / 100.0); o = l > 0.0 ? u * (nl / l) : float3(nl); }
  else { o = mix(float3(p[0] / 100.0), float3(p[1] / 100.0), u); }
  return pre(clamp(o, 0.0, 1.0), float(c.a));`),

  kern("ec.utility.colorprofileconverter", [P("from", "Input Profile (0 sRGB, 1 Linear, 2 Gamma 2.2, 3 Rec.709, 4 Gamma 2.4)", 0, 4, 0), P("to", "Output Profile", 0, 4, 1)], `
  half4 c = S(xy); float3 u = unp(c);
  float3 lin;
  if (p[0] < 0.5) { lin = mix(u / 12.92, pow((u + 0.055) / 1.055, float3(2.4)), step(0.04045, u)); }
  else if (p[0] < 1.5) { lin = u; } else if (p[0] < 2.5) { lin = pow(u, float3(2.2)); }
  else if (p[0] < 3.5) { lin = mix(u / 4.5, pow((u + 0.099) / 1.099, float3(1.0 / 0.45)), step(0.081, u)); }
  else { lin = pow(u, float3(2.4)); }
  float3 o;
  if (p[1] < 0.5) { o = mix(lin * 12.92, 1.055 * pow(lin, float3(1.0 / 2.4)) - 0.055, step(0.0031308, lin)); }
  else if (p[1] < 1.5) { o = lin; } else if (p[1] < 2.5) { o = pow(lin, float3(1.0 / 2.2)); }
  else if (p[1] < 3.5) { o = mix(lin * 4.5, 1.099 * pow(lin, float3(0.45)) - 0.099, step(0.018, lin)); }
  else { o = pow(lin, float3(1.0 / 2.4)); }
  return pre(clamp(o, 0.0, 1.0), float(c.a));`),

  kern("ec.utility.cineon", [P("conversion", "Conversion (0 Log to Linear, 1 Linear to Log)", 0, 1, 0), P("black", "10 Bit Black Point", 0, 1023, 95), P("white", "10 Bit White Point", 0, 1023, 685), P("gamma", "Gamma", 0.1, 4, 1, 0.01)], `
  half4 c = S(xy); float3 u = unp(c);
  float bp = p[1] / 1023.0, wp = p[2] / 1023.0;
  float3 o;
  if (p[0] < 0.5) { o = (pow(float3(10.0), (u * 1023.0 - p[2]) * 0.002 / p[3]) - pow(10.0, (p[1] - p[2]) * 0.002 / p[3])) / (1.0 - pow(10.0, (p[1] - p[2]) * 0.002 / p[3])); }
  else { o = clamp((log(max(u, float3(1e-4))) / log(10.0) * p[3] / 0.002 + p[2]) / 1023.0, 0.0, 1.0); }
  return pre(clamp(o, 0.0, 1.0), float(c.a));`),

  kern("ec.utility.hdrcompander", [P("gain", "Gain", 0.1, 8, 1, 0.05), P("mode", "Mode (0 Compress, 1 Expand)", 0, 1, 0), P("amount", "Amount", 0, 100, 50)], `
  half4 c = S(xy); float3 u = unp(c) * p[0];
  float k = p[2] / 100.0;
  float3 o = p[1] < 0.5 ? u / (1.0 + u * k) * (1.0 + k) : u / max(1.0 + k - u * k, 0.05);
  return pre(clamp(o, 0.0, 1.0), float(c.a));`),

  kern("ec.utility.hdrcompression", [P("amount", "Amount", 0, 100, 50)], `
  half4 c = S(xy); float3 u = unp(c);
  float k = p[0] / 100.0;
  float3 o = mix(u, 1.0 - exp(-u * 2.0), k * smoothstep(0.5, 1.0, u));
  return pre(clamp(o, 0.0, 1.0), float(c.a));`),

  kern("ec.utility.ccoverbrights", [P("method", "Method (0 Reflect, 1 Clip)", 0, 1, 0), P("threshold", "Threshold", 0, 100, 90)], `
  half4 c = S(xy); float3 u = unp(c);
  float t = p[1] / 100.0;
  float3 o = p[0] < 0.5 ? mix(u, t - (u - t) * 0.5, step(t, u)) : min(u, float3(t));
  return pre(clamp(o, 0.0, 1.0), float(c.a));`),
];
