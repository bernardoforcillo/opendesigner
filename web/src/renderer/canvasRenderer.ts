import type { SceneState, NodeLite, FillLite, StrokeLite } from "../store/types";
import type { Camera } from "../canvas/camera";
import { boundsOfNode, inflateBounds } from "../canvas/geometry";
import {
  nodePath, hitTestNode, inkIsBox, nodeCenter, vectorPaths,
  VECTOR_FILL_RULE, VECTOR_STROKE_PX,
} from "./shapes";
import { drawText, strokeText } from "./text";
import { imageCache, type CachedImage } from "./imageCache";

const DEG_TO_RAD = Math.PI / 180;

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
  // resolvedFill (traccia 3, default grigio) + cssRgba (traccia 2, float->CSS):
  // il default vive in un posto solo, la conversione in un altro.
  return cssRgba(resolvedFill(n));
}

// RGBA float 0..1 -> stringa CSS. Una funzione sola per riempimenti e tratti:
// sono lo stesso Color nel proto, e due conversioni indipendenti divergerebbero
// al primo arrotondamento diverso.
export function cssRgba(c: FillLite): string {
  const to255 = (v: number) => Math.round(v * 255);
  return `rgba(${to255(c.r)}, ${to255(c.g)}, ${to255(c.b)}, ${c.a})`;
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
    // Il guard sulla dimensione vale solo per le forme il cui inchiostro È il
    // box (rect, ellisse, immagine): per testo e vettoriale un lato a zero è uno
    // stato legittimo e disegnabile. L'elenco delle eccezioni sta in UN posto
    // solo (shapes.ts::inkIsBox), condiviso con l'hit-test: un nodo che si
    // disegna ma non si clicca -- o il contrario -- è il modo in cui i due
    // divergono.
    if (inkIsBox(n) && (n.width <= 0 || n.height <= 0)) continue;
    // ROTAZIONE (traccia 2): è il CONTESTO a ruotare attorno al centro del box
    // (nodeCenter, la stessa funzione che l'hit-test usa nel verso opposto),
    // non la geometria -- nodePath e drawText restano asse-allineati. save/
    // restore SOLO quando serve, così una scena ferma non paga due chiamate per
    // nodo e i nodi fermi attraversano esattamente lo stesso codice di prima.
    const rotated = n.rotation % 360 !== 0;
    if (rotated) {
      const c = nodeCenter(n);
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(n.rotation * DEG_TO_RAD);
      ctx.translate(-c.x, -c.y);
    }
    ctx.globalAlpha = n.opacity;
    const color = cssColor(n);
    ctx.fillStyle = color;
    if (n.kind === "text") {
      drawText(ctx, n);
      drawStrokes(ctx, n, null);
    } else if (n.kind === "image") {
      // Un'immagine disegna sé stessa sul proprio box (traccia 3): niente
      // riempimento sotto, e il tratto non fa parte del suo design.
      drawImageNode(ctx, state, n, px, images);
    } else if (n.kind === "vector") {
      // Il vettoriale ha la sua doppia passata (riempimento even-odd + tratto di
      // ogni contorno): NON è il box del modello, quindi non passa dal ramo
      // rettangolo qui sotto. Il tratto vettoriale è quello di drawVector, non
      // drawStrokes (che è per il perimetro di un box).
      drawVector(ctx, n, color, cam.zoom);
    } else {
      // UN SOLO Path2D per nodo: quello del riempimento è anche quello del
      // tratto (e quello del ritaglio). Costruirne un secondo sarebbe la solita
      // coppia destinata a divergere -- e per il ritaglio dovrebbe essere
      // identico al primo comunque.
      const path = nodePath(n);
      ctx.fill(path);
      drawStrokes(ctx, n, path);
    }
    if (rotated) ctx.restore();
  }
  ctx.globalAlpha = 1;
}

// --- IL TRATTO ----------------------------------------------------------------
//
// Il canvas 2D traccia SOLO centrato sul path: `lineWidth` si spartisce metà
// dentro e metà fuori, e non esiste nessuna proprietà di allineamento. Le altre
// due ricette si ottengono raddoppiando la larghezza -- così la metà che
// sopravvive è ESATTAMENTE il peso chiesto -- e ritagliando il lato di troppo:
//
//   INSIDE   clip(path)                  -> resta la metà interna
//   OUTSIDE  clip(complemento, evenodd)  -> resta la metà esterna
//
// È la tecnica standard, ed è esatta (non un'approssimazione) per le forme
// SEMPLICI che il progetto disegna: rettangolo, rettangolo stondato, ellisse.
// Su un path AUTOINTERSECANTE "dentro" e "fuori" dipenderebbero dalla regola di
// riempimento e il complemento evenodd non sarebbe più il complemento --
// nessuna delle forme di M1/M2 lo è, ma vale la pena saperlo prima del pen tool.
//
// Il TESTO fa storia a sé: un glifo un Path2D non ce l'ha (il canvas 2D non
// espone il contorno del testo), quindi il suo tratto è sempre centrato --
// l'approssimazione è dichiarata in renderer/text.ts::strokeText, e
// canvas/geometry.ts::strokeOutsetOfNode conta la sporgenza con la stessa
// regola, così misura e disegno restano la stessa cosa.
function drawStrokes(ctx: CanvasRenderingContext2D, n: NodeLite, path: Path2D | null): void {
  for (const s of n.strokes) {
    // Un peso non positivo NON è un tratto sottilissimo: non è un tratto. Il
    // canvas con lineWidth 0 non disegna nulla, e i bounds non contano nessuna
    // sporgenza (canvas/geometry.ts::strokeOutset) -- le due cose devono
    // saltare lo stesso tratto.
    if (!(s.weight > 0)) continue;
    ctx.strokeStyle = cssRgba(s.color);
    if (path === null) {
      ctx.lineWidth = s.weight;
      strokeText(ctx, n);
      continue;
    }
    strokeShape(ctx, n, path, s);
  }
}

