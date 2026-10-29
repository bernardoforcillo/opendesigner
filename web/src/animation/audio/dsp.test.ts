import { describe, it, expect } from "vitest";
import {
  butterworthQs, compressBlock, dbToGain, distortionCurve, fft, gainToDb, gateBlock, impulseResponse, rmsDb, rng, spectrumBands, waveformWindow, type CompressorState, type GateState,
} from "@/animation/audio/dsp";

const sine = (freq: number, sr: number, n: number, amp = 1) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / sr));

describe("dsp basics", () => {
  it("decibels and gains convert both ways", () => {
    expect(dbToGain(0)).toBe(1);
    expect(dbToGain(-6.0206)).toBeCloseTo(0.5, 4);
    expect(gainToDb(dbToGain(-23))).toBeCloseTo(-23, 6);
    expect(gainToDb(0)).toBeLessThan(-150);
  });
  it("the random generator is deterministic and uniform enough", () => {
    const a = rng(7), b = rng(7);
    const xs = Array.from({ length: 1000 }, () => a());
    expect(xs).toEqual(Array.from({ length: 1000 }, () => b()));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
    expect(xs.reduce((s, v) => s + v, 0) / 1000).toBeCloseTo(0.5, 1);
  });
});

describe("distortion curves", () => {
  it("map -1..1 to -1..1, are odd for soft and hard clipping, and clip harder with more drive", () => {
    for (const kind of ["soft", "hard", "fuzz", "crush"] as const) {
      const c = distortionCurve(kind, 60, 257);
      expect(Math.max(...c)).toBeLessThanOrEqual(1.0001);
      expect(Math.min(...c)).toBeGreaterThanOrEqual(-1.0001);
    }
    const soft = distortionCurve("soft", 50, 257), hard = distortionCurve("hard", 50, 257);
    expect(soft[256 - 10]).toBeCloseTo(-soft[10], 5);
    expect(hard[256 - 10]).toBeCloseTo(-hard[10], 5);
    // a quiet input is amplified more at high drive
    const quiet = (d: number) => distortionCurve("hard", d, 257)[128 + 10];
    expect(quiet(80)).toBeGreaterThan(quiet(10));
    // asymmetric fuzz is not odd
    const fuzz = distortionCurve("fuzz", 70, 257);
    expect(Math.abs(fuzz[128 - 8] + fuzz[128 + 8])).toBeGreaterThan(0.1);
    // crush has few distinct levels
    expect(new Set(distortionCurve("crush", 100, 2048)).size).toBeLessThan(10);
  });
});

describe("impulse responses", () => {
  const sr = 8000;
  it("decay to -60 dB over the decay time, are deterministic, and have two different channels", () => {
    const a = impulseResponse(sr, 1, 0.3, 5), b = impulseResponse(sr, 1, 0.3, 5);
    expect(a[0]).toEqual(b[0]);
    expect(a[0]).not.toEqual(a[1]);
    expect(a[0].length).toBe(sr);
    const early = rmsDb(a[0], 0, 400), late = rmsDb(a[0], sr - 400, sr);
    expect(early - late).toBeGreaterThan(40);
  });
  it("a longer decay is longer, and more damping is darker (less high-frequency energy late on)", () => {
    expect(impulseResponse(sr, 2, 0, 1)[0].length).toBe(2 * sr);
    const hf = (damp: number) => {
      const ir = impulseResponse(sr, 1, damp, 3)[0];
      let s = 0;
      for (let i = sr / 2; i < sr - 1; i++) s += (ir[i + 1] - ir[i]) ** 2; // the first difference weighs high frequencies
      return s;
    };
    expect(hf(0.95)).toBeLessThan(hf(0.05));
  });
});

