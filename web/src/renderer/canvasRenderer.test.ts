import { describe, it, expect, afterEach, vi } from "vitest";
import { hitTest, resizeCanvasToDisplaySize, drawScene } from "./canvasRenderer";
import { VECTOR_STROKE_PX } from "./shapes";
import type { Camera } from "../canvas/camera";
import { emptyScene } from "../store/types";
import type { NodeLite, AnchorLite, SubPathLite } from "../store/types";

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

function anchor(a: Partial<AnchorLite>): AnchorLite {
  return { x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0, ...a };
}

// jsdom non ha Path2D: un doppio inerte basta, qui interessa solo QUALE path
// finisce in fill e quale in stroke (la forma esatta è provata in shapes.test.ts).
class FakePath2D {
  rect() {} ellipse() {} roundRect() {}
  moveTo() {} lineTo() {} bezierCurveTo() {} closePath() {}
}

function vectorNode(id: string, subpaths: SubPathLite[], over: Partial<NodeLite> = {}): NodeLite {
  return { ...rect(id, 0, 0, "a0"), kind: "vector", vector: { subpaths }, ...over };
}

// Lo zoom entra solo nella tolleranza di presa del vettoriale: a zoom 1 px
// schermo e unità mondo coincidono, ed è quello che usano i test sulle forme
// il cui bersaglio non dipende dalla camera.
const Z1 = 1;

