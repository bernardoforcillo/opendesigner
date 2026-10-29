// THE TRACKING EFFECTS, with the tracking done BY HAND. The editor has no video to analyse, so the "track" is what you keyframe: the
// position of a feature at each moment, as ordinary effect parameters (percent of the node's box) that the timeline animates like
// any other. What these effects add is what an automatic tracker's solve would feed:
//   - Warp Stabilizer holds the node steady against the shake of a tracked point (and, with a second point, of its rotation and scale);
//   - 3D Camera Tracker pins the node onto a tracked plane: four corner points drive a perspective (corner-pin) warp;
//   - Face Track Points holds 13 facial landmarks and draws them (and the mesh between them);
//   - Face Measurements reads those landmarks, from the layer it names or the node itself, and draws what they measure.
// The smoothing the stabilizer and the pin offer is `derive` (library.ts): the same parameters averaged over a window of the clip.

import type { FxDef, FxValues } from "@/animation/fx/library";
import { P, kern, over } from "@/animation/fx/kit";

export const FACE_POINTS = "ec.utility.facetrackpoints";

const PCT = (id: string, label: string, def: number, min = -100, max = 200) => P(id, label, min, max, def, 0.1, "%");
const SMOOTH = (def: number) => P("smoothness", "Smoothness", 0, 4000, def, 10, "ms");

/** The average of the named parameters over a window of ±`w` ms around now (nine samples; `at(0)` is now). */
export function smoothed(ids: readonly string[], at: (dt: number) => FxValues, w: number): Record<string, number> {
  const out: Record<string, number> = {};
  if (w <= 0) return out;
  const N = 9;
  for (const id of ids) out[id] = 0;
  for (let i = 0; i < N; i++) {
    const v = at(-w + (2 * w * i) / (N - 1));
    for (const id of ids) out[id] += v[id] / N;
  }
  return out;
}

// --- Warp Stabilizer ----------------------------------------------------------------------------------------------------
const WARP = kern(
  "ec.distort.warpstabilizer",
  [
    PCT("trackX", "Track Point X", 50), PCT("trackY", "Track Point Y", 50),
    P("rotation", "Stabilize Rotation and Scale (second point)", 0, 1, 0), PCT("track2X", "Second Point X", 60), PCT("track2Y", "Second Point Y", 50),
    SMOOTH(600), P("strength", "Strength", 0, 100, 100, 1, "%"), P("zoom", "Zoom", 100, 300, 100, 1, "%"),
  ],
  `
  float2 T = box.xy + float2(p[0], p[1]) * 0.01 * box.zw;
  float2 Sm = box.xy + float2(p[2], p[3]) * 0.01 * box.zw;
  float2 vT = float2(p[4], p[5]) * 0.01 * box.zw;
  float2 vS = float2(p[6], p[7]) * 0.01 * box.zw;
  float st = p[8] * 0.01;
  float ang = 0.0; float sc = 1.0;
  if (p[9] > 0.5 && length(vT) > 0.5 && length(vS) > 0.5) {
    ang = (atan(vS.y, vS.x) - atan(vT.y, vT.x)) * st;
    sc = 1.0 + (length(vS) / length(vT) - 1.0) * st;
  }
  Sm = T + (Sm - T) * st;
  float2 c = box.xy + box.zw * 0.5;
  float2 q = c + (xy - c) / max(p[10] * 0.01, 0.01);
  float2 d = q - Sm;
  float ca = cos(-ang); float sa = sin(-ang);
  float2 r = float2(ca * d.x - sa * d.y, sa * d.x + ca * d.y) / max(sc, 0.01);
  return S(T + r);`,
  {
    slots: 12, outset: () => 120,
    uniforms: (v) => {
      const sx = v.sx ?? v.trackX, sy = v.sy ?? v.trackY;
      const s2x = v.s2x ?? v.track2X, s2y = v.s2y ?? v.track2Y;
      return [v.trackX, v.trackY, sx, sy, v.track2X - v.trackX, v.track2Y - v.trackY, s2x - sx, s2y - sy, v.strength, v.rotation, v.zoom];
    },
  },
);
const WARP_FX: FxDef = {
  ...WARP,
  derive: (v, at) => {
    const s = smoothed(["trackX", "trackY", "track2X", "track2Y"], at, v.smoothness);
    const out: Record<string, number> = {};
    if ("trackX" in s) { out.sx = s.trackX; out.sy = s.trackY; out.s2x = s.track2X; out.s2y = s.track2Y; }
    return out;
  },
};

// --- 3D Camera Tracker: a plane pin -------------------------------------------------------------------------------------
type M3 = [number, number, number, number, number, number, number, number, number];

