import { describe, it, expect, beforeEach } from "vitest";
import { create } from "@bufbuild/protobuf";
import { NodeSchema, OpSchema } from "../gen/brawt/v1/brawt_pb";
import type { Op } from "../gen/brawt/v1/brawt_pb";
import { useScene } from "./store";
import { emptyScene } from "./types";

// Doppio di SyncClient (vedi rpc/syncClient.ts): registra gli op che finiscono
// SUL FILO e modella un server che accetta ed ECOA subito -- applyPending (op
// in volo, visibile subito) seguito da apply (l'eco che lo conferma). Senza
// l'eco ogni op resterebbe in coda per sempre e i test parlerebbero di uno
// stato che il server non ha mai visto. Lo store dipende solo dalla superficie
// { submit }, quindi non serve un SyncClient reale (niente rete nei test).
class FakeSync {
  sent: Op[] = [];
  submit(op: Op) {
    this.sent.push(op);
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
}

// Doppio del server che RIFIUTA: applyPending (l'op si vede subito, in
// ottimistico) seguito da rejectPending (il rifiuto che lo toglie). È
// esattamente la coppia di chiamate che SyncClient.drain fa quando la unary
// fallisce -- InvalidArgument dal server, richiesta scaduta, o op scartato
// perché stava dietro a uno fallito.
class RejectingSync {
  sent: Op[] = [];
  constructor(private message = "node already exists") {}
  submit(op: Op) {
    this.sent.push(op);
    useScene.getState().applyPending(op);
    useScene.getState().rejectPending(op.opId, this.message);
  }
}

// Doppio di un trasporto PILOTATO A MANO: submit fa solo l'apply ottimistico
// (come SyncClient, che accoda e ritorna subito) e il test decide op per op
// quale ATTERRA (`land`, l'eco da Subscribe) e quale viene RIFIUTATO
// (`reject`). Serve a riprodurre il caso che né FakeSync né RejectingSync
// coprono -- accettano/rifiutano *tutto* -- cioè un gruppo di op submittati
// insieme di cui solo una PARTE arriva sul server. È esattamente ciò che
// SyncClient.drain produce: manda un op alla volta, e quando uno fallisce
// quelli davanti sono già passati e quelli dietro vengono scartati.
class ManualSync {
  sent: Op[] = [];
  submit(op: Op) {
    this.sent.push(op);
    useScene.getState().applyPending(op);
  }
  land(op: Op) {
    useScene.getState().apply(op);
  }
  reject(op: Op, message = "connection closed") {
    useScene.getState().rejectPending(op.opId, message);
  }
}

// Il nodo che un op di cancellazione bersaglia (null se non è un deleteNode):
// serve a distinguere QUALE voce di undo è stata consumata.
function deletedId(op: Op): string | null {
  return op.kind.case === "deleteNode" ? op.kind.value.id : null;
}

function rectNode(id: string, x: number, y: number, width = 100, height = 80) {
  return create(NodeSchema, {
    id, parentId: "page1", orderKey: "a0", name: "Rect", visible: true, opacity: 1,
    x, y, width, height,
    shape: { case: "rect", value: { cornerRadius: 0 } },
  });
}

function createOp(id: string, x: number, y: number): Op {
  return create(OpSchema, {
    opId: "new-" + id, docId: "doc1",
    kind: { case: "createNode", value: { node: rectNode(id, x, y) } },
  });
}

function moveOp(id: string, x: number, y: number): Op {
  return create(OpSchema, {
    opId: `mv-${id}-${x}-${y}`, docId: "doc1",
    kind: {
      case: "setProps",
      value: { id, patch: create(NodeSchema, { x, y }), mask: { paths: ["x", "y"] } },
    },
  });
}

function resizeOp(id: string, width: number, height: number): Op {
  return create(OpSchema, {
    opId: `rs-${id}-${width}`, docId: "doc1",
    kind: {
      case: "setProps",
      value: { id, patch: create(NodeSchema, { width, height }), mask: { paths: ["width", "height"] } },
    },
  });
}

function deleteOp(id: string): Op {
  return create(OpSchema, {
    opId: `del-${id}`, docId: "doc1",
    kind: { case: "deleteNode", value: { id } },
  });
}

// Wrapper: apre e chiude un gesto in un colpo solo, come farebbe un tool a
// fine drag. È la forma con cui i test costruiscono "un gesto" per lo stack.
function gesture(finalOps: Op[]) {
  const st = useScene.getState();
  st.beginGesture();
  st.endGesture(finalOps);
}

describe("undo/redo", () => {
  let sync: FakeSync;

  beforeEach(() => {
    sync = new FakeSync();
    useScene.setState({
      selection: [],
      marquee: null,
      gesture: null,
      undoStack: [],
      redoStack: [],
    });
    // setScene e non setState({scene}): installa una scena COERENTE (vista e
    // confermato allineati, coda vuota) -- l'invariante su cui poggia la
    // riconciliazione confermato/pending (vedi store.ts).
    useScene.getState().setScene(emptyScene("doc1", "Untitled"));
    useScene.getState().setSync(sync);
  });

  it("crea -> sposta -> resize: tre undo svuotano la scena, tre redo la ricostruiscono identica", () => {
    const st = useScene.getState();

    gesture([createOp("n1", 0, 0)]);
    gesture([moveOp("n1", 40, 40)]);
    gesture([resizeOp("n1", 200, 160)]);

    const finalScene = useScene.getState().scene;
    expect(finalScene!.nodes["n1"]).toMatchObject({ x: 40, y: 40, width: 200, height: 160 });
    expect(useScene.getState().undoStack).toHaveLength(3);
    expect(useScene.getState().canUndo).toBe(true);
    expect(useScene.getState().redoStack).toHaveLength(0);
    expect(useScene.getState().canRedo).toBe(false);

    st.undo();
    st.undo();
    st.undo();

    expect(useScene.getState().scene!.nodes["n1"]).toBeUndefined();
    expect(useScene.getState().undoStack).toHaveLength(0);
    expect(useScene.getState().canUndo).toBe(false);
    expect(useScene.getState().redoStack).toHaveLength(3);
    expect(useScene.getState().canRedo).toBe(true);

    st.redo();
    st.redo();
    st.redo();

    expect(useScene.getState().scene).toEqual(finalScene);
    expect(useScene.getState().redoStack).toHaveLength(0);
    expect(useScene.getState().undoStack).toHaveLength(3);
  });

  it("undo manda l'inverso tramite sync.submit e sposta la voce nel redo stack", () => {
    gesture([createOp("n1", 0, 0)]);
    sync.sent = [];

    useScene.getState().undo();

    expect(sync.sent).toHaveLength(1);
    expect(sync.sent[0].kind.case).toBe("deleteNode");
    expect(useScene.getState().scene!.nodes["n1"]).toBeUndefined();
    expect(useScene.getState().undoStack).toHaveLength(0);
    expect(useScene.getState().redoStack).toHaveLength(1);
  });

  it("un op ricevuto da un altro client non altera gli stack", () => {
    gesture([createOp("n1", 0, 0)]);
    expect(useScene.getState().undoStack).toHaveLength(1);

    // arriva via apply() (equivalente a SyncClient.consume() per un op REMOTO):
    // non passa da endGesture, quindi non deve toccare lo stack.
    useScene.getState().apply(createOp("n2", 500, 500));

    expect(useScene.getState().undoStack).toHaveLength(1);
    expect(useScene.getState().redoStack).toHaveLength(0);
    expect(useScene.getState().scene!.nodes["n2"]).toBeDefined();
  });

  it("un nuovo gesto dopo un undo svuota il redo stack", () => {
    gesture([createOp("n1", 0, 0)]);
    gesture([createOp("n2", 100, 100)]);

    useScene.getState().undo(); // annulla la creazione di n2
    expect(useScene.getState().redoStack).toHaveLength(1);

    gesture([createOp("n3", 200, 200)]);

    expect(useScene.getState().redoStack).toHaveLength(0);
    expect(useScene.getState().canRedo).toBe(false);
    expect(useScene.getState().undoStack).toHaveLength(2);
  });

  it("undo/redo su uno stack vuoto sono no-op silenziosi", () => {
    useScene.getState().undo();
    useScene.getState().redo();

    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().undoStack).toHaveLength(0);
    expect(useScene.getState().redoStack).toHaveLength(0);
  });

  it("un gesto senza op finali non lascia una voce nello stack undo", () => {
    const st = useScene.getState();
    st.beginGesture();
    st.applyLocal(moveOp("n1", 7, 7));
    st.endGesture([]);

    expect(useScene.getState().undoStack).toHaveLength(0);
  });

  // --- redo stack svuotato anche senza voce di undo (bug trovato in review) --
  // invertChain() aborta a null al PRIMO op della catena che non si può
  // invertire, ma gli op finali vengono submittati comunque: il documento è
  // già cambiato per davvero. Se in quel caso il redo stack restasse pieno, un
  // redo successivo rimetterebbe in gioco inversi calcolati su uno stato che
  // non esiste più, riscrivendo in silenzio il lavoro appena fatto.

  it("un gesto con effetto reale svuota il redo stack anche quando la voce di undo non si può costruire", () => {
    const st = useScene.getState();
    gesture([createOp("n1", 0, 0), createOp("n2", 300, 0)]);
    gesture([moveOp("n1", 40, 40)]);

    st.undo(); // n1 torna a (0,0); il redo stack contiene "rimetti n1 a (40,40)"
    expect(useScene.getState().scene!.nodes["n1"]).toMatchObject({ x: 0, y: 0 });
    expect(useScene.getState().redoStack).toHaveLength(1);
    expect(useScene.getState().undoStack).toHaveLength(1);
    sync.sent = [];

    // Nuovo gesto: drag di n1 e n2 insieme. A metà drag un client remoto
    // cancella n2 -> l'op arriva via apply() e fa avanzare il CONFERMATO,
    // quindi la base ricalcolata a fine gesto non ha più n2.
    st.beginGesture();
    st.apply(deleteOp("n2"));
    st.endGesture([moveOp("n1", 999, 999), moveOp("n2", 999, 0)]);

    // Lo spostamento di n1 è avvenuto per davvero (è stato submittato).
    expect(useScene.getState().scene!.nodes["n1"]).toMatchObject({ x: 999, y: 999 });
    expect(sync.sent).toHaveLength(2);
    // La catena di inversi non si può costruire (n2 non c'è più): nessuna voce
    // di undo nuova -- annullare a metà sarebbe peggio.
    expect(useScene.getState().undoStack).toHaveLength(1);
    // ...ma il redo stack DEVE essere vuoto lo stesso.
    expect(useScene.getState().redoStack).toHaveLength(0);
    expect(useScene.getState().canRedo).toBe(false);

    // E un redo() non deve poter riportare n1 a (40,40).
    st.redo();
    expect(useScene.getState().scene!.nodes["n1"]).toMatchObject({ x: 999, y: 999 });
    expect(useScene.getState().redoStack).toHaveLength(0);
  });

  // --- undo/redo con un gesto aperto (bug trovato in review) ---------------
  // sync.submit farebbe entrare l'inverso nella BASE del gesto (il confermato
  // più gli op in volo), quella da cui endGesture ricostruisce la scena al
  // pointerup, corrompendo sia il drag in corso sia lo stack.
  // undo()/redo() devono quindi essere no-op finché
  // il gesto non chiude.

  it("undo() durante un gesto aperto è un no-op: non tocca lo stack né manda nulla", () => {
    gesture([createOp("n1", 0, 0)]); // E1 = deleteNode, in cima allo stack
    sync.sent = [];

    const st = useScene.getState();
    st.beginGesture(); // il drag di selectTool apre il gesto
    st.applyLocal(moveOp("n1", 999, 999)); // anteprima a metà drag

    st.undo(); // Ctrl+Z premuto mentre il mouse è ancora giù

    expect(sync.sent).toHaveLength(0); // niente inviato: né l'inverso, né altro
    expect(useScene.getState().undoStack).toHaveLength(1); // E1 ancora lì
    expect(useScene.getState().redoStack).toHaveLength(0);
    expect(useScene.getState().gesture).not.toBeNull(); // il gesto resta aperto
    expect(useScene.getState().scene!.nodes["n1"]).toMatchObject({ x: 999, y: 999 }); // anteprima intatta

    // il drag prosegue e chiude normalmente: deve produrre una voce di undo
    // corretta per lo SPOSTAMENTO, non per la creazione (E1 va ancora bene).
    st.endGesture([moveOp("n1", 40, 40)]);

    expect(useScene.getState().scene!.nodes["n1"]).toMatchObject({ x: 40, y: 40 });
    expect(useScene.getState().undoStack).toHaveLength(2);
    expect(sync.sent).toHaveLength(1);
    expect(sync.sent[0].kind.case).toBe("setProps");

    // e i due undo funzionano nell'ordine giusto: prima disfa il move, poi la creazione.
    st.undo();
    expect(useScene.getState().scene!.nodes["n1"]).toMatchObject({ x: 0, y: 0 });
    st.undo();
    expect(useScene.getState().scene!.nodes["n1"]).toBeUndefined();
  });

  it("redo() durante un gesto aperto è un no-op: non tocca lo stack né manda nulla", () => {
    gesture([createOp("n1", 0, 0)]);
    useScene.getState().undo(); // n1 sparisce, E1 va nel redo stack
    sync.sent = [];

    const st = useScene.getState();
    st.beginGesture(); // un altro gesto (es. su un nodo diverso) è aperto
    st.redo(); // Ctrl+Shift+Z premuto a metà drag

    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().redoStack).toHaveLength(1); // voce ancora lì
    expect(useScene.getState().undoStack).toHaveLength(0);
    expect(useScene.getState().gesture).not.toBeNull();

    st.cancelGesture();
    st.redo(); // fuori dal gesto torna a funzionare
    expect(useScene.getState().scene!.nodes["n1"]).toBeDefined();
    expect(useScene.getState().redoStack).toHaveLength(0);
  });

