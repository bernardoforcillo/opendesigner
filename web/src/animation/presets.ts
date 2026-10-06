import type { ClipLite, KeyframeLite, NodeLite, SceneState, TrackLite } from "../store/types";
import { defaultTargetId, uniqueClipName } from "./timelineLogic";
import { canDraw } from "./pose";

// THE PRESETS: ready-made clips for a node, in one click ("Animate with a preset").
//
// PURE functions: given the node (its base values) and the scene, they produce the
// whole clip -- a single `SetClip`, hence a single undo step. The values are
// RELATIVE to the node's base ones (Slide up starts 24 px below where the node
// sits, not at an absolute coordinate), so the preset works wherever the
// node is and the clip ends on the state the designer drew.

export type PresetId = "fadeIn" | "slideUp" | "pop" | "spin" | "pulse" | "draw";

export interface PresetInfo {
  id: PresetId;
  label: string;
  /** A line saying what it does. */
  hint: string;
  /** True if the preset makes sense for this node (Draw needs a path). */
  applicable: (n: Pick<NodeLite, "kind">) => boolean;
}

export const PRESETS: readonly PresetInfo[] = [
  { id: "fadeIn", label: "Fade in", hint: "Appears with a fade", applicable: () => true },
  { id: "slideUp", label: "Slide up", hint: "Rises into place while fading in", applicable: () => true },
  { id: "pop", label: "Pop", hint: "Appears growing with a small bounce", applicable: () => true },
  { id: "spin", label: "Spin", hint: "Spins on itself continuously", applicable: () => true },
  { id: "pulse", label: "Pulse", hint: "Pulses slowly", applicable: () => true },
  { id: "draw", label: "Draw", hint: "The path draws itself from zero", applicable: canDraw },
];

const kf = (time: number, value: number, easing = "easeOut"): KeyframeLite => ({ time, value, easing });
const track = (nodeId: string, prop: string, ...keyframes: KeyframeLite[]): TrackLite => ({ nodeId, prop, keyframes });

type Shape = Pick<ClipLite, "duration" | "trigger" | "repeat" | "yoyo" | "tracks" | "delay"> & { name: string };

function shapeOf(id: PresetId, n: NodeLite): Shape {
  const base = { delay: 0, repeat: 0, yoyo: false };
  switch (id) {
    case "fadeIn":
      return { ...base, name: "Fade in", duration: 500, trigger: "enter", tracks: [track(n.id, "opacity", kf(0, 0), kf(500, n.opacity))] };
    case "slideUp":
      return {
        ...base, name: "Slide up", duration: 600, trigger: "enter",
        tracks: [
          track(n.id, "y", kf(0, n.y + 24), kf(600, n.y)),
          track(n.id, "opacity", kf(0, 0), kf(400, n.opacity)),
        ],
      };
    case "pop":
      return {
        ...base, name: "Pop", duration: 500, trigger: "enter",
        tracks: [
          // goes past the final value and comes back: the "bounce"
          track(n.id, "scale", kf(0, 0.6), kf(300, 1.08), kf(500, 1, "easeInOut")),
          track(n.id, "opacity", kf(0, 0), kf(200, n.opacity)),
        ],
      };
    case "spin":
      return {
        ...base, name: "Spin", duration: 1200, trigger: "loop", repeat: -1,
        tracks: [track(n.id, "rotation", kf(0, n.rotation, "linear"), kf(1200, n.rotation + 360, "linear"))],
      };
    case "pulse":
      return {
        ...base, name: "Pulse", duration: 1200, trigger: "loop", repeat: -1,
        tracks: [track(n.id, "scale", kf(0, 1, "easeInOut"), kf(600, 1.08, "easeInOut"), kf(1200, 1, "easeInOut"))],
      };
    case "draw":
      return { ...base, name: "Draw", duration: 1200, trigger: "enter", tracks: [track(n.id, "draw", kf(0, 0, "easeInOut"), kf(1200, 1))] };
  }
}

/**
 * The clip of preset `id` for node `node`, already with id, free name and target
 * (the container closest to the node). `null` if the preset does not apply to the node.
 */
export function buildPreset(id: PresetId, scene: SceneState, node: NodeLite, clipId: string): ClipLite | null {
  const info = PRESETS.find((p) => p.id === id);
  if (!info || !info.applicable(node)) return null;
  const s = shapeOf(id, node);
  return {
    id: clipId,
    name: uniqueClipName(scene.clips, s.name),
    duration: s.duration,
    trigger: s.trigger,
    delay: s.delay,
    repeat: s.repeat,
    yoyo: s.yoyo,
    tracks: s.tracks,
    targetId: defaultTargetId(scene, [node.id]),
  };
}
