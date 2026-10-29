import { describe, it, expect } from "vitest";
import { baseScene, child } from "@/flow/testSupport";
import { nodesWith } from "@/store/nodeMap";
import { poseScene } from "@/animation/pose";
import { sampleClip } from "@/animation/engine";
import { fxDef, resolveFx, type FxEnv } from "@/animation/fx/library";
import { META_AUDIO_HASH, META_AUDIO_NAME, META_AUDIO_START, soundOf } from "@/animation/audio/library";
import { attachAudioOp, removeAudioOp, setAudioStartOp } from "@/animation/audio/attach";
import { audioEffectsOf, planVoices, soundOffset } from "@/animation/audio/player";
import { AUDIO_FX, workletSource } from "@/animation/audio/effects";
import { VISUALISER_FX } from "@/animation/audio/visualisers";
import { FX_CATALOG } from "@/animation/fx/catalog";
import type { ClipLite, NodeLite } from "@/store/types";

const HASH = "c".repeat(64);
const kf = (v: number) => ({ time: 0, value: v, easing: "linear" });
const withSound = (n: NodeLite, start?: string): NodeLite => ({ ...n, meta: { [META_AUDIO_HASH]: HASH, ...(start ? { [META_AUDIO_START]: start } : {}) } });

function scene() {
  const s = baseScene();
  return {
    ...s,
    nodes: nodesWith(s.nodes, {
      music: withSound(child("music", "A", 0, 0), "250"),
      plain: child("plain", "A", 50, 0),
      tone: child("tone", "A", 100, 0),
    }),
  };
}
const clip = (tracks: ClipLite["tracks"]): ClipLite => ({ id: "c", name: "c", duration: 4000, trigger: "enter", delay: 0, repeat: 0, yoyo: false, targetId: "A", tracks });

describe("sounds on nodes", () => {
  it("are meta entries: hash, name, start", () => {
    expect(soundOf(undefined)).toBeNull();
    expect(soundOf(child("n", "A", 0, 0))).toBeNull();
    expect(soundOf({ meta: { [META_AUDIO_HASH]: "nothash" } })).toBeNull();
    expect(soundOf({ meta: { [META_AUDIO_HASH]: HASH, [META_AUDIO_START]: "1500", [META_AUDIO_NAME]: "Beat" } })).toEqual({ hash: HASH, startMs: 1500, name: "Beat" });
    expect(soundOf({ meta: { [META_AUDIO_HASH]: HASH, [META_AUDIO_START]: "abc" } })?.startMs).toBe(0);
  });
  it("are attached, moved and removed by ops that touch only meta", () => {
    const n = child("n", "A", 0, 0);
    const meta = (op: ReturnType<typeof attachAudioOp>) => (op.kind.case === "setProps" ? op.kind.value.patch?.meta : undefined);
    expect(meta(attachAudioOp(n, HASH, "Beat"))).toEqual({ [META_AUDIO_HASH]: HASH, [META_AUDIO_NAME]: "Beat" });
    expect(meta(attachAudioOp(n, HASH, "Beat", 2000))).toMatchObject({ [META_AUDIO_START]: "2000" });
    const has = withSound(n, "500");
    expect(meta(removeAudioOp(has)!)).toEqual({});
    expect(removeAudioOp(n)).toBeUndefined();
    expect(meta(setAudioStartOp(has, 900)!)).toMatchObject({ [META_AUDIO_START]: "900" });
    expect(setAudioStartOp(n, 900)).toBeUndefined();
  });
  it("tell where in the sound the clip time is", () => {
    expect(soundOffset(1000, 250)).toBeCloseTo(0.75);
    expect(soundOffset(0, 250)).toBeCloseTo(-0.25); // not yet: in a quarter of a second
    expect(soundOffset(250, 250)).toBe(0);
  });
});

describe("who plays", () => {
  it("a node with a sound plays, with its audio effects in track order and defaults filled in", () => {
    const tracks = [
      { nodeId: "music", prop: "fx.ec.audio.highlowpass.cutoff", keyframes: [kf(800)] },
      { nodeId: "music", prop: "fx.ec.audio.reverb.mix", keyframes: [kf(40)] },
      { nodeId: "music", prop: "fx.ec.blur.gaussian.blurriness", keyframes: [kf(5)] }, // a pixel effect: not audio
    ];
    const plans = planVoices(scene(), clip(tracks), 0);
    const music = plans.find((p) => p.nodeId === "music")!;
    expect(music.sound?.startMs).toBe(250);
    expect(music.effects.map((e) => e.id)).toEqual(["ec.audio.highlowpass", "ec.audio.reverb"]);
    expect(music.effects[0].values.cutoff).toBe(800);
    expect(music.effects[0].values.filter).toBe(1); // the default low-pass
    expect(music.effects[1].values.mix).toBe(40);
  });
  it("a Tone plays without a sound; a node with neither does not play", () => {
    const plans = planVoices(scene(), clip([{ nodeId: "tone", prop: "fx.ec.audio.tone.frequency", keyframes: [kf(660)] }]), 0);
    expect(plans.map((p) => p.nodeId).sort()).toEqual(["music", "tone"]);
    const tone = plans.find((p) => p.nodeId === "tone")!;
    expect(tone.sound).toBeNull();
    expect(tone.effects[0].values.frequency).toBe(660);
    expect(plans.find((p) => p.nodeId === "plain")).toBeUndefined();
  });
  it("follows the animated parameters as the clip time moves", () => {
    const track = { nodeId: "music", prop: "fx.ec.audio.highlowpass.cutoff", keyframes: [{ time: 0, value: 200, easing: "linear" }, { time: 1000, value: 4200, easing: "linear" }] };
    const at = (t: number) => planVoices(scene(), clip([track]), t).find((p) => p.nodeId === "music")!.effects[0].values.cutoff;
    expect(at(0)).toBe(200);
    expect(at(500)).toBe(2200);
    expect(at(2000)).toBe(4200);
  });
  it("audioEffectsOf keeps only audio effects and clamps to the parameter range", () => {
    expect(audioEffectsOf(undefined)).toEqual([]);
    const e = audioEffectsOf({ "ec.blur.gaussian": { blurriness: 3 }, "ec.audio.delay": { time: 1e9, feedback: -5 } });
    expect(e).toHaveLength(1);
    expect(e[0].values.time).toBe(5000);
    expect(e[0].values.feedback).toBe(0);
  });
});

