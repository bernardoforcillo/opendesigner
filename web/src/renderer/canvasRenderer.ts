import type { SceneState, NodeLite } from "../store/types";
import type { Camera } from "../canvas/camera";
import {
  IDENTITY,
  applyTransform,
  compose,
  invertTransform,
  localTransformOf,
  mapBounds,
  type Transform,
} from "../canvas/transform";
import { type Bounds, boundsIntersect, boundsOfNode, intersectBounds } from "../canvas/geometry";
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

// I nodi radice della PAGINA CORRENTE: i suoi figli diretti, in ordine di order
// key. Il canvas mostra UNA pagina alla volta, quindi disegno, hit-test e
// marquee scendono tutti da qui -- è l'unico punto in cui la scelta della
// pagina entra nel renderer, ed è ciò che tiene vedi-vs-seleziona in accordo (i
// tre condividono rootsOf, quindi non possono divergere sulla pagina).
//
// currentPageId è un PARAMETRO, non un campo della scena: la pagina corrente è
// stato di vista dello store (store.ts), e il renderer resta una funzione pura
// di (scene, camera, currentPageId). Assente (o null) ripiega sulla PRIMA
// pagina -- il default dello store -- così le scene a pagina singola non hanno
// bisogno di dirlo. Un id che non è (più) una pagina non ha radici: children
// non lo conosce e la lista è vuota (canvas bianco), ma l'invariante dello store
// fa sì che non capiti se non per un istante durante una transizione.
function rootsOf(state: SceneState, children: ChildIndex, currentPageId?: string | null): NodeLite[] {
  const pageId = currentPageId ?? state.pages[0]?.id;
  return pageId !== undefined ? children.get(pageId) ?? [] : [];
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

export function drawScene(ctx: CanvasRenderingContext2D, state: SceneState, cam: Camera, currentPageId?: string | null): void {
  const { canvas } = ctx;
  const dpr = devicePixelRatio();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(cam.zoom * dpr, 0, 0, cam.zoom * dpr, cam.x * dpr, cam.y * dpr);
  const children = childIndexOf(state);
  drawSiblings(ctx, children, rootsOf(state, children, currentPageId), new Set());
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
    // Un FRAME con clipsContent ritaglia i figli al PROPRIO box. Il clip sta
    // qui, DENTRO il save/restore e DOPO la trasformazione: è quindi nello
    // spazio locale dei figli, dove il box del frame è (0,0,width,height) --
    // l'origine del frame è l'origine dei figli. È lo STESSO ritaglio che pickIn
    // applica al punto e collectIn alla banda (via intersectBounds): vedi-vs-
    // seleziona, ciò che il clip nasconde al disegno non si clicca e il marquee
    // non lo prende. Un frame senza clipsContent lascia sporgere i figli.
    if (n.kind === "frame" && n.clipsContent) {
      const clip = new Path2D();
      clip.rect(0, 0, n.width, n.height);
      ctx.clip(clip);
    }
    drawSiblings(ctx, children, kids, seen);
    ctx.restore();
  }
}

// Il nodo e basta, nello spazio del suo parent (che è quello corrente del ctx).
// Un contenitore con un box degenere non si disegna ma i suoi figli sì: il
// guard sta QUI e non nella discesa, perché un gruppo non ha un box proprio da
// riempire e i suoi figli devono comunque comparire.
function drawNode(ctx: CanvasRenderingContext2D, n: NodeLite): void {
  // Un GRUPPO non si disegna: è un contenitore senza geometria propria (i suoi
  // bounds sono l'unione dei figli) e ciò che si vede sono i figli. Il ramo è
  // esplicito e non affidato al guard sulla dimensione qui sotto: un gruppo con
  // width/height diversi da zero -- scritti da chi non lo sa, o da un documento
  // di un'altra versione -- comparirebbe come un rettangolo pieno che l'utente
  // non ha mai disegnato.
  if (n.kind === "group") return;
  // Un FRAME invece SI DISEGNA: ha geometria propria (il box è suo, non
  // l'unione dei figli) e qui cade sul ramo forma qui sotto -- box riempito coi
  // suoi fills come un rettangolo (nodePath lo tiene a spigoli vivi). drawNode
  // gira PRIMA della discesa nei figli (drawSiblings), quindi il box del frame
  // finisce dietro il proprio contenuto: è lo sfondo dell'artboard. Il clip
  // eventuale dei figli è nella discesa, non qui.
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
export function hitTest(state: SceneState, wx: number, wy: number, currentPageId?: string | null): string | null {
  const children = childIndexOf(state);
  return pickIn(children, rootsOf(state, children, currentPageId), wx, wy, new Set());
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
      // Un FRAME con clipsContent nasconde i figli fuori dal proprio box: se il
      // punto (già nello spazio locale del frame, dove il box è
      // (0,0,width,height)) cade fuori, quei figli sono ritagliati via -- non si
      // disegnano lì (drawSiblings) e non si devono cliccare. Stessa geometria,
      // stesso risultato: vedi-vs-seleziona. Il frame stesso resta colpibile sul
      // suo box (hitTestNode qui sotto). Senza clip la discesa è come sempre.
      const clipsAway =
        n.kind === "frame" && n.clipsContent &&
        !(inner.x >= 0 && inner.x <= n.width && inner.y >= 0 && inner.y <= n.height);
      if (!clipsAway) {
        const hit = pickIn(children, kids, inner.x, inner.y, seen);
        if (hit) return hit;
      }
    }
    if (hitTestNode(n, px, py)) return n.id;
  }
  return null;
}