  it("un gesto multi-nodo (drag di due nodi) si annulla in UN SOLO undo", () => {
    gesture([createOp("n1", 0, 0), createOp("n2", 300, 0)]);
    gesture([moveOp("n1", 10, 10), moveOp("n2", 310, 10)]);

    expect(useScene.getState().undoStack).toHaveLength(2);

    useScene.getState().undo(); // annulla il drag di ENTRAMBI i nodi in un colpo

    expect(useScene.getState().scene!.nodes["n1"]).toMatchObject({ x: 0, y: 0 });
    expect(useScene.getState().scene!.nodes["n2"]).toMatchObject({ x: 300, y: 0 });
  });

  // --- rollback e storia (bug trovato in review) -----------------------------
  // endGesture spinge la voce di undo e svuota il redo PRIMA che gli op siano
  // stati accettati -- deve, altrimenti Ctrl+Z subito dopo un drag dovrebbe
  // aspettare il giro di rete. Se poi il server li rifiuta, quella voce resta
  // sullo stack con inversi calcolati su uno stato che il server non ha MAI
  // raggiunto: il rollback toglieva la modifica dalla vista e lasciava intatta
  // la storia.

  it("un gesto RIFIUTATO non lascia una voce di undo fantasma", () => {
    gesture([createOp("n1", 0, 0)]); // gesto VERO, accettato ed ecoato
    expect(useScene.getState().undoStack).toHaveLength(1);

    useScene.getState().setSync(new RejectingSync());
    gesture([createOp("n5", 10, 10)]); // il server lo rifiuta

    // La modifica sparisce dalla vista (già così) E dalla storia (il fix): la
    // sua voce sarebbe [deleteNode n5], e n5 sul server non è mai esistito.
    expect(useScene.getState().scene!.nodes["n5"]).toBeUndefined();
    expect(useScene.getState().undoStack).toHaveLength(1);
    expect(useScene.getState().canUndo).toBe(true);
    expect(useScene.getState().lastError).toContain("node already exists");

    // Il Ctrl+Z successivo deve annullare il gesto VERO. Senza la riparazione
    // consumerebbe la voce fantasma mandando deleteNode n5 -> ErrNodeNotFound
    // -> InvalidArgument -> altro rollback e altro banner, e il gesto
    // precedente resterebbe NON annullato.
    useScene.getState().setSync(sync);
    sync.sent = [];
    useScene.getState().undo();

    expect(sync.sent).toHaveLength(1);
    expect(deletedId(sync.sent[0])).toBe("n1");
    expect(useScene.getState().scene!.nodes["n1"]).toBeUndefined();
  });

