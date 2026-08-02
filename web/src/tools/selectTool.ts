import { hitTest } from "../renderer/canvasRenderer";
import { normalizeRect, boundsOfNode, boundsIntersect, worldVisualAabbOfNode, type Bounds } from "../canvas/geometry";
import { worldToScreen } from "../canvas/camera";
import { angleOf, centerOf, normalizeDegrees, rotateAround, snapDegrees } from "../canvas/transform";
import { selectionFrame, selectionWorldBounds } from "../renderer/overlayRenderer";
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
  const id = hitTest(scene, world.x, world.y);
  if (!id) return { mode: "marquee" };
  if (shiftKey) return { mode: "toggle", id };
  return selection.includes(id) ? { mode: "single" } : { mode: "single", id };
}

// Id dei nodi VISIBILI i cui bounds intersecano il marquee, ordinati per
// orderKey per un risultato deterministico (Object.values non garantisce
// l'ordine di inserimento per chiavi stringa).
export function nodesInMarquee(scene: SceneState, bounds: Bounds): string[] {
  return Object.values(scene.nodes)
    // worldVisualAabbOfNode e non boundsOfNode: conta quello che il nodo
    // DIPINGE -- ruotato (il rettangolo del modello non è più dove si vede) e
    // tratto compreso (un tratto esterno da 20 è una fascia larga 20 che sta
    // tutta fuori dal box). Trascinare un riquadro attorno a ciò che si vede
    // deve prenderlo: è tutto quello che il marquee promette.
    .filter((n) => n.visible && boundsIntersect(worldVisualAabbOfNode(n), bounds))
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
  let resizeHandle: HandleId | null = null;
  let resizeAnchor: { x: number; y: number } | null = null;
  let resizeStartFrame: SelectionFrame | null = null;
  // Bounds E angolo iniziale: un nodo ruotato dentro una selezione multipla non
  // si mappa come gli altri (vedi handles.ts::applyFrameResizeToNode), e per un
  // ribaltamento o una scala non uniforme anche il suo angolo cambia.
  let resizeStartNodes: Record<string, { bounds: Bounds; rotation: number }> | null = null;
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
  function dragDelta(e: PointerEvent, ctx: ToolContext): { dx: number; dy: number; guides: SnapGuide[] } {
    const world = ctx.toWorld(e);
    const dx = world.x - dragAnchor!.x;
    const dy = world.y - dragAnchor!.y;
    if (e.altKey || !dragBox || !dragTargets || dragTargets.length === 0) return { dx, dy, guides: [] };
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
  function resizeDelta(e: PointerEvent, ctx: ToolContext): { dx: number; dy: number; guides: SnapGuide[] } {
    const world = ctx.toWorld(e);
    const dx = world.x - resizeAnchor!.x;
    const dy = world.y - resizeAnchor!.y;
    const frame = resizeStartFrame;
    if (
      e.altKey || e.shiftKey || !frame || !resizeHandle
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
  function resizeOps(e: PointerEvent, ctx: ToolContext): { ops: Op[]; guides: SnapGuide[] } {
    if (!resizeHandle || !resizeAnchor || !resizeStartFrame || !resizeStartNodes) {
      return { ops: [], guides: [] };
    }
    const { dx, dy, guides } = resizeDelta(e, ctx);
    // resizeFrame porta il delta del puntatore nello spazio LOCALE del frame
    // (così la maniglia e allarga il nodo lungo il SUO asse, comunque sia
    // girato) e calcola l'offset che tiene l'ancora ferma nel MONDO. La
    // matematica del resize -- flip e keepAspect compresi -- resta quella di
    // resizeTransform, invariata: qui la si avvolge, non la si riscrive.
    const r = resizeFrame(resizeStartFrame, resizeHandle, dx, dy, { keepAspect: e.shiftKey });
    const ops = Object.entries(resizeStartNodes).map(([id, start]) => {
      const next = applyFrameResizeToNode(start.bounds, start.rotation, r);
      // L'angolo entra nella mask SOLO quando cambia davvero (un nodo allineato
      // al frame -- il caso normale -- manda esattamente l'op di prima). Cambia
      // quando una scala non uniforme o un ribaltamento girano gli assi del
      // nodo: senza spedirlo, il nodo si vedrebbe con la forma nuova e l'angolo
      // vecchio, cioè fuori dal riquadro.
      return next.rotation === start.rotation
        ? makeSetPropsOp(id, next.bounds, ["x", "y", "width", "height"])
        : makeSetPropsOp(
            id,
            { ...next.bounds, rotation: next.rotation },
            ["x", "y", "width", "height", "rotation"],
          );
    });
    return { ops, guides };
  }

  // Gli op del TRASCINAMENTO per la posizione corrente del puntatore. Come il
  // resize: ricalcolati dallo stato iniziale, mai dall'ultimo delta.
  function dragOps(e: PointerEvent, ctx: ToolContext): { ops: Op[]; guides: SnapGuide[] } {
    if (!dragAnchor || !dragStart) return { ops: [], guides: [] };
    const { dx, dy, guides } = dragDelta(e, ctx);
    const ops = Object.entries(dragStart).map(([id, start]) =>
      makeSetPropsOp(id, { x: start.x + dx, y: start.y + dy }, ["x", "y"]));
    return { ops, guides };
  }

  // Gli op della rotazione per la posizione corrente del puntatore. Come il
  // resize: SEMPRE ricalcolati dallo stato iniziale, mai dall'ultimo delta.
  function rotateOps(e: PointerEvent, ctx: ToolContext): Op[] {
    if (!rotateCenter || !rotateStartNodes) return [];
    const world = ctx.toWorld(e);
    const raw = angleOf(rotateCenter, world) - rotateStartAngle;
    // Con Shift lo scatto è sul TOTALE del riferimento, non sul delta: si
    // ottiene un angolo tondo (0, 15, 30...) invece di uno spostamento tondo a
    // partire da un angolo qualsiasi.
    const delta = e.shiftKey ? snapDegrees(rotateRef + raw, ROTATE_SNAP_DEG) - rotateRef : raw;
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
        const start: Record<string, { bounds: Bounds; rotation: number }> = {};
        for (const sid of store.selection) {
          const n = scene.nodes[sid];
          if (n) start[sid] = { bounds: boundsOfNode(n), rotation: n.rotation };
        }
        resizeHandle = overlay.handle;
        resizeAnchor = world;
        resizeStartFrame = frameOfSelection(ctx);
        resizeStartNodes = start;
        resizeTargets = snapTargets(scene, store.selection);
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
      const hitId = hitTest(scene, world.x, world.y);
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

      const target = pickTarget(scene, world, e.shiftKey, store.selection);

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
      // È il RIQUADRO della selezione a scattare, non i singoli nodi: con una
      // selezione multipla ogni nodo tirato dalla propria guida la sfalderebbe.
      dragBox = selectionWorldBounds(scene, selection);
      dragTargets = snapTargets(scene, selection);
    },

    onPointerMove(e, ctx) {
      if (rotateCenter) {
        setCursor(ctx, ROTATING_CURSOR);
        if (!rotateStarted) {
          rotateStarted = true;
          useScene.getState().beginGesture();
        }
        for (const op of rotateOps(e, ctx)) useScene.getState().applyLocal(op);
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
        const step = resizeOps(e, ctx);
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
      const step = dragOps(e, ctx);
      useScene.getState().setSnapGuides(step.guides);
      for (const op of step.ops) useScene.getState().applyLocal(op);
    },

    onPointerUp(e, ctx) {
      if (rotateCenter) {
        if (rotateStarted) useScene.getState().endGesture(rotateOps(e, ctx));
        resetRotate();
        return;
      }
      if (resizeHandle) {
        if (resizeStarted) useScene.getState().endGesture(resizeOps(e, ctx).ops);
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
      // Gli op finali portano la posizione SCATTATA, la stessa dell'ultima
      // anteprima: lo snap corregge il delta, non aggiunge un secondo op.
      if (dragStarted) useScene.getState().endGesture(dragOps(e, ctx).ops);
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
