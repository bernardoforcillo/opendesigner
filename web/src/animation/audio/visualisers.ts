// AUDIO SPECTRUM and AUDIO WAVEFORM: what the sound sounds like at the playhead, drawn over the node. The shader gets the numbers: the
// spectrum's bands (dsp.ts::spectrumBands over a 2048-sample window around the clip time) or the waveform's samples (dsp.ts::waveformWindow).
// The sound is the layer the effect names (a node that carries one) or the node's own. The same decoded buffers the player plays are read, so
// scrubbing shows the sound too. Nothing is drawn until the sound has been decoded.

import type { FxDef, FxEnv, FxValues } from "@/animation/fx/library";
import { P, over } from "@/animation/fx/kit";
import { spectrumBands, waveformWindow } from "@/animation/audio/dsp";

const HUE = (id: string, label: string, def: number) => P(id, label, 0, 360, def, 1, "°");
const BANDS = 64, SAMPLES = 96;

/** The sample index of clip time `timeMs` in `env`'s sound (it starts `startMs` into the clip), at its own sample rate. */
const centre = (env: FxEnv): number => Math.round(((env.timeMs - (env.sound?.startMs ?? 0)) / 1000) * (env.sound?.buffer.sampleRate ?? 44100));

function bandsOf(v: FxValues, env?: FxEnv): number[] {
  if (!env?.sound) return new Array(BANDS).fill(0);
  const b = env.sound.buffer;
  const n = Math.max(8, Math.min(BANDS, Math.round(v.bands)));
  const raw = spectrumBands(b.getChannelData(0), centre(env) - 1024, 2048, b.sampleRate, n, v.minHz, v.maxHz);
  while (raw.length < BANDS) raw.push(0);
  return raw;
}

