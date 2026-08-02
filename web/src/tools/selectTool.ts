import { hitTest, nodesIntersecting } from "../renderer/canvasRenderer";
import { normalizeRect, type Bounds } from "../canvas/geometry";
import {
  type Transform,
  invertTransform,
  mapBounds,
  mapVector,
  worldBoundsOfNode,
  worldTransformOf,
} from "../canvas/transform";
import { worldToScreen } from "../canvas/camera";
import { selectionWorldBounds } from "../renderer/overlayRenderer";
import {
  cursorForHandle,
  hitTestHandle,
  resizeTransform,
  transformBounds,
  type HandleId,
} from "../selection/handles";
import { useScene } from "../store/store";
import { enterTargetOf, selectionTargetOf, selectionTargetsOf, transformTargetsOf } from "../store/groups";
import { topmostOf } from "../store/tree";
import { groupOps, ungroupOps } from "./grouping";
import { makeDeleteOp, makeSetPropsOp } from "./ops";
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
function handleUnderPointer(ctx: ToolContext, world: { x: number; y: number }): HandleId | null {
  const scene = ctx.getScene();
  if (!scene) return null;
  const box = selectionWorldBounds(scene, useScene.getState().selection);
  if (!box) return null;
  const cam = ctx.getCamera();
  const p = worldToScreen(cam, world.x, world.y);
  return hitTestHandle(box, cam, p.x, p.y);
}

// Dal MONDO allo spazio in cui sono scritte le coordinate di un nodo, cioè lo
// spazio locale del suo parent. È la conversione che ogni gesto deve fare
// prima di scrivere nel modello: il puntatore parla mondo, il documento parla
// relativo al parent. Per un nodo figlio di una pagina è l'identità -- ed è
// per questo che un documento già esistente non si muove di un pixel.
function parentToLocal(scene: SceneState, parentId: string): Transform {
  return invertTransform(worldTransformOf(scene, parentId));
}

export type PickResult =
  | { mode: "marquee" }
  | { mode: "single"; id?: string }
  | { mode: "toggle"; id: string };

