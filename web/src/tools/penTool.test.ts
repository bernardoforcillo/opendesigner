import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createPenTool,
  penReduce,
  PEN_IDLE,
  PEN_CLICK_SLOP_PX,
  PEN_FILL,
  type PenState,
} from "./penTool";
import type { ToolContext } from "./types";
import type { Node as PbNode, Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "../store/store";
import { emptyScene } from "../store/types";
import type { AnchorLite } from "../store/types";

// --- doppi ------------------------------------------------------------------

// Doppio di SyncClient (come in rectTool.test.ts): registra gli op che finiscono
// SUL FILO e modella un server che accetta ed ecoa subito.
class FakeSync {
  sent: Op[] = [];
  submit(op: Op) {
    this.sent.push(op);
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
}

// toWorld è l'identità su clientX/clientY: i test ragionano direttamente in
// coordinate mondo (la conversione vera è testata in canvas/camera.test.ts).
function fakeCtx(zoom = 1) {
  const sync = new FakeSync();
  useScene.getState().setSync(sync);
  const ctx = {
    sync,
    getScene: () => useScene.getState().scene,
    getCamera: () => ({ ...useScene.getState().camera, zoom }),
    setCamera: vi.fn(),
    canvas: {} as HTMLCanvasElement,
    toWorld: (e: PointerEvent) => ({ x: e.clientX, y: e.clientY }),
  } as unknown as ToolContext;
  return { ctx, submitted: sync.sent };
}

const at = (x: number, y: number) => ({ clientX: x, clientY: y }) as PointerEvent;
const key = (k: string) => ({ key: k }) as KeyboardEvent;

function createdNode(op: Op): PbNode {
  if (op.kind.case !== "createNode") throw new Error(`expected createNode, got ${op.kind.case}`);
  const n = op.kind.value.node;
  if (!n) throw new Error("createNode without node");
  return n;
}

// Il contorno dentro l'op di creazione. Fallisce forte (non ritorna undefined)
// se la forma non è vettoriale: un pen tool che crea un rettangolo deve rompere
// il test che parla della sua geometria, non passarlo per silenzio.
function createdSubpath(op: Op) {
  const shape = createdNode(op).shape;
  if (shape.case !== "vector") throw new Error(`expected a vector shape, got ${shape.case}`);
  const sp = shape.value.subpaths[0];
  if (!sp) throw new Error("vector node without subpaths");
  return sp;
}

const corner = (x: number, y: number): AnchorLite => ({ x, y, inX: 0, inY: 0, outX: 0, outY: 0 });

// Gli ancoraggi di uno stato che ne ha (placing/drawing). Tenuto qui e non nel
// modulo: i test devono poter guardare DENTRO lo stato senza che il tool esponga
// una scorciatoia che nessun altro usa.
function anchorsOf(s: PenState): readonly AnchorLite[] {
  if (s.name === "idle") throw new Error("lo stato idle non ha ancoraggi");
  return s.anchors;
}

beforeEach(() => {
  useScene.setState({
    camera: { x: 0, y: 0, zoom: 1 },
    selection: [],
    marquee: null,
    penPreview: null,
    sync: null,
    gesture: null,
    undoStack: [],
    redoStack: [],
    canUndo: false,
    canRedo: false,
  });
  useScene.getState().setScene(emptyScene("doc-1", "Untitled"));
});

// ============================================================================
// LA MACCHINA A STATI, da sola: funzione pura, nessuno store, nessun DOM.
// ============================================================================

describe("penReduce: la macchina a stati", () => {
  it("idle + down piazza il PRIMO ancoraggio, e non chiede NIENTE al chiamante", () => {
    const step = penReduce(PEN_IDLE, { kind: "down", at: { x: 10, y: 20 }, grab: 6 });
    expect(step.state.name).toBe("placing");
    expect(anchorsOf(step.state)).toEqual([corner(10, 20)]);
    // Nessun effetto: il path in corso vive solo nell'anteprima, e lo slot del
    // gesto dello store resta libero per chiunque altro finché il disegno non
    // finisce (vedi il test "non occupa lo slot del gesto" più sotto).
    expect(step.effect).toBe("none");
    expect(step.path).toBeUndefined();
  });

  it("un drag oltre la soglia tira le maniglie SIMMETRICHE dell'ancoraggio appena posato", () => {
    const down = penReduce(PEN_IDLE, { kind: "down", at: { x: 10, y: 10 }, grab: 6 });
    const move = penReduce(down.state, { kind: "move", at: { x: 30, y: 40 }, slop: 3 });
    // Uscente VERSO il cursore, entrante specchiata: è l'ancoraggio morbido
    // standard, quello che rende continua la tangente in quel punto.
    expect(anchorsOf(move.state)).toEqual([
      { x: 10, y: 10, outX: 20, outY: 30, inX: -20, inY: -30 },
    ]);
    expect(move.effect).toBe("none");
  });

  it("un tremolio SOTTO la soglia lascia l'ancoraggio d'ANGOLO (nessuna maniglia)", () => {
    const down = penReduce(PEN_IDLE, { kind: "down", at: { x: 10, y: 10 }, grab: 6 });
    const move = penReduce(down.state, { kind: "move", at: { x: 11, y: 11 }, slop: 3 });
    expect(anchorsOf(move.state)).toEqual([corner(10, 10)]);
  });

  it("il rilascio chiude il piazzamento e passa in drawing, col cursore sul punto di rilascio", () => {
    const down = penReduce(PEN_IDLE, { kind: "down", at: { x: 10, y: 10 }, grab: 6 });
    const up = penReduce(down.state, { kind: "up", at: { x: 10, y: 10 }, slop: 3 });
    expect(up.state.name).toBe("drawing");
    if (up.state.name !== "drawing") throw new Error("unreachable");
    expect(up.state.cursor).toEqual({ x: 10, y: 10 });
    expect(up.effect).toBe("none"); // nessun op: il gesto è ancora aperto
  });

  it("un down LONTANO dal primo ancoraggio ne aggiunge un altro in coda", () => {
    let s = penReduce(PEN_IDLE, { kind: "down", at: { x: 0, y: 0 }, grab: 6 }).state;
    s = penReduce(s, { kind: "up", at: { x: 0, y: 0 }, slop: 3 }).state;
    const step = penReduce(s, { kind: "down", at: { x: 100, y: 0 }, grab: 6 });
    expect(step.state.name).toBe("placing");
    expect(anchorsOf(step.state)).toEqual([corner(0, 0), corner(100, 0)]);
    expect(step.effect).toBe("none");
  });

  it("un down SUL primo ancoraggio (entro la presa) chiude il contorno al rilascio", () => {
    const s = drawn([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]);
    const down = penReduce(s, { kind: "down", at: { x: 2, y: 1 }, grab: 6 });
    expect(down.state.name).toBe("placing");
    if (down.state.name !== "placing") throw new Error("unreachable");
    expect(down.state.grip).toBe("close");
    // DUE punti, due mestieri. `base` è l'ANCORAGGIO: è da lì che si misura la
    // maniglia, perché una maniglia è un offset dall'ancoraggio. `origin` è il
    // pixel effettivamente CLICCATO: è da lì che si misura se il puntatore si è
    // mosso, cioè se c'è un trascinamento. Confonderli fa pagare la generosità
    // della presa come se fosse un gesto (vedi il test sulla corona 3-6px).
    expect(down.state.base).toEqual(corner(0, 0));
    expect(down.state.origin).toEqual({ x: 2, y: 1 });
    // Nessun ancoraggio in più: chiudere non ne aggiunge uno sopra il primo.
    expect(anchorsOf(down.state)).toHaveLength(3);

    const up = penReduce(down.state, { kind: "up", at: { x: 2, y: 1 }, slop: 3 });
    expect(up.effect).toBe("finish");
    expect(up.path?.closed).toBe(true);
    expect(up.path?.anchors).toHaveLength(3);
    expect(up.state).toBe(PEN_IDLE);
  });

  // LA CORONA 3-6px. La presa che chiude il contorno vale 6px SCHERMO
  // (PEN_ANCHOR_GRAB_PX) mentre la soglia click/trascinamento ne vale 3
  // (PEN_CLICK_SLOP_PX): esattamente il doppio. Esiste quindi un anello attorno
  // al primo ancoraggio in cui un click CHIUDE ed è già oltre la soglia se la
  // soglia si misura dall'ANCORAGGIO. Lì dentro un click fermo -- puntatore che
  // non si muove di un pixel -- diventerebbe un trascinamento mai fatto, e il
  // segmento di ritorno nascerebbe curvo. Quell'anello è precisamente dove la
  // presa generosa INVITA a cliccare, quindi non è un caso limite: è il caso
  // normale di chi non centra il quadratino.
  it("un click FERMO nella corona 3-6px della presa NON regala nessuna maniglia", () => {
    const s = drawn([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]);
    // 5 unità mondo dal primo ancoraggio: dentro la presa (6), oltre la soglia
    // (3). Il puntatore però non si muove: down e up nello stesso punto.
    const down = penReduce(s, { kind: "down", at: { x: 5, y: 0 }, grab: 6 });
    const up = penReduce(down.state, { kind: "up", at: { x: 5, y: 0 }, slop: 3 });

    expect(up.effect).toBe("finish");
    expect(up.path?.closed).toBe(true);
    // Il primo ancoraggio è ancora un ANGOLO: nessuna entrante inventata.
    expect(up.path?.anchors[0]).toEqual(corner(0, 0));
  });

  // WYSIWYG: l'anteprima al pointerdown disegna il segmento di ritorno DRITTO
  // (penPreviewOf non tocca gli ancoraggi). Se il commit lo curvasse, il nodo
  // creato sarebbe diverso da quello che si stava guardando -- la peggiore
  // delle sorprese in uno strumento di disegno.
  it("nella corona, ciò che si vede al pointerdown è ciò che si ottiene al rilascio", () => {
    const s = drawn([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]);
    const down = penReduce(s, { kind: "down", at: { x: 4, y: 3 }, grab: 6 }); // dist 5
    const shown = anchorsOf(down.state);
    const up = penReduce(down.state, { kind: "up", at: { x: 4, y: 3 }, slop: 3 });
    expect(up.path?.anchors).toEqual(shown);
  });

  it("ma un trascinamento VERO partito nella corona tira la maniglia, misurata dall'ANCORAGGIO", () => {
    const s = drawn([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]);
    const down = penReduce(s, { kind: "down", at: { x: 5, y: 0 }, grab: 6 });
    // Il puntatore si muove davvero (40 unità dal punto di discesa): adesso è un
    // trascinamento, e la maniglia è il delta cursore-ANCORAGGIO -- non
    // cursore-punto di discesa, perché una maniglia è un offset dall'ancoraggio.
    const move = penReduce(down.state, { kind: "move", at: { x: 5, y: 40 }, slop: 3 });
    expect(anchorsOf(move.state)[0]).toEqual({ x: 0, y: 0, inX: 5, inY: 40, outX: 0, outY: 0 });
  });

  it("un trascinamento che RIENTRA nella soglia torna all'angolo (nessuna isteresi)", () => {
    const s = drawn([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]);
    const down = penReduce(s, { kind: "down", at: { x: 5, y: 0 }, grab: 6 });
    let m = penReduce(down.state, { kind: "move", at: { x: 5, y: 40 }, slop: 3 }).state;
    m = penReduce(m, { kind: "move", at: { x: 6, y: 1 }, slop: 3 }).state; // di nuovo entro 3 dal down
    expect(anchorsOf(m)[0]).toEqual(corner(0, 0));
  });

  it("trascinare sul primo ancoraggio tira la sua maniglia ENTRANTE e lascia stare l'uscente", () => {
    // Il primo ancoraggio nasce MORBIDO (posato con un trascinamento): la sua
    // uscente disegna già il primo segmento e non va deformata all'indietro da
    // un trascinamento di CHIUSURA, che riguarda il segmento di ritorno.
    let s = penReduce(PEN_IDLE, { kind: "down", at: { x: 0, y: 0 }, grab: 6 }).state;
    s = penReduce(s, { kind: "move", at: { x: 0, y: -50 }, slop: 3 }).state;
    s = penReduce(s, { kind: "up", at: { x: 0, y: -50 }, slop: 3 }).state;
    s = penReduce(s, { kind: "down", at: { x: 100, y: 0 }, grab: 6 }).state;
    s = penReduce(s, { kind: "up", at: { x: 100, y: 0 }, slop: 3 }).state;

    const down = penReduce(s, { kind: "down", at: { x: 0, y: 0 }, grab: 6 });
    const move = penReduce(down.state, { kind: "move", at: { x: 0, y: 40 }, slop: 3 });
    expect(anchorsOf(move.state)[0]).toEqual({ x: 0, y: 0, inX: 0, inY: 40, outX: 0, outY: -50 });
  });

  it("Invio col puntatore premuto sul primo ancoraggio finisce CHIUSO, come l'anteprima mostra", () => {
    // Il commit da tastiera arriva prima del rilascio. L'anteprima in quel
    // momento sta già disegnando il segmento di ritorno (grip "close"):
    // terminare APERTO darebbe un nodo diverso da quello che si ha davanti.
    const s = drawn([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]);
    const down = penReduce(s, { kind: "down", at: { x: 0, y: 0 }, grab: 6 });
    const move = penReduce(down.state, { kind: "move", at: { x: -40, y: 20 }, slop: 3 });
    const step = penReduce(move.state, { kind: "commit" });
    expect(step.effect).toBe("finish");
    expect(step.path?.closed).toBe(true);
    // E con la maniglia di chiusura tirata fin lì: gli ancoraggi del commit
    // sono quelli dello stato, che il trascinamento ha già aggiornato.
    expect(step.path?.anchors[0]).toEqual({ x: 0, y: 0, inX: -40, inY: 20, outX: 0, outY: 0 });
  });

  it("un commit di chiusura con UN SOLO ancoraggio resta APERTO", () => {
    const s = drawn([{ x: 0, y: 0 }]);
    const down = penReduce(s, { kind: "down", at: { x: 0, y: 0 }, grab: 6 });
    const step = penReduce(down.state, { kind: "commit" });
    expect(step.path?.closed).toBe(false);
  });

  it("con UN SOLO ancoraggio non c'è niente da chiudere: il path finisce APERTO", () => {
    const s = drawn([{ x: 0, y: 0 }]);
    const down = penReduce(s, { kind: "down", at: { x: 0, y: 0 }, grab: 6 });
    const up = penReduce(down.state, { kind: "up", at: { x: 0, y: 0 }, slop: 3 });
    expect(up.effect).toBe("finish");
    // `closed` con un ancoraggio solo sarebbe una bugia: non esiste nessun
    // segmento di ritorno da disegnare.
    expect(up.path?.closed).toBe(false);
    expect(up.path?.anchors).toHaveLength(1);
  });

  it("Enter/Escape (commit) terminano il path APERTO con quello che c'è", () => {
    const s = drawn([{ x: 0, y: 0 }, { x: 50, y: 50 }]);
    const step = penReduce(s, { kind: "commit" });
    expect(step.effect).toBe("finish");
    expect(step.path).toEqual({ anchors: [corner(0, 0), corner(50, 50)], closed: false });
    expect(step.state).toBe(PEN_IDLE);
  });

  it("commit a MANO ALZATA (nessun ancoraggio) non crea niente e non tocca nessun gesto", () => {
    const step = penReduce(PEN_IDLE, { kind: "commit" });
    expect(step.effect).toBe("none");
    expect(step.path).toBeUndefined();
    expect(step.state).toBe(PEN_IDLE);
  });

  it("abort abbandona il path in corso senza chiedere nessun op", () => {
    const s = drawn([{ x: 0, y: 0 }, { x: 50, y: 0 }]);
    const step = penReduce(s, { kind: "abort" });
    // Niente da annullare nello store: il path non era mai entrato nel
    // documento, e un cancelGesture qui annullerebbe il gesto di QUALCUN ALTRO.
    expect(step.effect).toBe("none");
    expect(step.path).toBeUndefined();
    expect(step.state).toBe(PEN_IDLE);
  });

  it("abort da idle non ha niente da annullare", () => {
    const step = penReduce(PEN_IDLE, { kind: "abort" });
    expect(step.effect).toBe("none");
    expect(step.state).toBe(PEN_IDLE);
  });

  it("un movimento a vuoto (idle) non produce nessuno stato nuovo", () => {
    const step = penReduce(PEN_IDLE, { kind: "move", at: { x: 5, y: 5 }, slop: 3 });
    // STESSO riferimento: è ciò che permette al tool di non riscrivere
    // l'anteprima nello store a ogni pointermove fuori dal disegno.
    expect(step.state).toBe(PEN_IDLE);
    expect(step.effect).toBe("none");
  });

  it("un SECONDO pointer premuto durante un piazzamento non entra nel path", () => {
    const down = penReduce(PEN_IDLE, { kind: "down", at: { x: 0, y: 0 }, grab: 6 });
    const second = penReduce(down.state, { kind: "down", at: { x: 500, y: 500 }, grab: 6 });
    expect(second.state).toBe(down.state);
    expect(second.effect).toBe("none");
  });

  // Uno stato "drawing" con gli ancoraggi dati, costruito passando dagli
  // EVENTI e non a mano: se le transizioni cambiano, questi helper cambiano con
  // loro invece di descrivere una macchina che non esiste più.
  function drawn(points: { x: number; y: number }[]): PenState {
    let s = PEN_IDLE;
    for (const p of points) {
      s = penReduce(s, { kind: "down", at: p, grab: 6 }).state;
      s = penReduce(s, { kind: "up", at: p, slop: 3 }).state;
    }
    return s;
  }
});

// ============================================================================
// IL TOOL: la macchina attaccata allo store (op, gesto, anteprima, selezione).
// ============================================================================

describe("penTool", () => {
  it("tre click e Invio: UN SOLO op sul filo, un createNode vettoriale di tre ancoraggi", () => {
    const tool = createPenTool();
    const { ctx, submitted } = fakeCtx();

    for (const [x, y] of [[0, 0], [100, 0], [100, 100]]) {
      tool.onPointerDown!(at(x, y), ctx);
      tool.onPointerUp!(at(x, y), ctx);
    }
    expect(submitted).toHaveLength(0); // nessun op PER ANCORAGGIO

    tool.onKeyDown!(key("Enter"), ctx);

    expect(submitted).toHaveLength(1);
    const sp = createdSubpath(submitted[0]);
    expect(sp.anchors).toHaveLength(3);
    expect(sp.closed).toBe(false);
  });

  it("è UNA sola voce di annulla, e disfarla toglie il path intero", () => {
    const tool = createPenTool();
    const { ctx, submitted } = fakeCtx();

    for (const [x, y] of [[0, 0], [100, 0], [100, 100]]) {
      tool.onPointerDown!(at(x, y), ctx);
      tool.onPointerUp!(at(x, y), ctx);
    }
    tool.onKeyDown!(key("Escape"), ctx);

    expect(useScene.getState().undoStack).toHaveLength(1);
    expect(useScene.getState().canUndo).toBe(true);
    const id = createdNode(submitted[0]).id;
    expect(useScene.getState().scene!.nodes[id]).toBeDefined();

    useScene.getState().undo();
    expect(useScene.getState().scene!.nodes[id]).toBeUndefined();
  });

  // Lo slot del gesto (store.gesture) è UNO SOLO per tutta l'applicazione.
  // Tenerlo occupato fra un click e l'altro -- una finestra lunga quanto
  // l'utente vuole -- significa che il primo pannello che apre il proprio gesto
  // se lo prende e lo CHIUDE da sotto (PropertiesPanel::scrubEnd,
  // LayersPanel), e il createNode finale finirebbe nel ramo di misuso di
  // endGesture: sottomesso senza ribasare sulla base del gesto.
  it("NON occupa lo slot del gesto tra un click e l'altro", () => {
    const tool = createPenTool();
    const { ctx } = fakeCtx();

    expect(useScene.getState().gesture).toBeNull();
    tool.onPointerDown!(at(0, 0), ctx);
    tool.onPointerUp!(at(0, 0), ctx);
    expect(useScene.getState().gesture).toBeNull();
    tool.onPointerDown!(at(50, 0), ctx);
    tool.onPointerUp!(at(50, 0), ctx);
    expect(useScene.getState().gesture).toBeNull();

    tool.onKeyDown!(key("Enter"), ctx);
    expect(useScene.getState().gesture).toBeNull();
  });

  it("un gesto ALTRUI a metà disegno non rompe la creazione (né la chiude a metà)", () => {
    const tool = createPenTool();
    const { ctx, submitted } = fakeCtx();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    tool.onPointerDown!(at(0, 0), ctx);
    tool.onPointerUp!(at(0, 0), ctx);
    tool.onPointerDown!(at(100, 0), ctx);
    tool.onPointerUp!(at(100, 0), ctx);

    // Il pannello proprietà a metà disegno: la selezione precedente è ancora
    // viva (il pen tool non la svuota), quindi scrub/scrubEnd sono
    // raggiungibilissimi. Apre e chiude il SUO gesto.
    useScene.getState().beginGesture();
    useScene.getState().endGesture([]);

    tool.onKeyDown!(key("Enter"), ctx);

    // Nessun warning di misuso: il gesto del pen tool si apre al finish, e a
    // quel punto lo slot è libero.
    expect(warn).not.toHaveBeenCalled();
    expect(submitted).toHaveLength(1);
    expect(createdSubpath(submitted[0]).anchors).toHaveLength(2);
    expect(useScene.getState().gesture).toBeNull();
    expect(useScene.getState().undoStack).toHaveLength(1);
    warn.mockRestore();
  });

  it("abbandonare il path non annulla il gesto di QUALCUN ALTRO", () => {
    const tool = createPenTool();
    const { ctx } = fakeCtx();

    tool.onPointerDown!(at(0, 0), ctx);
    tool.onPointerUp!(at(0, 0), ctx);
    // Un gesto altrui aperto (un pannello a metà scrub) mentre il pen tool
    // viene disattivato: cancelGesture qui riavvolgerebbe il LORO lavoro.
    useScene.getState().beginGesture();
    tool.onDeactivate!(ctx);

    expect(useScene.getState().gesture).not.toBeNull();
    expect(useScene.getState().penPreview).toBeNull();
  });

  it("Ctrl+Z a metà path non fa niente: il disegno in corso non è ancora documento", () => {
    const tool = createPenTool();
    const { ctx } = fakeCtx();

    // Un gesto già concluso da annullare (un path finito prima di questo).
    tool.onPointerDown!(at(0, 0), ctx);
    tool.onPointerUp!(at(0, 0), ctx);
    tool.onKeyDown!(key("Enter"), ctx);
    expect(useScene.getState().undoStack).toHaveLength(1);

    // Adesso un path NUOVO in corso: l'undo è rimandato, altrimenti
    // disferebbe qualcosa di diverso da ciò che l'utente sta guardando.
    tool.onPointerDown!(at(200, 200), ctx);
    tool.onPointerUp!(at(200, 200), ctx);
    useScene.getState().undo();
    expect(useScene.getState().undoStack).toHaveLength(1);

    // Finito il path, l'undo torna a funzionare.
    tool.onKeyDown!(key("Enter"), ctx);
    useScene.getState().undo();
    expect(useScene.getState().undoStack).toHaveLength(1);
    expect(useScene.getState().redoStack).toHaveLength(1);
  });

  it("click-e-TRASCINA posa un ancoraggio morbido con le maniglie simmetriche", () => {
    const tool = createPenTool();
    const { ctx, submitted } = fakeCtx();

    tool.onPointerDown!(at(0, 0), ctx);
    tool.onPointerMove!(at(0, 40), ctx);
    tool.onPointerUp!(at(0, 40), ctx);
    tool.onPointerDown!(at(100, 0), ctx);
    tool.onPointerUp!(at(100, 0), ctx);
    tool.onKeyDown!(key("Enter"), ctx);

    const sp = createdSubpath(submitted[0]);
    // Le maniglie sono OFFSET relativi all'ancoraggio (regola dei due spazi):
    // la traslazione in coordinate locali non le tocca.
    expect(sp.anchors[0].outY).toBe(40);
    expect(sp.anchors[0].inY).toBe(-40);
    expect(sp.anchors[1].outX).toBe(0);
    expect(sp.anchors[1].inX).toBe(0);
  });

  it("il click sul PRIMO ancoraggio chiude il contorno e finisce, senza bisogno di Invio", () => {
    const tool = createPenTool();
    const { ctx, submitted } = fakeCtx();

    for (const [x, y] of [[0, 0], [100, 0], [100, 100]]) {
      tool.onPointerDown!(at(x, y), ctx);
      tool.onPointerUp!(at(x, y), ctx);
    }
    tool.onPointerDown!(at(1, 1), ctx); // sul primo ancoraggio
    tool.onPointerUp!(at(1, 1), ctx);

    expect(submitted).toHaveLength(1);
    const sp = createdSubpath(submitted[0]);
    expect(sp.closed).toBe(true);
    expect(sp.anchors).toHaveLength(3); // il click di chiusura non ne aggiunge uno
  });

  // La corona 3-6px vista dal tool: la presa (6px) è il DOPPIO della soglia
  // (3px), quindi un click che chiude senza centrare il quadratino cade
  // regolarmente dove la soglia, misurata male, lo leggerebbe come un
  // trascinamento.
  it("un click di chiusura fuori centro (ma fermo) NON curva il segmento di ritorno", () => {
    const tool = createPenTool();
    const { ctx, submitted } = fakeCtx();

    for (const [x, y] of [[0, 0], [100, 0], [100, 100]]) {
      tool.onPointerDown!(at(x, y), ctx);
      tool.onPointerUp!(at(x, y), ctx);
    }
    // 5px dal primo ancoraggio: dentro la presa (6), oltre la soglia (3).
    tool.onPointerDown!(at(5, 0), ctx);
    // L'anteprima in questo istante mostra il ritorno DRITTO: l'ancoraggio non
    // è stato toccato. È il patto che il commit deve rispettare.
    expect(useScene.getState().penPreview!.anchors[0]).toEqual(corner(0, 0));
    tool.onPointerUp!(at(5, 0), ctx);

    const sp = createdSubpath(submitted[0]);
    expect(sp.closed).toBe(true);
    expect({ inX: sp.anchors[0].inX, inY: sp.anchors[0].inY }).toEqual({ inX: 0, inY: 0 });
  });

  // L'errore non era solo "una maniglia in più": era una maniglia in unità
  // MONDO. La presa vale 6px SCHERMO, quindi a zoom 0.25 sono 24 unità mondo di
  // curvatura cotte dentro il documento, che tornando a zoom 4 diventano un
  // gonfiore da ~96px. Lo stesso click a zoom 1 ne avrebbe lasciate 6: la
  // gravità del bug dipendeva dallo zoom, il che è il modo peggiore per un
  // documento di essere sbagliato.
  it("e a zoom 0.25 non ci bagna 20 unità MONDO di curvatura nel documento", () => {
    const tool = createPenTool();
    const { ctx, submitted } = fakeCtx(0.25);

    for (const [x, y] of [[0, 0], [100, 0], [100, 100]]) {
      tool.onPointerDown!(at(x, y), ctx);
      tool.onPointerUp!(at(x, y), ctx);
    }
    // presa = 6/0.25 = 24 unità mondo, soglia = 3/0.25 = 12. Un click fermo a
    // 20 unità dal primo ancoraggio chiude ed è dentro la corona.
    tool.onPointerDown!(at(20, 0), ctx);
    tool.onPointerUp!(at(20, 0), ctx);

    const sp = createdSubpath(submitted[0]);
    expect(sp.closed).toBe(true);
    expect({ inX: sp.anchors[0].inX, inY: sp.anchors[0].inY }).toEqual({ inX: 0, inY: 0 });
  });

  it("la presa di chiusura è in px SCHERMO: a zoom 4 lo stesso click sul vuoto NON chiude", () => {
    const tool = createPenTool();
    const { ctx, submitted } = fakeCtx(4);

    for (const [x, y] of [[0, 0], [100, 0]]) {
      tool.onPointerDown!(at(x, y), ctx);
      tool.onPointerUp!(at(x, y), ctx);
    }
    // 3 unità mondo = 12 px schermo a zoom 4: fuori dalla presa, quindi è un
    // ancoraggio nuovo. A zoom 1 sarebbero stati 3 px, cioè una chiusura.
    tool.onPointerDown!(at(3, 0), ctx);
    tool.onPointerUp!(at(3, 0), ctx);
    expect(submitted).toHaveLength(0);
    tool.onKeyDown!(key("Enter"), ctx);
    const sp = createdSubpath(submitted[0]);
    expect(sp.closed).toBe(false);
    expect(sp.anchors).toHaveLength(3);
  });

  it("Escape a mano alzata non crea nessun nodo e non lascia gesti aperti", () => {
    const tool = createPenTool();
    const { ctx, submitted } = fakeCtx();

    tool.onKeyDown!(key("Escape"), ctx);

    expect(submitted).toHaveLength(0);
    expect(Object.keys(useScene.getState().scene!.nodes)).toHaveLength(0);
    expect(useScene.getState().gesture).toBeNull();
    expect(useScene.getState().penPreview).toBeNull();
  });

  it("il box del nodo È la bbox della geometria, e gli ancoraggi sono LOCALI a partire da (0,0)", () => {
    const tool = createPenTool();
    const { ctx, submitted } = fakeCtx();

    for (const [x, y] of [[10, 10], [110, 10], [110, 60]]) {
      tool.onPointerDown!(at(x, y), ctx);
      tool.onPointerUp!(at(x, y), ctx);
    }
    tool.onKeyDown!(key("Enter"), ctx);

    const n = createdNode(submitted[0]);
    expect({ x: n.x, y: n.y, width: n.width, height: n.height })
      .toEqual({ x: 10, y: 10, width: 100, height: 50 });
    const sp = createdSubpath(submitted[0]);
    expect(sp.anchors.map((a) => ({ x: a.x, y: a.y })))
      .toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }]);
  });

  it("il nodo appena creato resta selezionato", () => {
    const tool = createPenTool();
    const { ctx, submitted } = fakeCtx();

    tool.onPointerDown!(at(0, 0), ctx);
    tool.onPointerUp!(at(0, 0), ctx);
    tool.onPointerDown!(at(50, 0), ctx);
    tool.onPointerUp!(at(50, 0), ctx);
    tool.onKeyDown!(key("Enter"), ctx);

    expect(useScene.getState().selection).toEqual([createdNode(submitted[0]).id]);
  });

  it("pubblica l'anteprima sull'overlay: il path posato PIÙ il segmento che segue il cursore", () => {
    const tool = createPenTool();
    const { ctx } = fakeCtx();

    tool.onPointerDown!(at(0, 0), ctx);
    tool.onPointerUp!(at(0, 0), ctx);
    tool.onPointerMove!(at(60, 20), ctx);

    const p = useScene.getState().penPreview;
    expect(p).not.toBeNull();
    expect(p!.anchors).toEqual([corner(0, 0)]);
    // Il segmento che seguirebbe il cursore: è l'unico pezzo dell'anteprima che
    // non è ancora geometria.
    expect(p!.next).toEqual({ x: 60, y: 20 });
    expect(p!.active).toBeNull();
  });

  it("durante il trascinamento l'anteprima mostra le MANIGLIE, non il segmento pendente", () => {
    const tool = createPenTool();
    const { ctx } = fakeCtx();

    tool.onPointerDown!(at(0, 0), ctx);
    tool.onPointerMove!(at(0, 40), ctx);

    const p = useScene.getState().penPreview;
    // Il cursore sta definendo una maniglia, non un punto nuovo: disegnare
    // anche il segmento pendente direbbe una cosa falsa.
    expect(p!.next).toBeNull();
    expect(p!.active).toBe(0);
    expect(p!.anchors[0].outY).toBe(40);
  });

  // Il segmento di RITORNO (ultimo -> primo) è quello che il trascinamento di
  // chiusura sta modellando: tira la maniglia entrante del primo ancoraggio,
  // che ne è il secondo punto di controllo. Senza dirlo all'anteprima si
  // vedrebbero solo un bastoncino e un pallino, e la curva comparirebbe solo a
  // nodo creato -- la peggiore delle sorprese in uno strumento di disegno.
  it("premendo sul primo ancoraggio l'anteprima si CHIUDE: il segmento di ritorno si vede", () => {
    const tool = createPenTool();
    const { ctx } = fakeCtx();

    for (const [x, y] of [[0, 0], [100, 0], [100, 100]]) {
      tool.onPointerDown!(at(x, y), ctx);
      tool.onPointerUp!(at(x, y), ctx);
    }
    expect(useScene.getState().penPreview!.closed).toBe(false);

    tool.onPointerDown!(at(1, 1), ctx); // sul primo ancoraggio
    expect(useScene.getState().penPreview!.closed).toBe(true);

    // E il trascinamento modella proprio la maniglia di quel segmento.
    tool.onPointerMove!(at(-30, 20), ctx);
    const p = useScene.getState().penPreview!;
    expect(p.closed).toBe(true);
    expect(p.active).toBe(0);
    expect(p.anchors[0]).toEqual({ x: 0, y: 0, inX: -30, inY: 20, outX: 0, outY: 0 });
  });

  it("con un ancoraggio solo l'anteprima non si dichiara chiusa (non c'è ritorno)", () => {
    const tool = createPenTool();
    const { ctx } = fakeCtx();

    tool.onPointerDown!(at(0, 0), ctx);
    tool.onPointerUp!(at(0, 0), ctx);
    tool.onPointerDown!(at(0, 0), ctx); // di nuovo sul primo: chiusura di niente
    expect(useScene.getState().penPreview!.closed).toBe(false);
  });

  it("l'anteprima sparisce quando il path è finito", () => {
    const tool = createPenTool();
    const { ctx } = fakeCtx();

    tool.onPointerDown!(at(0, 0), ctx);
    tool.onPointerUp!(at(0, 0), ctx);
    expect(useScene.getState().penPreview).not.toBeNull();

    tool.onKeyDown!(key("Enter"), ctx);
    expect(useScene.getState().penPreview).toBeNull();
  });

  it("onDeactivate abbandona il path: nessun op, nessun gesto appeso, nessuna anteprima", () => {
    const tool = createPenTool();
    const { ctx, submitted } = fakeCtx();

    tool.onPointerDown!(at(0, 0), ctx);
    tool.onPointerUp!(at(0, 0), ctx);
    tool.onPointerDown!(at(50, 0), ctx);
    tool.onPointerUp!(at(50, 0), ctx);
    tool.onDeactivate!(ctx);

    expect(submitted).toHaveLength(0);
    expect(Object.keys(useScene.getState().scene!.nodes)).toHaveLength(0);
    expect(useScene.getState().gesture).toBeNull();
    expect(useScene.getState().penPreview).toBeNull();
  });

  // Spostare la vista mentre si disegna è routine in qualunque editor
  // vettoriale, e con una gesture che dura più click è pure inevitabile: il
  // punto successivo può stare fuori schermo. Il pan temporaneo (spazio o tasto
  // centrale) non è un cambio di strumento e non deve costare il path.
  it("onSuspend (pan temporaneo) NON butta via il path: si riprende da dov'era", () => {
    const tool = createPenTool();
    const { ctx, submitted } = fakeCtx();

    tool.onPointerDown!(at(0, 0), ctx);
    tool.onPointerUp!(at(0, 0), ctx);
    tool.onPointerDown!(at(100, 0), ctx);
    tool.onPointerUp!(at(100, 0), ctx);

    tool.onSuspend!(ctx);
    // L'anteprima resta accesa: durante il pan il disegno si continua a vedere.
    expect(useScene.getState().penPreview!.anchors).toHaveLength(2);

    // Ripresa: il click successivo aggiunge il TERZO ancoraggio, non il primo.
    tool.onPointerDown!(at(100, 100), ctx);
    tool.onPointerUp!(at(100, 100), ctx);
    tool.onKeyDown!(key("Enter"), ctx);

    expect(submitted).toHaveLength(1);
    expect(createdSubpath(submitted[0]).anchors).toHaveLength(3);
  });

  it("dopo un abbandono il tool riparte pulito (nessun ancoraggio fantasma nel path successivo)", () => {
    const tool = createPenTool();
    const { ctx, submitted } = fakeCtx();

    tool.onPointerDown!(at(0, 0), ctx);
    tool.onPointerUp!(at(0, 0), ctx);
    tool.onDeactivate!(ctx);

    tool.onPointerDown!(at(200, 200), ctx);
    tool.onPointerUp!(at(200, 200), ctx);
    tool.onKeyDown!(key("Enter"), ctx);

    expect(submitted).toHaveLength(1);
    expect(createdSubpath(submitted[0]).anchors).toHaveLength(1);
  });

  it("la soglia click/drag è in px SCHERMO: a zoom 10 due unità mondo SONO un drag", () => {
    const tool = createPenTool();
    const { ctx, submitted } = fakeCtx(10);

    tool.onPointerDown!(at(0, 0), ctx);
    tool.onPointerMove!(at(0, 2), ctx); // 20 px schermo: oltre la soglia
    tool.onPointerUp!(at(0, 2), ctx);
    tool.onKeyDown!(key("Enter"), ctx);

    expect(createdSubpath(submitted[0]).anchors[0].outY).toBe(2);
    expect(PEN_CLICK_SLOP_PX).toBe(3);
  });

  it("nasce con una tinta propria, non con il grigio delle forme", () => {
    // Un contorno APERTO esiste sullo schermo solo come tratto da 1.5px
    // (renderer/shapes.ts): il grigio pensato per un'area piena lo renderebbe
    // quasi invisibile.
    expect(PEN_FILL.a).toBe(1);
    expect(PEN_FILL.r).toBeLessThan(0.5);
  });

  it("dichiara l'id e il cursore con cui la toolbar lo registra", () => {
    const tool = createPenTool();
    expect(tool.id).toBe("pen");
    expect(tool.cursor).toBe("crosshair");
  });
});
