import type { FillLite, SceneState, NodeLite } from "../store/types";
import type { Camera } from "../canvas/camera";
import { nodePath, hitTestNode, isPaintable } from "./shapes";
import { drawText } from "./text";
import { imageCache, type CachedImage } from "./imageCache";

// Esportata perché l'ORDINE DI DISEGNO non è solo un affare del canvas:
// l'export (export/region.ts) deve scegliere e ordinare i nodi esattamente
// come li sceglie e li ordina chi disegna, o l'immagine esportata non sarebbe
// quella che si vede.
export function sortedVisible(state: SceneState): NodeLite[] {
  return Object.values(state.nodes)
    .filter((n) => n.visible)
    .sort((a, b) => (a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : 0));
}

// La tinta con cui un nodo viene effettivamente riempito, DEFAULT COMPRESO: un
// nodo senza tinte è grigio chiaro, e quel grigio è una decisione del renderer
// (come i default del testo in renderer/text.ts) che non sta nel modello.
// Esportata perché serve a chiunque debba riprodurre lo stesso riempimento
// altrove -- l'export SVG scrive `fill` in attributi separati e non in una
// stringa CSS, ma il default deve restare lo STESSO.
export function resolvedFill(n: NodeLite): FillLite {
  return n.fills[0] ?? { r: 0.8, g: 0.8, b: 0.8, a: 1 };
}

// Esportata perché il colore di un nodo serve anche FUORI dal canvas: il
// textarea di editing (ui/TextEditorOverlay.tsx) deve scrivere con lo stesso
// colore con cui il canvas disegnerà quel testo. Una seconda conversione
// RGBA-float -> CSS altrove sarebbe la solita coppia destinata a divergere.
export function cssColor(n: NodeLite): string {
  const f = resolvedFill(n);
  const to255 = (v: number) => Math.round(v * 255);
  return `rgba(${to255(f.r)}, ${to255(f.g)}, ${to255(f.b)}, ${f.a})`;
}

// La camera resta sempre in pixel CSS: il devicePixelRatio non deve mai
// entrare nel modello né nei tool, solo qui nel disegno effettivo sul canvas.
function devicePixelRatio(): number {
  return typeof window !== "undefined" && window.devicePixelRatio ? window.devicePixelRatio : 1;
}

// Allinea la risoluzione del backing store del canvas alla sua dimensione CSS
// * devicePixelRatio, per evitare il blur su schermi HiDPI. Ritorna true se la
// dimensione è cambiata (utile per evitare resize/clear superflui ogni frame).
export function resizeCanvasToDisplaySize(canvas: HTMLCanvasElement): boolean {
  const dpr = devicePixelRatio();
  const width = Math.round(canvas.clientWidth * dpr);
  const height = Math.round(canvas.clientHeight * dpr);
  if (canvas.width === width && canvas.height === height) return false;
  canvas.width = width;
  canvas.height = height;
  return true;
}

// Opzioni di disegno. `dpr` esiste per un solo motivo: un canvas FUORI SCHERMO
// non ha un dispositivo. Quando si disegna per esportare (export/png.ts) la
// scala la sceglie l'utente (1x/2x/3x) e il devicePixelRatio della macchina non
// deve entrarci -- lo stesso documento esportato a 2x deve dare la stessa
// immagine su un portatile HiDPI e su un monitor esterno.
export interface DrawOptions {
  dpr?: number;
  // Da dove arrivano le immagini già decodificate. Il default è la cache
  // condivisa (renderer/imageCache.ts); si inietta nei test, dove non esiste
  // nessun caricamento vero.
  images?: ImageSource;
}

/** Il minimo che il disegno chiede alla cache delle immagini. */
export interface ImageSource {
  get(docId: string, hash: string): CachedImage;
}

// I colori del SEGNAPOSTO -- un'immagine che non c'è (o non è ancora arrivata).
// Un nodo il cui asset manca deve VEDERSI: sparire vorrebbe dire un buco nel
// documento senza spiegazione, e lanciare vorrebbe dire spegnere il render loop
// per l'intera scena.
const PLACEHOLDER_FILL = "rgba(0, 0, 0, 0.06)";
const PLACEHOLDER_LINE = "rgba(0, 0, 0, 0.35)";