// I nodi il cui box MONDO interseca `bounds`, in ordine di DISEGNO. È la
// domanda del marquee ("cosa c'è dentro questo rettangolo"), e sta qui insieme
// a drawScene/hitTest perché deve rispondere con gli STESSI nodi: un marquee
// che seleziona ciò che il renderer non disegna è la stessa divergenza
// vedi-vs-clicca che l'hit-test evita, solo presa dall'altro lato -- la
// selezione finirebbe con una cornice e 8 maniglie su canvas vuoto, e il drag
// successivo manderebbe setProps per una geometria che l'utente non vede.
// Quindi la stessa discesa: si parte dai figli delle pagine (chi non è
// raggiungibile non ha un posto nel mondo) e un container invisibile porta via
// con sé tutto il sottoalbero.
//
// A differenza di pickIn qui si accumula la trasformazione ANDANDO (locale ->
// mondo) invece di invertirla: il rettangolo del marquee è uno solo e sta nel
// mondo, mentre i box da confrontare sono uno per nodo.
//
// Come hitTest, non risponde MAI con un gruppo (vedi collectIn): risponde con
// ciò che si vede, e a risalire ai gruppi è la politica di selezione.
export function nodesIntersecting(state: SceneState, bounds: Bounds, currentPageId?: string | null): string[] {
  const children = childIndexOf(state);
  const out: string[] = [];
  collectIn(children, rootsOf(state, children, currentPageId), IDENTITY, bounds, out, new Set());
  return out;
}

// `toWorld` porta al mondo lo spazio in cui sono scritte le coordinate di
// QUESTI fratelli, cioè quello del loro parent (identità per i figli di una
// pagina): la stessa direzione dell'avvertenza su worldTransformOf.
//
// La discesa non si pota quando il box di un container manca il marquee: un
// gruppo non contiene per forza i propri figli (il suo box è il suo, non
// l'unione), quindi un figlio dentro il marquee resterebbe fuori dalla
// selezione. Si salta solo ciò che non si vede.
function collectIn(
  children: ChildIndex,
  siblings: NodeLite[],
  toWorld: Transform,
  bounds: Bounds,
  out: string[],
  seen: Set<string>,
): void {
  for (const n of siblings) {
    if (!n.visible || seen.has(n.id)) continue;
    seen.add(n.id);
    // Un GRUPPO non entra MAI per conto suo, come non si disegna (drawNode) e
    // non si colpisce (shapes.ts::hitTestNode): il suo box non è la sua
    // cornice. Alla creazione è 0x0 all'ORIGINE del parent, e boundsIntersect
    // confronta con < / > su bordi opposti, quindi un box degenere STRETTAMENTE
    // dentro la banda interseca: senza questo ramo un marquee tirato attorno
    // all'origine prenderebbe ogni gruppo appena creato -- cornice e 8 maniglie
    // attorno a un contenuto che sta cento pixel fuori dalla banda, cioè
    // esattamente la divergenza vedi-vs-seleziona descritta qui sopra.
    // A selezionarlo ci pensa la POLITICA (store/groups.ts::selectionTargetsOf),
    // che risale ai gruppi dai FIGLI presi qui sotto: un gruppo entra nella
    // selezione quando il marquee prende qualcosa che si vede di lui.
    const worldBox = mapBounds(toWorld, boundsOfNode(n));
    if (n.kind !== "group" && boundsIntersect(worldBox, bounds)) out.push(n.id);
    const kids = children.get(n.id);
    if (!kids || kids.length === 0) continue;
    // Un FRAME con clipsContent restringe la banda al proprio box MONDO prima di
    // scendere: i figli contano solo per la parte che si VEDE dentro il frame,
    // esattamente come il disegno li ritaglia (drawSiblings) e l'hit-test li
    // nasconde (pickIn). intersectBounds torna null quando la banda non tocca
    // affatto il box del frame -- lì non c'è niente di visibile da prendere, e
    // la discesa si ferma. Senza clip la banda scende intatta e i figli possono
    // sporgere. Ritagli annidati (frame dentro frame) si compongono da soli:
    // ogni livello restringe ancora.
    let childBounds: Bounds | null = bounds;
    if (n.kind === "frame" && n.clipsContent) {
      childBounds = intersectBounds(bounds, worldBox);
      if (!childBounds) continue;
    }
    collectIn(children, kids, compose(toWorld, localTransformOf(n)), childBounds, out, seen);
  }
}
