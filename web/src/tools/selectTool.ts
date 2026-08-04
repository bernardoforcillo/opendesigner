import { hitTest, nodesIntersecting } from "../renderer/canvasRenderer";
import { normalizeRect, boundsOfNode, type Bounds } from "../canvas/geometry";
import {
  type Transform,
  invertTransform,
  mapBounds,
  mapVector,
  worldBoundsOfNode,
  worldTransformOf,
} from "../canvas/transform";
import { worldToScreen } from "../canvas/camera";
import { angleOf, centerOf, normalizeDegrees, rotateAround, snapDegrees } from "../canvas/transform";
import { selectionFrame, selectionWorldBounds } from "../renderer/overlayRenderer";
import { resizeVector } from "../store/vectorGeometry";
import type { SubPathLite } from "../store/types";
import {
  applyFrameResize,
  applyFrameResizeToNode,
  cursorForFrameHit,
  cursorForHandle,
  hitTestFrame,
  movingEdgeLines,
  resizeFrame,
  ROTATING_CURSOR,
  type FrameHit,
  type HandleId,
  type SelectionFrame,
} from "../selection/handles";
import { snapBounds, snapMoving, snapTargets, worldThreshold, type SnapGuide } from "../selection/snap";
import { useScene } from "../store/store";
import { enterTargetOf, selectionTargetOf, selectionTargetsOf, transformTargetsOf } from "../store/groups";
import { subtreeOf, topmostOf } from "../store/tree";
import { groupOps, ungroupOps } from "./grouping";
import { makeDeleteOp, makeSetPropsOp, makeSetVectorPathOp } from "./ops";
import type { SceneState } from "../store/types";
import type { Op } from "../gen/brawt/v1/brawt_pb";
import type { Tool, ToolContext } from "./types";

const DEFAULT_CURSOR = "default";

// Sotto questa soglia (px SCHERMO, come la CLICK_SLOP_PX di shapeTool) un
// "marquee" non è un marquee: è un CLICK sul vuoto. La distinzione conta perché
// il marquee seleziona per intersezione di BOUNDS (AABB), mentre il click passa
// da hitTest (che per un'ellisse è la vera equazione dell'ellisse). Senza
// soglia, un click nell'angolo vuoto del bounding box di un'ellisse apre un
// marquee 0x0 che "interseca" quel bounding box e seleziona l'ellisse: la
// stessa selezione per AABB che hitTest esiste apposta per evitare. Il click sul
// vuoto deve solo azzerare la selezione (o lasciarla intatta con shift).
const MARQUEE_SLOP_PX = 3;

// Soglia di doppio click, in ms fra i due timeStamp dei pointerdown (Task 4,
// step 3: doppio click con Seleziona su un nodo testo entra in editing).
// toolManager.ts non inoltra un evento nativo "dblclick": rilevarlo qui per
// ID + tempo (invece che introdurre un secondo canale di eventi) resta
// testabile senza timer finti, bastano due PointerEvent con timeStamp diversi.
const DOUBLE_CLICK_MS = 400;

// Quanto può spostarsi il puntatore (px SCHERMO, come MARQUEE_SLOP_PX qui sopra
// e CLICK_SLOP_PX di shapeTool) fra il pointerdown del secondo click e il suo
// rilascio senza smettere di essere un doppio click. Sopra la soglia quel
// pointer è un DRAG e basta: vedi il commento su pendingTextEdit.
const DOUBLE_CLICK_SLOP_PX = 3;

// Con Shift premuto la rotazione scatta a multipli di 15° (la convenzione degli
// editor di design: 15 divide 45, 90 e 360).
const ROTATE_SNAP_DEG = 15;

// Il cursore vive sul DOM del canvas (come fa toolManager quando cambia tool).
// Duck-typing su style: nei test ctx.canvas è un doppio, non un HTMLCanvasElement.
function setCursor(ctx: ToolContext, cursor: string): void {
  const style = (ctx.canvas as unknown as { style?: { cursor: string } } | undefined)?.style;
  if (style) style.cursor = cursor;
}

// Le maniglie si testano in px SCHERMO (area di presa costante a ogni zoom),
// ma ToolContext espone solo toWorld: si torna in schermo passando ANCORA da
// canvas/camera.ts, mai ricalcolando la trasformazione a mano. Il round-trip
// world -> screen è l'inverso esatto di toWorld, quindi non serve conoscere il
// rettangolo del canvas qui.
//
// Ritorna il colpo COMPLETO dell'overlay: una delle 8 maniglie di resize
// oppure una delle 4 zone di rotazione appena fuori dagli angoli (l'ordine di
// precedenza sta in selection/handles.ts::hitTestFrame).
function frameUnderPointer(ctx: ToolContext, world: { x: number; y: number }): FrameHit | null {
  const frame = frameOfSelection(ctx);
  if (!frame) return null;
  const cam = ctx.getCamera();
  const p = worldToScreen(cam, world.x, world.y);
  return hitTestFrame(frame, cam, p.x, p.y);
}

function frameOfSelection(ctx: ToolContext): SelectionFrame | null {
  const scene = ctx.getScene();
  if (!scene) return null;
  return selectionFrame(scene, useScene.getState().selection);
}

// Dal MONDO allo spazio in cui sono scritte le coordinate di un nodo, cioè lo
// spazio locale del suo parent. È la conversione che ogni gesto deve fare
// prima di scrivere nel modello: il puntatore parla mondo, il documento parla
// relativo al parent. Per un nodo figlio di una pagina è l'identità -- ed è
// per questo che un documento già esistente non si muove di un pixel.
function parentToLocal(scene: SceneState, parentId: string): Transform {
  return invertTransform(worldTransformOf(scene, parentId));
}

// Gli id da ESCLUDERE dai bersagli dello snap: non solo i nodi selezionati ma
// tutto il loro SOTTOALBERO. Un gruppo che si trascina (o si ridimensiona) porta
// con sé i figli, che quindi si muovono insieme e non sono bersagli a cui
// scattare -- altrimenti la cornice del gruppo scatterebbe contro il proprio
// contenuto. Per una selezione piatta subtreeOf(id) è [id], quindi coincide con
// la selezione stessa e lo snap resta identico a prima.
function snapExclude(scene: SceneState, selection: readonly string[]): string[] {
  return selection.flatMap((id) => subtreeOf(scene, id).map((n) => n.id));
}

