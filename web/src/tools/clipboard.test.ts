import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useScene } from "../store/store";
import { emptyScene, type NodeLite } from "../store/types";
import {
  CLIPBOARD_FORMAT,
  CLIPBOARD_VERSION,
  PASTE_OFFSET,
  serializeNodes,
  parseClipboard,
  pasteOps,
  copySelection,
  pasteClipboard,
  duplicateSelection,
  attachClipboardShortcuts,
  clipboardMemory,
} from "./clipboard";

// --- fixture ----------------------------------------------------------------

function rect(id: string, over: Partial<NodeLite> = {}): NodeLite {
  return {
    id,
    parentId: "page1",
    orderKey: "a000001",
    name: "Rettangolo",
    visible: true,
    opacity: 1,
    x: 10,
    y: 20,
    width: 30,
    height: 40,
    rotation: 0,
    fills: [{ r: 0.5, g: 0.25, b: 0.125, a: 1 }],
    strokes: [],
    kind: "rect",
    cornerRadius: 4,
    ...over,
  };
}

function text(id: string, over: Partial<NodeLite> = {}): NodeLite {
  return rect(id, {
    kind: "text",
    cornerRadius: 0,
    name: "Testo",
    text: {
      content: "ciao",
      style: { fontFamily: "Inter", fontSize: 16, fontWeight: "400", lineHeight: 1.2, align: "center" },
    },
    ...over,
  });
}

function installScene(nodes: NodeLite[]): void {
  const scene = emptyScene("doc-1", "Untitled");
  for (const n of nodes) scene.nodes[n.id] = n;
  useScene.getState().setScene(scene);
}

// La clipboard di sistema non esiste in jsdom: la si installa (o la si toglie,
// per il caso "API non disponibile") su navigator per ogni test.
interface ClipboardStub {
  writeText: ReturnType<typeof vi.fn>;
  readText: ReturnType<typeof vi.fn>;
}

function setClipboard(stub: ClipboardStub | null): void {
  Object.defineProperty(globalThis.navigator, "clipboard", {
    value: stub ?? undefined,
    configurable: true,
    writable: true,
  });
}

function clipboardStub(initial: string | null = null): ClipboardStub {
  let held = initial;
  return {
    writeText: vi.fn(async (t: string) => {
      held = t;
    }),
    readText: vi.fn(async () => held ?? ""),
  };
}

beforeEach(() => {
  useScene.setState({
    selection: [],
    gesture: null,
    undoStack: [],
    redoStack: [],
    canUndo: false,
    canRedo: false,
    notice: null,
    lastError: null,
    sync: null,
    history: [],
    pending: [],
  });
  installScene([]);
  setClipboard(clipboardStub());
  // Il buffer di ripiego è stato di MODULO: senza azzerarlo, una copia fatta da
  // un test precedente resterebbe incollabile in quello dopo.
  clipboardMemory.text = null;
  clipboardMemory.onSystem = false;
});

afterEach(() => {
  setClipboard(null);
});

// --- formato ----------------------------------------------------------------

