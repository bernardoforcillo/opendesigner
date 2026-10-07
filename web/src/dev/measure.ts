import { worldAabbOfNode } from "../canvas/geometry";
import type { SceneState } from "../store/types";

// MEASUREMENTS for Develop (the redlines): where a node sits in its parent and how far it is from the
// nearest sibling on each side. Pure, in world units, read from the scene; the panel only prints it.

export interface Sides { top: number | null; right: number | null; bottom: number | null; left: number | null }

export interface Measurement {
  id: string;
  name: string;
  width: number;
  height: number;
  /** Position inside the parent (the page's origin for a root). */
  x: number;
  y: number;
  /** Gap to the parent's edges (negative when it sticks out). null: the parent is the page. */
  toParent: Sides;
  /** Gap to the nearest sibling that faces each side and overlaps it on the other axis. */
  toSibling: Sides;
}

const r = (n: number) => Math.round(n * 100) / 100;

export function measureNode(scene: SceneState, id: string): Measurement | null {
  const n = scene.nodes.get(id);
  if (!n) return null;
  const b = worldAabbOfNode(n);
  const parent = n.parentId ? scene.nodes.get(n.parentId) : undefined;
  const p = parent ? worldAabbOfNode(parent) : null;
  const toParent: Sides = p
    ? { top: r(b.y - p.y), left: r(b.x - p.x), right: r(p.x + p.width - (b.x + b.width)), bottom: r(p.y + p.height - (b.y + b.height)) }
    : { top: null, right: null, bottom: null, left: null };
  const toSibling: Sides = { top: null, right: null, bottom: null, left: null };
  for (const s of scene.nodes.values()) {
    if (s.id === id || s.parentId !== n.parentId || !s.visible) continue;
    const o = worldAabbOfNode(s);
    const overlapX = Math.min(b.x + b.width, o.x + o.width) > Math.max(b.x, o.x);
    const overlapY = Math.min(b.y + b.height, o.y + o.height) > Math.max(b.y, o.y);
    const keep = (side: keyof Sides, gap: number) => {
      if (gap < 0) return;
      if (toSibling[side] === null || gap < toSibling[side]!) toSibling[side] = r(gap);
    };
    if (overlapX) {
      keep("top", b.y - (o.y + o.height));
      keep("bottom", o.y - (b.y + b.height));
    }
    if (overlapY) {
      keep("left", b.x - (o.x + o.width));
      keep("right", o.x - (b.x + b.width));
    }
  }
  return {
    id, name: n.name, width: r(b.width), height: r(b.height),
    x: r(p ? b.x - p.x : b.x), y: r(p ? b.y - p.y : b.y),
    toParent, toSibling,
  };
}
