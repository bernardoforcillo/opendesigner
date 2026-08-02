import { describe, it, expect, afterEach, vi } from "vitest";
import { hitTest, resizeCanvasToDisplaySize, drawScene } from "./canvasRenderer";
import type { CachedImage } from "./imageCache";
import type { Camera } from "../canvas/camera";
import { emptyScene } from "../store/types";
import type { NodeLite } from "../store/types";

// Duck-typed stand-in for HTMLCanvasElement: resizeCanvasToDisplaySize only
// touches clientWidth/clientHeight/width/height, so a plain object is enough
// to test it under Node without a DOM (there is no jsdom/canvas setup here).
function fakeCanvas(clientWidth: number, clientHeight: number, width = 0, height = 0) {
  return { clientWidth, clientHeight, width, height } as unknown as HTMLCanvasElement;
}

function rect(id: string, x: number, y: number, order: string, visible = true): NodeLite {
  return { id, parentId: "page1", orderKey: order, name: id, visible, opacity: 1,
    x, y, width: 50, height: 50, rotation: 0, fills: [{ r: 0, g: 0, b: 0, a: 1 }], kind: "rect", cornerRadius: 0 };
}

describe("hitTest", () => {
  it("returns the topmost node under the point", () => {
    const s = emptyScene("d", "n");
    s.nodes["a"] = rect("a", 0, 0, "a0");
    s.nodes["b"] = rect("b", 10, 10, "a1"); // sopra (orderKey maggiore)
    expect(hitTest(s, 25, 25)).toBe("b");
    expect(hitTest(s, 5, 5)).toBe("a");
    expect(hitTest(s, 200, 200)).toBeNull();
  });

  it("returns the topmost node by orderKey when two nodes overlap", () => {
    const s = emptyScene("d", "n");
    // Stesso rettangolo esattamente sovrapposto: "b" ha orderKey maggiore quindi vince.
    s.nodes["a"] = rect("a", 0, 0, "a0");
    s.nodes["b"] = rect("b", 0, 0, "a1");
    expect(hitTest(s, 25, 25)).toBe("b");
  });

  it("skips invisible nodes", () => {
    const s = emptyScene("d", "n");
    s.nodes["a"] = rect("a", 0, 0, "a0", false); // visible: false, in cima per orderKey
    s.nodes["b"] = rect("b", 0, 0, "a-1", true); // sotto, ma visibile
    // "a" ha orderKey maggiore ma non è visibile: non deve mai essere ritornato.
    expect(hitTest(s, 25, 25)).toBe("b");

    const onlyInvisible = emptyScene("d", "n");
    onlyInvisible.nodes["a"] = rect("a", 0, 0, "a0", false);
    expect(hitTest(onlyInvisible, 25, 25)).toBeNull();
  });
});

function textNode(over: Partial<NodeLite> = {}): NodeLite {
  return { id: "t", parentId: "page1", orderKey: "a1", name: "Text", visible: true, opacity: 1,
    x: 10, y: 20, width: 200, height: 40, rotation: 0, fills: [{ r: 0, g: 0, b: 0, a: 1 }],
    kind: "text", cornerRadius: 0,
    text: { content: "hi", style: { fontFamily: "", fontSize: 16, fontWeight: "", lineHeight: 0, align: "left" } },
    ...over };
}

// ctx duck-typed: jsdom non ha né il canvas 2D né Path2D. Una scena di solo
// testo non passa mai da nodePath, quindi drawScene è testabile qui.
function fakeCtx() {
  const fillText: { text: string; x: number; y: number }[] = [];
  const fills: unknown[] = [];
  const ctx = {
    canvas: { width: 800, height: 600 },
    font: "", textBaseline: "", textAlign: "", fillStyle: "", globalAlpha: 1,
    setTransform: () => {},
    clearRect: () => {},
    measureText: (s: string) => ({ width: s.length * 10 }),
    fillText: (t: string, x: number, y: number) => { fillText.push({ text: t, x, y }); },
    fill: (p: unknown) => { fills.push(p); },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, fillText, fills };
}