/** The homography from the unit square (0,0)(1,0)(1,1)(0,1) onto the quad, and its inverse (row-major, scaled so the quad's centre has w > 0). */
export function quadInverse(q: readonly (readonly [number, number])[]): M3 | null {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  let a: number, b: number, d: number, e: number, g: number, h: number;
  if (Math.abs(dx3) < 1e-12 && Math.abs(dy3) < 1e-12) {
    a = x1 - x0; b = x3 - x0; d = y1 - y0; e = y3 - y0; g = 0; h = 0;
  } else {
    const den = dx1 * dy2 - dy1 * dx2;
    if (Math.abs(den) < 1e-12) return null;
    g = (dx3 * dy2 - dy3 * dx2) / den;
    h = (dx1 * dy3 - dy1 * dx3) / den;
    a = x1 - x0 + g * x1; b = x3 - x0 + h * x3; d = y1 - y0 + g * y1; e = y3 - y0 + h * y3;
  }
  const m: M3 = [a, b, x0, d, e, y0, g, h, 1];
  // adjugate = inverse up to scale
  const [A, B, C, D, E, F, G, H, I] = m;
  const det = A * (E * I - F * H) - B * (D * I - F * G) + C * (D * H - E * G);
  if (Math.abs(det) < 1e-12) return null;
  const inv: M3 = [E * I - F * H, C * H - B * I, B * F - C * E, F * G - D * I, A * I - C * G, C * D - A * F, D * H - E * G, B * G - A * H, A * E - B * D];
  const cx = (x0 + x1 + x2 + x3) / 4, cy = (y0 + y1 + y2 + y3) / 4;
  const z = inv[6] * cx + inv[7] * cy + inv[8];
  if (Math.abs(z) < 1e-12) return null;
  return z < 0 ? (inv.map((n) => -n) as M3) : inv;
}

const CORNERS = [["tl", "Top Left", 0, 0], ["tr", "Top Right", 100, 0], ["br", "Bottom Right", 100, 100], ["bl", "Bottom Left", 0, 100]] as const;
const CORNER_IDS = CORNERS.flatMap(([id]) => [`${id}X`, `${id}Y`]);

const PIN = kern(
  "ec.perspective.cameratracker",
  [
    ...CORNERS.flatMap(([id, label, x, y]) => [PCT(`${id}X`, `${label} X`, x), PCT(`${id}Y`, `${label} Y`, y)]),
    P("amount", "Amount", 0, 100, 100, 1, "%"), SMOOTH(0), P("showPoints", "Show Track Points", 0, 1, 0), P("pointSize", "Point Size", 2, 30, 8, 0.5, "px"),
  ],
  `
  float2 u = uv(xy);
  float3 hh = float3(p[0] * u.x + p[1] * u.y + p[2], p[3] * u.x + p[4] * u.y + p[5], p[6] * u.x + p[7] * u.y + p[8]);
  half4 o = half4(0.0);
  if (hh.z > 0.000001) {
    float2 su = hh.xy / hh.z;
    if (su.x >= 0.0 && su.x <= 1.0 && su.y >= 0.0 && su.y <= 1.0) { o = S(box.xy + su * box.zw); }
  }
  o = mix(S(xy), o, half(p[9] * 0.01));
  if (p[10] > 0.5) {
    for (int i = 0; i < 4; i++) {
      float2 c = box.xy + float2(p[12 + i * 2], p[13 + i * 2]) * 0.01 * box.zw;
      float ring = abs(length(xy - c) - p[11]) - 1.0;
      float m = 1.0 - smoothstep(0.0, 1.0, ring);
      o = o * half(1.0 - m) + half4(half(m), half(m * 0.85), half(0.1 * m), half(m));
    }
  }
  return o;`,
  {
    slots: 20, outset: () => 120,
    uniforms: (v) => {
      const q = CORNERS.map(([id]) => [v[`${id}X`] / 100, v[`${id}Y`] / 100] as const);
      const inv = quadInverse(q);
      // a degenerate quad (points on a line) leaves the node as it was
      const m: M3 = inv ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
      return [...m, inv ? v.amount : 0, v.showPoints, v.pointSize, ...CORNERS.flatMap(([id]) => [v[`${id}X`], v[`${id}Y`]])];
    },
  },
);
const PIN_FX: FxDef = {
  ...PIN,
  derive: (v, at) => smoothed(CORNER_IDS, at, v.smoothness),
};