describe("hitTest", () => {
  it("returns the topmost node under the point", () => {
    const s = emptyScene("d", "n");
    s.nodes["a"] = rect("a", 0, 0, "a0");
    s.nodes["b"] = rect("b", 10, 10, "a1"); // sopra (orderKey maggiore)
    expect(hitTest(s, 25, 25, Z1)).toBe("b");
    expect(hitTest(s, 5, 5, Z1)).toBe("a");
    expect(hitTest(s, 200, 200, Z1)).toBeNull();
  });

  it("returns the topmost node by orderKey when two nodes overlap", () => {
    const s = emptyScene("d", "n");
    // Stesso rettangolo esattamente sovrapposto: "b" ha orderKey maggiore quindi vince.
    s.nodes["a"] = rect("a", 0, 0, "a0");
    s.nodes["b"] = rect("b", 0, 0, "a1");
    expect(hitTest(s, 25, 25, Z1)).toBe("b");
  });

  it("skips invisible nodes", () => {
    const s = emptyScene("d", "n");
    s.nodes["a"] = rect("a", 0, 0, "a0", false); // visible: false, in cima per orderKey
    s.nodes["b"] = rect("b", 0, 0, "a-1", true); // sotto, ma visibile
    // "a" ha orderKey maggiore ma non è visibile: non deve mai essere ritornato.
    expect(hitTest(s, 25, 25, Z1)).toBe("b");

    const onlyInvisible = emptyScene("d", "n");
    onlyInvisible.nodes["a"] = rect("a", 0, 0, "a0", false);
    expect(hitTest(onlyInvisible, 25, 25, Z1)).toBeNull();
  });

  it("porta lo ZOOM fino alla tolleranza di presa del vettoriale", () => {
    // Il tramite: senza, un path si afferrerebbe a distanze diverse a seconda
    // dello zoom, e a zoom alto diventerebbe quasi impossibile da cliccare.
    const s = emptyScene("d", "n");
    s.nodes["v"] = vectorNode("v", [{
      anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 100, y: 0 })], closed: false,
    }], { width: 100, height: 0 });
    expect(hitTest(s, 50, 3, 1)).toBe("v");     // 3 unità mondo = 3 px
    expect(hitTest(s, 50, 3, 4)).toBeNull();    // 3 unità mondo = 12 px
    expect(hitTest(s, 50, 12, 0.25)).toBe("v"); // 12 unità mondo = 3 px
  });

  it("un vettoriale APERTO non ruba i click alle forme che gli stanno dentro", () => {
    // Il rettangolo sotto e, sopra, tre lati di un quadrato che lo circondano
    // senza chiudersi. Cliccare al centro deve prendere il rettangolo: il
    // contorno aperto lì non ha inchiostro.
    const s = emptyScene("d", "n");
    s.nodes["r"] = rect("r", 0, 0, "a0");
    s.nodes["v"] = vectorNode("v", [{
      anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 0, y: 50 }),
        anchor({ x: 50, y: 50 }), anchor({ x: 50, y: 0 })],
      closed: false,
    }], { orderKey: "a1" });
    expect(hitTest(s, 25, 25, Z1)).toBe("r");
    expect(hitTest(s, 25, 49, Z1)).toBe("v");  // sul lato, dove l'inchiostro c'è
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
  const fills: { path: unknown; rule: unknown }[] = [];
  const strokes: { path: unknown; lineWidth: number; strokeStyle: string; cap: string }[] = [];
  const ctx = {
    canvas: { width: 800, height: 600 },
    font: "", textBaseline: "", textAlign: "", fillStyle: "", globalAlpha: 1,
    strokeStyle: "", lineWidth: 0, lineCap: "", lineJoin: "",
    setTransform: () => {},
    clearRect: () => {},
    measureText: (s: string) => ({ width: s.length * 10 }),
    fillText: (t: string, x: number, y: number) => { fillText.push({ text: t, x, y }); },
    fill: (p: unknown, rule?: unknown) => { fills.push({ path: p, rule }); },
    stroke: (p: unknown) => {
      strokes.push({ path: p, lineWidth: ctx.lineWidth, strokeStyle: ctx.strokeStyle, cap: ctx.lineCap });
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, fillText, fills, strokes };
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

  it("still draws a vector node with a degenerate axis, but not a degenerate RECT", () => {
    // Il box di un nodo vettoriale è la bbox ESATTA della sua geometria
    // (invariante del proto), quindi un segmento orizzontale ha davvero height
    // 0. Scartarlo qui lo renderebbe invisibile -- e, con lo stesso guard
    // nell'hit-test, nemmeno cliccabile: raggiungibile solo dal pannello
    // livelli.
    //
    // Il rettangolo degenere invece resta scartato: lì l'inchiostro È il box e
    // non c'è niente da riempire. È la distinzione che vive in
    // shapes.ts::inkIsBox, condivisa da disegno e hit-test.
    vi.stubGlobal("Path2D", FakePath2D);
    try {
      const s = emptyScene("d", "n");
      s.nodes["v"] = vectorNode("v", [{
        anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 50, y: 0 })], closed: false,
      }], { height: 0 });
      const f = fakeCtx();
      drawScene(f.ctx, s, { x: 0, y: 0, zoom: 1 } as Camera);
      expect(f.strokes).toHaveLength(1);

      const s2 = emptyScene("d", "n");
      s2.nodes["r"] = { ...rect("r", 0, 0, "a0"), height: 0 };
      const f2 = fakeCtx();
      drawScene(f2.ctx, s2, { x: 0, y: 0, zoom: 1 } as Camera);
      expect(f2.fills).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("un vettoriale CHIUSO si riempie con la regola even-odd", () => {
    // La regola non è il default del canvas ("nonzero"), quindi va passata
    // esplicitamente -- ed è la stessa che usa l'hit-test. Con nonzero un
    // contorno interno percorso nello stesso verso di quello esterno NON
    // sarebbe un buco, e il disegno smetterebbe di corrispondere al click.
    vi.stubGlobal("Path2D", FakePath2D);
    try {
      const s = emptyScene("d", "n");
      s.nodes["v"] = vectorNode("v", [{
        anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 10, y: 0 }), anchor({ x: 10, y: 10 })],
        closed: true,
      }]);
      const f = fakeCtx();
      drawScene(f.ctx, s, { x: 0, y: 0, zoom: 1 } as Camera);
      expect(f.fills).toHaveLength(1);
      expect(f.fills[0].rule).toBe("evenodd");
      expect(f.strokes).toEqual([]);   // niente tratto: il riempimento è già visibile
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("un vettoriale APERTO si TRACCIA, con uno spessore costante in px schermo", () => {
    // Un contorno aperto non si riempie: senza tratto non esisterebbe sullo
    // schermo, e il pen tool disegnerebbe alla cieca. Il ctx è già in
    // trasformazione mondo (zoom applicato), quindi lo spessore va diviso per
    // lo zoom -- altrimenti la linea si ingrasserebbe insieme al disegno.
    vi.stubGlobal("Path2D", FakePath2D);
    try {
      const s = emptyScene("d", "n");
      s.nodes["v"] = vectorNode("v", [{
        anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 50, y: 50 })], closed: false,
      }]);
      for (const zoom of [1, 4, 0.5]) {
        const f = fakeCtx();
        drawScene(f.ctx, s, { x: 0, y: 0, zoom } as Camera);
        expect(f.fills).toEqual([]);
        expect(f.strokes).toHaveLength(1);
        expect(f.strokes[0].lineWidth).toBeCloseTo(VECTOR_STROKE_PX / zoom, 10);
        // Il modello non ha un colore di tratto: si usa quello del riempimento,
        // l'unica tinta che conosce.
        expect(f.strokes[0].strokeStyle).toBe("rgba(0, 0, 0, 1)");
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("un nodo con contorni aperti E chiusi paga una fill e una stroke", () => {
    vi.stubGlobal("Path2D", FakePath2D);
    try {
      const s = emptyScene("d", "n");
      s.nodes["v"] = vectorNode("v", [
        { anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 10, y: 0 }), anchor({ x: 0, y: 10 })], closed: true },
        { anchors: [anchor({ x: 50, y: 0 }), anchor({ x: 50, y: 30 })], closed: false },
      ]);
      const f = fakeCtx();
      drawScene(f.ctx, s, { x: 0, y: 0, zoom: 1 } as Camera);
      expect(f.fills).toHaveLength(1);
      expect(f.strokes).toHaveLength(1);
      // Due Path2D DIVERSI: nello stesso, il canvas chiuderebbe implicitamente
      // anche il contorno aperto e lo riempirebbe.
      expect(f.fills[0].path).not.toBe(f.strokes[0].path);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("un vettoriale senza geometria non dipinge niente", () => {
    // Nessuna fill a vuoto e nessuna stroke a vuoto: è anche la ragione per cui
    // l'hit-test non lo colpisce (niente inchiostro, niente bersaglio).
    vi.stubGlobal("Path2D", FakePath2D);
    try {
      const s = emptyScene("d", "n");
      s.nodes["v"] = vectorNode("v", []);
      const f = fakeCtx();
      drawScene(f.ctx, s, { x: 0, y: 0, zoom: 1 } as Camera);
      expect(f.fills).toEqual([]);
      expect(f.strokes).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
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
