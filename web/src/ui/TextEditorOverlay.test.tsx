// I matcher di jest-dom sono già installati dai setupFiles (vite.config.ts);
// l'import qui serve a TYPE-SCRIPT (tsc -b non legge i setupFiles).
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { create } from "@bufbuild/protobuf";
import { OpSchema } from "../gen/brawt/v1/brawt_pb";
import type { Op } from "../gen/brawt/v1/brawt_pb";
import { TextEditorOverlay } from "./TextEditorOverlay";
import { App } from "./App";
import { useScene } from "../store/store";
import { emptyScene } from "../store/types";
import type { NodeLite } from "../store/types";

// App parla con la rete al bootstrap (createDocument + SyncClient): serve solo
// nel test della guardia undo/redo, e lì basta un trasporto inerte.
vi.mock("../rpc/client", () => ({
  docClient: { createDocument: vi.fn(async () => ({ id: "doc-1" })) },
}));
vi.mock("../rpc/syncClient", () => ({
  SyncClient: class {
    async start() {}
    stop() {}
  },
}));
// jsdom qui non espone localStorage (Node lo disabilita senza
// --localstorage-file): con un docId in cache il bootstrap di App non fallisce.
vi.stubGlobal("localStorage", {
  getItem: () => "doc-1",
  setItem: () => {},
  removeItem: () => {},
});

