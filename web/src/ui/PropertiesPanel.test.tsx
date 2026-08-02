import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toJson, fromJson } from "@bufbuild/protobuf";
import { OpSchema } from "../gen/brawt/v1/brawt_pb";
import type { Op } from "../gen/brawt/v1/brawt_pb";
import { PropertiesPanel } from "./PropertiesPanel";
import { useScene } from "../store/store";
import { emptyScene } from "../store/types";
import type { NodeLite, TextLite } from "../store/types";

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

function ellipseNode(id: string, orderKey: string, over: Partial<NodeLite> = {}): NodeLite {
  return { ...rectNode(id, orderKey), kind: "ellipse", cornerRadius: 0, ...over };
}

const TEXT_STYLE: TextLite["style"] = {
  fontFamily: "Inter, sans-serif", fontSize: 16, fontWeight: "400", lineHeight: 1.2, align: "left",
};

function textNode(id: string, orderKey: string, content = "ciao", over: Partial<NodeLite> = {}): NodeLite {
  return {
    ...rectNode(id, orderKey),
    kind: "text", cornerRadius: 0,
    text: { content, style: { ...TEXT_STYLE } },
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

// --- Task 10: aspetto (riempimento, opacità, raggio degli angoli) ----------

function maskOf(op: Op): readonly string[] {
  if (op.kind.case !== "setProps") throw new Error("non è un op setProps");
  return op.kind.value.mask?.paths ?? [];
}

describe("riempimento", () => {
  it("mostra la tinta corrente in esadecimale", () => {
    installScene(rectNode("a", "a0", { fills: [{ r: 1, g: 0.5, b: 0, a: 1 }] }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);

    // 1 / 0.5 / 0 float -> FF 80 00. La conversione vive solo nel campo.
    expect(screen.getByRole("textbox", { name: "Riempimento" })).toHaveValue("#FF8000");
  });

  it("emette UN SetProperties mask `fills` con RGBA float 0..1", async () => {
    installScene(rectNode("a", "a0", { fills: [{ r: 0, g: 0, b: 0, a: 1 }] }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();
    const undoBefore = useScene.getState().undoStack.length;

    const input = screen.getByRole("textbox", { name: "Riempimento" });
    await user.clear(input);
    await user.type(input, "#FF8000{Enter}");

    expect(sync.sent).toHaveLength(1);
    const op = sync.sent[0];
    expect(op.kind.case).toBe("setProps");
    if (op.kind.case === "setProps") {
      expect(maskOf(op)).toEqual(["fills"]);
      const paint = op.kind.value.patch?.fills[0];
      expect(paint?.kind.case).toBe("solid");
      if (paint?.kind.case === "solid") {
        const c = paint.kind.value.color;
        // FLOAT 0..1, non 0..255: è il modello, non la forma della UI.
        expect(c?.r).toBeCloseTo(1, 5);
        expect(c?.g).toBeCloseTo(128 / 255, 5);
        expect(c?.b).toBeCloseTo(0, 5);
        // L'alfa della tinta precedente sopravvive: l'esadecimale non la porta.
        expect(c?.a).toBe(1);
      }
    }
    expect(useScene.getState().scene?.nodes.a.fills[0].r).toBeCloseTo(1, 5);
    // Un gesto, una voce di undo.
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
    expect(useScene.getState().gesture).toBeNull();
  });

  it("conserva l'alfa DEL NODO, non una qualunque", async () => {
    installScene(rectNode("a", "a0", { fills: [{ r: 0, g: 0, b: 0, a: 0.25 }] }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();

    const input = screen.getByRole("textbox", { name: "Riempimento" });
    await user.clear(input);
    await user.type(input, "#00FF00{Enter}");

    // Il colore È cambiato (senza questo, l'assert sull'alfa passerebbe anche
    // se il campo non avesse emesso NIENTE) ma l'alfa no.
    const fill = useScene.getState().scene?.nodes.a.fills[0];
    expect(fill?.g).toBeCloseTo(1, 5);
    expect(fill?.a).toBe(0.25);
  });

  it("riconfermare lo STESSO colore non manda nessun op", async () => {
    installScene(rectNode("a", "a0", { fills: [{ r: 1, g: 0, b: 0, a: 1 }] }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();

    const input = screen.getByRole("textbox", { name: "Riempimento" });
    await user.click(input);
    await user.keyboard("{Enter}");

    expect(sync.sent).toHaveLength(0);
  });
});

// Il track di un Slider di react-aria-components misura SÉ STESSO con
// getBoundingClientRect per convertire i pixel trascinati in valore; in jsdom
// ogni elemento misura 0x0, quindi senza questo stub la conversione darebbe
// NaN. È l'equivalente, per lo slider, del setPointerCapture che jsdom non
// implementa (vedi il try/catch in fields/NumberField.tsx).
function stubTrackWidth(px: number): () => void {
  const original = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (): DOMRect {
    return {
      width: px, height: 8, top: 0, left: 0, right: px, bottom: 8, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };
  return () => {
    HTMLElement.prototype.getBoundingClientRect = original;
  };
}

// Il div che porta i gestori di trascinamento (useMove) è il GENITORE del
// wrapper VisuallyHidden che contiene l'input range: l'input è solo il canale
// di tastiera e accessibilità. Se react-aria-components cambiasse questa
// struttura, l'errore qui lo direbbe subito invece di far fallire il drag in
// modo oscuro.
function sliderThumb(name: string): HTMLElement {
  const input = screen.getByRole("slider", { name });
  const thumb = input.parentElement?.parentElement;
  if (!thumb) throw new Error("struttura del SliderThumb inattesa");
  return thumb;
}

// Trascina il cursore dello slider `name` di `dx` px, in due passi intermedi.
// useMove apre il trascinamento sul pointerdown del cursore e poi ascolta sulla
// FINESTRA, quindi move e up vanno mandati lì.
function dragSlider(name: string, dx: number) {
  const thumb = sliderThumb(name);
  const base = { pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0 };
  fireEvent.pointerDown(thumb, { ...base, clientX: 0, pageX: 0 });
  fireEvent.pointerMove(window, { ...base, clientX: dx / 2, pageX: dx / 2 });
  fireEvent.pointerMove(window, { ...base, clientX: dx, pageX: dx });
  fireEvent.pointerUp(window, { ...base, clientX: dx, pageX: dx });
}

describe("opacità", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = stubTrackWidth(100);
  });
  afterEach(() => restore());

  it("mostra l'opacità corrente in percentuale", () => {
    installScene(rectNode("a", "a0", { opacity: 0.4 }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);

    expect(screen.getByRole("slider", { name: "Opacità" })).toHaveValue("0.4");
    expect(screen.getByText("40%")).toBeInTheDocument();
  });

  it("ANNUNCIA la stessa percentuale che si legge accanto al cursore", () => {
    installScene(rectNode("a", "a0", { opacity: 0.4 }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);

    // aria-valuetext è ciò che uno screen reader legge AL POSTO del numero
    // grezzo di aria-valuenow (0.4): deve essere la stessa cosa che si vede,
    // altrimenti chi ascolta e chi guarda leggono due valori diversi.
    const slider = screen.getByRole("slider", { name: "Opacità" });
    expect(slider).toHaveAttribute("aria-valuetext", "40%");
    expect(screen.getByText("40%")).toBeInTheDocument();
    // Selezione OMOGENEA: nessuno stato "misto" da nessuna parte.
    expect(sliderThumb("Opacità").closest("[data-mixed]")).toBeNull();
  });

  it("un trascinamento è UN gesto: un op sul filo, una voce di undo", () => {
    installScene(rectNode("a", "a0", { opacity: 1 }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);
    const undoBefore = useScene.getState().undoStack.length;

    // -50px su un track largo 100 = -50% di opacità: 1 -> 0.5.
    dragSlider("Opacità", -50);

    expect(sync.sent).toHaveLength(1);
    const op = sync.sent[0];
    expect(op.kind.case).toBe("setProps");
    if (op.kind.case === "setProps") {
      expect(maskOf(op)).toEqual(["opacity"]);
      expect(op.kind.value.patch?.opacity).toBeCloseTo(0.5, 5);
    }
    expect(useScene.getState().scene?.nodes.a.opacity).toBeCloseTo(0.5, 5);
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
    expect(useScene.getState().gesture).toBeNull();
  });

  it("durante il trascinamento aggiorna in ANTEPRIMA, senza mandare niente", () => {
    installScene(rectNode("a", "a0", { opacity: 1 }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);

    const thumb = sliderThumb("Opacità");
    const base = { pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0 };
    fireEvent.pointerDown(thumb, { ...base, clientX: 0, pageX: 0 });
    fireEvent.pointerMove(window, { ...base, clientX: -20, pageX: -20 });

    expect(useScene.getState().scene?.nodes.a.opacity).toBeCloseTo(0.8, 5);
    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().gesture).not.toBeNull();

    fireEvent.pointerUp(window, { ...base, clientX: -20, pageX: -20 });
    expect(sync.sent).toHaveLength(1);
    expect(useScene.getState().gesture).toBeNull();
  });

  it("un click sul cursore senza spostarlo non apre nessun gesto", () => {
    installScene(rectNode("a", "a0", { opacity: 1 }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);
    const undoBefore = useScene.getState().undoStack.length;

    dragSlider("Opacità", 0);

    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().undoStack.length).toBe(undoBefore);
    expect(useScene.getState().gesture).toBeNull();
  });
});

// Selezione con opacità DIVERSE: il cursore non ha nessun valore da mostrare.
// Un cursore però una posizione ce l'ha sempre, e il valore accessibile di un
// <input type=range> è il suo numero: mettergliene uno plausibile (1, cioè il
// 100%) significa ANNUNCIARE un valore che non esiste -- e mostrarlo, con la
// pastiglia a fondo corsa, mentre il testo accanto dice il contrario. Questi
// test bloccano quel ritorno: "misto" deve arrivare a chi guarda E a chi
// ascolta, e deve essere la STESSA parola.
describe("opacità mista", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = stubTrackWidth(100);
  });
  afterEach(() => restore());

  function installMixed() {
    installScene(rectNode("a", "a0", { opacity: 0.2 }), rectNode("b", "a1", { opacity: 0.9 }));
    useScene.getState().setSelection(["a", "b"]);
  }

  it("il valore ANNUNCIATO dice misto, non una percentuale inventata", () => {
    installMixed();
    render(<PropertiesPanel />);

    const slider = screen.getByRole("slider", { name: "Opacità" });
    expect(slider).toHaveAttribute("aria-valuetext", "Misto");
    // Nessuna percentuale, da nessuna parte del pannello: né annunciata né
    // scritta. "100%" sarebbe esattamente il valore inventato.
    expect(screen.queryByText(/%/)).toBeNull();
  });

  it("mostrato e annunciato sono la STESSA parola", () => {
    installMixed();
    render(<PropertiesPanel />);

    const shown = screen.getByText("Misto");
    const slider = screen.getByRole("slider", { name: "Opacità" });
    expect(slider.getAttribute("aria-valuetext")).toBe(shown.textContent);
  });

  it("il cursore si disegna VUOTO: nessuna posizione finta", () => {
    installMixed();
    render(<PropertiesPanel />);

    // Lo stato "misto" sta nel DOM (sul track, che porta anche la pastiglia),
    // non in una stringa di classi: è da lì che il CSS toglie il riempimento
    // al binario e alla pastiglia, come ColorField/NumberField si svuotano.
    expect(sliderThumb("Opacità").closest("[data-mixed]")).not.toBeNull();
  });

  it("resta usabile: trascinarlo assegna la stessa opacità a tutti, in UN gesto", () => {
    installMixed();
    render(<PropertiesPanel />);
    const undoBefore = useScene.getState().undoStack.length;

    dragSlider("Opacità", -50);

    // Un op per nodo ma UN solo gesto: una voce di undo, come per ogni altra
    // modifica multipla del pannello.
    expect(sync.sent).toHaveLength(2);
    for (const op of sync.sent) expect(maskOf(op)).toEqual(["opacity"]);
    const scene = useScene.getState().scene;
    expect(scene?.nodes.a.opacity).toBeCloseTo(0.5, 5);
    expect(scene?.nodes.b.opacity).toBeCloseTo(0.5, 5);
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
    expect(useScene.getState().gesture).toBeNull();
    // Assegnato un valore, il "misto" sparisce da entrambi i canali.
    expect(screen.getByRole("slider", { name: "Opacità" })).toHaveAttribute("aria-valuetext", "50%");
    expect(sliderThumb("Opacità").closest("[data-mixed]")).toBeNull();
  });

  it("cambiando selezione il 'Misto' non resta appeso", () => {
    installScene(
      rectNode("a", "a0", { opacity: 0.2 }),
      rectNode("b", "a1", { opacity: 0.9 }),
      // Opacità 1: ESATTAMENTE il valore di ripiego che il cursore usa nel
      // caso misto per avere una posizione. Il numero che React vede quindi
      // NON cambia passando da misto a singolo, e un attributo scritto una
      // volta sola resterebbe fermo su "Misto" -- annunciando "misto" per un
      // nodo con un'opacità precisa. È il motivo per cui il valore annunciato
      // si riscrive a ogni render.
      rectNode("c", "a2", { opacity: 1 }),
    );
    useScene.getState().setSelection(["a", "b"]);
    const { rerender } = render(<PropertiesPanel />);
    expect(screen.getByRole("slider", { name: "Opacità" })).toHaveAttribute("aria-valuetext", "Misto");

    useScene.getState().setSelection(["c"]);
    rerender(<PropertiesPanel />);

    expect(screen.getByRole("slider", { name: "Opacità" })).toHaveAttribute("aria-valuetext", "100%");
    expect(screen.getByText("100%")).toBeInTheDocument();
    expect(screen.queryByText("Misto")).toBeNull();
    expect(sliderThumb("Opacità").closest("[data-mixed]")).toBeNull();
  });
});

describe("raggio degli angoli", () => {
  it("compare SOLO per i rettangoli", () => {
    installScene(rectNode("a", "a0"), ellipseNode("e", "a1"), textNode("t", "a2"));

    useScene.getState().setSelection(["a"]);
    const { rerender } = render(<PropertiesPanel />);
    expect(screen.getByRole("textbox", { name: "R" })).toBeInTheDocument();

    useScene.getState().setSelection(["e"]);
    rerender(<PropertiesPanel />);
    expect(screen.queryByRole("textbox", { name: "R" })).toBeNull();

    useScene.getState().setSelection(["t"]);
    rerender(<PropertiesPanel />);
    expect(screen.queryByRole("textbox", { name: "R" })).toBeNull();

    // Selezione mista rettangolo+ellisse: non c'è un raggio da mostrare.
    useScene.getState().setSelection(["a", "e"]);
    rerender(<PropertiesPanel />);
    expect(screen.queryByRole("textbox", { name: "R" })).toBeNull();
  });

  it("emette la mask `corner_radius` e sopravvive al round-trip protojson", async () => {
    installScene(rectNode("a", "a0", { cornerRadius: 0 }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();
    const undoBefore = useScene.getState().undoStack.length;

    await user.clear(screen.getByRole("textbox", { name: "R" }));
    await user.type(screen.getByRole("textbox", { name: "R" }), "12{Enter}");

    expect(sync.sent).toHaveLength(1);
    const op = sync.sent[0];
    expect(maskOf(op)).toEqual(["corner_radius"]);

    // IL test del path multiparola: sul filo il FieldMask viaggia in
    // lowerCamelCase ("cornerRadius"), e fieldMaskToJson LANCIA se la
    // conversione non è reversibile. Un "cornerRadius" scritto a mano in
    // MASK_PATHS farebbe fallire QUESTA riga, non un test lontano.
    const wire = toJson(OpSchema, op) as { setProps?: { mask?: string } };
    expect(wire.setProps?.mask).toBe("cornerRadius");
    const back = fromJson(OpSchema, wire);
    expect(maskOf(back)).toEqual(["corner_radius"]);
    if (back.kind.case === "setProps") {
      const patch = back.kind.value.patch;
      expect(patch?.shape.case).toBe("rect");
      if (patch?.shape.case === "rect") expect(patch.shape.value.cornerRadius).toBe(12);
    }

    expect(useScene.getState().scene?.nodes.a.cornerRadius).toBe(12);
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
    expect(useScene.getState().gesture).toBeNull();
  });

  it("trascinare la sua etichetta resta UN gesto", () => {
    installScene(rectNode("a", "a0", { cornerRadius: 2 }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);
    const undoBefore = useScene.getState().undoStack.length;

    dragLabel("R", 6);

    expect(sync.sent).toHaveLength(1);
    expect(maskOf(sync.sent[0])).toEqual(["corner_radius"]);
    expect(useScene.getState().scene?.nodes.a.cornerRadius).toBe(8);
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
  });
});

// --- Task 11: selezione multipla con valori misti ---------------------------
//
// L'architettura dei gesti (commit/scrub operano già su TUTTA store.selection,
// non su un singolo id) e il riassunto MIXED (selectors.ts::selectionSummary)
// esistono da Task 9/10: questi test bloccano il comportamento che il brief
// richiede esplicitamente, alcuni dei quali erano finora provati solo per
// l'opacità (che ha il suo canale dedicato, il cursore). Qui la stessa
// garanzia si estende ai campi NumberField/ColorField/RadioGroup: un valore
// diverso fra i nodi selezionati si mostra VUOTO con un placeholder "Misto"
// (mai "0", che l'utente leggerebbe come il valore vero), lo stesso valore
// ovunque si mostra per quello che è, e confermare un valore nel campo misto
// lo scrive su OGNI nodo selezionato in UN gesto solo.

describe("selezione multipla — campi geometrici misti", () => {
  it("un campo con valori diversi si mostra VUOTO con placeholder 'Misto', non 0", () => {
    installScene(rectNode("a", "a0", { x: 10 }), rectNode("b", "a1", { x: 50 }));
    useScene.getState().setSelection(["a", "b"]);
    render(<PropertiesPanel />);

    const x = field("X");
    expect(x).toHaveValue("");
    expect(x).not.toHaveValue("0");
    expect(x).toHaveAttribute("placeholder", "Misto");
  });

  it("un campo con lo STESSO valore su tutti i nodi lo mostra, senza placeholder", () => {
    installScene(rectNode("a", "a0", { y: 7 }), rectNode("b", "a1", { y: 7 }));
    useScene.getState().setSelection(["a", "b"]);
    render(<PropertiesPanel />);

    const y = field("Y");
    expect(y).toHaveValue("7");
    expect(y).not.toHaveAttribute("placeholder");
  });

  it("digitare in un campo misto lo applica a TUTTI i nodi selezionati in UN gesto", async () => {
    installScene(rectNode("a", "a0", { x: 10 }), rectNode("b", "a1", { x: 50 }));
    useScene.getState().setSelection(["a", "b"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();
    const undoBefore = useScene.getState().undoStack.length;

    await user.clear(field("X"));
    await user.type(field("X"), "99{Enter}");

    // Un op PER NODO, ma un solo gesto: il patch di ogni op porta lo stesso
    // valore assoluto digitato, non una traslazione relativa alla posizione
    // di partenza di ciascun nodo.
    expect(sync.sent).toHaveLength(2);
    for (const op of sync.sent) {
      expect(op.kind.case).toBe("setProps");
      if (op.kind.case === "setProps") {
        expect(op.kind.value.mask?.paths).toEqual(["x"]);
        expect(op.kind.value.patch?.x).toBe(99);
      }
    }
    expect(useScene.getState().scene?.nodes.a.x).toBe(99);
    expect(useScene.getState().scene?.nodes.b.x).toBe(99);
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
    expect(useScene.getState().gesture).toBeNull();
    // Un valore ora esiste per tutta la selezione: "misto" sparisce.
    expect(field("X")).toHaveValue("99");
    expect(field("X")).not.toHaveAttribute("placeholder");
  });

  it("trascinare l'etichetta di un campo misto non apre nessun gesto: non c'è un valore di partenza da cui scrubare", () => {
    installScene(rectNode("a", "a0", { x: 10 }), rectNode("b", "a1", { x: 50 }));
    useScene.getState().setSelection(["a", "b"]);
    render(<PropertiesPanel />);
    const undoBefore = useScene.getState().undoStack.length;

    dragLabel("X", 25);

    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().scene?.nodes.a.x).toBe(10);
    expect(useScene.getState().scene?.nodes.b.x).toBe(50);
    expect(useScene.getState().undoStack.length).toBe(undoBefore);
    expect(useScene.getState().gesture).toBeNull();
  });
});

describe("selezione multipla — raggio degli angoli", () => {
  it("valori diversi fra rettangoli si mostrano VUOTI con placeholder, il campo resta VISIBILE (stesso kind)", () => {
    installScene(rectNode("a", "a0", { cornerRadius: 2 }), rectNode("b", "a1", { cornerRadius: 8 }));
    useScene.getState().setSelection(["a", "b"]);
    render(<PropertiesPanel />);

    const r = screen.getByRole("textbox", { name: "R" });
    expect(r).toHaveValue("");
    expect(r).toHaveAttribute("placeholder", "Misto");
  });

  it("confermare un raggio misto lo applica a TUTTI i rettangoli selezionati in UN gesto", async () => {
    installScene(rectNode("a", "a0", { cornerRadius: 2 }), rectNode("b", "a1", { cornerRadius: 8 }));
    useScene.getState().setSelection(["a", "b"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();
    const undoBefore = useScene.getState().undoStack.length;

    await user.clear(screen.getByRole("textbox", { name: "R" }));
    await user.type(screen.getByRole("textbox", { name: "R" }), "5{Enter}");

    expect(sync.sent).toHaveLength(2);
    for (const op of sync.sent) expect(maskOf(op)).toEqual(["corner_radius"]);
    expect(useScene.getState().scene?.nodes.a.cornerRadius).toBe(5);
    expect(useScene.getState().scene?.nodes.b.cornerRadius).toBe(5);
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
    expect(useScene.getState().gesture).toBeNull();
  });

  it("una selezione che mischia rettangoli e non-rettangoli non mostra il campo: nessun raggio vale per TUTTI i tipi", () => {
    installScene(rectNode("a", "a0", { cornerRadius: 2 }), ellipseNode("e", "a1"));
    useScene.getState().setSelection(["a", "e"]);
    render(<PropertiesPanel />);

    expect(screen.queryByRole("textbox", { name: "R" })).toBeNull();
  });
});

describe("selezione multipla — riempimento", () => {
  it("tinte diverse si mostrano VUOTE con placeholder 'Misto', non un colore a caso", () => {
    installScene(
      rectNode("a", "a0", { fills: [{ r: 1, g: 0, b: 0, a: 1 }] }),
      rectNode("b", "a1", { fills: [{ r: 0, g: 1, b: 0, a: 0.5 }] }),
    );
    useScene.getState().setSelection(["a", "b"]);
    render(<PropertiesPanel />);

    const input = screen.getByRole("textbox", { name: "Riempimento" });
    expect(input).toHaveValue("");
    expect(input).toHaveAttribute("placeholder", "Misto");
  });

  it("confermare un colore su un riempimento misto lo applica a TUTTI in UN gesto, ciascuno con la PROPRIA alfa", async () => {
    installScene(
      rectNode("a", "a0", { fills: [{ r: 1, g: 0, b: 0, a: 1 }] }),
      rectNode("b", "a1", { fills: [{ r: 0, g: 1, b: 0, a: 0.5 }] }),
    );
    useScene.getState().setSelection(["a", "b"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();
    const undoBefore = useScene.getState().undoStack.length;

    const input = screen.getByRole("textbox", { name: "Riempimento" });
    await user.clear(input);
    await user.type(input, "#0000FF{Enter}");

    expect(sync.sent).toHaveLength(2);
    for (const op of sync.sent) expect(maskOf(op)).toEqual(["fills"]);
    const scene = useScene.getState().scene;
    expect(scene?.nodes.a.fills[0].b).toBeCloseTo(1, 5);
    expect(scene?.nodes.a.fills[0].a).toBe(1);
    expect(scene?.nodes.b.fills[0].b).toBeCloseTo(1, 5);
    // L'alfa di ciascun nodo sopravvive: il campo non la porta.
    expect(scene?.nodes.b.fills[0].a).toBe(0.5);
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
    expect(useScene.getState().gesture).toBeNull();
  });
});

describe("selezione multipla — stile del testo", () => {
  it("un peso diverso fra i testi non mostra nessuna scelta selezionata", () => {
    installScene(
      textNode("t1", "a0", "uno", { text: { content: "uno", style: { ...TEXT_STYLE, fontWeight: "400" } } }),
      textNode("t2", "a1", "due", { text: { content: "due", style: { ...TEXT_STYLE, fontWeight: "700" } } }),
    );
    useScene.getState().setSelection(["t1", "t2"]);
    render(<PropertiesPanel />);

    expect(screen.getByRole("radio", { name: "Normale" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "Grassetto" })).not.toBeChecked();
  });

  it("scegliere un peso lo applica a TUTTI i testi selezionati in UN gesto, mantenendo il contenuto di ciascuno", async () => {
    installScene(
      textNode("t1", "a0", "uno", { text: { content: "uno", style: { ...TEXT_STYLE, fontWeight: "400" } } }),
      textNode("t2", "a1", "due", { text: { content: "due", style: { ...TEXT_STYLE, fontWeight: "700" } } }),
    );
    useScene.getState().setSelection(["t1", "t2"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();
    const undoBefore = useScene.getState().undoStack.length;

    await user.click(screen.getByRole("radio", { name: "Grassetto" }));

    expect(sync.sent).toHaveLength(2);
    for (const op of sync.sent) expect(op.kind.case).toBe("setText");
    const scene = useScene.getState().scene;
    expect(scene?.nodes.t1.text?.style.fontWeight).toBe("700");
    expect(scene?.nodes.t2.text?.style.fontWeight).toBe("700");
    expect(scene?.nodes.t1.text?.content).toBe("uno");
    expect(scene?.nodes.t2.text?.content).toBe("due");
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
    expect(useScene.getState().gesture).toBeNull();
  });
});

// --- Step 3: per i nodi testo, i controlli di stile ------------------------

describe("stile del testo", () => {
  it("compare SOLO per i nodi testo", () => {
    installScene(rectNode("a", "a0"), textNode("t", "a1"));

    useScene.getState().setSelection(["a"]);
    const { rerender } = render(<PropertiesPanel />);
    expect(screen.queryByRole("textbox", { name: "Dimensione" })).toBeNull();

    useScene.getState().setSelection(["t"]);
    rerender(<PropertiesPanel />);
    expect(screen.getByRole("textbox", { name: "Dimensione" })).toHaveValue("16");
    expect(screen.getByRole("radio", { name: "Normale" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Sinistra" })).toBeChecked();
  });

  it("la dimensione emette UN SetText con stylePresent e il contenuto invariato", async () => {
    installScene(textNode("t", "a0", "ciao"));
    useScene.getState().setSelection(["t"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();
    const undoBefore = useScene.getState().undoStack.length;

    await user.clear(screen.getByRole("textbox", { name: "Dimensione" }));
    await user.type(screen.getByRole("textbox", { name: "Dimensione" }), "32{Enter}");

    expect(sync.sent).toHaveLength(1);
    const op = sync.sent[0];
    expect(op.kind.case).toBe("setText");
    if (op.kind.case === "setText") {
      expect(op.kind.value.id).toBe("t");
      // Il contenuto si scrive SEMPRE (core.applySetText): ometterlo lo
      // cancellerebbe.
      expect(op.kind.value.content).toBe("ciao");
      expect(op.kind.value.stylePresent).toBe(true);
      expect(op.kind.value.style?.fontSize).toBe(32);
      // Gli altri campi dello stile restano quelli del nodo.
      expect(op.kind.value.style?.fontWeight).toBe("400");
      expect(op.kind.value.style?.fontFamily).toBe("Inter, sans-serif");
    }
    expect(useScene.getState().scene?.nodes.t.text?.style.fontSize).toBe(32);
    expect(useScene.getState().scene?.nodes.t.text?.content).toBe("ciao");
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
    expect(useScene.getState().gesture).toBeNull();
  });

  it("il peso emette SetText con stylePresent", async () => {
    installScene(textNode("t", "a0", "ciao"));
    useScene.getState().setSelection(["t"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("radio", { name: "Grassetto" }));

    expect(sync.sent).toHaveLength(1);
    const op = sync.sent[0];
    expect(op.kind.case).toBe("setText");
    if (op.kind.case === "setText") {
      expect(op.kind.value.stylePresent).toBe(true);
      expect(op.kind.value.style?.fontWeight).toBe("700");
      expect(op.kind.value.style?.fontSize).toBe(16);
    }
    expect(useScene.getState().scene?.nodes.t.text?.style.fontWeight).toBe("700");
  });

  it("l'allineamento emette SetText con stylePresent", async () => {
    installScene(textNode("t", "a0", "ciao"));
    useScene.getState().setSelection(["t"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("radio", { name: "Centro" }));

    expect(sync.sent).toHaveLength(1);
    const op = sync.sent[0];
    expect(op.kind.case).toBe("setText");
    if (op.kind.case === "setText") {
      expect(op.kind.value.stylePresent).toBe(true);
      // TextAlign.CENTER === 2 nel generato; il modello lo rilegge come "center".
      expect(op.kind.value.style?.align).toBe(2);
    }
    expect(useScene.getState().scene?.nodes.t.text?.style.align).toBe("center");
  });

  it("su più testi è UN gesto solo, e ogni nodo tiene il PROPRIO contenuto", async () => {
    installScene(
      textNode("t1", "a0", "uno"),
      textNode("t2", "a1", "due", { text: { content: "due", style: { ...TEXT_STYLE, fontWeight: "700" } } }),
    );
    useScene.getState().setSelection(["t1", "t2"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();
    const undoBefore = useScene.getState().undoStack.length;

    await user.clear(screen.getByRole("textbox", { name: "Dimensione" }));
    await user.type(screen.getByRole("textbox", { name: "Dimensione" }), "20{Enter}");

    expect(sync.sent).toHaveLength(2);
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
    const scene = useScene.getState().scene;
    expect(scene?.nodes.t1.text).toEqual({ content: "uno", style: { ...TEXT_STYLE, fontSize: 20 } });
    // Il peso diverso di t2 non viene uniformato da un cambio di dimensione.
    expect(scene?.nodes.t2.text).toEqual({
      content: "due", style: { ...TEXT_STYLE, fontSize: 20, fontWeight: "700" },
    });
  });
});
