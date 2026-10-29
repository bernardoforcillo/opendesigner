// AUDIO DSP, PURE: the maths the audio effects need that is not already a Web Audio node. No AudioContext in here, so it runs (and
// is tested) in node as well as in the browser. animation/audio/stages.ts puts these into Web Audio graphs.

export const dbToGain = (db: number): number => 10 ** (db / 20);
export const gainToDb = (g: number): number => 20 * Math.log10(Math.max(g, 1e-9));

// --- waveshaping ------------------------------------------------------------------------------------------------------------

export type DistortionKind = "soft" | "hard" | "fuzz" | "crush";

/** A WaveShaperNode curve (n samples over -1..1). `drive` 0..100; "crush" quantises to fewer and fewer levels. */
export function distortionCurve(kind: DistortionKind, drive: number, n = 2048): Float32Array<ArrayBuffer> {
  const k = 1 + Math.max(0, drive) / 100 * 29; // pre-gain 1..30
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const g = x * k;
    switch (kind) {
      case "soft": out[i] = Math.tanh(g) / Math.tanh(Math.max(k, 1e-3)) * Math.min(1, Math.tanh(k)); break;
      case "hard": out[i] = Math.max(-1, Math.min(1, g)); break;
      // asymmetric: positive half clipped hard, negative half soft, so even harmonics appear
      case "fuzz": out[i] = g >= 0 ? Math.min(1, g) : Math.tanh(g * 0.7); break;
      case "crush": { const steps = Math.max(2, Math.round(64 - drive / 100 * 60)); out[i] = Math.round(x * steps) / steps; break; }
    }
  }
  return out;
}

// --- reverb -------------------------------------------------------------------------------------------------------------------

/** A small deterministic PRNG (mulberry32) so an impulse response is the same every time. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The impulse response of a room: noise under an exponential decay that reaches -60 dB after `decay` seconds, darker as `damping`
 * (0..1) grows (a one-pole low-pass whose cutoff falls over time). Two channels with their own noise give width.
 */
export function impulseResponse(sampleRate: number, decay: number, damping: number, seed = 1, channels = 2): Float32Array<ArrayBuffer>[] {
  const len = Math.max(1, Math.floor(sampleRate * Math.max(0.05, decay)));
  const out: Float32Array<ArrayBuffer>[] = [];
  for (let c = 0; c < channels; c++) {
    const r = rng(seed + c * 7919);
    const buf = new Float32Array(len);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sampleRate;
      const env = 10 ** (-3 * t / Math.max(decay, 0.05)); // -60 dB at t = decay
      const white = r() * 2 - 1;
      // the filter closes with time and with damping: coefficient 1 = no filtering
      const a = Math.max(0.02, 1 - damping * (0.5 + 0.5 * Math.min(1, t / Math.max(decay, 0.05))));
      lp += a * (white - lp);
      buf[i] = lp * env;
    }
    out.push(buf);
  }
  return out;
}

// --- spectrum and waveform (the visualisers) ----------------------------------------------------------------------------------------

/** In-place radix-2 FFT; `re` and `im` have the same power-of-two length. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = i + k + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/**
 * `bands` magnitudes in 0..1 (log-spaced between minHz and maxHz, -80..0 dB) of the `size` samples of `data` starting at `start`
 * (zero outside the data). A Hann window; a full-scale sine reads about 1 in its band.
 */
export function spectrumBands(data: Float32Array, start: number, size: number, sampleRate: number, bands: number, minHz: number, maxHz: number): number[] {
  const re = new Float64Array(size), im = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    const idx = start + i;
    const s = idx >= 0 && idx < data.length ? data[idx] : 0;
    re[i] = s * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1)));
  }
  fft(re, im);
  const nyq = sampleRate / 2, half = size / 2;
  const mag = (bin: number) => (2 * Math.hypot(re[bin], im[bin])) / (size * 0.5);
  const out: number[] = [];
  const lo = Math.max(minHz, 1), hi = Math.min(maxHz, nyq);
  for (let b = 0; b < bands; b++) {
    const f0 = lo * (hi / lo) ** (b / bands), f1 = lo * (hi / lo) ** ((b + 1) / bands);
    const i0 = Math.max(1, Math.floor((f0 / nyq) * half)), i1 = Math.max(i0, Math.min(half - 1, Math.ceil((f1 / nyq) * half)));
    let peak = 0;
    for (let i = i0; i <= i1; i++) peak = Math.max(peak, mag(i));
    out.push(Math.min(1, Math.max(0, (gainToDb(peak) + 80) / 80)));
  }
  return out;
}

/** `count` values in -1..1: the sample of largest magnitude in each slice of the `window` samples starting at `start`. */
export function waveformWindow(data: Float32Array, start: number, window: number, count: number): number[] {
  const out: number[] = [];
  const step = window / count;
  for (let i = 0; i < count; i++) {
    const a = Math.floor(start + i * step), b = Math.max(a + 1, Math.floor(start + (i + 1) * step));
    let best = 0;
    for (let j = a; j < b; j++) {
      const s = j >= 0 && j < data.length ? data[j] : 0;
      if (Math.abs(s) > Math.abs(best)) best = s;
    }
    out.push(best);
  }
  return out;
}

