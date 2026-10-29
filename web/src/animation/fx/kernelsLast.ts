// The effects that were left: where EffectCraft's version needs data this editor does not have (a depth or ID render pass,
// another layer, a drawn mask, a brush path), these work on the node's OWN pixels instead and say so in the label:
//   - the 3D-channel effects treat the node's luminance as depth and its colours as IDs;
//   - the stroke/outline effects follow the node's alpha edge;
//   - the keyers and fills work from a colour or point picked with parameters.
// See kit.ts.

import type { FxDef } from "@/animation/fx/library";
import { P, kern, over } from "@/animation/fx/kit";

const HUE = (id: string, label: string, def: number) => P(id, label, 0, 360, def, 1, "°");
const CX = P("centerX", "Center X", -100, 200, 50, 0.5, "%");
const CY = P("centerY", "Center Y", -100, 200, 50, 0.5, "%");

export const LAST_FX: FxDef[] = [
  // 3D channel effects, on the node's own luminance (depth) and colours (IDs) ----------------------------
  kern("ec.3d.channelextract", [P("channel", "Channel (0 Luminance, 1 Red, 2 Green, 3 Blue, 4 Alpha, 5 Depth, 6 Hue)", 0, 6, 5), P("black", "Black Point", 0, 1, 0, 0.01), P("white", "White Point", 0, 1, 1, 0.01), P("invert", "Invert", 0, 1, 0), P("gamma", "Gamma", 0.1, 4, 1, 0.05), P("alpha", "Keep Alpha", 0, 1, 1)], `
  half4 c = S(xy); float3 u = unp(c);
  float v = p[0] < 0.5 ? lum(u) : p[0] < 1.5 ? u.r : p[0] < 2.5 ? u.g : p[0] < 3.5 ? u.b : p[0] < 4.5 ? float(c.a) : p[0] < 5.5 ? 1.0 - lum(u) : rgb2hsv(u).x;
  v = pow(clamp((v - p[1]) / max(p[2] - p[1], 0.001), 0.0, 1.0), 1.0 / p[4]);
  if (p[3] > 0.5) { v = 1.0 - v; }
  return pre(float3(v), p[5] > 0.5 ? float(c.a) : 1.0);`),

  kern("ec.3d.extractor", [P("channel", "Channel (0 Luminance, 1 Red, 2 Green, 3 Blue, 4 Alpha)", 0, 4, 0), P("black", "Black", 0, 1, 0, 0.01), P("white", "White", 0, 1, 1, 0.01), P("softness", "Softness", 0, 1, 0, 0.01), P("invert", "Invert", 0, 1, 0), P("convert", "Convert to Luminance", 0, 1, 1), P("gamma", "Gamma", 0.1, 4, 1, 0.05), P("alpha", "Keep Alpha", 0, 1, 1)], `
  half4 c = S(xy); float3 u = unp(c);
  float v = p[0] < 0.5 ? lum(u) : p[0] < 1.5 ? u.r : p[0] < 2.5 ? u.g : p[0] < 3.5 ? u.b : float(c.a);
  v = smoothstep(p[1] - p[3] * 0.5, p[2] + p[3] * 0.5 + 0.001, v);
  v = pow(v, 1.0 / p[6]);
  if (p[4] > 0.5) { v = 1.0 - v; }
  float3 o = p[5] > 0.5 ? float3(v) : mix(u, float3(v), 0.0) * v;
  return pre(o, p[7] > 0.5 ? float(c.a) : 1.0);`),

  kern("ec.3d.depthmatte", [P("depth", "Depth (0 near, 1 far)", 0, 1, 0.5, 0.01), P("feather", "Feather", 0, 1, 0.1, 0.01), P("invert", "Invert", 0, 1, 0)], `
  // depth = 1 - luminance: bright is near
  half4 c = S(xy); float3 u = unp(c);
  float d = 1.0 - lum(u);
  float m = 1.0 - smoothstep(p[0] - p[1] * 0.5, p[0] + p[1] * 0.5 + 0.001, d);
  if (p[2] > 0.5) { m = 1.0 - m; }
  return pre(u, float(c.a) * m);`),

  kern("ec.3d.depthoffield", [P("focal", "Focal Plane (depth)", 0, 1, 0.5, 0.01), P("maxBlur", "Maximum Blur", 0, 100, 12, 0.5), P("range", "Depth of Field", 0, 1, 0.2, 0.01), P("quality", "Quality (taps)", 4, 24, 16)], `
  half4 c0 = S(xy);
  float d = 1.0 - lum(unp(c0));
  float r = p[1] * clamp((abs(d - p[0]) - p[2] * 0.5) / max(1.0 - p[2] * 0.5, 0.05), 0.0, 1.0);
  half4 acc = half4(0.0); float wsum = 0.0;
  for (int i = 0; i < 24; i++) {
    if (float(i) >= p[3]) { break; }
    acc += S(xy + ring(float(i), p[3]) * r); wsum += 1.0;
  }
  return acc / half(max(wsum, 1.0));`, { outset: (v) => v.maxBlur }),

  kern("ec.3d.fog3d", [HUE("hue", "Fog Color (hue)", 210), P("sat", "Fog Saturation", 0, 100, 10), P("start", "Fog Start Depth", 0, 1, 0.2, 0.01), P("end", "Fog End Depth", 0, 1, 0.9, 0.01), P("density", "Fog Opacity", 0, 100, 80), P("scatter", "Scattering Density", 0, 100, 0), P("bright", "Fog Brightness", 0, 100, 90), P("keepAlpha", "Fog Background", 0, 1, 0)], `
  half4 c = S(xy); float3 u = unp(c);
  float d = 1.0 - lum(u);
  float f = smoothstep(p[2], max(p[3], p[2] + 0.01), d) * p[4] / 100.0;
  float3 fog = hsv2rgb(float3(p[0] / 360.0, p[1] / 100.0, p[6] / 100.0));
  return pre(mix(u, fog, f), float(c.a));`),

  kern("ec.3d.idmatte", [HUE("hue", "ID Color (hue)", 0), P("sat", "ID Saturation", 0, 100, 100), P("val", "ID Brightness", 0, 100, 100), P("tolerance", "Tolerance", 0, 100, 12), P("invert", "Invert", 0, 1, 0)], `
  half4 c = S(xy); float3 u = unp(c);
  float3 k = hsv2rgb(float3(p[0] / 360.0, p[1] / 100.0, p[2] / 100.0));
  float d = length(u - k) / 1.7320508 * 100.0;
  float m = 1.0 - smoothstep(p[3] * 0.6, p[3] + 0.001, d);
  if (p[4] > 0.5) { m = 1.0 - m; }
  return pre(u, float(c.a) * m);`),

  kern("ec.3d.cryptomatte", [HUE("hue", "Matte ID (hue)", 120), P("tolerance", "Hue Tolerance", 0, 100, 10), P("softness", "Softness", 0, 100, 10), P("invert", "Invert", 0, 1, 0)], `
  half4 c = S(xy); float3 u = unp(c); float3 h = rgb2hsv(u);
  float d = hdist(h.x, p[0] / 360.0) * 2.0 * 100.0;
  float m = (1.0 - smoothstep(p[1], p[1] + p[2] + 0.001, d)) * step(0.05, h.y);
  if (p[3] > 0.5) { m = 1.0 - m; }
  return pre(u, float(c.a) * m);`),

  kern("ec.3d.identifier", [P("levels", "ID Resolution", 2, 32, 6), P("seed", "Seed", 0, 1000, 1), P("blend", "Blend With Original", 0, 100, 0)], `
  // every distinct (quantised) colour gets its own pseudo-random colour
  half4 c = S(xy); float3 u = unp(c);
  float3 q = floor(u * p[0] + 0.5);
  float3 id = float3(hash21(q.xy + q.z * 7.0 + p[1]), hash21(q.yz + q.x * 5.0 + p[1] + 3.0), hash21(q.zx + q.y * 3.0 + p[1] + 9.0));
  return pre(mix(id, u, p[2] / 100.0), float(c.a));`),

  // Colour ---------------------------------------------------------------------------------------------------
  kern("ec.color.cccolorneutralizer", [
    P("shadowHue", "Shadows Hue", 0, 360, 220, 1, "°"), P("shadowAmt", "Shadows Amount", 0, 100, 0), P("midHue", "Midtones Hue", 0, 360, 30, 1, "°"), P("midAmt", "Midtones Amount", 0, 100, 0),
    P("highHue", "Highlights Hue", 0, 360, 50, 1, "°"), P("highAmt", "Highlights Amount", 0, 100, 0), P("auto", "Neutralize Casts", 0, 100, 50), P("range", "Mid Range", 0.1, 1, 0.5, 0.01), P("blend", "Blend With Original", 0, 100, 0),
  ], `
  half4 c = S(xy); float3 u = unp(c); float L = lum(u);
  float ws = 1.0 - smoothstep(0.0, 0.5, L), wh = smoothstep(0.5, 1.0, L), wm = 1.0 - ws - wh;
  float3 sh = hsv2rgb(float3(p[0] / 360.0, 1.0, 1.0)) - 0.5, md = hsv2rgb(float3(p[2] / 360.0, 1.0, 1.0)) - 0.5, hi = hsv2rgb(float3(p[4] / 360.0, 1.0, 1.0)) - 0.5;
  float3 o = u + (sh * ws * p[1] + md * wm * p[3] + hi * wh * p[5]) / 100.0 * 0.5;
  // pull the colour toward its own grey: a cast neutraliser
  o = mix(o, float3(lum(o)), p[6] / 100.0 * (1.0 - abs(L - 0.5) * 2.0 * (1.0 - p[7])) * 0.5);
  return pre(clamp(mix(o, u, p[8] / 100.0), 0.0, 1.0), float(c.a));`),

  kern("ec.color.ociodisplay", [
    P("exposure", "Exposure (stops)", -6, 6, 0, 0.05), P("gamma", "Display Gamma", 0.1, 4, 1, 0.01), P("view", "View (0 Standard, 1 Filmic Tonemap, 2 Raw)", 0, 2, 0), P("saturation", "Saturation", 0, 3, 1, 0.01),
    P("linearIn", "Input is Linear", 0, 1, 1), P("channel", "Channels (0 Color, 1 R, 2 G, 3 B, 4 Luma)", 0, 4, 0),
  ], `
  half4 c = S(xy); float3 u = unp(c);
  float3 lin = p[4] > 0.5 ? u : pow(u, float3(2.2));
  lin *= pow(2.0, p[0]);
  float l = lum(lin); lin = l + (lin - l) * p[3];
  float3 o;
  if (p[2] < 0.5) { o = pow(max(lin, float3(0.0)), float3(1.0 / 2.2)); }
  else if (p[2] < 1.5) { float3 x = max(lin - 0.004, float3(0.0)); o = (x * (6.2 * x + 0.5)) / (x * (6.2 * x + 1.7) + 0.06); }
  else { o = lin; }
  o = pow(max(o, float3(0.0)), float3(1.0 / p[1]));
  if (p[5] > 0.5 && p[5] < 1.5) { o = float3(o.r); } else if (p[5] > 1.5 && p[5] < 2.5) { o = float3(o.g); } else if (p[5] > 2.5 && p[5] < 3.5) { o = float3(o.b); } else if (p[5] > 3.5) { o = float3(lum(o)); }
  return pre(clamp(o, 0.0, 1.0), float(c.a));`),

  kern("ec.stylize.ccmrsmoothie", [P("phase", "Phase", -3600, 3600, 0, 1, "°"), P("cycles", "Cycles", 0.1, 8, 1.5, 0.05), P("hueStart", "Palette Start (hue)", 0, 360, 200, 1, "°"), P("hueEnd", "Palette End (hue)", 0, 360, 330, 1, "°"), P("smooth", "Smoothness", 0, 1, 0.7, 0.01), P("sat", "Saturation", 0, 100, 70), P("blend", "Blend With Original", 0, 100, 0)], `
  half4 c = S(xy); float3 u = unp(c);
  float t = lum(u) * p[1] + p[0] / 360.0;
  t = mix(fract(t), 0.5 - 0.5 * cos(6.2831853 * t), p[4]);
  float3 col = hsv2rgb(float3(mix(p[2], p[3], t) / 360.0, p[5] / 100.0, 0.55 + 0.45 * t));
  return pre(mix(col, u, p[6] / 100.0), float(c.a));`),

  // Distort ---------------------------------------------------------------------------------------------------
  kern("ec.distort.upscale", [P("scale", "Scale", 25, 800, 200, 1, "%"), P("detail", "Detail", 0, 100, 50), P("radius", "Detail Radius", 0.5, 8, 1.5, 0.1), CX, CY], `
  float2 c = box.xy + box.zw * float2(p[3], p[4]) / 100.0;
  float k = 100.0 / p[0];
  float2 q = c + (xy - c) * k;
  half4 o = S(q);
  half4 b = half4(0.0);
  for (int i = 0; i < 8; i++) { b += S(q + ring(float(i), 8.0) * p[2]); }
  b /= 8.0;
  half4 r = o + (o - b) * half(p[1] / 50.0);
  float a = clamp(float(r.a), 0.0, 1.0);
  return half4(clamp(r.rgb, half3(0.0), half3(a)), half(a));`, { outset: (v) => Math.max(0, v.scale - 100) }),

  kern("ec.distort.ccblobbylize", [P("blob", "Blobbiness", 0.5, 60, 8, 0.5), P("threshold", "Edge Threshold", 0, 1, 0.5, 0.01), P("height", "Bump Height", 0, 40, 12, 0.5), P("angle", "Light Direction", -360, 360, 135, 1, "°"), P("shine", "Shine", 0, 100, 50), P("ambient", "Ambient", 0, 100, 50), HUE("hue", "Light Color (hue)", 0)], `
  // a metaball look: the alpha is blurred into a height field, thresholded and lit
  float a = 0.0, ax = 0.0, ay = 0.0;
  for (int i = 0; i < 16; i++) {
    float2 o = ring(float(i), 16.0) * p[0];
    float s = float(S(xy + o).a);
    a += s; ax += s * o.x; ay += s * o.y;
  }
  a /= 16.0;
  float m = smoothstep(p[1] - 0.08, p[1] + 0.08, a);
  float3 n = normalize(float3(-ax / 16.0 * p[2] / max(p[0], 1.0), -ay / 16.0 * p[2] / max(p[0], 1.0), 1.0));
  float3 L = normalize(float3(cos(radians(p[3])), -sin(radians(p[3])), 0.8));
  half4 c = S(xy);
  float diff = clamp(dot(n, L), 0.0, 1.0);
  float spec = pow(clamp(dot(n, normalize(L + float3(0.0, 0.0, 1.0))), 0.0, 1.0), 32.0) * p[4] / 100.0;
  float3 lc = p[6] == 0.0 ? float3(1.0) : hsv2rgb(float3(p[6] / 360.0, 0.4, 1.0));
  float3 base = c.a > 0.0 ? unp(c) : float3(0.6, 0.65, 0.75);
  float3 o = base * (p[5] / 100.0 + (1.0 - p[5] / 100.0) * diff) + lc * spec;
  return pre(clamp(o, 0.0, 1.0), m);`, { outset: (v) => v.blob }),

  kern("ec.distort.ccflomotion", [P("amount", "Amount", 0, 400, 40), P("angle", "Flow Angle", -360, 360, 40, 1, "°"), P("zoom", "Zoom", -100, 100, 10), CX, CY, P("steps", "Quality (steps)", 4, 24, 16), P("fade", "Trail Fade", 0, 1, 0.5, 0.01)], `
  float2 c = box.xy + box.zw * float2(p[3], p[4]) / 100.0;
  float2 q = xy - c;
  half4 acc = half4(0.0); float wsum = 0.0;
  for (int i = 0; i < 24; i++) {
    if (float(i) >= p[5]) { break; }
    float t = float(i) / max(p[5] - 1.0, 1.0);
    float2 pt = c + rot(q, radians(p[1]) * t * p[0] / 400.0) * (1.0 - p[2] / 100.0 * t * 0.5);
    float w = 1.0 - t * p[6];
    acc += S(pt) * half(w); wsum += w;
  }
  return acc / half(max(wsum, 0.001));`, { outset: (v) => v.amount }),

  kern("ec.distort.bezierwarp", [
    P("tlx", "Top Left X", -300, 300, 0), P("tly", "Top Left Y", -300, 300, 0), P("trx", "Top Right X", -300, 300, 0), P("try", "Top Right Y", -300, 300, 0),
    P("blx", "Bottom Left X", -300, 300, 0), P("bly", "Bottom Left Y", -300, 300, 0), P("brx", "Bottom Right X", -300, 300, 0), P("bry", "Bottom Right Y", -300, 300, 0),
    P("top", "Top Edge Bulge", -200, 200, 0), P("right", "Right Edge Bulge", -200, 200, 0), P("bottom", "Bottom Edge Bulge", -200, 200, 0), P("left", "Left Edge Bulge", -200, 200, 0),
  ], `
  // invert the patch: find (u, v) whose forward position is xy, by Newton iterations with a numeric Jacobian
  float2 uv = clamp((xy - box.xy) / max(box.zw, float2(1.0)), 0.0, 1.0);
  for (int i = 0; i < 8; i++) {
    float2 f = coons(uv.x, uv.y) - xy;
    float2 fu = (coons(uv.x + 0.01, uv.y) - coons(uv.x, uv.y)) / 0.01;
    float2 fv = (coons(uv.x, uv.y + 0.01) - coons(uv.x, uv.y)) / 0.01;
    float det = fu.x * fv.y - fu.y * fv.x;
    if (abs(det) < 1e-3) { break; }
    uv -= float2(f.x * fv.y - f.y * fv.x, fu.x * f.y - fu.y * f.x) / det;
  }
  if (uv.x < -0.001 || uv.x > 1.001 || uv.y < -0.001 || uv.y > 1.001) { return half4(0.0); }
  return S(box.xy + uv * box.zw);`, {
    outset: (v) => 300 + Math.max(Math.abs(v.top), Math.abs(v.bottom), Math.abs(v.left), Math.abs(v.right)),
    head: `
float2 coons(float u, float v) {
  float2 P00 = box.xy + float2(p[0], p[1]), P10 = box.xy + float2(box.z + p[2], p[3]);
  float2 P01 = box.xy + float2(p[4], box.w + p[5]), P11 = box.xy + float2(box.z + p[6], box.w + p[7]);
  float2 T = mix(P00, P10, u) + float2(0.0, -p[8]) * sin(PI * u);
  float2 B = mix(P01, P11, u) + float2(0.0, p[10]) * sin(PI * u);
  float2 L = mix(P00, P01, v) + float2(-p[11], 0.0) * sin(PI * v);
  float2 R = mix(P10, P11, v) + float2(p[9], 0.0) * sin(PI * v);
  float2 corners = (1.0 - u) * (1.0 - v) * P00 + u * (1.0 - v) * P10 + (1.0 - u) * v * P01 + u * v * P11;
  return (1.0 - v) * T + v * B + (1.0 - u) * L + u * R - corners;
}`,
  }),

  kern("ec.distort.rollingshutterrepair", [P("rate", "Rolling Shutter Rate", 0, 200, 50, 1, "%"), P("direction", "Scan Direction (0 Up, 1 Down)", 0, 1, 1), P("skew", "Skew per 100 px", -100, 100, 6, 0.5), P("method", "Method (0 Pixel Motion, 1 Skew)", 0, 1, 1)], `
  float2 q = xy - ctr();
  float s = (p[1] > 0.5 ? 1.0 : -1.0) * p[2] / 100.0 * p[0] / 100.0;
  return S(float2(xy.x - q.y * s, xy.y));`, { outset: (v) => Math.abs(v.skew) * 5 }),

  // Keying -----------------------------------------------------------------------------------------------------
  kern("ec.key.ccsimplewireremoval", [P("ax", "Point A X", -100, 200, 20, 0.5, "%"), P("ay", "Point A Y", -100, 200, 50, 0.5, "%"), P("bx", "Point B X", -100, 200, 80, 0.5, "%"), P("by", "Point B Y", -100, 200, 50, 0.5, "%"), P("thickness", "Thickness", 0, 100, 6, 0.5), P("slope", "Slope", 0, 100, 50), P("mirror", "Mirror Blend", 0, 100, 100)], `
  float2 a = box.xy + box.zw * float2(p[0], p[1]) / 100.0, b = box.xy + box.zw * float2(p[2], p[3]) / 100.0;
  float2 ab = b - a; float len = max(length(ab), 1.0); float2 d = ab / len, n = float2(-d.y, d.x);
  float t = dot(xy - a, d) / len;
  float across = dot(xy - a, n);
  half4 c = S(xy);
  if (t < 0.0 || t > 1.0) { return c; }
  float w = p[4] * 0.5 + 0.001;
  float inside = 1.0 - smoothstep(w * (1.0 - p[5] / 100.0 * 0.8), w + 0.5, abs(across));
  half4 fill = mix(S(xy + n * (w + 1.0)), S(xy - n * (w + 1.0)), half(0.5 + 0.5 * clamp(across / w, -1.0, 1.0)));
  return mix(c, fill, half(inside * p[6] / 100.0));`),

  kern("ec.key.keycleaner", [P("reduce", "Reduce Chatter", 0, 100, 50), P("radius", "Radius", 0.5, 10, 2, 0.5), P("contrast", "Alpha Contrast", 0, 4, 1.6, 0.05), P("despeckle", "Remove Specks", 0, 100, 30)], `
  half4 c = S(xy);
  float a = 0.0, mn = 1.0;
  for (int i = 0; i < 12; i++) { float s = float(S(xy + ring(float(i), 12.0) * p[1]).a); a += s; mn = min(mn, s); }
  a /= 12.0;
  float cleaned = clamp((a - 0.5) * p[2] + 0.5, 0.0, 1.0);
  cleaned = mix(cleaned, float(c.a) * step(0.2, mn + 0.1), p[3] / 100.0 * 0.0);
  float o = mix(float(c.a), cleaned, p[0] / 100.0);
  return pre(unp(c), o);`),

  // Generate (from the node's alpha edge) ----------------------------------------------------------------
  kern("ec.generate.stroke", [HUE("hue", "Color (hue)", 40), P("sat", "Saturation", 0, 100, 0), P("val", "Brightness", 0, 100, 100), P("width", "Brush Size", 0.5, 100, 4, 0.5), P("hardness", "Brush Hardness", 0, 100, 80), P("opacity", "Opacity", 0, 100, 100), P("inside", "Stroke Position (0 Outside, 1 Inside, 2 Center)", 0, 2, 0), P("start", "Start", 0, 100, 0), P("end", "End", 0, 100, 100), P("paint", "Paint Style (0 On Original, 1 Stroke Only)", 0, 1, 0)], `
  half4 c = S(xy);
  float a0 = float(c.a);
  float mx = a0, mn = a0;
  for (int i = 0; i < 20; i++) { float s = float(S(xy + ring(float(i), 20.0) * p[3]).a); mx = max(mx, s); mn = min(mn, s); }
  float outer = mx - a0;
  float inner = a0 - mn;
  float e = p[6] < 0.5 ? outer : p[6] < 1.5 ? inner : max(outer, inner);
  e = smoothstep(0.0, mix(1.0, 0.1, p[4] / 100.0), e);
  // start/end: only the part of the outline whose angle (from the centre, clockwise from the top) is inside the range
  float ang = fract(atan(xy.x - ctr().x, -(xy.y - ctr().y)) / (2.0 * PI));
  e *= step(p[7] / 100.0, ang) * step(ang, p[8] / 100.0 + 0.0001);
  float3 col = hsv2rgb(float3(p[0] / 360.0, p[1] / 100.0, p[2] / 100.0));
  half4 s = half4(half3(col * e * p[5] / 100.0), half(e * p[5] / 100.0));
  return p[9] > 0.5 ? s : s + c * (1.0 - s.a);`, { outset: (v) => v.width }),

  kern("ec.generate.vegas", [HUE("hue", "Color (hue)", 50), P("segments", "Segments", 1, 40, 12), P("length", "Segment Length", 0, 100, 40, 1, "%"), P("phase", "Rotation", -3600, 3600, 0, 1, "°"), P("width", "Width", 0.5, 40, 3, 0.5), P("softness", "Softness", 0, 100, 40), P("opacity", "Opacity", 0, 100, 100), P("fill", "Keep Original", 0, 1, 1)], `
  half4 c = S(xy);
  float a0 = float(c.a), mx = a0;
  for (int i = 0; i < 16; i++) { mx = max(mx, float(S(xy + ring(float(i), 16.0) * p[4]).a)); }
  float edge = (mx - a0) + a0 * (1.0 - float(S(xy - normalize(xy - ctr() + 1e-3) * p[4]).a));
  edge = clamp(edge, 0.0, 1.0);
  float ang = atan(xy.x - ctr().x, -(xy.y - ctr().y)) / (2.0 * PI) + 0.5;
  float dash = fract(ang * p[1] - radians(p[3]) / (2.0 * PI) * p[1]);
  float on = 1.0 - smoothstep(p[2] / 100.0, p[2] / 100.0 + p[5] / 100.0 * 0.3 + 0.001, dash);
  float v = edge * on * p[6] / 100.0;
  half4 s = tint(hsv2rgb(float3(p[0] / 360.0, 0.7, 1.0)), v);
  return p[7] > 0.5 ? s + c * (1.0 - s.a) : s;`, { outset: (v) => v.width }),

  over("ec.generate.scribble", [P("angle", "Angle", -360, 360, 45, 1, "°"), P("spacing", "Spacing", 1, 100, 6, 0.5), P("width", "Stroke Width", 0.2, 20, 1.2, 0.1), P("wobble", "Wobble", 0, 20, 2, 0.1), HUE("hue", "Color (hue)", 0), P("sat", "Saturation (0 = black ink)", 0, 100, 0), P("opacity", "Opacity", 0, 100, 100), P("phase", "Draw Phase", 0, 100, 100, 1, "%"), P("seed", "Seed", 0, 1000, 1)], `
  float2 q = rot(xy - box.xy, -radians(p[0]));
  float row = floor(q.y / p[1]);
  float j = (vnoise(float2(q.x / 18.0, row + p[8])) - 0.5) * 2.0 * p[3];
  float d = abs(fract((q.y + j) / p[1]) - 0.5) * p[1];
  float line = 1.0 - smoothstep(p[2] * 0.5, p[2] * 0.5 + 0.8, d);
  // each line is drawn along its length as the phase grows, rows starting at different moments
  float along = clamp(q.x / max(box.z, 1.0), 0.0, 1.0);
  float drawn = step(along, p[7] / 100.0 * (1.0 + hash21(float2(row, p[8]))) );
  float3 col = p[5] > 0.0 ? hsv2rgb(float3(p[4] / 360.0, p[5] / 100.0, 1.0)) : float3(0.05);
  return tint(col, line * drawn * p[6] / 100.0);`),

  kern("ec.generate.paintbucket", [P("x", "Fill Point X", 0, 100, 50, 0.5, "%"), P("y", "Fill Point Y", 0, 100, 50, 0.5, "%"), P("tolerance", "Tolerance", 0, 100, 20), P("feather", "Feather", 0, 100, 10), HUE("hue", "Fill Color (hue)", 120), P("sat", "Saturation", 0, 100, 80), P("val", "Brightness", 0, 100, 100), P("opacity", "Opacity", 0, 100, 100), P("blend", "Blend (0 Replace, 1 Tint)", 0, 1, 0)], `
  // every pixel close in colour to the one at the fill point takes the fill colour
  half4 c = S(xy); float3 u = unp(c);
  float3 ref = unp(S(box.xy + box.zw * float2(p[0], p[1]) / 100.0));
  float d = length(u - ref) / 1.7320508 * 100.0;
  float m = (1.0 - smoothstep(p[2], p[2] + p[3] + 0.001, d)) * p[7] / 100.0;
  float3 fill = hsv2rgb(float3(p[4] / 360.0, p[5] / 100.0, p[6] / 100.0));
  float3 o = p[8] > 0.5 ? u * fill : fill;
  return pre(mix(u, o, m), float(c.a));`),

  kern("ec.color.colorlink", [P("sample", "Sample (0 Average, 1 Brightest, 2 Darkest)", 0, 2, 0), P("opacity", "Opacity", 0, 100, 100), P("mode", "Blend (0 Replace, 1 Multiply, 2 Screen, 3 Overlay)", 0, 3, 0), P("region", "Sample Region", 5, 100, 100, 1, "%"), P("cx", "Region Center X", 0, 100, 50, 0.5, "%"), P("cy", "Region Center Y", 0, 100, 50, 0.5, "%")], `
  // the node's own colour (average, brightest or darkest of an 8 x 8 grid over a region) painted back over it
  half4 c = S(xy);
  float2 hr = box.zw * p[3] / 200.0;
  float2 centre = box.xy + box.zw * float2(p[4], p[5]) / 100.0;
  float3 acc = float3(0.0); float wsum = 0.0;
  float3 best = p[0] < 1.5 ? float3(0.0) : float3(1.0);
  for (int j = 0; j < 8; j++) {
    for (int i = 0; i < 8; i++) {
      half4 s = S(centre + (float2(float(i), float(j)) / 7.0 * 2.0 - 1.0) * hr);
      float w = float(s.a);
      if (w <= 0.0) { continue; }
      float3 u = unp(s);
      acc += u * w; wsum += w;
      if (p[0] > 0.5 && p[0] < 1.5 && lum(u) > lum(best)) { best = u; }
      if (p[0] > 1.5 && lum(u) < lum(best)) { best = u; }
    }
  }
  float3 link = p[0] < 0.5 ? (wsum > 0.0 ? acc / wsum : float3(0.0)) : best;
  float3 u0 = unp(c);
  float3 o = p[2] < 0.5 ? link : p[2] < 1.5 ? u0 * link : p[2] < 2.5 ? 1.0 - (1.0 - u0) * (1.0 - link) : mix(2.0 * u0 * link, 1.0 - 2.0 * (1.0 - u0) * (1.0 - link), step(0.5, u0));
  return pre(mix(u0, o, p[1] / 100.0), float(c.a));`),
];