export type PickResult =
  | { mode: "marquee" }
  | { mode: "single"; id?: string }
  | { mode: "toggle"; id: string };

// Decide il TIPO di gesto senza toccare lo store: pura funzione di scena +
// input (`zoom` incluso: la presa attorno a un path vettoriale aperto è in px
// SCHERMO, vedi renderer/shapes.ts::VECTOR_HIT_PX), testabile senza DOM
// (Task 8, step 1). id assente in mode "single"
// significa "il nodo è già selezionato, non toccare la selezione" -- è la
// lettura di "selezione singola (SE NON GIÀ selezionato)" del brief: così un
// drag successivo sposta l'INTERA selezione (anche multipla) invece di
// collassarla prematuramente su un solo nodo.
export function pickTarget(
  scene: SceneState,
  world: { x: number; y: number },
  shiftKey: boolean,
  selection: string[],
  zoom: number,
  currentPageId?: string | null,
): PickResult {
  // Scoped alla pagina corrente, come il disegno (T1): un click non colpisce un
  // nodo di un'ALTRA pagina (che il canvas non mostra). `zoom` va fino a
  // hitTestNode per la presa di un path vettoriale aperto (T4, px SCHERMO).
  // currentPageId assente ripiega sulla prima pagina -- vedi canvasRenderer::rootsOf.
  const hit = hitTest(scene, world.x, world.y, zoom, currentPageId);
  if (!hit) return { mode: "marquee" };
  // hitTest risponde "quale nodo c'è sotto il puntatore" -- il più INTERNO,
  // sempre. Quale nodo si SELEZIONA è un'altra domanda, e la risposta è la
  // politica dei gruppi (store/groups.ts): il gruppo più esterno, a meno che
  // la selezione corrente non dica che ci siamo già entrati. Vale anche per lo
  // shift-click: si aggiunge alla selezione la stessa cosa che un click
  // selezionerebbe, o shift diventerebbe il modo per prendere un figlio senza
  // entrare nel gruppo.
  const id = selectionTargetOf(scene, hit, selection);
  if (shiftKey) return { mode: "toggle", id };
  return selection.includes(id) ? { mode: "single" } : { mode: "single", id };
}

// Id dei nodi che il marquee seleziona: quelli VISIBILI (nell'intero cammino
// dalla pagina in giù) il cui box MONDO interseca il rettangolo, in ordine di
// disegno.
//
// Il marquee è in coordinate MONDO (viene dal puntatore) e le coordinate del
// modello sono relative al parent: la conversione, insieme alle regole
// dell'albero (container invisibile che porta via il sottoalbero, clip dei
// frame), sta in renderer/canvasRenderer.ts::nodesIntersecting -- la STESSA
// discesa di drawScene e hitTest, così ciò che si vede è ciò che si seleziona.
//
// L'ordine è quello dell'albero (container prima dei figli, fratelli per order
// key) e non un confronto piatto di order key: per una scena piatta sono la
// stessa lista, per una annidata solo il primo ha un significato.
export function nodesInMarquee(scene: SceneState, bounds: Bounds, currentPageId?: string | null): string[] {
  return nodesIntersecting(scene, bounds, currentPageId);
}

function union(base: string[], extra: string[]): string[] {
  const seen = new Set(base);
  return [...base, ...extra.filter((id) => !seen.has(id))];
}

// I MODIFICATORI che decidono la forma di un gesto: Alt spegne lo snap, Shift
// tiene il rapporto d'aspetto (nel resize) e scatta l'angolo (nella rotazione).
interface Mods { alt: boolean; shift: boolean }

function modsOf(e: { altKey?: boolean; shiftKey?: boolean }): Mods {
  return { alt: e.altKey === true, shift: e.shiftKey === true };
}

