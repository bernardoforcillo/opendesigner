export interface Camera { x: number; y: number; zoom: number }

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 64;

// La trasformazione canvas è setTransform(zoom, 0, 0, zoom, x, y):
// screen = world * zoom + (x, y)
// world = (screen - (x, y)) / zoom

export function screenToWorld(cam: Camera, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - cam.x) / cam.zoom, y: (sy - cam.y) / cam.zoom };
}

export function worldToScreen(cam: Camera, wx: number, wy: number): { x: number; y: number } {
  return { x: wx * cam.zoom + cam.x, y: wy * cam.zoom + cam.y };
}

// Mantiene fermo il punto mondo sotto il cursore (sx, sy): calcola quel punto
// mondo prima dello zoom, clampa il fattore di zoom risultante, poi ricalcola
// x,y in modo che il punto mondo torni sotto lo stesso pixel schermo.
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