// Il segnaposto. Disegnato con fillRect/strokeRect/moveTo e NON con un Path2D:
// così resta l'unico ramo di drawScene interamente verificabile in questa suite
// (jsdom non ha Path2D), che è esattamente il ramo di cui conta di più sapere
// che non lancia.
//
// `px` è quanto vale UN pixel schermo in coordinate mondo: il ctx qui è già
// trasformato dalla camera, quindi una lineWidth costante sparirebbe a zoom
// basso e ingrasserebbe a zoom alto.
function drawImagePlaceholder(
  ctx: CanvasRenderingContext2D,
  n: NodeLite,
  px: number,
  missing: boolean,
): void {
  ctx.fillStyle = PLACEHOLDER_FILL;
  ctx.fillRect(n.x, n.y, n.width, n.height);
  ctx.strokeStyle = PLACEHOLDER_LINE;
  ctx.lineWidth = px;
  // Il bordo rientra di mezzo pixel per stare DENTRO il box: uno strokeRect sul
  // bordo esatto disegna metà tratto fuori, e l'immagine risulterebbe più grande
  // delle sue maniglie di selezione.
  ctx.strokeRect(n.x + px / 2, n.y + px / 2, n.width - px, n.height - px);
  // La croce distingue "l'asset non c'è" da "sta arrivando": senza, i due stati
  // sarebbero lo stesso rettangolo grigio e un'immagine persa sembrerebbe in
  // caricamento per sempre.
  if (!missing) return;
  ctx.beginPath();
  ctx.moveTo(n.x, n.y);
  ctx.lineTo(n.x + n.width, n.y + n.height);
  ctx.moveTo(n.x + n.width, n.y);
  ctx.lineTo(n.x, n.y + n.height);
  ctx.stroke();
}

// Un nodo immagine: i pixel se ci sono, il segnaposto altrimenti.
//
// L'immagine è tirata sul box del nodo (`drawImage` a quattro coordinate), non
// ritagliata né lettera-boxata: il box nasce dall'aspetto naturale del file
// (tools/imageDrop.ts) e da lì in poi ridimensionarlo è una scelta dell'utente,
// che deve vedere l'effetto che chiede. Le modalità "riempi/adatta" sono una
// funzione a parte, non un default da indovinare.
function drawImageNode(
  ctx: CanvasRenderingContext2D,
  state: SceneState,
  n: NodeLite,
  px: number,
  images: ImageSource,
): void {
  const entry = images.get(state.id, n.image?.assetHash ?? "");
  if (entry.status === "ready" && entry.image) {
    ctx.drawImage(entry.image, n.x, n.y, n.width, n.height);
    return;
  }
  drawImagePlaceholder(ctx, n, px, entry.status === "missing");
}

export function drawScene(
  ctx: CanvasRenderingContext2D,
  state: SceneState,
  cam: Camera,
  opts?: DrawOptions,
): void {
  const { canvas } = ctx;
  const dpr = opts?.dpr ?? devicePixelRatio();
  const images = opts?.images ?? imageCache;
  // Un pixel schermo in unità mondo, per i tratti che devono restare della
  // stessa grossezza a ogni zoom (oggi: il bordo del segnaposto).
  const px = 1 / (cam.zoom || 1);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(cam.zoom * dpr, 0, 0, cam.zoom * dpr, cam.x * dpr, cam.y * dpr);
  for (const n of sortedVisible(state)) {
    if (!isPaintable(n)) continue;
    ctx.globalAlpha = n.opacity;
    ctx.fillStyle = cssColor(n);
    if (n.kind === "text") {
      drawText(ctx, n);
      continue;
    }
    if (n.kind === "image") {
      drawImageNode(ctx, state, n, px, images);
      continue;
    }
    ctx.fill(nodePath(n));
  }
  ctx.globalAlpha = 1;
}

// hitTest in coordinate mondo (già trasformate). Ritorna il nodo più in alto.
export function hitTest(state: SceneState, wx: number, wy: number): string | null {
  const nodes = sortedVisible(state);
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (hitTestNode(n, wx, wy)) return n.id;
  }
  return null;
}