describe("il payload della clipboard", () => {
  it("fa il giro completo serializza -> analizza senza perdere niente", () => {
    const nodes = [rect("n1"), text("n2")];
    const parsed = parseClipboard(serializeNodes(nodes));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.nodes).toEqual(nodes);
  });

  it("è un JSON etichettato e versionato (così un'altra finestra lo riconosce)", () => {
    const payload = JSON.parse(serializeNodes([rect("n1")]));
    expect(payload.format).toBe(CLIPBOARD_FORMAT);
    expect(payload.version).toBe(CLIPBOARD_VERSION);
    expect(payload.nodes).toHaveLength(1);
  });

  it("tratta come ESTRANEO tutto ciò che non è un payload brawt", () => {
    for (const t of ["", "   ", "ciao mondo", "{ non json", JSON.stringify({ hello: "world" })]) {
      const parsed = parseClipboard(t);
      expect(parsed.ok, t).toBe(false);
      if (parsed.ok) throw new Error("unreachable");
      expect(parsed.reason, t).toBe("foreign");
    }
  });

  // Il requisito centrale: un payload che parla di un tipo di nodo che questa
  // build non conosce (un'altra finestra, una versione più nuova) va RIFIUTATO
  // in blocco -- creare un nodo "vector" degradato a rettangolo sarebbe un
  // documento corrotto in silenzio.
  it("RIFIUTA un payload con un tipo di nodo sconosciuto, invece di degradarlo", () => {
    const payload = JSON.stringify({
      format: CLIPBOARD_FORMAT,
      version: CLIPBOARD_VERSION,
      nodes: [rect("n1"), { ...rect("n2"), kind: "vector" }],
    });
    const parsed = parseClipboard(payload);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("unreachable");
    expect(parsed.reason).toBe("unsupported");
  });

  it("RIFIUTA un payload di una versione futura", () => {
    const payload = JSON.stringify({
      format: CLIPBOARD_FORMAT,
      version: CLIPBOARD_VERSION + 1,
      nodes: [rect("n1")],
    });
    const parsed = parseClipboard(payload);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("unreachable");
    expect(parsed.reason).toBe("unsupported");
  });

  it("riempie i campi mancanti invece di produrre un nodo a metà", () => {
    const payload = JSON.stringify({
      format: CLIPBOARD_FORMAT,
      version: CLIPBOARD_VERSION,
      nodes: [{ id: "n1", kind: "text" }],
    });
    const parsed = parseClipboard(payload);
    if (!parsed.ok) throw new Error("dovrebbe essere accettato");
    const n = parsed.nodes[0];
    expect(n.kind).toBe("text");
    expect(n.text).toBeDefined();
    expect(n.text?.content).toBe("");
    expect(n.x).toBe(0);
    expect(n.fills).toEqual([]);
  });
});

// --- op di incolla ----------------------------------------------------------