  it("il redo svuotato da un gesto RIFIUTATO torna disponibile", () => {
    gesture([createOp("n1", 0, 0)]);
    useScene.getState().undo(); // il "futuro" (ricrea n1) entra nel redo stack
    expect(useScene.getState().redoStack).toHaveLength(1);

    useScene.getState().setSync(new RejectingSync());
    gesture([createOp("n5", 10, 10)]); // svuota il redo... e viene rifiutato

    // Il redo era stato invalidato da una modifica MAI avvenuta: deve tornare.
    expect(useScene.getState().scene!.nodes["n5"]).toBeUndefined();
    expect(useScene.getState().redoStack).toHaveLength(1);
    expect(useScene.getState().canRedo).toBe(true);

    useScene.getState().setSync(sync);
    useScene.getState().redo();
    expect(useScene.getState().scene!.nodes["n1"]).toBeDefined();
  });

  it("un undo RIFIUTATO non consuma la sua voce", () => {
    gesture([createOp("n1", 0, 0)]);

    useScene.getState().setSync(new RejectingSync("disk full"));
    useScene.getState().undo(); // l'inverso non arriva mai al documento

    // La vista è tornata indietro (n1 c'è ancora), quindi anche la storia deve:
    // la voce va rimessa dov'era e il redo non ha guadagnato niente.
    expect(useScene.getState().scene!.nodes["n1"]).toBeDefined();
    expect(useScene.getState().undoStack).toHaveLength(1);
    expect(useScene.getState().canUndo).toBe(true);
    expect(useScene.getState().redoStack).toHaveLength(0);
    expect(useScene.getState().canRedo).toBe(false);

    // ...e riprovare deve funzionare: il rifiuto non brucia l'annullamento.
    useScene.getState().setSync(sync);
    useScene.getState().undo();
    expect(useScene.getState().scene!.nodes["n1"]).toBeUndefined();
  });