// --- the noise gate -----------------------------------------------------------------------------------------------------------------

export interface GateParams { threshold: number; attack: number; release: number; hold: number; floor: number }
export interface GateState { env: number; gain: number; holdLeft: number }

/**
 * One block of a noise gate, in place over `channels`: a peak follower (1 ms attack, 10 ms release; `hold` is what keeps the gate open longer) on the loudest channel opens the gate
 * above `threshold` (linear), keeps it open for `hold` seconds after the level falls, and the gain glides to 1 (open) or `floor` (closed)
 * with `attack` / `release` seconds. SELF-CONTAINED on purpose: the AudioWorklet is built from this function's source text
 * (stages.ts), so the browser runs exactly what the tests run.
 */
export function gateBlock(state: GateState, channels: Float32Array[], p: GateParams, sr: number): void {
  const n = channels[0]?.length ?? 0;
  const att = 1 - Math.exp(-1 / (0.001 * sr)), rel = 1 - Math.exp(-1 / (0.01 * sr));
  const gUp = 1 - Math.exp(-1 / (Math.max(p.attack, 1e-4) * sr)), gDown = 1 - Math.exp(-1 / (Math.max(p.release, 1e-4) * sr));
  for (let i = 0; i < n; i++) {
    let x = 0;
    for (let c = 0; c < channels.length; c++) x = Math.max(x, Math.abs(channels[c][i]));
    state.env += (x > state.env ? att : rel) * (x - state.env);
    if (state.env >= p.threshold) state.holdLeft = p.hold * sr;
    else if (state.holdLeft > 0) state.holdLeft -= 1;
    const target = state.env >= p.threshold || state.holdLeft > 0 ? 1 : p.floor;
    state.gain += (target > state.gain ? gUp : gDown) * (target - state.gain);
    for (let c = 0; c < channels.length; c++) channels[c][i] *= state.gain;
  }
}

// --- the compressor ------------------------------------------------------------------------------------------------------------------

export interface CompressorParams { threshold: number; ratio: number; attack: number; release: number; knee: number; makeup: number }
export interface CompressorState { envDb: number; grDb: number }

/**
 * One block of a feed-forward compressor, in place over `channels`: the loudest channel's level is followed in dB (instant attack, `release`
 * seconds to fall), the gain reduction comes from the usual soft-knee curve (threshold dB, ratio, knee dB) and glides with `attack` and
 * `release`, then `makeup` (linear) is applied. NEUTRAL by design: below the threshold the gain is exactly `makeup`, unlike Web Audio's
 * DynamicsCompressorNode which adds its own automatic make-up gain. SELF-CONTAINED: the AudioWorklet is built from this function's source.
 */
export function compressBlock(state: CompressorState, channels: Float32Array[], p: CompressorParams, sr: number): void {
  const n = channels[0]?.length ?? 0;
  const att = 1 - Math.exp(-1 / (Math.max(p.attack, 1e-4) * sr)), rel = 1 - Math.exp(-1 / (Math.max(p.release, 1e-4) * sr));
  const slope = 1 / Math.max(p.ratio, 1) - 1;
  for (let i = 0; i < n; i++) {
    let x = 0;
    for (let c = 0; c < channels.length; c++) x = Math.max(x, Math.abs(channels[c][i]));
    const inDb = 20 * Math.log10(Math.max(x, 1e-9));
    // the level follower: instant up, `release` down, so the gain computer sees the peaks
    state.envDb = inDb > state.envDb ? inDb : state.envDb + rel * (inDb - state.envDb);
    const over = state.envDb - p.threshold;
    let gr = 0;
    if (2 * over >= p.knee) gr = slope * over;
    else if (2 * over > -p.knee) gr = (slope * (over + p.knee / 2) * (over + p.knee / 2)) / (2 * Math.max(p.knee, 1e-9));
    state.grDb += (gr < state.grDb ? att : rel) * (gr - state.grDb);
    const g = Math.pow(10, state.grDb / 20) * p.makeup;
    for (let c = 0; c < channels.length; c++) channels[c][i] *= g;
  }
}

// --- filters ---------------------------------------------------------------------------------------------------------------------------

/** The Q of each cascaded biquad of a Butterworth filter with `stages` second-order sections (12 dB/oct each). */
export function butterworthQs(stages: number): number[] {
  const order = stages * 2;
  const qs: number[] = [];
  for (let k = 0; k < stages; k++) qs.push(1 / (2 * Math.cos(((2 * k + 1) * Math.PI) / (2 * order))));
  return qs;
}

/** Power of an array's samples in dB relative to full scale (RMS). */
export function rmsDb(x: ArrayLike<number>, from = 0, to = x.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return gainToDb(Math.sqrt(s / Math.max(1, to - from)));
}
