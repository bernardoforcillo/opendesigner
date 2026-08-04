// I matcher di jest-dom sono già installati dai setupFiles (vite.config.ts);
// l'import qui serve a TYPE-SCRIPT (tsc -b non legge i setupFiles).
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, within, cleanup, act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Op } from "../gen/brawt/v1/brawt_pb";
import { LayersPanel, layerDisplayName, reorderKey, visibleRows } from "./LayersPanel";
import { useScene } from "../store/store";
import { emptyScene } from "../store/types";
import { layersInDrawOrder } from "../store/selectors";
import type { NodeLite, PageLite } from "../store/types";

// Doppio di SyncClient: registra gli op che finiscono SUL FILO e modella un
// server che accetta ed ECOA subito (applyPending + apply), come negli altri
// test dello store (vedi TextEditorOverlay.test.tsx).
class FakeSync {
  sent: Op[] = [];
  submit(op: Op) {
    this.sent.push(op);
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
}

function rectNode(id: string, orderKey: string, over: Partial<NodeLite> = {}): NodeLite {
  return {
    id, parentId: "page1", orderKey, name: "", visible: true, opacity: 1,
    x: 0, y: 0, width: 100, height: 100, rotation: 0,
    fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false,
    ...over,
  };
}

function ellipseNode(id: string, orderKey: string, over: Partial<NodeLite> = {}): NodeLite {
  return { ...rectNode(id, orderKey), kind: "ellipse", ...over };
}

function textNode(id: string, orderKey: string, content: string, over: Partial<NodeLite> = {}): NodeLite {
  return {
    ...rectNode(id, orderKey),
    kind: "text",
    text: { content, style: { fontFamily: "Inter", fontSize: 16, fontWeight: "400", lineHeight: 1.5, align: "left" } },
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

let sync: FakeSync;

beforeEach(() => {
  sync = new FakeSync();
  useScene.setState({
    camera: { x: 0, y: 0, zoom: 1 },
    selection: [],
    marquee: null,
    gesture: null,
    editingNodeId: null,
  });
  useScene.getState().setSync(sync);
});

afterEach(cleanup);

function grid(): HTMLElement {
  return screen.getByRole("grid", { name: "Livelli" });
}

function rows(): HTMLElement[] {
  return within(grid()).getAllByRole("row");
}

// Simula la sequenza pointerdown -> mouseDown -> pointerup -> mouseUp ->
// click di un click reale del mouse, CON `pressure: 0.5` esplicito sul
// pointerdown.
//
// PERCHÉ non basta userEvent.click(): react-aria-components (usePress)
// distingue un click REALE da uno screen-reader/"virtuale" guardando
// width/height/pressure/detail del PointerEvent (react-aria/dist/private/
// utils/isVirtualEvent.mjs::isVirtualPointerEvent) -- un pattern pensato per
// TalkBack, non per jsdom. jsdom costruisce un PointerEvent con
// { width: 1, height: 1, pressure: 0 } quando questi campi non sono
// specificati, e QUELLA combinazione è esattamente l'euristica per un tap
// TalkBack. Ogni click sintetizzato da user-event (che non passa `pressure`)
// finisce quindi marcato "virtual" sotto jsdom -- mai sotto un browser vero,
// dove pressure di un mouse premuto è 0.5. Da "virtual" discende un effetto
// concreto e non solo cosmetico: selectionBehavior="replace" si comporta
// come "toggle" (ogni click AGGIUNGE invece di sostituire, vedi
// react-aria/dist/private/selection/useSelectableItem.mjs::onSelect), quindi
// senza questo aggiustamento "un secondo click semplice rimpiazza" e
// "ctrl/shift-click estende" sarebbero indistinguibili in questa suite.
// fireEvent (a differenza di user-event) costruisce il PointerEvent con
// `new PointerEvent(type, init)`, quindi accetta l'override.
function press(el: Element, opts: Partial<PointerEventInit & MouseEventInit> = {}) {
  const base = { button: 0, pointerId: 1, pointerType: "mouse", isPrimary: true, detail: 1, ...opts };
  fireEvent.pointerDown(el, { ...base, pressure: 0.5 });
  fireEvent.mouseDown(el, base);
  fireEvent.pointerUp(el, { ...base, pressure: 0 });
  fireEvent.mouseUp(el, base);
  fireEvent.click(el, base);
}

// --- Step 1: elenco, selezione, visibilità, eliminazione -------------------

describe("elenco", () => {
  it("mostra i nodi dal primo piano allo sfondo", () => {
    installScene(
      rectNode("bg", "a0", { name: "Sfondo" }),
      ellipseNode("mid", "a1", { name: "Centro" }),
      textNode("fg", "a2", "ciao", { name: "Primo piano" }),
    );
    render(<LayersPanel />);
    const labels = rows().map((r) => r.textContent);
    // "fg" (orderKey più alta, disegnata per ultima = primo piano) in cima,
    // "bg" (orderKey più bassa) in fondo -- l'inverso dell'ordine di disegno.
    expect(labels[0]).toContain("Primo piano");
    expect(labels[1]).toContain("Centro");
    expect(labels[2]).toContain("Sfondo");
  });

  it("una scena vuota mostra lo stato vuoto, non righe fantasma", () => {
    installScene();
    render(<LayersPanel />);
    expect(screen.getByText("Nessun livello")).toBeInTheDocument();
  });
});

describe("selezione: click su una riga", () => {
  it("seleziona il nodo (lo store lo riflette)", () => {
    installScene(rectNode("a", "a0", { name: "A" }), rectNode("b", "a1", { name: "B" }));
    render(<LayersPanel />);

    press(screen.getByText("B"));

    expect(useScene.getState().selection).toEqual(["b"]);
  });

  it("un secondo click SEMPLICE rimpiazza la selezione precedente", () => {
    installScene(rectNode("a", "a0", { name: "A" }), rectNode("b", "a1", { name: "B" }));
    render(<LayersPanel />);

    press(screen.getByText("B"));
    press(screen.getByText("A"));

    expect(useScene.getState().selection).toEqual(["a"]);
  });

  it("ctrl-click estende la selezione", () => {
    installScene(rectNode("a", "a0", { name: "A" }), rectNode("b", "a1", { name: "B" }));
    render(<LayersPanel />);

    press(screen.getByText("B"));
    press(screen.getByText("A"), { ctrlKey: true });

    expect(new Set(useScene.getState().selection)).toEqual(new Set(["a", "b"]));
  });

  it("shift-click estende la selezione per intervallo", () => {
    installScene(
      rectNode("a", "a0", { name: "A" }),
      rectNode("b", "a1", { name: "B" }),
      rectNode("c", "a2", { name: "C" }),
    );
    render(<LayersPanel />);

    // In cima alla lista (primo piano): C, B, A. Click su C poi shift-click
    // su A copre l'intero intervallo mostrato: tutti e tre.
    press(screen.getByText("C"));
    press(screen.getByText("A"), { shiftKey: true });

    expect(new Set(useScene.getState().selection)).toEqual(new Set(["a", "b", "c"]));
  });
});

describe("sincronizzazione bidirezionale", () => {
  it("selezionare sul canvas (store.setSelection) evidenzia la riga corrispondente", () => {
    installScene(rectNode("a", "a0", { name: "A" }), rectNode("b", "a1", { name: "B" }));
    render(<LayersPanel />);

    // Nessuna interazione col pannello: è il canvas (selectTool) che scrive
    // qui, esattamente con lo stesso store.setSelection. act(): una scrittura
    // diretta sullo store, fuori da un evento simulato da testing-library, va
    // avvolta esplicitamente perché React flushi il render prima dell'assert.
    act(() => {
      useScene.getState().setSelection(["b"]);
    });

    const rowA = screen.getByText("A").closest('[role="row"]') as HTMLElement;
    const rowB = screen.getByText("B").closest('[role="row"]') as HTMLElement;
    expect(rowB).toHaveAttribute("data-selected", "true");
    expect(rowA).not.toHaveAttribute("data-selected");
  });
});

describe("visibilità", () => {
  it("il toggle emette un SetProperties con mask visible, senza toccare la selezione", async () => {
    installScene(rectNode("a", "a0", { name: "A", visible: true }));
    useScene.getState().setSelection([]);
    render(<LayersPanel />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Nascondi A" }));

    expect(sync.sent).toHaveLength(1);
    const op = sync.sent[0];
    expect(op.kind.case).toBe("setProps");
    if (op.kind.case === "setProps") {
      expect(op.kind.value.id).toBe("a");
      expect(op.kind.value.mask?.paths).toEqual(["visible"]);
      expect(op.kind.value.patch?.visible).toBe(false);
    }
    expect(useScene.getState().scene?.nodes.a.visible).toBe(false);
    // Cliccare il pulsante di visibilità non deve selezionare la riga.
    expect(useScene.getState().selection).toEqual([]);
  });

  it("il toggle è un gesto (una voce di undo)", async () => {
    installScene(rectNode("a", "a0", { name: "A", visible: true }));
    render(<LayersPanel />);
    const user = userEvent.setup();
    const before = useScene.getState().undoStack.length;

    await user.click(screen.getByRole("button", { name: "Nascondi A" }));

    expect(useScene.getState().undoStack.length).toBe(before + 1);
    expect(useScene.getState().gesture).toBeNull();
  });
});

describe("eliminazione", () => {
  it("il pulsante è disabilitato senza selezione", () => {
    installScene(rectNode("a", "a0", { name: "A" }));
    render(<LayersPanel />);
    expect(screen.getByRole("button", { name: "Elimina i livelli selezionati" })).toBeDisabled();
  });

  it("emette deleteNode per OGNI nodo selezionato in un solo gesto (una sola voce di undo)", async () => {
    installScene(
      rectNode("a", "a0", { name: "A" }),
      rectNode("b", "a1", { name: "B" }),
      rectNode("c", "a2", { name: "C" }),
    );
    useScene.getState().setSelection(["a", "b"]);
    render(<LayersPanel />);
    const user = userEvent.setup();
    const undoBefore = useScene.getState().undoStack.length;

    await user.click(screen.getByRole("button", { name: "Elimina i livelli selezionati" }));

    const deleteIds = sync.sent
      .filter((op) => op.kind.case === "deleteNode")
      .map((op) => (op.kind.case === "deleteNode" ? op.kind.value.id : ""));
    expect(new Set(deleteIds)).toEqual(new Set(["a", "b"]));
    expect(sync.sent).toHaveLength(2);
    expect(useScene.getState().scene?.nodes.a).toBeUndefined();
    expect(useScene.getState().scene?.nodes.b).toBeUndefined();
    expect(useScene.getState().scene?.nodes.c).toBeDefined();
    // UNA sola voce di undo per l'intera cancellazione multipla, non una per
    // nodo: è il punto centrale del brief (Task 7, step 1).
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
    expect(useScene.getState().gesture).toBeNull();
  });

  // deleteNode cancella un SOTTOALBERO (applyOp / core.applyDelete): un figlio
  // selezionato insieme al suo gruppo non deve produrre un secondo op --
  // sarebbe rifiutato (il nodo è già sparito nella cascata) e farebbe saltare
  // la voce di undo dell'INTERO gesto.
  it("un gruppo E un suo discendente selezionati insieme emettono UN solo deleteNode", async () => {
    installScene(
      rectNode("g1", "a0", { name: "G" }),
      rectNode("c1", "a0", { name: "C", parentId: "g1" }),
      rectNode("other", "a1", { name: "Other" }),
    );
    useScene.getState().setSelection(["g1", "c1"]);
    render(<LayersPanel />);
    const user = userEvent.setup();
    const undoBefore = useScene.getState().undoStack.length;

    await user.click(screen.getByRole("button", { name: "Elimina i livelli selezionati" }));

    expect(sync.sent).toHaveLength(1);
    expect(sync.sent[0].kind.case === "deleteNode" && sync.sent[0].kind.value.id).toBe("g1");
    expect(useScene.getState().scene?.nodes.c1).toBeUndefined();
    expect(useScene.getState().scene?.nodes.other).toBeDefined();
    // La voce c'è ed è completa: g1 e c1 da ricreare, in un solo Ctrl+Z.
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
    expect(useScene.getState().undoStack[useScene.getState().undoStack.length - 1]).toHaveLength(2);
  });
});

// --- Step 3: il nome mostrato -----------------------------------------------

describe("layerDisplayName", () => {
  it("usa name quando è valorizzato", () => {
    expect(layerDisplayName(rectNode("a", "a0", { name: "Il mio rettangolo" }))).toBe("Il mio rettangolo");
  });

  it("ricade su 'Rectangle' per un rettangolo senza nome", () => {
    expect(layerDisplayName(rectNode("a", "a0", { name: "" }))).toBe("Rectangle");
  });

  it("ricade su 'Ellipse' per un'ellisse senza nome", () => {
    expect(layerDisplayName(ellipseNode("a", "a0", { name: "" }))).toBe("Ellipse");
  });

  // Un gruppo nasce già con un nome (tools/grouping.ts::GROUP_NAME); questo è
  // il ripiego per un gruppo rinominato a stringa vuota. Senza il suo ramo
  // cadrebbe in quello del TESTO e mostrerebbe "Text".
  it("ricade su 'Group' per un gruppo senza nome", () => {
    expect(layerDisplayName(rectNode("a", "a0", { name: "", kind: "group" }))).toBe("Group");
  });

  it("ricade sul contenuto (troncato) per un nodo testo senza nome", () => {
    expect(layerDisplayName(textNode("a", "a0", "ciao mondo", { name: "" }))).toBe("ciao mondo");
    const long = "a".repeat(50);
    const shown = layerDisplayName(textNode("a", "a0", long, { name: "" }));
    expect(shown.length).toBeLessThan(50);
    expect(shown.endsWith("…")).toBe(true);
  });

  it("ricade su 'Text' per un nodo testo vuoto senza nome", () => {
    expect(layerDisplayName(textNode("a", "a0", "   ", { name: "" }))).toBe("Text");
  });

  it("mostra il nome nella riga (kind fallback nella lista vera)", () => {
    installScene(rectNode("a", "a0", { name: "" }), ellipseNode("b", "a1", { name: "" }));
    render(<LayersPanel />);
    expect(screen.getByText("Rectangle")).toBeInTheDocument();
    expect(screen.getByText("Ellipse")).toBeInTheDocument();
  });
});

// --- Task 8, step 1: rinomina inline ---------------------------------------

function nameField(): HTMLInputElement {
  return screen.getByRole("textbox", { name: "Nome del livello" }) as HTMLInputElement;
}

describe("rinomina inline", () => {
  it("il doppio click sul nome apre un campo, seminato col nome VERO e col nome mostrato come placeholder", async () => {
    installScene(rectNode("a", "a0", { name: "" }));
    render(<LayersPanel />);
    const user = userEvent.setup();

    await user.dblClick(screen.getByText("Rectangle"));

    const field = nameField();
    // Seminato col nome vero (vuoto), non con il fallback: premere Enter senza
    // scrivere niente non deve PERSISTERE "Rectangle" come nome esplicito.
    expect(field).toHaveValue("");
    expect(field).toHaveAttribute("placeholder", "Rectangle");
    expect(field).toHaveFocus();
  });

  it("Enter conferma con un SetProperties mask name, in un solo gesto", async () => {
    installScene(rectNode("a", "a0", { name: "A" }));
    render(<LayersPanel />);
    const user = userEvent.setup();
    const undoBefore = useScene.getState().undoStack.length;

    await user.dblClick(screen.getByText("A"));
    await user.clear(nameField());
    await user.type(nameField(), "Pulsante{Enter}");

    expect(sync.sent).toHaveLength(1);
    const op = sync.sent[0];
    expect(op.kind.case).toBe("setProps");
    if (op.kind.case === "setProps") {
      expect(op.kind.value.id).toBe("a");
      expect(op.kind.value.mask?.paths).toEqual(["name"]);
      expect(op.kind.value.patch?.name).toBe("Pulsante");
    }
    expect(useScene.getState().scene?.nodes.a.name).toBe("Pulsante");
    // Un gesto, una voce di undo -- come ogni altra modifica del pannello.
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
    expect(useScene.getState().gesture).toBeNull();
    // Il campo si chiude e la riga torna a mostrare il nome.
    expect(screen.queryByRole("textbox", { name: "Nome del livello" })).toBeNull();
    expect(screen.getByText("Pulsante")).toBeInTheDocument();
  });

  it("Escape annulla: niente op, niente voce di undo, nome invariato", async () => {
    installScene(rectNode("a", "a0", { name: "A" }));
    render(<LayersPanel />);
    const user = userEvent.setup();
    const undoBefore = useScene.getState().undoStack.length;

    await user.dblClick(screen.getByText("A"));
    await user.clear(nameField());
    await user.type(nameField(), "Scartato{Escape}");

    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().scene?.nodes.a.name).toBe("A");
    expect(useScene.getState().undoStack.length).toBe(undoBefore);
    expect(screen.queryByRole("textbox", { name: "Nome del livello" })).toBeNull();
    expect(screen.getByText("A")).toBeInTheDocument();
  });

  it("confermare senza aver cambiato niente non manda nessun op", async () => {
    installScene(rectNode("a", "a0", { name: "A" }));
    render(<LayersPanel />);
    const user = userEvent.setup();

    await user.dblClick(screen.getByText("A"));
    await user.type(nameField(), "{Enter}");

    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().undoStack).toHaveLength(0);
  });

  it("mentre il campo ha il fuoco le scorciatoie globali restano inattive", async () => {
    installScene(rectNode("a", "a0", { name: "Alfa" }), rectNode("b", "a1", { name: "Beta" }));
    useScene.getState().setSelection(["a"]);
    render(<LayersPanel />);
    const user = userEvent.setup();

    await user.dblClick(screen.getByText("Alfa"));
    const selectionBefore = useScene.getState().selection;

    // Le scorciatoie globali dell'app (undo/redo in ui/App.tsx, Escape/Canc in
    // tools/toolManager.ts) ascoltano sulla FINESTRA: se un tasto battuto nel
    // campo arriva fin lì, Canc cancella il nodo che si sta rinominando e
    // Ctrl+Z annulla il gesto precedente invece del testo digitato.
    const onWindowKey = vi.fn();
    window.addEventListener("keydown", onWindowKey);
    try {
      await user.type(nameField(), "Beta{Backspace}{Delete}");
      await user.keyboard("{Control>}z{/Control}");
      expect(onWindowKey).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", onWindowKey);
    }

    // E nemmeno le scorciatoie della GridList stessa: scrivere "Beta" non deve
    // far scattare il typeahead sulla riga omonima.
    expect(useScene.getState().selection).toEqual(selectionBefore);
    expect(useScene.getState().selection).not.toContain("b");
  });
});

// --- Task 8, step 2/3: riordino con drag ------------------------------------

// L'ordine come lo vede il RESTO dell'app: layersInDrawOrder sulla scena dello
// store, non le righe del DOM. È il punto del brief -- il riordino deve cambiare
// l'ordine di disegno sul canvas, non solo l'aspetto del pannello.
function order(): string[] {
  const scene = useScene.getState().scene;
  return scene ? layersInDrawOrder(scene).map((n) => n.id) : [];
}

function rowOf(label: string): HTMLElement {
  return screen.getByText(label).closest('[role="row"]') as HTMLElement;
}

// Trascina la riga `from` sopra la riga `onto` e rilascia. Il rilascio arriva
// sulla FINESTRA (non sulla riga): è dove il pannello lo ascolta, perché il
// pointer può benissimo essere rilasciato fuori dalla lista.
function dragOnto(from: string, onto: string) {
  const handle = screen.getByRole("button", { name: `Riordina ${from}` });
  const base = { pointerId: 1, pointerType: "mouse", isPrimary: true };
  fireEvent.pointerDown(handle, { ...base, button: 0, pressure: 0.5 });
  fireEvent.pointerMove(rowOf(onto), base);
  fireEvent.pointerUp(window, { ...base, pressure: 0 });
}

describe("riordino con drag", () => {
  it("trascinare una riga su un'altra cambia l'ordine di disegno", () => {
    installScene(
      rectNode("a", "a0", { name: "A" }),
      rectNode("b", "a1", { name: "B" }),
      rectNode("c", "a2", { name: "C" }),
    );
    render(<LayersPanel />);
    // Lista (primo piano in cima): C, B, A.
    expect(order()).toEqual(["c", "b", "a"]);

    // C dal primo piano fino al posto di A (il fondo).
    dragOnto("C", "A");

    expect(order()).toEqual(["b", "a", "c"]);
  });

  it("emette UN SOLO SetProperties con mask order_key, in un solo gesto", () => {
    installScene(
      rectNode("a", "a0", { name: "A" }),
      rectNode("b", "a1", { name: "B" }),
      rectNode("c", "a2", { name: "C" }),
    );
    render(<LayersPanel />);
    const undoBefore = useScene.getState().undoStack.length;

    dragOnto("C", "A");

    expect(sync.sent).toHaveLength(1);
    const op = sync.sent[0];
    expect(op.kind.case).toBe("setProps");
    if (op.kind.case === "setProps") {
      expect(op.kind.value.id).toBe("c");
      expect(op.kind.value.mask?.paths).toEqual(["order_key"]);
      // La chiave calcolata è quella che il nodo ha davvero adesso, ed è
      // strettamente sotto quella di "a" (che è rimasta dov'era).
      const key = op.kind.value.patch?.orderKey ?? "";
      expect(useScene.getState().scene?.nodes.c.orderKey).toBe(key);
      expect(key < "a0").toBe(true);
    }
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
    expect(useScene.getState().gesture).toBeNull();
  });

  it("trascinare una riga su sé stessa non emette niente", () => {
    installScene(rectNode("a", "a0", { name: "A" }), rectNode("b", "a1", { name: "B" }));
    render(<LayersPanel />);

    dragOnto("B", "B");

    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().undoStack).toHaveLength(0);
  });

  it("gli estremi sono aperti: si può portare una riga in cima e in fondo", () => {
    installScene(
      rectNode("a", "a0", { name: "A" }),
      rectNode("b", "a1", { name: "B" }),
      rectNode("c", "a2", { name: "C" }),
    );
    render(<LayersPanel />);

    // Dal fondo alla cima: nessun vicino sopra, l'estremo superiore è aperto.
    dragOnto("A", "C");
    expect(order()).toEqual(["a", "c", "b"]);

    // E ritorno: dalla cima al fondo, estremo inferiore aperto.
    dragOnto("A", "B");
    expect(order()).toEqual(["c", "b", "a"]);
  });

  it("riordinare RIPETUTAMENTE nello stesso punto continua a funzionare", () => {
    installScene(
      rectNode("a", "a0", { name: "A" }),
      rectNode("b", "a1", { name: "B" }),
      rectNode("c", "a2", { name: "C" }),
    );
    render(<LayersPanel />);

    // Ogni giro infila la riga di fondo FRA le altre due: è esattamente il caso
    // che l'indice frazionario del Task 2 esiste per sostenere (il formato
    // "a" + 6 cifre di M0/M1a non ammetteva nessuna chiave fra due vicine, e
    // dal secondo inserimento nello stesso punto sarebbe stato impossibile).
    let expected = ["c", "b", "a"];
    const labels: Record<string, string> = { a: "A", b: "B", c: "C" };
    for (let i = 0; i < 20; i++) {
      dragOnto(labels[expected[2]], labels[expected[1]]);
      expected = [expected[0], expected[2], expected[1]];
      expect(order()).toEqual(expected);
    }
    // Venti op, venti gesti: nessuno è stato scartato per una chiave impossibile.
    expect(sync.sent).toHaveLength(20);
  });

  it("Alt+freccia sulla maniglia riordina da tastiera, con lo stesso op e lo stesso gesto", () => {
    installScene(
      rectNode("a", "a0", { name: "A" }),
      rectNode("b", "a1", { name: "B" }),
      rectNode("c", "a2", { name: "C" }),
    );
    render(<LayersPanel />);
    const undoBefore = useScene.getState().undoStack.length;

    // Senza mouse il riordino sarebbe l'unica funzione del pannello
    // irraggiungibile: la maniglia è un <button> vero apposta. ALT+freccia e
    // non la freccia liscia: react-aria riserva ArrowUp/ArrowDown alla
    // navigazione fra righe e le ferma in capture prima dei figli della riga
    // (vedi il commento sulla maniglia in LayersPanel.tsx).
    fireEvent.keyDown(screen.getByRole("button", { name: "Riordina A" }), {
      key: "ArrowUp",
      altKey: true,
    });

    expect(order()).toEqual(["c", "a", "b"]);
    expect(sync.sent).toHaveLength(1);
    expect(sync.sent[0].kind.case).toBe("setProps");
    if (sync.sent[0].kind.case === "setProps") {
      expect(sync.sent[0].kind.value.mask?.paths).toEqual(["order_key"]);
    }
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
  });

  it("la freccia che uscirebbe dalla lista non fa niente", () => {
    installScene(rectNode("a", "a0", { name: "A" }), rectNode("b", "a1", { name: "B" }));
    render(<LayersPanel />);

    // B è già in cima (primo piano): sopra non c'è nessun posto.
    fireEvent.keyDown(screen.getByRole("button", { name: "Riordina B" }), {
      key: "ArrowUp",
      altKey: true,
    });

    expect(order()).toEqual(["b", "a"]);
    expect(sync.sent).toHaveLength(0);
  });

  it("la freccia SENZA Alt resta a react-aria (navigazione fra righe), non riordina", () => {
    installScene(rectNode("a", "a0", { name: "A" }), rectNode("b", "a1", { name: "B" }));
    render(<LayersPanel />);

    fireEvent.keyDown(screen.getByRole("button", { name: "Riordina A" }), { key: "ArrowUp" });

    expect(order()).toEqual(["b", "a"]);
    expect(sync.sent).toHaveLength(0);
  });
});

// --- Task 8, step 2: la chiave calcolata (funzione pura) ---------------------

describe("reorderKey", () => {
  // Le righe come le mostra il pannello: primo piano in cima, orderKey
  // DECRESCENTE.
  const layers = [
    rectNode("c", "a2"),
    rectNode("b", "a1"),
    rectNode("a", "a0"),
  ];

  it("null quando la riga non si muove", () => {
    expect(reorderKey(layers, 1, 1)).toBeNull();
  });

  it("null per indici fuori dalla lista", () => {
    expect(reorderKey(layers, -1, 1)).toBeNull();
    expect(reorderKey(layers, 0, 3)).toBeNull();
  });

  it("in cima: chiave sopra a tutte (estremo superiore aperto)", () => {
    const key = reorderKey(layers, 2, 0);
    expect(key).not.toBeNull();
    expect(key! > "a2").toBe(true);
  });

  it("in fondo: chiave sotto a tutte (estremo inferiore aperto)", () => {
    const key = reorderKey(layers, 0, 2);
    expect(key).not.toBeNull();
    expect(key! < "a0").toBe(true);
  });

  it("in mezzo: chiave strettamente fra i due vicini della posizione d'arrivo", () => {
    const key = reorderKey(layers, 0, 1);
    expect(key).not.toBeNull();
    expect(key! > "a0").toBe(true);
    expect(key! < "a1").toBe(true);
  });

  it("null (invece di lanciare) quando i due vicini hanno la STESSA chiave", () => {
    // Non è raggiungibile dalla UI, ma nemmeno impossibile nel modello (niente
    // impedisce a due nodi di condividere una order key): orderKeyBetween
    // lancerebbe, e lanciare dentro il gestore di un pointerup vorrebbe dire
    // rompere l'app durante un trascinamento.
    const dup = [rectNode("x", "a1"), rectNode("y", "a1"), rectNode("z", "a1")];
    expect(reorderKey(dup, 0, 1)).toBeNull();
  });
});

// --- Traccia annidamento: albero + drag-per-riparentare --------------------

function groupNode(id: string, orderKey: string, over: Partial<NodeLite> = {}): NodeLite {
  return { ...rectNode(id, orderKey), kind: "group", name: "", ...over };
}

function frameNode(id: string, orderKey: string, over: Partial<NodeLite> = {}): NodeLite {
  return { ...rectNode(id, orderKey), kind: "frame", clipsContent: true, ...over };
}

// Come installScene, ma con un elenco di pagine esplicito (per i test che
// cambiano pagina). currentPageId viene ricalcolato da setScene contro le
// pagine passate.
function installScenePages(pages: PageLite[], ...nodes: NodeLite[]) {
  const scene = emptyScene("doc-1", "Untitled");
  scene.pages = pages;
  for (const n of nodes) scene.nodes[n.id] = n;
  useScene.getState().setScene(scene);
}

// Avvia un trascinamento di `from` (presa la maniglia) e lo porta sopra la
// riga `onto`, SENZA rilasciare: serve a ispezionare lo stato del pannello a
// metà drag (bersagli invalidi).
function dragHover(from: string, onto: string) {
  const handle = screen.getByRole("button", { name: `Riordina ${from}` });
  const base = { pointerId: 1, pointerType: "mouse", isPrimary: true };
  fireEvent.pointerDown(handle, { ...base, button: 0, pressure: 0.5 });
  fireEvent.pointerMove(rowOf(onto), base);
}

describe("albero: gerarchia della pagina corrente", () => {
  it("mostra i figli sotto il container, indentati per profondità", () => {
    installScene(
      groupNode("g", "a1", { name: "Gruppo" }),
      rectNode("c1", "a0", { name: "Figlio1", parentId: "g" }),
      rectNode("c2", "a1", { name: "Figlio2", parentId: "g" }),
      rectNode("r", "a0", { name: "Radice" }),
    );
    render(<LayersPanel />);

    const labels = rows().map((row) => row.textContent ?? "");
    const idxG = labels.findIndex((l) => l.includes("Gruppo"));
    const idxC1 = labels.findIndex((l) => l.includes("Figlio1"));
    const idxC2 = labels.findIndex((l) => l.includes("Figlio2"));
    const idxR = labels.findIndex((l) => l.includes("Radice"));

    // Il container prima dei suoi figli, i figli prima del fratello di sfondo.
    expect(idxG).toBeLessThan(idxC2);
    expect(idxC2).toBeLessThan(idxC1); // fra i figli, primo piano (c2, a1) in cima
    expect(idxC1).toBeLessThan(idxR);

    // Profondità: i figli sono un livello più dentro del container.
    expect(rowOf("Gruppo")).toHaveAttribute("data-depth", "0");
    expect(rowOf("Radice")).toHaveAttribute("data-depth", "0");
    expect(rowOf("Figlio1")).toHaveAttribute("data-depth", "1");
    expect(rowOf("Figlio2")).toHaveAttribute("data-depth", "1");
  });

  it("espandi/collassa è stato di vista: nasconde i figli senza op né undo", async () => {
    installScene(
      groupNode("g", "a1", { name: "Gruppo" }),
      rectNode("c", "a0", { name: "Figlio", parentId: "g" }),
    );
    render(<LayersPanel />);
    const user = userEvent.setup();
    expect(screen.getByText("Figlio")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Comprimi Gruppo" }));
    expect(screen.queryByText("Figlio")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Espandi Gruppo" }));
    expect(screen.getByText("Figlio")).toBeInTheDocument();

    // Nessun op sul filo, nessuna voce di undo: è stato di vista come la camera.
    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().undoStack).toHaveLength(0);
  });

  it("cambiare pagina cambia l'albero", () => {
    installScenePages(
      [{ id: "page1", name: "P1" }, { id: "page2", name: "P2" }],
      rectNode("a", "a0", { name: "SuUno", parentId: "page1" }),
      rectNode("b", "a0", { name: "SuDue", parentId: "page2" }),
    );
    useScene.getState().setCurrentPage("page1");
    render(<LayersPanel />);

    expect(screen.getByText("SuUno")).toBeInTheDocument();
    expect(screen.queryByText("SuDue")).toBeNull();

    act(() => {
      useScene.getState().setCurrentPage("page2");
    });

    expect(screen.queryByText("SuUno")).toBeNull();
    expect(screen.getByText("SuDue")).toBeInTheDocument();
  });
});

describe("albero: drag per riparentare", () => {
  it("trascinare DENTRO un gruppo emette UN ReparentNode al nuovo parent, una voce di undo", () => {
    installScene(
      groupNode("g", "a1", { name: "Gruppo" }),
      rectNode("r", "a0", { name: "Rett" }),
    );
    render(<LayersPanel />);
    const undoBefore = useScene.getState().undoStack.length;

    dragOnto("Rett", "Gruppo");

    expect(sync.sent).toHaveLength(1);
    const op = sync.sent[0];
    expect(op.kind.case).toBe("reparentNode");
    if (op.kind.case === "reparentNode") {
      expect(op.kind.value.id).toBe("r");
      expect(op.kind.value.newParentId).toBe("g");
    }
    expect(useScene.getState().scene?.nodes.r.parentId).toBe("g");
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
    expect(useScene.getState().gesture).toBeNull();
  });

  it("trascinare DENTRO un frame riparenta al frame", () => {
    installScene(
      frameNode("f", "a1", { name: "Frame" }),
      rectNode("r", "a0", { name: "Rett" }),
    );
    render(<LayersPanel />);

    dragOnto("Rett", "Frame");

    expect(sync.sent).toHaveLength(1);
    expect(sync.sent[0].kind.case).toBe("reparentNode");
    if (sync.sent[0].kind.case === "reparentNode") {
      expect(sync.sent[0].kind.value.newParentId).toBe("f");
    }
    expect(useScene.getState().scene?.nodes.r.parentId).toBe("f");
  });

  it("trascinare fuori, su una radice di pagina, riparenta alla pagina con orderKey fra i vicini", () => {
    installScene(
      groupNode("g", "a1", { name: "Gruppo" }),
      rectNode("c", "a0", { name: "Figlio", parentId: "g" }),
      rectNode("r", "a0", { name: "Radice" }),
    );
    render(<LayersPanel />);
    const undoBefore = useScene.getState().undoStack.length;

    // Il figlio, trascinato su una radice di pagina, esce dal gruppo e diventa
    // radice a fianco di essa.
    dragOnto("Figlio", "Radice");

    expect(sync.sent).toHaveLength(1);
    const op = sync.sent[0];
    expect(op.kind.case).toBe("reparentNode");
    if (op.kind.case === "reparentNode") {
      expect(op.kind.value.id).toBe("c");
      expect(op.kind.value.newParentId).toBe("page1");
      // fra i vicini: sopra "r" (a0) e sotto "g" (a1).
      const key = op.kind.value.orderKey;
      expect(key > "a0").toBe(true);
      expect(key < "a1").toBe(true);
    }
    expect(useScene.getState().scene?.nodes.c.parentId).toBe("page1");
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
  });

  it("un drop che farebbe un ciclo NON è offerto e NON produce nulla", () => {
    installScene(
      groupNode("g", "a1", { name: "Gruppo" }),
      rectNode("c", "a0", { name: "Figlio", parentId: "g" }),
    );
    render(<LayersPanel />);

    // A metà drag il discendente è marcato come bersaglio non valido.
    dragHover("Gruppo", "Figlio");
    expect(rowOf("Figlio")).toHaveAttribute("data-drop-invalid", "true");

    const base = { pointerId: 1, pointerType: "mouse", isPrimary: true };
    fireEvent.pointerUp(window, { ...base, pressure: 0 });

    // Calare un gruppo dentro un proprio figlio è rifiutato: niente op, niente
    // undo, il gruppo resta radice.
    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().undoStack).toHaveLength(0);
    expect(useScene.getState().scene?.nodes.g.parentId).toBe("page1");
  });

  it("trascinare su un fratello (stesso parent) resta un riordino: SetProperties order_key", () => {
    // Due radici di pagina non-container: dropare l'una sull'altra è un puro
    // riordino, come nella lista piatta -- il percorso di solo-riordino esiste
    // già e va usato al posto di un ReparentNode.
    installScene(
      rectNode("a", "a0", { name: "A" }),
      rectNode("b", "a1", { name: "B" }),
    );
    render(<LayersPanel />);

    dragOnto("B", "A");

    expect(sync.sent).toHaveLength(1);
    expect(sync.sent[0].kind.case).toBe("setProps");
    if (sync.sent[0].kind.case === "setProps") {
      expect(sync.sent[0].kind.value.mask?.paths).toEqual(["order_key"]);
    }
  });
});

describe("visibleRows", () => {
  it("scende solo nei container espansi, primo piano in cima", () => {
    const scene = emptyScene("doc-1", "Untitled");
    scene.nodes["g"] = groupNode("g", "a1", { name: "G" });
    scene.nodes["c1"] = rectNode("c1", "a0", { name: "C1", parentId: "g" });
    scene.nodes["c2"] = rectNode("c2", "a1", { name: "C2", parentId: "g" });
    scene.nodes["r"] = rectNode("r", "a0", { name: "R" });

    const expanded = visibleRows(scene, "page1", new Set());
    expect(expanded.map((row) => row.id)).toEqual(["g", "c2", "c1", "r"]);
    expect(expanded.find((row) => row.id === "c1")?.depth).toBe(1);

    // Compresso: i figli non compaiono.
    const collapsed = visibleRows(scene, "page1", new Set(["g"]));
    expect(collapsed.map((row) => row.id)).toEqual(["g", "r"]);
  });
});
