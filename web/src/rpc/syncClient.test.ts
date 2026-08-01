import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Code, ConnectError } from "@connectrpc/connect";
import { create } from "@bufbuild/protobuf";
import { DocumentSchema, NodeSchema, OpSchema, ServerMsgSchema } from "../gen/brawt/v1/brawt_pb";
import type { Node as PbNode, Op, ServerMsg } from "../gen/brawt/v1/brawt_pb";

// Doppio del trasporto Connect: SyncClient importa `docClient` da ./client, e
// questo è l'unico punto in cui tocca la rete. vi.hoisted perché la factory di
// vi.mock viene issata sopra gli import.
const rpc = vi.hoisted(() => ({
  openDocument: vi.fn(),
  submitOp: vi.fn(),
  subscribe: vi.fn(),
}));
vi.mock("./client", () => ({ docClient: rpc }));

import { MAX_OUTBOX, SyncClient } from "./syncClient";
import { useScene } from "../store/store";

const CLIENT = "client-A";
const OTHER = "client-B";

function rectNode(id: string, x: number, y: number): PbNode {
  return create(NodeSchema, {
    id, parentId: "page1", orderKey: "a0", name: id, visible: true, opacity: 1,
    x, y, width: 100, height: 80,
    shape: { case: "rect", value: { cornerRadius: 0 } },
  });
}

function moveOp(opId: string, id: string, x: number, y: number): Op {
  return create(OpSchema, {
    opId, docId: "doc1",
    kind: {
      case: "setProps",
      value: { id, patch: create(NodeSchema, { x, y }), mask: { paths: ["x", "y"] } },
    },
  });
}

function createOp(opId: string, id: string): Op {
  return create(OpSchema, {
    opId, docId: "doc1",
    kind: { case: "createNode", value: { node: rectNode(id, 0, 0) } },
  });
}

function applied(seq: number, clientId: string, op: Op): ServerMsg {
  return create(ServerMsgSchema, {
    kind: { case: "applied", value: { seq: BigInt(seq), clientId, op } },
  });
}

// Stream server->client pilotabile a mano: `push` consegna un record al loop di
// consume(), `close` lo fa terminare a fine test (altrimenti resterebbe appeso
// su una promise che nessuno risolve), `fail` lo fa MORIRE con un errore --
// esattamente i due modi in cui il server lo termina di sua iniziativa
// (subscriber troppo lento, since_seq fuori range).
function channel<T>() {
  const queue: T[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  let failure: unknown = null;
  return {
    push(v: T) {
      queue.push(v);
      wake?.();
      wake = null;
    },
    close() {
      closed = true;
      wake?.();
      wake = null;
    },
    fail(err: unknown) {
      failure = err;
      closed = true;
      wake?.();
      wake = null;
    },
    async *[Symbol.asyncIterator](): AsyncGenerator<T> {
      for (;;) {
        while (queue.length > 0) yield queue.shift() as T;
        if (failure) throw failure;
        if (closed) return;
        await new Promise<void>((r) => {
          wake = r;
        });
      }
    },
  };
}

// Un giro di macrotask: basta a far girare sia le catene di microtask
// (submitOp.then/.catch) sia il risveglio del for-await su channel.
const flush = () => new Promise((r) => setTimeout(r, 0));

// Attesa deterministica lunga `n` turni di microtask. Due catene avviate
// insieme finiscono in ordine di LUNGHEZZA, non di partenza: è il modo (senza
// timer, quindi senza flakiness) di simulare una rete che consegna le richieste
// fuori ordine.
function turns(n: number): Promise<void> {
  let p = Promise.resolve();
  for (let i = 0; i < n; i++) p = p.then(() => undefined);
  return p;
}

// Trasporto AVVERSARIALE. Il server assegna il seq in ordine di ARRIVO
// (internal/server/hub.go: Submit serializza sul mutex, chi arriva prima
// vince), quindi l'ordine persistito è quello con cui le richieste raggiungono
// l'hub -- NON quello con cui il client le ha emesse. Qui ogni richiesta
// "viaggia" per un numero DECRESCENTE di turni: se il client ne lascia più di
// una in volo insieme, arrivano in ordine INVERTITO. L'unico modo di far
// arrivare gli op in ordine di invio è mandarne uno alla volta.
const TRAVEL = 32; // > del numero di op usati nei test, così i turni restano positivi

function reorderingTransport() {
  const arrived: string[] = [];
  const failures = new Map<string, unknown>();
  let dispatched = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  let seq = 0;
  // mockReset: butta via il mockResolvedValue di boot() e qualunque coda di
  // *Once lasciata da un test precedente, così l'implementazione qui sotto è
  // l'unica che risponde.
  rpc.submitOp.mockReset();
  rpc.submitOp.mockImplementation(async (req: { op: Op }) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await turns(TRAVEL - dispatched++);
    inFlight -= 1;
    arrived.push(req.op.opId);
    const err = failures.get(req.op.opId);
    if (err) throw err;
    return { ack: { opId: req.op.opId, seq: BigInt(++seq) } };
  });
  return {
    arrived,
    failOn: (opId: string, err: unknown) => failures.set(opId, err),
    maxInFlight: () => maxInFlight,
  };
}

