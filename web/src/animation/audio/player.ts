// PLAYING THE AUDIO WITH THE TIMELINE. While the open clip plays, every node inside its target that has a sound (animation/audio/library.ts)
// or a Tone effect gets a voice: the sound -> its audio effects (effects.ts, in track order) -> the speakers. The effects' parameters are
// read from the clip at the playhead (the same sampling the canvas uses), so a keyframed cutoff or delay time changes the sound while it plays.
//
// What decides who plays and where in the sound we are is PURE (`planVoices`, `soundOffset`) and tested; the Web Audio around it is thin.
// The sound starts at its `audio.start` (ms into the clip); before that it waits, after the clip's end it is stopped. Scrubbing is silent.

import type { ClipLite, NodeLite, SceneState } from "@/store/types";
import { fxDef, resolveFx, type FxValues } from "@/animation/fx/library";
import { sampleClip } from "@/animation/engine";
import { isInside } from "@/animation/timelineLogic";
import { useScene } from "@/store/store";
import { useTimeline } from "@/animation/timelineStore";
import { buildChain, prepareAudio, type Chain, type ChainEffect } from "@/animation/audio/effects";
import { loadSound, reversedBuffer, soundOf, type NodeSound } from "@/animation/audio/library";

export interface VoicePlan { nodeId: string; sound: NodeSound | null; effects: ChainEffect[] }

/** The audio effects of a node's sampled values, in track order, with defaults filled in. */
export function audioEffectsOf(fx: Readonly<Record<string, Readonly<Record<string, number>>>> | undefined): ChainEffect[] {
  const out: ChainEffect[] = [];
  for (const [id, given] of Object.entries(fx ?? {})) {
    const def = fxDef(id);
    if (def?.audio) out.push({ id, values: resolveFx(def, given) });
  }
  return out;
}

/** Who plays at clip time `tMs`: every node inside the clip's target that carries a sound, or has an audio effect (a Tone needs no sound). */
export function planVoices(scene: SceneState, clip: ClipLite, tMs: number): VoicePlan[] {
  const sampled = sampleClip(clip, tMs);
  const plans: VoicePlan[] = [];
  for (const n of scene.nodes.values() as Iterable<NodeLite>) {
    const sound = soundOf(n);
    const effects = audioEffectsOf(sampled.get(n.id)?.fx);
    if (!sound && effects.length === 0) continue;
    if (!isInside(scene, n.id, clip.targetId)) continue;
    plans.push({ nodeId: n.id, sound, effects });
  }
  return plans;
}

/** Where in the sound (seconds) the clip time `tMs` is, for a sound that starts at `startMs`: negative means "not yet, in this many seconds". */
export const soundOffset = (tMs: number, startMs: number): number => (tMs - startMs) / 1000;

interface Voice {
  nodeId: string;
  signature: string; // the sound and the order of the effects: what a chain is built from
  chain: Chain;
  source: AudioBufferSourceNode | null;
}

const signatureOf = (p: VoicePlan) => `${p.sound?.hash ?? ""}|${p.effects.map((e) => e.id).join(",")}`;

export class AudioPlayer {
  private ctx: AudioContext | null = null;
  private voices = new Map<string, Voice>();
  private running = false;
  private lastT = 0;
  private lastUpdate = 0;
  private generation = 0;

  private context(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor = typeof window !== "undefined" ? window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext : undefined;
    if (!Ctor) return null;
    this.ctx = new Ctor();
    return this.ctx;
  }

  /** Called on every timeline change: starts, follows and stops the sound. */
  sync(): void {
    const tl = useTimeline.getState();
    const scene = useScene.getState().scene;
    const clip = scene && tl.clipId ? scene.clips[tl.clipId] : undefined;
    if (!tl.open || !tl.playing || !scene || !clip) {
      if (this.running) this.stop();
      return;
    }
    const t = tl.playhead;
    if (!this.running || t < this.lastT - 50) {
      // started, or the clip looped / jumped back: begin again from here
      this.begin(scene, clip, t, tl.speed);
    } else if (performance.now() - this.lastUpdate > 40) {
      this.follow(scene, clip, t);
    }
    this.lastT = t;
  }

  private begin(scene: SceneState, clip: ClipLite, t: number, speed: number): void {
    this.stop();
    const ctx = this.context();
    if (!ctx) return;
    this.running = true;
    const gen = ++this.generation;
    this.lastUpdate = performance.now();
    void ctx.resume();
    void prepareAudio(ctx).then(async () => {
      for (const plan of planVoices(scene, clip, t)) {
        if (gen !== this.generation) return;
        let buffer: AudioBuffer | null = null;
        if (plan.sound) {
          buffer = await loadSound(scene.id, plan.sound.hash, ctx);
          if (!buffer || gen !== this.generation) continue;
        }
        this.startVoice(ctx, plan, buffer, t, speed);
      }
    });
  }

  private startVoice(ctx: AudioContext, plan: VoicePlan, buffer: AudioBuffer | null, tNow: number, speed: number): void {
    const chain = buildChain(ctx, plan.effects);
    chain.output.connect(ctx.destination);
    let source: AudioBufferSourceNode | null = null;
    if (buffer && plan.sound) {
      source = ctx.createBufferSource();
      source.buffer = chain.reverse ? reversedBuffer(ctx, buffer) : buffer;
      source.playbackRate.value = speed;
      source.connect(chain.input);
      // where the playhead is in the sound NOW (the loading may have taken a while: the clip has moved on)
      const elapsed = (useTimeline.getState().playhead - tNow) / 1000;
      const off = soundOffset(tNow, plan.sound.startMs) + Math.max(0, elapsed);
      if (off >= 0) { if (off < buffer.duration) source.start(0, off); } else source.start(ctx.currentTime + -off / Math.max(speed, 0.01), 0);
    }
    chain.start(ctx.currentTime);
    this.voices.set(plan.nodeId, { nodeId: plan.nodeId, signature: signatureOf(plan), chain, source });
  }

  /** Moves the effects' parameters to the playhead; a chain whose effects changed is rebuilt. */
  private follow(scene: SceneState, clip: ClipLite, t: number): void {
    this.lastUpdate = performance.now();
    const ctx = this.ctx;
    if (!ctx) return;
    const plans = planVoices(scene, clip, t);
    const same = plans.length === this.voices.size && plans.every((p) => this.voices.get(p.nodeId)?.signature === signatureOf(p));
    if (!same) { this.begin(scene, clip, t, useTimeline.getState().speed); return; }
    for (const p of plans) this.voices.get(p.nodeId)?.chain.update(p.effects, ctx.currentTime);
  }

  stop(): void {
    this.generation++;
    this.running = false;
    for (const v of this.voices.values()) {
      try { v.source?.stop(); } catch { /* already stopped */ }
      v.chain.dispose();
    }
    this.voices.clear();
  }

  dispose(): void {
    this.stop();
    void this.ctx?.close();
    this.ctx = null;
  }
}

/** Starts the player: it follows the timeline until the returned function is called. */
export function attachAudioPlayer(): () => void {
  const player = new AudioPlayer();
  const off = useTimeline.subscribe(() => player.sync());
  return () => { off(); player.dispose(); };
}

export type { FxValues };