describe("pasteOps", () => {
  it("dà id NUOVI a ogni nodo incollato", () => {
    installScene([rect("n1")]);
    const { ops, ids } = pasteOps(useScene.getState().scene!, [rect("n1")]);
    expect(ops).toHaveLength(1);
    expect(ids[0]).not.toBe("n1");
    expect(ids[0]).not.toBe("");
    const op = ops[0];
    if (op.kind.case !== "createNode") throw new Error("wrong kind");
    expect(op.kind.value.node?.id).toBe(ids[0]);
  });

  // Un id o una order key duplicati corromperebbero il documento: il primo
  // perché core.applyCreate rifiuta l'op (ErrNodeExists) lasciando la scena
  // locale divergente, la seconda perché l'ordine di disegno diventerebbe
  // indefinito fra i due nodi.
  it("dà order key NUOVE, in cima al documento e nell'ordine dei nodi copiati", () => {
    installScene([rect("a", { orderKey: "a000001" }), rect("b", { orderKey: "a000005" })]);
    const scene = useScene.getState().scene!;
    const { ops } = pasteOps(scene, [rect("x", { orderKey: "a000009" }), rect("y", { orderKey: "a000002" })]);
    const keys = ops.map((op) => (op.kind.case === "createNode" ? op.kind.value.node!.orderKey : ""));
    expect(keys).toHaveLength(2);
    // Sopra ogni chiave già nel documento...
    for (const k of keys) expect(k > "a000005").toBe(true);
    // ...crescenti fra loro, e nell'ordine RELATIVO dei nodi copiati (y prima
    // di x: la sua order key di partenza era più bassa).
    expect(keys[0] < keys[1]).toBe(true);
    const names = ops.map((op) => (op.kind.case === "createNode" ? op.kind.value.node!.id : ""));
    expect(new Set(names).size).toBe(2);
  });

  it("sposta i nodi incollati dell'offset", () => {
    const scene = useScene.getState().scene!;
    const { ops } = pasteOps(scene, [rect("n1", { x: 10, y: 20 })]);
    const node = ops[0].kind.case === "createNode" ? ops[0].kind.value.node! : null;
    expect(node?.x).toBe(10 + PASTE_OFFSET);
    expect(node?.y).toBe(20 + PASTE_OFFSET);
  });

  it("conserva forma, stile e testo del nodo di partenza", () => {
    const scene = useScene.getState().scene!;
    const { ops } = pasteOps(scene, [text("t1", { opacity: 0.5, rotation: 30 })]);
    const node = ops[0].kind.case === "createNode" ? ops[0].kind.value.node! : null;
    expect(node?.shape.case).toBe("text");
    expect(node?.shape.case === "text" && node.shape.value.content).toBe("ciao");
    expect(node?.opacity).toBe(0.5);
    expect(node?.rotation).toBe(30);
    expect(node?.fills).toHaveLength(1);
  });

  // "I nodi selezionati e il loro parent", non "tutti i nodi del documento":
  // quando arriverà l'annidamento (traccia 1) un payload potrà contenere un
  // contenitore insieme ai suoi figli, e il figlio deve seguire la COPIA del
  // contenitore, non l'originale.
  it("rimappa il parent quando anche il parent è nel payload", () => {
    const scene = useScene.getState().scene!;
    const parent = rect("p1", { orderKey: "a000001" });
    const child = rect("c1", { parentId: "p1", orderKey: "a000002", x: 5, y: 5 });
    const { ops, ids } = pasteOps(scene, [parent, child]);
    const nodes = ops.map((op) => (op.kind.case === "createNode" ? op.kind.value.node! : null));
    expect(nodes[0]?.id).toBe(ids[0]);
    expect(nodes[1]?.parentId).toBe(ids[0]);
    // Il figlio NON prende l'offset: lo prende il contenitore, e spostare
    // entrambi lo sposterebbe due volte il giorno in cui le coordinate
    // diventeranno relative al parent.
    expect(nodes[1]?.x).toBe(5);
    expect(nodes[0]?.x).toBe(10 + PASTE_OFFSET);
  });

  it("conserva il parent quando esiste nel documento di destinazione", () => {
    installScene([rect("host")]);
    const scene = useScene.getState().scene!;
    const { ops } = pasteOps(scene, [rect("n1", { parentId: "host" })]);
    const node = ops[0].kind.case === "createNode" ? ops[0].kind.value.node! : null;
    expect(node?.parentId).toBe("host");
  });

  it("ripiega sulla pagina quando il parent non esiste (incolla in un ALTRO documento)", () => {
    const scene = useScene.getState().scene!;
    const { ops } = pasteOps(scene, [rect("n1", { parentId: "gruppo-di-un-altro-documento" })]);
    const node = ops[0].kind.case === "createNode" ? ops[0].kind.value.node! : null;
    expect(node?.parentId).toBe("page1");
  });

  // Gli id del payload NON sono garantiti: parseClipboard tollera un nodo senza
  // `id` (lo legge come "") e un payload scritto a mano può ripeterne uno. Se il
  // nuovo id si scegliesse per id di partenza invece che per posizione, quei
  // nodi collasserebbero su un solo uuid: due CreateNode con lo stesso id, che
  // in locale applyOp scarta (la scena guadagna UN nodo mentre `ids` ne
  // dichiara due) e che il server rifiuta con ErrNodeExists a gesto iniziato.
  it("dà id DISTINTI anche a nodi del payload senza id", () => {
    const scene = useScene.getState().scene!;
    const { ops, ids } = pasteOps(scene, [rect("", { x: 1 }), rect("", { x: 2 })]);
    expect(ops).toHaveLength(2);
    expect(ids).toHaveLength(2);
    const created = ops.map((op) => (op.kind.case === "createNode" ? op.kind.value.node!.id : ""));
    expect(new Set(created).size).toBe(2);
    expect(created).toEqual(ids);
    expect(created).not.toContain("");
  });

  it("dà id DISTINTI anche a nodi del payload che ripetono lo stesso id", () => {
    const scene = useScene.getState().scene!;
    const { ops, ids } = pasteOps(scene, [
      rect("stesso", { orderKey: "a000001" }),
      rect("stesso", { orderKey: "a000002" }),
    ]);
    const created = ops.map((op) => (op.kind.case === "createNode" ? op.kind.value.node!.id : ""));
    expect(new Set(created).size).toBe(2);
    expect(ids).toEqual(created);
  });

  // L'id vuoto non è un'identità: senza questa distinzione un nodo con
  // parentId "" verrebbe "rimappato" sotto la copia del nodo senza id.
  it("non attacca un nodo senza parent alla copia del nodo senza id", () => {
    const scene = useScene.getState().scene!;
    const { ops, ids } = pasteOps(scene, [
      rect("", { orderKey: "a000001" }),
      rect("n2", { parentId: "", orderKey: "a000002" }),
    ]);
    const nodes = ops.map((op) => (op.kind.case === "createNode" ? op.kind.value.node! : null));
    expect(nodes[1]?.parentId).toBe("page1");
    expect(nodes[1]?.parentId).not.toBe(ids[0]);
    // E poiché non è figlio di niente, resta una RADICE: prende l'offset.
    expect(nodes[1]?.x).toBe(10 + PASTE_OFFSET);
  });

  // Un parent ambiguo (due nodi con lo stesso id) non si tira a sorte: il nodo
  // ricade sui casi "esiste nel documento" / "atterra sulla pagina".
  it("non rimappa un parent ambiguo", () => {
    const scene = useScene.getState().scene!;
    const { ops, ids } = pasteOps(scene, [
      rect("dup", { orderKey: "a000001" }),
      rect("dup", { orderKey: "a000002" }),
      rect("c1", { parentId: "dup", orderKey: "a000003" }),
    ]);
    const child = ops[2].kind.case === "createNode" ? ops[2].kind.value.node! : null;
    expect(child?.parentId).toBe("page1");
    expect(ids).not.toContain(child?.parentId);
  });

  it("non crea un nodo figlio di sé stesso", () => {
    installScene([]);
    const scene = useScene.getState().scene!;
    const { ops, ids } = pasteOps(scene, [rect("n1", { parentId: "n1" })]);
    const node = ops[0].kind.case === "createNode" ? ops[0].kind.value.node! : null;
    expect(node?.parentId).not.toBe(ids[0]);
    expect(node?.parentId).toBe("page1");
  });
});

