// Generators (drawn over the node where it has pixels), masks for the transitions, and the
// Expression Controls (which only carry values).

import type { FxDef } from "@/animation/fx/library";
import { P, carrier, over, wipeBody } from "@/animation/fx/kit";

const HUE = (id: string, label: string, def: number) => P(id, label, 0, 360, def, 1, "°");
const OP = P("opacity", "Opacity", 0, 100, 100, 1, "%");
const CX = P("centerX", "Center X", -100, 200, 50, 0.5, "%");
const CY = P("centerY", "Center Y", -100, 200, 50, 0.5, "%");

export const GEN_FX: FxDef[] = [
  over("ec.generate.fourcolor", [HUE("h1", "Color 1 (hue)", 0), HUE("h2", "Color 2 (hue)", 60), HUE("h3", "Color 3 (hue)", 200), HUE("h4", "Color 4 (hue)", 300), OP], `
  float2 u = uv(xy);
  float3 a = hsv2rgb(float3(p[0] / 360.0, 0.8, 1.0)), b = hsv2rgb(float3(p[1] / 360.0, 0.8, 1.0));
  float3 c = hsv2rgb(float3(p[2] / 360.0, 0.8, 1.0)), d = hsv2rgb(float3(p[3] / 360.0, 0.8, 1.0));
  return tint(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), p[4] / 100.0);`),

  over("ec.generate.ellipse", [P("width", "Width", 1, 4000, 200), P("height", "Height", 1, 4000, 120), P("thickness", "Thickness (0 Filled)", 0, 500, 0), P("softness", "Softness", 0, 100, 0, 1, "%"), HUE("hue", "Color (hue)", 0), OP, CX, CY], `
  float2 c = box.xy + box.zw * float2(p[6], p[7]) / 100.0;
  float2 q = (xy - c) / (float2(p[0], p[1]) * 0.5);
  float d = length(q);
  float soft = max(p[3] / 100.0, 0.002);
  float outer = 1.0 - smoothstep(1.0 - soft, 1.0, d);
  float inner = p[2] > 0.0 ? smoothstep(1.0 - p[2] / max(min(p[0], p[1]) * 0.5, 1.0) - soft, 1.0 - p[2] / max(min(p[0], p[1]) * 0.5, 1.0), d) : 1.0;
  return tint(hsv2rgb(float3(p[4] / 360.0, 0.8, 1.0)), outer * inner * p[5] / 100.0);`),

  over("ec.generate.beam", [P("x1", "Starting Point X", -100, 200, 20, 0.5, "%"), P("y1", "Starting Point Y", -100, 200, 50, 0.5, "%"), P("x2", "Ending Point X", -100, 200, 80, 0.5, "%"), P("y2", "Ending Point Y", -100, 200, 50, 0.5, "%"), P("thickness", "Thickness", 0.5, 300, 6, 0.5), P("softness", "Softness", 0, 100, 40, 1, "%"), HUE("hue", "Inside Color (hue)", 200), OP], `
  float2 a = box.xy + box.zw * float2(p[0], p[1]) / 100.0, b = box.xy + box.zw * float2(p[2], p[3]) / 100.0;
  float2 ab = b - a; float t = clamp(dot(xy - a, ab) / max(dot(ab, ab), 1e-4), 0.0, 1.0);
  float d = length(xy - (a + ab * t)) / max(p[4], 0.5);
  float m = 1.0 - smoothstep(1.0 - p[5] / 100.0, 1.0 + 0.001, d);
  return tint(mix(float3(1.0), hsv2rgb(float3(p[6] / 360.0, 0.7, 1.0)), smoothstep(0.0, 1.0, d)), m * p[7] / 100.0);`),

  over("ec.generate.cellpattern", [P("size", "Size", 2, 1000, 60), P("disperse", "Disperse", 0, 1, 1, 0.01), P("contrast", "Contrast", 0, 400, 100), P("evolution", "Evolution", -3600, 3600, 0, 1, "°"), OP], `
  float2 q = (xy - box.xy) / max(p[0], 1.0);
  float2 i = floor(q), f = fract(q);
  float dmin = 8.0;
  for (int y = -1; y <= 1; y++) { for (int x = -1; x <= 1; x++) {
    float2 g = float2(float(x), float(y));
    float2 o = hash22(i + g);
    o = 0.5 + p[1] * (0.5 + 0.5 * sin(radians(p[3]) + 6.2831853 * o) - 0.5);
    dmin = min(dmin, length(g + o - f));
  } }
  float v = clamp((dmin - 0.5) * p[2] / 100.0 + 0.5, 0.0, 1.0);
  return tint(float3(v), p[4] / 100.0);`),

  over("ec.generate.lensflare", [CX, CY, P("brightness", "Flare Brightness", 0, 300, 100, 1, "%"), P("ghosts", "Ghosts", 0, 8, 4)], `
  float2 c = box.xy + box.zw * float2(p[0], p[1]) / 100.0;
  float R = max(length(box.zw) * 0.5, 1.0);
  float2 axis = ctr() - c;
  float3 col = float3(0.0);
  float d0 = length(xy - c) / R;
  col += float3(1.0, 0.95, 0.8) * (0.04 / (d0 * d0 + 0.02));
  for (int i = 1; i < 9; i++) {
    if (float(i) > p[2]) { break; }
    float2 g = c + axis * (float(i) * 0.5 - 0.2);
    float r = length(xy - g) / (R * (0.05 + 0.02 * float(i)));
    float disc = 1.0 - smoothstep(0.7, 1.0, r);
    col += hsv2rgb(float3(fract(float(i) * 0.17), 0.5, 1.0)) * disc * 0.25;
  }
  col *= p[1] / 100.0;
  return tint(clamp(col, 0.0, 1.0), clamp(max(col.r, max(col.g, col.b)), 0.0, 1.0));`),

  over("ec.generate.fractal", [P("set", "Set (0 Mandelbrot, 1 Julia)", 0, 1, 0), P("zoom", "Zoom", 0.1, 1000, 1, 0.1), P("cre", "Center Real", -2, 2, -0.5, 0.01), P("cim", "Center Imaginary", -2, 2, 0, 0.01), P("iterations", "Iterations", 8, 64, 32), P("juliaRe", "Julia Real", -2, 2, -0.8, 0.01), P("juliaIm", "Julia Imaginary", -2, 2, 0.156, 0.01), OP], `
  float2 u = (uv(xy) - 0.5) * float2(box.z / max(box.w, 1.0), 1.0) * 3.0 / max(p[1], 0.01);
  float2 z = u + float2(p[2], p[3]);
  float2 cc = p[0] < 0.5 ? z : float2(p[5], p[6]);
  float n = 0.0;
  for (int i = 0; i < 64; i++) {
    if (float(i) >= p[4]) { break; }
    if (dot(z, z) > 16.0) { break; }
    z = float2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + cc;
    n += 1.0;
  }
  float t = n / max(p[4], 1.0);
  float3 col = n >= p[4] ? float3(0.0) : hsv2rgb(float3(fract(0.65 + t * 2.0), 0.8, 1.0));
  return tint(col, p[7] / 100.0);`),

  over("ec.noise.turbulent", [P("scale", "Scale", 5, 2000, 100), P("contrast", "Contrast", 0, 400, 100), P("opacity", "Opacity", 0, 100, 50), P("evolution", "Evolution", -3600, 3600, 0, 1, "°")], `
  float2 q = (xy - box.xy) / max(p[0], 1.0);
  float e = radians(p[3]);
  float n = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { n += a * abs(2.0 * vnoise(q + float2(e * 0.5, e * 0.3)) - 1.0); q *= 2.0; a *= 0.5; }
  n = clamp((n - 0.35) * p[1] / 100.0 + 0.5, 0.0, 1.0);
  return tint(float3(n), p[2] / 100.0);`),

  over("ec.noise.curlnoise", [P("scale", "Scale", 5, 2000, 120), P("opacity", "Opacity", 0, 100, 50), P("evolution", "Evolution", -3600, 3600, 0, 1, "°"), P("strength", "Strength", 0, 10, 2, 0.1)], `
  float2 q = (xy - box.xy) / max(p[0], 1.0);
  float e = radians(p[2]) * 0.4;
  float e1 = fbm(q + float2(0.01, 0.0) + e), e2 = fbm(q - float2(0.01, 0.0) + e);
  float e3 = fbm(q + float2(0.0, 0.01) + e), e4 = fbm(q - float2(0.0, 0.01) + e);
  float2 curl = float2(e3 - e4, -(e1 - e2)) * 50.0 * p[3];
  return tint(0.5 + 0.5 * float3(curl, -curl.x * curl.y), p[1] / 100.0);`),

  // Masks (dstin): 1 keeps the node
  over("ec.transition.ccgridwipe", [P("completion", "Completion", 0, 100, 50), P("tile", "Tile Size", 4, 500, 50), P("feather", "Feather", 0, 1, 0.1, 0.01)], wipeBody(`
  float2 g = fract((xy - box.xy) / max(p[1], 1.0));
  float d = max(abs(g.x - 0.5), abs(g.y - 0.5)) * 2.0;
  float lim = 1.0 - p[0] / 100.0;
  float m = 1.0 - smoothstep(lim - p[2], lim + 0.0001, d);
  m = p[0] <= 0.0 ? 1.0 : m;`), "dstin"),

  over("ec.transition.ccjaws", [P("completion", "Completion", 0, 100, 50), P("direction", "Direction", -360, 360, 0, 1, "°"), P("jagHeight", "Jag Height", 0, 200, 30), P("jagWidth", "Jag Width", 1, 300, 40)], wipeBody(`
  float a = radians(p[1]); float2 d = float2(cos(a), sin(a)), n = float2(-d.y, d.x);
  float2 q = xy - ctr();
  float along = dot(q, d), across = dot(q, n);
  float ext = abs(box.z * n.x) + abs(box.w * n.y);
  float tri = abs(fract(along / max(p[3], 1.0)) - 0.5) * 2.0 * p[2];
  float gap = (ext * 0.5 + p[2]) * p[0] / 100.0;
  float m = abs(across) - tri > gap ? 1.0 : 0.0;
  m = p[0] <= 0.0 ? 1.0 : m;`), "dstin"),

  over("ec.transition.cclinesweep", [P("completion", "Completion", 0, 100, 50), P("direction", "Direction", -360, 360, 90, 1, "°"), P("thickness", "Thickness", 0, 500, 20), P("slant", "Slant", -100, 100, 0)], wipeBody(`
  float a = radians(p[1]); float2 d = float2(sin(a), -cos(a));
  float2 q = xy - ctr();
  q.x += q.y * p[3] / 100.0;
  float ext = abs(box.z * d.x) + abs(box.w * d.y);
  float t = dot(q, d) + ext * 0.5;
  float thr = (ext + p[2]) * p[0] / 100.0 - p[2] * 0.5;
  float m = smoothstep(thr - p[2] * 0.5, thr + p[2] * 0.5 + 0.001, t);
  m = p[0] <= 0.0 ? 1.0 : m;`), "dstin"),

  over("ec.transition.ccscalewipe", [P("completion", "Completion", 0, 100, 50), P("stretch", "Stretch", 0, 100, 50), P("direction", "Direction", -360, 360, 0, 1, "°")], wipeBody(`
  float a = radians(p[2]); float2 d = float2(cos(a), sin(a));
  float2 q = xy - ctr();
  float ext = abs(box.z * d.x) + abs(box.w * d.y);
  float t = dot(q, d) + ext * 0.5;
  float thr = ext * p[0] / 100.0;
  float m = t >= thr ? 1.0 : 0.0;
  m = p[0] <= 0.0 ? 1.0 : m;`), "dstin"),

  over("ec.transition.ccradialscalewipe", [P("completion", "Completion", 0, 100, 50), P("startAngle", "Start Angle", -360, 360, 0, 1, "°"), CX, CY, P("feather", "Feather", 0, 100, 5)], wipeBody(`
  float2 c = box.xy + box.zw * float2(p[2], p[3]) / 100.0;
  float2 q = xy - c;
  float a = mod(atan(q.x, -q.y) - radians(p[1]), 2.0 * PI) / (2.0 * PI);
  float f = max(p[4] / 100.0, 0.0001);
  float m = 1.0 - smoothstep(p[0] / 100.0 - f, p[0] / 100.0 + 0.0001, a);
  m = p[0] <= 0.0 ? 1.0 : m;`), "dstin"),

  // Expression Controls: no pixels, only values for expressions and scripts
  carrier("ec.control.slider", [P("slider", "Slider", -1000000, 1000000, 0, 0.1)]),
  carrier("ec.control.angle", [P("angle", "Angle", -36000, 36000, 0, 1, "°")]),
  carrier("ec.control.checkbox", [P("checkbox", "Checkbox", 0, 1, 0)]),
  carrier("ec.control.point", [P("x", "Point X", -100000, 100000, 0), P("y", "Point Y", -100000, 100000, 0)]),
  carrier("ec.control.point3d", [P("x", "3D Point X", -100000, 100000, 0), P("y", "3D Point Y", -100000, 100000, 0), P("z", "3D Point Z", -100000, 100000, 0)]),
  carrier("ec.control.color", [P("hue", "Color (hue)", 0, 360, 0, 1, "°"), P("saturation", "Color Saturation", 0, 100, 0), P("value", "Color Brightness", 0, 100, 100)]),
  carrier("ec.control.dropdown", [P("menu", "Menu", 1, 100, 1)]),
  carrier("ec.control.layer", [P("layer", "Layer", 0, 10000, 0)]),
  carrier("ec.utility.growbounds", [P("growth", "Growth", 0, 2000, 0)], (v) => v.growth),
];
