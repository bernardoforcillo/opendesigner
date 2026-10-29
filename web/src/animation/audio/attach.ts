// ATTACHING A SOUND TO A NODE: the file is uploaded as an asset (the server accepts WAV, MP3, Ogg, FLAC and M4A) and the node gets
// meta `audio.hash` / `audio.name` / `audio.start` (animation/audio/library.ts). One undo step.

import { withMeta } from "@/flow/meta";
import { uploadAsset } from "@/rpc/assets";
import { useScene } from "@/store/store";
import { makeSetPropsOp } from "@/tools/ops";
import type { NodeLite, SceneState } from "@/store/types";
import { META_AUDIO_HASH, META_AUDIO_NAME, META_AUDIO_START } from "@/animation/audio/library";

type Op = ReturnType<typeof makeSetPropsOp>;

/** The op that gives `node` the sound `hash` (named `name`, starting `startMs` into the clip). */
export function attachAudioOp(node: NodeLite, hash: string, name: string, startMs = 0): Op {
  let meta = withMeta(node, META_AUDIO_HASH, hash);
  meta = withMeta({ ...node, meta }, META_AUDIO_NAME, name);
  meta = withMeta({ ...node, meta }, META_AUDIO_START, startMs === 0 ? "" : String(startMs));
  return makeSetPropsOp(node.id, { meta }, ["meta"]);
}

/** The op that takes the sound off `node` (undefined if it has none). */
export function removeAudioOp(node: NodeLite): Op | undefined {
  if (!node.meta?.[META_AUDIO_HASH]) return undefined;
  let meta = withMeta(node, META_AUDIO_HASH, "");
  meta = withMeta({ ...node, meta }, META_AUDIO_NAME, "");
  meta = withMeta({ ...node, meta }, META_AUDIO_START, "");
  return makeSetPropsOp(node.id, { meta }, ["meta"]);
}

/** The op that moves the sound's start to `startMs` (a number of milliseconds into the clip). */
export function setAudioStartOp(node: NodeLite, startMs: number): Op | undefined {
  if (!node.meta?.[META_AUDIO_HASH]) return undefined;
  return makeSetPropsOp(node.id, { meta: withMeta(node, META_AUDIO_START, startMs === 0 ? "" : String(Math.round(startMs))) }, ["meta"]);
}

function run(ops: Op[]): void {
  const st = useScene.getState();
  st.beginGesture();
  st.endGesture(ops);
}

/** Uploads `file` and attaches it to the node `nodeId`. Rejects with a readable message if the server refuses the file. */
export async function attachAudioFile(file: File, nodeId: string): Promise<void> {
  const scene: SceneState | null = useScene.getState().scene;
  const node = scene?.nodes.get(nodeId);
  if (!scene || !node) throw new Error("there is no layer to attach the sound to");
  const ref = await uploadAsset(scene.id, file);
  if (!ref.contentType.startsWith("audio/")) throw new Error("that file is not a sound the editor can play (WAV, MP3, Ogg, FLAC or M4A)");
  const fresh = useScene.getState().scene?.nodes.get(nodeId) ?? node;
  run([attachAudioOp(fresh, ref.hash, file.name.replace(/\.[^.]+$/, ""))]);
}

export function removeAudio(nodeId: string): void {
  const node = useScene.getState().scene?.nodes.get(nodeId);
  const op = node && removeAudioOp(node);
  if (op) run([op]);
}