async function boot(nodes: Record<string, PbNode>) {
  const stream = channel<ServerMsg>();
  rpc.openDocument.mockResolvedValue({
    snapshot: create(DocumentSchema, {
      id: "doc1", name: "Untitled", schemaVersion: 1,
      pages: [{ id: "page1", name: "Page 1" }], nodes,
    }),
    seq: 0n,
  });
  rpc.subscribe.mockReturnValue(stream);
  rpc.submitOp.mockResolvedValue({ ack: { opId: "", seq: 1n } });
  const sync = new SyncClient("doc1", CLIENT);
  await sync.start();
  await flush();
  return { sync, stream };
}

describe("SyncClient: modello confermato/pending", () => {
  // Il console.error resta (serve allo sviluppatore) ma non è più l'UNICO
  // posto in cui i fallimenti finiscono: qui li zittiamo e li verifichiamo.
  // Spy condiviso perché ogni test chiude il proprio stream in fondo, e la
  // chiusura è di per sé un fallimento che va loggato.
  let logged: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    logged = vi.spyOn(console, "error").mockImplementation(() => {});
    useScene.setState({
      scene: null, confirmed: null, pending: [], lastError: null, syncError: null,
      selection: [], marquee: null, gesture: null, sync: null,
      undoStack: [], redoStack: [], canUndo: false, canRedo: false, history: [],
    });
  });

  afterEach(() => {
    logged.mockRestore();
  });

  it("un op RIFIUTATO dal server sparisce dalla vista e riporta l'errore", async () => {
    const { sync, stream } = await boot({ n1: rectNode("n1", 0, 0) });

    let rejectSubmit!: (e: unknown) => void;
    rpc.submitOp.mockReturnValueOnce(
      new Promise((_res, rej) => {
        rejectSubmit = rej;
      }),
    );

    sync.submit(moveOp("op-mine", "n1", 999, 999));
    // Apply ottimistico: la modifica si vede subito, prima di qualunque risposta.
    expect(useScene.getState().scene!.nodes["n1"]).toMatchObject({ x: 999, y: 999 });

    rejectSubmit(new Error("node already exists"));
    await flush();

    // Il server non l'ha mai accettata: la modifica DEVE sparire (in M0 restava
    // sullo schermo per sempre, persa al reload successivo).
    expect(useScene.getState().scene!.nodes["n1"]).toMatchObject({ x: 0, y: 0 });
    expect(useScene.getState().pending).toHaveLength(0);
    // ...e il fallimento deve essere VISIBILE, non solo un console.error.
    expect(useScene.getState().lastError).toContain("node already exists");
    expect(logged).toHaveBeenCalled();

    stream.close();
    await flush();
  });

  it("un op remoto arrivato mentre il proprio è in volo NON schiaccia la modifica ottimistica (rebase)", async () => {
    const { sync, stream } = await boot({
      n1: rectNode("n1", 0, 0),
      n2: rectNode("n2", 0, 0),
    });

    let resolveSubmit!: (v: unknown) => void;
    rpc.submitOp.mockReturnValueOnce(
      new Promise((res) => {
        resolveSubmit = res;
      }),
    );

    sync.submit(moveOp("op-mine", "n1", 200, 0));

    // L'altro client ha vinto la corsa: i SUOI record arrivano prima del nostro
    // eco. Il record su n1 è ordinato PRIMA del nostro op.
    stream.push(applied(1, OTHER, moveOp("op-them-1", "n1", 100, 0)));
    stream.push(applied(2, OTHER, moveOp("op-them-2", "n2", 333, 0)));
    await flush();

    const scene = useScene.getState().scene!;
    expect(scene.nodes["n2"]).toMatchObject({ x: 333 }); // la modifica remota non si perde
    expect(scene.nodes["n1"]).toMatchObject({ x: 200 }); // ...e nemmeno la nostra

    // Poi arriva il nostro eco: l'op diventa confermato e la coda si svuota.
    resolveSubmit({ ack: { opId: "op-mine", seq: 3n } });
    stream.push(applied(3, CLIENT, moveOp("op-mine", "n1", 200, 0)));
    await flush();

    expect(useScene.getState().scene!.nodes["n1"]).toMatchObject({ x: 200 });
    expect(useScene.getState().pending).toHaveLength(0);

    stream.close();
    await flush();
  });

  it("il proprio eco conferma l'op UNA volta sola e non lo riapplica sopra i record successivi", async () => {
    const { sync, stream } = await boot({ n1: rectNode("n1", 0, 0) });

    sync.submit(moveOp("op-mine", "n1", 200, 0));
    await flush();
    expect(useScene.getState().pending).toHaveLength(1);

    // L'eco del PROPRIO op non va scartato: è ciò che lo rende confermato.
    stream.push(applied(1, CLIENT, moveOp("op-mine", "n1", 200, 0)));
    await flush();
    expect(useScene.getState().pending).toHaveLength(0);
    expect(useScene.getState().confirmed!.nodes["n1"]).toMatchObject({ x: 200 });

    // Un record remoto successivo deve poter sovrascrivere: se l'op confermato
    // fosse rimasto anche in coda, il rebase lo riapplicherebbe sopra e n1
    // tornerebbe a 200 -- doppia applicazione dello stesso op.
    stream.push(applied(2, OTHER, moveOp("op-them", "n1", 50, 0)));
    await flush();
    expect(useScene.getState().scene!.nodes["n1"]).toMatchObject({ x: 50 });

    stream.close();
    await flush();
  });

  // --- morte dello stream ----------------------------------------------------
  // Subscribe è l'UNICA cosa che fa avanzare il confermato e che svuota la coda
  // degli op in volo: la sua morte non può restare invisibile. Prima di questo
  // fix `void this.consume()` non aveva né catch né try/catch, quindi la fine
  // dello stream era una unhandled rejection e NIENT'ALTRO -- confermato
  // congelato, coda che cresceva a ogni gesto, e la pillola di stato che
  // continuava a dire "connesso".

  it("uno stream che MUORE non resta silenzioso", async () => {
    const { sync, stream } = await boot({ n1: rectNode("n1", 0, 0) });
    expect(useScene.getState().syncError).toBeNull();

    // Caso reale: Subscribe risponde CodeOutOfRange quando since_seq è più
    // vecchio della history ormai compattata (l'altro è l'hub che chiude un
    // subscriber troppo lento). Entrambi partono dal SERVER: non serve una rete
    // che cade perché succeda.
    stream.fail(new ConnectError("since_seq too old", Code.OutOfRange));
    await flush();

    expect(useScene.getState().syncError).toContain("since_seq too old");
    expect(logged).toHaveBeenCalled();

    // Da qui in poi nessun eco può più confermare niente: l'op resta in coda
    // per sempre. È il wedge -- che adesso è però OSSERVABILE (pillola
    // "sconnesso" + banner in App.tsx) invece che silenzioso.
    sync.submit(moveOp("op-mine", "n1", 200, 0));
    await flush();
    expect(useScene.getState().pending).toHaveLength(1);
    expect(useScene.getState().syncError).not.toBeNull();
  });

  it("uno stream CHIUSO dal server è un fallimento come gli altri", async () => {
    const { stream } = await boot({ n1: rectNode("n1", 0, 0) });

    // Fine "pulita" del for-await: nessuna eccezione, ma il risultato per il
    // client è identico -- non arriverà più nessun record.
    stream.close();
    await flush();

    expect(useScene.getState().syncError).toContain("stream");
    expect(logged).toHaveBeenCalled();
  });

  // --- ordine di invio -------------------------------------------------------
  // Il seq lo assegna il SERVER in ordine di arrivo, quindi l'ordine persistito
  // è deciso dalla rete e non dall'utente. Con submit fire-and-forget più
  // richieste sono in volo insieme e il documento ricaricato può legittimamente
  // differire da quello sullo schermo: op19 (x=100) e op20 (x=200) partiti
  // insieme, op20 che arriva per primo, oplog [x=200, x=100], reload a x=100
  // mentre il canvas mostra 200.

  it("submit CONCORRENTI raggiungono il server nell'ORDINE DI INVIO", async () => {
    const { sync, stream } = await boot({ n1: rectNode("n1", 0, 0) });
    const net = reorderingTransport();

    // Cinque modifiche in rapida successione (due gesti ravvicinati, o un undo
    // subito dopo un drag): l'intento dell'utente È questo ordine, e x=500 deve
    // essere l'ultima cosa che il server persiste.
    const ids = ["op-1", "op-2", "op-3", "op-4", "op-5"];
    ids.forEach((opId, i) => sync.submit(moveOp(opId, "n1", (i + 1) * 100, 0)));
    await flush();

    expect(net.arrived).toEqual(ids);
    // ...e il modo in cui ci si arriva: una sola richiesta in volo alla volta.
    // Senza questo, l'ordine sarebbe solo una coincidenza dello scheduler.
    expect(net.maxInFlight()).toBe(1);

    stream.close();
    await flush();
  });

  it("se un op FALLISCE la coda si FERMA: i successivi non partono mai", async () => {
    const { sync, stream } = await boot({ n1: rectNode("n1", 0, 0) });
    const net = reorderingTransport();
    net.failOn("op-2", new ConnectError("node already exists", Code.InvalidArgument));

    sync.submit(moveOp("op-1", "n1", 100, 0));
    sync.submit(moveOp("op-2", "n1", 200, 0));
    sync.submit(moveOp("op-3", "n1", 300, 0));
    sync.submit(moveOp("op-4", "n1", 400, 0));
    // Apply ottimistico: tutti e quattro si vedono subito.
    expect(useScene.getState().scene!.nodes["n1"]).toMatchObject({ x: 400 });
    await flush();

    // op-3 e op-4 erano costruiti su uno stato (x=200) che il server non ha mai
    // raggiunto: mandarli vorrebbe dire persistere una modifica basata su una
    // premessa falsa. Non partono.
    expect(net.arrived).toEqual(["op-1", "op-2"]);
    expect(rpc.submitOp).toHaveBeenCalledTimes(2);

    // op-1 è passato e resta in volo in attesa del suo eco; op-2 (rifiutato) e
    // la coda dietro di lui escono dalla vista.
    expect(useScene.getState().pending.map((p) => p.opId)).toEqual(["op-1"]);
    expect(useScene.getState().scene!.nodes["n1"]).toMatchObject({ x: 100 });
    expect(useScene.getState().lastError).toContain("node already exists");
    expect(logged).toHaveBeenCalled();

    stream.close();
    await flush();
  });

  // Hub.Submit prende writeMu, appende, e fa il BROADCAST ai subscriber PRIMA
  // di scrivere la risposta della unary (internal/server/hub.go). Se la
  // connessione muore in quella finestra il client vede fallire una richiesta
  // che sul server è invece andata a buon fine -- e l'eco lo dimostra, perché è
  // già arrivato.
  it("un submit fallito DOPO che il server ha già applicato l'op non trascina giù la coda", async () => {
    const { sync, stream } = await boot({ n1: rectNode("n1", 0, 0) });

    const sent: string[] = [];
    let killFirst!: (e: unknown) => void;
    rpc.submitOp.mockReset();
    rpc.submitOp.mockImplementation((req: { op: Op }) => {
      sent.push(req.op.opId);
      if (req.op.opId === "op-1") {
        return new Promise((_res, rej) => {
          killFirst = rej;
        });
      }
      return Promise.resolve({ ack: { opId: req.op.opId, seq: 2n } });
    });

    sync.submit(moveOp("op-1", "n1", 100, 0));
    sync.submit(moveOp("op-2", "n1", 200, 0));
    await flush();
    expect(sent).toEqual(["op-1"]); // op-2 aspetta il suo turno

    // Il broadcast è già passato: op-1 è nell'op-log, quindi DURABILE.
    stream.push(applied(1, CLIENT, moveOp("op-1", "n1", 100, 0)));
    await flush();
    expect(useScene.getState().pending.map((p) => p.opId)).toEqual(["op-2"]);

    // ...e solo ADESSO la risposta HTTP muore.
    killFirst(new ConnectError("connection closed", Code.Unavailable));
    await flush();

    // La premessa di op-2 ("op-1 è sul server") è VERA: fermarlo butterebbe
    // via lavoro valido e mostrerebbe un errore per un op riuscito.
    expect(sent).toEqual(["op-1", "op-2"]);
    expect(useScene.getState().pending.map((p) => p.opId)).toEqual(["op-2"]);
    expect(useScene.getState().scene!.nodes["n1"]).toMatchObject({ x: 200 });
    expect(useScene.getState().lastError).toBeNull();
    expect(logged).toHaveBeenCalled(); // resta comunque in console

    stream.close();
    await flush();
  });

  // --- deadline e tetto della coda -------------------------------------------
  // Con l'outbox serializzato una richiesta che non si risolve mai non perde
  // più solo se stessa: blocca la testa, e ogni gesto successivo viene
  // applicato in ottimistico, accodato e mai spedito -- senza che nulla lo
  // segnali (lastError vuoto, syncError riguarda solo Subscribe, pillola
  // "connesso").

  it("un submit che NON SI RISOLVE MAI non blocca la coda per sempre: c'è una deadline", async () => {
    const { sync, stream } = await boot({ n1: rectNode("n1", 0, 0) });

    // Trasporto che ONORA la deadline della chiamata (come quello vero:
    // CallOptions.timeoutMs) e per il resto non risponde mai -- handler
    // bloccato, connessione finita nel nulla, laptop sospeso.
    const sent: { opId: string; timeoutMs?: number }[] = [];
    rpc.submitOp.mockReset();
    rpc.submitOp.mockImplementation(
      (req: { op: Op }, opts?: { timeoutMs?: number }) =>
        new Promise((_res, rej) => {
          sent.push({ opId: req.op.opId, timeoutMs: opts?.timeoutMs });
          if (opts?.timeoutMs && opts.timeoutMs > 0) {
            setTimeout(
              () => rej(new ConnectError("the operation timed out", Code.DeadlineExceeded)),
              opts.timeoutMs,
            );
          }
        }),
    );

    vi.useFakeTimers();
    try {
      sync.submit(moveOp("op-1", "n1", 100, 0));
      await vi.advanceTimersByTimeAsync(0);
      // Senza deadline richiesta la promise resta appesa e il drain non
      // riparte MAI: è l'unica cosa che rende il blocco finito.
      expect(sent[0].timeoutMs).toBeGreaterThan(0);

      // Nel frattempo l'utente continua a lavorare: tutto si accoda, niente parte.
      sync.submit(moveOp("op-2", "n1", 200, 0));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sent).toHaveLength(1);
      expect(useScene.getState().pending).toHaveLength(2);

      // Scaduta la deadline la richiesta muore: il wedge diventa un fallimento
      // osservabile invece di durare per sempre in silenzio.
      await vi.advanceTimersByTimeAsync(60_000);
    } finally {
      vi.useRealTimers();
    }

    expect(useScene.getState().lastError).toContain("timed out");
    expect(useScene.getState().pending).toHaveLength(0);
    expect(useScene.getState().scene!.nodes["n1"]).toMatchObject({ x: 0 });

    stream.close();
    await flush();
  });

  it("la coda ha un TETTO: il lavoro a rischio resta finito e il blocco visibile", async () => {
    const { sync, stream } = await boot({ n1: rectNode("n1", 0, 0) });

    // Caso peggiore: testa bloccata e nemmeno la deadline la salva (rete che
    // non risponde e timer fermi). Solo il tetto limita il danno.
    rpc.submitOp.mockReset();
    rpc.submitOp.mockImplementation(() => new Promise(() => {}));

    for (let i = 0; i < MAX_OUTBOX; i++) sync.submit(moveOp(`op-${i}`, "n1", i + 1, 0));
    await flush();
    expect(useScene.getState().pending).toHaveLength(MAX_OUTBOX);
    expect(useScene.getState().lastError).toBeNull();

    // L'op che sfonda il tetto non entra: viene rifiutato subito, con lo stesso
    // rollback e lo stesso banner di un rifiuto del server. Quelli già accodati
    // restano -- sono l'intento più vecchio e possono ancora partire.
    sync.submit(moveOp("op-over", "n1", 999, 0));
    await flush();

    expect(useScene.getState().pending).toHaveLength(MAX_OUTBOX);
    expect(useScene.getState().pending.some((p) => p.opId === "op-over")).toBe(false);
    expect(useScene.getState().scene!.nodes["n1"]).toMatchObject({ x: MAX_OUTBOX });
    expect(useScene.getState().lastError).toContain("troppe modifiche in attesa");

    stream.close();
    await flush();
  });

  // --- storia e rollback -----------------------------------------------------
  // endGesture spinge la voce di undo PRIMA di mandare l'op: se il tail-drop
  // scarta N gesti, senza riparazione restano N voci di undo i cui inversi
  // invertono uno stato che il server non ha mai avuto.

  it("un fallimento che scarta la coda riavvolge le voci di undo di TUTTA la raffica", async () => {
    const { stream } = await boot({});
    const net = reorderingTransport();
    net.failOn("op-a", new ConnectError("node already exists", Code.InvalidArgument));

    const st = useScene.getState();
    st.beginGesture();
    st.endGesture([createOp("op-a", "n1")]);
    st.beginGesture();
    st.endGesture([createOp("op-b", "n2")]);
    // Le voci ci sono subito: Ctrl+Z non può aspettare il giro di rete.
    expect(useScene.getState().undoStack).toHaveLength(2);
    await flush();

    // op-a rifiutato, op-b scartato con lui: nessuno dei due nodi esiste, e
    // nessuna delle due voci di undo ha più un senso -- annullarle manderebbe
    // deleteNode di nodi che il server non ha mai visto (ErrNodeNotFound), una
    // per volta, bruciando le voci dei gesti VERI più sotto.
    expect(net.arrived).toEqual(["op-a"]);
    expect(useScene.getState().scene!.nodes["n1"]).toBeUndefined();
    expect(useScene.getState().scene!.nodes["n2"]).toBeUndefined();
    expect(useScene.getState().undoStack).toHaveLength(0);
    expect(useScene.getState().canUndo).toBe(false);

    stream.close();
    await flush();
  });

  it("lo stop è per la coda, non per il client: un submit successivo riparte", async () => {
    const { sync, stream } = await boot({ n1: rectNode("n1", 0, 0) });
    const net = reorderingTransport();
    net.failOn("op-1", new ConnectError("disk full", Code.InvalidArgument));

    sync.submit(moveOp("op-1", "n1", 100, 0));
    await flush();
    expect(useScene.getState().pending).toHaveLength(0);
    expect(useScene.getState().scene!.nodes["n1"]).toMatchObject({ x: 0 });

    // Il rollback ha riportato la vista a quello che il server HA davvero: un
    // op successivo è costruito su una premessa vera e va mandato. Latchare il
    // client per sempre al primo InvalidArgument (un id duplicato, per dire)
    // vorrebbe dire congelare l'editor.
    sync.submit(moveOp("op-2", "n1", 700, 0));
    await flush();

    expect(net.arrived).toEqual(["op-1", "op-2"]);
    expect(useScene.getState().scene!.nodes["n1"]).toMatchObject({ x: 700 });

    stream.close();
    await flush();
  });
});
