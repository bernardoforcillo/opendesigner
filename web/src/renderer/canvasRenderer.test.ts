import { describe, it, expect, afterEach, vi } from "vitest";
import { hitTest, resizeCanvasToDisplaySize, drawScene } from "./canvasRenderer";
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

function childRect(id: string, parentId: string, x: number, y: number, order: string, over: Partial<NodeLite> = {}): NodeLite {
  return { ...rect(id, x, y, order), parentId, ...over };
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

// page1 > g(100,50) > h(10,20) > k(3,4): tre livelli, ogni livello con uno
// scostamento diverso da zero su entrambi gli assi. In coordinate MONDO
// l'angolo di "k" cade a (113,74) e il suo box 50x50 arriva a (163,124).
function nestedScene() {
  const s = emptyScene("d", "n");
  s.nodes["g"] = childRect("g", "page1", 100, 50, "a0", { width: 400, height: 400 });
  s.nodes["h"] = childRect("h", "g", 10, 20, "a0", { width: 200, height: 200 });
  s.nodes["k"] = childRect("k", "h", 3, 4, "a0");
  return s;
}

describe("hitTest with nesting", () => {
  it("finds a nested node at its WORLD position, not at its local one", () => {
    const s = nestedScene();
    // Il centro di "k" in coordinate mondo: 113+25, 74+25.
    expect(hitTest(s, 138, 99)).toBe("k");
    // Le sue coordinate LOCALI (3,4) non sono un punto di "k" nel mondo: lì
    // sotto c'è soltanto il suo bisnonno "g"... anzi nemmeno lui, "g" parte a
    // (100,50). Un hit-test rimasto piatto risponderebbe "k".
    expect(hitTest(s, 5, 6)).toBeNull();
  });

  it("returns the innermost node: a child is drawn above its container", () => {
    const s = nestedScene();
    // (120, 80) sta dentro g, dentro h, e dentro k: vince il più interno.
    expect(hitTest(s, 120, 80)).toBe("k");
    // Dentro g e h ma fuori da k (k finisce a x=163).
    expect(hitTest(s, 200, 100)).toBe("h");
    // Solo dentro g (h finisce a x=310 nel mondo).
    expect(hitTest(s, 400, 100)).toBe("g");
  });

  it("orders across containers by the tree, not by a flat orderKey comparison", () => {
    const s = emptyScene("d", "n");
    // Due contenitori sovrapposti: "sotto" ha l'orderKey minore, quindi il suo
    // sottoalbero sta TUTTO sotto quello di "sopra" -- anche se il figlio di
    // "sotto" ha l'orderKey più grande di tutti.
    s.nodes["sotto"] = childRect("sotto", "page1", 0, 0, "a0", { width: 200, height: 200 });
    s.nodes["sopra"] = childRect("sopra", "page1", 0, 0, "a1", { width: 200, height: 200 });
    s.nodes["figlioSotto"] = childRect("figlioSotto", "sotto", 0, 0, "z9");
    s.nodes["figlioSopra"] = childRect("figlioSopra", "sopra", 0, 0, "a0");
    expect(hitTest(s, 25, 25)).toBe("figlioSopra");
  });

  it("skips the whole subtree of an invisible container", () => {
    const s = nestedScene();
    s.nodes["h"] = { ...s.nodes["h"], visible: false };
    // "k" è visibile ma sta dentro un contenitore nascosto: non si disegna,
    // quindi non si clicca. Sotto resta "g", che è visibile.
    expect(hitTest(s, 138, 99)).toBe("g");
  });

  it("ignores a node whose parent does not exist (unreachable from any page)", () => {
    const s = emptyScene("d", "n");
    s.nodes["orfano"] = childRect("orfano", "sparito", 0, 0, "a0");
    expect(hitTest(s, 25, 25)).toBeNull();
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
//
// Il finto ctx tiene la TRASLAZIONE corrente con una pila per save/restore, che
// è esattamente ciò che drawScene applica scendendo l'albero: le coordinate
// registrate in `fillText` sono quindi quelle MONDO (i test usano la camera
// identità), non quelle locali del nodo. Senza questo, un annidamento
// sbagliato passerebbe inosservato -- il testo verrebbe registrato con le sue
// coordinate locali in ogni caso.
function fakeCtx() {
  const fillText: { text: string; x: number; y: number }[] = [];
  const fills: unknown[] = [];
  let cur = { x: 0, y: 0 };
  const stack: { x: number; y: number }[] = [];
  const ctx = {
    canvas: { width: 800, height: 600 },
    font: "", textBaseline: "", textAlign: "", fillStyle: "", globalAlpha: 1,
    // La camera: i test la passano identità, quindi ignorarla qui lascia le
    // coordinate registrate in unità mondo.
    setTransform: () => {},
    save: () => { stack.push(cur); },
    restore: () => { cur = stack.pop() ?? { x: 0, y: 0 }; },
    transform: (a: number, b: number, c: number, d: number, e: number, f: number) => {
      // Solo traslazioni, per ora: se un giorno arrivasse una scala o una
      // rotazione questo finto ctx andrebbe reso una matrice vera.
      cur = { x: cur.x + e, y: cur.y + f };
      void a; void b; void c; void d;
    },
    clearRect: () => {},
    measureText: (s: string) => ({ width: s.length * 10 }),
    fillText: (t: string, x: number, y: number) => { fillText.push({ text: t, x: cur.x + x, y: cur.y + y }); },
    fill: (p: unknown) => { fills.push(p); },
  };
  return {
    ctx: ctx as unknown as CanvasRenderingContext2D,
    fillText,
    fills,
    // Quanti save() non hanno ancora ricevuto il loro restore().
    open: () => stack.length,
  };
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

// Un nodo testo con fontSize 16 e lineHeight non specificato: interlinea
// 16*1.2 = 19.2 e ascent (19.2-16)/2 + 16*0.8 = 14.4 (vedi renderer/text.ts).
// La baseline della prima riga cade quindi a y + 14.4.
const ASCENT = 14.4;
const identityCam = { x: 0, y: 0, zoom: 1 } as Camera;

function textAt(id: string, parentId: string, x: number, y: number, order = "a0", over: Partial<NodeLite> = {}): NodeLite {
  return { ...textNode(), id, parentId, orderKey: order, x, y, name: id,
    text: { content: id, style: { fontFamily: "", fontSize: 16, fontWeight: "", lineHeight: 0, align: "left" } }, ...over };
}

describe("drawScene with nesting", () => {
  it("draws a container BEFORE its children, and the child at its world position", () => {
    const s = emptyScene("d", "n");
    s.nodes["P"] = textAt("P", "page1", 100, 50);
    s.nodes["C"] = textAt("C", "P", 3, 4);
    const f = fakeCtx();
    drawScene(f.ctx, s, identityCam);
    expect(f.fillText).toEqual([
      { text: "P", x: 100, y: 50 + ASCENT },
      // (3,4) è RELATIVO a P: nel mondo cade a (103, 54).
      { text: "C", x: 103, y: 54 + ASCENT },
    ]);
  });

  it("accumulates the transform three levels deep", () => {
    const s = emptyScene("d", "n");
    s.nodes["P"] = textAt("P", "page1", 100, 50);
    s.nodes["Q"] = textAt("Q", "P", 10, 20);
    s.nodes["R"] = textAt("R", "Q", 3, 4);
    const f = fakeCtx();
    drawScene(f.ctx, s, identityCam);
    expect(f.fillText.map((c) => [c.text, c.x, c.y])).toEqual([
      ["P", 100, 50 + ASCENT],
      ["Q", 110, 70 + ASCENT],
      ["R", 113, 74 + ASCENT],
    ]);
  });

  it("draws the children of a container in orderKey order", () => {
    const s = emptyScene("d", "n");
    s.nodes["P"] = textAt("P", "page1", 0, 0);
    s.nodes["b"] = textAt("b", "P", 0, 0, "a2");
    s.nodes["a"] = textAt("a", "P", 0, 0, "a1");
    const f = fakeCtx();
    drawScene(f.ctx, s, identityCam);
    expect(f.fillText.map((c) => c.text)).toEqual(["P", "a", "b"]);
  });

  it("descends into a container with a degenerate box (a group has no box of its own)", () => {
    // Il guard sulla dimensione salta il DISEGNO del contenitore, non la
    // discesa: un gruppo (traccia 1, task 3) non ha nulla da riempire ma i suoi
    // figli devono comparire, e alla loro posizione mondo.
    const s = emptyScene("d", "n");
    s.nodes["g"] = { ...rect("g", 100, 50, "a0"), width: 0, height: 0 };
    s.nodes["C"] = textAt("C", "g", 3, 4);
    const f = fakeCtx();
    drawScene(f.ctx, s, identityCam);
    expect(f.fills).toEqual([]); // niente Path2D per il contenitore degenere
    expect(f.fillText).toEqual([{ text: "C", x: 103, y: 54 + ASCENT }]);
  });

  it("hides the whole subtree of an invisible container", () => {
    const s = emptyScene("d", "n");
    s.nodes["P"] = textAt("P", "page1", 0, 0, "a0", { visible: false });
    s.nodes["C"] = textAt("C", "P", 3, 4);
    const f = fakeCtx();
    drawScene(f.ctx, s, identityCam);
    expect(f.fillText).toEqual([]);
  });

  it("does not draw a node unreachable from any page", () => {
    const s = emptyScene("d", "n");
    s.nodes["orfano"] = textAt("orfano", "sparito", 0, 0);
    const f = fakeCtx();
    drawScene(f.ctx, s, identityCam);
    expect(f.fillText).toEqual([]);
  });

  it("leaves the ctx transform stack balanced", () => {
    const s = emptyScene("d", "n");
    s.nodes["P"] = textAt("P", "page1", 100, 50);
    s.nodes["Q"] = textAt("Q", "P", 10, 20);
    s.nodes["R"] = textAt("R", "Q", 3, 4);
    const f = fakeCtx();
    drawScene(f.ctx, s, identityCam);
    expect(f.open()).toBe(0);
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