  it("un gesto CONFERMATO non è più annullabile da un rifiuto successivo", () => {
    gesture([createOp("n1", 0, 0)]); // confermato dall'eco di FakeSync

    useScene.getState().setSync(new RejectingSync());
    gesture([moveOp("n1", 40, 40)]); // rifiutato

    // Solo la transizione rifiutata viene riavvolta: quella confermata resta.
    expect(useScene.getState().scene!.nodes["n1"]).toMatchObject({ x: 0, y: 0 });
    expect(useScene.getState().undoStack).toHaveLength(1);
    expect(useScene.getState().canUndo).toBe(true);
  });

  // --- gesti MULTI-OP atterrati a metà (bug trovato in review round 2) --------
  // Un gesto è il pezzo unitario dell'undo, ma NON del trasporto: l'outbox
  // manda un op alla volta e un fallimento scarta solo la coda dietro
  // (rpc/syncClient.ts). E i gesti multi-op sono la norma, non un caso limite:
  // selectTool emette un setProps per nodo selezionato sul drag e sul resize, e
  // un deleteNode per nodo su Canc. Riavvolgere l'INTERA voce di undo perché
  // l'ultimo op del gruppo è caduto cancella l'annullabilità della metà che
  // invece si è persistita.

  it("un gesto multi-op atterrato a METÀ tiene la voce di undo della parte passata", () => {
    gesture([createOp("n1", 0, 0), createOp("n2", 300, 0)]);
    expect(useScene.getState().undoStack).toHaveLength(1);

    // Drag di n1+n2: due setProps, un solo gesto, una sola voce di undo.
    const manual = new ManualSync();
    useScene.getState().setSync(manual);
    const mv1 = moveOp("n1", 40, 40);
    const mv2 = moveOp("n2", 340, 40);
    gesture([mv1, mv2]);
    expect(useScene.getState().undoStack).toHaveLength(2);

    // mv1 passa (200 OK) ma il suo eco non è ancora arrivato; mv2 muore.
    manual.reject(mv2);

    // La vista: n1 è rimasto spostato (ottimistico, in volo), n2 è tornato.
    expect(useScene.getState().scene!.nodes["n1"]).toMatchObject({ x: 40, y: 40 });
    expect(useScene.getState().scene!.nodes["n2"]).toMatchObject({ x: 300, y: 0 });
    // La voce di undo NON sparisce: coprirebbe uno spostamento che sul server
    // è avvenuto per davvero, e senza di lei n1 resta mosso e non annullabile.
    // Resta però ristretta alla sola metà atterrata.
    expect(useScene.getState().undoStack).toHaveLength(2);
    expect(useScene.getState().undoStack[1]).toHaveLength(1);
    expect(useScene.getState().canUndo).toBe(true);

    // ...e l'eco che arriva DOPO il rifiuto non la cancella (prima del fix il
    // mark era già sparito e confirmHistory era un no-op).
    manual.land(mv1);
    expect(useScene.getState().undoStack).toHaveLength(2);
    expect(useScene.getState().pending).toHaveLength(0);

    // Ctrl+Z annulla esattamente la metà che è passata: un solo op sul filo,
    // n1 torna al punto di partenza, n2 non viene toccato.
    useScene.getState().setSync(sync);
    sync.sent = [];
    useScene.getState().undo();

    expect(sync.sent).toHaveLength(1);
    expect(useScene.getState().scene!.nodes["n1"]).toMatchObject({ x: 0, y: 0 });
    expect(useScene.getState().scene!.nodes["n2"]).toMatchObject({ x: 300, y: 0 });
  });

