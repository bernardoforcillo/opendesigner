// THE AUDIO EFFECTS of EffectCraft's Audio category, as Web Audio graphs. An effect is a stage with an input and an output; the player
// chains the node's audio effects in track order between the sound and the speakers, and calls `update` with the effect's animated
// parameters as the playhead moves, so a keyframed delay time or cutoff changes the sound while it plays.
//
// What each one is (the parameter names follow EffectCraft; the DSP is Web Audio's, so it is the same family of algorithm but not the same
// code): Backwards reverses the sound; Bass & Treble are two shelves; Compressor is a dynamics compressor with make-up gain; Delay a feedback
// delay; Distortion a waveshaper; Flange & Chorus a modulated delay; Gate an AudioWorklet (dsp.ts::gateBlock); High-Low Pass cascaded Butterworth
// sections; Modulator tremolo, vibrato or ring modulation; Parametric EQ five bands; Reverb a convolution with a generated room; Stereo Mixer
// level, pan and phase per channel; Tone an oscillator mixed with the sound.

import type { AudioStage, FxDef, FxValues } from "@/animation/fx/library";
import { P } from "@/animation/fx/kit";
import { butterworthQs, compressBlock, dbToGain, distortionCurve, gateBlock, impulseResponse, type DistortionKind } from "@/animation/audio/dsp";

const SMOOTH = 0.02; // seconds: parameter changes glide, so animating one does not click

const set = (p: AudioParam, value: number, now: number) => {
  if (!Number.isFinite(value)) return;
  p.setTargetAtTime(value, now, SMOOTH);
};

/** A dry / wet pair: `mix` 0..1; the dry path is the input itself. Returns where the wet path starts (`wetIn`) and ends (`wetOut`). */
function dryWet(ctx: BaseAudioContext) {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain();
  const wetIn = ctx.createGain();
  const wetOut = ctx.createGain();
  input.connect(dry).connect(output);
  input.connect(wetIn);
  wetOut.connect(output);
  const setMix = (mix: number, now: number) => {
    const m = Math.min(1, Math.max(0, mix));
    set(dry.gain, 1 - m, now);
    set(wetOut.gain, m, now);
  };
  return { input, output, wetIn, wetOut, setMix, nodes: [input, output, dry, wetIn, wetOut] as AudioNode[] };
}

const disposeAll = (nodes: (AudioNode | undefined)[], sources: (OscillatorNode | undefined)[] = []) => () => {
  for (const s of sources) { try { s?.stop(); } catch { /* not started */ } }
  for (const n of [...sources, ...nodes]) { try { n?.disconnect(); } catch { /* already */ } }
};

const mixParam = P("mix", "Mix", 0, 100, 100, 1, "%");
const dB = (id: string, label: string, min: number, max: number, def: number) => P(id, label, min, max, def, 0.1, "dB");

// --- the effects ---------------------------------------------------------------------------------------------------------------------------

