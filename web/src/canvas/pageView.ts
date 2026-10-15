import type { Camera } from "./camera";
import { worldBoundsOfNode } from "./transform";
import type { SceneState } from "../store/types";

// WHERE THE VIEW IS ON EACH PAGE. The camera is one number set, but a page is a different place:
// arriving on one with the other page's camera would show empty canvas (or the wrong part). Each
// page remembers the camera it was left with; one never visited is framed on its content.

const FIT_MARGIN = 72;

/** The camera that frames a page's top-level content in a w x h box (never beyond 1:1); null for an empty page. */
export function fitPage(scene: SceneState, pageId: string, w: number, h: number): Camera | null {
  if (w <= 0 || h <= 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of scene.nodes.values()) {
    if (n.parentId !== pageId || !n.visible) continue;
    const b = worldBoundsOfNode(scene, n);
    minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width); maxY = Math.max(maxY, b.y + b.height);
  }
  if (!Number.isFinite(minX)) return null;
  const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
  const zoom = Math.min(1, Math.max(0.02, Math.min((w - 2 * FIT_MARGIN) / bw, (h - 2 * FIT_MARGIN) / bh)));
  return { zoom, x: (w - bw * zoom) / 2 - minX * zoom, y: (h - bh * zoom) / 2 - minY * zoom };
}

/** Per-page camera memory. */
export class PageCameras {
  private seen = new Map<string, Camera>();
  save(pageId: string, cam: Camera): void { this.seen.set(pageId, { ...cam }); }
  /** The camera to show on `pageId`: the one it was left with, else framed on its content, else `fallback`. */
  restore(scene: SceneState, pageId: string, w: number, h: number, fallback: Camera): Camera {
    return this.seen.get(pageId) ?? fitPage(scene, pageId, w, h) ?? fallback;
  }
}