describe("fft and spectrum", () => {
  it("finds the frequency of a sine", () => {
    const n = 1024, sr = 8192, re = Float64Array.from(sine(1000, sr, n)), im = new Float64Array(n);
    fft(re, im);
    let best = 1;
    for (let i = 1; i < n / 2; i++) if (Math.hypot(re[i], im[i]) > Math.hypot(re[best], im[best])) best = i;
    expect((best * sr) / n).toBeCloseTo(1000, -1);
  });
  it("is linear: the transform of a sum is the sum of the transforms", () => {
    const n = 64, a = Float64Array.from({ length: n }, (_, i) => Math.sin(i)), b = Float64Array.from({ length: n }, (_, i) => Math.cos(3 * i));
    const sum = a.map((v, i) => v + b[i]);
    const fa = [a.slice(), new Float64Array(n)], fb = [b.slice(), new Float64Array(n)], fs = [sum.slice(), new Float64Array(n)];
    fft(fa[0], fa[1]); fft(fb[0], fb[1]); fft(fs[0], fs[1]);
    for (let i = 0; i < n; i++) { expect(fs[0][i]).toBeCloseTo(fa[0][i] + fb[0][i], 8); expect(fs[1][i]).toBeCloseTo(fa[1][i] + fb[1][i], 8); }
  });
  it("puts a full-scale sine in the right band and nothing in the others", () => {
    const sr = 44100, data = sine(1000, sr, 8192);
    const bands = spectrumBands(data, 1000, 2048, sr, 32, 40, 16000);
    const at = Math.round((Math.log(1000 / 40) / Math.log(16000 / 40)) * 32 - 0.5);
    const peak = bands.indexOf(Math.max(...bands));
    expect(Math.abs(peak - at)).toBeLessThanOrEqual(1);
    expect(bands[peak]).toBeGreaterThan(0.85);
    expect(bands[0]).toBeLessThan(0.45);
    expect(bands[31]).toBeLessThan(0.45);
  });
  it("reads silence as zero and treats samples outside the data as silence", () => {
    expect(Math.max(...spectrumBands(new Float32Array(4096), 0, 1024, 44100, 16, 40, 16000))).toBe(0);
    expect(Math.max(...spectrumBands(sine(500, 44100, 100), 5000, 1024, 44100, 16, 40, 16000))).toBe(0);
  });
});

describe("waveform window", () => {
  it("takes the largest-magnitude sample of each slice, signed", () => {
    const data = Float32Array.from([0, 0.2, -0.9, 0.1, 0.5, -0.3, 0, 0]);
    expect(waveformWindow(data, 0, 8, 4)).toEqual([expect.closeTo(0.2, 6), expect.closeTo(-0.9, 6), expect.closeTo(0.5, 6), 0]);
    expect(waveformWindow(data, -4, 8, 2)).toEqual([0, expect.closeTo(-0.9, 6)]); // before the start is silence
  });
});

describe("noise gate", () => {
  const sr = 8000;
  const run = (x: Float32Array, p: Partial<{ threshold: number; attack: number; release: number; hold: number; floor: number }> = {}) => {
    const state: GateState = { env: 0, gain: 0, holdLeft: 0 };
    const out = x.slice();
    gateBlock(state, [out], { threshold: 0.1, attack: 0.002, release: 0.02, hold: 0.01, floor: 0, ...p }, sr);
    return out;
  };
  // 0.25 s loud tone, then 0.25 s of faint noise
  const loud = sine(440, sr, 2000, 0.8), quiet = sine(300, sr, 2000, 0.02);
  const signal = Float32Array.from([...loud, ...quiet]);
  it("passes what is above the threshold and closes on what is below it", () => {
    const out = run(signal);
    expect(rmsDb(out, 800, 1900) - rmsDb(signal, 800, 1900)).toBeGreaterThan(-1);
    expect(rmsDb(out, 3000, 4000)).toBeLessThan(rmsDb(signal, 3000, 4000) - 30);
  });
  it("the floor leaves some of the quiet part; the hold keeps it open for a while", () => {
    const withFloor = run(signal, { floor: 0.3 });
    expect(rmsDb(withFloor, 3000, 4000) - rmsDb(signal, 3000, 4000)).toBeCloseTo(gainToDb(0.3), 0);
    const held = run(signal, { hold: 0.1, release: 0.001 });
    const right = (o: Float32Array) => rmsDb(o, 2000 + 100, 2000 + 500);
    expect(right(held)).toBeGreaterThan(right(run(signal, { hold: 0, release: 0.001 })) + 6);
  });
  it("works in place on several channels with one gain", () => {
    const l = signal.slice(), r = signal.slice().map((v) => v * 0.5);
    gateBlock({ env: 0, gain: 0, holdLeft: 0 }, [l, r], { threshold: 0.1, attack: 0.002, release: 0.02, hold: 0, floor: 0 }, sr);
    for (let i = 3500; i < 3600; i++) { expect(l[i]).toBeCloseTo(0, 4); expect(r[i]).toBeCloseTo(0, 4); }
    expect(r[1000] / l[1000]).toBeCloseTo(0.5, 3);
  });
});