describe("drawScene", () => {
  it("routes a text node to drawText instead of filling its box", () => {
    const s = emptyScene("d", "n");
    s.nodes["t"] = textNode();
    const f = fakeCtx();
    drawScene(f.ctx, s, { x: 0, y: 0, zoom: 1 } as Camera);
    expect(f.fillText.map((c) => c.text)).toEqual(["hi"]);
    expect(f.fills).toEqual([]); // niente riempimento del rettangolo sotto il testo
  });

  it("still draws a text node whose height has not been measured yet", () => {
    // L'altezza di un testo la produce il LAYOUT, non il box: un nodo con
    // height 0 deve comunque comparire, altrimenti il testo appena scritto
    // resterebbe invisibile finché qualcuno non aggiorna height.
    const s = emptyScene("d", "n");
    s.nodes["t"] = textNode({ height: 0 });
    const f = fakeCtx();
    drawScene(f.ctx, s, { x: 0, y: 0, zoom: 1 } as Camera);
    expect(f.fillText.map((c) => c.text)).toEqual(["hi"]);
  });

  it("skips an invisible text node", () => {
    const s = emptyScene("d", "n");
    s.nodes["t"] = textNode({ visible: false });
    const f = fakeCtx();
    drawScene(f.ctx, s, { x: 0, y: 0, zoom: 1 } as Camera);
    expect(f.fillText).toEqual([]);
  });
});

describe("resizeCanvasToDisplaySize", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to DPR 1 when window is unavailable (no jsdom in this project)", () => {
    const canvas = fakeCanvas(800, 600);
    expect(resizeCanvasToDisplaySize(canvas)).toBe(true);
    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(600);
  });

  it("scales the backing store by devicePixelRatio and rounds", () => {
    vi.stubGlobal("window", { devicePixelRatio: 2.5 });
    const canvas = fakeCanvas(801, 600); // 801 * 2.5 = 2002.5 -> rounds to 2003
    expect(resizeCanvasToDisplaySize(canvas)).toBe(true);
    expect(canvas.width).toBe(2003);
    expect(canvas.height).toBe(1500);
  });

  it("returns false and leaves the backing store untouched when size is unchanged", () => {
    vi.stubGlobal("window", { devicePixelRatio: 2 });
    const canvas = fakeCanvas(400, 300, 800, 600); // already at CSS size * dpr
    expect(resizeCanvasToDisplaySize(canvas)).toBe(false);
    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(600);
  });

  it("returns true and resizes when only one dimension changed", () => {
    vi.stubGlobal("window", { devicePixelRatio: 1 });
    const canvas = fakeCanvas(400, 300, 400, 999);
    expect(resizeCanvasToDisplaySize(canvas)).toBe(true);
    expect(canvas.width).toBe(400);
    expect(canvas.height).toBe(300);
  });

  it("falls back to DPR 1 when window.devicePixelRatio is falsy (e.g. 0)", () => {
    vi.stubGlobal("window", { devicePixelRatio: 0 });
    const canvas = fakeCanvas(400, 300);
    resizeCanvasToDisplaySize(canvas);
    expect(canvas.width).toBe(400);
    expect(canvas.height).toBe(300);
  });
});

// --- immagini (traccia 3) ----------------------------------------------------

function imageNode(over: Partial<NodeLite> = {}): NodeLite {
  return { id: "i", parentId: "page1", orderKey: "a1", name: "Image", visible: true, opacity: 1,
    x: 10, y: 20, width: 320, height: 180, rotation: 0, fills: [], kind: "image", cornerRadius: 0,
    image: { assetHash: "abc" }, ...over };
}

// Il ctx finto guadagna quello che serve al ramo immagine. Il segnaposto è
// disegnato con fillRect/strokeRect/moveTo e NON con un Path2D proprio perché
// deve restare verificabile qui: jsdom non ha Path2D.
function imageCtx() {
  const drawn: { src: unknown; x: number; y: number; w: number; h: number }[] = [];
  const fillRects: { x: number; y: number; w: number; h: number }[] = [];
  const strokeRects: { x: number; y: number; w: number; h: number }[] = [];
  const lines: { x: number; y: number }[] = [];
  const ctx = {
    canvas: { width: 800, height: 600 },
    fillStyle: "", strokeStyle: "", lineWidth: 0, globalAlpha: 1,
    setTransform: () => {},
    clearRect: () => {},
    fill: () => {},
    drawImage: (src: unknown, x: number, y: number, w: number, h: number) => {
      drawn.push({ src, x, y, w, h });
    },
    fillRect: (x: number, y: number, w: number, h: number) => { fillRects.push({ x, y, w, h }); },
    strokeRect: (x: number, y: number, w: number, h: number) => { strokeRects.push({ x, y, w, h }); },
    beginPath: () => {},
    moveTo: (x: number, y: number) => { lines.push({ x, y }); },
    lineTo: (x: number, y: number) => { lines.push({ x, y }); },
    stroke: () => {},
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, drawn, fillRects, strokeRects, lines };
}

