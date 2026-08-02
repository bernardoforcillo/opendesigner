// I matcher di jest-dom sono già installati dai setupFiles (vite.config.ts);
// l'import qui serve a TYPE-SCRIPT (tsc -b non legge i setupFiles).
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, within, cleanup, act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Op } from "../gen/brawt/v1/brawt_pb";
import { LayersPanel, layerDisplayName } from "./LayersPanel";
import { useScene } from "../store/store";
import { emptyScene } from "../store/types";
import type { NodeLite } from "../store/types";

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
    fills: [{ r: 0, g: 0, b: 0, a: 1 }], kind: "rect", cornerRadius: 0,
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
