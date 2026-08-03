import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { hitTest, nodesIntersecting, resizeCanvasToDisplaySize, drawScene } from "./canvasRenderer";
import type { Camera } from "../canvas/camera";
import { emptyScene } from "../store/types";
import type { NodeLite, SceneState } from "../store/types";

// jsdom non ha Path2D: lo stub registra le sub-path costruite (rect/roundRect/
// ellipse) così un test può leggere COSA è stato disegnato o ritagliato senza
// un canvas vero. Va installato con vi.stubGlobal PRIMA di una drawScene che
// tocchi nodePath (una scena di solo testo non lo tocca).
class FakePath2D {
  ops: { op: string; args: number[] }[] = [];
  rect(x: number, y: number, w: number, h: number): void { this.ops.push({ op: "rect", args: [x, y, w, h] }); }
  roundRect(x: number, y: number, w: number, h: number, r: number): void { this.ops.push({ op: "roundRect", args: [x, y, w, h, r] }); }
  ellipse(cx: number, cy: number, rx: number, ry: number): void { this.ops.push({ op: "ellipse", args: [cx, cy, rx, ry] }); }
}

function frameNode(id: string, parentId: string, x: number, y: number, w: number, h: number, clips: boolean, order = "a0"): NodeLite {
  return { id, parentId, orderKey: order, name: id, visible: true, opacity: 1,
    x, y, width: w, height: h, rotation: 0, fills: [{ r: 0.9, g: 0.9, b: 0.9, a: 1 }],
    kind: "frame", cornerRadius: 0, clipsContent: clips };
}

// Duck-typed stand-in for HTMLCanvasElement: resizeCanvasToDisplaySize only
// touches clientWidth/clientHeight/width/height, so a plain object is enough
// to test it under Node without a DOM (there is no jsdom/canvas setup here).
function fakeCanvas(clientWidth: number, clientHeight: number, width = 0, height = 0) {
  return { clientWidth, clientHeight, width, height } as unknown as HTMLCanvasElement;
}

function rect(id: string, x: number, y: number, order: string, visible = true): NodeLite {
  return { id, parentId: "page1", orderKey: order, name: id, visible, opacity: 1,
    x, y, width: 50, height: 50, rotation: 0, fills: [{ r: 0, g: 0, b: 0, a: 1 }], kind: "rect", cornerRadius: 0, clipsContent: false };
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

  // Un gruppo non è mai la risposta dell'hit-test: non ha geometria propria e
  // non disegna niente, quindi non c'è nessun pixel suo sotto il puntatore. Che
  // il CLICK poi selezioni il gruppo è una politica di selezione
  // (store/groups.ts), e sta là apposta.
  it("never returns a group: it returns the child, and nothing in the empty space between children", () => {
    const s = emptyScene("d", "n");
    s.nodes["g"] = { ...childRect("g", "page1", 0, 0, "a0"), kind: "group", width: 400, height: 400 };
    s.nodes["c"] = childRect("c", "g", 10, 10, "a0");
    expect(hitTest(s, 25, 25)).toBe("c");
    // Dentro l'unione dei figli ma su nessun figlio: niente da selezionare.
    expect(hitTest(s, 300, 300)).toBeNull();
  });
});

// VEDI-vs-SELEZIONA per un FRAME, lato hit-test. Un frame si colpisce sul
// PROPRIO box (cliccare il vuoto = selezionare il frame), e -- se clipsContent
// -- un punto sulla parte RITAGLIATA VIA di un figlio non colpisce il figlio,
// esattamente come lì non si disegna. Senza clip il figlio sporge e si clicca.
describe("hitTest with a frame", () => {
  // Frame F (0,0 100x100) con un figlio C (local 80,80 50x50): C sporge oltre
  // il bordo destro/basso del frame (il suo box mondo arriva a 130,130, il
  // frame finisce a 100,100).
  function framed(clips: boolean): SceneState {
    const s = emptyScene("d", "n");
    s.nodes["F"] = frameNode("F", "page1", 0, 0, 100, 100, clips);
    s.nodes["C"] = childRect("C", "F", 80, 80, "a0");
    return s;
  }

  it("clicking the empty body of a frame selects the FRAME (artboard convention)", () => {
    expect(hitTest(framed(true), 10, 10)).toBe("F");
  });

  it("clicking a child inside the frame selects the child, not the frame", () => {
    expect(hitTest(framed(true), 90, 90)).toBe("C");
  });

  it("does NOT hit a child on the part the frame clips away", () => {
    // (120,120) sta sul figlio ma FUORI dal box del frame: il clip lo nasconde,
    // e lì non c'è nemmeno il frame -- quindi niente.
    expect(hitTest(framed(true), 120, 120)).toBeNull();
  });

  it("DOES hit the overflowing child when the frame does not clip", () => {
    // Stesso punto, ma senza clip il figlio sporge e si vede: si clicca.
    expect(hitTest(framed(false), 120, 120)).toBe("C");
  });
});

