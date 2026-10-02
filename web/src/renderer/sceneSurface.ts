import type { Camera } from "../canvas/camera";
import { type RendererChoice, useRenderer } from "../store/rendererChoice";
import type { SceneState } from "../store/types";
import { type ImageSource, resizeCanvasToDisplaySize } from "./canvasRenderer";
import { CanvasKitRenderer } from "./ck/ckRenderer";
import { FontBook, loadCanvasKit } from "./ck/canvaskit";
import { SceneLayerCache } from "./layerCache";

// IL RENDERER SU GPU, IMPACCHETTATO: CanvasKit + i font + il renderer, con la
// stessa superficie di chiamata del disegno CPU.
export class GpuSceneRenderer {
  private constructor(
    private readonly renderer: CanvasKitRenderer,
    private readonly fonts: FontBook,
  ) {}

  /** Carica CanvasKit e i font e crea il renderer su `canvas`. Lancia se la GPU non c'è. */
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
    this.renderer.draw(scene, cam, pageId);
  }

  dispose(): void {
    this.renderer.dispose();
    this.fonts.dispose();
  }
}

// La SUPERFICIE della scena: due canvas sovrapposti (uno 2D, uno WebGL) e la
// decisione di quale disegna. Un canvas non può cambiare tipo di contesto una
// volta creato, quindi ognuno ha il proprio elemento: quello inattivo è nascosto
// o -- per il 2D, che resta sopra perché riceve gli eventi -- svuotato.
//
// Se la GPU manca, fallisce o perde il contesto si torna in CPU senza perdere
// niente: il documento non sa quale renderer lo disegna.
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
    // Chiede un nuovo frame (un font arrivato, la GPU pronta).
    private readonly invalidate: () => void,
  ) {}

  /**
   * Disegna la scena col renderer scelto. Ritorna `true` se il frame è esatto, `false` se
   * è il riuso di un'immagine (solo CPU, vedi layerCache.ts) e va pianificato il frame
   * vero.
   */
  draw(scene: SceneState, cam: Camera, pageId: string | null, force: boolean): boolean {
    const choice: RendererChoice = useRenderer.getState().choice;
    if (choice === "gpu") {
      if (!this.gpu && !this.loading) this.startLoad();
      if (this.gpu) {
        if (this.gpu.lost) {
          this.fail("il contesto WebGL è andato perso");
        } else {
          try {
            this.drawGpu(this.gpu, scene, cam, pageId);
            return true;
          } catch (e) {
            this.fail(e instanceof Error ? e.message : String(e));
          }
        }
      }
    } else {
      // Un "error" se queda finché l'utente non cambia scelta: è il motivo per
      // cui si sta disegnando in CPU.
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
    // Il canvas 2D sta sopra e riceve gli eventi: va lasciato trasparente.
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

  // La GPU non va: si torna alla CPU e si dice perché. Si smette di riprovare
  // finché l'utente non cambia scelta.
  private fail(message: string): void {
    this.gpu?.dispose();
    this.gpu = null;
    // Senza passare da setChoice: quello salverebbe "cpu" come preferenza, e un
    // guasto passeggero (una rete caduta durante il download) cancellerebbe la
    // scelta dell'utente.
    useRenderer.setState({ choice: "cpu", status: "error", error: message, frameMs: null });
    this.invalidate();
  }

  // Il tempo del frame, per il confronto fra renderer. Si pubblica al più due
  // volte al secondo: lo store notifica a ogni scrittura.
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