  it("una CANCELLAZIONE multi-nodo atterrata a metà resta annullabile per il nodo cancellato", () => {
    gesture([createOp("n1", 0, 0), createOp("n2", 300, 0)]);

    // Canc con due nodi selezionati: un deleteNode per nodo, un solo gesto.
    const manual = new ManualSync();
    useScene.getState().setSync(manual);
    const del1 = deleteOp("n1");
    const del2 = deleteOp("n2");
    gesture([del1, del2]);

    manual.land(del1); // il primo è nell'op-log: n1 è cancellato per davvero
    manual.reject(del2); // il secondo no

    expect(useScene.getState().scene!.nodes["n1"]).toBeUndefined();
    expect(useScene.getState().scene!.nodes["n2"]).toBeDefined();
    // Senza la riparazione la voce [createNode n1, createNode n2] veniva
    // buttata via intera: n1 cancellato per sempre, nessun Ctrl+Z possibile.
    expect(useScene.getState().undoStack).toHaveLength(2);
    expect(useScene.getState().undoStack[1]).toHaveLength(1);

    useScene.getState().setSync(sync);
    sync.sent = [];
    useScene.getState().undo();

    expect(sync.sent).toHaveLength(1);
    expect(sync.sent[0].kind.case).toBe("createNode");
    expect(useScene.getState().scene!.nodes["n1"]).toBeDefined();
  });

