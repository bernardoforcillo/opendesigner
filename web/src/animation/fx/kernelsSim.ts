// Simulation, card/shatter transitions and text generators (see kit.ts).
//
// None of these keeps state between frames. A piece, particle or card is a pure function of its id and of the
// animatable `phase`/`completion` parameter, so they scrub, loop and render the same everywhere:
//   - shatter / card dance / card wipe / pixel polly: the node is cut into pieces on a grid; every piece moves by a rigid
//     transform that depends on its id; for each output pixel the pieces that could cover it (a few cells around) are
//     inverse-transformed and tested, the one with the highest priority wins;
//   - particles: N particles, each with a position that is a closed-form function of its age (launch speed, gravity);
//   - text: a 5x7 bitmap font in SkSL; the characters are formatted on the CPU and passed as uniforms.

import type { FxDef } from "@/animation/fx/library";
import { P, kern, over } from "@/animation/fx/kit";

const HUE = (id: string, label: string, def: number) => P(id, label, 0, 360, def, 1, "°");
const CX = P("centerX", "Center X", -100, 200, 50, 0.5, "%");
const CY = P("centerY", "Center Y", -100, 200, 50, 0.5, "%");

// --- pieces ----------------------------------------------------------------------------------------------------

// Search radius in cells (kept constant for SkSL's loops; unused cells are skipped by a cheap test).
const SEARCH = 3;

/**
 * Pieces cut from a grid of `size` px cells, two triangles per cell (shatter) or one rectangle (cards). The body supplies
 * `pieceXform(cell, tri)` -> (translation.xy, angle, scaleX, scaleY, delayedPhase) through the macro it defines as
 * functions in `head`; here only the search loop is generic.
 */
const searchBody = (cardMode: boolean) => `
  float size = max(p[PIECE], 2.0);
  float2 g = (xy - box.xy) / size;
  float2 base = floor(g);
  half4 best = half4(0.0); float bestPri = -1.0;
  for (int j = -${SEARCH}; j <= ${SEARCH}; j++) {
    for (int i = -${SEARCH}; i <= ${SEARCH}; i++) {
      float2 cell = base + float2(float(i), float(j));
      float2 c0 = box.xy + (cell + 0.5) * size;
      // the cell must lie over the node, else it has nothing to carry
      if (c0.x < box.x - size || c0.y < box.y - size || c0.x > box.x + box.z + size || c0.y > box.y + box.w + size) { continue; }
      ${cardMode ? `
      float4 xf = cardXform(cell, c0, size);   // xy = translation, z = rotation, w = flip (cos)
      float2 q = rot(xy - c0 - xf.xy, -xf.z);
      float flip = xf.w;
      if (abs(flip) < 0.03) { continue; }
      q.x /= flip;
      if (abs(q.x) > size * 0.5 || abs(q.y) > size * 0.5) { continue; }
      half4 col = S(c0 + q);
      float pri = hash21(cell + 3.7) + (flip > 0.0 ? 1.0 : 0.0) * 0.001;
      if (flip < 0.0) { col = half4(col.rgb * half(BACKTONE), col.a * half(BACKOP)); }
      ` : `
      float4 xf0 = shardXform(cell, c0, size, 0.0);
      float4 xf1 = shardXform(cell, c0, size, 1.0);
      float2 q0 = rot(xy - c0 - xf0.xy, -xf0.z);
      float2 q1 = rot(xy - c0 - xf1.xy, -xf1.z);
      // triangle 0 is the lower-left half of the cell, triangle 1 the upper-right half
      bool in0 = q0.x + q0.y <= 0.0 && abs(q0.x) <= size * 0.5 && abs(q0.y) <= size * 0.5;
      bool in1 = q1.x + q1.y > 0.0 && abs(q1.x) <= size * 0.5 && abs(q1.y) <= size * 0.5;
      half4 col = half4(0.0); float pri = -1.0;
      if (in0) { col = S(c0 + q0); pri = hash21(cell + 1.3); }
      if (in1) { float p1 = hash21(cell + 8.1); if (p1 > pri) { col = S(c0 + q1); pri = p1; } }
      `}
      if (pri > bestPri && col.a > 0.0) { bestPri = pri; best = col; }
    }
  }
  return best;`;

