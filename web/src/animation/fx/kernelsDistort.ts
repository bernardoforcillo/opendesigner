// Distort and Stylize effects that RESAMPLE the node (fx/kit.ts::kern): each pixel is read from
// somewhere else in the node, so they need the node drawn offscreen first.

import type { FxDef } from "@/animation/fx/library";
import { P, kern } from "@/animation/fx/kit";

const CX = P("centerX", "Center X", -100, 200, 50, 0.5, "%");
const CY = P("centerY", "Center Y", -100, 200, 50, 0.5, "%");
// the effect's center in the node's local space
const C = "float2 c = box.xy + box.zw * float2(CX, CY) / 100.0;";
const withC = (body: string, ix: number) => `${C.replace("CX", `p[${ix}]`).replace("CY", `p[${ix + 1}]`)}\n${body}`;

export const DISTORT_FX: FxDef[] = [
  kern("ec.distort.wavewarp", [P("height", "Wave Height", 0, 500, 10, 0.5), P("width", "Wave Width", 1, 1000, 50), P("direction", "Direction", -360, 360, 90, 1, "°"), P("phase", "Phase", -3600, 3600, 0, 1, "°")], `
  float a = radians(p[2]); float2 d = float2(cos(a), sin(a)); float2 n = float2(-d.y, d.x);
  float t = dot(xy - box.xy, d) / max(p[1], 1.0) * 2.0 * PI - radians(p[3]);
  return S(xy + n * sin(t) * p[0]);`, { outset: (v) => v.height }),

  kern("ec.distort.ripple", [P("radius", "Radius", 1, 2000, 200), P("width", "Wave Width", 1, 500, 30), P("height", "Wave Height", 0, 300, 10, 0.5), P("phase", "Wave Phase", -3600, 3600, 0, 1, "°"), CX, CY], withC(`
  float2 q = xy - c; float r = length(q);
  float fall = clamp(1.0 - r / p[0], 0.0, 1.0);
  float k = sin(r / max(p[1], 1.0) * 2.0 * PI - radians(p[3])) * p[2] * fall;
  return S(xy + (r > 0.0 ? q / r : float2(0.0)) * k);`, 4), { outset: (v) => v.height }),

  kern("ec.distort.bulge", [P("radius", "Vertical Radius", 1, 2000, 150), P("amount", "Bulge Height", -1, 1, 0.5, 0.01), CX, CY], withC(`
  float2 q = xy - c; float r = length(q) / max(p[0], 1.0);
  float k = r < 1.0 ? 1.0 - p[1] * (1.0 - r * r) : 1.0;
  return S(c + q * k);`, 2)),

  kern("ec.distort.spherize", [P("radius", "Radius", 1, 2000, 150), P("amount", "Amount", 0, 1, 1, 0.01), CX, CY], withC(`
  float2 q = xy - c; float R = max(p[0], 1.0); float r = length(q);
  if (r >= R) { return S(xy); }
  float z = sqrt(1.0 - (r / R) * (r / R));
  float k = mix(1.0, (r > 0.0 ? asin(r / R) * R / r / (PI / 2.0) * 1.0 : 1.0), p[1]);
  return S(c + q * mix(1.0, k * 0.8 + z * 0.2, p[1]));`, 2)),

  kern("ec.distort.twirl", [P("angle", "Angle", -3600, 3600, 90, 1, "°"), P("radius", "Radius", 1, 2000, 150), CX, CY], withC(`
  float2 q = xy - c; float R = max(p[1], 1.0); float r = length(q);
  float f = clamp(1.0 - r / R, 0.0, 1.0);
  return S(c + rot(q, radians(p[0]) * f * f));`, 2)),

  kern("ec.distort.twirllegacy", [P("angle", "Angle", -3600, 3600, 90, 1, "°"), P("radius", "Radius", 1, 2000, 150), CX, CY], withC(`
  float2 q = xy - c; float R = max(p[1], 1.0); float r = length(q);
  float f = clamp(1.0 - r / R, 0.0, 1.0);
  return S(c + rot(q, radians(p[0]) * f));`, 2)),

  kern("ec.distort.polar", [P("type", "Type of Conversion (0 Rect to Polar, 1 Polar to Rect)", 0, 1, 0)], `
  float rad = min(box.z, box.w) * 0.5;
  if (p[0] < 0.5) {
    float2 q = (xy - ctr()) / max(rad, 1.0);
    float ang = atan(q.x, -q.y) / (2.0 * PI) + 0.5;
    return S(box.xy + float2(ang * box.z, length(q) * box.w));
  }
  float2 u = uv(xy);
  float ang = (u.x - 0.5) * 2.0 * PI;
  return S(ctr() + u.y * rad * float2(sin(ang), -cos(ang)));`),

  kern("ec.distort.mirror", [P("centerX", "Reflection Center X", -100, 200, 50, 0.5, "%"), P("centerY", "Reflection Center Y", -100, 200, 50, 0.5, "%"), P("angle", "Reflection Angle", -360, 360, 0, 1, "°")], `
  float2 c = box.xy + box.zw * float2(p[0], p[1]) / 100.0;
  float a = radians(p[2]); float2 n = float2(cos(a), sin(a));
  float d = dot(xy - c, n);
  return S(d < 0.0 ? xy - 2.0 * d * n : xy);`),

  kern("ec.distort.cctiler", [P("scale", "Scale", 5, 400, 50, 1, "%"), CX, CY], withC(`
  float2 size = box.zw * p[0] / 100.0;
  float2 t = (xy - c) / max(size, float2(1.0)) + 0.5;
  return S(box.xy + fract(t) * box.zw);`, 1), { outset: (v) => 400 / Math.max(v.scale, 5) * 100 }),

  kern("ec.stylize.motiontile", [
    P("tileW", "Tile Width", 5, 400, 100, 1, "%"), P("tileH", "Tile Height", 5, 400, 100, 1, "%"),
    P("outW", "Output Width", 5, 1000, 300, 1, "%"), P("outH", "Output Height", 5, 1000, 300, 1, "%"),
    P("mirror", "Mirror Edges", 0, 1, 0), P("phase", "Phase", -3600, 3600, 0, 1, "°"),
  ], `
  float2 hf = box.zw * float2(p[2], p[3]) / 200.0;
  float2 q = xy - ctr();
  if (abs(q.x) > hf.x || abs(q.y) > hf.y) { return half4(0.0); }
  float2 size = box.zw * float2(p[0], p[1]) / 100.0;
  float2 t = q / max(size, float2(1.0)) + 0.5;
  t.x += radians(p[5]) / (2.0 * PI);
  if (p[4] > 0.5) { t = abs(mod(t, 2.0) - 1.0); } else { t = fract(t); }
  return S(box.xy + t * box.zw);`, { outset: (v) => Math.max(v.outW, v.outH) * 5 }),

  kern("ec.distort.magnify", [P("size", "Size", 1, 1000, 100), P("magnification", "Magnification", 100, 1000, 200, 1, "%"), CX, CY], withC(`
  float2 q = xy - c; float r = length(q);
  float k = r < p[0] ? 100.0 / max(p[1], 100.0) : 1.0;
  return S(c + q * k);`, 2)),

  kern("ec.distort.opticscompensation", [P("amount", "Field of View", -100, 100, 30), P("reverse", "Reverse Lens Distortion", 0, 1, 0)], `
  float2 h = box.zw * 0.5; float R = max(length(h), 1.0);
  float2 q = (xy - ctr()) / R; float r2 = dot(q, q);
  float k = (p[1] > 0.5 ? -1.0 : 1.0) * p[0] / 100.0;
  return S(ctr() + q * (1.0 + k * r2) * R);`),

  kern("ec.distort.ccslant", [P("slant", "Slant", -100, 100, 0), P("height", "Height", 0, 100, 100, 1, "%")], `
  return S(float2(xy.x - (xy.y - ctr().y) * p[0] / 100.0, xy.y));`, { outset: (v) => Math.abs(v.slant) * 5 }),

  kern("ec.distort.turbulentdisplace", [P("amount", "Amount", 0, 1000, 50), P("size", "Size", 1, 1000, 100), P("evolution", "Evolution", -3600, 3600, 0, 1, "°"), P("offset", "Offset", -1000, 1000, 0)], `
  float2 q = (xy - box.xy + p[3]) / max(p[1], 1.0) + radians(p[2]) * 0.3;
  float2 n = float2(fbm(q), fbm(q + 17.3)) - 0.5;
  return S(xy + n * 2.0 * p[0]);`, { outset: (v) => v.amount }),

  kern("ec.stylize.roughenedges", [P("border", "Border", 0, 200, 8, 0.5), P("scale", "Scale", 1, 500, 40), P("evolution", "Evolution", -3600, 3600, 0, 1, "°"), P("sharpness", "Edge Sharpness", 0, 1, 0.6, 0.01)], `
  float2 q = (xy - box.xy) / max(p[1], 1.0) + radians(p[2]) * 0.3;
  float2 n = float2(fbm(q), fbm(q + 31.7)) - 0.5;
  half4 c = S(xy + n * 2.0 * p[0]);
  float a = smoothstep(0.5 - p[3] * 0.5, 0.5 + p[3] * 0.5, float(c.a));
  return half4(c.rgb * half(a), half(a * c.a));`, { outset: (v) => v.border }),

  kern("ec.stylize.scatter", [P("amount", "Scatter Amount", 0, 1000, 10, 0.5), P("grain", "Grain (0 Both, 1 Horizontal, 2 Vertical)", 0, 2, 0), P("seed", "Seed", 0, 1000, 1)], `
  float2 r = (hash22(floor(xy) + p[2]) - 0.5) * 2.0 * p[0];
  if (p[1] > 0.5 && p[1] < 1.5) { r.y = 0.0; }
  if (p[1] > 1.5) { r.x = 0.0; }
  return S(xy + r);`, { outset: (v) => v.amount }),

  kern("ec.stylize.cckaleida", [P("sectors", "Sectors", 2, 32, 6), P("rotation", "Rotation", -3600, 3600, 0, 1, "°"), P("size", "Zoom", 1, 400, 100, 1, "%"), CX, CY], withC(`
  float2 q = xy - c; float r = length(q) * 100.0 / max(p[2], 1.0);
  float seg = 2.0 * PI / max(floor(p[0]), 2.0);
  float a = atan(q.y, q.x) - radians(p[1]);
  a = mod(a, seg); a = abs(a - seg * 0.5);
  float b = a + radians(p[1]);
  return S(c + r * float2(cos(b), sin(b)));`, 3)),

  kern("ec.stylize.mosaic", [P("h", "Horizontal Blocks", 1, 200, 10), P("v", "Vertical Blocks", 1, 200, 10)], `
  float2 bs = box.zw / max(float2(p[0], p[1]), float2(1.0));
  return S(box.xy + (floor((xy - box.xy) / bs) + 0.5) * bs);`),

  kern("ec.distort.transform", [
    P("x", "Position X", -2000, 2000, 0), P("y", "Position Y", -2000, 2000, 0), P("scale", "Scale", 1, 1000, 100, 1, "%"),
    P("rotation", "Rotation", -3600, 3600, 0, 1, "°"), P("skew", "Skew", -85, 85, 0, 1, "°"), P("opacity", "Opacity", 0, 100, 100, 1, "%"),
  ], `
  float2 q = xy - ctr() - float2(p[0], p[1]);
  q = rot(q, -radians(p[3]));
  q.x -= q.y * tan(radians(p[4]));
  q = q * 100.0 / max(p[2], 1.0);
  half4 c = S(ctr() + q);
  return c * half(p[5] / 100.0);`, { outset: (v) => Math.hypot(v.x, v.y) + 100 * Math.max(0, v.scale - 100) / 100 }),

  kern("ec.distort.displacementmap", [P("maxX", "Max Horizontal Displacement", -500, 500, 20), P("maxY", "Max Vertical Displacement", -500, 500, 20)], `
  // the node's own luminance is the map
  half4 c = S(xy);
  float m = lum(unp(c)) - 0.5;
  return S(xy + float2(p[0], p[1]) * m * 2.0);`, { outset: (v) => Math.max(Math.abs(v.maxX), Math.abs(v.maxY)) }),

  kern("ec.distort.warp", [P("style", "Warp Style (0 Flag, 1 Wave, 2 Fish)", 0, 2, 0), P("bend", "Bend", -100, 100, 50), P("h", "Horizontal Distortion", -100, 100, 0), P("v", "Vertical Distortion", -100, 100, 0)], `
  float2 u = uv(xy);
  float b = p[1] / 100.0;
  float2 d = float2(0.0);
  if (p[0] < 0.5) { d.y = sin(u.x * 2.0 * PI) * b * 0.15; }
  else if (p[0] < 1.5) { d.y = sin(u.x * PI) * b * 0.3; }
  else { float2 q = u - 0.5; d = q * (1.0 - dot(q, q) * 4.0) * b * 0.5; }
  u += d + float2(p[2], p[3]) / 100.0 * (u.yx - 0.5) * 0.3;
  return S(box.xy + u * box.zw);`, { outset: (v) => 60 + Math.abs(v.bend) * 2 }),

  kern("ec.distort.cornerpin", [
    P("tlx", "Upper Left X", -1000, 1000, 0), P("tly", "Upper Left Y", -1000, 1000, 0), P("trx", "Upper Right X", -1000, 1000, 0), P("try", "Upper Right Y", -1000, 1000, 0),
    P("blx", "Lower Left X", -1000, 1000, 0), P("bly", "Lower Left Y", -1000, 1000, 0), P("brx", "Lower Right X", -1000, 1000, 0), P("bry", "Lower Right Y", -1000, 1000, 0),
  ], `
  // p[0..8] is the inverse homography (destination -> source unit square), row-major
  float3 d = float3((xy - box.xy) / max(box.zw, float2(1.0)), 1.0);
  float3 r = float3(dot(float3(p[0], p[1], p[2]), d), dot(float3(p[3], p[4], p[5]), d), dot(float3(p[6], p[7], p[8]), d));
  float2 s = r.xy / (abs(r.z) < 1e-6 ? 1e-6 : r.z);
  if (s.x < 0.0 || s.x > 1.0 || s.y < 0.0 || s.y > 1.0) { return half4(0.0); }
  return S(box.xy + s * box.zw);`, {
    outset: (v) => Math.max(...["tlx", "tly", "trx", "try", "blx", "bly", "brx", "bry"].map((k) => Math.abs(v[k]))),
    uniforms: (v) => {
      // the node's box is reported in the shader; the unit-square corners move by the offsets (in units of the box)
      // so the homography is computed in a size-independent way using 1000 as the reference box size.
      const ref = 1000;
      const q = [
        [v.tlx / ref, v.tly / ref], [1 + v.trx / ref, v.try / ref], [1 + v.brx / ref, 1 + v.bry / ref], [v.blx / ref, 1 + v.bly / ref],
      ];
      return invertHomography(unitSquareTo(q));
    },
  }),
];

// --- homography: unit square -> quad, and its inverse (3x3, row-major) -----------------

export function unitSquareTo(q: number[][]): number[] {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  const det = dx1 * dy2 - dx2 * dy1;
  const g = det === 0 ? 0 : (dx3 * dy2 - dx2 * dy3) / det;
  const h = det === 0 ? 0 : (dx1 * dy3 - dx3 * dy1) / det;
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1];
}

export function invertHomography(m: number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}