// --- copia ------------------------------------------------------------------

describe("copySelection", () => {
  it("scrive la selezione sulla clipboard di SISTEMA come payload brawt", async () => {
    const cb = clipboardStub();
    setClipboard(cb);
    installScene([rect("n1"), rect("n2")]);
    useScene.getState().setSelection(["n1"]);

    expect(await copySelection()).toBe(true);
    expect(cb.writeText).toHaveBeenCalledTimes(1);
    const parsed = parseClipboard(cb.writeText.mock.calls[0][0] as string);
    if (!parsed.ok) throw new Error("dovrebbe essere un payload brawt");
    expect(parsed.nodes.map((n) => n.id)).toEqual(["n1"]);
  });

  it("non copia niente (e non tocca la clipboard) senza selezione", async () => {
    const cb = clipboardStub();
    setClipboard(cb);
    installScene([rect("n1")]);
    expect(await copySelection()).toBe(false);
    expect(cb.writeText).not.toHaveBeenCalled();
  });
});

// --- incolla ----------------------------------------------------------------

describe("pasteClipboard", () => {
  it("incolla il payload della clipboard di sistema con id nuovi", async () => {
    const cb = clipboardStub(serializeNodes([rect("n1"), rect("n2")]));
    setClipboard(cb);
    installScene([]);

    await pasteClipboard();

    const scene = useScene.getState().scene!;
    const ids = Object.keys(scene.nodes);
    expect(ids).toHaveLength(2);
    expect(ids).not.toContain("n1");
    expect(useScene.getState().selection).toEqual(ids.sort((a, b) =>
      scene.nodes[a].orderKey < scene.nodes[b].orderKey ? -1 : 1));
  });

  // Il punto del "un solo gesto": un Ctrl+Z toglie TUTTO l'incollato, non un
  // nodo per volta.
  it("è UN SOLO gesto: un Ctrl+Z toglie tutti i nodi incollati insieme", async () => {
    setClipboard(clipboardStub(serializeNodes([rect("n1"), rect("n2"), rect("n3")])));
    installScene([rect("gia-qui")]);

    await pasteClipboard();
    expect(Object.keys(useScene.getState().scene!.nodes)).toHaveLength(4);
    expect(useScene.getState().undoStack).toHaveLength(1);

    useScene.getState().undo();
    expect(Object.keys(useScene.getState().scene!.nodes)).toEqual(["gia-qui"]);
  });

  it("incolla dal buffer in memoria quando la clipboard di sistema non è disponibile", async () => {
    setClipboard(null); // niente navigator.clipboard: ambiente non sicuro, permesso negato...
    installScene([rect("n1")]);
    useScene.getState().setSelection(["n1"]);
    await copySelection();

    await pasteClipboard();
    expect(Object.keys(useScene.getState().scene!.nodes)).toHaveLength(2);
  });

  it("incolla dal buffer in memoria quando la clipboard di sistema RIFIUTA la lettura", async () => {
    const cb = clipboardStub();
    cb.readText.mockRejectedValue(new Error("permesso negato"));
    setClipboard(cb);
    installScene([rect("n1")]);
    useScene.getState().setSelection(["n1"]);
    await copySelection();

    await pasteClipboard();
    expect(Object.keys(useScene.getState().scene!.nodes)).toHaveLength(2);
  });

  it("non incolla niente quando non c'è mai stata una copia", async () => {
    setClipboard(clipboardStub("del testo qualunque"));
    installScene([rect("n1")]);
    await pasteClipboard();
    expect(Object.keys(useScene.getState().scene!.nodes)).toEqual(["n1"]);
    expect(useScene.getState().undoStack).toHaveLength(0);
  });

  it("rifiuta pulito un payload con un tipo sconosciuto: nessun nodo, un avviso", async () => {
    const payload = JSON.stringify({
      format: CLIPBOARD_FORMAT,
      version: CLIPBOARD_VERSION,
      nodes: [{ ...rect("n1"), kind: "vector" }],
    });
    setClipboard(clipboardStub(payload));
    installScene([rect("gia-qui")]);

    await pasteClipboard();

    expect(Object.keys(useScene.getState().scene!.nodes)).toEqual(["gia-qui"]);
    expect(useScene.getState().undoStack).toHaveLength(0);
    expect(useScene.getState().notice).toBeTruthy();
  });

  // La lettura degli appunti è ASINCRONA e può restare appesa a lungo
  // (Chromium non risolve readText finché il documento non ha il fuoco).
  // Senza guardia, i Ctrl+V premuti nel frattempo si accodano e atterrano
  // TUTTI INSIEME quando la lettura si sblocca: una raffica di incolla che
  // nessuno ha chiesto, per di più da disfare uno per uno.
  it("un secondo Ctrl+V mentre la lettura è ancora appesa non accoda un altro incolla", async () => {
    let release: (t: string) => void = () => {};
    const cb = clipboardStub();
    cb.readText.mockImplementation(() => new Promise<string>((res) => (release = res)));
    setClipboard(cb);
    installScene([]);

    const first = pasteClipboard();
    const second = pasteClipboard();
    release(serializeNodes([rect("n1")]));
    await Promise.all([first, second]);

    expect(cb.readText).toHaveBeenCalledTimes(1);
    expect(Object.keys(useScene.getState().scene!.nodes)).toHaveLength(1);
  });

  // Il caso end-to-end del payload scritto male: due nodi senza `id`. Devono
  // diventare DUE nodi, e la selezione (che è anche ciò che la voce di undo
  // toglierà) deve corrispondere a quello che è davvero nella scena.
  it("incolla due nodi anche se il payload non dà loro un id", async () => {
    const payload = JSON.stringify({
      format: CLIPBOARD_FORMAT,
      version: CLIPBOARD_VERSION,
      nodes: [{ kind: "rect" }, { kind: "rect" }],
    });
    setClipboard(clipboardStub(payload));
    installScene([]);

    const ids = await pasteClipboard();

    const nodes = Object.keys(useScene.getState().scene!.nodes);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(nodes.sort()).toEqual([...ids].sort());
    expect(useScene.getState().selection).toEqual(ids);

    useScene.getState().undo();
    expect(Object.keys(useScene.getState().scene!.nodes)).toEqual([]);
  });

  // Il ripiego sul buffer in memoria NON è per "sugli appunti c'è altro": una
  // lettura riuscita è l'ultima copia che l'utente ha fatto davvero (testo
  // selezionato nella pagina e Ctrl+C, o una copia in un'altra applicazione).
  // Incollare al suo posto un rettangolo copiato prima sarebbe incollare una
  // cosa per un'altra, senza dirlo.
  it("NON ripiega sulla copia precedente quando gli appunti si leggono e contengono altro", async () => {
    const cb = clipboardStub();
    setClipboard(cb);
    installScene([rect("n1")]);
    useScene.getState().setSelection(["n1"]);
    await copySelection();
    // Qualcun altro (il browser, un'altra applicazione) sovrascrive gli appunti.
    cb.readText.mockResolvedValue("del testo copiato altrove");

    expect(await pasteClipboard()).toEqual([]);
    expect(Object.keys(useScene.getState().scene!.nodes)).toEqual(["n1"]);
    expect(useScene.getState().undoStack).toHaveLength(0);
  });

  // ...ma se la nostra copia sulla clipboard di sistema non c'è mai arrivata
  // (scrittura negata, documento senza fuoco), il buffer in memoria è l'UNICA
  // copia che esiste: lì il ripiego resta l'unica cosa sensata.
  it("ripiega comunque quando la SCRITTURA di sistema era fallita", async () => {
    const cb = clipboardStub();
    cb.writeText.mockRejectedValue(new Error("permesso negato"));
    setClipboard(cb);
    installScene([rect("n1")]);
    useScene.getState().setSelection(["n1"]);
    await copySelection();
    cb.readText.mockResolvedValue("del testo copiato altrove");

    await pasteClipboard();
    expect(Object.keys(useScene.getState().scene!.nodes)).toHaveLength(2);
  });

  it("non incolla a gesto aperto (un drag in corso): rimandato, come undo/redo", async () => {
    setClipboard(clipboardStub(serializeNodes([rect("n1")])));
    installScene([]);
    useScene.getState().beginGesture();
    await pasteClipboard();
    expect(Object.keys(useScene.getState().scene!.nodes)).toHaveLength(0);
  });
});

