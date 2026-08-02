import { hitTest } from "../renderer/canvasRenderer";
import { selectionBoundsOfNode, hasInk } from "../renderer/shapes";
import { normalizeRect, boundsOfNode, boundsIntersect, type Bounds } from "../canvas/geometry";
import { worldToScreen } from "../canvas/camera";
import { selectionWorldBounds } from "../renderer/overlayRenderer";
import { resizeVector } from "../store/vectorGeometry";
import type { SubPathLite } from "../store/types";
import {
  cursorForHandle,
  hitTestHandle,
  resizeTransform,
  transformBounds,
  type HandleId,
} from "../selection/handles";
import { useScene } from "../store/store";
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
): PickResult {
  const id = hitTest(scene, world.x, world.y, zoom);
  if (!id) return { mode: "marquee" };
  if (shiftKey) return { mode: "toggle", id };
  return selection.includes(id) ? { mode: "single" } : { mode: "single", id };
}

// Id dei nodi VISIBILI i cui bounds intersecano il marquee, ordinati per
// orderKey per un risultato deterministico (Object.values non garantisce
// l'ordine di inserimento per chiavi stringa).
// Il box è quello di SELEZIONE (renderer/shapes.ts), non quello grezzo del
// modello. NON è lo stesso bersaglio del click: hitTest colpisce l'inchiostro
// del path e misura la presa in px SCHERMO, mentre qui si confrontano bounds in
// coordinate MONDO e la camera non c'è. Le due porte non possono coincidere, ma
// devono concordare sui due estremi, ed è quello che fanno le due condizioni
// qui sotto:
//   - `hasInk`: un vettoriale senza NESSUN ancoraggio non si vede e non si
//     clicca, quindi non deve nemmeno finire in un marquee -- altrimenti
//     resterebbe l'unica porta verso un nodo invisibile, e selezionerebbe il
//     nulla per sorpresa;
//   - `selectionBoundsOfNode`: un vettoriale il cui box ha legittimamente un
//     lato a zero (un segmento orizzontale, un path di un solo ancoraggio) si
//     vede e si clicca eccome, ma con il box grezzo un marquee lo prenderebbe
//     solo SCAVALCANDOLO in senso stretto -- passargli accanto non basterebbe.
export function nodesInMarquee(scene: SceneState, bounds: Bounds): string[] {
  return Object.values(scene.nodes)
    .filter((n) => n.visible && hasInk(n) && boundsIntersect(selectionBoundsOfNode(n), bounds))
    .sort((a, b) => (a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : 0))
    .map((n) => n.id);
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
  let dragAnchor: { x: number; y: number } | null = null;
  let dragStart: Record<string, { x: number; y: number }> | null = null;
  let dragStarted = false;

  // --- resize con le maniglie -------------------------------------------------
  // Stessa struttura del drag di spostamento: ancora MONDO + stato iniziale, e
  // apertura PIGRA del gesto al primo move vero (un click su una maniglia non
  // deve produrre nessun op). resizeStartBox è il bbox di GRUPPO a inizio
  // gesto: ogni nodo viene poi mappato con la stessa trasformazione, così una
  // selezione multipla scala (e si specchia) in blocco.
  let resizeHandle: HandleId | null = null;
  let resizeAnchor: { x: number; y: number } | null = null;
  let resizeStartBox: Bounds | null = null;
  let resizeStartNodes: Record<string, Bounds> | null = null;
  // La GEOMETRIA di partenza dei soli nodi vettoriali selezionati. Catturata a
  // pointerdown come i bounds e per lo stesso motivo: gli op di anteprima sono
  // assoluti e si ricalcolano sempre dallo stato iniziale, mai dall'ultima
  // anteprima -- che, applicata in locale, è già la geometria scalata.
  let resizeStartVectors: Record<string, SubPathLite[]> | null = null;
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
    resizeStartVectors = null;
    resizeStarted = false;
  }

  // Gli op del resize per la posizione corrente del puntatore, ricalcolati
  // SEMPRE dai bounds iniziali (mai dal delta dell'ultimo move): niente
  // accumulo di errori, e l'op finale è identico all'ultima anteprima.
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
    const ops: Op[] = [];
    for (const [id, start] of Object.entries(resizeStartNodes)) {
      const b = transformBounds(start, t);
      ops.push(makeSetPropsOp(id, b, ["x", "y", "width", "height"]));
      // Un nodo VETTORIALE porta la sua geometria dentro il gesto. Gli ancoraggi
      // sono lunghezze in coordinate locali, non frazioni del box: senza questo
      // secondo op il box crescerebbe e l'inchiostro resterebbe della sua
      // misura, violando l'invariante del proto (dopo un SetVectorPath la bbox
      // locale della geometria è (0,0)-(width,height)) con un gesto ordinario.
      //
      // È lo STESSO gesto, non un secondo: una voce di undo sola, un solo invio
      // sul filo, e in anteprima due chiavi di coalescing distinte (`s|id|...` e
      // `v|id`, vedi store.ts::previewKey) che non si schiacciano a vicenda.
      const start0 = resizeStartVectors?.[id];
      if (!start0) continue;
      ops.push(makeSetVectorPathOp(id, resizeVector(
        start0,
        start,
        { signed: t.signedW, start: t.startW },
        { signed: t.signedH, start: t.startH },
      )));
    }
    return ops;
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
        const start: Record<string, Bounds> = {};
        const startVectors: Record<string, SubPathLite[]> = {};
        for (const sid of store.selection) {
          const n = scene.nodes[sid];
          if (!n) continue;
          start[sid] = boundsOfNode(n);
          if (n.kind === "vector" && n.vector) startVectors[sid] = n.vector.subpaths;
        }
        resizeHandle = handle;
        resizeAnchor = world;
        resizeStartBox = selectionWorldBounds(scene, store.selection);
        resizeStartNodes = start;
        resizeStartVectors = startVectors;
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
      const zoom = ctx.getCamera().zoom;
      const hitId = hitTest(scene, world.x, world.y, zoom);
      if (hitId && !e.shiftKey) {
        const isDoubleClick =
          lastClick !== null &&
          lastClick.id === hitId &&
          e.timeStamp - lastClick.time <= DOUBLE_CLICK_MS;
        if (isDoubleClick && scene.nodes[hitId]?.kind === "text") {
          // lastClick azzerato: un terzo click non incatena un altro doppio.
          lastClick = null;
          pendingTextEdit = hitId;
        } else {
          lastClick = { id: hitId, time: e.timeStamp };
        }
      } else {
        lastClick = null;
      }

      const target = pickTarget(scene, world, e.shiftKey, store.selection, zoom);

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

      const selection = useScene.getState().selection;
      const start: Record<string, { x: number; y: number }> = {};
      for (const sid of selection) {
        const n = scene.nodes[sid];
        if (n) start[sid] = { x: n.x, y: n.y };
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
      const world = ctx.toWorld(e);
      const dx = world.x - dragAnchor.x;
      const dy = world.y - dragAnchor.y;
      for (const [id, start] of Object.entries(dragStart)) {
        useScene.getState().applyLocal(makeSetPropsOp(id, { x: start.x + dx, y: start.y + dy }, ["x", "y"]));
      }
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
        const inside = scene && !isClick ? nodesInMarquee(scene, box) : [];
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
      if (dragStarted) {
        const world = ctx.toWorld(e);
        const dx = world.x - dragAnchor.x;
        const dy = world.y - dragAnchor.y;
        const finalOps = Object.entries(dragStart).map(([id, start]) =>
          makeSetPropsOp(id, { x: start.x + dx, y: start.y + dy }, ["x", "y"]));
        useScene.getState().endGesture(finalOps);
      }
      resetDrag();
    },

    onKeyDown(e) {
      if (e.key === "Escape") {
        cancelActiveGesture();
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
        const ids = store.selection;
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