// Doppio di SyncClient: registra gli op che finiscono SUL FILO e modella un
// server che accetta ed ECOA subito (applyPending + apply), come negli altri
// test dello store.
class FakeSync {
  sent: Op[] = [];
  submit(op: Op) {
    this.sent.push(op);
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
}

function textNode(id: string, content: string, over: Partial<NodeLite> = {}): NodeLite {
  return {
    id, parentId: "page1", orderKey: "a0", name: "Text", visible: true, opacity: 1,
    x: 10, y: 20, width: 200, height: 24, rotation: 0,
    fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [],
    kind: "text", cornerRadius: 0,
    text: {
      content,
      style: { fontFamily: "Inter", fontSize: 16, fontWeight: "400", lineHeight: 1.5, align: "left" },
    },
    ...over,
  };
}

function installScene(...nodes: NodeLite[]) {
  const scene = emptyScene("doc-1", "Untitled");
  for (const n of nodes) scene.nodes[n.id] = n;
  // setScene e non setState({scene}): installa una scena COERENTE (vista e
  // confermato allineati, coda vuota) -- l'invariante della riconciliazione.
  useScene.getState().setScene(scene);
}

function deleteOp(id: string): Op {
  return create(OpSchema, { opId: "del-" + id, docId: "doc-1", kind: { case: "deleteNode", value: { id } } });
}

let sync: FakeSync;

// Il campo di editing, cercato per NOME ACCESSIBILE e non per il solo ruolo:
// da quando App monta anche il pannello proprietà (ui/App.tsx, le tre colonne)
// un "textbox" qualunque può essere il campo X del pannello. Il nome è quello
// che l'overlay dichiara (aria-label), quindi la query resta identica sia per
// l'overlay montato da solo sia per l'app intera.
const FIELD_NAME = "Contenuto del testo";

function field(): HTMLTextAreaElement {
  return screen.getByRole("textbox", { name: FIELD_NAME }) as HTMLTextAreaElement;
}

function content(id = "t1"): string | undefined {
  return useScene.getState().scene?.nodes[id]?.text?.content;
}

beforeEach(() => {
  sync = new FakeSync();
  useScene.setState({
    camera: { x: 0, y: 0, zoom: 1 },
    selection: [],
    marquee: null,
    gesture: null,
    editingNodeId: null,
  });
  installScene(textNode("t1", "ciao"));
  useScene.getState().setSync(sync);
  useScene.getState().setSelection(["t1"]);
  // Il flag lo accende chi entra in editing (textTool / doppio click di
  // selectTool): l'overlay lo trova già acceso e lo spegne uscendo.
  useScene.setState({ editingNodeId: "t1" });
});

afterEach(cleanup);

// --- Step 1: posizionamento -------------------------------------------------

describe("posizionamento", () => {
  it("si mette sul nodo: origine da worldToScreen, misure in px SCHERMO", () => {
    useScene.setState({ camera: { x: 5, y: 7, zoom: 2 } });
    render(<TextEditorOverlay nodeId="t1" />);
    const ta = field();

    expect(ta.style.left).toBe("25px"); // 10 * 2 + 5
    expect(ta.style.top).toBe("47px"); // 20 * 2 + 7
    expect(ta.style.width).toBe("400px"); // 200 * 2
    expect(ta.style.fontSize).toBe("32px"); // 16 * 2
    expect(ta.style.lineHeight).toBe("48px"); // 16 * 1.5 * 2
    // Il campo copre almeno il box del nodo: è lui a nascondere il testo
    // disegnato sul canvas (vedi il commento del componente).
    expect(ta.style.minHeight).toBe("48px"); // 24 * 2
  });

  it("risolve i default del renderer quando lo stile non li specifica", () => {
    installScene(textNode("t1", "ciao", {
      text: { content: "ciao", style: { fontFamily: "", fontSize: 0, fontWeight: "", lineHeight: 0, align: "left" } },
    }));
    useScene.setState({ editingNodeId: "t1" });
    render(<TextEditorOverlay nodeId="t1" />);

    // DEFAULT_FONT_SIZE = 16, DEFAULT_LINE_HEIGHT = 1.2 (renderer/text.ts)
    expect(field().style.fontSize).toBe("16px");
    expect(field().style.lineHeight).toBe("19.2px");
  });

  it("resta OPACO anche su un nodo semitrasparente: è lui a coprire il testo del canvas", () => {
    installScene(textNode("t1", "ciao", { opacity: 0.2 }));
    useScene.setState({ editingNodeId: "t1" });
    render(<TextEditorOverlay nodeId="t1" />);

    // Con l'opacità del nodo applicata al campo, lo sfondo diventerebbe
    // semitrasparente e il testo disegnato sotto trasparirebbe: due testi
    // sovrapposti e sfalsati, cioè il difetto che la copertura evita.
    expect(field().style.opacity).toBe("");
  });

  // Il campo COPRE i glifi disegnati sul canvas: è l'invariante su cui poggia
  // tutta la scelta del campo opaco (vedi il commento del componente). Un nodo
  // RUOTATO lo rompeva: drawScene disegnava il testo girato (ruota il contesto
  // attorno al centro del box) e il campo restava dritto sopra -- il testo si
  // vedeva DOPPIO, a due angoli diversi.
  describe("su un nodo RUOTATO", () => {
    it("gira con il nodo, attorno al centro del suo box", () => {
      installScene(textNode("t1", "ciao", { rotation: 30 }));
      useScene.setState({ editingNodeId: "t1" });
      render(<TextEditorOverlay nodeId="t1" />);
      const ta = field();

      // stessa convenzione del renderer: gradi, orari, attorno al CENTRO del
      // box del nodo (200x24 a zoom 1 -> 100px, 12px dall'angolo del campo)
      expect(ta.style.transform).toBe("rotate(30deg)");
      expect(ta.style.transformOrigin).toBe("100px 12px");
      // l'origine resta quella del modello: a ruotare è il campo, non il punto
      expect(ta.style.left).toBe("10px");
      expect(ta.style.top).toBe("20px");
    });

    it("tiene il perno in px SCHERMO anche sotto zoom", () => {
      installScene(textNode("t1", "ciao", { rotation: 90 }));
      useScene.setState({ editingNodeId: "t1", camera: { x: 0, y: 0, zoom: 2 } });
      render(<TextEditorOverlay nodeId="t1" />);

      expect(field().style.transform).toBe("rotate(90deg)");
      expect(field().style.transformOrigin).toBe("200px 24px"); // (200/2, 24/2) * 2
    });

    it("un angolo NULLO non scrive nessuna trasformazione", () => {
      render(<TextEditorOverlay nodeId="t1" />);
      expect(field().style.transform).toBe("");
      expect(field().style.transformOrigin).toBe("");
    });
  });

  it("si riposiziona a ogni cambio di camera: pan e zoom non lo scollano dal nodo", () => {
    render(<TextEditorOverlay nodeId="t1" />);
    expect(field().style.left).toBe("10px");

    act(() => useScene.getState().setCamera({ x: 100, y: 40, zoom: 1 }));
    expect(field().style.left).toBe("110px");
    expect(field().style.top).toBe("60px");

    act(() => useScene.getState().setCamera({ x: 0, y: 0, zoom: 4 }));
    expect(field().style.left).toBe("40px");
    expect(field().style.width).toBe("800px");
    expect(field().style.fontSize).toBe("64px");
  });
});

// --- Step 5: fuoco e cursore ------------------------------------------------

describe("ingresso in editing", () => {
  it("prende il fuoco da solo e mette il cursore a FINE testo", () => {
    render(<TextEditorOverlay nodeId="t1" />);
    const ta = field();

    expect(document.activeElement).toBe(ta);
    expect(ta.value).toBe("ciao");
    expect(ta.selectionStart).toBe(4);
    expect(ta.selectionEnd).toBe(4);
  });

  it("apre UN gesto al montaggio (la sessione intera è un solo gesto)", () => {
    expect(useScene.getState().gesture).toBeNull();
    render(<TextEditorOverlay nodeId="t1" />);
    expect(useScene.getState().gesture).not.toBeNull();
  });
});

// --- Step 2: ciclo di vita del gesto ---------------------------------------

describe("anteprima durante la scrittura", () => {
  it("ogni modifica è un applyLocal: si vede sul canvas ma non va sul filo", async () => {
    render(<TextEditorOverlay nodeId="t1" />);
    await userEvent.type(field(), " mondo");

    expect(content()).toBe("ciao mondo");
    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().undoStack).toHaveLength(0);
    expect(useScene.getState().gesture).not.toBeNull();
  });

  it("una sessione lunga non accumula un'anteprima per tasto", async () => {
    render(<TextEditorOverlay nodeId="t1" />);
    await userEvent.type(field(), "0123456789");

    expect(useScene.getState().gesture!.preview.size).toBe(1);
    expect(content()).toBe("ciao0123456789");
  });
});

