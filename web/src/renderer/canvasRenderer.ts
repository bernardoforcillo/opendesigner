import type { SceneState, NodeLite } from "../store/types";
import type { Camera } from "../canvas/camera";
import { applyTransform, invertTransform, localTransformOf } from "../canvas/transform";
import { childIndexOf } from "../store/tree";
import { nodePath, hitTestNode } from "./shapes";
import { drawText } from "./text";

// L'ALBERO, non più la mappa piatta.
//
// Le coordinate di un nodo sono relative al suo parent (vedi
// canvas/transform.ts), quindi il disegno non può più leggere x/y e piazzarli:
// deve SCENDERE, accumulando la trasformazione di ogni container. Da qui
// discendono, senza scelte in più, anche l'ordine e la visibilità:
//   - un container si disegna PRIMA dei suoi figli (sta dietro al proprio
//     contenuto), i fratelli in ordine di order key;
//   - un nodo irraggiungibile da una pagina non si disegna: non ha un posto
//     nel mondo (stessa regola di tree.ts::parentExists);
//   - un container invisibile porta via con sé tutto il sottoalbero -- non si
//     può disegnare il figlio di qualcosa che non c'è.
// L'hit-test fa lo stesso cammino al contrario, ed è l'unico modo perché ciò
// che si vede sia esattamente ciò che si clicca.
//
// Un indice figli-per-parent (store/tree.ts::childIndexOf) costruito una volta
// per chiamata invece di una childrenOf per nodo: quest'ultima è una scansione
// della mappa, e il renderer gira a ogni frame.
type ChildIndex = Map<string, NodeLite[]>;

// I nodi radice del documento: i figli DIRETTI delle pagine, nell'ordine delle
// pagine. Oggi il documento ha una pagina sola e la scena disegna tutto ciò che
// è raggiungibile; quando arriveranno le pagine multiple (stessa traccia) sarà
// qui che si passerà alla sola pagina corrente.
function rootsOf(state: SceneState, children: ChildIndex): NodeLite[] {
  return state.pages.flatMap((p) => children.get(p.id) ?? []);
}

// Esportata perché il colore di un nodo serve anche FUORI dal canvas: il
// textarea di editing (ui/TextEditorOverlay.tsx) deve scrivere con lo stesso
// colore con cui il canvas disegnerà quel testo. Una seconda conversione
// RGBA-float -> CSS altrove sarebbe la solita coppia destinata a divergere.
export function cssColor(n: NodeLite): string {
  const f = n.fills[0] ?? { r: 0.8, g: 0.8, b: 0.8, a: 1 };
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

export function drawScene(ctx: CanvasRenderingContext2D, state: SceneState, cam: Camera): void {
  const { canvas } = ctx;
  const dpr = devicePixelRatio();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(cam.zoom * dpr, 0, 0, cam.zoom * dpr, cam.x * dpr, cam.y * dpr);
  const children = childIndexOf(state);
  drawSiblings(ctx, children, rootsOf(state, children), new Set());
  ctx.globalAlpha = 1;
}

// Disegna una lista di fratelli (già ordinata) nello spazio CORRENTE del ctx,
// scendendo in ognuno.
//
// Ricorsione e non pila esplicita come tree.ts::subtreeOf: qui la discesa è
// ACCOPPIATA a save/restore del ctx (e, nell'hit-test, alla conversione del
// punto), e una pila esplicita dovrebbe ricostruire a mano proprio
// quell'accoppiamento. `seen` rende comunque la profondità limitata dal NUMERO di
// nodi -- un ciclo in un documento malformato non può far scendere all'infinito
// -- e la profondità di un documento vero è dell'ordine delle decine.
function drawSiblings(ctx: CanvasRenderingContext2D, children: ChildIndex, siblings: NodeLite[], seen: Set<string>): void {
  for (const n of siblings) {
    if (!n.visible || seen.has(n.id)) continue;
    seen.add(n.id);
    drawNode(ctx, n);
    const kids = children.get(n.id);
    if (!kids || kids.length === 0) continue;
    // Il container entra nella trasformazione SOLO per i figli: le sue
    // coordinate proprie sono già state usate qui sopra, nello spazio del suo
    // parent. save/restore invece di applicare l'inversa a mano: il ctx sa già
    // annullare esattamente ciò che gli è stato composto.
    ctx.save();
    const t = localTransformOf(n);
    ctx.transform(t.a, t.b, t.c, t.d, t.e, t.f);
    drawSiblings(ctx, children, kids, seen);
    ctx.restore();
  }
}

// Il nodo e basta, nello spazio del suo parent (che è quello corrente del ctx).
// Un contenitore con un box degenere non si disegna ma i suoi figli sì: il
// guard sta QUI e non nella discesa, perché un gruppo non ha un box proprio da
// riempire e i suoi figli devono comunque comparire.
function drawNode(ctx: CanvasRenderingContext2D, n: NodeLite): void {
  // Il guard sulla dimensione NON vale per il testo: l'altezza di un nodo
  // testo la produce il layout (e la width è solo la larghezza di wrap),
  // quindi un testo con height 0 -- un nodo appena creato -- deve comunque
  // disegnarsi. Una forma degenere invece non ha niente da riempire.
  if (n.kind !== "text" && (n.width <= 0 || n.height <= 0)) return;
  // L'opacità resta PER NODO e non si eredita: l'opacità di gruppo (il
  // sottoalbero composto fuori schermo e poi fuso) è un'altra cosa, e arriva
  // con i gruppi. Moltiplicarla qui darebbe un risultato diverso da entrambe.
  ctx.globalAlpha = n.opacity;
  ctx.fillStyle = cssColor(n);
  if (n.kind === "text") {
    drawText(ctx, n);
    return;
  }
  ctx.fill(nodePath(n));
}

// hitTest in coordinate MONDO. Ritorna il nodo più in alto -- il PIÙ INTERNO
// dove i sottoalberi si sovrappongono, perché un figlio si disegna sopra il
// proprio container. Chi selezionerà il GRUPPO invece del figlio (il click
// seleziona il gruppo, il doppio click entra) risale da qui con l'albero: è
// una politica di selezione, non di hit-test, e non va nascosta qui dentro.
export function hitTest(state: SceneState, wx: number, wy: number): string | null {
  const children = childIndexOf(state);
  return pickIn(children, rootsOf(state, children), wx, wy, new Set());
}

// Lo STESSO cammino di drawSiblings, al contrario: fratelli dall'ultimo al
// primo (l'ultimo è il più in alto) e, dentro ognuno, prima il sottoalbero e
// poi il nodo stesso.
//
// (px, py) è il punto nello spazio LOCALE di questi fratelli, cioè quello in
// cui sono scritte le loro coordinate: è lì che hitTestNode li confronta. Per
// scendere in un container si applica al punto l'INVERSA della trasformazione
// che il renderer applica al ctx -- la stessa localTransformOf, letta
// nell'altro verso.
function pickIn(children: ChildIndex, siblings: NodeLite[], px: number, py: number, seen: Set<string>): string | null {
  for (let i = siblings.length - 1; i >= 0; i--) {
    const n = siblings[i];
    if (!n.visible || seen.has(n.id)) continue;
    seen.add(n.id);
    const kids = children.get(n.id);
    if (kids && kids.length > 0) {
      const inner = applyTransform(invertTransform(localTransformOf(n)), px, py);
      const hit = pickIn(children, kids, inner.x, inner.y, seen);
      if (hit) return hit;
    }
    if (hitTestNode(n, px, py)) return n.id;
  }
  return null;
}