const shardHead = `
// translation (xy), rotation (z) of one half-cell piece at the current phase; w unused
float4 shardXform(float2 cell, float2 c0, float size, float tri) {
  float2 id = cell + tri * 17.0;
  float rnd = hash21(id + p[SEED]);
  float delay = rnd * p[DELAY] / 100.0;
  float t = clamp((p[PHASE] / 100.0 - delay) / max(1.0 - delay, 0.001), 0.0, 1.0);
  float2 dir = normalize(c0 - (box.xy + box.zw * float2(p[CXI], p[CYI]) / 100.0) + (hash22(id) - 0.5) * 2.0 * 0.001 + 1e-4);
  float2 tr = dir * p[FORCE] * t * (0.5 + rnd) + float2(0.0, 1.0) * p[GRAV] * t * t;
  float ang = (hash21(id + 5.5) - 0.5) * 2.0 * radians(p[ROT]) * t;
  return float4(tr, ang, 1.0);
}`;
const cardHead = `
float4 cardXform(float2 cell, float2 c0, float size) {
  float rnd = hash21(cell + p[SEED]);
  float delay = rnd * p[DELAY] / 100.0;
  float t = clamp((p[PHASE] / 100.0 - delay) / max(1.0 - delay, 0.001), 0.0, 1.0);
  float2 r2 = hash22(cell + 11.0) - 0.5;
  float2 tr = r2 * 2.0 * p[SPREAD] * t + float2(0.0, 1.0) * p[GRAV] * t * t;
  float rz = (hash21(cell + 2.2) - 0.5) * 2.0 * radians(p[ROTZ]) * t;
  float flip = cos(radians(p[ROTY]) * (0.5 + rnd) * t);
  return float4(tr, rz, flip);
}`;
const sub = (s: string, m: Record<string, number | string>) => s.replace(/\b[A-Z]{2,}[A-Z0-9]*\b/g, (k) => (k in m ? String(m[k]) : k));

const shatterBody = (m: Record<string, number>) => sub(searchBody(false), m);
const shardHeadFor = (m: Record<string, number>) => sub(shardHead, m);

// --- particles -------------------------------------------------------------------------------------------------

const PARTICLES = `
  half4 acc = half4(0.0);
  float2 em = box.xy + box.zw * float2(p[EX], p[EY]) / 100.0;
  float cycle = radians(p[PHASE]) / (2.0 * PI);
  for (int i = 0; i < 96; i++) {
    if (float(i) >= p[COUNT]) { break; }
    float2 r = hash22(float2(float(i), p[SEED]));
    float2 r2 = hash22(float2(float(i) + 31.0, p[SEED] + 7.0));
    float age = fract(r.x + cycle * p[RATE]);
    float t = age * p[LIFE];
    float a = radians(p[DIR] + (r.y - 0.5) * p[SPREAD]);
    float sp = p[SPEED] * (1.0 - p[VAR] * r2.x);
    float2 pos = em + float2(cos(a), -sin(a)) * sp * t + float2(0.0, 1.0) * 0.5 * p[GRAV] * t * t;
    float rad = max(p[SIZE] * (1.0 - age * p[SHRINK]) * (0.6 + 0.8 * r2.y), 0.3);
    float d = length(xy - pos);
    float cov = 1.0 - smoothstep(rad * 0.3, rad, d);
    float al = cov * (1.0 - pow(age, 2.0) * p[FADE]) * p[OPAC] / 100.0;
    float3 col = hsv2rgb(float3(fract((p[HUEP] + (r2.x - 0.5) * p[HUEVAR]) / 360.0), p[SATP] / 100.0, 1.0));
    acc += half4(half3(col * al), half(al)) * (1.0 - acc.a);
  }
  return acc;`;