function strokeShape(ctx: CanvasRenderingContext2D, n: NodeLite, path: Path2D, s: StrokeLite): void {
  if (s.align === "center") {
    ctx.lineWidth = s.weight;
    ctx.stroke(path);
    return;
  }
  ctx.save();
  if (s.align === "inside") ctx.clip(path);
  else ctx.clip(outsideClip(n, path, s.weight), "evenodd");
  ctx.lineWidth = s.weight * 2;
  ctx.stroke(path);
  ctx.restore();
}

// Il COMPLEMENTO della forma, come regione di ritaglio: un rettangolo che
// copre tutta la fascia esterna PIÙ il path della forma, valutati con evenodd.
// Un punto dentro la forma attraversa due bordi (pari) e resta quindi FUORI
// dalla regione; uno nella fascia ne attraversa uno solo (dispari) e ci resta
// dentro. Nessun path da invertire, e la forma è la stessa del riempimento.
//
// Il rettangolo non è "tutto lo schermo": basta il box del nodo allargato di
// quanto il tratto può sporgere (weight, perché la metà esterna di un tratto
// spesso 2*weight arriva esattamente lì) più un margine, che esiste solo perché
// il bordo del rettangolo di clip non cada MAI sul bordo esterno della fascia --
// lì l'antialiasing del canvas mangerebbe mezzo pixel di tratto.
const OUTSIDE_CLIP_MARGIN = 1;

function outsideClip(n: NodeLite, path: Path2D, weight: number): Path2D {
  const b = inflateBounds(boundsOfNode(n), weight + OUTSIDE_CLIP_MARGIN);
  const clip = new Path2D();
  clip.rect(b.x, b.y, b.width, b.height);
  clip.addPath(path);
  return clip;
}

// Un nodo vettoriale in DUE passate: OGNI contorno si traccia, e in più quelli
// che hanno area si riempiono. Il tratto non è decorazione -- è ciò che tiene
// visibile un contorno aperto e un contorno chiuso di area nulla (due
// ancoraggi, o tre allineati: due stati che il pen tool raggiunge in tre click,
// e che il solo riempimento non dipingerebbe affatto).
//
// I due Path2D sono separati perché un contorno aperto messo in quello del
// riempimento verrebbe chiuso implicitamente dal canvas e riempito -- ed è per
// questo che vectorPaths ne restituisce due.
function drawVector(ctx: CanvasRenderingContext2D, n: NodeLite, color: string, zoom: number): void {
  const { fill, stroke } = vectorPaths(n);
  // La regola even-odd è una SCELTA (motivata su shapes.ts::VECTOR_FILL_RULE)
  // e non il default del canvas, quindi va passata a ogni fill. È la stessa
  // che usa l'hit-test: un buco che si vede ma si clicca sarebbe la firma di
  // due regole diverse.
  if (fill) ctx.fill(fill, VECTOR_FILL_RULE);
  if (stroke) {
    ctx.strokeStyle = color;
    // Il ctx è in trasformazione MONDO (drawScene applica zoom * dpr), quindi
    // uno spessore costante sullo schermo si ottiene dividendo per lo zoom --
    // il dpr si cura da sé, essendo nella stessa matrice. Senza, la linea di un
    // path si ingrasserebbe insieme al disegno e a zoom 64 sarebbe una banda.
    ctx.lineWidth = VECTOR_STROKE_PX / zoom;
    // Giunti e capi tondi: sono anche ciò che rende visibile un contorno di UN
    // solo ancoraggio, che shapes.ts traccia come un segmento di lunghezza
    // nulla (il pallino del pen tool dopo il primo click).
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke(stroke);
  }
}

// hitTest in coordinate mondo (già trasformate). Ritorna il nodo più in alto.
// `zoom` arriva fino a hitTestNode perché la presa attorno a un contorno
// vettoriale APERTO è in px SCHERMO: vedi shapes.ts::VECTOR_HIT_PX.
export function hitTest(state: SceneState, wx: number, wy: number, zoom: number): string | null {
  const nodes = sortedVisible(state);
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (hitTestNode(n, wx, wy, zoom)) return n.id;
  }
  return null;
}
