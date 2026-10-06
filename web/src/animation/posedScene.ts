import { useScene } from "../store/store";
import type { SceneState } from "../store/types";
import { poseScene, sampleWithDraft } from "./pose";
import { useTimeline } from "./timelineStore";

// THE SCENE THE CANVAS SHOWS. With the timeline stopped (or closed, or before the
// first scrub) it is the document's scene, the SAME instance as the store:
// no work and no change in behavior. With the clip open and the pose
// on (scrubbing, playing, recording) it is the derived scene with the sampled
// values (animation/pose.ts). The document is never touched.
//
// Who reads it: the draw loop (ui/App.tsx), the tools' context
// (`getScene`: the geometry you drag on is what you see, so
// recording a movement starts from the pose and not from the base value) and the
// Properties panel (shows the pose values).

let memo: {
  scene: SceneState; clipRef: unknown; playhead: number; draft: unknown; out: SceneState;
} | null = null;

export function posedScene(): SceneState | null {
  const scene = useScene.getState().scene;
  if (!scene) return null;
  const tl = useTimeline.getState();
  if (!tl.open || !tl.posed || !tl.clipId) return scene;
  const clip = tl.draftClip ?? scene.clips[tl.clipId];
  if (!clip) return scene;
  if (memo && memo.scene === scene && memo.clipRef === clip && memo.playhead === tl.playhead && memo.draft === tl.recordDraft) return memo.out;
  const out = poseScene(scene, sampleWithDraft(clip, tl.playhead, tl.recordDraft));
  memo = { scene, clipRef: clip, playhead: tl.playhead, draft: tl.recordDraft, out };
  return out;
}

/** Is the pose on? (the canvas is not showing the document). */
export function isPosing(): boolean {
  const tl = useTimeline.getState();
  return tl.open && tl.posed && !!tl.clipId;
}

/**
 * React hook: the posed scene, which updates on every scene, playhead,
 * draft or clip change. It subscribes ONLY to what the pose reads, so with the timeline
 * stopped it re-renders nothing extra.
 */
export function usePosedScene(): SceneState | null {
  const scene = useScene((s) => s.scene);
  // While the clip RUNS the panels do not follow every frame (re-rendering them 60 times
  // a second is useless to anyone): they show the real scene, and when paused or scrubbing
  // they go back to following the pose.
  const playing = useTimeline((s) => s.playing);
  useTimeline((s) => (s.open && s.posed && !s.playing ? s.playhead : -1));
  useTimeline((s) => (s.open && s.posed ? s.recordDraft : null));
  useTimeline((s) => (s.open && s.posed ? s.draftClip : null));
  useTimeline((s) => (s.open && s.posed ? s.clipId : null));
  return playing ? scene : posedScene();
}