const particleParams = (d: Record<string, number>) => [
  P("count", "Birth Rate (particles)", 1, 96, d.count), P("life", "Longevity (s)", 0.1, 10, d.life, 0.1), P("speed", "Velocity", 0, 1000, d.speed), P("dir", "Direction", -360, 360, d.dir, 1, "°"),
  P("spread", "Spread", 0, 360, d.spread, 1, "°"), P("grav", "Gravity", -2000, 2000, d.grav), P("size", "Particle Size", 0.5, 100, d.size, 0.5), P("shrink", "Shrink", 0, 1, d.shrink, 0.01),
  P("fade", "Fade Out", 0, 1, d.fade, 0.01), HUE("hue", "Color (hue)", d.hue), P("hueVar", "Color Variation", 0, 360, d.hueVar, 1, "°"), P("sat", "Saturation", 0, 100, d.sat),
  P("opacity", "Opacity", 0, 100, 100), P("phase", "Time (animate)", -36000, 36000, 0, 1, "°"), P("rate", "Cycles", 0.1, 10, 1, 0.1), P("var", "Speed Variation", 0, 1, d.varr, 0.01),
  P("ex", "Emitter X", -100, 200, d.ex, 0.5, "%"), P("ey", "Emitter Y", -100, 200, d.ey, 0.5, "%"), P("seed", "Random Seed", 0, 1000, 1),
];
// p index of each named parameter above
const PIDX = { COUNT: 0, LIFE: 1, SPEED: 2, DIR: 3, SPREAD: 4, GRAV: 5, SIZE: 6, SHRINK: 7, FADE: 8, HUEP: 9, HUEVAR: 10, SATP: 11, OPAC: 12, PHASE: 13, RATE: 14, VAR: 15, EX: 16, EY: 17, SEED: 18 };
const particles = (id: string, d: Record<string, number>): FxDef =>
  over(id, particleParams(d), sub(PARTICLES, PIDX), "srcover", { slots: 24, outset: (v) => Math.min(800, v.speed * v.life + Math.abs(v.grav) * v.life * v.life * 0.5 + v.size) });

// --- text ------------------------------------------------------------------------------------------------------

const FONT: Record<string, number[]> = {
  "0": [14, 17, 19, 21, 25, 17, 14], "1": [4, 12, 4, 4, 4, 4, 14], "2": [14, 17, 1, 2, 4, 8, 31], "3": [31, 2, 4, 2, 1, 17, 14],
  "4": [2, 6, 10, 18, 31, 2, 2], "5": [31, 16, 30, 1, 1, 17, 14], "6": [6, 8, 16, 30, 17, 17, 14], "7": [31, 1, 2, 4, 8, 8, 8],
  "8": [14, 17, 17, 14, 17, 17, 14], "9": [14, 17, 17, 15, 1, 2, 12], ":": [0, 4, 4, 0, 4, 4, 0], ".": [0, 0, 0, 0, 0, 12, 12],
  "-": [0, 0, 0, 31, 0, 0, 0], ",": [0, 0, 0, 0, 12, 4, 8], " ": [0, 0, 0, 0, 0, 0, 0],
};
const CHARS = "0123456789:.-, ";
const code = (c: string) => Math.max(0, CHARS.indexOf(c));
/** SkSL: the 5 bits of row `row` (0..6) of character code `ch` (0..14) as a float 0..31. */
const GLYPH = `float glyphRow(float ch, float row) {
${[...CHARS].map((c, i) => `  if (ch < ${i}.5) { ${FONT[c].map((b, r) => `if (row < ${r}.5) { return ${b}.0; }`).join(" ")} return ${FONT[c][6]}.0; }`).join("\n")}
  return 0.0;
}`;
const TEXT = `
  float scale = max(p[15], 0.5);
  float n = p[14];
  float width = n * 6.0 * scale;
  float2 origin = float2(box.x + box.z * p[16] / 100.0 - width * p[18], box.y + box.w * p[17] / 100.0 - 3.5 * scale);
  float2 l = (xy - origin) / scale;
  if (l.y < 0.0 || l.y >= 7.0 || l.x < 0.0) { return half4(0.0); }
  float ci = floor(l.x / 6.0);
  float gx = l.x - ci * 6.0;
  if (gx >= 5.0 || ci >= n) { return half4(0.0); }
  float ch = 14.0;
  for (int k = 0; k < 14; k++) { if (float(k) == ci) { ch = p[k]; } }
  float bits = glyphRow(ch, floor(l.y));
  float on = mod(floor(bits / pow(2.0, 4.0 - floor(gx))), 2.0);
  return tint(hsv2rgb(float3(p[19] / 360.0, p[20] / 100.0, 1.0)), on * p[21]);`;