describe("uscita con conferma", () => {
  it("manda UN SOLO setText e lascia UNA voce di undo", async () => {
    render(<TextEditorOverlay nodeId="t1" />);
    await userEvent.type(field(), " mondo");
    fireEvent.blur(field());

    expect(sync.sent).toHaveLength(1);
    expect(sync.sent[0].kind.case).toBe("setText");
    expect(sync.sent[0].kind.case === "setText" && sync.sent[0].kind.value.content).toBe("ciao mondo");
    expect(content()).toBe("ciao mondo");
    expect(useScene.getState().undoStack).toHaveLength(1);
    expect(useScene.getState().gesture).toBeNull();
    expect(useScene.getState().editingNodeId).toBeNull();
  });

  it("TUTTA la sessione è UNA voce di undo: dieci tasti, un solo Ctrl+Z", async () => {
    render(<TextEditorOverlay nodeId="t1" />);
    await userEvent.type(field(), "0123456789");
    fireEvent.blur(field());
    expect(content()).toBe("ciao0123456789");

    act(() => useScene.getState().undo());

    // Un solo passo indietro riporta al contenuto di PARTENZA, non al
    // penultimo carattere.
    expect(content()).toBe("ciao");
    expect(useScene.getState().canUndo).toBe(false);
    expect(useScene.getState().canRedo).toBe(true);
  });

  it("Tab conferma (il fuoco esce dal campo)", async () => {
    render(<TextEditorOverlay nodeId="t1" />);
    await userEvent.type(field(), "!");
    await userEvent.tab();

    expect(sync.sent).toHaveLength(1);
    expect(content()).toBe("ciao!");
    expect(useScene.getState().editingNodeId).toBeNull();
  });

  it("uscire senza aver cambiato nulla non manda niente e non sporca la storia", () => {
    render(<TextEditorOverlay nodeId="t1" />);
    fireEvent.blur(field());

    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().undoStack).toHaveLength(0);
    expect(useScene.getState().canUndo).toBe(false);
    expect(useScene.getState().editingNodeId).toBeNull();
    expect(content()).toBe("ciao");
  });
});

// --- Step 3: uscita ---------------------------------------------------------

describe("uscita con Escape", () => {
  it("annulla: niente sul filo, niente nella storia, contenuto di partenza", async () => {
    render(<TextEditorOverlay nodeId="t1" />);
    await userEvent.type(field(), " buttato via");
    expect(content()).toBe("ciao buttato via");

    fireEvent.keyDown(field(), { key: "Escape" });

    expect(sync.sent).toHaveLength(0);
    expect(content()).toBe("ciao");
    expect(useScene.getState().undoStack).toHaveLength(0);
    expect(useScene.getState().gesture).toBeNull();
    expect(useScene.getState().editingNodeId).toBeNull();
  });

  it("su un nodo appena creato (vuoto) l'annullamento lo fa sparire, in modo annullabile", async () => {
    installScene(textNode("t1", ""));
    useScene.setState({ editingNodeId: "t1" });
    render(<TextEditorOverlay nodeId="t1" />);
    await userEvent.type(field(), "abc");

    fireEvent.keyDown(field(), { key: "Escape" });

    // Il nodo era rimasto vuoto: la politica dello store (endTextEditing) lo
    // cancella invece di lasciare un fantasma sulla scena -- ma passando da un
    // gesto, quindi con il suo Ctrl+Z.
    expect(useScene.getState().scene!.nodes["t1"]).toBeUndefined();
    expect(sync.sent).toHaveLength(1);
    expect(sync.sent[0].kind.case).toBe("deleteNode");
    act(() => useScene.getState().undo());
    expect(useScene.getState().scene!.nodes["t1"]).toBeDefined();
  });
});

