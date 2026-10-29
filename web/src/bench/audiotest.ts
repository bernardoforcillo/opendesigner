import { renderOffline } from "@/animation/audio/offline";
import { reversedBuffer } from "@/animation/audio/library";
import { rmsDb, spectrumBands } from "@/animation/audio/dsp";
import { AUDIO_FX } from "@/animation/audio/effects";

// Measures what each audio effect does to a known signal, in a real browser's Web Audio (headless Chromium, offline rendering), so the
// chains the player builds are checked by their output and not only by compiling. `pnpm audio-check` runs it and fails on any miss.
const SR = 44100;

function makeBuffer(channels: Float32Array[]): AudioBuffer {
  const ctx = new OfflineAudioContext(channels.length, channels[0].length, SR);
  const b = ctx.createBuffer(channels.length, channels[0].length, SR);
  channels.forEach((c, i) => b.copyToChannel(c as Float32Array<ArrayBuffer>, i));
  return b;
}
const sine = (f: number, seconds: number, amp = 0.5) => Float32Array.from({ length: Math.round(seconds * SR) }, (_, i) => amp * Math.sin((2 * Math.PI * f * i) / SR));
const stereo = (x: Float32Array, y = x) => makeBuffer([x, y]);
const sum = (...xs: Float32Array[]) => Float32Array.from({ length: xs[0].length }, (_, i) => xs.reduce((s, x) => s + x[i], 0));
/** The level of a tone at `f` in `data` between two times (a correlation, so other tones do not count): dB re full scale. */
function toneDb(data: Float32Array, f: number, from: number, to: number): number {
  const a = Math.round(from * SR), b = Math.round(to * SR);
  let c = 0, s = 0;
  for (let i = a; i < b; i++) { const ph = (2 * Math.PI * f * i) / SR; c += data[i] * Math.cos(ph); s += data[i] * Math.sin(ph); }
  const amp = (2 * Math.hypot(c, s)) / (b - a);
  return 20 * Math.log10(Math.max(amp, 1e-9));
}
const ch = (b: AudioBuffer, i = 0) => b.getChannelData(i);

interface Check { name: string; ok: boolean; detail: string }
const checks: Check[] = [];
const check = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
const f1 = (x: number) => x.toFixed(1);