// La terza domanda sulla stessa discesa (la prima è "disegna", la seconda
// "cosa c'è sotto il puntatore"): "cosa c'è dentro questo rettangolo mondo".
// Deve rispondere con gli stessi nodi delle altre due, altrimenti il marquee
// seleziona ciò che non si vede.
describe("nodesIntersecting", () => {
  it("returns the visible nodes whose WORLD box intersects, in draw order", () => {
    const s = nestedScene();
    // Il box mondo di "k" è (113,74)-(163,124): un rettangolo attorno al suo
    // angolo prende k, e con lui gli antenati che lo contengono.
    expect(nodesIntersecting(s, { x: 105, y: 70, width: 20, height: 20 })).toEqual(["g", "h", "k"]);
    // Le coordinate LOCALI di "k" (3,4) non sono un suo punto nel mondo.
    expect(nodesIntersecting(s, { x: 0, y: 0, width: 10, height: 10 })).toEqual([]);
  });

  it("skips the whole subtree of an invisible container", () => {
    const s = nestedScene();
    s.nodes["h"] = { ...s.nodes["h"], visible: false };
    // "k" ha visible: true, ma sta dentro un contenitore nascosto: non si
    // disegna, quindi non si può nemmeno selezionare col marquee -- resta "g".
    // Un filtro piatto su n.visible risponderebbe ["g", "k"].
    expect(nodesIntersecting(s, { x: 105, y: 70, width: 20, height: 20 })).toEqual(["g"]);
  });

  it("ignores a node unreachable from any page", () => {
    const s = emptyScene("d", "n");
    s.nodes["orfano"] = childRect("orfano", "sparito", 0, 0, "a0");
    expect(nodesIntersecting(s, { x: 0, y: 0, width: 100, height: 100 })).toEqual([]);
  });

  it("keeps descending when a container's own box misses the rectangle", () => {
    // Il box di un gruppo è il SUO, non l'unione dei figli: potare la discesa
    // sull'intersezione del container perderebbe un figlio che sta dentro il
    // marquee mentre il suo container ne sta fuori.
    const s = emptyScene("d", "n");
    s.nodes["g"] = childRect("g", "page1", 0, 0, "a0", { width: 10, height: 10 });
    s.nodes["c"] = childRect("c", "g", 500, 500, "a0");
    expect(nodesIntersecting(s, { x: 490, y: 490, width: 30, height: 30 })).toEqual(["c"]);
  });

  it("excludes a node that only touches the rectangle at an edge", () => {
    const s = emptyScene("d", "n");
    s.nodes["a"] = rect("a", 50, 0, "a0"); // 50x50 -> (50,0)-(100,50)
    expect(nodesIntersecting(s, { x: 0, y: 0, width: 50, height: 50 })).toEqual([]);
  });

  // La stessa regola di hitTest, dall'altro lato: un gruppo non si disegna,
  // quindi non lo si può nemmeno prendere col marquee. Il suo box NON è la sua
  // cornice, e alla creazione è 0x0 sull'origine del parent: senza il ramo
  // esplicito una banda attorno all'origine lo prenderebbe -- boundsIntersect
  // confronta bordi opposti con < / >, e un box degenere STRETTAMENTE dentro la
  // banda interseca. A metterlo in selezione ci pensa la politica
  // (store/groups.ts::selectionTargetsOf) partendo dai figli.
  it("never returns a group: its degenerate box at the parent origin is not a frame", () => {
    const s = emptyScene("d", "n");
    s.nodes["g"] = { ...childRect("g", "page1", 0, 0, "a0"), kind: "group", width: 0, height: 0 };
    s.nodes["c"] = childRect("c", "g", 100, 100, "a0"); // 50x50 -> (100,100)-(150,150)
    // Una banda attorno all'origine: il contenuto del gruppo è 100px fuori.
    expect(nodesIntersecting(s, { x: -5, y: -5, width: 10, height: 10 })).toEqual([]);
    // E quando la banda prende il figlio, la risposta è il FIGLIO: il gruppo lo
    // aggiunge selectionTargetsOf, non questa discesa.
    expect(nodesIntersecting(s, { x: 90, y: 90, width: 30, height: 30 })).toEqual(["c"]);
  });

  it("never returns a group even when it carries a non-zero box", () => {
    // width/height su un gruppo non li scrive nessun gesto, ma possono arrivare
    // da un documento di un'altra versione: il ramo è sul KIND, non sul box
    // degenere, esattamente come in drawNode e in hitTestNode.
    const s = emptyScene("d", "n");
    s.nodes["g"] = { ...childRect("g", "page1", 0, 0, "a0"), kind: "group", width: 400, height: 400 };
    s.nodes["c"] = childRect("c", "g", 300, 300, "a0");
    expect(nodesIntersecting(s, { x: 10, y: 10, width: 20, height: 20 })).toEqual([]);
    expect(nodesIntersecting(s, { x: 310, y: 310, width: 20, height: 20 })).toEqual(["c"]);
  });
});

