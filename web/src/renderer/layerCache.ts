import type { Camera } from "../canvas/camera";
import type { SceneState } from "../store/types";
import { drawScene } from "./canvasRenderer";

// THE HEAVY FRAME AND THE MOVING CAMERA.
//
// A very large document can take tens of milliseconds to draw
// the whole scene (at that size the cost is the rasterizer, not the logic).
// Redrawing it on every step of a pan or zoom means dropping below
// 15 fps exactly when the user is MOVING the view. But while the camera
// moves and the document does not, the pixels needed are those of the last frame,
// just moved and scaled: redoing them exactly makes sense when the camera stops.
//
// It works like this:
//  - every full draw remembers how much it cost; if it is heavy (> HEAVY_MS)
//    it snapshots the result into an offscreen canvas;
//  - if then ONLY the camera changes (same scene, same page, same
//    size), instead of redrawing the snapshot is stamped with the
//    transform that takes the old camera to the new one: it costs one copy;
//  - the call says it is NOT exact, and whoever makes it schedules a real
//    draw when the movement is over (SETTLE_MS after the last change).
//
// A light document never enters this path: it always draws exact.

export const HEAVY_MS = 20;
export const SETTLE_MS = 120;

interface Snapshot {
  scene: SceneState;
  pageId: string | null;
  width: number;
  height: number;
  cam: Camera;
}

export class SceneLayerCache {
  private layer: HTMLCanvasElement | null = null;
  private snap: Snapshot | null = null;
  // How much the last full draw cost.
  lastCostMs = 0;

  /**
   * Draws the scene onto `ctx`. Returns `true` if the result is EXACT, `false`
   * if it is the snapshot of the last frame brought to the new camera (the
   * caller must then schedule the real draw). `force` skips the shortcut.
   */
  draw(
    ctx: CanvasRenderingContext2D,
    scene: SceneState,
    cam: Camera,
    pageId: string | null,
    force = false,
  ): boolean {
    const canvas = ctx.canvas;
    const s = this.snap;
    const sameWorld = !!s && s.scene === scene && s.pageId === pageId && s.width === canvas.width && s.height === canvas.height;
    const cameraMoved = !!s && (s.cam.x !== cam.x || s.cam.y !== cam.y || s.cam.zoom !== cam.zoom);

    if (!force && sameWorld && cameraMoved && this.layer && this.lastCostMs > HEAVY_MS) {
      this.blit(ctx, s as Snapshot, cam);
      return false;
    }

    const t0 = performance.now();
    drawScene(ctx, scene, cam, pageId);
    this.lastCostMs = performance.now() - t0;

    if (this.lastCostMs > HEAVY_MS) {
      this.photograph(canvas);
      this.snap = { scene, pageId, width: canvas.width, height: canvas.height, cam: { ...cam } };
    } else {
      this.snap = null;
    }
    return true;
  }

  private photograph(source: HTMLCanvasElement): void {
    if (typeof document === "undefined") return;
    if (!this.layer) this.layer = document.createElement("canvas");
    if (this.layer.width !== source.width) this.layer.width = source.width;
    if (this.layer.height !== source.height) this.layer.height = source.height;
    this.layer.getContext("2d")?.drawImage(source, 0, 0);
  }

  // One css pixel of the snapshot sits at p0 = (p1 - c0) / z0 in the world, and the
  // world goes to p1' = c1 + z1 * world: therefore p1' = s * p1 + (c1 - s * c0), with
  // s = z1 / z0. The scale and the translation are in backing-store pixels
  // (multiplied by the dpr, which here is the ratio between backing store and css).
  private blit(ctx: CanvasRenderingContext2D, snap: Snapshot, cam: Camera): void {
    const layer = this.layer as HTMLCanvasElement;
    const canvas = ctx.canvas;
    const dpr = canvas.clientWidth > 0 ? canvas.width / canvas.clientWidth : 1;
    const k = cam.zoom / snap.cam.zoom;
    const tx = (cam.x - snap.cam.x * k) * dpr;
    const ty = (cam.y - snap.cam.y * k) * dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(layer, tx, ty, layer.width * k, layer.height * k);
  }
}
