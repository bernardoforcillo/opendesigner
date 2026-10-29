// More distortions, lighting, procedural "simulation" patterns, stylize, transitions and VR helpers (see kit.ts).
// The particle effects are procedural: every flake/drop/bubble is a hashed cell whose position is a function of the
// animatable `phase` parameter, so they scrub and loop like everything else.

import type { FxDef } from "@/animation/fx/library";
import { P, kern, over, wipeBody } from "@/animation/fx/kit";

const HUE = (id: string, label: string, def: number) => P(id, label, 0, 360, def, 1, "°");
const CX = P("centerX", "Center X", -100, 200, 50, 0.5, "%");
const CY = P("centerY", "Center Y", -100, 200, 50, 0.5, "%");
const OP = P("opacity", "Opacity", 0, 100, 100, 1, "%");

export const MORE2_FX: FxDef[] = [
  // Distort ------------------------------------------------------------------------------------------
  kern("ec.distort.cclens", [P("size", "Size", 1, 1000, 150), P("convergence", "Convergence", -200, 200, 60), CX, CY], `
  float2 c = box.xy + box.zw * float2(p[2], p[3]) / 100.0;
  float2 q = xy - c; float r = length(q) / max(p[0], 1.0);
  // convergence 0 is the identity, > 0 magnifies the middle, < 0 pinches it
  float k = r < 1.0 ? pow(max(r, 1e-3), p[1] / 200.0) : 1.0;
  return S(c + q * k);`),

  kern("ec.distort.ccbendit", [P("bend", "Bend", -100, 100, 30), P("start", "Start", 0, 100, 0, 1, "%"), P("end", "End", 0, 100, 100, 1, "%"), P("render", "Render Prestyle (0 Bend, 1 Squeeze)", 0, 1, 0)], `
  float2 u = uv(xy);
  float t = clamp((u.x - p[1] / 100.0) / max((p[2] - p[1]) / 100.0, 0.001), 0.0, 1.0);
  float k = p[0] / 100.0 * box.w * 0.6;
  float2 d = p[3] < 0.5 ? float2(0.0, -k * t * t) : float2(0.0, 0.0);
  float sc = p[3] < 0.5 ? 1.0 : 1.0 + k * t / max(box.w, 1.0);
  return S(float2(xy.x, ctr().y + (xy.y - ctr().y) * sc) + d);`, { outset: (v) => Math.abs(v.bend) * 5 }),

  kern("ec.distort.ccbender", [P("amount", "Amount", -100, 100, 30), P("style", "Style (0 Arc, 1 Wave)", 0, 1, 0), P("angle", "Direction", -360, 360, 0, 1, "°"), P("size", "Wave Size", 10, 1000, 200)], `
  float2 d = float2(cos(radians(p[2])), sin(radians(p[2]))), n = float2(-d.y, d.x);
  float2 q = xy - ctr();
  float along = dot(q, d) / max(length(box.zw) * 0.5, 1.0);
  float off = p[1] < 0.5 ? along * along - 0.33 : sin(dot(q, d) / max(p[3], 1.0) * 6.2831853);
  return S(xy - n * off * p[0] * 0.5);`, { outset: (v) => Math.abs(v.amount) }),

  kern("ec.distort.ccsplit", [P("split", "Split", 0, 100, 20, 1, "%"), P("angle", "Angle", -360, 360, 0, 1, "°"), P("offset", "Offset", -100, 100, 0, 1, "%")], `
  float2 d = float2(cos(radians(p[1])), sin(radians(p[1]))), n = float2(-d.y, d.x);
  float2 q = xy - ctr();
  float side = dot(q, n) - p[2] / 100.0 * box.w * 0.5;
  float gap = p[0] / 100.0 * box.w * 0.25;
  float sh = side >= 0.0 ? gap : -gap;
  if (abs(side) < gap) { return half4(0.0); }
  return S(xy - n * sh);`, { outset: (v) => v.split * 5 }),

  kern("ec.distort.ccsplit2", [P("split", "Split", 0, 100, 20, 1, "%"), P("angle", "Angle", -360, 360, 0, 1, "°"), P("offset", "Offset", -100, 100, 0, 1, "%"), P("balance", "Balance", -100, 100, 0, 1)], `
  float2 d = float2(cos(radians(p[1])), sin(radians(p[1]))), n = float2(-d.y, d.x);
  float2 q = xy - ctr();
  float side = dot(q, n) - p[2] / 100.0 * box.w * 0.5;
  float gap = p[0] / 100.0 * box.w * 0.25;
  float sh = side >= 0.0 ? gap * (1.0 + p[3] / 100.0) : -gap * (1.0 - p[3] / 100.0);
  if (abs(side) < abs(sh)) { return half4(0.0); }
  return S(xy - n * sh);`, { outset: (v) => v.split * 5 }),

  kern("ec.distort.ccsmear", [P("fromX", "From X", -100, 200, 30, 0.5, "%"), P("fromY", "From Y", -100, 200, 50, 0.5, "%"), P("toX", "To X", -100, 200, 70, 0.5, "%"), P("toY", "To Y", -100, 200, 50, 0.5, "%"), P("reach", "Reach", 0, 100, 50)], `
  float2 a = box.xy + box.zw * float2(p[0], p[1]) / 100.0, b = box.xy + box.zw * float2(p[2], p[3]) / 100.0;
  float R = max(p[4] / 100.0 * length(box.zw) * 0.5, 1.0);
  float f = 1.0 - smoothstep(0.0, R, length(xy - a));
  return S(xy - (b - a) * f);`, { outset: (v) => 200 + v.reach }),

  kern("ec.distort.ccgriddler", [P("hScale", "Horizontal Scale", 1, 400, 70), P("vScale", "Vertical Scale", 1, 400, 70), P("tile", "Tile Size", 4, 500, 40), P("rotation", "Rotation", -360, 360, 0, 1, "°"), P("blend", "Blend With Original", 0, 100, 0)], `
  float2 q = rot(xy - box.xy, -radians(p[3]));
  float2 cell = floor(q / p[2]), f = fract(q / p[2]) - 0.5;
  float2 s = float2(p[0], p[1]) / 100.0;
  float2 g = f / s;
  if (abs(g.x) > 0.5 || abs(g.y) > 0.5) { return mix(half4(0.0), S(xy), half(p[4] / 100.0)); }
  float2 src = rot((cell + 0.5 + g * 1.0) * p[2], radians(p[3])) + box.xy;
  return mix(S(src), S(xy), half(p[4] / 100.0));`),

  kern("ec.stylize.cchextile", [P("size", "Size", 4, 500, 24), P("blend", "Blend With Original", 0, 100, 0)], `
  // hexagonal mosaic: every pixel takes the colour at the centre of its hexagon
  float2 q = (xy - box.xy) / max(p[0], 2.0);
  float2 r = float2(1.0, 1.7320508), h = r * 0.5;
  float2 a = mod(q, r) - h, b = mod(q - h, r) - h;
  float2 gv = dot(a, a) < dot(b, b) ? a : b;
  float2 cen = q - gv;
  return mix(S(box.xy + cen * max(p[0], 2.0)), S(xy), half(p[1] / 100.0));`, { outset: (v) => v.size }),

  kern("ec.sim.ccballaction", [P("spacing", "Grid Spacing", 4, 200, 24), P("radius", "Ball Size", 0.1, 1, 0.45, 0.01), P("lens", "Lens Strength", 0, 1, 0.6, 0.01), P("scatter", "Scatter", 0, 1, 0, 0.01)], `
  float2 g = (xy - box.xy) / p[0];
  float2 cell = floor(g), f = fract(g) - 0.5;
  f += (hash22(cell) - 0.5) * p[3];
  float r = length(f) / p[1];
  if (r > 1.0) { return half4(0.0); }
  float z = sqrt(1.0 - r * r);
  float2 src = box.xy + (cell + 0.5) * p[0] + f / p[1] * p[0] * 0.5 * (1.0 - z * p[2]);
  half4 c = S(src);
  float shade = 0.65 + 0.35 * z;
  return half4(c.rgb * half(shade), c.a);`),

  kern("ec.perspective.ccsphere", [P("radius", "Radius", 1, 2000, 60), P("rotation", "Rotation Y", -3600, 3600, 0, 1, "°"), P("tilt", "Rotation X", -90, 90, 0, 1, "°"), P("light", "Light Intensity", 0, 100, 60), CX, CY], `
  float2 c = box.xy + box.zw * float2(p[4], p[5]) / 100.0;
  float2 q = (xy - c) / max(p[0], 1.0);
  float r2 = dot(q, q);
  if (r2 > 1.0) { return half4(0.0); }
  float z = sqrt(1.0 - r2);
  float3 n = float3(q.x, q.y, z);
  float ct = cos(radians(p[2])), st = sin(radians(p[2]));
  n = float3(n.x, n.y * ct - n.z * st, n.y * st + n.z * ct);
  float lon = atan(n.x, n.z) + radians(p[1]);
  float lat = asin(clamp(n.y, -1.0, 1.0));
  float2 u = float2(fract(lon / (2.0 * PI) + 0.5), lat / PI + 0.5);
  half4 col = S(box.xy + u * box.zw);
  float diff = clamp(dot(float3(q, z), normalize(float3(-0.5, -0.6, 0.8))), 0.0, 1.0);
  float lit = 1.0 - p[3] / 100.0 + p[3] / 100.0 * (0.25 + 0.75 * diff);
  return half4(col.rgb * half(lit), col.a);`, { outset: (v) => v.radius }),

  kern("ec.perspective.cccylinder", [P("radius", "Radius", 1, 2000, 50), P("rotation", "Rotation", -3600, 3600, 0, 1, "°"), P("light", "Light Intensity", 0, 100, 60), CX, CY], `
  float2 c = box.xy + box.zw * float2(p[3], p[4]) / 100.0;
  float2 q = xy - c;
  float x = q.x / max(p[0], 1.0);
  if (abs(x) > 1.0) { return half4(0.0); }
  float z = sqrt(1.0 - x * x);
  float lon = asin(x) + radians(p[1]);
  // the cylinder spans the node's height; its surface wraps the node's image around it
  float2 u = float2(fract(lon / (2.0 * PI) + 0.5), (xy.y - box.xy.y) / max(box.w, 1.0));
  if (u.y < 0.0 || u.y > 1.0) { return half4(0.0); }
  half4 col = S(box.xy + u * box.zw);
  float lit = 1.0 - p[2] / 100.0 + p[2] / 100.0 * (0.3 + 0.7 * z);
  return half4(col.rgb * half(lit), col.a);`, { outset: (v) => v.radius }),

  kern("ec.perspective.3dglasses", [P("convergence", "Convergence Offset", -100, 100, 6), P("balance", "Balance", 0, 100, 50), P("swap", "Swap Left-Right", 0, 1, 0)], `
  float d = p[0] * (p[2] > 0.5 ? -1.0 : 1.0);
  half4 l = S(xy - float2(d, 0.0)), r = S(xy + float2(d, 0.0));
  float k = p[1] / 100.0;
  half4 o = half4(l.r, r.g, r.b, max(l.a, r.a));
  return mix(S(xy), o, half(0.5 + k * 0.5));`, { outset: (v) => Math.abs(v.convergence) }),

  kern("ec.perspective.radialshadow", [P("lx", "Light X", -100, 200, 20, 0.5, "%"), P("ly", "Light Y", -100, 200, 20, 0.5, "%"), P("length", "Projection Distance", 0, 100, 40), P("opacity", "Opacity", 0, 100, 60), P("softness", "Softness", 0, 100, 10), P("only", "Shadow Only", 0, 1, 0)], `
  float2 L = box.xy + box.zw * float2(p[0], p[1]) / 100.0;
  float2 dir = xy - L;
  float a = 0.0;
  for (int i = 0; i < 24; i++) {
    float t = float(i) / 23.0 * p[2] / 100.0;
    a = max(a, float(S(xy - dir * t + hash22(xy + float(i)) * p[4] * 0.2).a) * (1.0 - float(i) / 24.0 * 0.5));
  }
  half4 c = S(xy);
  half4 sh = half4(0.0, 0.0, 0.0, half(a * p[3] / 100.0));
  return p[5] > 0.5 ? sh : c + sh * (1.0 - c.a);`, { outset: (v) => 400 + v.length }),

  over("ec.perspective.ccspotlight", [P("intensity", "Intensity", 0, 100, 70), P("radius", "Radius", 1, 2000, 200), P("softness", "Edge Softness", 0, 100, 60), HUE("hue", "Light Color (hue)", 40), P("tint", "Color Amount", 0, 100, 0), CX, CY], `
  float2 c = box.xy + box.zw * float2(p[5], p[6]) / 100.0;
  float d = length(xy - c) / max(p[1], 1.0);
  float lit = 1.0 - smoothstep(1.0 - p[2] / 100.0, 1.0, d);
  float3 col = mix(float3(0.0), hsv2rgb(float3(p[3] / 360.0, p[4] / 100.0 * 0.8, 1.0)), 0.0);
  return tint(float3(0.0), (1.0 - lit) * p[0] / 100.0);`),

  // Stylize ------------------------------------------------------------------------------------------
  kern("ec.stylize.ccplastic", [P("height", "Bump Height", 0, 50, 10, 0.5), P("smooth", "Smoothness", 0.5, 20, 2, 0.5), P("angle", "Light Direction", -360, 360, 135, 1, "°"), P("specular", "Specular", 0, 100, 40), P("gloss", "Roughness", 1, 100, 20)], `
  half4 c = S(xy);
  float s = p[1];
  float gx = lum(float3(S(xy + float2(s, 0)).rgb)) - lum(float3(S(xy - float2(s, 0)).rgb));
  float gy = lum(float3(S(xy + float2(0, s)).rgb)) - lum(float3(S(xy - float2(0, s)).rgb));
  float3 n = normalize(float3(-gx * p[0], -gy * p[0], 1.0));
  float3 L = normalize(float3(cos(radians(p[2])), -sin(radians(p[2])), 0.8));
  float diff = clamp(dot(n, L), 0.0, 1.0);
  float spec = pow(clamp(dot(n, normalize(L + float3(0, 0, 1))), 0.0, 1.0), 100.0 / p[4] * 4.0) * p[3] / 100.0;
  float3 o = unp(c) * (0.45 + 0.75 * diff) + spec;
  return pre(clamp(o, 0.0, 1.0), float(c.a));`),

  kern("ec.stylize.texturize", [P("contrast", "Contrast", 0, 4, 1, 0.05), P("scale", "Texture Scale", 1, 500, 20), P("angle", "Light Direction", -360, 360, 135, 1, "°"), P("type", "Texture (0 Paper, 1 Canvas, 2 Stucco)", 0, 2, 0)], `
  float2 q = (xy - box.xy) / max(p[1], 1.0);
  float h = p[3] < 0.5 ? fbm(q * 3.0) : p[3] < 1.5 ? 0.5 + 0.25 * sin(q.x * 6.2831853) + 0.25 * sin(q.y * 6.2831853) : vnoise(q * 2.0);
  float hx = p[3] < 0.5 ? fbm((q + float2(0.02, 0.0)) * 3.0) : p[3] < 1.5 ? 0.5 + 0.25 * sin((q.x + 0.02) * 6.2831853) + 0.25 * sin(q.y * 6.2831853) : vnoise((q + float2(0.02, 0.0)) * 2.0);
  float hy = p[3] < 0.5 ? fbm((q + float2(0.0, 0.02)) * 3.0) : p[3] < 1.5 ? 0.5 + 0.25 * sin(q.x * 6.2831853) + 0.25 * sin((q.y + 0.02) * 6.2831853) : vnoise((q + float2(0.0, 0.02)) * 2.0);
  float3 n = normalize(float3(-(hx - h) * 20.0 * p[0], -(hy - h) * 20.0 * p[0], 1.0));
  float3 L = normalize(float3(cos(radians(p[2])), -sin(radians(p[2])), 0.9));
  half4 c = S(xy);
  float lit = 0.6 + 0.6 * clamp(dot(n, L), 0.0, 1.0);
  return pre(clamp(unp(c) * lit, 0.0, 1.0), float(c.a));`),

  kern("ec.stylize.ccburnfilm", [P("burn", "Burn", 0, 100, 40), P("center", "Center", -100, 200, 50, 0.5, "%"), P("random", "Random Seed", 0, 1000, 1)], `
  half4 c = S(xy);
  float2 u = uv(xy) - 0.5;
  float n = fbm((xy - box.xy) / 40.0 + p[2]);
  float edge = length(u) * 1.6 + (n - 0.5) * 0.8 - 1.0 + p[0] / 100.0 * 1.4;
  float a = 1.0 - smoothstep(0.0, 0.08, edge);
  float3 o = mix(unp(c), float3(1.0, 0.45, 0.1), smoothstep(-0.2, 0.0, edge) * 0.8);
  return pre(o, float(c.a) * a);`),

  kern("ec.stylize.ccglass", [P("softness", "Softness", 0.5, 30, 4, 0.5), P("height", "Bump Height", 0, 100, 20), P("displacement", "Displacement", 0, 200, 20), P("shine", "Shine", 0, 100, 30)], `
  float s = p[0];
  float l0 = lum(float3(S(xy).rgb));
  float gx = lum(float3(S(xy + float2(s, 0)).rgb)) - lum(float3(S(xy - float2(s, 0)).rgb));
  float gy = lum(float3(S(xy + float2(0, s)).rgb)) - lum(float3(S(xy - float2(0, s)).rgb));
  float2 g = float2(gx, gy) * p[1] / 10.0;
  half4 c = S(xy + g * p[2]);
  float spec = pow(clamp(dot(normalize(float3(-g, 1.0)), normalize(float3(-0.4, -0.5, 0.8))), 0.0, 1.0), 24.0) * p[3] / 100.0;
  return half4(c.rgb + half3(spec) * c.a, c.a);`, { outset: (v) => v.displacement }),

  // Generate -----------------------------------------------------------------------------------------
  over("ec.generate.ccthreads", [P("width", "Thread Width", 1, 100, 8), P("gap", "Gap", 0, 100, 2), HUE("hueA", "Warp Color (hue)", 200), HUE("hueB", "Weft Color (hue)", 30), OP, P("shade", "Shading", 0, 1, 0.6, 0.01)], `
  float2 q = (xy - box.xy) / (p[0] + p[1]);
  float2 c = floor(q), f = fract(q);
  float over = mod(c.x + c.y, 2.0);
  float inX = step(f.x * (p[0] + p[1]), p[0]), inY = step(f.y * (p[0] + p[1]), p[0]);
  float warp = inX * (over > 0.5 ? 1.0 : 0.0), weft = inY * (over > 0.5 ? 0.0 : 1.0);
  float3 col = warp > 0.5 ? hsv2rgb(float3(p[2] / 360.0, 0.6, 0.9)) : hsv2rgb(float3(p[3] / 360.0, 0.6, 0.9));
  float shade = 1.0 - p[5] * 0.5 * (warp > 0.5 ? abs(f.x - 0.5) : abs(f.y - 0.5)) * 2.0;
  return tint(col * shade, max(warp, weft) * p[4] / 100.0);`),

  over("ec.generate.advancedlightning", [P("x1", "Start X", -100, 200, 10, 0.5, "%"), P("y1", "Start Y", -100, 200, 50, 0.5, "%"), P("x2", "End X", -100, 200, 90, 0.5, "%"), P("y2", "End Y", -100, 200, 50, 0.5, "%"), P("roughness", "Roughness", 0, 100, 40), P("width", "Core Width", 0.5, 50, 2, 0.5), P("glow", "Glow Radius", 0, 200, 20), HUE("hue", "Color (hue)", 210), P("phase", "Phase", -3600, 3600, 0, 1, "°"), OP], `
  float2 a = box.xy + box.zw * float2(p[0], p[1]) / 100.0, b = box.xy + box.zw * float2(p[2], p[3]) / 100.0;
  float2 ab = b - a; float len = max(length(ab), 1.0); float2 d = ab / len, n = float2(-d.y, d.x);
  float t = clamp(dot(xy - a, d) / len, 0.0, 1.0);
  float ph = floor(radians(p[8]) * 4.0);
  float jag = (fbm(float2(t * 14.0, ph)) - 0.5) * 2.0 + (vnoise(float2(t * 40.0, ph + 3.0)) - 0.5) * 0.7;
  float off = jag * p[4] / 100.0 * len * 0.18 * sin(t * PI);
  float dist = abs(dot(xy - a, n) - off);
  float core = exp(-pow(dist / max(p[5], 0.5), 2.0));
  float halo = exp(-dist / max(p[6], 0.5)) * 0.6;
  float3 col = mix(hsv2rgb(float3(p[7] / 360.0, 0.7, 1.0)), float3(1.0), core);
  return tint(col, clamp(core + halo, 0.0, 1.0) * p[9] / 100.0);`),

  over("ec.sim.ccsnowfall", [P("size", "Flake Size", 2, 80, 12), P("amount", "Amount", 0, 1, 0.35, 0.01), P("phase", "Fall Phase", -36000, 36000, 0, 1, "°"), P("seed", "Seed", 0, 1000, 1), P("wind", "Wind", -100, 100, 10), OP], `
  float a = 0.0;
  for (int L = 0; L < 3; L++) {
    float s = p[0] * (1.0 + float(L) * 0.8);
    float2 q = (xy - box.xy) / s;
    q.y -= radians(p[2]) * (0.35 + float(L) * 0.2);
    q.x += sin(q.y * 0.7 + float(L)) * 0.25 + q.y * p[4] / 100.0 * 0.2;
    float2 i = floor(q), f = fract(q);
    float2 r = hash22(i + float(L) * 7.3 + p[3]);
    if (r.x < p[1]) { float2 c = 0.2 + 0.6 * hash22(i + 3.1); a = max(a, 1.0 - smoothstep(0.07, 0.16, length(f - c))); }
  }
  return tint(float3(1.0), a * p[5] / 100.0);`),

  over("ec.sim.ccrainfall", [P("drops", "Drops", 0, 1, 0.3, 0.01), P("size", "Cell Size", 4, 100, 24), P("phase", "Fall Phase", -36000, 36000, 0, 1, "°"), P("angle", "Wind Angle", -45, 45, 8, 1, "°"), P("length", "Streak Length", 0.1, 4, 1.5, 0.05), OP, P("seed", "Seed", 0, 1000, 1)], `
  float a = 0.0;
  for (int L = 0; L < 3; L++) {
    float s = p[1] * (1.0 + float(L) * 0.6);
    float2 q = rot(xy - box.xy, radians(p[3])) / s;
    q.y -= radians(p[2]) * (1.0 + float(L) * 0.5);
    float2 i = floor(q), f = fract(q);
    float2 r = hash22(i + float(L) * 5.1 + p[6]);
    if (r.x < p[0]) { float x = 0.15 + 0.7 * r.y; float inY = step(0.0, f.y) * (1.0 - smoothstep(0.0, 0.5 / max(p[4], 0.1), abs(f.y - 0.5) * 1.0)); a = max(a, (1.0 - smoothstep(0.0, 0.035, abs(f.x - x))) * inY * 0.8); }
  }
  return tint(float3(0.8, 0.88, 1.0), a * p[5] / 100.0);`),

  over("ec.sim.ccbubbles", [P("size", "Bubble Size", 4, 200, 40), P("amount", "Amount", 0, 1, 0.3, 0.01), P("phase", "Rise Phase", -36000, 36000, 0, 1, "°"), P("seed", "Seed", 0, 1000, 1), OP], `
  float a = 0.0, rim = 0.0;
  for (int L = 0; L < 2; L++) {
    float s = p[0] * (1.0 + float(L) * 0.7);
    float2 q = (xy - box.xy) / s;
    q.y += radians(p[2]) * (0.25 + float(L) * 0.15);
    q.x += sin(q.y * 1.3 + float(L)) * 0.2;
    float2 i = floor(q), f = fract(q);
    float2 r = hash22(i + float(L) * 9.7 + p[3]);
    if (r.x < p[1]) { float2 c = 0.25 + 0.5 * hash22(i + 1.7); float rad = 0.12 + 0.12 * r.y; float d = length(f - c) / rad; a = max(a, step(d, 1.0) * 0.15); rim = max(rim, smoothstep(0.82, 1.0, d) * (1.0 - smoothstep(1.0, 1.08, d))); }
  }
  return tint(float3(0.85, 0.95, 1.0), clamp(a + rim * 0.8, 0.0, 1.0) * p[4] / 100.0);`),

  over("ec.sim.ccdrizzle", [P("drops", "Drops", 0, 1, 0.25, 0.01), P("size", "Cell Size", 4, 100, 30), P("phase", "Phase", -36000, 36000, 0, 1, "°"), P("seed", "Seed", 0, 1000, 1), OP], `
  float2 q = (xy - box.xy) / p[1];
  float2 i = floor(q), f = fract(q);
  float2 r = hash22(i + p[3]);
  float life = fract(r.y + radians(p[2]) / 6.2831853);
  float2 c = 0.2 + 0.6 * hash22(i + 2.3);
  float d = length(f - c);
  float ring = (1.0 - smoothstep(0.0, 0.03, abs(d - life * 0.45))) * (1.0 - life);
  float a = r.x < p[0] ? ring : 0.0;
  return tint(float3(0.85, 0.92, 1.0), a * p[4] / 100.0);`),

  over("ec.sim.ccstarburst", [P("size", "Star Size", 1, 40, 6, 0.5), P("amount", "Amount", 0, 1, 0.4, 0.01), P("phase", "Twinkle Phase", -36000, 36000, 0, 1, "°"), P("seed", "Seed", 0, 1000, 1), OP], `
  float s = p[0] * 6.0;
  float2 q = (xy - box.xy) / s;
  float2 i = floor(q), f = fract(q);
  float2 r = hash22(i + p[3]);
  float2 c = 0.2 + 0.6 * hash22(i + 4.4);
  float tw = 0.5 + 0.5 * sin(radians(p[2]) + r.y * 6.2831853);
  float2 d = abs(f - c);
  float spike = max(0.0, 1.0 - (d.x * 14.0 + d.y * 1.5)) + max(0.0, 1.0 - (d.y * 14.0 + d.x * 1.5));
  float core = 1.0 - smoothstep(0.0, 0.08, length(f - c));
  float a = r.x < p[1] ? clamp(spike * 0.7 + core, 0.0, 1.0) * tw : 0.0;
  return tint(float3(1.0, 0.97, 0.85), a * p[4] / 100.0);`),

  over("ec.sim.caustics", [P("scale", "Scale", 5, 500, 80), P("phase", "Phase", -36000, 36000, 0, 1, "°"), P("brightness", "Brightness", 0, 300, 100), P("sharp", "Sharpness", 0.5, 8, 3, 0.1), HUE("hue", "Tint (hue)", 190), P("opacity", "Opacity", 0, 100, 60)], `
  float2 q = (xy - box.xy) / p[0];
  float t = radians(p[1]) * 0.5;
  float v = 0.0;
  for (int k = 0; k < 3; k++) {
    float fk = float(k) + 1.0;
    float2 w = q * fk + float2(sin(t * fk + q.y * 1.7), cos(t * fk * 0.8 + q.x * 1.9)) * 0.6;
    v += 1.0 - abs(2.0 * vnoise(w * 1.7 + float2(t * 0.3, -t * 0.2)) - 1.0);
  }
  v = pow(clamp(v / 3.0, 0.0, 1.0), p[3]) * p[2] / 100.0;
  return tint(mix(float3(1.0), hsv2rgb(float3(p[4] / 360.0, 0.5, 1.0)), 0.5), clamp(v, 0.0, 1.0) * p[5] / 100.0);`),

  // Transition ---------------------------------------------------------------------------------------
  kern("ec.transition.cclightwipe", [P("completion", "Completion", 0, 100, 50), P("direction", "Direction", -360, 360, 90, 1, "°"), P("intensity", "Light Intensity", 0, 300, 100), P("edge", "Edge Thickness", 1, 500, 40), HUE("hue", "Light Color (hue)", 40), P("shape", "Shape (0 Linear, 1 Radial)", 0, 1, 0)], `
  half4 c = S(xy);
  float a = radians(p[1]); float2 d = float2(sin(a), -cos(a));
  float2 q = xy - ctr();
  float ext = p[5] > 0.5 ? length(box.zw) * 0.5 : abs(box.z * d.x) + abs(box.w * d.y);
  float t = p[5] > 0.5 ? length(q) : dot(q, d) + ext * 0.5;
  float thr = (ext + p[3]) * p[0] / 100.0 - p[3] * 0.5;
  float m = smoothstep(thr - p[3] * 0.5, thr + p[3] * 0.5 + 0.001, t);
  m = p[0] <= 0.0 ? 1.0 : m;
  float glow = exp(-pow((t - thr) / max(p[3] * 0.6, 1.0), 2.0)) * p[2] / 100.0 * step(0.001, p[0]) * step(p[0], 99.9);
  float3 lc = hsv2rgb(float3(p[4] / 360.0, 0.5, 1.0));
  half4 base = c * half(m);
  return half4(clamp(base.rgb + half3(lc * glow) * half(max(c.a, 0.0)), 0.0, 1.0), clamp(base.a + half(glow * 0.0), 0.0, 1.0));`),

  over("ec.stylize.ccblockload", [P("completion", "Completion", 0, 100, 50), P("block", "Block Size", 2, 300, 24), P("seed", "Seed", 0, 1000, 1), P("scan", "Scan Rows (0 Random, 1 Scanline)", 0, 1, 1), P("feather", "Feather", 0, 1, 0.1, 0.01)], wipeBody(`
  float2 c = floor((xy - box.xy) / max(p[1], 1.0));
  float rows = max(floor(box.w / max(p[1], 1.0)), 1.0), cols = max(floor(box.z / max(p[1], 1.0)), 1.0);
  float order = p[3] > 0.5 ? (c.y * cols + c.x) / (rows * cols) : hash21(c + p[2]);
  float m = 1.0 - smoothstep(p[0] / 100.0 - p[4], p[0] / 100.0 + 0.0001, order);
  m = p[0] <= 0.0 ? 1.0 : m;`), "dstin"),
];
