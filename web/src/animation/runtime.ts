import type { ClipLite, SceneState } from "../store/types";
import { worldBoundsOfNode } from "../canvas/transform";
import { clipTimeline, sampleClip, type NodeAnim } from "./engine";
import { mergeAnim } from "./pose";
import { isInside } from "./timelineLogic";

// THE PROTOTYPE RUNTIME: which clips run, since when, and what state they sample
// "now". PURE functions with no timers -- whoever uses them (ui/PrototypePlayer.tsx)
// keeps the list of runs and the requestAnimationFrame loop; here there is only
// the decision. Sampling is the same as the editor's (engine.ts + pose.ts):
// what you see in the timeline is what you see in Present.

/** A running clip: since when (ms, the clock of whoever runs it). */
export interface ClipRun { clip: ClipLite; startedAt: number }

/** The triggers that start on their own when the screen appears. */
const AUTO_TRIGGERS = new Set(["enter", "loop"]);

/** The `enter` and `loop` clips of the screen: the target is the screen or lies inside it. */
export function autoClipsForScreen(scene: SceneState, screenId: string): ClipLite[] {
  return Object.values(scene.clips)
    .filter((c) => AUTO_TRIGGERS.has(c.trigger) && c.tracks.length > 0 && scene.nodes.get(c.targetId) && isInside(scene, c.targetId, screenId))
    .sort(byId);
}

/** The `hover` or `tap` clips of the screen. */
export function pointerClipsForScreen(scene: SceneState, screenId: string, trigger: "hover" | "tap"): ClipLite[] {
  return Object.values(scene.clips)
    .filter((c) => c.trigger === trigger && c.tracks.length > 0 && scene.nodes.get(c.targetId) && isInside(scene, c.targetId, screenId))
    .sort(byId);
}

const byId = (a: ClipLite, b: ClipLite) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Among `clips`, those whose TARGET contains the point (world coordinates): the
 * "hover" or "tap" on a target is inside its box in the world.
 */
export function clipsUnder(scene: SceneState, clips: readonly ClipLite[], x: number, y: number): ClipLite[] {
  return clips.filter((c) => {
    const n = scene.nodes.get(c.targetId);
    if (!n) return false;
    const b = worldBoundsOfNode(scene, n);
    return x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;
  });
}

/**
 * The clip as it REALLY runs: the `loop` trigger is "like `enter` but without end"
 * (docs/animation.md), so it repeats forever whatever `repeat` is.
 */
export function asPlayed(clip: ClipLite): ClipLite {
  return clip.trigger === "loop" && clip.repeat >= 0 ? { ...clip, repeat: -1 } : clip;
}

/** The runs that start together at `now` for the given clips. */
export function startRuns(clips: readonly ClipLite[], now: number): ClipRun[] {
  return clips.map((clip) => ({ clip: asPlayed(clip), startedAt: now }));
}

/**
 * The sampled state of all the runs at `now`, with the later ones winning
 * over the earlier ones; `live` says whether at least one is still running (whoever has a frame
 * loop keeps it on only while `live`). A finished clip STAYS applied on
 * its last value (fill-mode "both" of the exported code): an `enter` that brings
 * an element to opacity 1 does not put it back to 0 when it ends.
 */
export function sampleRuns(runs: readonly ClipRun[], now: number): { anim: Map<string, NodeAnim>; live: boolean } {
  const anim = new Map<string, NodeAnim>();
  let live = false;
  for (const r of runs) {
    const { t, done } = clipTimeline(r.clip, now - r.startedAt);
    if (!done) live = true;
    mergeAnim(anim, sampleClip(r.clip, t));
  }
  return { anim, live };
}
