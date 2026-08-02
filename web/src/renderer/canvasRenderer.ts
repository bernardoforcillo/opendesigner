import type { SceneState, NodeLite, FillLite, StrokeLite } from "../store/types";
import type { Camera } from "../canvas/camera";
import { boundsOfNode, inflateBounds } from "../canvas/geometry";
import { nodePath, hitTestNode, nodeCenter } from "./shapes";
import { drawText, strokeText } from "./text";

const DEG_TO_RAD = Math.PI / 180;

function sortedVisible(state: SceneState): NodeLite[] {
  return Object.values(state.nodes)
    .filter((n) => n.visible)
    .sort((a, b) => (a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : 0));
}

// Esportata perché il colore di un nodo serve anche FUORI dal canvas: il
// textarea di editing (ui/TextEditorOverlay.tsx) deve scrivere con lo stesso
// colore con cui il canvas disegnerà quel testo. Una seconda conversione
// RGBA-float -> CSS altrove sarebbe la solita coppia destinata a divergere.
export function cssColor(n: NodeLite): string {
  return cssRgba(n.fills[0] ?? { r: 0.8, g: 0.8, b: 0.8, a: 1 });
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

export function drawScene(ctx: CanvasRenderingContext2D, state: SceneState, cam: Camera): void {
  const { canvas } = ctx;
  const dpr = devicePixelRatio();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(cam.zoom * dpr, 0, 0, cam.zoom * dpr, cam.x * dpr, cam.y * dpr);
  for (const n of sortedVisible(state)) {
    // Il guard sulla dimensione NON vale per il testo: l'altezza di un nodo
    // testo la produce il layout (e la width è solo la larghezza di wrap),
    // quindi un testo con height 0 -- un nodo appena creato -- deve comunque
    // disegnarsi. Una forma degenere invece non ha niente da riempire.
    if (n.kind !== "text" && (n.width <= 0 || n.height <= 0)) continue;
    // ROTAZIONE: attorno al CENTRO del box del nodo (nodeCenter, la stessa
    // funzione che usa l'hit-test per andare nel verso opposto -- vedi
    // canvas/transform.ts per la convenzione). È il CONTESTO a ruotare, non la
    // geometria: nodePath e drawText continuano a disegnare alle coordinate
    // mondo del modello, che restano asse-allineate.
    //
    // save/restore SOLO quando serve davvero: una scena ferma non deve pagare
    // due chiamate per nodo per frame, e i nodi non ruotati devono attraversare
    // esattamente lo stesso codice di prima.
    const rotated = n.rotation % 360 !== 0;
    if (rotated) {
      const c = nodeCenter(n);
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(n.rotation * DEG_TO_RAD);
      ctx.translate(-c.x, -c.y);
    }
    ctx.globalAlpha = n.opacity;
    ctx.fillStyle = cssColor(n);
    if (n.kind === "text") {
      drawText(ctx, n);
      drawStrokes(ctx, n, null);
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

// hitTest in coordinate mondo (già trasformate). Ritorna il nodo più in alto.
export function hitTest(state: SceneState, wx: number, wy: number): string | null {
  const nodes = sortedVisible(state);
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (hitTestNode(n, wx, wy)) return n.id;
  }
  return null;
}