async function run(): Promise<Check[]> {
  const t = (id: string, values: Record<string, number>, input: AudioBuffer | null, seconds: number) => renderOffline({ effects: [{ id, values }], input, seconds });

  // High-Low Pass: a 3 kHz tone through a 500 Hz low-pass is far quieter, a 100 Hz tone is not; high-pass the other way
  {
    const tone3k = stereo(sine(3000, 1)), tone100 = stereo(sine(100, 1));
    const lp3k = await t("ec.audio.highlowpass", { filter: 1, cutoff: 500, slope: 2 }, tone3k, 1);
    const lp100 = await t("ec.audio.highlowpass", { filter: 1, cutoff: 500, slope: 2 }, tone100, 1);
    const drop = toneDb(ch(lp3k), 3000, 0.3, 0.9) - toneDb(sine(3000, 1, 0.5), 3000, 0.3, 0.9);
    const keep = toneDb(ch(lp100), 100, 0.3, 0.9) - toneDb(sine(100, 1, 0.5), 100, 0.3, 0.9);
    check("low-pass 500 Hz removes 3 kHz", drop < -30, `${f1(drop)} dB`);
    check("low-pass 500 Hz keeps 100 Hz", keep > -1.5, `${f1(keep)} dB`);
    const hp100 = await t("ec.audio.highlowpass", { filter: 0, cutoff: 1000, slope: 2 }, tone100, 1);
    const hpDrop = toneDb(ch(hp100), 100, 0.3, 0.9) - toneDb(sine(100, 1, 0.5), 100, 0.3, 0.9);
    check("high-pass 1 kHz removes 100 Hz", hpDrop < -30, `${f1(hpDrop)} dB`);
    const steep = await t("ec.audio.highlowpass", { filter: 1, cutoff: 1000, slope: 4 }, stereo(sine(2000, 1)), 1);
    const gentle = await t("ec.audio.highlowpass", { filter: 1, cutoff: 1000, slope: 1 }, stereo(sine(2000, 1)), 1);
    check("a steeper slope cuts more", toneDb(ch(steep), 2000, 0.3, 0.9) < toneDb(ch(gentle), 2000, 0.3, 0.9) - 10, `${f1(toneDb(ch(steep), 2000, 0.3, 0.9))} vs ${f1(toneDb(ch(gentle), 2000, 0.3, 0.9))} dB`);
  }

  // Bass & Treble
  {
    const lo = await t("ec.audio.basstreble", { bass: 12, treble: 0 }, stereo(sine(60, 1)), 1);
    const gain = toneDb(ch(lo), 60, 0.3, 0.9) - toneDb(sine(60, 1, 0.5), 60, 0.3, 0.9);
    check("bass +12 dB boosts 60 Hz", gain > 9 && gain < 13, `${f1(gain)} dB`);
    const hi = await t("ec.audio.basstreble", { bass: 0, treble: -12 }, stereo(sine(10000, 1)), 1);
    const cut = toneDb(ch(hi), 10000, 0.3, 0.9) - toneDb(sine(10000, 1, 0.5), 10000, 0.3, 0.9);
    check("treble -12 dB cuts 10 kHz", cut < -9 && cut > -13, `${f1(cut)} dB`);
  }

  // Parametric EQ
  {
    const r = await t("ec.audio.parametriceq", { m1F: 1000, m1G: 12, m1Q: 1 }, stereo(sine(1000, 1)), 1);
    const g = toneDb(ch(r), 1000, 0.3, 0.9) - toneDb(sine(1000, 1, 0.5), 1000, 0.3, 0.9);
    check("EQ peak +12 dB at 1 kHz", g > 10.5 && g < 13.5, `${f1(g)} dB`);
    const flat = await t("ec.audio.parametriceq", { m1F: 1000, m1G: 12, bypass: 1 }, stereo(sine(1000, 1)), 1);
    check("EQ bypass is flat", Math.abs(toneDb(ch(flat), 1000, 0.3, 0.9) - toneDb(sine(1000, 1, 0.5), 1000, 0.3, 0.9)) < 0.5, "bypass");
  }

  // Delay: an impulse comes back after `time`, `mix * feedback^n` as loud each time
  {
    const imp = new Float32Array(SR * 2); imp[1000] = 1;
    const r = await t("ec.audio.delay", { time: 300, feedback: 50, mix: 50, level: 0 }, stereo(imp), 2);
    const d = ch(r);
    const near = (sec: number) => { const c = 1000 + Math.round(sec * SR); let m = 0; for (let i = c - 40; i < c + 300; i++) m = Math.max(m, Math.abs(d[i])); return m; };
    check("delay: dry impulse at 0 s", near(0) > 0.45, `${near(0).toFixed(2)}`);
    check("delay: first echo at 300 ms", near(0.3) > 0.2 && near(0.3) < 0.55, `${near(0.3).toFixed(2)}`);
    check("delay: second echo at 600 ms is half the first", near(0.6) / near(0.3) > 0.4 && near(0.6) / near(0.3) < 0.65, `${(near(0.6) / near(0.3)).toFixed(2)}`);
    check("delay: nothing between the echoes", near(0.15) < 0.02, `${near(0.15).toFixed(3)}`);
  }

  // Compressor: a loud tone gets quieter, a quiet one (under the threshold) does not
  {
    const loud = await t("ec.audio.compressor", { threshold: -30, ratio: 10, attack: 1, release: 100, knee: 0, makeup: 0, mix: 100 }, stereo(sine(440, 1, 0.9)), 1);
    const reduce = toneDb(ch(loud), 440, 0.5, 0.95) - toneDb(sine(440, 1, 0.9), 440, 0.5, 0.95);
    check("compressor reduces a loud tone", reduce < -10, `${f1(reduce)} dB`);
    const quiet = await t("ec.audio.compressor", { threshold: -20, ratio: 10, attack: 1, release: 100, knee: 0, makeup: 0, mix: 100 }, stereo(sine(440, 1, 0.01)), 1);
    const same = toneDb(ch(quiet), 440, 0.5, 0.95) - toneDb(sine(440, 1, 0.01), 440, 0.5, 0.95);
    check("compressor leaves a quiet tone alone", Math.abs(same) < 1.5, `${f1(same)} dB`);
    const makeup = await t("ec.audio.compressor", { threshold: 0, ratio: 1, attack: 1, release: 100, knee: 0, makeup: 12, mix: 100 }, stereo(sine(440, 1, 0.1)), 1);
    const up = toneDb(ch(makeup), 440, 0.5, 0.95) - toneDb(sine(440, 1, 0.1), 440, 0.5, 0.95);
    check("compressor make-up gain +12 dB", up > 10.5 && up < 13.5, `${f1(up)} dB`);
  }

  // Distortion: harmonics appear, the level stays in range
  {
    const r = await t("ec.audio.distortion", { type: 1, drive: 80, mix: 100, level: 0, tone: 20000 }, stereo(sine(500, 1, 0.5)), 1);
    const third = toneDb(ch(r), 1500, 0.3, 0.9), clean = toneDb(sine(500, 1, 0.5), 1500, 0.3, 0.9);
    check("distortion adds a 3rd harmonic", third > clean + 40 && third > -30, `${f1(third)} dB (clean ${f1(clean)})`);
    const settled = ch(r).slice(Math.round(0.3 * SR), Math.round(0.9 * SR));
    // a hard-clipped square rings a little when it is band-limited (Gibbs), a few percent over full scale at most
    check("distortion stays within ±1 (plus ringing)", Math.max(...settled.map(Math.abs)) <= 1.1, `${Math.max(...settled.map(Math.abs)).toFixed(3)}`);
    const dry = await t("ec.audio.distortion", { type: 1, drive: 80, mix: 0, level: 0, tone: 20000 }, stereo(sine(500, 1, 0.5)), 1);
    check("distortion at mix 0 is the dry sound", Math.abs(toneDb(ch(dry), 500, 0.3, 0.9) - toneDb(sine(500, 1, 0.5), 500, 0.3, 0.9)) < 0.5, "mix 0");
  }

  // Flange & Chorus and Modulator: the sound is changed over time, and the dry sound survives at mix 0 / depth 0
  {
    const noise = Float32Array.from({ length: SR * 2 }, (_, i) => Math.sin(i * 12.9898) * 43758.5453 % 1 * 0.4);
    const fl = await t("ec.audio.flangechorus", { mode: 0, delay: 4, rate: 1, depth: 80, feedback: 60, mix: 50 }, stereo(noise), 2);
    const bands = (b: AudioBuffer, from: number) => spectrumBands(ch(b), Math.round(from * SR), 4096, SR, 24, 100, 10000);
    const a = bands(fl, 0.5), b2 = bands(fl, 0.75);
    const moved = a.reduce((s, v, i) => s + Math.abs(v - b2[i]), 0);
    check("flanger: the comb moves over time", moved > 0.8, `spectrum change ${moved.toFixed(2)}`);
    const trem = await t("ec.audio.modulator", { type: 0, rate: 4, depth: 100, shape: 0 }, stereo(sine(440, 2, 0.5)), 2);
    const levels = Array.from({ length: 16 }, (_, k) => rmsDb(ch(trem), Math.round((0.4 + k * 0.1) * SR), Math.round((0.5 + k * 0.1) * SR)));
    check("tremolo: the level swings", Math.max(...levels) - Math.min(...levels) > 12, `${f1(Math.max(...levels) - Math.min(...levels))} dB swing`);
    const steady = await t("ec.audio.modulator", { type: 0, rate: 4, depth: 0, shape: 0 }, stereo(sine(440, 2, 0.5)), 2);
    const l2 = Array.from({ length: 16 }, (_, k) => rmsDb(ch(steady), Math.round((0.4 + k * 0.1) * SR), Math.round((0.5 + k * 0.1) * SR)));
    check("tremolo at depth 0 is steady", Math.max(...l2) - Math.min(...l2) < 0.5, `${f1(Math.max(...l2) - Math.min(...l2))} dB`);
    const ring = await t("ec.audio.modulator", { type: 2, rate: 100, depth: 100, shape: 0 }, stereo(sine(1000, 1, 0.5)), 1);
    check("ring modulation makes sidebands at 900 and 1100 Hz", toneDb(ch(ring), 900, 0.3, 0.9) > -16 && toneDb(ch(ring), 1100, 0.3, 0.9) > -16 && toneDb(ch(ring), 1000, 0.3, 0.9) < -30, `900 Hz ${f1(toneDb(ch(ring), 900, 0.3, 0.9))} dB, 1000 Hz ${f1(toneDb(ch(ring), 1000, 0.3, 0.9))} dB`);
  }

  // Reverb: the tail rings on after the sound stopped and dies away; mix 0 is dry
  {
    const burst = new Float32Array(SR * 3); burst.set(sine(500, 0.1, 0.5));
    const r = await t("ec.audio.reverb", { decay: 1.5, damping: 30, preDelay: 0, mix: 60, level: 0 }, stereo(burst), 3);
    const d = ch(r);
    const early = rmsDb(d, Math.round(0.15 * SR), Math.round(0.35 * SR)), late = rmsDb(d, Math.round(1.6 * SR), Math.round(1.9 * SR));
    check("reverb: a tail after the sound", early > -45, `${f1(early)} dB at 0.15-0.35 s`);
    check("reverb: the tail decays", early - late > 20, `${f1(early - late)} dB lower at 1.6 s`);
    const dry = await t("ec.audio.reverb", { decay: 1.5, damping: 30, preDelay: 0, mix: 0, level: 0 }, stereo(burst), 3);
    check("reverb at mix 0 has no tail", rmsDb(ch(dry), Math.round(0.15 * SR), Math.round(0.35 * SR)) < -100, `${f1(rmsDb(ch(dry), Math.round(0.15 * SR), Math.round(0.35 * SR)))} dB`);
  }

  // Gate: loud passes, quiet is cut
  {
    const x = new Float32Array(SR * 2); x.set(sine(440, 1, 0.5)); x.set(sine(440, 1, 0.01), SR);
    const r = await t("ec.audio.gate", { threshold: -30, attack: 2, release: 30, hold: 20, floor: -80 }, stereo(x), 2);
    const loud = toneDb(ch(r), 440, 0.2, 0.8) - toneDb(x, 440, 0.2, 0.8);
    const quiet = toneDb(ch(r), 440, 1.3, 1.9) - toneDb(x, 440, 1.3, 1.9);
    check("gate passes the loud part", loud > -1.5, `${f1(loud)} dB`);
    check("gate cuts the quiet part", quiet < -30, `${f1(quiet)} dB`);
  }

  // Stereo Mixer: hard left, level and phase
  {
    const r = await t("ec.audio.stereomixer", { left: 0, right: -60, leftPan: -100, rightPan: 100, invert: 0 }, stereo(sine(440, 1, 0.5)), 1);
    check("stereo mixer: right channel muted", toneDb(ch(r, 1), 440, 0.3, 0.9) < -60, `${f1(toneDb(ch(r, 1), 440, 0.3, 0.9))} dB`);
    check("stereo mixer: left channel kept", toneDb(ch(r, 0), 440, 0.3, 0.9) > -8, `${f1(toneDb(ch(r, 0), 440, 0.3, 0.9))} dB`);
    const inv = await t("ec.audio.stereomixer", { left: 0, right: 0, leftPan: -100, rightPan: 100, invert: 1 }, stereo(sine(440, 1, 0.5)), 1);
    const a = ch(inv, 0), orig = sine(440, 1, 0.5);
    check("stereo mixer: phase inverted", a[20000] * orig[20000] < 0, `${a[20000].toFixed(3)} vs ${orig[20000].toFixed(3)}`);
  }

  // Tone: a generator; with the sound kept and without
  {
    const r = await t("ec.audio.tone", { wave: 0, frequency: 880, level: -6, fadeIn: 10, through: 1 }, null, 1);
    check("tone: 880 Hz at about -6 dB", Math.abs(toneDb(ch(r), 880, 0.3, 0.9) - -6) < 1.5, `${f1(toneDb(ch(r), 880, 0.3, 0.9))} dB`);
    const both = await t("ec.audio.tone", { wave: 0, frequency: 880, level: -6, fadeIn: 10, through: 1 }, stereo(sine(220, 1, 0.5)), 1);
    check("tone: added to the sound", toneDb(ch(both), 220, 0.3, 0.9) > -8 && toneDb(ch(both), 880, 0.3, 0.9) > -8, `220 Hz ${f1(toneDb(ch(both), 220, 0.3, 0.9))} dB, 880 Hz ${f1(toneDb(ch(both), 880, 0.3, 0.9))} dB`);
    const solo = await t("ec.audio.tone", { wave: 1, frequency: 880, level: -6, fadeIn: 10, through: 0 }, stereo(sine(220, 1, 0.5)), 1);
    check("tone: without the original", toneDb(ch(solo), 220, 0.3, 0.9) < -40, `${f1(toneDb(ch(solo), 220, 0.3, 0.9))} dB`);
  }

  // Backwards: the sound plays from its end; swap channels
  {
    const ramp = Float32Array.from({ length: SR }, (_, i) => i / SR * 0.8);
    const r = await t("ec.audio.backwards", { swap: 0 }, stereo(ramp), 1);
    check("backwards: starts where the sound ended", Math.abs(ch(r)[2000] - 0.8 * (1 - 2000 / SR)) < 0.02, `${ch(r)[2000].toFixed(3)}`);
    const rev = reversedBuffer(new OfflineAudioContext(2, 10, SR), stereo(ramp));
    check("backwards: the reversed buffer is the original reversed", rev.getChannelData(0)[0] === ramp[SR - 1], "buffer");
    const sw = await t("ec.audio.backwards", { swap: 1 }, stereo(sine(440, 1, 0.5), sine(440, 1, 0.0)), 1);
    check("backwards: swap channels", toneDb(ch(sw, 1), 440, 0.3, 0.9) > -8 && toneDb(ch(sw, 0), 440, 0.3, 0.9) < -60, `L ${f1(toneDb(ch(sw, 0), 440, 0.3, 0.9))} dB, R ${f1(toneDb(ch(sw, 1), 440, 0.3, 0.9))} dB`);
  }

  // A chain: order matters and every stage runs
  {
    const r = await renderOffline({ effects: [{ id: "ec.audio.highlowpass", values: { filter: 1, cutoff: 800, slope: 2 } }, { id: "ec.audio.basstreble", values: { bass: 0, treble: 0 } }], input: stereo(sum(sine(300, 1, 0.3), sine(6000, 1, 0.3))), seconds: 1 });
    check("chain: low-pass then EQ keeps 300 Hz, removes 6 kHz", toneDb(ch(r), 300, 0.3, 0.9) > -12 && toneDb(ch(r), 6000, 0.3, 0.9) < -45, `300 Hz ${f1(toneDb(ch(r), 300, 0.3, 0.9))} dB, 6 kHz ${f1(toneDb(ch(r), 6000, 0.3, 0.9))} dB`);
  }

  check("every audio effect of the catalog is covered", AUDIO_FX.length === 13, `${AUDIO_FX.length} effects`);
  return checks;
}

// @ts-expect-error exposed to Playwright
window.runAudioChecks = run;