export function createSelectTool(): Tool {
  // --- I MODIFICATORI DELL'ULTIMA ANTEPRIMA ---------------------------------
  //
  // L'op finale si ricalcola dalla posizione del POINTERUP, ma i modificatori
  // NO: si usano quelli dell'ultimo pointermove, cioè quelli che hanno prodotto
  // l'anteprima che l'utente sta guardando quando lascia il pulsante.
  //
  // Leggerli dall'evento di pointerup è un bug che si vede solo quando conta:
  // Alt tenuto per tutto un trascinamento (anteprime esattamente sotto il dito,
  // per posare un nodo a 2 px dal vicino), Alt lasciato un istante PRIMA del
  // pulsante -- e il pointerup arriva con altKey false, lo snap scatta al
  // commit e il nodo salta fino a SNAP_THRESHOLD_PX/zoom. endGesture ricostruisce
  // la scena da quegli op, quindi il salto è ciò che finisce sul filo e nella
  // voce di undo. Il verso opposto (premere Alt appena prima di lasciare, per
  // sfuggire a uno scatto già mostrato) è altrettanto raggiungibile. Alt è
  // proprio la via d'uscita dallo snap: leggerlo al rilascio disfa la funzione
  // nell'unico momento in cui serve.
  //
  // Vale identico per Shift: lasciarlo prima del pulsante commetterebbe un
  // resize NON vincolato dopo un'anteprima vincolata, e un angolo non scattato
  // dopo un'anteprima scattata.
  //
  // Si LATCHA all'ultima anteprima (non al pointerdown) perché premere o
  // lasciare un modificatore a metà gesto deve continuare a cambiare l'anteprima
  // subito, come in ogni editor: la regola è "si commette ciò che si è visto",
  // non "si commette ciò che si era premuto all'inizio". Un latch solo per tutti
  // e tre i gesti: ne è aperto al massimo uno per volta.
  let lastMods: Mods = { alt: false, shift: false };

  // --- drag di spostamento --------------------------------------------------
  // Ancora MONDO e posizione di partenza (MONDO) di ogni nodo trascinato,
  // catturate a pointerdown. Il gesto sullo store (beginGesture) viene aperto
  // in modo PIGRO al primo pointermove reale: un semplice click (down+up
  // senza move in mezzo) non deve mai aprire/chiudere un gesto a vuoto --
  // altrimenti ogni click su un nodo già selezionato spamerebbe un
  // beginGesture "misuso" nei test che testano solo onPointerDown (vedi
  // store.ts: beginGesture con un gesto già aperto avvisa e non annidano).
  //
  // `toLocal` è l'inversa della trasformazione del PARENT del nodo, fotografata
  // a pointerdown (durante un gesto nessuno riparenta): il puntatore si muove
  // nel MONDO, ma x/y del modello sono relative al parent, e per un nodo
  // annidato i due spostamenti non sono lo stesso numero. Finché i container
  // contribuiscono solo traslazioni la parte lineare è l'identità e i due
  // coincidono; il giorno della rotazione (altra traccia) è questa conversione
  // a evitare che trascinare un figlio di un container ruotato lo mandi di
  // traverso.
  let dragAnchor: { x: number; y: number } | null = null;
  let dragStart: Record<string, { x: number; y: number; toLocal: Transform }> | null = null;
  let dragStarted = false;
  // Lo SNAP del trascinamento, fotografato a pointerdown: il riquadro che la
  // selezione occupa (è LUI a scattare, non i singoli nodi -- altrimenti una
  // selezione multipla si sfalderebbe, ogni nodo tirato dalla propria guida) e i
  // rettangoli a cui può scattare. Calcolati una volta per gesto e non a ogni
  // pointermove: i bersagli non si muovono durante il trascinamento, e
  // ricalcolarli 60 volte al secondo vorrebbe dire rileggere tutta la scena.
  let dragBox: Bounds | null = null;
  let dragTargets: Bounds[] | null = null;

  // --- resize con le maniglie -------------------------------------------------
  // Stessa struttura del drag di spostamento: ancora MONDO + stato iniziale, e
  // apertura PIGRA del gesto al primo move vero (un click su una maniglia non
  // deve produrre nessun op). resizeStartBox è il bbox di GRUPPO a inizio
  // gesto: ogni nodo viene poi mappato con la stessa trasformazione, così una
  // selezione multipla scala (e si specchia) in blocco.
  //
  // Il bbox di gruppo è in coordinate MONDO (ci vivono le maniglie e il
  // puntatore), quindi anche i box di partenza dei singoli nodi lo sono:
  // mappare un box LOCALE con una trasformazione calcolata nel mondo darebbe
  // un rettangolo senza senso. Il ritorno al locale avviene alla fine, quando
  // si scrive nel modello -- vedi resizeOps.
  let resizeHandle: HandleId | null = null;
  let resizeAnchor: { x: number; y: number } | null = null;
  let resizeStartFrame: SelectionFrame | null = null;
  // Il box di partenza di ogni nodo in coordinate MONDO (la stessa in cui vive
  // il frame e il puntatore), il suo angolo, e `toLocal` per riscrivere il
  // risultato nello spazio del PARENT -- dove x/y/width/height vivono davvero.
  // world+toLocal (annidamento, T1) e rotation (T2) insieme: un nodo ruotato
  // dentro una selezione multipla non si mappa come gli altri (handles.ts::
  // applyFrameResizeToNode), e un ribaltamento gli cambia anche l'angolo.
  let resizeStartNodes:
    | Record<string, { bounds: Bounds; rotation: number; toLocal: Transform }>
    | null = null;
  // La GEOMETRIA di partenza dei soli nodi vettoriali selezionati (T4). Catturata
  // a pointerdown come i bounds e per lo stesso motivo: gli op di anteprima sono
  // assoluti e si ricalcolano sempre dallo stato iniziale.
  let resizeStartVectors: Record<string, SubPathLite[]> | null = null;
  let resizeStarted = false;
  // I bersagli dello snap per il ridimensionamento, fotografati come quelli del
  // trascinamento (stessa ragione).
  let resizeTargets: Bounds[] | null = null;

  // --- rotazione dalle zone d'angolo ------------------------------------------
  // Stessa forma degli altri due gesti (ancora + stato iniziale + apertura
  // PIGRA del gesto al primo move vero). L'ancora qui è ANGOLARE: l'angolo del
  // raggio centro->puntatore a pointerdown, da cui si misura il delta.
  //
  // rotateCenter è il centro del FRAME, che per una selezione multipla non è il
  // centro di nessun nodo: i nodi ruotano attorno a quello (i loro centri si
  // spostano) e ciascuno gira anche su sé stesso dello stesso delta -- cioè la
  // selezione ruota come un CORPO RIGIDO.
  let rotateCenter: { x: number; y: number } | null = null;
  let rotateStartAngle = 0;
  // L'angolo di riferimento a cui si applica lo scatto con Shift: quello del
  // PRIMO nodo selezionato. Scattare l'angolo di ciascun nodo separatamente
  // spezzerebbe la rigidità del gruppo (nodi con angoli iniziali diversi
  // convergerebbero); scattare il DELTA di un nodo solo non darebbe mai un
  // angolo tondo. Si scatta il totale del riferimento e si usa il delta che ne
  // risulta per tutti.
  let rotateRef = 0;
  let rotateStartNodes: Record<string, { bounds: Bounds; rotation: number }> | null = null;
  let rotateStarted = false;

  // --- marquee ---------------------------------------------------------------
  let marqueeAnchor: { x: number; y: number } | null = null;
  let marqueeBase: string[] | null = null;
  let preMarqueeSelection: string[] | null = null;

  // --- doppio click su un nodo testo -----------------------------------------
  let lastClick: { id: string; time: number } | null = null;

  // Id del nodo testo CANDIDATO all'editing: il secondo click entro soglia è
  // arrivato, ma la decisione è rinviata al rilascio. Il pointerdown da solo
  // non basta a dire "doppio click" -- un ri-click rapido che poi TRASCINA è un
  // normale spostamento, e deciderlo al down lo inghiottiva in una sessione di
  // editing lasciando il nodo inchiodato dov'era (stessa forma del marquee 0x0
  // curato in M1a: non impegnarsi finché non ci sono abbastanza prove).
  // Finché è valorizzato il drag è PREPARATO ma non avviato (dragStarted resta
  // false, nessun gesto aperto sullo store): a pointerup si apre l'editing, e
  // se invece il puntatore supera DOUBLE_CLICK_SLOP_PX il candidato cade e il
  // drag prosegue esattamente come un move qualunque -- delta calcolato da
  // dragAnchor, quindi anche i px "spesi" per superare la soglia contano.
  let pendingTextEdit: string | null = null;

  // Le guide vivono quanto il GESTO che le ha prodotte: si spengono dovunque un
  // gesto finisca -- rilascio, Esc, Canc, cambio tool -- perché tutte quelle
  // strade passano da un reset.
  function clearGuides() {
    useScene.getState().setSnapGuides([]);
  }

  function resetDrag() {
    dragAnchor = null;
    dragStart = null;
    dragStarted = false;
    dragBox = null;
    dragTargets = null;
    clearGuides();
  }

  function resetResize() {
    resizeHandle = null;
    resizeAnchor = null;
    resizeStartFrame = null;
    resizeStartNodes = null;
    resizeStartVectors = null;
    resizeStarted = false;
    resizeTargets = null;
    clearGuides();
  }

  function resetRotate() {
    rotateCenter = null;
    rotateStartAngle = 0;
    rotateRef = 0;
    rotateStartNodes = null;
    rotateStarted = false;
  }

  // --- LO SNAP, DENTRO IL GESTO ---------------------------------------------
  //
  // Lo scatto NON è un'altra modifica: corregge la posizione del puntatore
  // PRIMA che il gesto la usi, quindi entra nell'anteprima e nell'op finale
  // esattamente allo stesso modo. Il gesto resta uno, l'op resta uno per nodo,
  // la voce di undo resta una. È il punto in cui l'implementazione poteva
  // sbandare: uno snap applicato "dopo" avrebbe voluto un op suo.
  //
  // ALT lo spegne per quel gesto: è la convenzione, e senza una via d'uscita un
  // nodo diventerebbe impossibile da posare a 2 px da un altro.

  // Il delta del TRASCINAMENTO, scatto compreso. Il riquadro della selezione
  // viene spostato del delta grezzo e lì gli si chiede lo scatto: sono le sue
  // sei linee (bordi e centri, su entrambi gli assi) a competere.
  function dragDelta(e: PointerEvent, ctx: ToolContext, mods: Mods): { dx: number; dy: number; guides: SnapGuide[] } {
    const world = ctx.toWorld(e);
    const dx = world.x - dragAnchor!.x;
    const dy = world.y - dragAnchor!.y;
    if (mods.alt || !dragBox || !dragTargets || dragTargets.length === 0) return { dx, dy, guides: [] };
    const moved = { ...dragBox, x: dragBox.x + dx, y: dragBox.y + dy };
    const s = snapBounds(moved, dragTargets, worldThreshold(ctx.getCamera()));
    return { dx: dx + s.dx, dy: dy + s.dy, guides: s.guides };
  }

  // Il delta del RIDIMENSIONAMENTO, scatto compreso. Tre casi in cui lo snap si
  // fa da parte, e nessuno dei tre è una rinuncia per pigrizia:
  //
  //  - ALT: disattivazione esplicita, come nel trascinamento.
  //  - SHIFT: l'utente ha chiesto il RAPPORTO D'ASPETTO, che è un vincolo più
  //    forte -- far scattare un asse romperebbe l'altro, cioè disobbedirebbe
  //    all'unica cosa che ha chiesto a voce alta.
  //  - FRAME RUOTATO: i suoi bordi non sono rette dello schermo, e una guida
  //    che non è una retta dello schermo non allinea niente (vedi la scelta
  //    dichiarata in selection/snap.ts). I bersagli restano AABB anche per i
  //    nodi ruotati; è il riquadro che si sta TIRANDO a dover essere dritto.
  //
  // Correggere il delta del puntatore (invece del risultato) è ciò che tiene lo
  // scatto dentro la matematica esistente: resizeFrame resta l'unica a
  // calcolare il resize, flip e ancora compresi.
  function resizeDelta(e: PointerEvent, ctx: ToolContext, mods: Mods): { dx: number; dy: number; guides: SnapGuide[] } {
    const world = ctx.toWorld(e);
    const dx = world.x - resizeAnchor!.x;
    const dy = world.y - resizeAnchor!.y;
    const frame = resizeStartFrame;
    if (
      mods.alt || mods.shift || !frame || !resizeHandle
      || !resizeTargets || resizeTargets.length === 0
      || frame.rotation % 360 !== 0
    ) {
      return { dx, dy, guides: [] };
    }
    const r = resizeFrame(frame, resizeHandle, dx, dy);
    const box = applyFrameResize(frame.bounds, r);
    const lines = movingEdgeLines(box, resizeHandle);
    // RIBALTAMENTO in corso: il bordo mobile ha superato l'ancora, quindi in
    // `box` (normalizzato) il minimo e il massimo si sono scambiati e
    // movingEdgeLines starebbe indicando il bordo FERMO. Su quell'asse non si
    // scatta: farlo sposterebbe l'ancora, cioè l'unico punto che il resize
    // promette di non muovere.
    if (r.transform.signedW < 0) lines.x = [];
    if (r.transform.signedH < 0) lines.y = [];
    const s = snapMoving(box, lines, resizeTargets, worldThreshold(ctx.getCamera()));
    return { dx: dx + s.dx, dy: dy + s.dy, guides: s.guides };
  }

  // Gli op del resize per la posizione corrente del puntatore, ricalcolati
  // SEMPRE dai bounds iniziali (mai dal delta dell'ultimo move): niente
  // accumulo di errori, e l'op finale è identico all'ultima anteprima.
  function resizeOps(e: PointerEvent, ctx: ToolContext, mods: Mods): { ops: Op[]; guides: SnapGuide[] } {
    if (!resizeHandle || !resizeAnchor || !resizeStartFrame || !resizeStartNodes) {
      return { ops: [], guides: [] };
    }
    const { dx, dy, guides } = resizeDelta(e, ctx, mods);
    // resizeFrame porta il delta del puntatore nello spazio LOCALE del frame
    // (così la maniglia e allarga il nodo lungo il SUO asse, comunque sia
    // girato) e calcola l'offset che tiene l'ancora ferma nel MONDO. La
    // matematica del resize -- flip e keepAspect compresi -- resta quella di
    // resizeTransform, invariata: qui la si avvolge, non la si riscrive.
    const r = resizeFrame(resizeStartFrame, resizeHandle, dx, dy, { keepAspect: mods.shift });
    const ops: Op[] = [];
    for (const [id, start] of Object.entries(resizeStartNodes)) {
      const next = applyFrameResizeToNode(start.bounds, start.rotation, r);
      // Il conto avviene nel MONDO (dove sta il frame), poi il box torna nello
      // spazio del PARENT prima di finire in un op (T1 annidamento): nel modello
      // x/y/width/height sono relative al parent, e scriverci un box mondo
      // sposterebbe un nodo annidato del passo del suo container. Per un nodo
      // figlio di una pagina toLocal è l'identità e localBounds === next.bounds.
      const localBounds = mapBounds(start.toLocal, next.bounds);
      // L'angolo entra nella mask SOLO quando cambia davvero (un nodo allineato
      // al frame -- il caso normale -- manda esattamente l'op di prima). Cambia
      // quando una scala non uniforme o un ribaltamento girano gli assi del
      // nodo: senza spedirlo, il nodo si vedrebbe con la forma nuova e l'angolo
      // vecchio, cioè fuori dal riquadro.
      ops.push(
        next.rotation === start.rotation
          ? makeSetPropsOp(id, localBounds, ["x", "y", "width", "height"])
          : makeSetPropsOp(
              id,
              { ...localBounds, rotation: next.rotation },
              ["x", "y", "width", "height", "rotation"],
            ),
      );
      // Un nodo VETTORIALE porta la sua geometria dentro lo STESSO gesto: gli
      // ancoraggi sono lunghezze in coordinate locali, non frazioni del box,
      // quindi senza questo secondo op il box crescerebbe e l'inchiostro
      // resterebbe della sua misura -- violando l'invariante del proto (dopo un
      // SetVectorPath la bbox locale della geometria è (0,0)-(width,height)). La
      // scala viene dalla trasformazione di gruppo (r.transform), la stessa che
      // ha appena mappato il box; in anteprima le due chiavi di coalescing
      // (`s|id|...` e `v|id`, vedi store.ts::previewKey) non si schiacciano a
      // vicenda, ed è un'unica voce di undo.
      const start0 = resizeStartVectors?.[id];
      if (!start0) continue;
      // resizeVector misura gli ancoraggi contro il box nello spazio LOCALE del
      // nodo (gli ancoraggi sono locali). Per un figlio di pagina è identico al
      // box mondo; per un nodo annidato lo si riporta in locale come sopra.
      const localStart = mapBounds(start.toLocal, start.bounds);
      ops.push(makeSetVectorPathOp(id, resizeVector(
        start0,
        localStart,
        { signed: r.transform.signedW, start: r.transform.startW },
        { signed: r.transform.signedH, start: r.transform.startH },
      )));
    }
    return { ops, guides };
  }

  // Gli op del TRASCINAMENTO per la posizione corrente del puntatore. Come il
  // resize: ricalcolati dallo stato iniziale, mai dall'ultimo delta.
  function dragOps(e: PointerEvent, ctx: ToolContext, mods: Mods): { ops: Op[]; guides: SnapGuide[] } {
    if (!dragAnchor || !dragStart) return { ops: [], guides: [] };
    const { dx, dy, guides } = dragDelta(e, ctx, mods);
    const ops = Object.entries(dragStart).map(([id, start]) => {
      // Lo spostamento (mondo, scatto compreso) passa per la sola parte LINEARE
      // della trasformazione del parent (mapVector): è un delta, non un punto,
      // quindi la traslazione del container non lo tocca. Per un figlio di pagina
      // toLocal è l'identità e (d.x, d.y) === (dx, dy).
      const d = mapVector(start.toLocal, dx, dy);
      return makeSetPropsOp(id, { x: start.x + d.x, y: start.y + d.y }, ["x", "y"]);
    });
    return { ops, guides };
  }

  // Gli op della rotazione per la posizione corrente del puntatore. Come il
  // resize: SEMPRE ricalcolati dallo stato iniziale, mai dall'ultimo delta.
  function rotateOps(e: PointerEvent, ctx: ToolContext, mods: Mods): Op[] {
    if (!rotateCenter || !rotateStartNodes) return [];
    const world = ctx.toWorld(e);
    const raw = angleOf(rotateCenter, world) - rotateStartAngle;
    // Con Shift lo scatto è sul TOTALE del riferimento, non sul delta: si
    // ottiene un angolo tondo (0, 15, 30...) invece di uno spostamento tondo a
    // partire da un angolo qualsiasi.
    const delta = mods.shift ? snapDegrees(rotateRef + raw, ROTATE_SNAP_DEG) - rotateRef : raw;
    return Object.entries(rotateStartNodes).map(([id, start]) => {
      // Il centro del nodo gira attorno a quello del frame (per una selezione
      // singola i due coincidono e questo è l'identità esatta), e il nodo gira
      // su sé stesso dello stesso delta: insieme, una rotazione rigida.
      const c = rotateAround(centerOf(start.bounds), rotateCenter!, delta);
      return makeSetPropsOp(id, {
        x: c.x - start.bounds.width / 2,
        y: c.y - start.bounds.height / 2,
        rotation: normalizeDegrees(start.rotation + delta),
      }, ["x", "y", "rotation"]);
    });
  }

  function resetMarquee() {
    marqueeAnchor = null;
    marqueeBase = null;
    preMarqueeSelection = null;
    useScene.getState().setMarquee(null);
  }

  // Abbandona QUALUNQUE gesto locale in corso (spostamento, marquee o resize),
  // riportando sia lo store sia lo stato del tool al punto di partenza -- senza
  // mandare nulla sul filo. Condivisa da Esc, Delete/Backspace e onDeactivate:
  // tutti e tre i punti in cui il tool deve poter "staccarsi" pulito da un
  // gesto a metà. Cruciale per Delete/Backspace in particolare -- senza questo
  // richiamo PRIMA di cancellare, un Delete premuto a metà drag chiuderebbe il
  // gesto dello STORE (via il proprio beginGesture/endGesture per la
  // cancellazione) ma lascerebbe dragAnchor/dragStart/dragStarted del tool
  // stale: il successivo pointerup li troverebbe ancora validi e chiamerebbe
  // endGesture() una seconda volta SENZA gesto aperto, che (mis)uso previsto
  // da store.ts) manda comunque sul filo un setProps fasullo per un nodo ormai
  // cancellato.
  function cancelActiveGesture() {
    // Anche il candidato all'editing è "gesto in corso": senza azzerarlo, il
    // pointerup che arriva comunque dopo Esc/Delete aprirebbe una sessione di
    // editing in ritardo (su un nodo che Delete può pure aver cancellato).
    pendingTextEdit = null;
    if (marqueeAnchor) {
      useScene.getState().setSelection(preMarqueeSelection ?? []);
      resetMarquee();
    }
    if (dragAnchor) {
      if (dragStarted) useScene.getState().cancelGesture();
      resetDrag();
    }
    if (resizeHandle) {
      if (resizeStarted) useScene.getState().cancelGesture();
      resetResize();
    }
    if (rotateCenter) {
      if (rotateStarted) useScene.getState().cancelGesture();
      resetRotate();
    }
  }

  return {
    id: "select",
    cursor: "default",

    onPointerDown(e, ctx) {
      const scene = ctx.getScene();
      if (!scene) return;
      // Il latch riparte dal gesto che sta per iniziare, così non porta dentro
      // i modificatori di un hover o di un gesto precedente. (Non basta da solo
      // a decidere niente: senza almeno un pointermove nessun gesto si apre.)
      lastMods = modsOf(e);
      const world = ctx.toWorld(e);
      const store = useScene.getState();
      // Ogni nuovo pointerdown riparte senza candidati: un down non risolto (un
      // secondo dito, un up mai arrivato) non deve poter aprire l'editing molto
      // dopo. Prima delle maniglie, che escono dal metodo per la loro strada.
      pendingTextEdit = null;

      // Le maniglie hanno PRIORITÀ sui nodi: la maniglia se di un rettangolo
      // cade dentro (o sul bordo di) il rettangolo stesso, e quelle esterne
      // cadono sul vuoto -- senza priorità un pointerdown lì lo sposterebbe o
      // farebbe partire un marquee azzerando la selezione.
      const overlay = frameUnderPointer(ctx, world);
      if (overlay?.kind === "resize") {
        // Un op per nodo PIÙ IN ALTO con i GRUPPI ESPANSI nei figli
        // (transformTargetsOf ∘ topmostOf, T1): un gruppo non ha un box proprio
        // da riscrivere -- ridimensionarlo è ridimensionare il contenuto -- e un
        // discendente selezionato col suo container si trasformerebbe due volte,
        // perché trasformare il container trasforma già il figlio. Il bbox di
        // GRUPPO resta invece quello dell'INTERA selezione (frameOfSelection),
        // su cui l'overlay ha disegnato le maniglie appena afferrate.
        const start: Record<string, { bounds: Bounds; rotation: number; toLocal: Transform }> = {};
        // La geometria di partenza dei soli nodi vettoriali (T4): serve a
        // resizeOps per scalare gli ancoraggi insieme al box.
        const startVectors: Record<string, SubPathLite[]> = {};
        for (const sid of transformTargetsOf(scene, topmostOf(scene, store.selection))) {
          const n = scene.nodes[sid];
          if (!n) continue;
          // bounds in MONDO (come il frame e il puntatore) + toLocal per tornare
          // in parent-local quando si scrive l'op -- vedi resizeStartNodes.
          start[sid] = {
            bounds: worldBoundsOfNode(scene, n),
            rotation: n.rotation,
            toLocal: parentToLocal(scene, n.parentId),
          };
          if (n.kind === "vector" && n.vector) startVectors[sid] = n.vector.subpaths;
        }
        resizeHandle = overlay.handle;
        resizeAnchor = world;
        resizeStartFrame = frameOfSelection(ctx);
        resizeStartNodes = start;
        resizeStartVectors = startVectors;
        resizeTargets = snapTargets(scene, snapExclude(scene, store.selection));
        resizeStarted = false;
        setCursor(ctx, cursorForHandle(overlay.handle));
        return;
      }
      // La ROTAZIONE, dalla zona appena fuori dall'angolo. Ha la stessa
      // priorità delle maniglie sul nodo sotto il puntatore (in realtà cade
      // sempre sul vuoto attorno alla selezione: senza questo ramo un
      // pointerdown lì aprirebbe un marquee azzerando la selezione).
      if (overlay?.kind === "rotate") {
        const frame = frameOfSelection(ctx);
        if (frame) {
          const start: Record<string, { bounds: Bounds; rotation: number }> = {};
          for (const sid of store.selection) {
            const n = scene.nodes[sid];
            if (n) start[sid] = { bounds: boundsOfNode(n), rotation: n.rotation };
          }
          rotateCenter = centerOf(frame.bounds);
          rotateStartAngle = angleOf(rotateCenter, world);
          rotateRef = scene.nodes[store.selection[0]]?.rotation ?? 0;
          rotateStartNodes = start;
          rotateStarted = false;
          setCursor(ctx, ROTATING_CURSOR);
          return;
        }
      }

      // Doppio click su un nodo TESTO: entra in editing invece di iniziare un
      // drag (Task 4, step 3). Rilevato per ID + e.timeStamp: ricalcola
      // hitTest invece di leggerlo da pickTarget qui sotto, che per un nodo
      // GIÀ selezionato non lo restituisce (pickTarget ritorna "single" senza
      // id apposta, vedi il suo commento) -- e qui serve SEMPRE, selezionato o
      // no. Shift-click resta riservato al toggle multi-selezione, non a
      // questo: uno shift+doppio click non fa nulla di speciale.
      //
      // Il secondo click segna solo un CANDIDATO (pendingTextEdit) e prosegue:
      // selezione e drag si preparano come per un click qualunque, così se il
      // puntatore si muove il gesto è già armato e lo spostamento parte da
      // questo stesso down. Chi decide è il rilascio (onPointerUp), non il down.
      const zoom = ctx.getCamera().zoom;
      const hitId = hitTest(scene, world.x, world.y, zoom, store.currentPageId);
      if (hitId && !e.shiftKey) {
        const isDoubleClick =
          lastClick !== null &&
          lastClick.id === hitId &&
          e.timeStamp - lastClick.time <= DOUBLE_CLICK_MS;
        if (isDoubleClick) {
          // lastClick azzerato: un terzo click non incatena un altro doppio.
          lastClick = null;
          // I due significati del doppio click stanno IN FILA, non in
          // concorrenza: prima si ENTRA nei gruppi (un livello per doppio
          // click, vedi store/groups.ts::enterTargetOf), e solo quando non c'è
          // più niente in cui entrare il doppio click torna a essere quello
          // del testo. Su un testo dentro un gruppo servono quindi due doppi
          // click: il primo entra, il secondo scrive -- che è anche l'ordine
          // in cui l'utente li pensa.
          const enter = enterTargetOf(scene, hitId, store.selection);
          if (enter) {
            // SUBITO, non a pointerup: il drag preparato qui sotto deve agire
            // sul nodo in cui si è appena entrati (doppio click e trascina
            // sposta il figlio, non il gruppo).
            store.setSelection([enter]);
          } else if (scene.nodes[hitId]?.kind === "text") {
            pendingTextEdit = hitId;
          }
        } else {
          lastClick = { id: hitId, time: e.timeStamp };
        }
      } else {
        lastClick = null;
      }

      // Selezione LETTA ADESSO e non da `store`: entrare in un gruppo (qui
      // sopra) l'ha appena cambiata, e `store` è la fotografia di prima. `zoom`
      // (T4) e currentPageId (T1) entrambi, come in hitTest qui sopra.
      const target = pickTarget(scene, world, e.shiftKey, useScene.getState().selection, zoom, store.currentPageId);

      if (target.mode === "marquee") {
        // shift+click sul vuoto non azzera: è l'inizio di un'aggiunta (unione
        // con la selezione corrente a pointerup).
        const base = e.shiftKey ? store.selection : [];
        preMarqueeSelection = store.selection;
        if (!e.shiftKey) store.clearSelection();
        marqueeBase = base;
        marqueeAnchor = world;
        store.setMarquee({ x: world.x, y: world.y, width: 0, height: 0 });
        return;
      }

      if (target.mode === "toggle") store.toggleSelection(target.id);
      else if (target.id) store.setSelection([target.id]);
      // target.mode === "single" senza id: nodo già selezionato, nessun
      // cambio -- il drag qui sotto userà la selezione (multipla) esistente.

      // topmostOf come nel resize qui sopra (e nella cancellazione): un
      // discendente si sposta GIÀ perché si sposta il suo container, quindi un
      // op suo lo porterebbe a 2*delta dal punto di partenza.
      const selection = useScene.getState().selection;
      const start: Record<string, { x: number; y: number; toLocal: Transform }> = {};
      for (const sid of topmostOf(scene, selection)) {
        const n = scene.nodes[sid];
        if (n) start[sid] = { x: n.x, y: n.y, toLocal: parentToLocal(scene, n.parentId) };
      }
      dragAnchor = world;
      dragStart = start;
      dragStarted = false;
      // È il RIQUADRO della selezione a scattare, non i singoli nodi: con una
      // selezione multipla ogni nodo tirato dalla propria guida la sfalderebbe.
      dragBox = selectionWorldBounds(scene, selection);
      dragTargets = snapTargets(scene, snapExclude(scene, selection));
    },

    onPointerMove(e, ctx) {
      // Ogni anteprima LATCHA i suoi modificatori: è questa coppia, e non
      // quella del pointerup, che l'op finale userà (vedi lastMods).
      lastMods = modsOf(e);
      if (rotateCenter) {
        setCursor(ctx, ROTATING_CURSOR);
        if (!rotateStarted) {
          rotateStarted = true;
          useScene.getState().beginGesture();
        }
        for (const op of rotateOps(e, ctx, lastMods)) useScene.getState().applyLocal(op);
        return;
      }
      if (resizeHandle) {
        // Il cursore resta quello della maniglia afferrata per tutto il drag,
        // anche quando il puntatore si allontana da dove stava la maniglia.
        setCursor(ctx, cursorForHandle(resizeHandle));
        if (!resizeStarted) {
          resizeStarted = true;
          useScene.getState().beginGesture();
        }
        const step = resizeOps(e, ctx, lastMods);
        useScene.getState().setSnapGuides(step.guides);
        for (const op of step.ops) useScene.getState().applyLocal(op);
        return;
      }
      if (marqueeAnchor) {
        const world = ctx.toWorld(e);
        useScene.getState().setMarquee(normalizeRect(marqueeAnchor.x, marqueeAnchor.y, world.x, world.y));
        return;
      }
      if (!dragAnchor || !dragStart) {
        // Nessun gesto in corso: è un semplice hover. Il cursore anticipa quel
        // che si può afferrare sotto il puntatore -- maniglia di resize o zona
        // di rotazione (step 4 del brief, esteso alla rotazione).
        const hover = frameUnderPointer(ctx, ctx.toWorld(e));
        setCursor(ctx, hover ? cursorForFrameHit(hover) : DEFAULT_CURSOR);
        return;
      }
      if (pendingTextEdit) {
        // px schermo -> unità mondo, così la soglia non dipende dallo zoom
        // (stessa conversione della soglia di click del marquee).
        const p = ctx.toWorld(e);
        const slop = DOUBLE_CLICK_SLOP_PX / ctx.getCamera().zoom;
        if (Math.abs(p.x - dragAnchor.x) < slop && Math.abs(p.y - dragAnchor.y) < slop) {
          return; // tremolio: resta un doppio click, nessun gesto aperto
        }
        pendingTextEdit = null; // soglia superata: da qui è un drag come un altro
      }
      if (!dragStarted) {
        dragStarted = true;
        useScene.getState().beginGesture();
      }
      const step = dragOps(e, ctx, lastMods);
      useScene.getState().setSnapGuides(step.guides);
      for (const op of step.ops) useScene.getState().applyLocal(op);
    },

    // POSIZIONE dall'evento di rilascio, MODIFICATORI dall'ultima anteprima
    // (lastMods): si commette ciò che si è visto. Vedi il commento su lastMods
    // per il motivo -- leggere e.altKey qui fa scattare al commit un gesto che
    // l'utente aveva tenuto libero per tutto il tempo.
    onPointerUp(e, ctx) {
      if (rotateCenter) {
        if (rotateStarted) useScene.getState().endGesture(rotateOps(e, ctx, lastMods));
        resetRotate();
        return;
      }
      if (resizeHandle) {
        if (resizeStarted) useScene.getState().endGesture(resizeOps(e, ctx, lastMods).ops);
        resetResize();
        return;
      }
      if (marqueeAnchor) {
        const scene = ctx.getScene();
        const world = ctx.toWorld(e);
        const box = normalizeRect(marqueeAnchor.x, marqueeAnchor.y, world.x, world.y);
        // px schermo -> unità mondo, così la soglia non dipende dallo zoom.
        const slop = MARQUEE_SLOP_PX / ctx.getCamera().zoom;
        const isClick = box.width < slop && box.height < slop;
        // Stessa politica del click (store/groups.ts): la banda elastica
        // seleziona il gruppo, non i suoi figli -- altrimenti sarebbe l'unico
        // modo per prendere il contenuto di un gruppo senza entrarci. Il
        // contesto è la selezione PRE-marquee: quella corrente è stata
        // azzerata a pointerdown.
        const inside =
          scene && !isClick
            ? selectionTargetsOf(scene, nodesInMarquee(scene, box, useScene.getState().currentPageId), preMarqueeSelection ?? [])
            : [];
        useScene.getState().setSelection(union(marqueeBase ?? [], inside));
        resetMarquee();
        return;
      }
      // Il secondo click è arrivato al rilascio senza superare la soglia: ORA
      // è un doppio click, e apre l'editing. dragStarted è false per
      // costruzione (onPointerMove non apre nessun gesto finché il candidato è
      // vivo), quindi non c'è niente da chiudere né da mandare sul filo.
      if (pendingTextEdit) {
        const id = pendingTextEdit;
        pendingTextEdit = null;
        resetDrag();
        const store = useScene.getState();
        store.setSelection([id]);
        store.beginTextEditing(id);
        return; // la sessione di editing (Task 5) prende da qui
      }
      if (!dragAnchor || !dragStart) return;
      // Gli op finali portano la posizione SCATTATA, la stessa dell'ultima
      // anteprima: lo snap corregge il delta, non aggiunge un secondo op.
      if (dragStarted) useScene.getState().endGesture(dragOps(e, ctx, lastMods).ops);
      resetDrag();
    },

    onKeyDown(e) {
      if (e.key === "Escape") {
        cancelActiveGesture();
        return;
      }
      // Ctrl/Cmd+G raggruppa la selezione, Ctrl/Cmd+Shift+G la separa. Un
      // GESTO ciascuno: gli op (createNode + N reparentNode, oppure N
      // reparentNode + deleteNode) vanno tutti in un solo endGesture, quindi un
      // solo invio in rete e UNA voce di undo -- un Ctrl+Z disfa il
      // raggruppamento intero, non l'ultimo figlio riparentato.
      //
      // Sul tool e non sulla finestra come undo/redo (ui/App.tsx): raggruppare
      // è un'operazione sulla SELEZIONE, cioè roba di questo tool, esattamente
      // come Delete qui sotto -- e toolManager filtra già i tasti quando il
      // fuoco è in un campo di testo.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "g") {
        // Sempre preventDefault: in un browser Ctrl+G è "trova successivo".
        e.preventDefault();
        // Un drag o un marquee a metà vanno abbandonati PRIMA, per la stessa
        // ragione di Delete qui sotto: un gesto aperto ne renderebbe un altro
        // annidato (beginGesture avvisa e tiene il primo) e il pointerup
        // successivo troverebbe uno stato del tool ormai stale.
        cancelActiveGesture();
        const store = useScene.getState();
        const scene = store.scene;
        if (!scene) return;
        const res = e.shiftKey ? ungroupOps(scene, store.selection) : groupOps(scene, store.selection);
        // Niente da raggruppare (selezione vuota) o niente da separare (nessun
        // gruppo selezionato): nessun gesto, nessun op, nessuna voce di undo.
        if (!res) return;
        store.beginGesture();
        // La selezione voluta PRIMA di chiudere: endGesture la riconcilia
        // contro la scena finale, quindi può già nominare il gruppo che gli op
        // stanno per creare.
        store.setSelection(res.selection);
        store.endGesture(res.ops);
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        // Un drag o un marquee possono essere a metà (pulsante ancora premuto)
        // quando arriva il tasto: vanno abbandonati PRIMA di cancellare, così
        // dragAnchor/dragStart/dragStarted (o marqueeAnchor) non restano stale
        // e il pointerup che arriverà comunque dopo non trova nulla da fare
        // (vedi commento su cancelActiveGesture più sopra).
        cancelActiveGesture();
        const store = useScene.getState();
        const scene = store.scene;
        if (!scene) return;
        // Un op per nodo TOPMOST, non per id selezionato: deleteNode cascata
        // sul sottoalbero, quindi un figlio selezionato insieme al suo gruppo
        // è già sparito quando il suo op arriva. Vedi topmostOf -- senza la
        // potatura il secondo op viene rifiutato dal server E l'intero gesto
        // resta senza voce di undo.
        const ids = topmostOf(scene, store.selection);
        if (ids.length === 0) return;
        store.beginGesture();
        store.endGesture(ids.map((id) => makeDeleteOp(id)));
      }
    },

    // Gesto abbandonato (cambio tool, pointercancel, smontaggio): nessun op.
    onDeactivate() {
      cancelActiveGesture();
    },
  };
}

export const selectTool = createSelectTool();
