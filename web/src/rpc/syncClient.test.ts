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

import { SyncClient } from "./syncClient";
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
      undoStack: [], redoStack: [], canUndo: false, canRedo: false,
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
});