// --- Face Track Points --------------------------------------------------------------------------------------------------
const LANDMARKS = [
  ["lEye", "Left Eye", 35, 38], ["rEye", "Right Eye", 65, 38], ["nose", "Nose Tip", 50, 55], ["mouthL", "Mouth Left", 40, 70], ["mouthR", "Mouth Right", 60, 70],
  ["lip1", "Upper Lip", 50, 67], ["lip2", "Lower Lip", 50, 74], ["chin", "Chin", 50, 88], ["lBrow", "Left Eyebrow", 35, 30], ["rBrow", "Right Eyebrow", 65, 30],
  ["lJaw", "Left Jaw", 25, 60], ["rJaw", "Right Jaw", 75, 60], ["fore", "Forehead", 50, 15],
] as const;
const L = Object.fromEntries(LANDMARKS.map(([id], i) => [id, i])) as Record<(typeof LANDMARKS)[number][0], number>;
const MESH: [keyof typeof L, keyof typeof L][] = [
  ["lEye", "rEye"], ["lEye", "nose"], ["rEye", "nose"], ["nose", "mouthL"], ["nose", "mouthR"], ["mouthL", "lip1"], ["mouthR", "lip1"], ["mouthL", "lip2"], ["mouthR", "lip2"],
  ["lip2", "chin"], ["lBrow", "lEye"], ["rBrow", "rEye"], ["lBrow", "rBrow"], ["lJaw", "chin"], ["rJaw", "chin"], ["lJaw", "mouthL"], ["rJaw", "mouthR"], ["fore", "lBrow"], ["fore", "rBrow"],
];
/** The SkSL for the landmark `i` of the `p[]` array (explicit constants: SkSL cannot index a uniform array by a variable). */
const pt = (i: number, base = 0) => `(box.xy + float2(p[${base + 2 * i}], p[${base + 2 * i + 1}]) * 0.01 * box.zw)`;
const SEG = `float sdseg(float2 q, float2 a, float2 b) { float2 pa = q - a; float2 ba = b - a; float h = clamp(dot(pa, ba) / max(dot(ba, ba), 0.0001), 0.0, 1.0); return length(pa - ba * h); }`;

const FACE_PARAMS = [
  ...LANDMARKS.flatMap(([id, label, x, y]) => [PCT(`${id}X`, `${label} X`, x), PCT(`${id}Y`, `${label} Y`, y)]),
  P("mesh", "Show Mesh", 0, 1, 1), P("size", "Point Size", 1, 20, 4, 0.5, "px"), P("hue", "Color (hue)", 0, 360, 140, 1, "°"), P("opacity", "Opacity", 0, 100, 100, 1, "%"),
];
const FACE_TRACK = over(
  FACE_POINTS, FACE_PARAMS,
  `
  float d = 100000.0;
  ${LANDMARKS.map((_, i) => `d = min(d, length(xy - ${pt(i)}) - p[27]);`).join("\n  ")}
  float line = 100000.0;
  ${MESH.map(([a, b]) => `line = min(line, sdseg(xy, ${pt(L[a])}, ${pt(L[b])}));`).join("\n  ")}
  float m = 1.0 - smoothstep(0.0, 1.0, d);
  if (p[26] > 0.5) { m = max(m, (1.0 - smoothstep(0.35, 1.35, line)) * 0.6); }
  float3 c = hsv2rgb(float3(p[28] / 360.0, 0.75, 1.0));
  float a = m * p[29] * 0.01;
  return half4(half3(c * a), half(a));`,
  "srcover",
  { slots: 30, head: SEG, outset: () => 40 },
);

// --- Face Measurements --------------------------------------------------------------------------------------------------
const dist = (f: FxValues, a: keyof typeof L, b: keyof typeof L) => Math.hypot(f[`${a}X`] - f[`${b}X`], f[`${a}Y`] - f[`${b}Y`]);
/** What the landmarks measure, each as a number in -1..1 (roll, yaw) or 0..1: mouth opening, eye distance, brow raise, roll, yaw. */
export function measureFace(f: FxValues, range: number): number[] {
  const jaw = Math.max(1e-6, dist(f, "lJaw", "rJaw")), height = Math.max(1e-6, dist(f, "fore", "chin"));
  const eyes = Math.max(1e-6, dist(f, "lEye", "rEye")), mouth = Math.max(1e-6, dist(f, "mouthL", "mouthR"));
  const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
  const eyeMidX = (f.lEyeX + f.rEyeX) / 2;
  const brow = ((f.lEyeY - f.lBrowY) + (f.rEyeY - f.rBrowY)) / 2 / height;
  const roll = (Math.atan2(f.rEyeY - f.lEyeY, f.rEyeX - f.lEyeX) * 180) / Math.PI;
  return [
    clamp(dist(f, "lip1", "lip2") / mouth / Math.max(range, 1e-6), 0, 1),
    clamp(eyes / jaw, 0, 1),
    clamp(brow / 0.2, 0, 1),
    clamp(roll / 45, -1, 1),
    clamp((f.noseX - eyeMidX) / eyes, -1, 1),
  ];
}