export const VISUALISER_FX: FxDef[] = [
  over("ec.generate.audiospectrum", [
    P("bands", "Frequency Bands", 8, BANDS, 32, 1), P("minHz", "Start Frequency", 20, 5000, 40, 1, "Hz"), P("maxHz", "End Frequency", 1000, 20000, 12000, 1, "Hz"),
    P("height", "Maximum Height", 5, 200, 80, 1, "%"), P("thickness", "Thickness", 5, 100, 70, 1, "%"), P("style", "Display (0 Bars, 1 Line, 2 Dots)", 0, 2, 0),
    HUE("hueLow", "Inside Color (hue)", 200), HUE("hueHigh", "Outside Color (hue)", 330), P("mirror", "Mirror (0 Bottom, 1 Centre)", 0, 1, 0), P("opacity", "Opacity", 0, 100, 100, 1, "%"),
    P("softness", "Softness", 0, 100, 30, 1, "%"),
  ], `
  float2 u = uv(xy);
  if (u.x < 0.0 || u.x > 1.0 || u.y < 0.0 || u.y > 1.0) { return half4(0.0); }
  float n = p[11];
  float idx = min(floor(u.x * n), n - 1.0);
  float v = 0.0, vn = 0.0, vp = 0.0;
  for (int i = 0; i < 64; i++) {
    if (float(i) == idx) { v = p[12 + i]; }
    if (float(i) == idx + 1.0) { vn = p[12 + i]; }
    if (float(i) == idx - 1.0) { vp = p[12 + i]; }
  }
  float within = fract(u.x * n);
  float h = p[3] / 100.0;
  float top = v * h;
  // height measured from the bottom (or from the middle when mirrored)
  float y = p[8] > 0.5 ? abs(u.y - 0.5) * 2.0 : 1.0 - u.y;
  float soft = max(p[10] / 100.0 * 0.06, 0.004);
  float a;
  if (p[5] < 0.5) {
    float slot = 0.5 - p[4] / 200.0;
    a = smoothstep(slot - 0.02, slot + 0.02, within) * (1.0 - smoothstep(1.0 - slot - 0.02, 1.0 - slot + 0.02, within)) * (1.0 - smoothstep(top - soft, top + soft, y));
  } else if (p[5] < 1.5) {
    float edge = mix(mix(vp, v, 0.5 + within * 0.5), mix(v, vn, within * 0.5), step(0.5, within)) * h;
    float thick = max(p[4] / 100.0 * 0.04, 0.004);
    a = 1.0 - smoothstep(thick, thick + soft, abs(y - edge));
  } else {
    float2 d = float2((within - 0.5) * (1.0 / n) * box.z, (y - top) * box.w * (p[8] > 0.5 ? 0.5 : 1.0));
    float r = max(p[4] / 100.0 * box.z / n * 0.5, 1.0);
    a = (1.0 - smoothstep(r - 1.0, r + 1.0, length(d))) * step(0.02, v);
  }
  float3 col = hsv2rgb(float3(mix(p[6], p[7], clamp(y / max(h, 0.01), 0.0, 1.0)) / 360.0, 0.75, 1.0));
  return tint(col, a * p[9] / 100.0 * step(0.001, v));`, "srcover", {
    slots: 80, needsTime: true, layerOptional: true,
    uniforms: (v, env) => [v.bands, v.minHz, v.maxHz, v.height, v.thickness, v.style, v.hueLow, v.hueHigh, v.mirror, v.opacity, v.softness, Math.round(v.bands), ...bandsOf(v, env)],
  }),

  over("ec.generate.audiowaveform", [
    P("window", "Displayed Duration", 5, 2000, 80, 1, "ms"), P("height", "Maximum Height", 5, 200, 70, 1, "%"), P("thickness", "Thickness", 0.5, 30, 2, 0.5), P("style", "Display (0 Line, 1 Bars)", 0, 1, 0),
    HUE("hue", "Color (hue)", 150), P("sat", "Saturation", 0, 100, 70), P("opacity", "Opacity", 0, 100, 100, 1, "%"), P("mirror", "Centre Line", 0, 100, 100, 1, "%"),
  ], `
  float2 u = uv(xy);
  if (u.x < 0.0 || u.x > 1.0) { return half4(0.0); }
  float mid = 0.5, h = p[1] / 100.0 * 0.5;
  float px = max(p[2], 0.5);
  float a = 0.0;
  if (p[3] < 0.5) {
    // a polyline through the samples: the nearest segment decides
    float best = 1e9;
    for (int i = 0; i < 95; i++) {
      float2 a0 = float2(float(i) / 95.0, mid - p[12 + i] * h), a1 = float2(float(i + 1) / 95.0, mid - p[13 + i] * h);
      float2 s = (a1 - a0) * box.zw, q = (u - a0) * box.zw;
      float t = clamp(dot(q, s) / max(dot(s, s), 1e-4), 0.0, 1.0);
      best = min(best, length(q - s * t));
    }
    a = 1.0 - smoothstep(px * 0.5, px * 0.5 + 1.0, best);
  } else {
    float k = min(floor(u.x * 96.0), 95.0);
    float v = 0.0;
    for (int i = 0; i < 96; i++) { if (float(i) == k) { v = p[12 + i]; } }
    float slot = fract(u.x * 96.0);
    a = step(0.15, slot) * step(slot, 0.85) * step(abs(u.y - mid), max(abs(v) * h, 0.003));
  }
  float3 col = hsv2rgb(float3(p[4] / 360.0, p[5] / 100.0, 1.0));
  float line = 1.0 - smoothstep(0.0, 1.0, abs(u.y - mid) * box.w / 1.0) * 0.0;
  float guide = (1.0 - smoothstep(0.0, 1.0, abs(u.y - mid) * box.w)) * p[7] / 100.0 * 0.25;
  return tint(col, clamp(a + guide * step(a, 0.01), 0.0, 1.0) * p[6] / 100.0);`, "srcover", {
    slots: 112, needsTime: true, layerOptional: true,
    uniforms: (v, env) => {
      let samples: number[] = new Array(SAMPLES).fill(0);
      if (env?.sound) {
        const b = env.sound.buffer;
        const win = Math.max(SAMPLES, Math.round((v.window / 1000) * b.sampleRate));
        samples = waveformWindow(b.getChannelData(0), centre(env) - Math.round(win / 2), win, SAMPLES);
      }
      return [v.window, v.height, v.thickness, v.style, v.hue, v.sat, v.opacity, v.mirror, 0, 0, 0, 0, ...samples];
    },
  }),
];
