import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

function rectNode(id: string, x: number, y: number) {
  return create(NodeSchema, {
    id, parentId: "page1", orderKey: "a0", name: "Rect", visible: true, opacity: 1,
    x, y, width: 100, height: 80,
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
  return create(OpSchema, { opId: "del-" + id, docId: "doc1", kind: { case: "deleteNode", value: { id } } });
}

describe("gesture coalescing", () => {
  let sync: FakeSync;

  beforeEach(() => {
    sync = new FakeSync();
    useScene.setState({ selection: [], marquee: null, gesture: null });
    // setScene e non setState({scene}): installa una scena COERENTE (vista e
    // confermato allineati, coda vuota) -- l'invariante su cui poggia la
    // riconciliazione confermato/pending (vedi store.ts).
    useScene.getState().setScene(emptyScene("doc1", "Untitled"));
    useScene.getState().setSync(sync);
    // due nodi di partenza, creati fuori dal gesto
    sync.submit(createOp("n1", 0, 0));
    sync.submit(createOp("n2", 300, 0));
    sync.sent = [];
  });

  it("invia UN SOLO op per un drag di 20 pointermove (debito M0: ne mandava ~20)", () => {
    const st = useScene.getState();
    st.beginGesture();
    for (let i = 1; i <= 20; i++) st.applyLocal(moveOp("n1", i * 10, i * 5));

    // durante il gesto: anteprima locale aggiornata, ma niente sul filo
    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().scene!.nodes["n1"]).toMatchObject({ x: 200, y: 100 });

    st.endGesture([moveOp("n1", 200, 100)]);

    expect(sync.sent).toHaveLength(1);
    expect(useScene.getState().scene!.nodes["n1"]).toMatchObject({ x: 200, y: 100 });
  });

  it("un gesto su più nodi manda un op PER NODO, non uno per pointermove", () => {
    const st = useScene.getState();
    st.beginGesture();
    for (let i = 1; i <= 20; i++) {
      st.applyLocal(moveOp("n1", i, i));
      st.applyLocal(moveOp("n2", 300 + i, i));
    }
    st.endGesture([moveOp("n1", 20, 20), moveOp("n2", 320, 20)]);

    expect(sync.sent).toHaveLength(2);
    expect(useScene.getState().scene!.nodes["n1"]).toMatchObject({ x: 20, y: 20 });
    expect(useScene.getState().scene!.nodes["n2"]).toMatchObject({ x: 320, y: 20 });
  });

  it("lo stato finale è snapshot + op finali: le anteprime non restano attaccate", () => {
    const st = useScene.getState();
    st.beginGesture();
    // anteprima che tocca width/height, campi che l'op finale NON contiene
    st.applyLocal(resizeOp("n1", 999, 999));
    st.endGesture([moveOp("n1", 50, 60)]);

    const n1 = useScene.getState().scene!.nodes["n1"];
    expect(n1).toMatchObject({ x: 50, y: 60, width: 100, height: 80 });
  });

  it("cancelGesture riporta la scena allo stato di inizio gesto senza inviare nulla", () => {
    const before = useScene.getState().scene;
    const st = useScene.getState();
    st.beginGesture();
    for (let i = 1; i <= 20; i++) st.applyLocal(moveOp("n1", i * 10, i * 5));
    st.cancelGesture();

    expect(useScene.getState().scene).toEqual(before);
    expect(sync.sent).toHaveLength(0);
  });

  it("cancelGesture ripristina anche la selezione (gesto di cancellazione annullato)", () => {
    useScene.getState().setSelection(["n1", "n2"]);
    const st = useScene.getState();
    st.beginGesture();
    st.applyLocal(deleteOp("n1"));
    expect(useScene.getState().selection).toEqual(["n2"]); // invariante selezione

    st.cancelGesture();
    expect(useScene.getState().selection).toEqual(["n1", "n2"]);
    expect(useScene.getState().scene!.nodes["n1"]).toBeDefined();
  });

  it("un gesto senza op finali non cambia nulla e non manda nulla", () => {
    const before = useScene.getState().scene;
    const st = useScene.getState();
    st.beginGesture();
    st.applyLocal(moveOp("n1", 7, 7));
    st.endGesture([]);

    expect(useScene.getState().scene).toEqual(before);
    expect(sync.sent).toHaveLength(0);
  });

  it("endGesture chiude il gesto: un cancelGesture successivo non ripristina nulla", () => {
    const st = useScene.getState();
    st.beginGesture();
    st.applyLocal(moveOp("n1", 40, 40));
    st.endGesture([moveOp("n1", 40, 40)]);
    st.cancelGesture();

    expect(useScene.getState().scene!.nodes["n1"]).toMatchObject({ x: 40, y: 40 });
    expect(sync.sent).toHaveLength(1);
  });

  it("gesti consecutivi partono ognuno dal proprio snapshot", () => {
    const st = useScene.getState();
    st.beginGesture();
    st.applyLocal(moveOp("n1", 40, 40));
    st.endGesture([moveOp("n1", 40, 40)]);

    st.beginGesture();
    st.applyLocal(moveOp("n1", 900, 900));
    st.cancelGesture();

    // torna al risultato del PRIMO gesto, non allo stato iniziale
    expect(useScene.getState().scene!.nodes["n1"]).toMatchObject({ x: 40, y: 40 });
  });

  it("applyLocal fuori da un gesto aggiorna solo lo stato locale", () => {
    useScene.getState().applyLocal(moveOp("n1", 12, 34));
    expect(useScene.getState().scene!.nodes["n1"]).toMatchObject({ x: 12, y: 34 });
    expect(sync.sent).toHaveLength(0);
  });

  // --- op autorevoli arrivati MENTRE il gesto era aperto -------------------
  // apply() è la porta d'ingresso dello stream remoto (rpc/syncClient.ts): fa
  // avanzare il documento CONFERMATO, che è anche la base da cui endGesture e
  // cancelGesture ricostruiscono la scena. Quei record sopravvivono quindi per
  // costruzione: SyncClient avanza il proprio seq appena li consuma e non li
  // rivedrà mai più, quindi scartarli sarebbe desync permanente fino al reload.

  it("un op remoto arrivato durante il gesto sopravvive a endGesture", () => {
    const st = useScene.getState();
    st.beginGesture();
    st.applyLocal(moveOp("n1", 5, 5)); // anteprima del drag locale

    // l'altra tab crea un nodo e ne sposta un altro: arriva via apply()
    st.apply(createOp("n3", 700, 700));
    st.apply(moveOp("n2", 333, 44));

    st.applyLocal(moveOp("n1", 200, 100)); // il drag continua

    st.endGesture([moveOp("n1", 200, 100)]);

    const scene = useScene.getState().scene!;
    expect(scene.nodes["n1"]).toMatchObject({ x: 200, y: 100 }); // gesto locale
    expect(scene.nodes["n3"]).toBeDefined(); // creazione remota NON persa
    expect(scene.nodes["n2"]).toMatchObject({ x: 333, y: 44 }); // modifica remota NON persa
    expect(sync.sent).toHaveLength(1); // e sempre un solo op sul filo
  });

  it("un op remoto arrivato durante il gesto sopravvive a cancelGesture", () => {
    const st = useScene.getState();
    st.beginGesture();
    st.applyLocal(moveOp("n1", 900, 900));
    st.apply(createOp("n3", 700, 700));
    st.cancelGesture();

    const scene = useScene.getState().scene!;
    // annullare il PROPRIO gesto non annulla le modifiche ALTRUI
    expect(scene.nodes["n1"]).toMatchObject({ x: 0, y: 0 });
    expect(scene.nodes["n3"]).toBeDefined();
    expect(sync.sent).toHaveLength(0);
  });

  it("un delete remoto durante il gesto non resuscita il nodo con cancelGesture", () => {
    useScene.getState().setSelection(["n1", "n2"]);
    const st = useScene.getState();
    st.beginGesture();
    st.applyLocal(moveOp("n1", 40, 40));
    st.apply(deleteOp("n2")); // l'altra tab cancella n2

    st.cancelGesture();

    const scene = useScene.getState().scene!;
    expect(scene.nodes["n2"]).toBeUndefined();
    // la selezione ripristinata resta potata: niente maniglie su un nodo morto
    expect(useScene.getState().selection).toEqual(["n1"]);
  });

  it("un delete remoto durante il gesto pota la selezione anche dopo endGesture", () => {
    useScene.getState().setSelection(["n1", "n2"]);
    const st = useScene.getState();
    st.beginGesture();
    st.apply(deleteOp("n2"));
    st.endGesture([moveOp("n1", 40, 40)]);

    expect(useScene.getState().scene!.nodes["n2"]).toBeUndefined();
    expect(useScene.getState().selection).toEqual(["n1"]);
  });

  // --- selezione di nodi creati DAL gesto stesso ---------------------------
  // Il flusso "disegna e seleziona" dei Task 8/9: il tool crea il nodo in
  // anteprima con applyLocal, lo seleziona subito (le maniglie seguono il
  // drag) e a fine gesto manda il createNode definitivo. La selezione deve
  // sopravvivere: alla chiusura del gesto il nodo ESISTE.

  it("un nodo creato dagli op finali del gesto resta selezionato", () => {
    const st = useScene.getState();
    st.beginGesture();
    st.applyLocal(createOp("n9", 10, 10)); // anteprima del nodo che si sta disegnando
    st.setSelection(["n9"]); // il tool lo seleziona subito, a metà drag
    expect(useScene.getState().selection).toEqual(["n9"]);

    st.endGesture([createOp("n9", 10, 10)]);

    expect(useScene.getState().scene!.nodes["n9"]).toBeDefined();
    expect(useScene.getState().selection).toEqual(["n9"]);
  });

  it("resta selezionato anche il nodo creato da un op finale NON primo", () => {
    // La potatura non può avvenire op per op: dopo il primo createNode il
    // secondo nodo non esiste ancora e verrebbe buttato fuori per sempre.
    const st = useScene.getState();
    st.beginGesture();
    st.applyLocal(createOp("n9", 10, 10));
    st.applyLocal(createOp("n10", 20, 20));
    st.setSelection(["n9", "n10"]);

    st.endGesture([createOp("n9", 10, 10), createOp("n10", 20, 20)]);

    expect(useScene.getState().selection).toEqual(["n9", "n10"]);
  });

  it("un nodo di sola anteprima, non confermato dagli op finali, esce dalla selezione", () => {
    const st = useScene.getState();
    st.beginGesture();
    st.applyLocal(createOp("n9", 10, 10));
    st.setSelection(["n1", "n9"]);

    st.endGesture([]); // gesto abortito: nessun op finale, n9 non esiste davvero

    expect(useScene.getState().scene!.nodes["n9"]).toBeUndefined();
    expect(useScene.getState().selection).toEqual(["n1"]); // niente maniglie appese
  });

  it("una selezione cambiata a metà gesto su nodi esistenti sopravvive a endGesture", () => {
    useScene.getState().setSelection(["n1"]);
    const st = useScene.getState();
    st.beginGesture();
    st.setSelection(["n2"]); // il tool cambia selezione durante il gesto
    st.endGesture([moveOp("n2", 44, 44)]);

    expect(useScene.getState().selection).toEqual(["n2"]);
  });

  // --- guardie sulla macchina a stati --------------------------------------

  describe("misusi della macchina a stati", () => {
    // Il misuso deve essere RUMOROSO: si verifica il warning, non solo lo stato.
    const silenceWarn = () => vi.spyOn(console, "warn").mockImplementation(() => {});
    let warn: ReturnType<typeof silenceWarn>;
    beforeEach(() => {
      warn = silenceWarn();
    });
    afterEach(() => {
      warn.mockRestore();
    });

    it("beginGesture con un gesto già aperto segnala e tiene lo snapshot INIZIALE", () => {
      const st = useScene.getState();
      st.beginGesture();
      st.applyLocal(moveOp("n1", 40, 40));
      st.beginGesture(); // misuso: il tool ha dimenticato di chiudere il primo
      st.applyLocal(moveOp("n1", 90, 90));
      st.cancelGesture();

      // deve tornare al vero inizio (0,0), non allo stato di metà drag (40,40)
      expect(useScene.getState().scene!.nodes["n1"]).toMatchObject({ x: 0, y: 0 });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("beginGesture");
    });

    it("beginGesture ripetuto non perde gli op remoti già registrati", () => {
      const st = useScene.getState();
      st.beginGesture();
      st.apply(createOp("n3", 700, 700));
      st.beginGesture(); // misuso
      st.cancelGesture();

      expect(useScene.getState().scene!.nodes["n3"]).toBeDefined();
    });

    it("endGesture senza gesto aperto segnala ma manda comunque gli op", () => {
      const st = useScene.getState();
      st.endGesture([moveOp("n1", 40, 40)]); // misuso: nessun beginGesture

      expect(sync.sent).toHaveLength(1);
      expect(useScene.getState().scene!.nodes["n1"]).toMatchObject({ x: 40, y: 40 });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("endGesture");
    });

    it("endGesture([]) senza gesto aperto è un no-op silenzioso", () => {
      const before = useScene.getState().scene;
      useScene.getState().endGesture([]);

      expect(useScene.getState().scene).toEqual(before);
      expect(sync.sent).toHaveLength(0);
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