// VEDI-vs-SELEZIONA per un FRAME, lato marquee. La banda prende il frame sul
// suo box (come un rettangolo); e -- se clipsContent -- NON prende un figlio
// nell'area che il frame ritaglia via, perché lì il figlio non si vede. Senza
// clip il figlio sporge e la banda lo prende.
describe("nodesIntersecting with a frame", () => {
  function framed(clips: boolean): SceneState {
    const s = emptyScene("d", "n");
    s.nodes["F"] = frameNode("F", "page1", 0, 0, 100, 100, clips);
    s.nodes["C"] = childRect("C", "F", 80, 80, "a0"); // box mondo (80,80)-(130,130)
    return s;
  }

  it("takes the frame on its own box, and a child on its visible (in-frame) part", () => {
    // Banda (85,85)-(95,95): dentro il frame e sulla parte visibile di C.
    expect(nodesIntersecting(framed(true), { x: 85, y: 85, width: 10, height: 10 })).toEqual(["F", "C"]);
  });

  it("does NOT take a child through the area the frame clips away", () => {
    // Banda (110,110)-(120,120): tutta oltre il bordo del frame, sul pezzo di C
    // ritagliato via. Non prende C (clip) né F (la banda è fuori dal suo box).
    expect(nodesIntersecting(framed(true), { x: 110, y: 110, width: 10, height: 10 })).toEqual([]);
  });

  it("takes the overflowing child there when the frame does not clip", () => {
    // Stessa banda: senza clip il pezzo di C che sporge si vede, e si prende.
    expect(nodesIntersecting(framed(false), { x: 110, y: 110, width: 10, height: 10 })).toEqual(["C"]);
  });
});

