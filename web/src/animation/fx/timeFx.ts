// TIME EFFECTS. EffectCraft's time category works on frames from other moments. Here a "frame history" is not
// pixels kept from earlier frames but the node POSED AGAIN at those moments: the clips are pure functions of
// time (animation/engine.ts), so the pose at `now + dt` is exact, costs nothing to keep and is identical when
// the playhead is scrubbed, jumped or played backwards. animation/pose.ts builds the samples; the renderer
// (ckRenderer.ts::drawEchoes) draws them and combines them with the mode.
//

import type { FxDef, FxTime } from "@/animation/fx/library";
import { P } from "@/animation/fx/kit";

const MS = 1000;

/** Frames a Time Displacement chooses between (SkSL cannot index children dynamically, so they are named). */
export const DISPLACE_FRAMES = 8;

/**
 * Time Displacement: each pixel is taken from a different moment, chosen by a map. The map is the node itself now
 * (its luminance, alpha or red), 0.5 meaning "no displacement"; the frames are the node posed at DISPLACE_FRAMES moments
 * evenly spread over [-maxDisplacement, +maxDisplacement], blended linearly between neighbours.
 * p: [0] map (0 luma, 1 alpha, 2 red, 3 green, 4 blue), [1] contrast, [2] invert.
 */
export const DISPLACE_SKSL = `uniform shader map;
${Array.from({ length: DISPLACE_FRAMES }, (_, i) => `uniform shader f${i};`).join("\n")}
uniform float4 box; uniform float p[12];
half4 main(float2 xy) {
  half4 m = map.eval(xy);
  float3 u = m.a > 0.0 ? float3(m.rgb) / float(m.a) : float3(0.0);
  float v = p[0] < 0.5 ? dot(float3(m.rgb), float3(0.2126, 0.7152, 0.0722)) : p[0] < 1.5 ? float(m.a) : p[0] < 2.5 ? u.r : p[0] < 3.5 ? u.g : u.b;
  v = clamp((v - 0.5) * p[1] + 0.5, 0.0, 1.0);
  if (p[2] > 0.5) { v = 1.0 - v; }
  float pos = v * ${DISPLACE_FRAMES - 1}.0;
  half4 acc = half4(0.0);
${Array.from({ length: DISPLACE_FRAMES }, (_, i) => `  acc += f${i}.eval(xy) * half(max(0.0, 1.0 - abs(pos - ${i}.0)));`).join("\n")}
  return acc;
}`;
const time = (id: string, params: FxDef["params"], t: NonNullable<FxDef["time"]>): FxDef => ({ id, params, time: t });

/** Evenly spaced samples over the shutter interval ending now, each with the same weight (they add up to 1). */
function shutter(angle: number, count: number, fps: number, phase = 0): FxTime {
  const n = Math.max(2, Math.round(count));
  const span = (angle / 360) * (MS / Math.max(fps, 1));
  const start = -span * (1 - phase);
  const samples = [];
  for (let i = 0; i < n; i++) samples.push({ dt: start + (span * i) / (n - 1), weight: 1 / n });
  return { samples, mode: "plus" };
}