const withCommas = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const pack = (text: string, rest: number[]): number[] => {
  const chars = [...text].slice(-14).map(code);
  const out = chars.concat(new Array(14 - chars.length).fill(14));
  return [...out, chars.length, ...rest];
};
export function formatNumber(value: number, decimals: number, commas: boolean): string {
  const fixed = Math.abs(value).toFixed(Math.max(0, Math.min(6, Math.round(decimals))));
  const [ip, fp] = fixed.split(".");
  return (value < 0 && Number(fixed) !== 0 ? "-" : "") + (commas ? withCommas(ip) : ip) + (fp !== undefined ? `.${fp}` : "");
}
export function formatTimecode(seconds: number, fps: number, mode: number): string {
  const f = Math.max(1, Math.round(fps));
  const neg = seconds < 0;
  const total = Math.floor(Math.abs(seconds) * f + 1e-6);
  if (mode >= 1.5) return (neg ? "-" : "") + String(total);
  const ff = total % f, s = Math.floor(total / f) % 60, m = Math.floor(total / f / 60) % 60, h = Math.floor(total / f / 3600);
  const two = (n: number) => String(n).padStart(2, "0");
  return (neg ? "-" : "") + (mode < 0.5 ? `${two(h)}:${two(m)}:${two(s)}:${two(ff)}` : `${two(h)}:${two(m)}:${two(s)}`);
}

const textLayout = [
  P("size", "Size", 4, 400, 24), P("x", "Position X", -100, 200, 50, 0.5, "%"), P("y", "Position Y", -100, 200, 50, 0.5, "%"),
  P("align", "Align (0 Left, 1 Center, 2 Right)", 0, 2, 1), HUE("hue", "Color (hue)", 0), P("sat", "Saturation", 0, 100, 0), P("opacity", "Opacity", 0, 100, 100, 1, "%"),
];
const textUniforms = (text: string, v: Record<string, number>) => pack(text, [v.size / 7, v.x, v.y, Math.round(v.align) / 2, v.hue, v.sat, v.opacity / 100]);
const textFx = (id: string, params: ReturnType<typeof P>[], text: (v: Record<string, number>) => string): FxDef =>
  over(id, params, `${TEXT}`, "srcover", { slots: 24, head: GLYPH, uniforms: (v) => textUniforms(text(v), v), outset: (v) => v.size * 2 });

