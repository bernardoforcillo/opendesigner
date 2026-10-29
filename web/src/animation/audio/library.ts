// THE SOUNDS OF THE DOCUMENT. A node carries a sound as two meta entries (no model change, like text.path): `audio.hash`, the asset
// the server keeps (it accepts WAV, MP3, Ogg, FLAC and M4A files next to images and fonts), and `audio.start`, the clip time in
// milliseconds at which it begins (0 if absent). Decoded buffers are cached by hash, so a sound is fetched and decoded once however many
// nodes use it, and the visualisers (Audio Spectrum, Audio Waveform) read the same buffers the player plays.

import type { NodeLite } from "@/store/types";
import { assetUrl, isAssetHash } from "@/rpc/assets";

export const META_AUDIO_HASH = "audio.hash";
export const META_AUDIO_START = "audio.start";
export const META_AUDIO_NAME = "audio.name";

export interface NodeSound { hash: string; startMs: number; name: string }

/** The sound a node carries, or null. */
export function soundOf(n: Pick<NodeLite, "meta"> | undefined): NodeSound | null {
  const hash = n?.meta?.[META_AUDIO_HASH];
  if (!hash || !isAssetHash(hash)) return null;
  const start = Number(n?.meta?.[META_AUDIO_START] ?? 0);
  return { hash, startMs: Number.isFinite(start) ? start : 0, name: n?.meta?.[META_AUDIO_NAME] ?? "" };
}

const decoded = new Map<string, AudioBuffer>();
const loading = new Map<string, Promise<AudioBuffer | null>>();
const reversed = new WeakMap<AudioBuffer, AudioBuffer>();
const listeners = new Set<() => void>();

/** Tells whoever redraws (the visualisers) that a sound arrived. */
export function onAudioLoaded(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** The decoded sound if it is already here, else null (and nothing is started: use `loadSound`). */
export function soundBuffer(hash: string): AudioBuffer | null {
  return decoded.get(hash) ?? null;
}

/** Puts a decoded buffer in the cache (the tests, and a sound just recorded or generated). */
export function registerSound(hash: string, buffer: AudioBuffer): void {
  decoded.set(hash, buffer);
  listeners.forEach((l) => l());
}

/** Fetches and decodes the sound `hash` of document `docId` with `ctx` (once; null if it cannot be fetched or decoded). */
export function loadSound(docId: string, hash: string, ctx: BaseAudioContext): Promise<AudioBuffer | null> {
  const have = decoded.get(hash);
  if (have) return Promise.resolve(have);
  let p = loading.get(hash);
  if (!p) {
    p = fetch(assetUrl(docId, hash))
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then((bytes) => ctx.decodeAudioData(bytes))
      .then((buf) => { decoded.set(hash, buf); listeners.forEach((l) => l()); return buf; })
      .catch(() => null)
      .finally(() => { loading.delete(hash); });
    loading.set(hash, p);
  }
  return p;
}

/** The sound played backwards (cached per buffer). */
export function reversedBuffer(ctx: BaseAudioContext, buf: AudioBuffer): AudioBuffer {
  const hit = reversed.get(buf);
  if (hit) return hit;
  const out = ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
  for (let c = 0; c < buf.numberOfChannels; c++) out.copyToChannel(buf.getChannelData(c).slice().reverse(), c);
  reversed.set(buf, out);
  return out;
}