// --- duplica ----------------------------------------------------------------

describe("duplicateSelection", () => {
  it("duplica la selezione con l'offset, e seleziona le copie", () => {
    installScene([rect("n1", { x: 100, y: 200 })]);
    useScene.getState().setSelection(["n1"]);

    const ids = duplicateSelection();

    const scene = useScene.getState().scene!;
    expect(ids).toHaveLength(1);
    expect(Object.keys(scene.nodes)).toHaveLength(2);
    expect(scene.nodes[ids[0]].x).toBe(100 + PASTE_OFFSET);
    expect(scene.nodes[ids[0]].y).toBe(200 + PASTE_OFFSET);
    expect(useScene.getState().selection).toEqual(ids);
  });

  it("è UN SOLO gesto anche su più nodi", () => {
    installScene([rect("n1"), rect("n2", { orderKey: "a000002" })]);
    useScene.getState().setSelection(["n1", "n2"]);

    duplicateSelection();
    expect(Object.keys(useScene.getState().scene!.nodes)).toHaveLength(4);
    expect(useScene.getState().undoStack).toHaveLength(1);

    useScene.getState().undo();
    expect(Object.keys(useScene.getState().scene!.nodes).sort()).toEqual(["n1", "n2"]);
  });

  it("NON tocca la clipboard: duplicare non è copiare", () => {
    const cb = clipboardStub();
    setClipboard(cb);
    installScene([rect("n1")]);
    useScene.getState().setSelection(["n1"]);

    duplicateSelection();
    expect(cb.writeText).not.toHaveBeenCalled();
  });

  it("senza selezione non fa niente", () => {
    installScene([rect("n1")]);
    expect(duplicateSelection()).toEqual([]);
    expect(Object.keys(useScene.getState().scene!.nodes)).toEqual(["n1"]);
  });
});