describe("butterworth sections", () => {
  it("a 2nd-order filter has Q 0.707, a 4th-order pair 0.541 and 1.307", () => {
    expect(butterworthQs(1)[0]).toBeCloseTo(0.7071, 3);
    const [a, b] = butterworthQs(2);
    expect(a).toBeCloseTo(0.5412, 3);
    expect(b).toBeCloseTo(1.3066, 3);
  });
});

describe("compressor", () => {
  const sr = 8000;
  const run = (x: Float32Array, p: Partial<{ threshold: number; ratio: number; attack: number; release: number; knee: number; makeup: number }> = {}) => {
    const state: CompressorState = { envDb: -120, grDb: 0 };
    const out = x.slice();
    compressBlock(state, [out], { threshold: -20, ratio: 4, attack: 0.001, release: 0.05, knee: 0, makeup: 1, ...p }, sr);
    return { out, state };
  };
  it("is neutral below the threshold: the gain is exactly the make-up", () => {
    const x = sine(440, sr, 4000, 0.05); // -26 dBFS, under the -20 dB threshold
    expect(rmsDb(run(x).out, 2000, 4000)).toBeCloseTo(rmsDb(x, 2000, 4000), 2);
    expect(rmsDb(run(x, { makeup: 2 }).out, 2000, 4000) - rmsDb(x, 2000, 4000)).toBeCloseTo(gainToDb(2), 2);
  });
  it("reduces by (1 - 1/ratio) of the excess over the threshold", () => {
    const x = sine(440, sr, 8000, 0.8); // peak -1.94 dBFS
    const out = run(x).out;
    const peakIn = -1.94, expected = (peakIn - -20) * (1 - 1 / 4); // 13.5 dB
    const reduced = rmsDb(x, 6000, 8000) - rmsDb(out, 6000, 8000);
    expect(Math.abs(reduced - expected)).toBeLessThan(1.2);
  });
  it("a higher ratio compresses more, and a soft knee starts before the threshold", () => {
    const x = sine(440, sr, 8000, 0.8);
    expect(rmsDb(run(x, { ratio: 20 }).out, 6000, 8000)).toBeLessThan(rmsDb(run(x, { ratio: 2 }).out, 6000, 8000) - 3);
    const near = sine(440, sr, 8000, 0.09); // -20.9 dBFS: just under the threshold
    const hard = rmsDb(run(near, { knee: 0 }).out, 6000, 8000), soft = rmsDb(run(near, { knee: 12 }).out, 6000, 8000);
    expect(soft).toBeLessThan(hard - 0.1);
  });
  it("lets go after the loud part (release) and never goes beyond the make-up", () => {
    const x = Float32Array.from([...sine(440, sr, 4000, 0.8), ...sine(440, sr, 8000, 0.03)]);
    const { out } = run(x, { release: 0.02 });
    // well after the loud part the quiet tone is back at its own level
    expect(rmsDb(out, 10000, 12000)).toBeCloseTo(rmsDb(x, 10000, 12000), 0);
    expect(Math.max(...out.map(Math.abs))).toBeLessThanOrEqual(0.8001);
  });
  it("works in place on two channels with one gain", () => {
    const l = sine(440, sr, 8000, 0.8), r = sine(440, sr, 8000, 0.4);
    compressBlock({ envDb: -120, grDb: 0 }, [l, r], { threshold: -20, ratio: 4, attack: 0.001, release: 0.05, knee: 0, makeup: 1 }, sr);
    expect(rmsDb(l, 6000, 8000) - rmsDb(r, 6000, 8000)).toBeCloseTo(6.02, 1);
  });
});
