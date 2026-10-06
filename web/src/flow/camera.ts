import type { Camera } from "../canvas/camera";
import { MAX_ZOOM, MIN_ZOOM } from "../canvas/camera";
import type { Bounds } from "../canvas/geometry";

/**
 * The camera that frames `b` at the center of a `viewW x viewH` view (CSS px),
 * with `pad` px of margin and without zooming in beyond `maxZoom` (a small
 * screen must not fill the whole screen and lose the context).
 */
export function cameraToFit(b: Bounds, viewW: number, viewH: number, pad = 80, maxZoom = 1): Camera {
  const w = Math.max(1, viewW - pad * 2);
  const h = Math.max(1, viewH - pad * 2);
  const zoom = Math.min(maxZoom, MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(w / Math.max(1, b.width), h / Math.max(1, b.height))));
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  return { zoom, x: viewW / 2 - cx * zoom, y: viewH / 2 - cy * zoom };
}

/**
 * Is `b` (world) entirely inside the view, with `margin` px of breathing room? It serves to
 * decide whether a click in the panel (a transition, a problem) should
 * move the camera: if the object is already visible it is enough to highlight it, moving the
 * view on every click disorients whoever is editing.
 */
export function isFullyVisible(b: Bounds, cam: Camera, viewW: number, viewH: number, margin = 24): boolean {
  const x0 = b.x * cam.zoom + cam.x;
  const y0 = b.y * cam.zoom + cam.y;
  const x1 = (b.x + b.width) * cam.zoom + cam.x;
  const y1 = (b.y + b.height) * cam.zoom + cam.y;
  return x0 >= margin && y0 >= margin && x1 <= viewW - margin && y1 <= viewH - margin;
}