export const TIME_FX: FxDef[] = [
  time("ec.time.echo", [
    P("echoTime", "Echo Time (s)", -2, 2, -0.033, 0.001), P("echoes", "Number of Echoes", 1, 30, 8),
    P("intensity", "Starting Intensity", 0, 1, 1, 0.01), P("decay", "Decay", 0, 1, 0.5, 0.01),
    P("operator", "Echo Operator (0 Add, 1 Screen, 2 Maximum, 3 Minimum, 4 Composite in Back, 5 Composite in Front, 6 Blend)", 0, 6, 0),
  ], (v) => {
    const n = Math.round(v.echoes), echoes = [];
    for (let i = 1; i <= n; i++) echoes.push({ dt: v.echoTime * MS * i, weight: v.intensity * v.decay ** (i - 1) });
    const op = Math.round(v.operator);
    const now = { dt: 0, weight: 1 };
    // oldest first: whatever is drawn last ends up on top
    const old = echoes.slice().reverse();
    switch (op) {
      case 1: return { samples: [...old, now], mode: "screen" };
      case 2: return { samples: [...old, now], mode: "lighten" };
      case 3: return { samples: [...old, now], mode: "darken" };
      case 4: return { samples: [...old, now], mode: "over" };
      case 5: return { samples: [now, ...echoes], mode: "over" };
      case 6: return { samples: [...old, now], mode: "over" };
      default: return { samples: [...old, now], mode: "plus" };
    }
  }),

  time("ec.time.ccwidetime", [
    P("forward", "Forward Steps", 0, 50, 3), P("backward", "Backward Steps", 0, 50, 3),
    P("interval", "Steps Interval (s)", 0.001, 2, 0.033, 0.001), P("ending", "Ending Intensity", 0, 100, 20, 1, "%"),
  ], (v) => {
    const f = Math.round(v.forward), b = Math.round(v.backward), raw = [];
    for (let k = -b; k <= f; k++) {
      const steps = k < 0 ? b : f;
      const x = steps > 0 ? Math.abs(k) / steps : 0;
      raw.push({ dt: k * v.interval * MS, weight: 1 + (v.ending / 100 - 1) * x });
    }
    const sum = raw.reduce((a, r) => a + r.weight, 0) || 1;
    return { samples: raw.map((r) => ({ dt: r.dt, weight: r.weight / sum })), mode: "plus" };
  }),

  time("ec.time.pixelmotionblur", [
    P("shutterAngle", "Shutter Angle", 0, 720, 180, 1, "°"), P("samples", "Samples", 2, 32, 8), P("fps", "Frame Rate", 1, 120, 30), P("phase", "Shutter Phase", 0, 1, 0, 0.01),
  ], (v) => shutter(v.shutterAngle, v.samples, v.fps, v.phase)),

  time("ec.time.ccforcemotionblur", [
    P("samples", "Motion Blur Samples", 2, 32, 8), P("shutterAngle", "Shutter Angle", 0, 720, 180, 1, "°"), P("fps", "Frame Rate", 1, 120, 30), P("phase", "Shutter Phase", 0, 1, 0, 0.01),
  ], (v) => shutter(v.shutterAngle, v.samples, v.fps, v.phase)),

  time("ec.time.posterizetime", [P("fps", "Frame Rate", 0.1, 100, 12, 0.1)], (v, t) => {
    const frame = MS / v.fps;
    return { samples: [{ dt: Math.floor(t / frame) * frame - t, weight: 1 }], mode: "over" };
  }),

  time("ec.time.timewarp", [P("speed", "Speed", -400, 400, 100, 1, "%"), P("offset", "Time Offset (s)", -60, 60, 0, 0.01)], (v, t) => ({
    samples: [{ dt: Math.max(0, (t * v.speed) / 100 + v.offset * MS) - t, weight: 1 }], mode: "over",
  })),

  time("ec.time.timedisplacement", [
    P("maxDisplacement", "Max Displacement Time (s)", -2, 2, 0.5, 0.01), P("map", "Time Displacement Map (0 Luma, 1 Alpha, 2 Red, 3 Green, 4 Blue)", 0, 4, 0),
    P("contrast", "Contrast", 0, 10, 1, 0.05), P("invert", "Invert Map", 0, 1, 0),
  ], (v) => {
    const samples = [];
    for (let i = 0; i < DISPLACE_FRAMES; i++) samples.push({ dt: v.maxDisplacement * MS * ((2 * i) / (DISPLACE_FRAMES - 1) - 1), weight: 1 });
    samples.push({ dt: 0, weight: 1 });
    return { samples, mode: "displace", uniforms: [v.map, v.contrast, v.invert] };
  }),

  time("ec.time.timedifference", [P("offset", "Time Offset (s)", -2, 2, -0.033, 0.001), P("opacity", "Opacity", 0, 100, 100, 1, "%")], (v) => ({
    samples: [{ dt: v.offset * MS, weight: 1 }, { dt: 0, weight: v.opacity / 100 }], mode: "difference",
  })),
];