function images(entry: CachedImage) {
  const asked: { docId: string; hash: string }[] = [];
  return {
    asked,
    source: {
      get(docId: string, hash: string) {
        asked.push({ docId, hash });
        return entry;
      },
    },
  };
}

const READY = { status: "ready", image: { naturalWidth: 40, naturalHeight: 20 } as HTMLImageElement } as CachedImage;

describe("drawScene: immagini", () => {
  it("disegna l'immagine decodificata nel box del nodo", () => {
    const s = emptyScene("doc-1", "n");
    s.nodes["i"] = imageNode();
    const f = imageCtx();
    const src = images(READY);
    drawScene(f.ctx, s, { x: 0, y: 0, zoom: 1 } as Camera, { images: src.source });

    expect(f.drawn).toEqual([{ src: READY.image, x: 10, y: 20, w: 320, h: 180 }]);
    // L'hash lo si chiede per il DOCUMENTO della scena: lo stesso hash in un
    // altro documento è un altro file.
    expect(src.asked).toEqual([{ docId: "doc-1", hash: "abc" }]);
    // Niente riempimento sotto: un rettangolo grigio dietro un'immagine con
    // trasparenza si vedrebbe attraverso.
    expect(f.fillRects).toEqual([]);
  });

  it("un asset MANCANTE diventa un segnaposto visibile, non un'eccezione", () => {
    const s = emptyScene("doc-1", "n");
    s.nodes["i"] = imageNode();
    const f = imageCtx();
    const src = images({ status: "missing", image: null });

    expect(() =>
      drawScene(f.ctx, s, { x: 0, y: 0, zoom: 1 } as Camera, { images: src.source }),
    ).not.toThrow();

    expect(f.drawn).toEqual([]);
    expect(f.fillRects).toEqual([{ x: 10, y: 20, w: 320, h: 180 }]);
    expect(f.strokeRects.length).toBe(1);
    // La croce: due diagonali, cioè quattro punti. È ciò che distingue "manca"
    // da "sto caricando", che altrimenti sarebbero lo stesso rettangolo grigio.
    expect(f.lines.length).toBe(4);
  });

  it("un asset ANCORA IN CARICAMENTO è un segnaposto SENZA croce", () => {
    const s = emptyScene("doc-1", "n");
    s.nodes["i"] = imageNode();
    const f = imageCtx();
    const src = images({ status: "loading", image: null });
    drawScene(f.ctx, s, { x: 0, y: 0, zoom: 1 } as Camera, { images: src.source });

    expect(f.drawn).toEqual([]);
    expect(f.fillRects.length).toBe(1);
    expect(f.lines).toEqual([]);
  });

  it("il bordo del segnaposto è spesso un PIXEL SCHERMO a ogni zoom", () => {
    // Il ctx è trasformato in coordinate mondo: una lineWidth in unità mondo
    // sparirebbe a zoom 0.1 e diventerebbe un bordo grasso a zoom 8.
    const s = emptyScene("doc-1", "n");
    s.nodes["i"] = imageNode();
    for (const zoom of [0.25, 1, 4]) {
      const f = imageCtx();
      drawScene(f.ctx, s, { x: 0, y: 0, zoom } as Camera, {
        images: images({ status: "missing", image: null }).source,
      });
      expect(f.ctx.lineWidth).toBeCloseTo(1 / zoom);
    }
  });

  it("un nodo immagine degenere non disegna niente (come ogni forma senza area)", () => {
    const s = emptyScene("doc-1", "n");
    s.nodes["i"] = imageNode({ width: 0 });
    const f = imageCtx();
    drawScene(f.ctx, s, { x: 0, y: 0, zoom: 1 } as Camera, { images: images(READY).source });
    expect(f.drawn).toEqual([]);
    expect(f.fillRects).toEqual([]);
  });

  it("senza una sorgente iniettata usa la cache condivisa, e non lancia", () => {
    // È il percorso VERO (App.tsx non inietta niente): in jsdom l'immagine non
    // si carica mai, quindi resta "loading" -- ma il loop non deve morire.
    const s = emptyScene("doc-1", "n");
    s.nodes["i"] = imageNode();
    const f = imageCtx();
    expect(() => drawScene(f.ctx, s, { x: 0, y: 0, zoom: 1 } as Camera)).not.toThrow();
    expect(f.drawn).toEqual([]);
  });
});
