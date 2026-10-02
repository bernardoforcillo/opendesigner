import type { Camera } from "../canvas/camera";
import { MAX_ZOOM, MIN_ZOOM } from "../canvas/camera";
import type { Bounds } from "../canvas/geometry";

/**
 * La camera che inquadra `b` al centro di una vista `viewW x viewH` (px CSS),
 * con `pad` px di margine e senza ingrandire oltre `maxZoom` (una schermata
 * piccola non deve riempire tutto lo schermo e perdere il contesto).
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
 * `b` (mondo) sta tutto dentro la vista, con `margin` px di respiro? Serve a
 * decidere se un click nel pannello (una transizione, un problema) debba
 * spostare la camera: se l'oggetto si vede già basta evidenziarlo, muovere la
 * vista a ogni click disorienta chi sta modificando.
 */
export function isFullyVisible(b: Bounds, cam: Camera, viewW: number, viewH: number, margin = 24): boolean {
  const x0 = b.x * cam.zoom + cam.x;
  const y0 = b.y * cam.zoom + cam.y;
  const x1 = (b.x + b.width) * cam.zoom + cam.x;
  const y1 = (b.y + b.height) * cam.zoom + cam.y;
  return x0 >= margin && y0 >= margin && x1 <= viewW - margin && y1 <= viewH - margin;
}