export const AUDIO_FX: FxDef[] = [
  {
    id: "ec.audio.backwards",
    params: [P("swap", "Swap Channels", 0, 1, 0)],
    audio: (ctx) => {
      const input = ctx.createGain(), output = ctx.createGain();
      const split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2), keep = ctx.createGain(), swapped = ctx.createGain();
      input.channelCount = 2; input.channelCountMode = "explicit";
      input.connect(keep).connect(output);
      input.connect(split);
      split.connect(merge, 0, 1); split.connect(merge, 1, 0);
      merge.connect(swapped).connect(output);
      swapped.gain.value = 0;
      return {
        input, output, reverse: true,
        update: (v, now) => { const s = v.swap > 0.5 ? 1 : 0; set(keep.gain, 1 - s, now); set(swapped.gain, s, now); },
        dispose: disposeAll([input, output, split, merge, keep, swapped]),
      };
    },
  },

  {
    id: "ec.audio.basstreble",
    params: [dB("bass", "Bass", -24, 24, 0), dB("treble", "Treble", -24, 24, 0)],
    audio: (ctx) => {
      const low = ctx.createBiquadFilter(), high = ctx.createBiquadFilter();
      low.type = "lowshelf"; low.frequency.value = 250;
      high.type = "highshelf"; high.frequency.value = 4000;
      low.connect(high);
      return { input: low, output: high, update: (v, now) => { set(low.gain, v.bass, now); set(high.gain, v.treble, now); }, dispose: disposeAll([low, high]) };
    },
  },

  {
    id: "ec.audio.compressor",
    params: [
      dB("threshold", "Threshold", -100, 0, -24), P("ratio", "Ratio", 1, 20, 4, 0.1), P("attack", "Attack", 0.1, 1000, 5, 0.1, "ms"), P("release", "Release", 1, 2000, 250, 1, "ms"),
      dB("knee", "Knee", 0, 40, 6), dB("makeup", "Make-up Gain", 0, 36, 0), mixParam, dB("output", "Output Level", -24, 12, 0),
    ],
    audio: (ctx) => {
      const w = dryWet(ctx), out = ctx.createGain();
      let node: AudioWorkletNode | null = null;
      try { node = new AudioWorkletNode(ctx, COMPRESSOR_PROCESSOR, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] }); } catch { node = null; }
      if (node) w.wetIn.connect(node).connect(w.wetOut); else w.wetIn.connect(w.wetOut);
      w.output.connect(out);
      const names = ["threshold", "ratio", "attack", "release", "knee", "makeup"] as const;
      return {
        input: w.input, output: out,
        update: (v, now) => {
          if (node) {
            const lin = { threshold: v.threshold, ratio: v.ratio, attack: v.attack / 1000, release: v.release / 1000, knee: v.knee, makeup: dbToGain(v.makeup) };
            for (const n of names) set(node.parameters.get(n)!, lin[n], now);
          }
          set(out.gain, dbToGain(v.output), now); w.setMix(v.mix / 100, now);
        },
        dispose: disposeAll([...w.nodes, node ?? undefined, out]),
      };
    },
  },

  {
    id: "ec.audio.delay",
    params: [P("time", "Delay Time", 1, 5000, 300, 1, "ms"), P("feedback", "Feedback", 0, 95, 40, 1, "%"), P("mix", "Wet Mix", 0, 100, 50, 1, "%"), dB("level", "Output Level", -24, 12, 0)],
    audio: (ctx) => {
      const w = dryWet(ctx), delay = ctx.createDelay(5), fb = ctx.createGain(), out = ctx.createGain();
      w.wetIn.connect(delay).connect(w.wetOut);
      delay.connect(fb).connect(delay);
      w.output.connect(out);
      return {
        input: w.input, output: out,
        update: (v, now) => { set(delay.delayTime, v.time / 1000, now); set(fb.gain, Math.min(0.95, v.feedback / 100), now); w.setMix(v.mix / 100, now); set(out.gain, dbToGain(v.level), now); },
        dispose: disposeAll([...w.nodes, delay, fb, out]),
      };
    },
  },

  {
    id: "ec.audio.distortion",
    params: [P("type", "Type (0 Soft, 1 Hard, 2 Fuzz, 3 Bit Crush)", 0, 3, 0), P("drive", "Drive", 0, 100, 50), mixParam, dB("level", "Output Level", -24, 12, -3), P("tone", "Tone (Low-pass)", 200, 20000, 12000, 10, "Hz")],
    audio: (ctx) => {
      const w = dryWet(ctx), shaper = ctx.createWaveShaper(), tone = ctx.createBiquadFilter(), out = ctx.createGain();
      shaper.oversample = "4x"; tone.type = "lowpass"; tone.Q.value = 0.7071;
      w.wetIn.connect(shaper).connect(tone).connect(w.wetOut);
      w.output.connect(out);
      let last = "";
      return {
        input: w.input, output: out,
        update: (v, now) => {
          const kind = (["soft", "hard", "fuzz", "crush"] as DistortionKind[])[Math.round(v.type)] ?? "soft";
          const key = `${kind}:${Math.round(v.drive)}`;
          if (key !== last) { shaper.curve = distortionCurve(kind, v.drive); last = key; }
          set(tone.frequency, v.tone, now); set(out.gain, dbToGain(v.level), now); w.setMix(v.mix / 100, now);
        },
        dispose: disposeAll([...w.nodes, shaper, tone, out]),
      };
    },
  },

  {
    id: "ec.audio.flangechorus",
    params: [
      P("mode", "Mode (0 Flanger, 1 Chorus)", 0, 1, 0), P("delay", "Voice Separation", 0.5, 50, 4, 0.1, "ms"), P("rate", "Modulation Rate", 0.05, 10, 0.5, 0.05, "Hz"), P("depth", "Modulation Depth", 0, 100, 60, 1, "%"),
      P("feedback", "Voice Phase / Feedback", -95, 95, 40, 1, "%"), P("mix", "Dry/Wet Mix", 0, 100, 50, 1, "%"),
    ],
    audio: (ctx) => {
      const w = dryWet(ctx), delay = ctx.createDelay(0.2), lfo = ctx.createOscillator(), depth = ctx.createGain(), fb = ctx.createGain();
      lfo.type = "sine";
      lfo.connect(depth).connect(delay.delayTime);
      w.wetIn.connect(delay).connect(w.wetOut);
      delay.connect(fb).connect(delay);
      lfo.start();
      return {
        input: w.input, output: w.output,
        update: (v, now) => {
          const base = v.delay / 1000 * (v.mode > 0.5 ? 5 : 1); // a chorus sits further out than a flanger
          set(delay.delayTime, base, now);
          set(depth.gain, base * (v.depth / 100) * 0.9, now);
          set(lfo.frequency, v.rate, now);
          set(fb.gain, v.mode > 0.5 ? 0 : v.feedback / 100, now);
          w.setMix(v.mix / 100, now);
        },
        dispose: disposeAll([...w.nodes, delay, depth, fb], [lfo]),
      };
    },
  },

  {
    id: "ec.audio.gate",
    params: [dB("threshold", "Threshold", -80, 0, -40), P("attack", "Attack", 0.1, 500, 5, 0.1, "ms"), P("release", "Release", 1, 2000, 120, 1, "ms"), P("hold", "Hold", 0, 2000, 50, 1, "ms"), dB("floor", "Floor", -80, 0, -80)],
    audio: (ctx) => {
      const input = ctx.createGain(), output = ctx.createGain();
      let node: AudioWorkletNode | null = null;
      try { node = new AudioWorkletNode(ctx, GATE_PROCESSOR, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] }); } catch { node = null; }
      // without the worklet (not prepared, or unsupported) the sound passes unchanged rather than the effect failing
      if (node) input.connect(node).connect(output); else input.connect(output);
      const names = ["threshold", "attack", "release", "hold", "floor"] as const;
      return {
        input, output,
        update: (v, now) => {
          if (!node) return;
          const lin = { threshold: dbToGain(v.threshold), attack: v.attack / 1000, release: v.release / 1000, hold: v.hold / 1000, floor: v.floor <= -79.9 ? 0 : dbToGain(v.floor) };
          for (const n of names) set(node.parameters.get(n)!, lin[n], now);
        },
        dispose: disposeAll([input, output, node ?? undefined]),
      };
    },
  },

  {
    id: "ec.audio.highlowpass",
    params: [P("filter", "Filter (0 High Pass, 1 Low Pass)", 0, 1, 1), P("cutoff", "Cutoff Frequency", 20, 20000, 1000, 1, "Hz"), P("slope", "Slope (12 dB/oct per step)", 1, 4, 2, 1), P("q", "Resonance", 0.1, 10, 0.7071, 0.01)],
    audio: (ctx) => {
      const input = ctx.createGain(), output = ctx.createGain();
      const stages = [0, 1, 2, 3].map(() => ctx.createBiquadFilter());
      let wired = 0;
      const wire = (n: number) => {
        if (n === wired) return;
        input.disconnect(); stages.forEach((s) => s.disconnect());
        const used = stages.slice(0, n);
        input.connect(used[0]);
        used.forEach((s, i) => s.connect(used[i + 1] ?? output));
        wired = n;
      };
      return {
        input, output,
        update: (v, now) => {
          const n = Math.max(1, Math.min(4, Math.round(v.slope)));
          wire(n);
          const qs = butterworthQs(n);
          stages.slice(0, n).forEach((s, i) => {
            s.type = v.filter > 0.5 ? "lowpass" : "highpass";
            set(s.frequency, v.cutoff, now);
            // the first section takes the user's resonance on top of its Butterworth Q, so 0.7071 is the plain Butterworth response
            set(s.Q, qs[i] * (i === 0 ? v.q / 0.7071 : 1), now);
          });
        },
        dispose: disposeAll([input, output, ...stages]),
      };
    },
  },

  {
    id: "ec.audio.modulator",
    params: [P("type", "Type (0 Tremolo, 1 Vibrato, 2 Ring Modulator)", 0, 2, 0), P("rate", "Modulation Rate", 0.1, 5000, 5, 0.1, "Hz"), P("depth", "Modulation Depth", 0, 100, 60, 1, "%"), P("shape", "Shape (0 Sine, 1 Square, 2 Triangle, 3 Sawtooth)", 0, 3, 0)],
    audio: (ctx) => {
      const input = ctx.createGain(), output = ctx.createGain();
      const lfo = ctx.createOscillator();
      // tremolo: the sound's gain follows the LFO
      const trem = ctx.createGain(), tremDepth = ctx.createGain(), tremOut = ctx.createGain();
      lfo.connect(tremDepth).connect(trem.gain);
      input.connect(trem).connect(tremOut).connect(output);
      // vibrato: the delay time follows the LFO
      const vib = ctx.createDelay(0.05), vibDepth = ctx.createGain(), vibOut = ctx.createGain();
      lfo.connect(vibDepth).connect(vib.delayTime);
      input.connect(vib).connect(vibOut).connect(output);
      // ring modulation: the sound is multiplied by an oscillator
      const ring = ctx.createGain(), ringOsc = ctx.createOscillator(), ringOut = ctx.createGain();
      ring.gain.value = 0;
      ringOsc.connect(ring.gain);
      input.connect(ring).connect(ringOut).connect(output);
      lfo.start(); ringOsc.start();
      const shapes: OscillatorType[] = ["sine", "square", "triangle", "sawtooth"];
      return {
        input, output,
        update: (v, now) => {
          const t = Math.round(v.type), d = v.depth / 100;
          lfo.type = ringOsc.type = shapes[Math.round(v.shape)] ?? "sine";
          set(lfo.frequency, Math.min(v.rate, 40), now); set(ringOsc.frequency, v.rate, now);
          set(trem.gain, 1 - d / 2, now); set(tremDepth.gain, d / 2, now);
          set(vib.delayTime, 0.01, now); set(vibDepth.gain, 0.008 * d, now);
          set(tremOut.gain, t === 0 ? 1 : 0, now); set(vibOut.gain, t === 1 ? 1 : 0, now); set(ringOut.gain, t === 2 ? 1 : 0, now);
        },
        dispose: disposeAll([input, output, trem, tremDepth, tremOut, vib, vibDepth, vibOut, ring, ringOut], [lfo, ringOsc]),
      };
    },
  },

  {
    id: "ec.audio.parametriceq",
    params: [
      P("lowF", "Low Shelf Frequency", 20, 2000, 120, 1, "Hz"), dB("lowG", "Low Shelf Gain", -24, 24, 0),
      P("m1F", "Mid 1 Frequency", 50, 10000, 500, 1, "Hz"), dB("m1G", "Mid 1 Gain", -24, 24, 0), P("m1Q", "Mid 1 Q", 0.1, 20, 1, 0.05),
      P("m2F", "Mid 2 Frequency", 100, 16000, 3000, 1, "Hz"), dB("m2G", "Mid 2 Gain", -24, 24, 0), P("m2Q", "Mid 2 Q", 0.1, 20, 1, 0.05),
      P("hiF", "High Shelf Frequency", 1000, 20000, 8000, 1, "Hz"), dB("hiG", "High Shelf Gain", -24, 24, 0), dB("out", "Output Gain", -24, 24, 0), P("bypass", "Bypass", 0, 1, 0),
    ],
    audio: (ctx) => {
      const low = ctx.createBiquadFilter(), m1 = ctx.createBiquadFilter(), m2 = ctx.createBiquadFilter(), high = ctx.createBiquadFilter(), out = ctx.createGain();
      low.type = "lowshelf"; m1.type = "peaking"; m2.type = "peaking"; high.type = "highshelf";
      low.connect(m1).connect(m2).connect(high).connect(out);
      return {
        input: low, output: out,
        update: (v, now) => {
          const g = (x: number) => (v.bypass > 0.5 ? 0 : x);
          set(low.frequency, v.lowF, now); set(low.gain, g(v.lowG), now);
          set(m1.frequency, v.m1F, now); set(m1.gain, g(v.m1G), now); set(m1.Q, v.m1Q, now);
          set(m2.frequency, v.m2F, now); set(m2.gain, g(v.m2G), now); set(m2.Q, v.m2Q, now);
          set(high.frequency, v.hiF, now); set(high.gain, g(v.hiG), now);
          set(out.gain, v.bypass > 0.5 ? 1 : dbToGain(v.out), now);
        },
        dispose: disposeAll([low, m1, m2, high, out]),
      };
    },
  },

  {
    id: "ec.audio.reverb",
    params: [P("decay", "Reverb Time", 0.1, 10, 2, 0.05, "s"), P("damping", "Damping", 0, 100, 40, 1, "%"), P("preDelay", "Pre-delay", 0, 200, 10, 1, "ms"), P("mix", "Wet Mix", 0, 100, 30, 1, "%"), dB("level", "Output Level", -24, 12, 0)],
    audio: (ctx) => {
      const w = dryWet(ctx), pre = ctx.createDelay(0.5), conv = ctx.createConvolver(), out = ctx.createGain();
      w.wetIn.connect(pre).connect(conv).connect(w.wetOut);
      w.output.connect(out);
      let built = "";
      return {
        input: w.input, output: out,
        update: (v, now) => {
          // the room is rebuilt only when its shape really changed (it costs a few milliseconds)
          const key = `${Math.round(v.decay * 10)}:${Math.round(v.damping / 5)}`;
          if (key !== built) {
            const ir = impulseResponse(ctx.sampleRate, v.decay, v.damping / 100, 11, 2);
            const buf = ctx.createBuffer(2, ir[0].length, ctx.sampleRate);
            ir.forEach((c, i) => buf.copyToChannel(c, i));
            conv.buffer = buf;
            built = key;
          }
          set(pre.delayTime, v.preDelay / 1000, now); w.setMix(v.mix / 100, now); set(out.gain, dbToGain(v.level), now);
        },
        dispose: disposeAll([...w.nodes, pre, conv, out]),
      };
    },
  },

  {
    id: "ec.audio.stereomixer",
    params: [dB("left", "Left Level", -60, 12, 0), dB("right", "Right Level", -60, 12, 0), P("leftPan", "Left Pan", -100, 100, -100, 1), P("rightPan", "Right Pan", -100, 100, 100, 1), P("invert", "Invert Phase", 0, 1, 0)],
    audio: (ctx) => {
      const input = ctx.createGain(), output = ctx.createGain(), split = ctx.createChannelSplitter(2);
      input.channelCount = 2; input.channelCountMode = "explicit";
      const gl = ctx.createGain(), gr = ctx.createGain(), pl = ctx.createStereoPanner(), pr = ctx.createStereoPanner(), phase = ctx.createGain();
      input.connect(split);
      split.connect(gl, 0); split.connect(gr, 1);
      gl.connect(pl).connect(phase); gr.connect(pr).connect(phase);
      phase.connect(output);
      return {
        input, output,
        update: (v, now) => {
          set(gl.gain, dbToGain(v.left), now); set(gr.gain, dbToGain(v.right), now);
          set(pl.pan, v.leftPan / 100, now); set(pr.pan, v.rightPan / 100, now);
          set(phase.gain, v.invert > 0.5 ? -1 : 1, now);
        },
        dispose: disposeAll([input, output, split, gl, gr, pl, pr, phase]),
      };
    },
  },

  {
    id: "ec.audio.tone",
    params: [P("wave", "Waveform (0 Sine, 1 Square, 2 Triangle, 3 Sawtooth)", 0, 3, 0), P("frequency", "Frequency", 20, 20000, 440, 1, "Hz"), dB("level", "Level", -60, 0, -12), P("detune", "Detune", -1200, 1200, 0, 1, "cents"), P("fadeIn", "Fade In", 0, 5000, 20, 1, "ms"), P("through", "Keep the Original Sound", 0, 1, 1)],
    audio: (ctx) => {
      // a generator that is added to whatever comes in (nothing, if the node has no sound of its own)
      const input = ctx.createGain(), output = ctx.createGain(), pass = ctx.createGain(), osc = ctx.createOscillator(), level = ctx.createGain(), fade = ctx.createGain();
      input.connect(pass).connect(output);
      osc.connect(level).connect(fade).connect(output);
      fade.gain.value = 0;
      const waves: OscillatorType[] = ["sine", "square", "triangle", "sawtooth"];
      let fadeSec = 0.02;
      return {
        input, output,
        start: (when) => {
          osc.start(when);
          // the tone comes in over the fade-in time instead of with a click
          fade.gain.cancelScheduledValues(when);
          fade.gain.setValueAtTime(0, when);
          fade.gain.linearRampToValueAtTime(1, when + Math.max(fadeSec, 0.001));
        },
        update: (v, now) => {
          fadeSec = v.fadeIn / 1000;
          osc.type = waves[Math.round(v.wave)] ?? "sine";
          set(osc.frequency, v.frequency, now); set(osc.detune, v.detune, now); set(level.gain, dbToGain(v.level), now); set(pass.gain, v.through > 0.5 ? 1 : 0, now);
        },
        dispose: disposeAll([input, output, pass, level, fade], [osc]),
      };
    },
  },
];

