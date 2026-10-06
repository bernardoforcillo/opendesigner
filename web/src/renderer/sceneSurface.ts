import type { Camera } from "../canvas/camera";
import { type RendererChoice, useRenderer } from "../store/rendererChoice";
import type { SceneState } from "../store/types";
import { type ImageSource, resizeCanvasToDisplaySize } from "./canvasRenderer";
import { CanvasKitRenderer } from "./ck/ckRenderer";
import { FontBook, loadCanvasKit } from "./ck/canvaskit";
import { SceneLayerCache } from "./layerCache";
import { syncDocumentFonts } from "./fontRegistry";

// THE GPU RENDERER, PACKAGED: CanvasKit + the fonts + the renderer, with the
// same call surface as the CPU drawing.
export class GpuSceneRenderer {
  private constructor(
    private readonly renderer: CanvasKitRenderer,
    private readonly fonts: FontBook,
  ) {}

  /** Loads CanvasKit and the fonts and creates the renderer on `canvas`. Throws if there is no GPU. */
  static async create(canvas: HTMLCanvasElement, images: ImageSource, onFontLoad: () => void): Promise<GpuSceneRenderer> {
    const CK = await loadCanvasKit();
    let self: GpuSceneRenderer | null = null;
    const fonts = new FontBook(CK, () => {
      self?.renderer.fontsChanged();
      onFontLoad();
    });
    await fonts.ready();
    const renderer = new CanvasKitRenderer(CK, canvas, fonts, images);
    self = new GpuSceneRenderer(renderer, fonts);
    return self;
  }

  get lost(): boolean {
    return this.renderer.lost;
  }

  draw(scene: SceneState, cam: Camera, pageId: string | null): void {
    // The uploaded fonts: loaded into CanvasKit's own font book (it cannot see document.fonts).
    this.fonts.setDocumentFonts(scene.id, scene.fonts);
    this.renderer.draw(scene, cam, pageId);
  }

  dispose(): void {
    this.renderer.dispose();
    this.fonts.dispose();
  }
}

// The scene SURFACE: two stacked canvases (one 2D, one WebGL) and the
// decision of which one draws. A canvas cannot change context type once
// created, so each has its own element: the inactive one is hidden
// or -- for the 2D, which stays on top because it receives events -- emptied.
//
// If the GPU is missing, fails or loses the context we go back to the CPU without losing
// anything: the document does not know which renderer draws it.
export class SceneSurface {
  private readonly layers = new SceneLayerCache();
  private gpu: GpuSceneRenderer | null = null;
  private loading = false;
  private disposed = false;
  private cpuCleared = false;
  private lastStats = 0;

  constructor(
    private readonly cpuCanvas: HTMLCanvasElement,
    private readonly glCanvas: HTMLCanvasElement,
    private readonly images: ImageSource,
    // Asks for a new frame (a font arrived, the GPU ready).
    private readonly invalidate: () => void,
  ) {}

  /**
   * Draws the scene with the chosen renderer. Returns `true` if the frame is exact, `false` if
   * it is the reuse of an image (CPU only, see layerCache.ts) and the real frame
   * must be scheduled.
   */
  draw(scene: SceneState, cam: Camera, pageId: string | null, force: boolean): boolean {
    // The uploaded fonts of the document, as CSS fonts for the 2D canvas.
    syncDocumentFonts(scene.id, scene.fonts);
    const choice: RendererChoice = useRenderer.getState().choice;
    // The stroke being drawn (`draw`) is canvas 2D dashing: the GPU renderer
    // cannot do it. As long as a playback-derived scene contains it, drawing happens
    // on the CPU (without touching the user's choice or the "gpu" state); the
    // other animated effects (x, y, rotation, opacity, scale) also go on the GPU.
    if (choice === "gpu" && !scene.anim?.hasDraw) {
      if (!this.gpu && !this.loading) this.startLoad();
      if (this.gpu) {
        if (this.gpu.lost) {
          this.fail("the WebGL context was lost");
        } else {
          try {
            this.drawGpu(this.gpu, scene, cam, pageId);
            return true;
          } catch (e) {
            this.fail(e instanceof Error ? e.message : String(e));
          }
        }
      }
    } else if (choice !== "gpu") {
      // An "error" stays until the user changes choice: it is the reason
      // why drawing is happening on the CPU.
      const st = useRenderer.getState().status;
      if (st === "gpu" || st === "loading") useRenderer.getState().setStatus("cpu");
    }
    return this.drawCpu(scene, cam, pageId, force);
  }

  private drawCpu(scene: SceneState, cam: Camera, pageId: string | null, force: boolean): boolean {
    this.glCanvas.style.display = "none";
    this.cpuCleared = false;
    const ctx = this.cpuCanvas.getContext("2d");
    if (!ctx) return true;
    const t0 = performance.now();
    const exact = this.layers.draw(ctx, scene, cam, pageId, force);
    if (exact) this.report(performance.now() - t0);
    return exact;
  }

  private drawGpu(gpu: GpuSceneRenderer, scene: SceneState, cam: Camera, pageId: string | null): void {
    // The 2D canvas sits on top and receives events: it must be left transparent.
    if (!this.cpuCleared) {
      const ctx = this.cpuCanvas.getContext("2d");
      ctx?.clearRect(0, 0, this.cpuCanvas.width, this.cpuCanvas.height);
      this.cpuCleared = true;
    }
    this.glCanvas.style.display = "block";
    resizeCanvasToDisplaySize(this.glCanvas);
    const t0 = performance.now();
    gpu.draw(scene, cam, pageId);
    this.report(performance.now() - t0);
    if (useRenderer.getState().status !== "gpu") useRenderer.getState().setStatus("gpu");
  }

  private startLoad(): void {
    this.loading = true;
    useRenderer.getState().setStatus("loading");
    GpuSceneRenderer.create(this.glCanvas, this.images, this.invalidate)
      .then((g) => {
        if (this.disposed) {
          g.dispose();
          return;
        }
        this.gpu = g;
        this.loading = false;
        this.invalidate();
      })
      .catch((e) => {
        this.loading = false;
        this.fail(e instanceof Error ? e.message : String(e));
      });
  }

  // The GPU does not work: we go back to the CPU and say why. We stop retrying
  // until the user changes choice.
  private fail(message: string): void {
    this.gpu?.dispose();
    this.gpu = null;
    // Without going through setChoice: that would save "cpu" as the preference, and a
    // transient fault (a network dropped during the download) would erase the
    // user's choice.
    useRenderer.setState({ choice: "cpu", status: "error", error: message, frameMs: null });
    this.invalidate();
  }

  // The frame time, for comparison between renderers. It is published at most twice
  // per second: the store notifies on every write.
  private report(ms: number): void {
    const now = performance.now();
    if (now - this.lastStats < 500) return;
    this.lastStats = now;
    useRenderer.getState().setFrameMs(ms);
  }

  dispose(): void {
    this.disposed = true;
    this.gpu?.dispose();
    this.gpu = null;
  }
}
