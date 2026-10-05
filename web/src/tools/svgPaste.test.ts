import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useScene } from "../store/store";
import { emptyScene, type NodeLite } from "../store/types";
import { attachClipboardShortcuts, clipboardMemory, pasteClipboard, serializeNodes } from "./clipboard";

// Pasting SVG text from the clipboard. (Pasting opendesigner nodes is in
// clipboard.test.ts and does not change: here we only verify the new branch and that it
// does not steal anything from the old one.)

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40" width="100" height="40"><rect id="bar" width="100" height="40" rx="8"/><circle id="dot" cx="20" cy="20" r="6" fill="#fff"/></svg>`;

function setClipboard(text: string | null): void {
  Object.defineProperty(globalThis.navigator, "clipboard", {
    value: text === null ? undefined : { readText: vi.fn(async () => text), writeText: vi.fn(async () => {}) },
    configurable: true,
    writable: true,
  });
}

function node(over: Partial<NodeLite> = {}): NodeLite {
  return {
    id: "n1", parentId: "page1", orderKey: "a000001", name: "Rectangle", visible: true, opacity: 1,
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

describe("pasting SVG text from the clipboard", () => {
  it("imports it as nodes, ONE gesture, selecting the root", async () => {
    setClipboard(SVG);
    const ids = await pasteClipboard();
    expect(ids.length).toBe(1);
    expect(kinds()).toEqual(["ellipse", "group", "rect"]);
    expect(useScene.getState().selection).toEqual(ids);
    expect(useScene.getState().notice).toBe("Imported as 3 layers");
    useScene.getState().undo();
    expect(kinds()).toEqual([]);
  });

  it("recognizes an SVG with an XML prologue and comments", async () => {
    setClipboard(`<?xml version="1.0"?>\n<!-- Created with X -->\n${SVG}\n`);
    expect((await pasteClipboard()).length).toBe(1);
  });

  it("is CENTERED on the center of the view (camera included)", async () => {
    useScene.setState({ camera: { x: -1000, y: 0, zoom: 1 } });
    setClipboard(SVG);
    const [id] = await pasteClipboard();
    const root = useScene.getState().scene!.nodes.at(id);
    // with no canvas in the DOM the view is 800x600: screen center (400,300) -> world (1400,300)
    expect(root.x).toBe(1400 - 50);
    expect(root.y).toBe(300 - 20);
  });

  it("a broken SVG: notice, no nodes, no exception", async () => {
    setClipboard("<svg><rect></svg>");
    expect(await pasteClipboard()).toEqual([]);
    expect(kinds()).toEqual([]);
    expect(useScene.getState().notice).toMatch(/SVG import failed/);
  });

  it("the opendesigner payload ALWAYS takes precedence (even if a name contains '<svg')", async () => {
    setClipboard(serializeNodes([node({ name: "<svg viewBox='0 0 1 1'></svg>" })]));
    const ids = await pasteClipboard();
    expect(ids.length).toBe(1);
    expect(kinds()).toEqual(["rect"]);
  });

  it("other text (non-SVG) still pastes NOTHING", async () => {
    setClipboard("<html><body>hello</body></html>");
    expect(await pasteClipboard()).toEqual([]);
    expect(kinds()).toEqual([]);
    expect(useScene.getState().notice).toBeNull();
  });

  it("without a system clipboard there is nothing to paste", async () => {
    setClipboard(null);
    expect(await pasteClipboard()).toEqual([]);
  });

  it("Ctrl+V on the window imports the SVG", async () => {
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
