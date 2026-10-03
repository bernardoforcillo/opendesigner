import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useScene } from "../store/store";
import { emptyScene, type NodeLite } from "../store/types";
import { attachClipboardShortcuts, clipboardMemory, pasteClipboard, serializeNodes } from "./clipboard";

// L'incolla di testo SVG dagli appunti. (L'incolla dei nodi opendesigner è in
// clipboard.test.ts e non cambia: qui si verifica solo il ramo nuovo e che non
// rubi niente al vecchio.)

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40" width="100" height="40"><rect id="barra" width="100" height="40" rx="8"/><circle id="punto" cx="20" cy="20" r="6" fill="#fff"/></svg>`;

function setClipboard(text: string | null): void {
  Object.defineProperty(globalThis.navigator, "clipboard", {
    value: text === null ? undefined : { readText: vi.fn(async () => text), writeText: vi.fn(async () => {}) },
    configurable: true,
    writable: true,
  });
}

function node(over: Partial<NodeLite> = {}): NodeLite {
  return {
    id: "n1", parentId: "page1", orderKey: "a000001", name: "Rettangolo", visible: true, opacity: 1,
    x: 10, y: 20, width: 30, height: 40, rotation: 0, fills: [{ r: 0.5, g: 0.25, b: 0.125, a: 1 }], strokes: [],
    kind: "rect", cornerRadius: 4, clipsContent: false, ...over,
  };
}

const kinds = () => [...(useScene.getState().scene?.nodes.values() ?? [])].map((n) => n.kind).sort();

beforeEach(() => {
  useScene.setState({ gesture: null, lastError: null, notice: null, selection: [], camera: { x: 0, y: 0, zoom: 1 } });
  useScene.getState().setScene(emptyScene("doc-1", "Untitled"));
  clipboardMemory.text = null;
  clipboardMemory.onSystem = false;
});

afterEach(() => setClipboard(null));

describe("incolla di testo SVG dagli appunti", () => {
  it("lo importa come nodi, UN gesto, selezionando la radice", async () => {
    setClipboard(SVG);
    const ids = await pasteClipboard();
    expect(ids.length).toBe(1);
    expect(kinds()).toEqual(["ellipse", "group", "rect"]);
    expect(useScene.getState().selection).toEqual(ids);
    expect(useScene.getState().notice).toBe("Importato come 3 livelli");
    useScene.getState().undo();
    expect(kinds()).toEqual([]);
  });

  it("riconosce un SVG con prologo XML e commenti", async () => {
    setClipboard(`<?xml version="1.0"?>\n<!-- Created with X -->\n${SVG}\n`);
    expect((await pasteClipboard()).length).toBe(1);
  });

  it("è CENTRATO al centro della vista (camera inclusa)", async () => {
    useScene.setState({ camera: { x: -1000, y: 0, zoom: 1 } });
    setClipboard(SVG);
    const [id] = await pasteClipboard();
    const root = useScene.getState().scene!.nodes.at(id);
    // senza canvas nel DOM la vista è 800x600: centro schermo (400,300) -> mondo (1400,300)
    expect(root.x).toBe(1400 - 50);
    expect(root.y).toBe(300 - 20);
  });

  it("un SVG rotto: avviso, niente nodi, nessuna eccezione", async () => {
    setClipboard("<svg><rect></svg>");
    expect(await pasteClipboard()).toEqual([]);
    expect(kinds()).toEqual([]);
    expect(useScene.getState().notice).toMatch(/Importazione SVG non riuscita/);
  });

  it("il payload opendesigner ha SEMPRE la precedenza (anche se un nome contiene '<svg')", async () => {
    setClipboard(serializeNodes([node({ name: "<svg viewBox='0 0 1 1'></svg>" })]));
    const ids = await pasteClipboard();
    expect(ids.length).toBe(1);
    expect(kinds()).toEqual(["rect"]);
  });

  it("altro testo (non SVG) continua a NON incollare niente", async () => {
    setClipboard("<html><body>ciao</body></html>");
    expect(await pasteClipboard()).toEqual([]);
    expect(kinds()).toEqual([]);
    expect(useScene.getState().notice).toBeNull();
  });

  it("senza clipboard di sistema non c'è nulla da incollare", async () => {
    setClipboard(null);
    expect(await pasteClipboard()).toEqual([]);
  });

  it("Ctrl+V sulla finestra importa l'SVG", async () => {
    setClipboard(SVG);
    const handlers: Record<string, (e: KeyboardEvent) => void> = {};
    const detach = attachClipboardShortcuts({
      addEventListener: (_t: "keydown", h: (e: KeyboardEvent) => void) => { handlers.keydown = h; },
      removeEventListener: () => {},
    });
    handlers.keydown({ key: "v", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, target: null, preventDefault: () => {} } as unknown as KeyboardEvent);
    await vi.waitFor(() => expect(kinds()).toEqual(["ellipse", "group", "rect"]));
    detach();
  });
});