describe("the audio effects in the catalog", () => {
  it("are the 13 Audio effects plus the two visualisers, each with the parts it needs", () => {
    const ids = FX_CATALOG.filter((e) => e.category === "Audio").map((e) => e.id).sort();
    expect(AUDIO_FX.map((d) => d.id).sort()).toEqual(ids);
    expect(ids).toHaveLength(13);
    expect(VISUALISER_FX.map((d) => d.id).sort()).toEqual(["ec.generate.audiospectrum", "ec.generate.audiowaveform"]);
    for (const d of AUDIO_FX) { expect(d.audio, d.id).toBeTypeOf("function"); expect(d.params.length).toBeGreaterThan(0); }
  });
  it("the worklet module carries the very functions the tests run", () => {
    const src = workletSource();
    expect(src).toContain("registerProcessor(\"ec-gate\"");
    expect(src).toContain("registerProcessor(\"ec-compressor\"");
    expect(src).toContain("state.holdLeft");
    expect(src).toContain("state.grDb");
  });
});

describe("the visualisers", () => {
  // a sound that is a pure tone, standing in for a decoded buffer
  const sr = 44100;
  const data = Float32Array.from({ length: sr * 2 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 1000 * i) / sr));
  const env = (timeMs: number, startMs = 0): FxEnv => ({ timeMs, sound: { buffer: { sampleRate: sr, getChannelData: () => data } as unknown as AudioBuffer, startMs } });
  const uniforms = (id: string, given: Record<string, number>, e?: FxEnv) => {
    const d = fxDef(id)!;
    return d.overlay!(resolveFx(d, given)).uniforms(resolveFx(d, given), e);
  };

  it("the spectrum has its peak where the tone is, and is silent without a sound", () => {
    const u = uniforms("ec.generate.audiospectrum", { bands: 32, minHz: 40, maxHz: 16000 }, env(500));
    expect(u).toHaveLength(80);
    const bands = u.slice(12, 12 + 32);
    const at = Math.round((Math.log(1000 / 40) / Math.log(16000 / 40)) * 32 - 0.5);
    expect(Math.abs(bands.indexOf(Math.max(...bands)) - at)).toBeLessThanOrEqual(1);
    expect(Math.max(...bands)).toBeGreaterThan(0.8);
    expect(Math.max(...uniforms("ec.generate.audiospectrum", {}, undefined).slice(12))).toBe(0);
    expect(u[11]).toBe(32);
  });
  it("the sound starts where its node says: before that the spectrum is silent", () => {
    const quiet = uniforms("ec.generate.audiospectrum", { bands: 32 }, env(500, 5000)).slice(12, 44);
    expect(Math.max(...quiet)).toBe(0);
  });
  it("the waveform is the signed samples around the clip time", () => {
    const u = uniforms("ec.generate.audiowaveform", { window: 20 }, env(500));
    expect(u).toHaveLength(112);
    const samples = u.slice(12, 12 + 96);
    expect(Math.max(...samples)).toBeGreaterThan(0.4);
    expect(Math.min(...samples)).toBeLessThan(-0.4);
    expect(Math.max(...uniforms("ec.generate.audiowaveform", {}, undefined).slice(12).map(Math.abs))).toBe(0);
  });
  it("a node with a visualiser gets the clip time from the pose", () => {
    const s = baseScene();
    const sc = { ...s, nodes: nodesWith(s.nodes, { n: child("n", "A", 0, 0) }) };
    const anim = sampleClip({ tracks: [{ nodeId: "n", prop: "fx.ec.generate.audiospectrum.bands", keyframes: [kf(24)] }] }, 0);
    expect(poseScene(sc, anim, { t: 1234, at: () => anim }).nodes.at("n").animTime).toBe(1234);
    // an effect that does not read the time does not get it
    const blur = sampleClip({ tracks: [{ nodeId: "n", prop: "fx.ec.blur.gaussian.blurriness", keyframes: [kf(4)] }] }, 0);
    expect(poseScene(sc, blur, { t: 1234, at: () => blur }).nodes.at("n").animTime).toBeUndefined();
  });
});