// --- the gate's AudioWorklet -----------------------------------------------------------------------------------------------------------------------

export const GATE_PROCESSOR = "ec-gate";
export const COMPRESSOR_PROCESSOR = "ec-compressor";

/** The worklet module's source: dsp.ts::gateBlock and ::compressBlock's own text plus the processors around them. */
export function workletSource(): string {
  const processor = (name: string, cls: string, fn: string, stateInit: string, params: [string, number][]) => `
class ${cls} extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return ${JSON.stringify(params)}.map(([name, defaultValue]) => ({ name, defaultValue, automationRate: "k-rate" }));
  }
  constructor() { super(); this.state = ${stateInit}; }
  process(inputs, outputs, parameters) {
    const inp = inputs[0], out = outputs[0];
    if (!inp || inp.length === 0) return true;
    const chans = [];
    for (let c = 0; c < out.length; c++) { out[c].set(inp[c] || inp[0]); chans.push(out[c]); }
    const p = {};
    for (const k in parameters) p[k] = parameters[k][0];
    ${fn}(this.state, chans, p, sampleRate);
    return true;
  }
}
registerProcessor("${name}", ${cls});`;
  return `const gateBlock = (${gateBlock.toString()});
const compressBlock = (${compressBlock.toString()});
${processor(GATE_PROCESSOR, "EcGate", "gateBlock", "{ env: 0, gain: 0, holdLeft: 0 }", [["threshold", 0.01], ["attack", 0.005], ["release", 0.12], ["hold", 0.05], ["floor", 0]])}
${processor(COMPRESSOR_PROCESSOR, "EcCompressor", "compressBlock", "{ envDb: -120, grDb: 0 }", [["threshold", -24], ["ratio", 4], ["attack", 0.005], ["release", 0.25], ["knee", 6], ["makeup", 1]])}`;
}

