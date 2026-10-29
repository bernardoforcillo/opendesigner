// RENDERING A CHAIN OFFLINE: the same graph the player builds (effects.ts::buildChain), run faster than real time into a buffer. The tests
// use it to measure what each effect does to a known signal.

import type { FxValues } from "@/animation/fx/library";
import { fxDef, resolveFx } from "@/animation/fx/library";
import { buildChain, prepareAudio, type ChainEffect } from "@/animation/audio/effects";
import { reversedBuffer } from "@/animation/audio/library";

export interface OfflineJob {
  /** the audio effects, in order, with the values they have (missing ones take their defaults) */
  effects: { id: string; values?: FxValues }[];
  /** the sound that goes in, or null for none (a generator) */
  input: AudioBuffer | null;
  seconds: number;
  sampleRate?: number;
}

export async function renderOffline(job: OfflineJob): Promise<AudioBuffer> {
  const sr = job.sampleRate ?? 44100;
  const ctx = new OfflineAudioContext(2, Math.max(1, Math.round(job.seconds * sr)), sr);
  await prepareAudio(ctx);
  const effects: ChainEffect[] = job.effects.map((e) => ({ id: e.id, values: resolveFx(fxDef(e.id)!, e.values) }));
  const chain = buildChain(ctx, effects);
  if (job.input) {
    const src = ctx.createBufferSource();
    src.buffer = chain.reverse ? reversedBuffer(ctx, job.input) : job.input;
    src.connect(chain.input);
    src.start(0);
  }
  chain.output.connect(ctx.destination);
  chain.start(0);
  // let a moment of automation settle: the stages ease to their values in tens of milliseconds
  return ctx.startRendering();
}
