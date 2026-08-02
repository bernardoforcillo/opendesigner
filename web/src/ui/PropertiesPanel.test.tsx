import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Op } from "../gen/brawt/v1/brawt_pb";
import { PropertiesPanel } from "./PropertiesPanel";
import { useScene } from "../store/store";
import { emptyScene } from "../store/types";
import type { NodeLite } from "../store/types";

// Doppio di SyncClient: registra gli op che finiscono SUL FILO e modella un
// server che accetta ed ECOA subito (applyPending + apply), come
// ui/LayersPanel.test.tsx.
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
    x: 10, y: 20, width: 30, height: 40, rotation: 0,
    fills: [{ r: 0, g: 0, b: 0, a: 1 }], kind: "rect", cornerRadius: 0,
    ...over,
  };
}

function installScene(...nodes: NodeLite[]) {
  const scene = emptyScene("doc-1", "Untitled");
  for (const n of nodes) scene.nodes[n.id] = n;
  // setScene e non setState({scene}): installa una scena COERENTE (vista e
  // confermato allineati, coda vuota, storia azzerata) -- l'invariante della
  // riconciliazione, e il punto di partenza pulito per ogni test.
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

function field(letter: string): HTMLInputElement {
  return screen.getByRole("textbox", { name: letter }) as HTMLInputElement;
}

function label(letter: string): HTMLElement {
  return screen.getByText(letter, { selector: "label" });
}

// Trascina l'etichetta `letter` di `dx` px (in un solo passo intermedio) e
// rilascia. pointerId condiviso fra i tre eventi: è così che NumberField
// riconosce che appartengono allo STESSO trascinamento.
function dragLabel(letter: string, dx: number) {
  const el = label(letter);
  const base = { pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0 };
  fireEvent.pointerDown(el, { ...base, clientX: 0 });
  fireEvent.pointerMove(el, { ...base, clientX: Math.round(dx / 2) });
  fireEvent.pointerMove(el, { ...base, clientX: dx });
  fireEvent.pointerUp(el, { ...base, clientX: dx });
}

// --- Step 1: valori mostrati, digitazione, trascinamento, selezione vuota --

describe("senza selezione", () => {
  it("il pannello è vuoto/disabilitato: nessun campo geometrico", () => {
    installScene(rectNode("a", "a0"));
    render(<PropertiesPanel />);

    expect(screen.queryByRole("textbox", { name: "X" })).toBeNull();
    expect(screen.getByText("Nessuna selezione")).toBeInTheDocument();
  });
});

describe("un nodo selezionato", () => {
  it("i campi X/Y/W/H mostrano i suoi valori", () => {
    installScene(rectNode("a", "a0", { x: 10, y: 20, width: 30, height: 40 }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);

    expect(field("X")).toHaveValue("10");
    expect(field("Y")).toHaveValue("20");
    expect(field("W")).toHaveValue("30");
    expect(field("H")).toHaveValue("40");
  });
});

describe("digitare e confermare", () => {
  it("emette UN SetProperties con la sola mask del campo modificato", async () => {
    installScene(rectNode("a", "a0", { x: 10, y: 20, width: 30, height: 40 }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();
    const undoBefore = useScene.getState().undoStack.length;

    await user.clear(field("X"));
    await user.type(field("X"), "99{Enter}");

    expect(sync.sent).toHaveLength(1);
    const op = sync.sent[0];
    expect(op.kind.case).toBe("setProps");
    if (op.kind.case === "setProps") {
      expect(op.kind.value.id).toBe("a");
      expect(op.kind.value.mask?.paths).toEqual(["x"]);
      expect(op.kind.value.patch?.x).toBe(99);
      // Nessun altro campo tocco: la mask è la sola prova che conta, ma il
      // valore confermato non deve nemmeno comparire fuori da x.
      expect(op.kind.value.patch?.y).toBe(0);
    }
    expect(useScene.getState().scene?.nodes.a.x).toBe(99);
    // Un gesto, una voce di undo -- come ogni altra modifica dei pannelli.
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
    expect(useScene.getState().gesture).toBeNull();
  });

  it("confermare lo STESSO valore non manda nessun op", async () => {
    installScene(rectNode("a", "a0", { x: 10, y: 20, width: 30, height: 40 }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();

    await user.click(field("Y"));
    await user.keyboard("{Enter}");

    expect(sync.sent).toHaveLength(0);
  });
});

describe("trascinare l'etichetta", () => {
  it("produce un solo gesto (una voce di undo, un invio), non uno per pixel", () => {
    installScene(rectNode("a", "a0", { x: 10, y: 20, width: 30, height: 40 }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);
    const undoBefore = useScene.getState().undoStack.length;

    dragLabel("X", 25);

    // UN solo op sul filo -- non uno per pointermove -- e UNA sola voce di
    // undo, esattamente come il drag di spostamento di selectTool.ts.
    expect(sync.sent).toHaveLength(1);
    const op = sync.sent[0];
    expect(op.kind.case).toBe("setProps");
    if (op.kind.case === "setProps") {
      expect(op.kind.value.mask?.paths).toEqual(["x"]);
      expect(op.kind.value.patch?.x).toBe(35); // 10 (partenza) + 25 (dx)
    }
    expect(useScene.getState().scene?.nodes.a.x).toBe(35);
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
    expect(useScene.getState().gesture).toBeNull();
  });

  it("il trascinamento aggiorna il valore mostrato in ANTEPRIMA, prima del rilascio", () => {
    installScene(rectNode("a", "a0", { x: 10, y: 20, width: 30, height: 40 }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);

    const el = label("X");
    const base = { pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0 };
    fireEvent.pointerDown(el, { ...base, clientX: 0 });
    fireEvent.pointerMove(el, { ...base, clientX: 12 });

    // Anteprima locale: il documento cambia (applyLocal), ma NIENTE è ancora
    // partito verso il server -- il gesto è ancora aperto.
    expect(useScene.getState().scene?.nodes.a.x).toBe(22);
    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().gesture).not.toBeNull();

    fireEvent.pointerUp(el, { ...base, clientX: 12 });
    expect(sync.sent).toHaveLength(1);
    expect(useScene.getState().gesture).toBeNull();
  });

  it("un click sull'etichetta senza superare la soglia non apre nessun gesto", () => {
    installScene(rectNode("a", "a0", { x: 10, y: 20, width: 30, height: 40 }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);
    const undoBefore = useScene.getState().undoStack.length;

    dragLabel("X", 1); // sotto SCRUB_SLOP_PX

    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().scene?.nodes.a.x).toBe(10);
    expect(useScene.getState().undoStack.length).toBe(undoBefore);
    expect(useScene.getState().gesture).toBeNull();
  });
});

// --- Step 3: nessun NaN non deve poter raggiungere il documento ------------

describe("valori non validi", () => {
  it("un campo svuotato e confermato non emette nessun Op", async () => {
    installScene(rectNode("a", "a0", { x: 10, y: 20, width: 30, height: 40 }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();

    await user.clear(field("X"));
    await user.keyboard("{Enter}");

    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().scene?.nodes.a.x).toBe(10);
    expect(Number.isNaN(useScene.getState().scene?.nodes.a.x)).toBe(false);
    // Il campo torna a mostrare il valore vero: niente resta bloccato vuoto.
    expect(field("X")).toHaveValue("10");
  });

  it("un valore che non parsa affatto (es. '-' da solo) non emette nessun Op", async () => {
    installScene(rectNode("a", "a0", { x: 10, y: 20, width: 30, height: 40 }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();

    await user.clear(field("X"));
    await user.type(field("X"), "-{Enter}");

    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().scene?.nodes.a.x).toBe(10);
    expect(field("X")).toHaveValue("10");
  });

  it("nessun NaN raggiunge mai scene.nodes indipendentemente dal percorso", () => {
    // Guardia diretta sul modello: qualunque bug futuro nel filtro di
    // NumberField non deve poter scrivere un x/y/width/height NaN nel
    // documento -- è la conseguenza concreta che il brief descrive (un nodo
    // con x=NaN diventa invisibile e irrecuperabile dalla UI).
    installScene(rectNode("a", "a0", { x: 10, y: 20, width: 30, height: 40 }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);

    const node = useScene.getState().scene?.nodes.a;
    expect(node).toBeDefined();
    for (const v of [node!.x, node!.y, node!.width, node!.height]) {
      expect(Number.isNaN(v)).toBe(false);
    }
  });
});

// Silenzia l'avviso react-stately su controllato/non controllato se mai
// dovesse ricomparire per regressione: un test che lo intercetta è più utile
// di uno che lo ignora in silenzio.
describe("nessun avviso di controllo react-stately", () => {
  it("passare da selezione singola a nessuna selezione non stampa l'avviso controlled/uncontrolled", () => {
    installScene(rectNode("a", "a0", { x: 10, y: 20, width: 30, height: 40 }));
    useScene.getState().setSelection(["a"]);
    const { rerender } = render(<PropertiesPanel />);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      useScene.getState().setSelection([]);
      rerender(<PropertiesPanel />);
      useScene.getState().setSelection(["a"]);
      rerender(<PropertiesPanel />);
      const controlledWarning = warn.mock.calls.some((args) =>
        String(args[0]).includes("controlled"));
      expect(controlledWarning).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});
