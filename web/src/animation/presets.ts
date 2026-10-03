import type { ClipLite, KeyframeLite, NodeLite, SceneState, TrackLite } from "../store/types";
import { defaultTargetId, uniqueClipName } from "./timelineLogic";
import { canDraw } from "./pose";

// I PRESET: clip pronte per un nodo, in un click ("Anima con un preset").
//
// Funzioni PURE: dato il nodo (i suoi valori di base) e la scena, producono la
// clip intera -- un solo `SetClip`, quindi un solo passo di undo. I valori sono
// RELATIVI a quelli di base del nodo (Slide up parte 24 px sotto dove il nodo
// sta, non a una coordinata assoluta), così il preset funziona ovunque sia
// il nodo e la clip finisce sullo stato che il designer ha disegnato.

export type PresetId = "fadeIn" | "slideUp" | "pop" | "spin" | "pulse" | "draw";

export interface PresetInfo {
  id: PresetId;
  label: string;
  /** Una riga che dice cosa fa. */
  hint: string;
  /** Vero se il preset ha senso per questo nodo (Draw vuole un tracciato). */
  applicable: (n: Pick<NodeLite, "kind">) => boolean;
}

export const PRESETS: readonly PresetInfo[] = [
  { id: "fadeIn", label: "Fade in", hint: "Appare con una dissolvenza", applicable: () => true },
  { id: "slideUp", label: "Slide up", hint: "Sale al suo posto sfumando", applicable: () => true },
  { id: "pop", label: "Pop", hint: "Compare ingrandendosi con un piccolo rimbalzo", applicable: () => true },
  { id: "spin", label: "Spin", hint: "Gira su sé stesso in continuazione", applicable: () => true },
  { id: "pulse", label: "Pulse", hint: "Pulsa lentamente", applicable: () => true },
  { id: "draw", label: "Draw", hint: "Il tracciato si disegna da zero", applicable: canDraw },
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
          // sale oltre il valore finale e ci torna: il "rimbalzo"
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
 * La clip del preset `id` per il nodo `node`, già con id, nome libero e bersaglio
 * (il contenitore più vicino al nodo). `null` se il preset non si applica al nodo.
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
