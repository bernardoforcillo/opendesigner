import type { Camera } from "../canvas/camera";
import type { SceneState } from "../store/types";
import { drawScene } from "./canvasRenderer";

// IL FRAME PESANTE E LA CAMERA CHE SI MUOVE.
//
// Un documento molto grande può richiedere decine di millisecondi per disegnare
// la scena intera (a quella taglia il costo è il rasterizzatore, non la logica).
// Ridisegnarla a ogni passo di un pan o di uno zoom vuol dire scendere sotto i
// 15 fps proprio quando l'utente sta MUOVENDO la vista. Ma mentre la camera si
// muove e il documento no, i pixel che servono sono quelli dell'ultimo frame,
// solo spostati e scalati: rifarli esatti ha senso quando la camera si ferma.
//
// Funziona così:
//  - ogni disegno completo ricorda quanto è costato; se è pesante (> HEAVY_MS)
//    ne fotografa il risultato in un canvas fuori schermo;
//  - se poi cambia SOLO la camera (stessa scena, stessa pagina, stessa
//    dimensione), invece di ridisegnare si stampa la fotografia con la
//    trasformazione che porta la vecchia camera nella nuova: costa una copia;
//  - la chiamata dice di NON essere esatta, e chi la fa pianifica un disegno
//    vero a movimento finito (SETTLE_MS dopo l'ultimo cambio).
//
// Un documento leggero non entra mai in questa strada: disegna sempre esatto.

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
  // Quanto è costato l'ultimo disegno completo.
  lastCostMs = 0;

  /**
   * Disegna la scena su `ctx`. Ritorna `true` se il risultato è ESATTO, `false`
   * se è la fotografia dell'ultimo frame riportata alla camera nuova (chi
   * chiama deve allora pianificare il disegno vero). `force` salta la scorciatoia.
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

  // Un pixel css della fotografia sta a p0 = (p1 - c0) / z0 nel mondo, e il
  // mondo va a p1' = c1 + z1 * mondo: quindi p1' = s * p1 + (c1 - s * c0), con
  // s = z1 / z0. La scala e la traslazione sono in pixel del backing store
  // (moltiplicate per il dpr, che qui è il rapporto fra backing store e css).
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
