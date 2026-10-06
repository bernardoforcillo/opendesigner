export interface Camera { x: number; y: number; zoom: number }

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 64;

// The canvas transform is setTransform(zoom, 0, 0, zoom, x, y):
// screen = world * zoom + (x, y)
// world = (screen - (x, y)) / zoom

export function screenToWorld(cam: Camera, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - cam.x) / cam.zoom, y: (sy - cam.y) / cam.zoom };
}

export function worldToScreen(cam: Camera, wx: number, wy: number): { x: number; y: number } {
  return { x: wx * cam.zoom + cam.x, y: wy * cam.zoom + cam.y };
}

// Keeps the world point under the cursor (sx, sy) fixed: computes that world
// point before the zoom, clamps the resulting zoom factor, then recomputes
// x,y so that the world point returns under the same screen pixel.
export function zoomAt(cam: Camera, factor: number, sx: number, sy: number): Camera {
  const world = screenToWorld(cam, sx, sy);
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, cam.zoom * factor));
  return {
    x: sx - world.x * zoom,
    y: sy - world.y * zoom,
    zoom,
  };
}

export function panBy(cam: Camera, dxScreen: number, dyScreen: number): Camera {
  return { x: cam.x + dxScreen, y: cam.y + dyScreen, zoom: cam.zoom };
}