const MEASURE = over(
  "ec.utility.facemeasurements",
  [
    P("showEyeLine", "Eye Line", 0, 1, 1), P("showMouthWidth", "Mouth Width", 0, 1, 1), P("showMouthOpen", "Mouth Opening", 0, 1, 1), P("showFace", "Face Width and Height", 0, 1, 1),
    P("showBrows", "Eyebrow Raise", 0, 1, 1), P("showGauges", "Gauges", 0, 1, 1), P("lineWidth", "Line Width", 0.5, 8, 1.5, 0.5, "px"), P("hue", "Color (hue)", 0, 360, 190, 1, "°"),
    P("opacity", "Opacity", 0, 100, 100, 1, "%"), PCT("gaugeX", "Gauges X", 4, -100, 200), PCT("gaugeY", "Gauges Y", 4, -100, 200), P("gaugeSize", "Gauge Length", 20, 400, 90, 1, "px"),
    P("gaugeRange", "Mouth Opening Range", 0.1, 2, 0.6, 0.05),
  ],
  `
  float on = p[26];
  float w = p[33] * 0.5;
  float lines = 100000.0;
  if (p[27] > 0.5) { lines = min(lines, sdseg(xy, ${pt(L.lEye)}, ${pt(L.rEye)})); }
  if (p[28] > 0.5) { lines = min(lines, sdseg(xy, ${pt(L.mouthL)}, ${pt(L.mouthR)})); }
  if (p[29] > 0.5) { lines = min(lines, sdseg(xy, ${pt(L.lip1)}, ${pt(L.lip2)})); }
  if (p[30] > 0.5) {
    lines = min(lines, sdseg(xy, ${pt(L.lJaw)}, ${pt(L.rJaw)}));
    lines = min(lines, sdseg(xy, ${pt(L.fore)}, ${pt(L.chin)}));
  }
  if (p[31] > 0.5) {
    lines = min(lines, sdseg(xy, ${pt(L.lBrow)}, ${pt(L.lEye)}));
    lines = min(lines, sdseg(xy, ${pt(L.rBrow)}, ${pt(L.rEye)}));
  }
  float m = (1.0 - smoothstep(w - 0.5, w + 0.5, lines));
  if (p[32] > 0.5) {
    float2 g0 = box.xy + float2(p[36], p[37]) * 0.01 * box.zw;
    for (int i = 0; i < 5; i++) {
      float2 q = xy - (g0 + float2(0.0, float(i) * 12.0));
      float val = p[39 + i];
      float signedBar = (i >= 3) ? 1.0 : 0.0;
      float x0 = signedBar > 0.5 ? p[38] * 0.5 : 0.0;
      float x1 = signedBar > 0.5 ? x0 + val * p[38] * 0.5 : val * p[38];
      float inY = step(abs(q.y - 4.0), 3.0);
      float inBar = inY * step(min(x0, x1), q.x) * step(q.x, max(x0, x1));
      float rail = inY * step(0.0, q.x) * step(q.x, p[38]) * 0.25;
      m = max(m, max(inBar, rail * (1.0 - inBar)));
    }
  }
  float3 c = hsv2rgb(float3(p[34] / 360.0, 0.7, 1.0));
  float a = m * on * p[35] * 0.01;
  return half4(half3(c * a), half(a));`,
  "srcover",
  {
    slots: 44, head: SEG, outset: () => 40, needsLayer: 1, layerOptional: true,
    uniforms: (v, env) => {
      const f = env?.face ?? null;
      const pts = LANDMARKS.flatMap(([id]) => [f ? f[`${id}X`] : 0, f ? f[`${id}Y`] : 0]);
      const g = f ? measureFace(f, v.gaugeRange) : [0, 0, 0, 0, 0];
      return [
        ...pts, f ? 1 : 0, v.showEyeLine, v.showMouthWidth, v.showMouthOpen, v.showFace, v.showBrows, v.showGauges, v.lineWidth, v.hue, v.opacity,
        v.gaugeX, v.gaugeY, v.gaugeSize, ...g,
      ];
    },
  },
);

export const TRACK_FX: FxDef[] = [WARP_FX, PIN_FX, FACE_TRACK, MEASURE];