describe("Enter", () => {
  it("va a capo e NON conferma: è un editor multilinea", async () => {
    render(<TextEditorOverlay nodeId="t1" />);
    await userEvent.type(field(), "{Enter}riga2");

    expect(field().value).toBe("ciao\nriga2");
    expect(content()).toBe("ciao\nriga2");
    expect(useScene.getState().editingNodeId).toBe("t1");
    expect(useScene.getState().gesture).not.toBeNull();
    expect(sync.sent).toHaveLength(0);
  });
});

// --- Step 4: le scorciatoie globali restano fuori ---------------------------

describe("scorciatoie globali mentre si scrive", () => {
  it("Ctrl+Z dentro il campo non arriva all'undo dell'app (e fuori sì)", () => {
    // Il campo qui viene dall'App vera (che lo monta da sé quando
    // editingNodeId è valorizzato): la guardia si verifica sull'app montata,
    // non su un overlay affiancato a mano.
    render(<App />);

    // La guardia isTextField di App.tsx esce PRIMA di preventDefault: se
    // l'evento non è stato cancellato, la scorciatoia non l'ha nemmeno
    // considerato -- l'undo nativo del campo resta quello del browser.
    const inField = new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true });
    act(() => {
      field().dispatchEvent(inField);
    });
    expect(inField.defaultPrevented).toBe(false);

    const outside = new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true });
    act(() => {
      document.body.dispatchEvent(outside);
    });
    expect(outside.defaultPrevented).toBe(true);
  });

  it("Backspace nel campo non cancella il nodo selezionato", async () => {
    render(<App />);
    expect(useScene.getState().selection).toEqual(["t1"]);

    await userEvent.type(field(), "{Backspace}{Backspace}");

    expect(field().value).toBe("ci");
    expect(useScene.getState().scene!.nodes["t1"]).toBeDefined();
    expect(sync.sent).toHaveLength(0);
  });
});

// --- Step 5: accenti e IME --------------------------------------------------

describe("accenti e IME", () => {
  it("gli accenti arrivano interi fino all'op finale", async () => {
    installScene(textNode("t1", ""));
    useScene.setState({ editingNodeId: "t1" });
    render(<TextEditorOverlay nodeId="t1" />);

    await userEvent.type(field(), "però{Enter}àèìòù");
    fireEvent.blur(field());

    expect(sync.sent).toHaveLength(1);
    expect(sync.sent[0].kind.case === "setText" && sync.sent[0].kind.value.content).toBe("però\nàèìòù");
  });

  it("una composizione IME non viene persa: conta il valore del campo, non i tasti", () => {
    render(<TextEditorOverlay nodeId="t1" />);
    const ta = field();

    // Sequenza tipica di un IME: nessun keydown utile, solo composition +
    // input. L'overlay legge il VALORE del campo, quindi la vede tutta.
    fireEvent.compositionStart(ta);
    fireEvent.change(ta, { target: { value: "ciao に" } });
    fireEvent.compositionEnd(ta, { data: "に" });

    expect(content()).toBe("ciao に");
    fireEvent.blur(ta);
    expect(sync.sent[0].kind.case === "setText" && sync.sent[0].kind.value.content).toBe("ciao に");
  });

  // Bug trovato in review: Escape era gestito INCONDIZIONATAMENTE. Con un IME
  // aperto quel tasto è il modo standard di rifiutare una conversione (chiude
  // la finestra dei candidati), e trattarlo come "annulla tutto" buttava via
  // l'intera sessione di editing -- proprio con le lingue per cui l'overlay
  // del DOM esiste.
  describe("Escape mentre l'IME sta componendo", () => {
    it("non chiude la sessione: quel tasto è dell'IME", () => {
      render(<TextEditorOverlay nodeId="t1" />);
      const ta = field();

      fireEvent.compositionStart(ta);
      fireEvent.change(ta, { target: { value: "ciao に" } });
      // L'utente rifiuta il candidato: l'IME si chiude, l'editing NO.
      fireEvent.keyDown(ta, { key: "Escape" });

      expect(screen.queryByRole("textbox", { name: FIELD_NAME })).not.toBeNull();
      expect(useScene.getState().editingNodeId).toBe("t1");
      expect(useScene.getState().gesture).not.toBeNull();
      expect(content()).toBe("ciao に");
      expect(sync.sent).toHaveLength(0);
    });

    it("torna a essere nostro appena la composizione finisce", () => {
      render(<TextEditorOverlay nodeId="t1" />);
      const ta = field();

      fireEvent.compositionStart(ta);
      fireEvent.change(ta, { target: { value: "ciao に" } });
      fireEvent.compositionEnd(ta, { data: "に" });

      fireEvent.keyDown(ta, { key: "Escape" });

      // Adesso Escape annulla come sempre: contenuto di partenza, niente sul
      // filo, niente nella storia.
      expect(useScene.getState().editingNodeId).toBeNull();
      expect(useScene.getState().gesture).toBeNull();
      expect(content()).toBe("ciao");
      expect(sync.sent).toHaveLength(0);
    });

    it("rispetta anche isComposing e il keyCode 229, che alcuni browser mandano da soli", () => {
      render(<TextEditorOverlay nodeId="t1" />);
      const ta = field();

      // Nessun compositionstart visto da noi (l'ordine degli eventi cambia da
      // browser a browser): resta il flag standard sull'evento...
      fireEvent.keyDown(ta, { key: "Escape", isComposing: true });
      expect(useScene.getState().editingNodeId).toBe("t1");

      // ...e il vecchio "tasto in lavorazione dall'IME".
      fireEvent.keyDown(ta, { key: "Escape", keyCode: 229 });
      expect(useScene.getState().editingNodeId).toBe("t1");
      expect(useScene.getState().gesture).not.toBeNull();

      // Un Escape normale, invece, esce.
      fireEvent.keyDown(ta, { key: "Escape" });
      expect(useScene.getState().editingNodeId).toBeNull();
    });
  });
});