  it("un gesto atterrato a metà NON riarma il redo stack che aveva svuotato", () => {
    gesture([createOp("n1", 0, 0), createOp("n2", 300, 0)]);
    gesture([moveOp("n1", 40, 40)]);
    useScene.getState().undo(); // n1 torna a (0,0); il redo ha "rimettilo a (40,40)"
    expect(useScene.getState().redoStack).toHaveLength(1);

    const manual = new ManualSync();
    useScene.getState().setSync(manual);
    const mv1 = moveOp("n1", 999, 999);
    const mv2 = moveOp("n2", 999, 0);
    gesture([mv1, mv2]); // svuota il redo; mv1 passa, mv2 no
    manual.land(mv1);
    manual.reject(mv2);

    // Il documento è cambiato per davvero (n1 è a 999,999 sul server): la voce
    // di redo inverte uno stato che non esiste più. Riarmarla è la stessa
    // sovrascrittura silenziosa che lo svuotamento incondizionato esiste per
    // impedire (vedi endGesture) -- un redo rimetterebbe n1 a (40,40).
    expect(useScene.getState().redoStack).toHaveLength(0);
    expect(useScene.getState().canRedo).toBe(false);

    useScene.getState().setSync(sync);
    useScene.getState().redo();
    expect(useScene.getState().scene!.nodes["n1"]).toMatchObject({ x: 999, y: 999 });
  });