const prepared = new WeakSet<BaseAudioContext>();

/** Loads what the effects need into `ctx` (the gate's worklet). Await it before building a chain. */
export async function prepareAudio(ctx: BaseAudioContext): Promise<void> {
  if (prepared.has(ctx) || !ctx.audioWorklet) return;
  const url = URL.createObjectURL(new Blob([workletSource()], { type: "text/javascript" }));
  try {
    await ctx.audioWorklet.addModule(url);
    prepared.add(ctx);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// --- chains ---------------------------------------------------------------------------------------------------------------------------------------

export interface ChainEffect { id: string; values: FxValues }
export interface Chain { input: AudioNode; output: AudioNode; stages: { id: string; stage: AudioStage }[]; reverse: boolean; update(effects: readonly ChainEffect[], now: number): void; start(when: number): void; dispose(): void }

/**
 * The chain of `effects` (audio effects only, in order): the first stage's input is `input`, each output feeds the next. `update`
 * moves every stage's parameters; the ids must be the ones the chain was built from (the player rebuilds when they change).
 */
export function buildChain(ctx: BaseAudioContext, effects: readonly ChainEffect[]): Chain {
  const input = ctx.createGain(), output = ctx.createGain();
  const stages: Chain["stages"] = [];
  let tail: AudioNode = input;
  for (const e of effects) {
    const make = AUDIO_FX.find((d) => d.id === e.id)?.audio;
    if (!make) continue;
    const stage = make(ctx, e.values);
    if (stage.input) tail.connect(stage.input);
    tail = stage.output;
    stage.update(e.values, ctx.currentTime);
    stages.push({ id: e.id, stage });
  }
  tail.connect(output);
  return {
    input, output, stages,
    reverse: stages.some((s) => s.stage.reverse),
    update: (next, now) => stages.forEach((s, i) => { const e = next[i]; if (e && e.id === s.id) s.stage.update(e.values, now); }),
    start: (when) => stages.forEach((s) => s.stage.start?.(when)),
    dispose: () => { stages.forEach((s) => s.stage.dispose()); input.disconnect(); output.disconnect(); },
  };
}