// --- il wiring nell'app -----------------------------------------------------

// Un componente che nessuno monta è codice morto: il testo si potrebbe creare
// ma non scrivere. Questi test tengono chiuso quel buco -- è la stessa forma
// del bug "il tool testo non era nella toolbar" (vedi App.test.tsx).
describe("App monta l'overlay", () => {
  it("quando c'è un nodo in editing il campo esiste ed è VIVO", async () => {
    render(<App />);

    const ta = field();
    expect(ta.value).toBe("ciao");
    expect(document.activeElement).toBe(ta);

    await userEvent.type(ta, " mondo");
    fireEvent.blur(ta);

    // Non basta che il campo compaia: deve essere collegato allo store vero.
    expect(sync.sent).toHaveLength(1);
    expect(sync.sent[0].kind.case).toBe("setText");
    expect(content()).toBe("ciao mondo");
    expect(useScene.getState().editingNodeId).toBeNull();
  });

  it("senza editing non c'è nessun campo (e nessun gesto aperto)", () => {
    useScene.setState({ editingNodeId: null });
    render(<App />);

    expect(screen.queryByRole("textbox", { name: FIELD_NAME })).toBeNull();
    expect(useScene.getState().gesture).toBeNull();
  });

  it("cambiare nodo in editing sposta il campo sull'altro nodo", () => {
    installScene(textNode("t1", "primo"), textNode("t2", "secondo", { x: 300 }));
    useScene.setState({ editingNodeId: "t1" });
    render(<App />);
    expect(field().value).toBe("primo");

    act(() => useScene.getState().beginTextEditing("t2"));

    expect(field().value).toBe("secondo");
    expect(field().style.left).toBe("300px");
  });
});

// --- robustezza -------------------------------------------------------------

describe("il nodo sparisce mentre lo si edita", () => {
  it("un delete remoto chiude la sessione senza lasciare un gesto aperto", async () => {
    render(<TextEditorOverlay nodeId="t1" />);
    await userEvent.type(field(), " mondo");

    act(() => useScene.getState().apply(deleteOp("t1")));

    expect(screen.queryByRole("textbox", { name: FIELD_NAME })).toBeNull();
    expect(useScene.getState().gesture).toBeNull();
    expect(useScene.getState().editingNodeId).toBeNull();
    expect(sync.sent).toHaveLength(0);
  });

  it("un nodo che non è di testo non apre nessun campo", () => {
    installScene({ ...textNode("t1", "ciao"), kind: "rect", text: undefined });
    useScene.setState({ editingNodeId: "t1" });
    render(<TextEditorOverlay nodeId="t1" />);

    expect(screen.queryByRole("textbox", { name: FIELD_NAME })).toBeNull();
  });
});