function textNode(over: Partial<NodeLite> = {}): NodeLite {
  return { id: "t", parentId: "page1", orderKey: "a1", name: "Text", visible: true, opacity: 1,
    x: 10, y: 20, width: 200, height: 40, rotation: 0, fills: [{ r: 0, g: 0, b: 0, a: 1 }],
    kind: "text", cornerRadius: 0, clipsContent: false,
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
  const clips: unknown[] = [];
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
    // Il clip di un frame: si registra la sub-path ricevuta (uno stub FakePath2D
    // con le sue ops) così il test può leggere il box a cui il frame ritaglia.
    clip: (p: unknown) => { clips.push(p); },
  };
  return {
    ctx: ctx as unknown as CanvasRenderingContext2D,
    fillText,
    fills,
    clips,
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

  // Il test qui sopra copre il contenitore DEGENERE; un gruppo non si disegna
  // MAI, nemmeno con un box addosso -- non ha geometria propria (i suoi bounds
  // sono l'unione dei figli, vedi store/groups.ts). Senza il ramo esplicito
  // comparirebbe un rettangolo pieno che l'utente non ha mai disegnato.
  it("never fills a group, whatever box it carries, but draws its children", () => {
    const s = emptyScene("d", "n");
    s.nodes["g"] = { ...rect("g", 100, 50, "a0"), kind: "group", width: 400, height: 400 };
    s.nodes["C"] = textAt("C", "g", 3, 4);
    const f = fakeCtx();
    drawScene(f.ctx, s, identityCam);
    expect(f.fills).toEqual([]);
    expect(f.fillText).toEqual([{ text: "C", x: 103, y: 54 + ASCENT }]);
  });

  it("hides the whole subtree of an invisible group, like any other container", () => {
    const s = emptyScene("d", "n");
    s.nodes["g"] = { ...rect("g", 0, 0, "a0"), kind: "group", visible: false };
    s.nodes["C"] = textAt("C", "g", 3, 4);
    const f = fakeCtx();
    drawScene(f.ctx, s, identityCam);
    expect(f.fillText).toEqual([]);
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

// UN FRAME SI DISEGNA (a differenza del gruppo): il suo box riempito coi suoi
// fills, PRIMA dei figli (è lo sfondo dell'artboard). Se clipsContent, i figli
// sono ritagliati al box del frame -- nello STESSO spazio locale in cui sono
// disegnati (l'origine del frame è l'origine dei figli), quindi il box del clip
// è (0,0,width,height).
describe("drawScene with a frame", () => {
  beforeEach(() => { vi.stubGlobal("Path2D", FakePath2D); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("fills the frame's box (at its parent-space position) and still draws its children", () => {
    const s = emptyScene("d", "n");
    s.nodes["F"] = frameNode("F", "page1", 20, 30, 100, 80, true);
    s.nodes["C"] = textAt("C", "F", 5, 5);
    const f = fakeCtx();
    drawScene(f.ctx, s, identityCam);
    // Il box del frame è riempito (una sola fill: il testo non passa da fill).
    expect(f.fills.length).toBe(1);
    expect((f.fills[0] as FakePath2D).ops).toEqual([{ op: "rect", args: [20, 30, 100, 80] }]);
    // E i figli si disegnano comunque, alla loro posizione mondo (dentro F).
    expect(f.fillText.map((c) => c.text)).toEqual(["C"]);
  });

  it("draws a plain rect even if the frame carries a corner radius: a frame is rectangular", () => {
    const s = emptyScene("d", "n");
    s.nodes["F"] = { ...frameNode("F", "page1", 0, 0, 100, 80, false), cornerRadius: 40 };
    const f = fakeCtx();
    drawScene(f.ctx, s, identityCam);
    expect((f.fills[0] as FakePath2D).ops).toEqual([{ op: "rect", args: [0, 0, 100, 80] }]);
  });

  it("clips its children to its OWN local box when clipsContent", () => {
    const s = emptyScene("d", "n");
    s.nodes["F"] = frameNode("F", "page1", 20, 30, 100, 80, true);
    s.nodes["C"] = textAt("C", "F", 5, 5);
    const f = fakeCtx();
    drawScene(f.ctx, s, identityCam);
    // Il clip è al box LOCALE (0,0,w,h) -- lo spazio dei figli -- non alla x/y
    // del frame nel parent.
    expect(f.clips.length).toBe(1);
    expect((f.clips[0] as FakePath2D).ops).toEqual([{ op: "rect", args: [0, 0, 100, 80] }]);
  });

  it("does NOT clip when clipsContent is false: the children may overflow", () => {
    const s = emptyScene("d", "n");
    s.nodes["F"] = frameNode("F", "page1", 20, 30, 100, 80, false);
    s.nodes["C"] = textAt("C", "F", 5, 5);
    const f = fakeCtx();
    drawScene(f.ctx, s, identityCam);
    expect(f.clips.length).toBe(0);
    expect(f.fillText.map((c) => c.text)).toEqual(["C"]); // comunque disegnati
  });

  it("does not clip for a childless clipping frame (nothing to clip)", () => {
    const s = emptyScene("d", "n");
    s.nodes["F"] = frameNode("F", "page1", 0, 0, 100, 80, true);
    const f = fakeCtx();
    drawScene(f.ctx, s, identityCam);
    expect(f.clips.length).toBe(0);
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