  it("un gesto multi-op rifiutato dal PRIMO op riavvolge tutta la voce", () => {
    gesture([createOp("n1", 0, 0)]);

    const manual = new ManualSync();
    useScene.getState().setSync(manual);
    const c2 = createOp("n2", 300, 0);
    const c3 = createOp("n3", 600, 0);
    gesture([c2, c3]);
    expect(useScene.getState().undoStack).toHaveLength(2);

    // Nessuno dei due è atterrato: il drain annulla la coda DAL FONDO.
    manual.reject(c3);
    manual.reject(c2);

    // Qui il riavvolgimento totale è quello giusto: la transizione non è mai
    // avvenuta, quindi la voce sparisce e il redo torna com'era.
    expect(useScene.getState().scene!.nodes["n2"]).toBeUndefined();
    expect(useScene.getState().scene!.nodes["n3"]).toBeUndefined();
    expect(useScene.getState().undoStack).toHaveLength(1);

    useScene.getState().setSync(sync);
    sync.sent = [];
    useScene.getState().undo();
    expect(deletedId(sync.sent[0])).toBe("n1"); // il gesto VERO
  });

  it("un undo atterrato a metà lascia sullo stack solo la parte non disfatta", () => {
    gesture([createOp("n1", 0, 0), createOp("n2", 300, 0)]);
    // La voce è [deleteNode n2, deleteNode n1]: si disfa nell'ordine inverso.
    expect(useScene.getState().undoStack[0]).toHaveLength(2);

    const manual = new ManualSync();
    useScene.getState().setSync(manual);
    useScene.getState().undo();
    const [first, second] = manual.sent;

    manual.land(first); // n2 è cancellato sul server
    manual.reject(second); // n1 no

    expect(useScene.getState().scene!.nodes["n2"]).toBeUndefined();
    expect(useScene.getState().scene!.nodes["n1"]).toBeDefined();
    // Rimettere la voce INTERA (com'era prima del fix) significherebbe che il
    // Ctrl+Z successivo rimanda deleteNode n2 su un nodo che il server ha già
    // cancellato -> ErrNodeNotFound -> altro rollback, voce bruciata.
    expect(useScene.getState().undoStack).toHaveLength(1);
    expect(useScene.getState().undoStack[0]).toHaveLength(1);
    // ...e la metà DISFATTA è ridiventata rifacibile.
    expect(useScene.getState().redoStack).toHaveLength(1);
    expect(useScene.getState().redoStack[0]).toHaveLength(1);

    useScene.getState().setSync(sync);
    sync.sent = [];
    useScene.getState().undo();
    expect(sync.sent).toHaveLength(1);
    expect(deletedId(sync.sent[0])).toBe("n1");
    expect(useScene.getState().scene!.nodes["n1"]).toBeUndefined();
  });

  it("un redo atterrato a metà lascia sullo stack solo la parte non rifatta", () => {
    gesture([createOp("n1", 0, 0), createOp("n2", 300, 0)]);
    useScene.getState().undo(); // entrambi spariscono; il redo li ricrea
    expect(useScene.getState().redoStack[0]).toHaveLength(2);

    const manual = new ManualSync();
    useScene.getState().setSync(manual);
    useScene.getState().redo();
    const [first, second] = manual.sent;

    manual.land(first); // il primo nodo è di nuovo nell'op-log
    manual.reject(second); // il secondo no

    expect(useScene.getState().redoStack).toHaveLength(1);
    expect(useScene.getState().redoStack[0]).toHaveLength(1);
    // ...e la metà rifatta è di nuovo annullabile.
    expect(useScene.getState().undoStack).toHaveLength(1);
    expect(useScene.getState().undoStack[0]).toHaveLength(1);

    useScene.getState().setSync(sync);
    useScene.getState().redo();
    expect(Object.keys(useScene.getState().scene!.nodes).sort()).toEqual(["n1", "n2"]);
  });
});