export const SIM_FX: FxDef[] = [
  // Shatter and pixel polly -----------------------------------------------------------------------------------
  kern("ec.sim.shatter", [
    P("phase", "Force / Time", 0, 100, 30, 1, "%"), P("piece", "Piece Size", 4, 200, 28), P("force", "Strength", 0, 1500, 220), P("grav", "Gravity", 0, 3000, 300), P("rot", "Spin", 0, 720, 180, 1, "°"),
    P("delay", "Delay Randomness", 0, 90, 40, 1, "%"), P("seed", "Random Seed", 0, 1000, 1), CX, CY,
  ], shatterBody({ PIECE: 1, PHASE: 0, FORCE: 2, GRAV: 3, ROT: 4, DELAY: 5, SEED: 6, CXI: 7, CYI: 8 }), {
    head: shardHeadFor({ PIECE: 1, PHASE: 0, FORCE: 2, GRAV: 3, ROT: 4, DELAY: 5, SEED: 6, CXI: 7, CYI: 8 }),
    outset: (v) => v.force + v.grav * 0.6 + v.piece * 2,
  }),

  kern("ec.sim.ccpixelpolly", [
    P("phase", "Time", 0, 100, 30, 1, "%"), P("piece", "Grid Spacing", 3, 100, 16), P("force", "Initial Velocity", 0, 800, 60), P("grav", "Gravity", 0, 3000, 600), P("rot", "Slant", 0, 720, 360, 1, "°"),
    P("delay", "Randomness", 0, 90, 70, 1, "%"), P("seed", "Random Seed", 0, 1000, 1), CX, CY,
  ], shatterBody({ PIECE: 1, PHASE: 0, FORCE: 2, GRAV: 3, ROT: 4, DELAY: 5, SEED: 6, CXI: 7, CYI: 8 }), {
    head: shardHeadFor({ PIECE: 1, PHASE: 0, FORCE: 2, GRAV: 3, ROT: 4, DELAY: 5, SEED: 6, CXI: 7, CYI: 8 }),
    outset: (v) => v.force + v.grav * 0.6 + v.piece * 2,
  }),

  // Cards -------------------------------------------------------------------------------------------------------
  kern("ec.sim.carddance", [
    P("phase", "Time", 0, 100, 40, 1, "%"), P("piece", "Card Size", 6, 200, 32), P("spread", "Position Spread", 0, 600, 80), P("grav", "Fall", 0, 2000, 0),
    P("rotz", "Rotation Z", 0, 720, 90, 1, "°"), P("roty", "Flip (Rotation Y)", 0, 1080, 180, 1, "°"), P("delay", "Delay Randomness", 0, 90, 40, 1, "%"), P("seed", "Random Seed", 0, 1000, 1), P("back", "Back Face Opacity", 0, 100, 100),
  ], sub(searchBody(true), { PIECE: 1, BACKTONE: "0.6", BACKOP: "(p[8] / 100.0)" }), {
    head: sub(cardHead, { PIECE: 1, PHASE: 0, SPREAD: 2, GRAV: 3, ROTZ: 4, ROTY: 5, DELAY: 6, SEED: 7 }),
    outset: (v) => v.spread + v.grav * 0.5 + v.piece,
  }),

  kern("ec.transition.cardwipe", [
    P("completion", "Transition Completion", 0, 100, 50), P("piece", "Card Size", 6, 200, 36), P("direction", "Wipe Direction", -360, 360, 0, 1, "°"), P("spread", "Transition Width", 0, 100, 40, 1, "%"),
    P("back", "Back Face Opacity", 0, 100, 0), P("axis", "Flip Axis (0 Horizontal, 1 Vertical)", 0, 1, 0), P("jitter", "Timing Jitter", 0, 100, 30, 1, "%"), P("seed", "Random Seed", 0, 1000, 1),
  ], `
  float size = max(p[1], 2.0);
  float2 cell = floor((xy - box.xy) / size);
  float2 c0 = box.xy + (cell + 0.5) * size;
  float2 d = float2(cos(radians(p[2])), sin(radians(p[2])));
  float ext = abs(box.z * d.x) + abs(box.w * d.y);
  float order = clamp(dot(c0 - ctr(), d) / max(ext, 1.0) + 0.5, 0.0, 1.0);
  order = mix(order, hash21(cell + p[7]), p[6] / 100.0);
  float w = p[3] / 100.0;
  float t = clamp((p[0] / 100.0 * (1.0 + w) - order * 1.0) / max(w, 0.001), 0.0, 1.0);
  if (p[0] <= 0.0) { return S(xy); }
  float a = t * PI;
  float flip = cos(a);
  float2 q = xy - c0;
  if (p[5] < 0.5) { q.x /= (abs(flip) < 0.03 ? 0.03 : flip); } else { q.y /= (abs(flip) < 0.03 ? 0.03 : flip); }
  if (abs(q.x) > size * 0.5 || abs(q.y) > size * 0.5) { return half4(0.0); }
  half4 col = S(c0 + q);
  if (flip < 0.0) { col = half4(col.rgb * 0.6, col.a) * half(p[4] / 100.0); }
  return col;`),

  kern("ec.transition.ccwarpomatic", [P("completion", "Completion", 0, 100, 50), P("smooth", "Smoothness", 0, 100, 40), P("warp", "Warp Amount", 0, 400, 60), P("angle", "Warp Direction", -360, 360, 0, 1, "°"), P("invert", "Invert Map", 0, 1, 0), P("steps", "Quality", 4, 16, 8)], `
  float c = p[0] / 100.0;
  half4 here = S(xy);
  float L = lum(unp(here)); if (p[4] > 0.5) { L = 1.0 - L; }
  float s = p[1] / 100.0 + 0.001;
  float t = clamp((c * (1.0 + s) - L) / s, 0.0, 1.0);
  float2 d = float2(cos(radians(p[3])), sin(radians(p[3])));
  half4 acc = half4(0.0);
  for (int i = 0; i < 16; i++) {
    if (float(i) >= p[5]) { break; }
    acc += S(xy + d * p[2] * t * (float(i) / max(p[5] - 1.0, 1.0) - 0.5));
  }
  acc /= p[5];
  return acc * half(1.0 - t);`, { outset: (v) => v.warp }),

  // Particles ---------------------------------------------------------------------------------------------------
  particles("ec.sim.ccparticleworld", { count: 64, life: 3, speed: 160, dir: 90, spread: 60, grav: 220, size: 4, shrink: 0.4, fade: 0.8, hue: 40, hueVar: 40, sat: 60, varr: 0.4, ex: 50, ey: 80 }),
  particles("ec.sim.ccparticlesystems2", { count: 80, life: 2, speed: 260, dir: 90, spread: 25, grav: 450, size: 3, shrink: 0.2, fade: 0.9, hue: 200, hueVar: 30, sat: 50, varr: 0.3, ex: 50, ey: 95 }),
  particles("ec.sim.particleplayground", { count: 96, life: 2, speed: 220, dir: 0, spread: 360, grav: 0, size: 3, shrink: 0.6, fade: 1, hue: 20, hueVar: 90, sat: 80, varr: 0.7, ex: 50, ey: 50 }),

  over("ec.sim.foam", [P("size", "Bubble Size", 3, 100, 16), P("amount", "Amount", 0, 1, 0.7, 0.01), P("phase", "Phase", -36000, 36000, 0, 1, "°"), P("seed", "Seed", 0, 1000, 1), P("rim", "Rim Brightness", 0, 100, 70), HUE("hue", "Tint (hue)", 200), P("opacity", "Opacity", 0, 100, 70)], `
  float a = 0.0, rim = 0.0;
  for (int L = 0; L < 3; L++) {
    float s = p[0] * (1.0 + float(L) * 0.6);
    float2 q = (xy - box.xy) / s + float2(sin(radians(p[2]) * 0.3 + float(L)), cos(radians(p[2]) * 0.25 + float(L) * 2.0)) * 0.3;
    float2 i = floor(q), f = fract(q);
    float2 r = hash22(i + float(L) * 13.1 + p[3]);
    if (r.x < p[1]) {
      float2 c = 0.3 + 0.4 * hash22(i + 2.2); float rad = 0.28 + 0.2 * r.y;
      float d = length(f - c) / rad;
      a = max(a, step(d, 1.0) * 0.18);
      rim = max(rim, smoothstep(0.78, 0.98, d) * (1.0 - smoothstep(0.98, 1.1, d)));
    }
  }
  float3 col = mix(float3(0.9, 0.97, 1.0), hsv2rgb(float3(p[5] / 360.0, 0.3, 1.0)), 0.5);
  return tint(col, clamp(a + rim * p[4] / 100.0, 0.0, 1.0) * p[6] / 100.0);`, "srcatop"),

  over("ec.sim.waveworld", [P("scale", "Wave Length", 4, 600, 70), P("height", "Wave Height", 0, 1, 0.5, 0.01), P("phase", "Phase", -36000, 36000, 0, 1, "°"), P("angle", "Wind Direction", -360, 360, 30, 1, "°"), HUE("hue", "Water Color (hue)", 200), P("shine", "Reflection", 0, 100, 60), P("opacity", "Opacity", 0, 100, 60)], `
  float2 q = (xy - box.xy) / p[0];
  float t = radians(p[2]);
  float2 g = float2(0.0); float h = 0.0;
  for (int i = 0; i < 4; i++) {
    float f = float(i) + 1.0;
    float a = radians(p[3]) + f * 0.9;
    float2 d = float2(cos(a), sin(a));
    float ph = dot(q, d) * f * 1.3 + t * (0.6 + f * 0.25);
    h += sin(ph) / f;
    g += d * cos(ph) * 1.3;
  }
  float3 n = normalize(float3(-g * p[1] * 1.6, 1.0));
  float spec = pow(clamp(dot(n, normalize(float3(-0.3, -0.5, 0.8))), 0.0, 1.0), 40.0) * p[5] / 100.0;
  float3 base = hsv2rgb(float3(p[4] / 360.0, 0.6, 0.5 + 0.2 * h * p[1]));
  return tint(base + spec, p[6] / 100.0);`, "srcatop"),

  over("ec.sim.ccmrmercury", [P("count", "Blobs", 2, 14, 8), P("radius", "Blob Radius", 4, 200, 18), P("speed", "Speed", 0, 10, 1, 0.1), P("phase", "Phase", -36000, 36000, 0, 1, "°"), P("threshold", "Surface Threshold", 0.2, 3, 1.4, 0.05), P("shine", "Shine", 0, 100, 70), HUE("hue", "Tint (hue)", 210), P("sat", "Tint Amount", 0, 100, 10), P("opacity", "Opacity", 0, 100, 100), P("area", "Roam Area", 5, 100, 60, 1, "%")], `
  float f = 0.0; float2 grad = float2(0.0);
  float t = radians(p[3]) * p[2];
  for (int i = 0; i < 14; i++) {
    if (float(i) >= p[0]) { break; }
    float2 r = hash22(float2(float(i), 3.0));
    float2 c = ctr() + (float2(sin(t * (0.5 + r.x) + r.y * 6.28), cos(t * (0.4 + r.y) + r.x * 6.28)) * 0.5) * box.zw * p[9] / 100.0;
    float2 d = xy - c;
    float k = p[1] * p[1] / (dot(d, d) + 1.0);
    f += k; grad += -2.0 * d * k * k / (p[1] * p[1]);
  }
  float m = smoothstep(p[4] - 0.08, p[4] + 0.08, f);
  float3 n = normalize(float3(-grad * 0.2, 1.0));
  float env = 0.5 + 0.5 * n.y * 0.0 + 0.5 * dot(n.xy, float2(-0.6, -0.8));
  float spec = pow(clamp(dot(n, normalize(float3(-0.5, -0.6, 0.7))), 0.0, 1.0), 30.0) * p[5] / 100.0;
  float3 col = mix(float3(0.55 + 0.4 * env), hsv2rgb(float3(p[6] / 360.0, 0.6, 0.8)), p[7] / 100.0) + spec;
  return tint(clamp(col, 0.0, 1.0), m * p[8] / 100.0);`, "srcover", { outset: (v) => v.radius * 2 }),

  kern("ec.sim.cchair", [P("length", "Hair Length", 0, 200, 24), P("density", "Density", 1, 24, 12), P("gravity", "Gravity", -100, 100, 20), P("wind", "Wind", -100, 100, 0), P("curl", "Curl", 0, 100, 20), P("seed", "Seed", 0, 1000, 1), P("fade", "Tip Fade", 0, 1, 0.5, 0.01)], `
  // strands grow outward from the node's edge: for each strand step, look back toward the edge along a noisy direction
  half4 own = S(xy);
  if (own.a > 0.5) { return own; }
  half4 best = half4(0.0);
  float2 out0 = normalize(xy - ctr() + 1e-3);
  for (int i = 0; i < 24; i++) {
    if (float(i) >= p[1]) { break; }
    float r = hash21(float2(float(i), p[5]));
    float2 dir = rot(out0, (r - 0.5) * 1.2 + (vnoise((xy - box.xy) / 14.0 + float(i)) - 0.5) * p[4] / 50.0);
    dir += float2(p[3] / 200.0, p[2] / 200.0);
    float len = p[0] * (0.4 + 0.6 * hash21(float2(float(i), p[5] + 9.0)));
    for (int k = 1; k < 6; k++) {
      float t = float(k) / 5.0;
      half4 s = S(xy - dir * len * t);
      if (s.a > 0.5) {
        float strand = 1.0 - smoothstep(0.0, 0.7, abs(fract((xy.x * dir.y - xy.y * dir.x) / 3.0 + r * 9.0) - 0.5) * 2.0 - 0.3);
        float a = strand * (1.0 - t * p[6]) * step(best.a, 0.9);
        if (a > float(best.a)) { best = half4(s.rgb * half(0.85) * half(a), half(a)); }
        break;
      }
    }
  }
  return best;`, { outset: (v) => v.length }),

  // Text --------------------------------------------------------------------------------------------------------
  textFx("ec.text.numbers", [P("value", "Value", -1000000, 1000000, 0, 0.01), P("decimals", "Decimal Places", 0, 6, 0), P("commas", "Commas", 0, 1, 0), ...textLayout], (v) => formatNumber(v.value, v.decimals, v.commas > 0.5)),
  textFx("ec.text.timecode", [P("seconds", "Time (s)", -86400, 86400, 0, 0.01), P("fps", "Frame Rate", 1, 120, 24), P("format", "Display (0 HH:MM:SS:FF, 1 HH:MM:SS, 2 Frames)", 0, 2, 0), ...textLayout], (v) => formatTimecode(v.seconds, v.fps, v.format)),
];