// Decide il TIPO di gesto senza toccare lo store: pura funzione di scena +
// input, testabile senza DOM (Task 8, step 1). id assente in mode "single"
// significa "il nodo è già selezionato, non toccare la selezione" -- è la
// lettura di "selezione singola (SE NON GIÀ selezionato)" del brief: così un
// drag successivo sposta l'INTERA selezione (anche multipla) invece di
// collassarla prematuramente su un solo nodo.
export function pickTarget(
  scene: SceneState,
  world: { x: number; y: number },
  shiftKey: boolean,
  selection: string[],
): PickResult {
  const hit = hitTest(scene, world.x, world.y);
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
// dell'albero, sta in renderer/canvasRenderer.ts::nodesIntersecting -- la
// STESSA discesa di drawScene e hitTest. Non si può filtrare la mappa piatta
// leggendo solo `n.visible`: un flag proprio a true dentro un gruppo nascosto
// (o su un nodo orfano) selezionerebbe qualcosa che non è sullo schermo, e
// l'unica traccia visibile sarebbero cornice e maniglie sul vuoto -- seguite,
// al primo drag, da setProps per una geometria che l'utente non vede.
//
// L'ordine è quello dell'albero (container prima dei figli, fratelli per order
// key) e non un confronto piatto di order key: per una scena piatta sono la
// stessa lista, per una annidata solo il primo ha un significato.
export function nodesInMarquee(scene: SceneState, bounds: Bounds): string[] {
  return nodesIntersecting(scene, bounds);
}

function union(base: string[], extra: string[]): string[] {
  const seen = new Set(base);
  return [...base, ...extra.filter((id) => !seen.has(id))];
}

export function createSelectTool(): Tool {
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
  let resizeStartBox: Bounds | null = null;
  let resizeStartNodes: Record<string, { world: Bounds; toLocal: Transform }> | null = null;
  let resizeStarted = false;

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

  function resetDrag() {
    dragAnchor = null;
    dragStart = null;
    dragStarted = false;
  }

  function resetResize() {
    resizeHandle = null;
    resizeAnchor = null;
    resizeStartBox = null;
    resizeStartNodes = null;
    resizeStarted = false;
  }

  // Gli op del resize per la posizione corrente del puntatore, ricalcolati
  // SEMPRE dai bounds iniziali (mai dal delta dell'ultimo move): niente
  // accumulo di errori, e l'op finale è identico all'ultima anteprima.
  //
  // Il conto si fa tutto nel MONDO (è lì che sta il puntatore) e il risultato
  // torna nello spazio del parent PRIMA di finire in un op: nel documento le
  // coordinate sono relative al parent, e scriverci un box mondo sposterebbe
  // ogni nodo annidato del passo del suo container.
  function resizeOps(e: PointerEvent, ctx: ToolContext): Op[] {
    if (!resizeHandle || !resizeAnchor || !resizeStartBox || !resizeStartNodes) return [];
    const world = ctx.toWorld(e);
    const t = resizeTransform(
      resizeStartBox,
      resizeHandle,
      world.x - resizeAnchor.x,
      world.y - resizeAnchor.y,
      { keepAspect: e.shiftKey },
    );
    return Object.entries(resizeStartNodes).map(([id, start]) => {
      const b = mapBounds(start.toLocal, transformBounds(start.world, t));
      return makeSetPropsOp(id, b, ["x", "y", "width", "height"]);
    });
  }

  // Gli op dello spostamento per la posizione corrente del puntatore. Stessa
  // regola del resize: sempre dalle posizioni INIZIALI, mai dall'ultimo delta,
  // e un solo posto a produrli così l'anteprima di ogni move e l'op finale del
  // pointerup non possono divergere.
  function moveOps(e: PointerEvent, ctx: ToolContext): Op[] {
    if (!dragAnchor || !dragStart) return [];
    const world = ctx.toWorld(e);
    const dx = world.x - dragAnchor.x;
    const dy = world.y - dragAnchor.y;
    return Object.entries(dragStart).map(([id, start]) => {
      // Uno SPOSTAMENTO passa per la sola parte lineare (mapVector): non è un
      // punto, la traslazione del parent non lo tocca.
      const d = mapVector(start.toLocal, dx, dy);
      return makeSetPropsOp(id, { x: start.x + d.x, y: start.y + d.y }, ["x", "y"]);
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
  }

  return {
    id: "select",
    cursor: "default",

    onPointerDown(e, ctx) {
      const scene = ctx.getScene();
      if (!scene) return;
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
      const handle = handleUnderPointer(ctx, world);
      if (handle) {
        // Un op per nodo PIÙ IN ALTO, non per id selezionato -- stessa potatura
        // e stessa funzione della cancellazione (vedi onKeyDown), per una
        // ragione geometrica invece che di cascata: le coordinate di un figlio
        // sono relative al suo container, quindi trasformare il container
        // trasforma GIÀ il figlio. Dare un op anche al figlio lo trasforma due
        // volte: il suo box mondo viene riscalato dalla stessa t mentre
        // l'origine del container gli si sposta sotto, e il figlio scappa fuori
        // dal rettangolo che l'utente sta trascinando.
        //
        // Il bbox di GRUPPO resta invece quello dell'INTERA selezione: è il
        // rettangolo su cui l'overlay ha disegnato le maniglie che l'utente ha
        // appena afferrato, e t deve nascere esattamente da quello. Anche la
        // selezione resta intatta: il discendente è ancora selezionato (la
        // cornice lo comprende, i pannelli lo mostrano), solo non riceve un op.
        //
        // transformTargetsOf oltre alla potatura: un GRUPPO non ha un box
        // proprio da riscrivere (i suoi bounds sono l'unione dei figli), e la
        // sua trasformazione è una traslazione -- scrivergli width/height non
        // scalerebbe niente. Ridimensionare un gruppo è ridimensionare il suo
        // contenuto, quindi il gesto scende ai figli. Lo SPOSTAMENTO no: lì
        // basta il gruppo, perché la sua x/y trasla già tutti i figli.
        const start: Record<string, { world: Bounds; toLocal: Transform }> = {};
        for (const sid of transformTargetsOf(scene, topmostOf(scene, store.selection))) {
          const n = scene.nodes[sid];
          if (n) start[sid] = { world: worldBoundsOfNode(scene, n), toLocal: parentToLocal(scene, n.parentId) };
        }
        resizeHandle = handle;
        resizeAnchor = world;
        resizeStartBox = selectionWorldBounds(scene, store.selection);
        resizeStartNodes = start;
        resizeStarted = false;
        setCursor(ctx, cursorForHandle(handle));
        return;
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
      const hitId = hitTest(scene, world.x, world.y);
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
      // sopra) l'ha appena cambiata, e `store` è la fotografia di prima.
      const target = pickTarget(scene, world, e.shiftKey, useScene.getState().selection);

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
    },

    onPointerMove(e, ctx) {
      if (resizeHandle) {
        // Il cursore resta quello della maniglia afferrata per tutto il drag,
        // anche quando il puntatore si allontana da dove stava la maniglia.
        setCursor(ctx, cursorForHandle(resizeHandle));
        if (!resizeStarted) {
          resizeStarted = true;
          useScene.getState().beginGesture();
        }
        for (const op of resizeOps(e, ctx)) useScene.getState().applyLocal(op);
        return;
      }
      if (marqueeAnchor) {
        const world = ctx.toWorld(e);
        useScene.getState().setMarquee(normalizeRect(marqueeAnchor.x, marqueeAnchor.y, world.x, world.y));
        return;
      }
      if (!dragAnchor || !dragStart) {
        // Nessun gesto in corso: è un semplice hover. Il cursore anticipa la
        // maniglia afferrabile sotto il puntatore (step 4 del brief).
        const hover = handleUnderPointer(ctx, ctx.toWorld(e));
        setCursor(ctx, hover ? cursorForHandle(hover) : DEFAULT_CURSOR);
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
      for (const op of moveOps(e, ctx)) useScene.getState().applyLocal(op);
    },

    onPointerUp(e, ctx) {
      if (resizeHandle) {
        if (resizeStarted) useScene.getState().endGesture(resizeOps(e, ctx));
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
            ? selectionTargetsOf(scene, nodesInMarquee(scene, box), preMarqueeSelection ?? [])
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
      if (dragStarted) useScene.getState().endGesture(moveOps(e, ctx));
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