// --- scorciatoie ------------------------------------------------------------

describe("attachClipboardShortcuts", () => {
  let detach: () => void = () => {};

  afterEach(() => {
    detach();
    detach = () => {};
    document.body.replaceChildren();
  });

  function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = window): void {
    const e = new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(e);
  }

  it("Ctrl+D duplica la selezione", () => {
    detach = attachClipboardShortcuts();
    installScene([rect("n1")]);
    useScene.getState().setSelection(["n1"]);

    press("d");
    expect(Object.keys(useScene.getState().scene!.nodes)).toHaveLength(2);
  });

  it("Ctrl+C poi Ctrl+V copiano e incollano", async () => {
    setClipboard(clipboardStub());
    detach = attachClipboardShortcuts();
    installScene([rect("n1")]);
    useScene.getState().setSelection(["n1"]);

    press("c");
    await vi.waitFor(() => expect(useScene.getState().selection).toEqual(["n1"]));
    press("v");
    await vi.waitFor(() => expect(Object.keys(useScene.getState().scene!.nodes)).toHaveLength(2));
  });

  it("ignora le scorciatoie dentro un campo di testo (lì la copia è del campo)", () => {
    detach = attachClipboardShortcuts();
    installScene([rect("n1")]);
    useScene.getState().setSelection(["n1"]);
    const input = document.createElement("input");
    document.body.appendChild(input);

    press("d", {}, input);
    expect(Object.keys(useScene.getState().scene!.nodes)).toHaveLength(1);
  });

  it("ignora un tasto senza il modificatore, e Ctrl+Shift+D (che è un'altra scorciatoia)", () => {
    detach = attachClipboardShortcuts();
    installScene([rect("n1")]);
    useScene.getState().setSelection(["n1"]);

    press("d", { ctrlKey: false });
    press("d", { shiftKey: true });
    expect(Object.keys(useScene.getState().scene!.nodes)).toHaveLength(1);
  });

  it("la cleanup stacca davvero il listener", () => {
    detach = attachClipboardShortcuts();
    installScene([rect("n1")]);
    useScene.getState().setSelection(["n1"]);
    detach();
    detach = () => {};

    press("d");
    expect(Object.keys(useScene.getState().scene!.nodes)).toHaveLength(1);
  });

  it("previene il default SOLO quando gestisce il tasto", () => {
    detach = attachClipboardShortcuts();
    installScene([rect("n1")]);
    useScene.getState().setSelection(["n1"]);

    const handled = new KeyboardEvent("keydown", { key: "d", ctrlKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(handled);
    expect(handled.defaultPrevented).toBe(true);

    const other = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(other);
    expect(other.defaultPrevented).toBe(false);
  });
});

// --- immagini (traccia 3) ----------------------------------------------------

function imageNode(id: string, hash: string, over: Partial<NodeLite> = {}): NodeLite {
  return rect(id, { kind: "image", cornerRadius: 0, name: "logo.png", image: { assetHash: hash }, ...over });
}

describe("clipboard: immagini", () => {
  it("copia e rilegge un nodo immagine tenendo il suo hash", () => {
    // `image` è in KNOWN_KINDS: senza, questo payload sarebbe stato rifiutato
    // come "unsupported" -- che è la garanzia che un tipo NUOVO non si incolla
    // mai degradato a rettangolo.
    const parsed = parseClipboard(serializeNodes([imageNode("n1", "abc123")]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.nodes[0].kind).toBe("image");
    expect(parsed.nodes[0].image?.assetHash).toBe("abc123");
  });

  it("un'immagine senza hash leggibile si incolla come segnaposto, non fa fallire l'incolla", () => {
    const parsed = parseClipboard(JSON.stringify({
      format: CLIPBOARD_FORMAT,
      version: CLIPBOARD_VERSION,
      nodes: [{ id: "n1", kind: "image" }],
    }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.nodes[0].image?.assetHash).toBe("");
  });

  it("l'incolla dà un id NUOVO ma lo STESSO hash: i byte non si duplicano", () => {
    // È l'indirizzamento per contenuto a rendere questo corretto: due nodi che
    // puntano allo stesso sha256 sono un file solo su disco.
    const scene = emptyScene("doc-1", "Untitled");
    const { ops } = pasteOps(scene, [imageNode("n1", "abc123")]);
    const node = ops[0].kind.case === "createNode" ? ops[0].kind.value.node! : null;
    expect(node?.id).not.toBe("n1");
    expect(node?.shape.case).toBe("image");
    expect(node?.shape.case === "image" ? node.shape.value.assetHash : "").toBe("abc123");
  });
});
