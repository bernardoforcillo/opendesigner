import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toJson, fromJson } from "@bufbuild/protobuf";
import { OpSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { PropertiesPanel } from "./PropertiesPanel";
import { contentWorldBounds } from "../store/groups";
import { useScene } from "../store/store";
import { emptyScene } from "../store/types";
import type { InstanceOverrideLite, NodeLite, StrokeAlignLite, StrokeLite, TextLite } from "../store/types";

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
    fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false,
    ...over,
  };
}

function ellipseNode(id: string, orderKey: string, over: Partial<NodeLite> = {}): NodeLite {
  return { ...rectNode(id, orderKey), kind: "ellipse", cornerRadius: 0, clipsContent: false, ...over };
}

// Un gruppo NASCE a (0,0) e senza geometria propria: la sua cornice è l'unione
// dei figli (store/groups.ts), non il suo box.
function groupNode(id: string, orderKey: string, over: Partial<NodeLite> = {}): NodeLite {
  return { ...rectNode(id, orderKey), kind: "group", x: 0, y: 0, width: 0, height: 0, fills: [], ...over };
}

const TEXT_STYLE: TextLite["style"] = {
  fontFamily: "Inter, sans-serif", fontSize: 16, fontWeight: "400", lineHeight: 1.2, align: "left",
};

function textNode(id: string, orderKey: string, content = "ciao", over: Partial<NodeLite> = {}): NodeLite {
  return {
    ...rectNode(id, orderKey),
    kind: "text", cornerRadius: 0, clipsContent: false,
    text: { content, style: { ...TEXT_STYLE } },
    ...over,
  };
}

function installScene(...nodes: NodeLite[]) {
  const scene = emptyScene("doc-1", "Untitled");
  for (const n of nodes) scene.nodes = scene.nodes.set(n.id, n);
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

  // La maniglia dell'overlay dà il GESTO; questo campo dà il NUMERO. Senza, un
  // nodo ruotato non ha nessun posto dove dire a che angolo sta, e un angolo
  // esatto (90, 45, o 0 per rimetterlo dritto) non si può scrivere.
  it("il campo Rot mostra l'angolo del nodo", () => {
    installScene(rectNode("a", "a0", { rotation: 45 }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);

    expect(field("Rot")).toHaveValue("45");
  });
});

