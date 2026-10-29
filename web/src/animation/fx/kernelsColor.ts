// Colour, channel, keying and lighting effects that need per-pixel logic a colour matrix cannot
// express (hue tests, local neighbourhoods, alpha from colour).

import type { FxDef } from "@/animation/fx/library";
import { P, kern } from "@/animation/fx/kit";

// picks channel `i` (0 off, 1 alpha, 2 R, 3 G, 4 B, 5 luma, 6 on) without a dynamic index
const sel = (i: string) => `(${i} < 0.5 ? 0.0 : ${i} < 1.5 ? ca : ${i} < 2.5 ? u.r : ${i} < 3.5 ? u.g : ${i} < 4.5 ? u.b : ${i} < 5.5 ? l : 1.0)`;
const HUE = (id: string, label: string, def: number) => P(id, label, 0, 360, def, 1, "°");


export const COLOR_FX: FxDef[] = [
  kern("ec.color.leavecolor", [P("decolor", "Amount to Decolor", 0, 100, 100), HUE("hue", "Color to Leave (hue)", 0), P("tolerance", "Tolerance", 0, 100, 30), P("softness", "Edge Softness", 0, 100, 20)], `
  half4 c = S(xy); float3 u = unp(c); float3 h = rgb2hsv(u);
  float d = hdist(h.x, p[1] / 360.0) * 2.0;
  float keep = 1.0 - smoothstep(p[2] / 100.0, p[2] / 100.0 + p[3] / 100.0 + 0.001, d);
  keep = max(keep, 1.0 - p[0] / 100.0);
  return pre(mix(float3(lum(u)), u, keep), float(c.a));`),

  kern("ec.color.changetocolor", [HUE("from", "From (hue)", 0), HUE("to", "To (hue)", 120), P("tolerance", "Tolerance", 0, 100, 30), P("softness", "Softness", 0, 100, 20), P("saturation", "Saturation Shift", -100, 100, 0)], `
  half4 c = S(xy); float3 u = unp(c); float3 h = rgb2hsv(u);
  float d = hdist(h.x, p[0] / 360.0) * 2.0;
  float m = 1.0 - smoothstep(p[2] / 100.0, p[2] / 100.0 + p[3] / 100.0 + 0.001, d);
  h.x = fract(h.x + m * (p[1] - p[0]) / 360.0);
  h.y = clamp(h.y * (1.0 + m * p[4] / 100.0), 0.0, 1.0);
  return pre(hsv2rgb(h), float(c.a));`),

  kern("ec.color.changecolor", [HUE("match", "Color to Change (hue)", 0), P("hueShift", "Hue Transform", -180, 180, 60, 1, "°"), P("lightness", "Lightness Transform", -100, 100, 0), P("saturation", "Saturation Transform", -100, 100, 0), P("tolerance", "Matching Tolerance", 0, 100, 25), P("softness", "Matching Softness", 0, 100, 20)], `
  half4 c = S(xy); float3 u = unp(c); float3 h = rgb2hsv(u);
  float d = hdist(h.x, p[0] / 360.0) * 2.0;
  float m = 1.0 - smoothstep(p[4] / 100.0, p[4] / 100.0 + p[5] / 100.0 + 0.001, d);
  h.x = fract(h.x + m * p[1] / 360.0);
  h.y = clamp(h.y * (1.0 + m * p[3] / 100.0), 0.0, 1.0);
  h.z = clamp(h.z * (1.0 + m * p[2] / 100.0), 0.0, 1.0);
  return pre(hsv2rgb(h), float(c.a));`),

  kern("ec.color.tritone", [HUE("highlights", "Highlights (hue)", 50), HUE("midtones", "Midtones (hue)", 0), HUE("shadows", "Shadows (hue)", 240), P("saturation", "Saturation", 0, 100, 50), P("blend", "Blend With Original", 0, 100, 0)], `
  half4 c = S(xy); float3 u = unp(c); float L = lum(u);
  float3 hi = hsv2rgb(float3(p[0] / 360.0, p[3] / 100.0, 1.0));
  float3 mid = hsv2rgb(float3(p[1] / 360.0, p[3] / 100.0, 0.7));
  float3 sh = hsv2rgb(float3(p[2] / 360.0, p[3] / 100.0, 0.25));
  float3 t = L < 0.5 ? mix(sh, mid, L * 2.0) : mix(mid, hi, (L - 0.5) * 2.0);
  return pre(mix(t * (0.4 + 0.6 * L) / max(0.4 + 0.6 * L, 0.001), u, p[4] / 100.0), float(c.a));`),

  kern("ec.color.cctoner", [HUE("highlights", "Highlights (hue)", 40), HUE("midtones", "Midtones (hue)", 20), HUE("shadows", "Shadows (hue)", 220), P("blend", "Blend With Original", 0, 100, 0)], `
  half4 c = S(xy); float3 u = unp(c); float L = lum(u);
  float3 hi = hsv2rgb(float3(p[0] / 360.0, 0.5, 1.0));
  float3 mid = hsv2rgb(float3(p[1] / 360.0, 0.5, 0.7));
  float3 sh = hsv2rgb(float3(p[2] / 360.0, 0.5, 0.3));
  float3 t = L < 0.5 ? mix(sh, mid, L * 2.0) : mix(mid, hi, (L - 0.5) * 2.0);
  return pre(mix(t, u, p[3] / 100.0), float(c.a));`),

  kern("ec.color.colorbalancehls", [P("hue", "Hue", -180, 180, 0, 1, "°"), P("lightness", "Lightness", -100, 100, 0), P("saturation", "Saturation", -100, 100, 0)], `
  half4 c = S(xy); float3 h = rgb2hsv(unp(c));
  h.x = fract(h.x + p[0] / 360.0 + 1.0);
  h.z = clamp(h.z + p[1] / 100.0, 0.0, 1.0);
  h.y = clamp(h.y * (1.0 + p[2] / 100.0), 0.0, 1.0);
  return pre(hsv2rgb(h), float(c.a));`),

  kern("ec.color.shadowhighlight", [P("shadows", "Shadow Amount", 0, 100, 50), P("highlights", "Highlight Amount", 0, 100, 0), P("radius", "Radius", 1, 300, 30)], `
  half4 c = S(xy); float3 u = unp(c);
  float local = 0.0;
  for (int i = 0; i < 16; i++) { float a = float(i) * 0.39269908; local += lum(unp(S(xy + p[2] * float2(cos(a), sin(a))))); }
  local /= 16.0;
  float lift = (1.0 - local) * (1.0 - local) * p[0] / 100.0;
  float comp = local * local * p[1] / 100.0;
  float3 o = u + (1.0 - u) * lift * 0.6 - u * comp * 0.5;
  return pre(clamp(o, 0.0, 1.0), float(c.a));`, { outset: () => 0 }),

  kern("ec.color.broadcast", [P("max", "Maximum Signal Amplitude", 50, 100, 100)], `
  half4 c = S(xy); float3 u = min(unp(c), p[0] / 100.0);
  return pre(u, float(c.a));`),

  // Channel
  kern("ec.channel.shiftchannels", [
    P("alpha", "Take Alpha From (0 Full Off, 1 Alpha, 2 Red, 3 Green, 4 Blue, 5 Luminance, 6 Full On)", 0, 6, 1),
    P("red", "Take Red From", 0, 6, 2), P("green", "Take Green From", 0, 6, 3), P("blue", "Take Blue From", 0, 6, 4),
  ], `
  half4 c = S(xy); float3 u = unp(c);
  float ca = float(c.a), l = lum(u);
  float a = ${sel("p[0]")}; float r = ${sel("p[1]")}; float g = ${sel("p[2]")}; float b = ${sel("p[3]")};
  return pre(float3(r, g, b), a);`),

  kern("ec.channel.solidcomposite", [P("sourceOpacity", "Source Opacity", 0, 100, 100), HUE("hue", "Color (hue)", 0), P("saturation", "Color Saturation", 0, 100, 0), P("value", "Color Brightness", 0, 100, 0), P("opacity", "Opacity", 0, 100, 100)], `
  half4 c = S(xy) * half(p[0] / 100.0);
  float3 bg = hsv2rgb(float3(p[1] / 360.0, p[2] / 100.0, p[3] / 100.0));
  half4 b = half4(half3(bg), 1.0) * half(p[4] / 100.0);
  return c + b * (1.0 - c.a);`),

  // Lighting
  kern("ec.perspective.dropshadow", [
    P("color", "Shadow Color (brightness)", 0, 100, 0), P("opacity", "Opacity", 0, 100, 50), P("direction", "Direction", -360, 360, 135, 1, "°"),
    P("distance", "Distance", 0, 1000, 8, 0.5), P("softness", "Softness", 0, 250, 6, 0.5), P("shadowOnly", "Shadow Only", 0, 1, 0),
  ], `
  float2 d = float2(sin(radians(p[2])), -cos(radians(p[2]))) * p[3];
  float a = 0.0;
  for (int i = 0; i < 24; i++) { a += float(S(xy - d + ring(float(i), 24.0) * p[4]).a); }
  a = a / 24.0 * p[1] / 100.0;
  half4 c = S(xy);
  half4 sh = half4(half3(p[0] / 100.0) * half(a), half(a));
  return p[5] > 0.5 ? sh : c + sh * (1.0 - c.a);`, { outset: (v) => v.distance + v.softness }),

  kern("ec.perspective.bevelalpha", [P("thickness", "Edge Thickness", 0.5, 100, 4, 0.5), P("angle", "Light Angle", -360, 360, -45, 1, "°"), P("intensity", "Light Intensity", 0, 1, 0.5, 0.01), HUE("hue", "Light Color (hue)", 0)], `
  float2 L = float2(sin(radians(p[1])), -cos(radians(p[1])));
  float a1 = float(S(xy + L * p[0]).a), a2 = float(S(xy - L * p[0]).a);
  half4 c = S(xy);
  float k = (a2 - a1) * p[2];
  float3 lc = p[3] == 0.0 ? float3(1.0) : hsv2rgb(float3(p[3] / 360.0, 0.4, 1.0));
  float3 o = unp(c) + (k > 0.0 ? lc * k : float3(k));
  return pre(clamp(o, 0.0, 1.0), float(c.a));`),

  kern("ec.perspective.beveledges", [P("thickness", "Edge Thickness", 0.5, 100, 4, 0.5), P("angle", "Light Angle", -360, 360, -45, 1, "°"), P("intensity", "Light Intensity", 0, 1, 0.5, 0.01), HUE("hue", "Light Color (hue)", 0)], `
  float2 L = float2(sin(radians(p[1])), -cos(radians(p[1])));
  float a1 = float(S(xy + L * p[0]).a), a2 = float(S(xy - L * p[0]).a);
  half4 c = S(xy);
  float k = (a2 - a1) * p[2] * 1.5;
  float3 o = unp(c) + k;
  return pre(clamp(o, 0.0, 1.0), float(c.a));`),

  // Keying: colour -> alpha
  kern("ec.key.linearcolor", [HUE("hue", "Key Color (hue)", 120), P("saturation", "Key Saturation", 0, 100, 100), P("value", "Key Brightness", 0, 100, 100), P("tolerance", "Matching Tolerance", 0, 100, 30), P("softness", "Matching Softness", 0, 100, 20), P("keep", "Key Operation (0 Key, 1 Keep)", 0, 1, 0)], `
  half4 c = S(xy); float3 u = unp(c);
  float3 k = hsv2rgb(float3(p[0] / 360.0, p[1] / 100.0, p[2] / 100.0));
  float d = length(u - k) / 1.7320508;
  float m = smoothstep(p[3] / 100.0, p[3] / 100.0 + p[4] / 100.0 + 0.001, d);
  if (p[5] > 0.5) { m = 1.0 - m; }
  return pre(u, float(c.a) * m);`),

  kern("ec.key.extract", [P("black", "Black Point", 0, 255, 0), P("white", "White Point", 0, 255, 255), P("softness", "Black Softness", 0, 255, 0), P("invert", "Invert", 0, 1, 0)], `
  half4 c = S(xy); float3 u = unp(c);
  float l = lum(u) * 255.0;
  float m = smoothstep(p[0] - p[2] * 0.5 - 0.001, max(p[1], p[0] + 1.0), l);
  if (p[3] > 0.5) { m = 1.0 - m; }
  return pre(u, float(c.a) * m);`),

  kern("ec.key.unmult", [P("amount", "Amount", 0, 100, 100)], `
  half4 c = S(xy); float3 u = unp(c);
  float a = max(max(u.r, u.g), u.b);
  half4 o = a > 0.0 ? pre(u / a, float(c.a) * a) : half4(0.0);
  return mix(c, o, half(p[0] / 100.0));`),

  kern("ec.key.advancedspill", [HUE("hue", "Key Color (hue)", 120), P("tolerance", "Tolerance", 0, 100, 40), P("amount", "Suppression", 0, 100, 100)], `
  half4 c = S(xy); float3 u = unp(c); float3 h = rgb2hsv(u);
  float m = (1.0 - smoothstep(p[1] / 100.0 * 0.5, p[1] / 100.0 * 0.5 + 0.1, hdist(h.x, p[0] / 360.0))) * h.y * p[2] / 100.0;
  h.y *= 1.0 - m;
  return pre(hsv2rgb(h), float(c.a));`),

  // Noise on colour / alpha
  kern("ec.noise.noisealpha", [P("amount", "Amount", 0, 100, 25), P("seed", "Seed", 0, 1000, 1), P("mode", "Noise (0 Multiply, 1 Add)", 0, 1, 0)], `
  half4 c = S(xy);
  float n = hash21(floor(xy) + p[1]);
  float a = p[2] < 0.5 ? float(c.a) * (1.0 - n * p[0] / 100.0) : clamp(float(c.a) + n * p[0] / 100.0, 0.0, 1.0);
  return pre(unp(c), a);`),

  kern("ec.noise.noisehls", [P("hue", "Hue", 0, 100, 0), P("lightness", "Lightness", 0, 100, 10), P("saturation", "Saturation", 0, 100, 0), P("seed", "Seed", 0, 1000, 1)], `
  half4 c = S(xy); float3 h = rgb2hsv(unp(c));
  float3 n = float3(hash21(floor(xy) + p[3]), hash21(floor(xy) + p[3] + 11.0), hash21(floor(xy) + p[3] + 23.0)) - 0.5;
  h.x = fract(h.x + n.x * p[0] / 100.0 + 1.0);
  h.z = clamp(h.z + n.y * p[1] / 50.0, 0.0, 1.0);
  h.y = clamp(h.y + n.z * p[2] / 50.0, 0.0, 1.0);
  return pre(hsv2rgb(h), float(c.a));`),

  kern("ec.noise.noisehlsauto", [P("hue", "Hue", 0, 100, 0), P("lightness", "Lightness", 0, 100, 10), P("saturation", "Saturation", 0, 100, 0), P("speed", "Noise Animation Speed", -3600, 3600, 0, 1, "°")], `
  half4 c = S(xy); float3 h = rgb2hsv(unp(c));
  float t = floor(radians(p[3]) * 3.0);
  float3 n = float3(hash21(floor(xy) + t), hash21(floor(xy) + t + 11.0), hash21(floor(xy) + t + 23.0)) - 0.5;
  h.x = fract(h.x + n.x * p[0] / 100.0 + 1.0);
  h.z = clamp(h.z + n.y * p[1] / 50.0, 0.0, 1.0);
  h.y = clamp(h.y + n.z * p[2] / 50.0, 0.0, 1.0);
  return pre(hsv2rgb(h), float(c.a));`),

  // Transition that reads the node
  kern("ec.transition.gradientwipe", [P("completion", "Transition Completion", 0, 100, 50), P("softness", "Transition Softness", 0, 100, 10), P("invert", "Invert Gradient", 0, 1, 0)], `
  half4 c = S(xy);
  float L = lum(unp(c)); if (p[2] > 0.5) { L = 1.0 - L; }
  float t = p[0] / 100.0 * (1.0 + p[1] / 100.0) - p[1] / 100.0;
  float m = smoothstep(t, t + p[1] / 100.0 + 0.001, L);
  m = p[0] <= 0.0 ? 1.0 : m;
  return c * half(m);`),

  kern("ec.transition.cctwister", [P("completion", "Completion", 0, 100, 50), P("axis", "Twist Axis (0 Vertical, 1 Horizontal)", 0, 1, 0), P("twists", "Twists", 0.25, 4, 1, 0.25)], `
  float2 u = uv(xy) - 0.5;
  float e = p[0] / 100.0;
  float s = p[1] < 0.5 ? u.y : u.x;
  float ang = e * PI * p[2] * (s + 0.5) * 2.0;
  float k = cos(ang);
  float2 q = p[1] < 0.5 ? float2(u.x / (abs(k) < 0.02 ? 0.02 : k), u.y) : float2(u.x, u.y / (abs(k) < 0.02 ? 0.02 : k));
  if (abs(q.x) > 0.5 || abs(q.y) > 0.5) { return half4(0.0); }
  return S(box.xy + (q + 0.5) * box.zw);`),

  kern("ec.generate.eyedropperfill", [P("x", "Sample Point X", 0, 100, 50, 0.5, "%"), P("y", "Sample Point Y", 0, 100, 50, 0.5, "%"), P("radius", "Sample Radius", 0, 50, 2), P("opacity", "Blend With Original", 0, 100, 100)], `
  half4 c = S(xy);
  float2 pt = box.xy + box.zw * float2(p[0], p[1]) / 100.0;
  half4 acc = half4(0.0);
  for (int i = 0; i < 9; i++) { acc += S(pt + (float2(mod(float(i), 3.0), floor(float(i) / 3.0)) - 1.0) * p[2]); }
  acc /= 9.0;
  float3 f = unp(acc);
  return pre(mix(unp(c), f, p[3] / 100.0), float(c.a));`),

  kern("ec.generate.cclightrays", [P("intensity", "Intensity", 0, 300, 100), P("centerX", "Center X", -100, 200, 50, 0.5, "%"), P("centerY", "Center Y", -100, 200, 50, 0.5, "%"), P("radius", "Radius", 0, 500, 50), P("threshold", "Threshold", 0, 100, 40)], `
  float2 c = box.xy + box.zw * float2(p[1], p[2]) / 100.0;
  float2 q = xy - c;
  half4 acc = half4(0.0);
  for (int i = 0; i < 24; i++) {
    float t = float(i) / 23.0;
    half4 s = S(c + q * (1.0 - t * p[3] / 100.0));
    float l = lum(float3(s.rgb));
    acc += s * half(max(l - p[4] / 100.0, 0.0) * (1.0 - t));
  }
  half4 base = S(xy);
  half4 add = acc * half(p[0] / 100.0 / 6.0);
  return half4(base.rgb + add.rgb, clamp(base.a + add.a * 0.5, 0.0, 1.0));`),

  kern("ec.generate.cclightburst", [P("intensity", "Intensity", 0, 300, 100), P("centerX", "Center X", -100, 200, 50, 0.5, "%"), P("centerY", "Center Y", -100, 200, 50, 0.5, "%"), P("rayLength", "Ray Length", 0, 100, 60), P("threshold", "Threshold", 0, 100, 30)], `
  float2 c = box.xy + box.zw * float2(p[1], p[2]) / 100.0;
  float2 q = xy - c;
  half4 acc = half4(0.0);
  for (int i = 0; i < 24; i++) {
    float t = float(i) / 23.0;
    half4 s = S(c + q * (1.0 - t * p[3] / 100.0));
    acc += s * half(max(lum(float3(s.rgb)) - p[4] / 100.0, 0.0));
  }
  half4 base = S(xy);
  half4 add = acc * half(p[0] / 100.0 / 8.0);
  return half4(base.rgb + add.rgb, clamp(base.a + add.a * 0.5, 0.0, 1.0));`),
];
