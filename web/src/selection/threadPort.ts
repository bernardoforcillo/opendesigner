import { worldBoundsOfNode } from "@/canvas/transform";
import { hitTest } from "@/renderer/canvasRenderer";
import { canLink, nextOf, threadOps } from "@/store/threads";
import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";
import type { SceneState } from "@/store/types";

// THREADING BY DRAGGING A PORT: the filled square at the bottom-right of a text frame that flows into nothing (the
// last frame of a chain, or a frame on its own; a red "+" when text is left over). Dragging from it to another text
// frame and releasing there links the two -- the same operation as "Thread frames" (store/threads.ts::threadOps).
export const PORT_HIT_PX = 6;
export const PORT_MIN_PX = 40;

export interface ThreadPort {
  id: string;
  /** The centre of the port square, in the world. */
  world: { x: number; y: number };
}

export function threadPortOf(scene: SceneState, selection: readonly string[], zoom: number): ThreadPort | null {
  if (selection.length !== 1 || !(zoom > 0)) return null;
  const n = scene.nodes.at(selection[0]);
  if (!n || n.kind !== "text" || !n.text || !n.visible || nextOf(scene, n)) return null;
  const b = worldBoundsOfNode(scene, n);
  if (b.width * zoom < PORT_MIN_PX || b.height * zoom < PORT_MIN_PX) return null;
  return { id: n.id, world: { x: b.x + b.width - 4 / zoom, y: b.y + b.height - 4 / zoom } };
}

export function threadPortHit(p: ThreadPort, world: { x: number; y: number }, zoom: number): boolean {
  return Math.hypot(world.x - p.world.x, world.y - p.world.y) <= PORT_HIT_PX / zoom;
}

/** The frame the pointer is over, when `from` can flow into it. */
export function threadTargetAt(scene: SceneState, from: string, world: { x: number; y: number }, zoom: number, pageId?: string | null): string | null {
  const id = hitTest(scene, world.x, world.y, zoom, pageId);
  return id && id !== from && canLink(scene, from, id) ? id : null;
}

/** The ops that link `from` to the frame under the pointer, or null. */
export function threadDropOps(scene: SceneState, from: string, world: { x: number; y: number }, zoom: number, pageId?: string | null): Op[] | null {
  const to = threadTargetAt(scene, from, world, zoom, pageId);
  return to ? threadOps(scene, [from, to]) : null;
}