describe("il campo Rot", () => {
  it("scrive l'angolo con UN SetProperties sulla sola mask rotation", async () => {
    installScene(rectNode("a", "a0", { rotation: 0 }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();

    await user.clear(field("Rot"));
    await user.type(field("Rot"), "90{Enter}");

    expect(sync.sent).toHaveLength(1);
    const op = sync.sent[0];
    expect(op.kind.case).toBe("setProps");
    if (op.kind.case === "setProps") {
      expect(op.kind.value.mask?.paths).toEqual(["rotation"]);
      expect(op.kind.value.patch?.rotation).toBe(90);
    }
    expect(useScene.getState().scene!.nodes.at("a").rotation).toBe(90);
    expect(useScene.getState().undoStack).toHaveLength(1); // un campo, un gesto
  });

  it("accetta un angolo NEGATIVO (-30 si scrive più volentieri di 330)", async () => {
    installScene(rectNode("a", "a0", { rotation: 0 }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();

    await user.clear(field("Rot"));
    await user.type(field("Rot"), "-30{Enter}");

    expect(useScene.getState().scene!.nodes.at("a").rotation).toBe(-30);
  });

  it("su una selezione con angoli diversi dice Misto invece di inventarne uno", () => {
    installScene(rectNode("a", "a0", { rotation: 0 }), rectNode("b", "a1", { rotation: 90 }));
    useScene.getState().setSelection(["a", "b"]);
    render(<PropertiesPanel />);

    expect(field("Rot")).toHaveValue("");
    expect(field("Rot")).toHaveAttribute("placeholder", "Misto");
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
    expect(useScene.getState().scene?.nodes.at("a").x).toBe(99);
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
    expect(useScene.getState().scene?.nodes.at("a").x).toBe(35);
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
    expect(useScene.getState().scene?.nodes.at("a").x).toBe(22);
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
    expect(useScene.getState().scene?.nodes.at("a").x).toBe(10);
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
    expect(useScene.getState().scene?.nodes.at("a").x).toBe(10);
    expect(Number.isNaN(useScene.getState().scene?.nodes.at("a").x)).toBe(false);
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
    expect(useScene.getState().scene?.nodes.at("a").x).toBe(10);
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

    const node = useScene.getState().scene?.nodes.at("a");
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
    expect(useScene.getState().scene?.nodes.at("a").fills[0].r).toBeCloseTo(1, 5);
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
    const fill = useScene.getState().scene?.nodes.at("a").fills[0];
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
    expect(useScene.getState().scene?.nodes.at("a").opacity).toBeCloseTo(0.5, 5);
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

    expect(useScene.getState().scene?.nodes.at("a").opacity).toBeCloseTo(0.8, 5);
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
    expect(scene?.nodes.at("a").opacity).toBeCloseTo(0.5, 5);
    expect(scene?.nodes.at("b").opacity).toBeCloseTo(0.5, 5);
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

    expect(useScene.getState().scene?.nodes.at("a").cornerRadius).toBe(12);
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
    expect(useScene.getState().scene?.nodes.at("a").cornerRadius).toBe(8);
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
    expect(useScene.getState().scene?.nodes.at("a").x).toBe(99);
    expect(useScene.getState().scene?.nodes.at("b").x).toBe(99);
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
    expect(useScene.getState().scene?.nodes.at("a").x).toBe(10);
    expect(useScene.getState().scene?.nodes.at("b").x).toBe(50);
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
    expect(useScene.getState().scene?.nodes.at("a").cornerRadius).toBe(5);
    expect(useScene.getState().scene?.nodes.at("b").cornerRadius).toBe(5);
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
    expect(scene?.nodes.at("a").fills[0].b).toBeCloseTo(1, 5);
    expect(scene?.nodes.at("a").fills[0].a).toBe(1);
    expect(scene?.nodes.at("b").fills[0].b).toBeCloseTo(1, 5);
    // L'alfa di ciascun nodo sopravvive: il campo non la porta.
    expect(scene?.nodes.at("b").fills[0].a).toBe(0.5);
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
    expect(scene?.nodes.at("t1").text?.style.fontWeight).toBe("700");
    expect(scene?.nodes.at("t2").text?.style.fontWeight).toBe("700");
    expect(scene?.nodes.at("t1").text?.content).toBe("uno");
    expect(scene?.nodes.at("t2").text?.content).toBe("due");
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
    expect(useScene.getState().scene?.nodes.at("t").text?.style.fontSize).toBe(32);
    expect(useScene.getState().scene?.nodes.at("t").text?.content).toBe("ciao");
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
    expect(useScene.getState().scene?.nodes.at("t").text?.style.fontWeight).toBe("700");
  });

  it("l'allineamento emette SetText con stylePresent", async () => {
    installScene(textNode("t", "a0", "ciao"));
    useScene.getState().setSelection(["t"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();

    // Dentro il gruppo "Allineamento": da M2 esiste anche una "Posizione" del
    // tratto con un suo "Centro" (il gruppo, non l'opzione, è ciò che li
    // distingue -- vedi STROKE_ALIGNMENTS in PropertiesPanel.tsx).
    await user.click(radioIn("Allineamento", "Centro"));

    expect(sync.sent).toHaveLength(1);
    const op = sync.sent[0];
    expect(op.kind.case).toBe("setText");
    if (op.kind.case === "setText") {
      expect(op.kind.value.stylePresent).toBe(true);
      // TextAlign.CENTER === 2 nel generato; il modello lo rilegge come "center".
      expect(op.kind.value.style?.align).toBe(2);
    }
    expect(useScene.getState().scene?.nodes.at("t").text?.style.align).toBe("center");
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
    expect(scene?.nodes.at("t1").text).toEqual({ content: "uno", style: { ...TEXT_STYLE, fontSize: 20 } });
    // Il peso diverso di t2 non viene uniformato da un cambio di dimensione.
    expect(scene?.nodes.at("t2").text).toEqual({
      content: "due", style: { ...TEXT_STYLE, fontSize: 20, fontWeight: "700" },
    });
  });
});

// --- M2, traccia 2: il TRATTO ------------------------------------------------
//
// Stessa forma dei controlli di riempimento/opacità: colore in esadecimale al
// bordo UI, valori assoluti su tutta la selezione, e la regola dei gesti (un
// trascinamento = UN gesto, quindi un op sul filo e una voce di undo).

function strokeOf(weight: number, align: StrokeAlignLite, color = { r: 0, g: 0, b: 0, a: 1 }): StrokeLite {
  return { color, weight, align };
}

// Il radio `name` DENTRO il gruppo `group`: "Centro" esiste sia fra le
// posizioni del tratto sia fra gli allineamenti del testo, e su un nodo testo
// con un tratto i due gruppi convivono nel pannello.
function radioIn(group: string, name: string): HTMLElement {
  return within(screen.getByRole("radiogroup", { name: group })).getByRole("radio", { name });
}

describe("tratto", () => {
  it("mostra colore, spessore e posizione del primo tratto", () => {
    installScene(rectNode("a", "a0", { strokes: [strokeOf(4, "outside", { r: 1, g: 0.5, b: 0, a: 1 })] }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);

    expect(screen.getByRole("textbox", { name: "Tratto" })).toHaveValue("#FF8000");
    expect(field("Spessore")).toHaveValue("4");
    expect(radioIn("Posizione", "Esterno")).toBeChecked();
  });

  it("un nodo SENZA tratti mostra il campo vuoto, spessore 0 e posizione al centro", () => {
    installScene(rectNode("a", "a0", { strokes: [] }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);

    expect(screen.getByRole("textbox", { name: "Tratto" })).toHaveValue("");
    expect(field("Spessore")).toHaveValue("0");
    expect(radioIn("Posizione", "Centro")).toBeChecked();
  });

  it("scrivere un colore su un nodo senza tratti NE CREA uno visibile (1 px, centrato)", async () => {
    installScene(rectNode("a", "a0", { strokes: [] }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();
    const undoBefore = useScene.getState().undoStack.length;

    const input = screen.getByRole("textbox", { name: "Tratto" });
    await user.clear(input);
    await user.type(input, "#FF0000{Enter}");

    expect(sync.sent).toHaveLength(1);
    expect(maskOf(sync.sent[0])).toEqual(["strokes"]);
    const strokes = useScene.getState().scene?.nodes.at("a").strokes ?? [];
    expect(strokes).toHaveLength(1);
    expect(strokes[0].color.r).toBeCloseTo(1, 5);
    // Un peso di ripiego > 0: un tratto creato con peso 0 non si vedrebbe, e
    // l'utente avrebbe scritto un colore senza nessun effetto visibile.
    expect(strokes[0].weight).toBe(1);
    expect(strokes[0].align).toBe("center");
    // Un gesto, una voce di undo.
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
    expect(useScene.getState().gesture).toBeNull();
  });

  // L'alfa NON passa dal campo esadecimale (vedi fields/ColorField.tsx): la
  // rimette strokeOps prendendola dal tratto DEL NODO. Gemello di "conserva
  // l'alfa DEL NODO, non una qualunque" per il riempimento.
  it("cambiare il colore conserva l'alfa DEL NODO", async () => {
    installScene(rectNode("a", "a0", { strokes: [strokeOf(4, "inside", { r: 0, g: 0, b: 0, a: 0.25 })] }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();

    const input = screen.getByRole("textbox", { name: "Tratto" });
    await user.clear(input);
    await user.type(input, "#00FF00{Enter}");

    // Il colore È cambiato (senza questo, l'assert sull'alfa passerebbe anche
    // se il campo non avesse emesso NIENTE) ma l'alfa no -- e nemmeno spessore
    // e posizione.
    const s = useScene.getState().scene?.nodes.at("a").strokes[0];
    expect(s?.color.g).toBeCloseTo(1, 5);
    expect(s?.color.a).toBe(0.25);
    expect(s?.weight).toBe(4);
    expect(s?.align).toBe("inside");
  });

  // Il caso che il riassunto della selezione non può servire: su tratti diversi
  // `summary.strokes` è MIXED, cioè NESSUN valore da cui leggere un'alfa.
  // Prenderla da lì (o dal suo ripiego 1) distruggerebbe in silenzio lo 0.3 di
  // A -- una modifica che l'utente non ha chiesto e non vede finché non guarda
  // il canvas.
  it("su tratti diversi il colore va a tutti ma ciascuno tiene la PROPRIA alfa", async () => {
    installScene(
      rectNode("a", "a0", { strokes: [strokeOf(2, "center", { r: 1, g: 0, b: 0, a: 0.3 })] }),
      rectNode("b", "a1", { strokes: [strokeOf(9, "outside", { r: 0, g: 0, b: 1, a: 1 })] }),
    );
    useScene.getState().setSelection(["a", "b"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();
    const undoBefore = useScene.getState().undoStack.length;

    const input = screen.getByRole("textbox", { name: "Tratto" });
    expect(input).toHaveValue("");
    await user.type(input, "#00FF00{Enter}");

    expect(sync.sent).toHaveLength(2);
    for (const op of sync.sent) expect(maskOf(op)).toEqual(["strokes"]);
    const scene = useScene.getState().scene;
    expect(scene?.nodes.at("a").strokes[0].color.g).toBeCloseTo(1, 5);
    expect(scene?.nodes.at("b").strokes[0].color.g).toBeCloseTo(1, 5);
    expect(scene?.nodes.at("a").strokes[0].color.a).toBe(0.3);
    expect(scene?.nodes.at("b").strokes[0].color.a).toBe(1);
    // ...e il resto del tratto di ciascuno resta suo.
    expect(scene?.nodes.at("a").strokes[0].weight).toBe(2);
    expect(scene?.nodes.at("b").strokes[0].align).toBe("outside");
    // Due op, UN gesto: una sola voce di undo.
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
    expect(useScene.getState().gesture).toBeNull();
  });

  it("cambiare lo spessore conserva colore e posizione del tratto", async () => {
    installScene(rectNode("a", "a0", { strokes: [strokeOf(4, "inside", { r: 0, g: 1, b: 0, a: 0.5 })] }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();

    await user.clear(field("Spessore"));
    await user.type(field("Spessore"), "12{Enter}");

    expect(sync.sent).toHaveLength(1);
    expect(maskOf(sync.sent[0])).toEqual(["strokes"]);
    expect(useScene.getState().scene?.nodes.at("a").strokes).toEqual([
      { color: { r: 0, g: 1, b: 0, a: 0.5 }, weight: 12, align: "inside" },
    ]);
  });

  it("la posizione conserva colore e spessore", async () => {
    installScene(rectNode("a", "a0", { strokes: [strokeOf(4, "center", { r: 0, g: 0, b: 1, a: 1 })] }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();

    await user.click(radioIn("Posizione", "Interno"));

    expect(sync.sent).toHaveLength(1);
    expect(maskOf(sync.sent[0])).toEqual(["strokes"]);
    expect(useScene.getState().scene?.nodes.at("a").strokes).toEqual([
      { color: { r: 0, g: 0, b: 1, a: 1 }, weight: 4, align: "inside" },
    ]);
  });

  it("trascinare l'etichetta Spessore è UN gesto, non uno per pixel", () => {
    installScene(rectNode("a", "a0", { strokes: [strokeOf(2, "center")] }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);
    const undoBefore = useScene.getState().undoStack.length;

    dragLabel("Spessore", 10);

    expect(sync.sent).toHaveLength(1);
    expect(maskOf(sync.sent[0])).toEqual(["strokes"]);
    expect(useScene.getState().scene?.nodes.at("a").strokes[0].weight).toBe(12);
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
    expect(useScene.getState().gesture).toBeNull();
  });

  it("un tratto oltre il primo non si perde", async () => {
    installScene(rectNode("a", "a0", {
      strokes: [strokeOf(2, "center"), strokeOf(8, "outside", { r: 1, g: 0, b: 0, a: 1 })],
    }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();

    await user.clear(field("Spessore"));
    await user.type(field("Spessore"), "5{Enter}");

    const strokes = useScene.getState().scene?.nodes.at("a").strokes ?? [];
    expect(strokes).toHaveLength(2);
    expect(strokes[0].weight).toBe(5);
    expect(strokes[1]).toEqual(strokeOf(8, "outside", { r: 1, g: 0, b: 0, a: 1 }));
  });

  it("su una selezione con tratti diversi dice Misto, e scriverci assegna a tutti", async () => {
    installScene(
      rectNode("a", "a0", { strokes: [strokeOf(2, "center")] }),
      rectNode("b", "a1", { strokes: [strokeOf(9, "outside")] }),
    );
    useScene.getState().setSelection(["a", "b"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();
    const undoBefore = useScene.getState().undoStack.length;

    expect(field("Spessore")).toHaveValue("");
    expect(field("Spessore")).toHaveAttribute("placeholder", "Misto");
    expect(screen.getByRole("textbox", { name: "Tratto" })).toHaveValue("");

    await user.type(field("Spessore"), "3{Enter}");

    // Due op (uno per nodo) ma UN gesto solo: una voce di undo.
    expect(sync.sent).toHaveLength(2);
    const scene = useScene.getState().scene;
    expect(scene?.nodes.at("a").strokes[0].weight).toBe(3);
    expect(scene?.nodes.at("b").strokes[0].weight).toBe(3);
    // ...e ogni nodo tiene la PROPRIA posizione: cambiare lo spessore non
    // uniforma il resto.
    expect(scene?.nodes.at("a").strokes[0].align).toBe("center");
    expect(scene?.nodes.at("b").strokes[0].align).toBe("outside");
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
  });

  it("il tratto c'è anche su un'ellisse e su un testo (non è dentro il oneof shape)", () => {
    installScene(ellipseNode("e", "a0", { strokes: [strokeOf(3, "center")] }));
    useScene.getState().setSelection(["e"]);
    const { unmount } = render(<PropertiesPanel />);
    expect(field("Spessore")).toHaveValue("3");
    unmount();

    installScene(textNode("t", "a0", "ciao", { strokes: [strokeOf(5, "center")] }));
    useScene.getState().setSelection(["t"]);
    render(<PropertiesPanel />);
    expect(field("Spessore")).toHaveValue("5");
  });
});

// --- ALLINEAMENTO (M2, traccia 2, task 3) ------------------------------------
//
// La MATEMATICA dell'allineamento è testata dov'è, come funzione pura
// (selection/align.test.ts). Qui si verifica solo che il pannello sia il modo di
// raggiungerla: che i pulsanti ci siano, che abbiano un nome leggibile e che
// muovano davvero la selezione con UN gesto.
describe("allineamento", () => {
  it("non mostra i pulsanti senza selezione", () => {
    installScene(rectNode("a", "a0"));
    render(<PropertiesPanel />);
    expect(screen.queryByRole("button", { name: "Allinea a sinistra" })).toBeNull();
  });

  it("allinea la selezione multipla al suo riquadro comune, in un gesto solo", () => {
    installScene(
      rectNode("a", "a0", { x: 0, y: 0, width: 50, height: 50 }),
      rectNode("b", "a1", { x: 100, y: 30, width: 50, height: 50 }),
    );
    useScene.getState().setSelection(["a", "b"]);
    render(<PropertiesPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Allinea a sinistra" }));

    const scene = useScene.getState().scene;
    expect(scene?.nodes.at("a").x).toBe(0);
    expect(scene?.nodes.at("b").x).toBe(0);
    expect(scene?.nodes.at("b").y).toBe(30); // l'asse che non riguarda non si muove
    expect(sync.sent).toHaveLength(1); // solo "b" si è mosso
    expect(useScene.getState().undoStack).toHaveLength(1);
    expect(useScene.getState().gesture).toBeNull();
  });

  it("distribuisce tre nodi con un pulsante solo", () => {
    installScene(
      rectNode("a", "a0", { x: 0, y: 0, width: 10, height: 10 }),
      rectNode("b", "a1", { x: 15, y: 0, width: 10, height: 10 }),
      rectNode("c", "a2", { x: 90, y: 0, width: 10, height: 10 }),
    );
    useScene.getState().setSelection(["a", "b", "c"]);
    render(<PropertiesPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Distribuisci orizzontalmente" }));

    expect(useScene.getState().scene?.nodes.at("b").x).toBe(45);
    expect(useScene.getState().undoStack).toHaveLength(1);
  });

  // UN NODO SOLO: i pulsanti sono DISABILITATI e il nodo non si muove. Non
  // esiste nessuna pagina contro cui allinearlo (selection/align.ts), e un
  // pulsante vivo che non fa niente non si distingue da uno rotto.
  it("con un nodo solo la barra non c'è (niente da allineare) e non si muove niente", () => {
    installScene(rectNode("a", "a0", { x: 500, y: 500, width: 50, height: 50 }));
    useScene.getState().setSelection(["a"]);
    render(<PropertiesPanel />);

    expect(screen.queryByRole("group", { name: "Allinea" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Allinea a sinistra" })).not.toBeInTheDocument();
    expect(useScene.getState().scene?.nodes.at("a").x).toBe(500); // dov'era
    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().undoStack).toHaveLength(0);
  });

  it("con DUE nodi i sei allineamenti si accendono, le distribuzioni no", () => {
    installScene(rectNode("a", "a0"), rectNode("b", "a1", { x: 100 }));
    useScene.getState().setSelection(["a", "b"]);
    render(<PropertiesPanel />);
    for (const name of [
      "Allinea a sinistra", "Centra orizzontalmente", "Allinea a destra",
      "Allinea in alto", "Centra verticalmente", "Allinea in basso",
    ]) {
      expect(screen.getByRole("button", { name })).toBeEnabled();
    }
    expect(screen.getByRole("button", { name: "Distribuisci orizzontalmente" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Distribuisci verticalmente" })).toBeDisabled();
  });

  it("con TRE nodi si accende tutto", () => {
    installScene(rectNode("a", "a0"), rectNode("b", "a1", { x: 100 }), rectNode("c", "a2", { x: 200 }));
    useScene.getState().setSelection(["a", "b", "c"]);
    render(<PropertiesPanel />);
    expect(screen.getByRole("button", { name: "Distribuisci orizzontalmente" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Distribuisci verticalmente" })).toBeEnabled();
  });

  it("ogni comando ha il suo pulsante con un nome leggibile", () => {
    installScene(rectNode("a", "a0"), rectNode("b", "a1", { x: 100 }));
    useScene.getState().setSelection(["a", "b"]);
    render(<PropertiesPanel />);
    for (const name of [
      "Allinea a sinistra", "Centra orizzontalmente", "Allinea a destra",
      "Distribuisci orizzontalmente",
      "Allinea in alto", "Centra verticalmente", "Allinea in basso",
      "Distribuisci verticalmente",
    ]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });
});

// --- Gruppi: il pannello dice la stessa cosa che disegna l'overlay ----------
//
// Un gruppo non ha geometria propria (store/groups.ts): la sua cornice è
// l'unione dei figli e le sue x/y sono la TRASLAZIONE che contribuisce loro.
// Il pannello mostrava invece i campi grezzi -- W=0 H=0 su un gruppo che si
// vede benissimo, e una X che non è il bordo sinistro della cornice.
//   - W/H spariscono appena la selezione contiene un gruppo: non c'è un box da
//     riscrivere, e l'op partirebbe lo stesso (accettato da entrambe le
//     implementazioni di apply, invisibile su canvas, una voce di undo sprecata);
//   - X/Y restano e significano per un gruppo quello che significano per tutti
//     gli altri: l'angolo alto-sinistra della cornice, nello spazio del parent.

function groupWithChild() {
  installScene(
    groupNode("g", "a1"),
    rectNode("c", "a0", { parentId: "g", x: 10, y: 20, width: 30, height: 40 }),
    rectNode("solo", "a2", { x: 200, y: 200 }),
  );
}

describe("gruppi — campi geometrici", () => {
  it("un gruppo non mostra W/H: non ha un box proprio da riscrivere", () => {
    groupWithChild();

    useScene.getState().setSelection(["g"]);
    const { rerender } = render(<PropertiesPanel />);
    expect(field("X")).toBeInTheDocument();
    expect(field("Y")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "W" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "H" })).toBeNull();

    // Il figlio è un rettangolo come un altro: i quattro campi tornano.
    useScene.getState().setSelection(["c"]);
    rerender(<PropertiesPanel />);
    expect(screen.getByRole("textbox", { name: "W" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "H" })).toBeInTheDocument();
  });

  it("nemmeno in una selezione MISTA gruppo+rettangolo: l'op andrebbe anche al gruppo", () => {
    groupWithChild();
    useScene.getState().setSelection(["g", "solo"]);
    render(<PropertiesPanel />);

    expect(screen.queryByRole("textbox", { name: "W" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "H" })).toBeNull();
    expect(field("X")).toBeInTheDocument();
  });

  it("X/Y mostrano l'origine della CORNICE, non la traslazione (0,0) del gruppo", () => {
    groupWithChild();
    useScene.getState().setSelection(["g"]);
    render(<PropertiesPanel />);

    const scene = useScene.getState().scene!;
    expect(scene.nodes.at("g").x).toBe(0); // la traslazione del gruppo È zero...
    // ...ma la cornice che l'overlay disegna sta a (10,20), ed è quella che il
    // pannello deve dire.
    const frame = contentWorldBounds(scene, scene.nodes.at("g"))!;
    expect(field("X")).toHaveValue(String(frame.x));
    expect(field("Y")).toHaveValue(String(frame.y));
    expect(field("X")).toHaveValue("10");
    expect(field("Y")).toHaveValue("20");
  });

  it("digitare X su un gruppo porta il BORDO SINISTRO della cornice lì: UN op, UNA voce di undo", async () => {
    groupWithChild();
    useScene.getState().setSelection(["g"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();
    const undoBefore = useScene.getState().undoStack.length;

    await user.clear(field("X"));
    await user.type(field("X"), "99{Enter}");

    // Un solo op, e ASSOLUTO come ogni altro setProps: il delta si risolve
    // quando l'op si costruisce, non viaggia sul filo -- altrimenti un rebase
    // (o un redo) lo applicherebbe una seconda volta.
    expect(sync.sent).toHaveLength(1);
    const op = sync.sent[0];
    expect(maskOf(op)).toEqual(["x"]);
    if (op.kind.case === "setProps") expect(op.kind.value.patch?.x).toBe(89); // 0 + (99 - 10)

    const scene = useScene.getState().scene!;
    expect(scene.nodes.at("g").x).toBe(89);
    expect(scene.nodes.at("c").x).toBe(10); // il figlio non si muove nel suo spazio
    expect(contentWorldBounds(scene, scene.nodes.at("g"))!.x).toBe(99);
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
    expect(useScene.getState().gesture).toBeNull();

    // E si annulla come qualunque altra modifica: la cornice torna a 10.
    useScene.getState().undo();
    const after = useScene.getState().scene!;
    expect(after.nodes.at("g").x).toBe(0);
    expect(contentWorldBounds(after, after.nodes.at("g"))!.x).toBe(10);
  });

  it("confermare la X che il campo già mostra non manda nessun op", async () => {
    groupWithChild();
    useScene.getState().setSelection(["g"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();

    await user.click(field("X"));
    await user.keyboard("{Enter}");

    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().scene?.nodes.at("g").x).toBe(0);
  });

  it("trascinare l'etichetta X di un gruppo resta UN gesto e porta la cornice dove dice il campo", () => {
    groupWithChild();
    useScene.getState().setSelection(["g"]);
    render(<PropertiesPanel />);
    const undoBefore = useScene.getState().undoStack.length;

    dragLabel("X", 25); // dalla cornice a 10 -> 35

    expect(sync.sent).toHaveLength(1);
    expect(maskOf(sync.sent[0])).toEqual(["x"]);
    const scene = useScene.getState().scene!;
    expect(scene.nodes.at("g").x).toBe(25);
    // I passi intermedi dell'anteprima non si sommano: la cornice finisce
    // esattamente dove il campo dice, non a 10+12+25.
    expect(contentWorldBounds(scene, scene.nodes.at("g"))!.x).toBe(35);
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
    expect(useScene.getState().gesture).toBeNull();
  });

  // Un figlio NASCOSTO non è contenuto: il renderer non lo disegna (e non lo
  // colpisce, e il marquee non lo prende). La X del pannello è il bordo
  // sinistro della CORNICE, e la cornice è ciò che si vede: se contasse anche
  // il nascosto, il numero mostrato sarebbe il suo bordo, e digitarci dentro
  // porterebbe LUI a quella X lasciando il contenuto visibile altrove.
  function groupWithHiddenChild() {
    installScene(
      groupNode("g", "a1"),
      rectNode("nascosto", "a0", { parentId: "g", x: 10, y: 20, width: 30, height: 40, visible: false }),
      rectNode("visibile", "a1", { parentId: "g", x: 100, y: 0, width: 20, height: 20 }),
    );
  }

  it("X/Y mostrano il bordo del contenuto VISIBILE: un figlio nascosto non allarga la cornice", () => {
    groupWithHiddenChild();
    useScene.getState().setSelection(["g"]);
    render(<PropertiesPanel />);

    // Con il figlio nascosto dentro l'unione, X direbbe 10 e Y direbbe 0.
    expect(field("X")).toHaveValue("100");
    expect(field("Y")).toHaveValue("0");
  });

  it("digitare X su quel gruppo porta il contenuto VISIBILE a quella X", async () => {
    groupWithHiddenChild();
    useScene.getState().setSelection(["g"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();

    await user.clear(field("X"));
    await user.type(field("X"), "99{Enter}");

    expect(sync.sent).toHaveLength(1);
    expect(maskOf(sync.sent[0])).toEqual(["x"]);
    // 0 + (99 - 100): la traslazione del gruppo si sposta di -1, non di +89
    // (che è quello che darebbe il bordo del figlio nascosto).
    if (sync.sent[0].kind.case === "setProps") expect(sync.sent[0].kind.value.patch?.x).toBe(-1);

    const scene = useScene.getState().scene!;
    expect(contentWorldBounds(scene, scene.nodes.at("g"))!.x).toBe(99);
    // Il figlio visibile è davvero lì: 100 + (-1).
    expect(scene.nodes.at("g").x + scene.nodes.at("visibile").x).toBe(99);
  });

  it("un gruppo con TUTTI i figli nascosti si comporta come uno vuoto: X è la sua traslazione", async () => {
    installScene(
      groupNode("g", "a1", { x: 3, y: 4 }),
      rectNode("h1", "a0", { parentId: "g", x: 10, y: 20, visible: false }),
      rectNode("h2", "a1", { parentId: "g", x: 100, y: 0, visible: false }),
    );
    useScene.getState().setSelection(["g"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();

    expect(field("X")).toHaveValue("3");

    // E la X si scrive ASSOLUTA, come per ogni gruppo senza cornice.
    await user.clear(field("X"));
    await user.type(field("X"), "50{Enter}");

    expect(sync.sent).toHaveLength(1);
    if (sync.sent[0].kind.case === "setProps") expect(sync.sent[0].kind.value.patch?.x).toBe(50);
    expect(useScene.getState().scene?.nodes.at("g").x).toBe(50);
  });

  it("un gruppo VUOTO non ha cornice: X/Y restano la sua traslazione, scritta com'è", async () => {
    installScene(groupNode("g", "a0", { x: 3, y: 4 }));
    useScene.getState().setSelection(["g"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();

    expect(field("X")).toHaveValue("3");

    await user.clear(field("X"));
    await user.type(field("X"), "50{Enter}");

    expect(sync.sent).toHaveLength(1);
    if (sync.sent[0].kind.case === "setProps") expect(sync.sent[0].kind.value.patch?.x).toBe(50);
    expect(useScene.getState().scene?.nodes.at("g").x).toBe(50);
  });
});

// --- M4: OVERRIDE DELLE ISTANZE ---------------------------------------------
//
// Per UNA sola istanza selezionata il pannello mostra una sezione "Override":
// una riga per ogni nodo del MASTER che sia un testo o abbia un riempimento, col
// suo valore EFFETTIVO (l'override dell'istanza se c'è, altrimenti il valore del
// master). Scriverci emette UN SetInstanceOverride; "Ripristina" ne emette uno
// VUOTO (rimozione, torna a ereditare). Le due metà (fills/text) sono
// indipendenti: modificarne una conserva l'altra.

// Installa un master (frame `m` con un rect "Sfondo" rosso e un testo
// "Etichetta") registrato come componente cmp1, più un'istanza `inst` che lo
// rende. `overrides` semina gli override dell'istanza.
function installInstance(overrides: InstanceOverrideLite[] = []) {
  const scene = emptyScene("doc-1", "Untitled");
  const m: NodeLite = {
    ...rectNode("m", "a1"), kind: "frame", fills: [], x: 0, y: 0, width: 100, height: 100,
  };
  const mr: NodeLite = {
    ...rectNode("mr", "a1", { parentId: "m", name: "Sfondo", fills: [{ r: 1, g: 0, b: 0, a: 1 }] }),
  };
  const mt: NodeLite = { ...textNode("mt", "a2", "Ciao", { parentId: "m", name: "Etichetta" }) };
  const inst: NodeLite = {
    ...rectNode("inst", "a9"), kind: "instance", instance: { componentId: "cmp1", overrides },
  };
  for (const n of [m, mr, mt, inst]) scene.nodes = scene.nodes.set(n.id, n);
  scene.components["cmp1"] = { rootNodeId: "m", name: "Frame" };
  useScene.getState().setScene(scene);
  useScene.getState().setSelection(["inst"]);
}

function overrideOf(op: Op) {
  if (op.kind.case !== "setInstanceOverride") throw new Error("non è un op setInstanceOverride");
  return op.kind.value;
}

describe("override delle istanze", () => {
  it("per un'istanza mostra la sezione Override con una riga per ogni nodo sovrascrivibile del master", () => {
    installInstance();
    render(<PropertiesPanel />);

    expect(screen.getByText("Override")).toBeInTheDocument();
    // Valore EFFETTIVO ereditato dal master: il rosso del rect e il testo.
    expect(screen.getByRole("textbox", { name: "Sfondo" })).toHaveValue("#FF0000");
    expect(screen.getByRole("textbox", { name: "Etichetta" })).toHaveValue("Ciao");
  });

  it("modificare il riempimento di un nodo del master emette UN SetInstanceOverride e aggiorna il valore mostrato", async () => {
    installInstance();
    render(<PropertiesPanel />);
    const user = userEvent.setup();
    const undoBefore = useScene.getState().undoStack.length;

    const input = screen.getByRole("textbox", { name: "Sfondo" });
    await user.clear(input);
    await user.type(input, "#00FF00{Enter}");

    expect(sync.sent).toHaveLength(1);
    const o = overrideOf(sync.sent[0]);
    expect(o.instanceId).toBe("inst");
    expect(o.override?.masterNodeId).toBe("mr");
    expect(o.override?.fillsPresent).toBe(true);
    // Il testo NON è toccato: text_present resta false.
    expect(o.override?.textPresent).toBe(false);
    if (o.override?.fills[0]?.kind.case === "solid") {
      expect(o.override.fills[0].kind.value.color?.g).toBeCloseTo(1, 5);
    }
    // Il modello ora ha l'override, e il campo mostra il nuovo valore.
    const inst = useScene.getState().scene!.nodes.at("inst");
    expect(inst.instance?.overrides).toHaveLength(1);
    expect(screen.getByRole("textbox", { name: "Sfondo" })).toHaveValue("#00FF00");
    // Un gesto, una voce di undo.
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
    expect(useScene.getState().gesture).toBeNull();
  });

  it("modificare il testo di un nodo del master emette UN SetInstanceOverride con text_present", async () => {
    installInstance();
    render(<PropertiesPanel />);
    const user = userEvent.setup();

    const input = screen.getByRole("textbox", { name: "Etichetta" });
    await user.clear(input);
    await user.type(input, "Nuovo{Enter}");

    expect(sync.sent).toHaveLength(1);
    const o = overrideOf(sync.sent[0]);
    expect(o.override?.masterNodeId).toBe("mt");
    expect(o.override?.textPresent).toBe(true);
    expect(o.override?.text).toBe("Nuovo");
    expect(o.override?.fillsPresent).toBe(false);
    expect(useScene.getState().scene!.nodes.at("inst").instance?.overrides[0].text).toBe("Nuovo");
    expect(screen.getByRole("textbox", { name: "Etichetta" })).toHaveValue("Nuovo");
  });

  it("il Ripristina è disabilitato senza override e attivo con override; premerlo emette una RIMOZIONE", async () => {
    // Semina un override di fill su "mr".
    installInstance([{ masterNodeId: "mr", fills: [{ r: 0, g: 0, b: 1, a: 1 }] }]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();

    // Il campo mostra il valore SOVRASCRITTO (blu), non quello del master.
    expect(screen.getByRole("textbox", { name: "Sfondo" })).toHaveValue("#0000FF");
    // Ripristina attivo per "mr" (c'è un override), disabilitato per "mt" (non c'è).
    const resetSfondo = screen.getByRole("button", { name: "Ripristina Sfondo" });
    expect(resetSfondo).toBeEnabled();
    expect(screen.getByRole("button", { name: "Ripristina Etichetta" })).toBeDisabled();

    await user.click(resetSfondo);

    expect(sync.sent).toHaveLength(1);
    const o = overrideOf(sync.sent[0]);
    expect(o.override?.masterNodeId).toBe("mr");
    // Override VUOTO = rimozione: entrambi i *_present a false.
    expect(o.override?.fillsPresent).toBe(false);
    expect(o.override?.textPresent).toBe(false);
    // L'override è sparito, e il campo torna al valore del master (rosso).
    expect(useScene.getState().scene!.nodes.at("inst").instance?.overrides).toHaveLength(0);
    expect(screen.getByRole("textbox", { name: "Sfondo" })).toHaveValue("#FF0000");
  });

  it("un override si annulla con Ctrl+Z (un solo gesto)", async () => {
    installInstance();
    render(<PropertiesPanel />);
    const user = userEvent.setup();

    const input = screen.getByRole("textbox", { name: "Sfondo" });
    await user.clear(input);
    await user.type(input, "#00FF00{Enter}");
    expect(useScene.getState().scene!.nodes.at("inst").instance?.overrides).toHaveLength(1);

    useScene.getState().undo();

    expect(useScene.getState().scene!.nodes.at("inst").instance?.overrides).toHaveLength(0);
    expect(useScene.getState().undoStack).toHaveLength(0);
    expect(useScene.getState().redoStack).toHaveLength(1);
  });
});
