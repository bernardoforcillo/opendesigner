import { applyTransform, invertTransform, worldTransformOf } from "../canvas/transform";
import { threadsOf } from "../store/comments";
import type { SceneState } from "../store/types";

// WHERE A COMMENT'S PIN SITS. A comment attached to a node is an offset in the node's own
// space, so the pin follows the node; a free one is in world coordinates on its page.

export interface Pin {
  threadId: string;
  /** World position of the pin's tip. */
  x: number;
  y: number;
  /** 1-based number shown in the bubble: the thread's rank by creation time on the page. */
  number: number;
  resolved: boolean;
}

/** The pins of a page. Resolved threads are left out unless `showResolved`; orphans have no pin. */
export function pinsOf(scene: SceneState, pageId: string, showResolved: boolean): Pin[] {
  const threads = threadsOf(scene, pageId).filter((t) => !t.orphan);
  // Numbers by age, oldest first, over ALL threads of the page: resolving one must not renumber the others.
  const byAge = [...threads].sort((a, b) => a.root.createdAt - b.root.createdAt || a.root.id.localeCompare(b.root.id));
  const number = new Map(byAge.map((t, i) => [t.root.id, i + 1]));
  const out: Pin[] = [];
  for (const t of threads) {
    if (t.root.resolved && !showResolved) continue;
    const c = t.root;
    let p = { x: c.x, y: c.y };
    if (c.nodeId !== "") {
      p = applyTransform(worldTransformOf(scene, c.nodeId), c.x, c.y);
    }
    out.push({ threadId: c.id, x: p.x, y: p.y, number: number.get(c.id) ?? 0, resolved: c.resolved });
  }
  return out.sort((a, b) => a.number - b.number);
}

/** The pin under a world point (the bubble is `radiusPx` on screen), the newest on top. */
export function pinAt(pins: readonly Pin[], wx: number, wy: number, zoom: number, radiusPx = 12): Pin | null {
  const r = radiusPx / (zoom || 1);
  // The bubble sits ABOVE the tip: its centre is `r` up.
  for (let i = pins.length - 1; i >= 0; i--) {
    const p = pins[i];
    if (Math.hypot(wx - p.x, wy - (p.y - r)) <= r) return p;
  }
  return null;
}

/** The world position of a draft pin. */
export function draftWorld(scene: SceneState, d: { nodeId: string; x: number; y: number }): { x: number; y: number } {
  return d.nodeId !== "" && scene.nodes.has(d.nodeId) ? applyTransform(worldTransformOf(scene, d.nodeId), d.x, d.y) : { x: d.x, y: d.y };
}

/** The attachment of a new comment at a world point over `nodeId` (or free on `pageId`). */
export function placement(
  scene: SceneState, nodeId: string | null, pageId: string, wx: number, wy: number,
): { nodeId: string; pageId: string; x: number; y: number } {
  if (nodeId && scene.nodes.has(nodeId)) {
    const local = applyTransform(invertTransform(worldTransformOf(scene, nodeId)), wx, wy);
    return { nodeId, pageId: "", x: local.x, y: local.y };
  }
  return { nodeId: "", pageId, x: wx, y: wy };
}
