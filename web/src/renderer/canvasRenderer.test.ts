import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { hitTest, nodesIntersecting, resizeCanvasToDisplaySize, drawScene } from "./canvasRenderer";
import type { CachedImage } from "./imageCache";
import { VECTOR_STROKE_PX } from "./shapes";
import type { Camera } from "../canvas/camera";
import { emptyScene } from "../store/types";
import type { FillLite, NodeLite, SceneState, AnchorLite, SubPathLite } from "../store/types";

function frameNode(id: string, parentId: string, x: number, y: number, w: number, h: number, clips: boolean, order = "a0"): NodeLite {
  return { id, parentId, orderKey: order, name: id, visible: true, opacity: 1,
    x, y, width: w, height: h, rotation: 0, fills: [{ r: 0.9, g: 0.9, b: 0.9, a: 1 }],
    strokes: [], kind: "frame", cornerRadius: 0, clipsContent: clips };
}

// Duck-typed stand-in for HTMLCanvasElement: resizeCanvasToDisplaySize only
// touches clientWidth/clientHeight/width/height, so a plain object is enough
// to test it under Node without a DOM (there is no jsdom/canvas setup here).
function fakeCanvas(clientWidth: number, clientHeight: number, width = 0, height = 0) {
  return { clientWidth, clientHeight, width, height } as unknown as HTMLCanvasElement;
}

function rect(id: string, x: number, y: number, order: string, visible = true): NodeLite {
  return { id, parentId: "page1", orderKey: order, name: id, visible, opacity: 1,
    x, y, width: 50, height: 50, rotation: 0, fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [],
    kind: "rect", cornerRadius: 0, clipsContent: false };
}

function childRect(id: string, parentId: string, x: number, y: number, order: string, over: Partial<NodeLite> = {}): NodeLite {
  return { ...rect(id, x, y, order), parentId, ...over };
}

function anchor(a: Partial<AnchorLite>): AnchorLite {
  return { x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0, ...a };
}

// Path2D finto: jsdom non ce l'ha. Registra le primitive chiamate, così un test
// può dire non solo "ha ritagliato/tracciato" ma "con QUESTA forma". Superset
// che serve sia al tratto (rect/roundRect/ellipse/addPath) sia al vettoriale
// (moveTo/lineTo/bezierCurveTo/closePath): la forma esatta di un path
// vettoriale è comunque provata in shapes.test.ts, qui interessa QUALE path
// finisce in fill e quale in stroke.
class FakePath2D {
  ops: { op: string; args: unknown[] }[] = [];
  rect(...args: number[]) { this.ops.push({ op: "rect", args }); }
  roundRect(...args: unknown[]) { this.ops.push({ op: "roundRect", args }); }
  ellipse(...args: number[]) { this.ops.push({ op: "ellipse", args }); }
  addPath(p: unknown) { this.ops.push({ op: "addPath", args: [p] }); }
  moveTo(...args: number[]) { this.ops.push({ op: "moveTo", args }); }
  lineTo(...args: number[]) { this.ops.push({ op: "lineTo", args }); }
  bezierCurveTo(...args: number[]) { this.ops.push({ op: "bezierCurveTo", args }); }
  closePath() { this.ops.push({ op: "closePath", args: [] }); }
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
    s.nodes = s.nodes.set("a", rect("a", 0, 0, "a0"));
    s.nodes = s.nodes.set("b", rect("b", 10, 10, "a1")); // sopra (orderKey maggiore)
    expect(hitTest(s, 25, 25, Z1)).toBe("b");
    expect(hitTest(s, 5, 5, Z1)).toBe("a");
    expect(hitTest(s, 200, 200, Z1)).toBeNull();
  });

  it("returns the topmost node by orderKey when two nodes overlap", () => {
    const s = emptyScene("d", "n");
    // Stesso rettangolo esattamente sovrapposto: "b" ha orderKey maggiore quindi vince.
    s.nodes = s.nodes.set("a", rect("a", 0, 0, "a0"));
    s.nodes = s.nodes.set("b", rect("b", 0, 0, "a1"));
    expect(hitTest(s, 25, 25, Z1)).toBe("b");
  });

  it("skips invisible nodes", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("a", rect("a", 0, 0, "a0", false)); // visible: false, in cima per orderKey
    s.nodes = s.nodes.set("b", rect("b", 0, 0, "a-1", true)); // sotto, ma visibile
    // "a" ha orderKey maggiore ma non è visibile: non deve mai essere ritornato.
    expect(hitTest(s, 25, 25, Z1)).toBe("b");

    const onlyInvisible = emptyScene("d", "n");
    onlyInvisible.nodes = onlyInvisible.nodes.set("a", rect("a", 0, 0, "a0", false));
    expect(hitTest(onlyInvisible, 25, 25, Z1)).toBeNull();
  });

  it("porta lo ZOOM fino alla tolleranza di presa del vettoriale", () => {
    // Il tramite: senza, un path si afferrerebbe a distanze diverse a seconda
    // dello zoom, e a zoom alto diventerebbe quasi impossibile da cliccare.
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("v", vectorNode("v", [{
      anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 100, y: 0 })], closed: false,
    }], { width: 100, height: 0 }));
    expect(hitTest(s, 50, 3, 1)).toBe("v");     // 3 unità mondo = 3 px
    expect(hitTest(s, 50, 3, 4)).toBeNull();    // 3 unità mondo = 12 px
    expect(hitTest(s, 50, 12, 0.25)).toBe("v"); // 12 unità mondo = 3 px
  });

  it("un vettoriale APERTO non ruba i click alle forme che gli stanno dentro", () => {
    // Il rettangolo sotto e, sopra, tre lati di un quadrato che lo circondano
    // senza chiudersi. Cliccare al centro deve prendere il rettangolo: il
    // contorno aperto lì non ha inchiostro.
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("r", rect("r", 0, 0, "a0"));
    s.nodes = s.nodes.set("v", vectorNode("v", [{
      anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 0, y: 50 }),
        anchor({ x: 50, y: 50 }), anchor({ x: 50, y: 0 })],
      closed: false,
    }], { orderKey: "a1" }));
    expect(hitTest(s, 25, 25, Z1)).toBe("r");
    expect(hitTest(s, 25, 49, Z1)).toBe("v");  // sul lato, dove l'inchiostro c'è
  });
});

// page1 > g(100,50) > h(10,20) > k(3,4): tre livelli, ogni livello con uno
// scostamento diverso da zero su entrambi gli assi. In coordinate MONDO
// l'angolo di "k" cade a (113,74) e il suo box 50x50 arriva a (163,124).
function nestedScene() {
  const s = emptyScene("d", "n");
  s.nodes = s.nodes.set("g", childRect("g", "page1", 100, 50, "a0", { width: 400, height: 400 }));
  s.nodes = s.nodes.set("h", childRect("h", "g", 10, 20, "a0", { width: 200, height: 200 }));
  s.nodes = s.nodes.set("k", childRect("k", "h", 3, 4, "a0"));
  return s;
}

describe("hitTest with nesting", () => {
  it("finds a nested node at its WORLD position, not at its local one", () => {
    const s = nestedScene();
    // Il centro di "k" in coordinate mondo: 113+25, 74+25.
    expect(hitTest(s, 138, 99, Z1)).toBe("k");
    // Le sue coordinate LOCALI (3,4) non sono un punto di "k" nel mondo: lì
    // sotto c'è soltanto il suo bisnonno "g"... anzi nemmeno lui, "g" parte a
    // (100,50). Un hit-test rimasto piatto risponderebbe "k".
    expect(hitTest(s, 5, 6, Z1)).toBeNull();
  });

  it("returns the innermost node: a child is drawn above its container", () => {
    const s = nestedScene();
    // (120, 80) sta dentro g, dentro h, e dentro k: vince il più interno.
    expect(hitTest(s, 120, 80, Z1)).toBe("k");
    // Dentro g e h ma fuori da k (k finisce a x=163).
    expect(hitTest(s, 200, 100, Z1)).toBe("h");
    // Solo dentro g (h finisce a x=310 nel mondo).
    expect(hitTest(s, 400, 100, Z1)).toBe("g");
  });

  it("orders across containers by the tree, not by a flat orderKey comparison", () => {
    const s = emptyScene("d", "n");
    // Due contenitori sovrapposti: "sotto" ha l'orderKey minore, quindi il suo
    // sottoalbero sta TUTTO sotto quello di "sopra" -- anche se il figlio di
    // "sotto" ha l'orderKey più grande di tutti.
    s.nodes = s.nodes.set("sotto", childRect("sotto", "page1", 0, 0, "a0", { width: 200, height: 200 }));
    s.nodes = s.nodes.set("sopra", childRect("sopra", "page1", 0, 0, "a1", { width: 200, height: 200 }));
    s.nodes = s.nodes.set("figlioSotto", childRect("figlioSotto", "sotto", 0, 0, "z9"));
    s.nodes = s.nodes.set("figlioSopra", childRect("figlioSopra", "sopra", 0, 0, "a0"));
    expect(hitTest(s, 25, 25, Z1)).toBe("figlioSopra");
  });

  it("skips the whole subtree of an invisible container", () => {
    const s = nestedScene();
    s.nodes = s.nodes.set("h", { ...s.nodes.at("h"), visible: false });
    // "k" è visibile ma sta dentro un contenitore nascosto: non si disegna,
    // quindi non si clicca. Sotto resta "g", che è visibile.
    expect(hitTest(s, 138, 99, Z1)).toBe("g");
  });

  it("ignores a node whose parent does not exist (unreachable from any page)", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("orfano", childRect("orfano", "sparito", 0, 0, "a0"));
    expect(hitTest(s, 25, 25, Z1)).toBeNull();
  });

  // Un gruppo non è mai la risposta dell'hit-test: non ha geometria propria e
  // non disegna niente, quindi non c'è nessun pixel suo sotto il puntatore. Che
  // il CLICK poi selezioni il gruppo è una politica di selezione
  // (store/groups.ts), e sta là apposta.
  it("never returns a group: it returns the child, and nothing in the empty space between children", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("g", { ...childRect("g", "page1", 0, 0, "a0"), kind: "group", width: 400, height: 400 });
    s.nodes = s.nodes.set("c", childRect("c", "g", 10, 10, "a0"));
    expect(hitTest(s, 25, 25, Z1)).toBe("c");
    // Dentro l'unione dei figli ma su nessun figlio: niente da selezionare.
    expect(hitTest(s, 300, 300, Z1)).toBeNull();
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
    s.nodes = s.nodes.set("F", frameNode("F", "page1", 0, 0, 100, 100, clips));
    s.nodes = s.nodes.set("C", childRect("C", "F", 80, 80, "a0"));
    return s;
  }

  it("clicking the empty body of a frame selects the FRAME (artboard convention)", () => {
    expect(hitTest(framed(true), 10, 10, Z1)).toBe("F");
  });

  it("clicking a child inside the frame selects the child, not the frame", () => {
    expect(hitTest(framed(true), 90, 90, Z1)).toBe("C");
  });

  it("does NOT hit a child on the part the frame clips away", () => {
    // (120,120) sta sul figlio ma FUORI dal box del frame: il clip lo nasconde,
    // e lì non c'è nemmeno il frame -- quindi niente.
    expect(hitTest(framed(true), 120, 120, Z1)).toBeNull();
  });

  it("DOES hit the overflowing child when the frame does not clip", () => {
    // Stesso punto, ma senza clip il figlio sporge e si vede: si clicca.
    expect(hitTest(framed(false), 120, 120, Z1)).toBe("C");
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
    s.nodes = s.nodes.set("h", { ...s.nodes.at("h"), visible: false });
    // "k" ha visible: true, ma sta dentro un contenitore nascosto: non si
    // disegna, quindi non si può nemmeno selezionare col marquee -- resta "g".
    // Un filtro piatto su n.visible risponderebbe ["g", "k"].
    expect(nodesIntersecting(s, { x: 105, y: 70, width: 20, height: 20 })).toEqual(["g"]);
  });

  it("ignores a node unreachable from any page", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("orfano", childRect("orfano", "sparito", 0, 0, "a0"));
    expect(nodesIntersecting(s, { x: 0, y: 0, width: 100, height: 100 })).toEqual([]);
  });

  it("keeps descending when a container's own box misses the rectangle", () => {
    // Il box di un gruppo è il SUO, non l'unione dei figli: potare la discesa
    // sull'intersezione del container perderebbe un figlio che sta dentro il
    // marquee mentre il suo container ne sta fuori.
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("g", childRect("g", "page1", 0, 0, "a0", { width: 10, height: 10 }));
    s.nodes = s.nodes.set("c", childRect("c", "g", 500, 500, "a0"));
    expect(nodesIntersecting(s, { x: 490, y: 490, width: 30, height: 30 })).toEqual(["c"]);
  });

  it("excludes a node that only touches the rectangle at an edge", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("a", rect("a", 50, 0, "a0")); // 50x50 -> (50,0)-(100,50)
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
    s.nodes = s.nodes.set("g", { ...childRect("g", "page1", 0, 0, "a0"), kind: "group", width: 0, height: 0 });
    s.nodes = s.nodes.set("c", childRect("c", "g", 100, 100, "a0")); // 50x50 -> (100,100)-(150,150)
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
    s.nodes = s.nodes.set("g", { ...childRect("g", "page1", 0, 0, "a0"), kind: "group", width: 400, height: 400 });
    s.nodes = s.nodes.set("c", childRect("c", "g", 300, 300, "a0"));
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
    s.nodes = s.nodes.set("F", frameNode("F", "page1", 0, 0, 100, 100, clips));
    s.nodes = s.nodes.set("C", childRect("C", "F", 80, 80, "a0")); // box mondo (80,80)-(130,130)
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
    x: 10, y: 20, width: 200, height: 40, rotation: 0, fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [],
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
  const fills: { path: unknown; rule: unknown }[] = [];
  const strokes: { path: unknown; lineWidth: number; strokeStyle: string; cap: string }[] = [];
  const clips: unknown[] = [];
  // Le chiamate che compongono la trasformazione di un nodo RUOTATO, in ordine
  // (traccia 2): drawScene le emette solo attorno ai nodi con rotation != 0,
  // quindi una scena ferma deve lasciare questa lista vuota.
  const xform: { op: string; args: number[] }[] = [];
  // La traslazione corrente e la sua pila (traccia 1, annidamento): save/restore
  // e transform la muovono, così le coordinate registrate in fillText sono
  // quelle MONDO (i test usano la camera identità), non quelle locali del nodo.
  let cur = { x: 0, y: 0 };
  const stack: { x: number; y: number }[] = [];
  const ctx = {
    canvas: { width: 800, height: 600 },
    font: "", textBaseline: "", textAlign: "", fillStyle: "", globalAlpha: 1,
    strokeStyle: "", lineWidth: 0, lineCap: "", lineJoin: "",
    setTransform: () => {},
    clearRect: () => {},
    save: () => { stack.push(cur); xform.push({ op: "save", args: [] }); },
    restore: () => { cur = stack.pop() ?? { x: 0, y: 0 }; xform.push({ op: "restore", args: [] }); },
    translate: (x: number, y: number) => { cur = { x: cur.x + x, y: cur.y + y }; xform.push({ op: "translate", args: [x, y] }); },
    rotate: (r: number) => { xform.push({ op: "rotate", args: [r] }); },
    transform: (a: number, b: number, c: number, d: number, e: number, f: number) => {
      // La discesa nell'albero: solo traslazioni per ora (se arrivasse una scala
      // o una rotazione fra i container questo finto ctx andrebbe reso matrice).
      // NON entra in `xform`, che registra la sola rotazione dei nodi.
      cur = { x: cur.x + e, y: cur.y + f };
      void a; void b; void c; void d;
    },
    measureText: (s: string) => ({ width: s.length * 10 }),
    fillText: (t: string, x: number, y: number) => { fillText.push({ text: t, x: cur.x + x, y: cur.y + y }); },
    strokeText: () => {},
    fill: (p: unknown, rule?: unknown) => { fills.push({ path: p, rule }); },
    stroke: (p: unknown) => {
      strokes.push({ path: p, lineWidth: ctx.lineWidth, strokeStyle: ctx.strokeStyle, cap: ctx.lineCap });
    },
    // Il clip di un frame: si registra la sub-path ricevuta (uno stub FakePath2D
    // con le sue ops) così il test può leggere il box a cui il frame ritaglia.
    clip: (p: unknown) => { clips.push(p); },
  };
  return {
    ctx: ctx as unknown as CanvasRenderingContext2D,
    fillText,
    fills,
    strokes,
    clips,
    xform,
    // Quanti save() non hanno ancora ricevuto il loro restore().
    open: () => stack.length,
  };
}

describe("drawScene", () => {
  it("routes a text node to drawText instead of filling its box", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("t", textNode());
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
    s.nodes = s.nodes.set("t", textNode({ height: 0 }));
    const f = fakeCtx();
    drawScene(f.ctx, s, { x: 0, y: 0, zoom: 1 } as Camera);
    expect(f.fillText.map((c) => c.text)).toEqual(["hi"]);
  });

  it("skips an invisible text node", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("t", textNode({ visible: false }));
    const f = fakeCtx();
    drawScene(f.ctx, s, { x: 0, y: 0, zoom: 1 } as Camera);
    expect(f.fillText).toEqual([]);
  });

  // --- rotazione ------------------------------------------------------------
  // Il nodo si disegna sempre col suo path NON ruotato: a ruotare è il
  // CONTESTO, attorno al CENTRO del box (la convenzione di canvas/transform.ts).

  it("rotates a node about the CENTRE of its box, and undoes the transform after", () => {
    const s = emptyScene("d", "n");
    // box (10,20) 200x40 -> centro (110, 40)
    s.nodes = s.nodes.set("t", textNode({ rotation: 90 }));
    const f = fakeCtx();
    drawScene(f.ctx, s, { x: 0, y: 0, zoom: 1 } as Camera);

    expect(f.xform.map((e) => e.op)).toEqual(["save", "translate", "rotate", "translate", "restore"]);
    expect(f.xform[1].args).toEqual([110, 40]);
    expect(f.xform[2].args[0]).toBeCloseTo(Math.PI / 2, 12); // gradi -> radianti
    expect(f.xform[3].args).toEqual([-110, -40]);
    // e il nodo viene comunque disegnato, alle sue coordinate di sempre
    expect(f.fillText.map((c) => c.text)).toEqual(["hi"]);
  });

  it("emits no transform at all for an unrotated scene", () => {
    // Solo testo: nodePath (e quindi Path2D, che qui non esiste) non entra in
    // gioco -- stessa ragione per cui lo evitano i test qui sopra.
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("t", textNode());
    s.nodes = s.nodes.set("u", textNode({ id: "u", orderKey: "a2", rotation: 0 }));
    const f = fakeCtx();
    drawScene(f.ctx, s, { x: 0, y: 0, zoom: 1 } as Camera);
    expect(f.xform).toEqual([]);
  });
});

// --- il TRATTO -----------------------------------------------------------------
//
// Il canvas 2D sa tracciare SOLO centrato: INSIDE e OUTSIDE si ottengono
// raddoppiando la larghezza (così la metà che sopravvive è esattamente il peso
// chiesto) e RITAGLIANDO il lato che non serve. Questi test fissano le tre
// ricette, perché sono l'unico posto in cui "align" diventa qualcosa di
// osservabile sul canvas.

interface StrokeCall { path: unknown; lineWidth: number; strokeStyle: string }
interface ClipCall { path: unknown; rule?: string }

// Come fakeCtx, ma con quel che serve al tratto: stroke/clip/save/restore e i
// due attributi di stato letti al momento della chiamata (il ctx è stateful, e
// leggerli DOPO direbbe solo l'ultimo valore scritto).
function strokeCtx() {
  const fills: unknown[] = [];
  const strokes: StrokeCall[] = [];
  const clips: ClipCall[] = [];
  const strokeText: { text: string; x: number; y: number }[] = [];
  const order: string[] = [];
  const ctx = {
    canvas: { width: 800, height: 600 },
    font: "", textBaseline: "", textAlign: "",
    fillStyle: "", strokeStyle: "", lineWidth: 1, globalAlpha: 1,
    setTransform: () => {}, clearRect: () => {},
    save: () => { order.push("save"); },
    restore: () => { order.push("restore"); },
    translate: () => {}, rotate: () => {},
    measureText: (s: string) => ({ width: s.length * 10 }),
    fillText: () => { order.push("fillText"); },
    strokeText: (t: string, x: number, y: number) => {
      order.push("strokeText");
      strokeText.push({ text: t, x, y });
    },
    fill: (p: unknown) => { order.push("fill"); fills.push(p); },
    stroke: (p: unknown) => {
      order.push("stroke");
      strokes.push({ path: p, lineWidth: ctx.lineWidth, strokeStyle: ctx.strokeStyle });
    },
    clip: (p: unknown, rule?: string) => { order.push("clip"); clips.push({ path: p, rule }); },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, fills, strokes, clips, strokeText, order };
}

function strokedRect(over: Partial<NodeLite> = {}): NodeLite {
  return { ...rect("r", 0, 0, "a0"), ...over };
}

const RED: FillLite = { r: 1, g: 0, b: 0, a: 1 };

describe("drawScene: tratto", () => {
  beforeEach(() => { vi.stubGlobal("Path2D", FakePath2D); });
  afterEach(() => { vi.unstubAllGlobals(); });

  function sceneWith(n: NodeLite) {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set(n.id, n);
    return s;
  }

  it("un nodo SENZA tratti non traccia niente e non ritaglia niente", () => {
    const f = strokeCtx();
    drawScene(f.ctx, sceneWith(strokedRect()), { x: 0, y: 0, zoom: 1 } as Camera);
    expect(f.strokes).toEqual([]);
    expect(f.clips).toEqual([]);
    expect(f.order).toEqual(["fill"]);
  });

  it("CENTER: traccia lo STESSO path del riempimento, con lineWidth = peso, dopo il fill", () => {
    const f = strokeCtx();
    const n = strokedRect({ strokes: [{ color: RED, weight: 6, align: "center" }] });
    drawScene(f.ctx, sceneWith(n), { x: 0, y: 0, zoom: 1 } as Camera);

    expect(f.strokes).toHaveLength(1);
    // LO STESSO oggetto: il tratto segue la geometria del riempimento per
    // costruzione, non per una seconda costruzione destinata a divergere.
    expect(f.strokes[0].path).toBe(f.fills[0]);
    expect(f.strokes[0].lineWidth).toBe(6);
    expect(f.strokes[0].strokeStyle).toBe("rgba(255, 0, 0, 1)");
    // Il tratto sta SOPRA il riempimento, come in ogni editor.
    expect(f.order).toEqual(["fill", "stroke"]);
    // Nessun clip: il centrato è l'unico che il canvas sa fare da solo.
    expect(f.clips).toEqual([]);
  });

  it("INSIDE: ritaglia DENTRO la forma e raddoppia la larghezza", () => {
    const f = strokeCtx();
    const n = strokedRect({ strokes: [{ color: RED, weight: 6, align: "inside" }] });
    drawScene(f.ctx, sceneWith(n), { x: 0, y: 0, zoom: 1 } as Camera);

    expect(f.clips).toHaveLength(1);
    // Il clip è il path della forma stessa, senza regola di riempimento.
    expect(f.clips[0].path).toBe(f.fills[0]);
    expect(f.clips[0].rule).toBeUndefined();
    // 12 e non 6: metà cade fuori e viene ritagliata, la metà che resta DENTRO
    // è esattamente il peso chiesto.
    expect(f.strokes[0].lineWidth).toBe(12);
    // E il clip è confinato in un save/restore: non deve sopravvivere al nodo.
    expect(f.order).toEqual(["fill", "save", "clip", "stroke", "restore"]);
  });

  it("OUTSIDE: ritaglia il COMPLEMENTO della forma (evenodd) e raddoppia la larghezza", () => {
    const f = strokeCtx();
    const n = strokedRect({ strokes: [{ color: RED, weight: 6, align: "outside" }] });
    drawScene(f.ctx, sceneWith(n), { x: 0, y: 0, zoom: 1 } as Camera);

    expect(f.clips).toHaveLength(1);
    expect(f.clips[0].rule).toBe("evenodd");
    const clip = f.clips[0].path as FakePath2D;
    // Un rettangolo che copre tutta la fascia esterna PIÙ la forma: con
    // evenodd, i punti dentro la forma attraversano due bordi (pari) e restano
    // FUORI dal clip. È il complemento, senza dover invertire un path.
    expect(clip.ops.map((o) => o.op)).toEqual(["rect", "addPath"]);
    // rect: il box del nodo (50x50 in 0,0) allargato di quanto il tratto può
    // sporgere, con un margine perché il rettangolo di clip non tagli il bordo
    // esterno della fascia.
    const [rx, ry, rw, rh] = clip.ops[0].args as number[];
    expect(rx).toBeLessThanOrEqual(-6);
    expect(ry).toBeLessThanOrEqual(-6);
    expect(rx + rw).toBeGreaterThanOrEqual(56);
    expect(ry + rh).toBeGreaterThanOrEqual(56);
    expect(clip.ops[1].args[0]).toBe(f.fills[0]);
    expect(f.strokes[0].lineWidth).toBe(12);
    expect(f.order).toEqual(["fill", "save", "clip", "stroke", "restore"]);
  });

  it("un peso non positivo non traccia niente (non è un tratto sottilissimo: non c'è)", () => {
    const f = strokeCtx();
    const n = strokedRect({ strokes: [
      { color: RED, weight: 0, align: "center" },
      { color: RED, weight: -3, align: "outside" },
    ] });
    drawScene(f.ctx, sceneWith(n), { x: 0, y: 0, zoom: 1 } as Camera);
    expect(f.strokes).toEqual([]);
    expect(f.clips).toEqual([]);
  });

  it("più tratti si disegnano NELL'ORDINE della lista, l'ultimo sopra", () => {
    const f = strokeCtx();
    const n = strokedRect({ strokes: [
      { color: RED, weight: 8, align: "center" },
      { color: { r: 0, g: 0, b: 1, a: 1 }, weight: 2, align: "center" },
    ] });
    drawScene(f.ctx, sceneWith(n), { x: 0, y: 0, zoom: 1 } as Camera);
    expect(f.strokes.map((s) => [s.lineWidth, s.strokeStyle])).toEqual([
      [8, "rgba(255, 0, 0, 1)"],
      [2, "rgba(0, 0, 255, 1)"],
    ]);
  });

  it("un nodo INVISIBILE non traccia niente", () => {
    const f = strokeCtx();
    const n = strokedRect({ visible: false, strokes: [{ color: RED, weight: 6, align: "center" }] });
    drawScene(f.ctx, sceneWith(n), { x: 0, y: 0, zoom: 1 } as Camera);
    expect(f.strokes).toEqual([]);
  });

  it("il TESTO si traccia con strokeText, riga per riga, sopra i glifi riempiti", () => {
    const f = strokeCtx();
    const n = { ...textNode(), strokes: [{ color: RED, weight: 3, align: "center" as const }] };
    drawScene(f.ctx, sceneWith(n), { x: 0, y: 0, zoom: 1 } as Camera);

    expect(f.strokeText.map((c) => c.text)).toEqual(["hi"]);
    expect(f.order).toEqual(["fillText", "strokeText"]);
    // Nessun clip: un glifo non ha un Path2D da ritagliare, quindi il tratto
    // del testo è SEMPRE centrato -- vedi il commento in renderer/text.ts.
    expect(f.clips).toEqual([]);
  });

  it("il testo non ritaglia nemmeno con align inside/outside: resta centrato", () => {
    const f = strokeCtx();
    const n = { ...textNode(), strokes: [{ color: RED, weight: 3, align: "outside" as const }] };
    drawScene(f.ctx, sceneWith(n), { x: 0, y: 0, zoom: 1 } as Camera);
    expect(f.clips).toEqual([]);
    expect(f.order).toEqual(["fillText", "strokeText"]);
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
      s.nodes = s.nodes.set("v", vectorNode("v", [{
        anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 50, y: 0 })], closed: false,
      }], { height: 0 }));
      const f = fakeCtx();
      drawScene(f.ctx, s, { x: 0, y: 0, zoom: 1 } as Camera);
      expect(f.strokes).toHaveLength(1);

      const s2 = emptyScene("d", "n");
      s2.nodes = s2.nodes.set("r", { ...rect("r", 0, 0, "a0"), height: 0 });
      const f2 = fakeCtx();
      drawScene(f2.ctx, s2, { x: 0, y: 0, zoom: 1 } as Camera);
      expect(f2.fills).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("un vettoriale CHIUSO si riempie con la regola even-odd, e si traccia comunque", () => {
    // La regola non è il default del canvas ("nonzero"), quindi va passata
    // esplicitamente -- ed è la stessa che usa l'hit-test. Con nonzero un
    // contorno interno percorso nello stesso verso di quello esterno NON
    // sarebbe un buco, e il disegno smetterebbe di corrispondere al click.
    vi.stubGlobal("Path2D", FakePath2D);
    try {
      const s = emptyScene("d", "n");
      s.nodes = s.nodes.set("v", vectorNode("v", [{
        anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 10, y: 0 }), anchor({ x: 10, y: 10 })],
        closed: true,
      }]));
      const f = fakeCtx();
      drawScene(f.ctx, s, { x: 0, y: 0, zoom: 1 } as Camera);
      expect(f.fills).toHaveLength(1);
      expect(f.fills[0].rule).toBe("evenodd");
      // Il tratto c'è anche qui. Sul colore è invisibile (è la stessa tinta del
      // riempimento, mezzo spessore in più di forma), ma è ciò che tiene visibile
      // un contorno chiuso di AREA NULLA -- vedi il test qui sotto.
      expect(f.strokes).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("un vettoriale CHIUSO di AREA NULLA si dipinge lo stesso: il tratto c'è", () => {
    // A -> B -> A, ciò che il pen tool produce chiudendo un path di due punti.
    // La fill non dipinge niente (even-odd su un contorno senza area), quindi
    // senza la stroke il nodo sarebbe INVISIBILE. Il caso è raggiungibile con
    // tre click, non è un limite.
    vi.stubGlobal("Path2D", FakePath2D);
    try {
      const s = emptyScene("d", "n");
      s.nodes = s.nodes.set("v", vectorNode("v", [{
        anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 50, y: 0 })], closed: true,
      }], { height: 0 }));
      const f = fakeCtx();
      drawScene(f.ctx, s, { x: 0, y: 0, zoom: 1 } as Camera);
      expect(f.strokes).toHaveLength(1);
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
      s.nodes = s.nodes.set("v", vectorNode("v", [{
        anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 50, y: 50 })], closed: false,
      }]));
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
      s.nodes = s.nodes.set("v", vectorNode("v", [
        { anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 10, y: 0 }), anchor({ x: 0, y: 10 })], closed: true },
        { anchors: [anchor({ x: 50, y: 0 }), anchor({ x: 50, y: 30 })], closed: false },
      ]));
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
      s.nodes = s.nodes.set("v", vectorNode("v", []));
      const f = fakeCtx();
      drawScene(f.ctx, s, { x: 0, y: 0, zoom: 1 } as Camera);
      expect(f.fills).toEqual([]);
      expect(f.strokes).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
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
    s.nodes = s.nodes.set("P", textAt("P", "page1", 100, 50));
    s.nodes = s.nodes.set("C", textAt("C", "P", 3, 4));
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
    s.nodes = s.nodes.set("P", textAt("P", "page1", 100, 50));
    s.nodes = s.nodes.set("Q", textAt("Q", "P", 10, 20));
    s.nodes = s.nodes.set("R", textAt("R", "Q", 3, 4));
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
    s.nodes = s.nodes.set("P", textAt("P", "page1", 0, 0));
    s.nodes = s.nodes.set("b", textAt("b", "P", 0, 0, "a2"));
    s.nodes = s.nodes.set("a", textAt("a", "P", 0, 0, "a1"));
    const f = fakeCtx();
    drawScene(f.ctx, s, identityCam);
    expect(f.fillText.map((c) => c.text)).toEqual(["P", "a", "b"]);
  });

  it("descends into a container with a degenerate box (a group has no box of its own)", () => {
    // Il guard sulla dimensione salta il DISEGNO del contenitore, non la
    // discesa: un gruppo (traccia 1, task 3) non ha nulla da riempire ma i suoi
    // figli devono comparire, e alla loro posizione mondo.
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("g", { ...rect("g", 100, 50, "a0"), width: 0, height: 0 });
    s.nodes = s.nodes.set("C", textAt("C", "g", 3, 4));
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
    s.nodes = s.nodes.set("g", { ...rect("g", 100, 50, "a0"), kind: "group", width: 400, height: 400 });
    s.nodes = s.nodes.set("C", textAt("C", "g", 3, 4));
    const f = fakeCtx();
    drawScene(f.ctx, s, identityCam);
    expect(f.fills).toEqual([]);
    expect(f.fillText).toEqual([{ text: "C", x: 103, y: 54 + ASCENT }]);
  });

  it("hides the whole subtree of an invisible group, like any other container", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("g", { ...rect("g", 0, 0, "a0"), kind: "group", visible: false });
    s.nodes = s.nodes.set("C", textAt("C", "g", 3, 4));
    const f = fakeCtx();
    drawScene(f.ctx, s, identityCam);
    expect(f.fillText).toEqual([]);
  });

  it("hides the whole subtree of an invisible container", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("P", textAt("P", "page1", 0, 0, "a0", { visible: false }));
    s.nodes = s.nodes.set("C", textAt("C", "P", 3, 4));
    const f = fakeCtx();
    drawScene(f.ctx, s, identityCam);
    expect(f.fillText).toEqual([]);
  });

  it("does not draw a node unreachable from any page", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("orfano", textAt("orfano", "sparito", 0, 0));
    const f = fakeCtx();
    drawScene(f.ctx, s, identityCam);
    expect(f.fillText).toEqual([]);
  });

  it("leaves the ctx transform stack balanced", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("P", textAt("P", "page1", 100, 50));
    s.nodes = s.nodes.set("Q", textAt("Q", "P", 10, 20));
    s.nodes = s.nodes.set("R", textAt("R", "Q", 3, 4));
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
    s.nodes = s.nodes.set("F", frameNode("F", "page1", 20, 30, 100, 80, true));
    s.nodes = s.nodes.set("C", textAt("C", "F", 5, 5));
    const f = fakeCtx();
    drawScene(f.ctx, s, identityCam);
    // Il box del frame è riempito (una sola fill: il testo non passa da fill).
    expect(f.fills.length).toBe(1);
    expect((f.fills[0].path as FakePath2D).ops).toEqual([{ op: "rect", args: [20, 30, 100, 80] }]);
    // E i figli si disegnano comunque, alla loro posizione mondo (dentro F).
    expect(f.fillText.map((c) => c.text)).toEqual(["C"]);
  });

  it("draws a plain rect even if the frame carries a corner radius: a frame is rectangular", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("F", { ...frameNode("F", "page1", 0, 0, 100, 80, false), cornerRadius: 40 });
    const f = fakeCtx();
    drawScene(f.ctx, s, identityCam);
    expect((f.fills[0].path as FakePath2D).ops).toEqual([{ op: "rect", args: [0, 0, 100, 80] }]);
  });

  it("clips its children to its OWN local box when clipsContent", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("F", frameNode("F", "page1", 20, 30, 100, 80, true));
    s.nodes = s.nodes.set("C", textAt("C", "F", 5, 5));
    const f = fakeCtx();
    drawScene(f.ctx, s, identityCam);
    // Il clip è al box LOCALE (0,0,w,h) -- lo spazio dei figli -- non alla x/y
    // del frame nel parent.
    expect(f.clips.length).toBe(1);
    expect((f.clips[0] as FakePath2D).ops).toEqual([{ op: "rect", args: [0, 0, 100, 80] }]);
  });

  it("does NOT clip when clipsContent is false: the children may overflow", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("F", frameNode("F", "page1", 20, 30, 100, 80, false));
    s.nodes = s.nodes.set("C", textAt("C", "F", 5, 5));
    const f = fakeCtx();
    drawScene(f.ctx, s, identityCam);
    expect(f.clips.length).toBe(0);
    expect(f.fillText.map((c) => c.text)).toEqual(["C"]); // comunque disegnati
  });

  it("does not clip for a childless clipping frame (nothing to clip)", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("F", frameNode("F", "page1", 0, 0, 100, 80, true));
    const f = fakeCtx();
    drawScene(f.ctx, s, identityCam);
    expect(f.clips.length).toBe(0);
  });
});

// SCOPING PER PAGINA CORRENTE. Il canvas mostra UNA pagina alla volta: ciò che
// si DISEGNA, ciò che l'hit-test COLPISCE e ciò che il marquee PRENDE rispondono
// tutti sulle radici della SOLA pagina corrente (rootsOf). currentPageId è un
// parametro del renderer, non un campo della scena; assente ripiega sulla prima
// pagina (il default dello store), che è il comportamento a pagina singola dei
// test qui sopra.
describe("scoping alla pagina corrente", () => {
  // Due pagine, un nodo per pagina, ESATTAMENTE sovrapposti nel mondo
  // (entrambi a (0,0), 50x50): il punto (25,25) e una banda su (0,0)-(50,50)
  // cadono su tutti e due, quindi solo lo scoping decide quale risponde.
  function twoPages(): SceneState {
    const s = emptyScene("d", "n");
    s.pages = [{ id: "page1", name: "Page 1" }, { id: "page2", name: "Page 2" }];
    s.nodes = s.nodes.set("a", rect("a", 0, 0, "a0")); // parentId "page1"
    s.nodes = s.nodes.set("b", childRect("b", "page2", 0, 0, "a0"));
    return s;
  }

  it("hitTest colpisce solo il nodo della pagina corrente", () => {
    const s = twoPages();
    expect(hitTest(s, 25, 25, Z1, "page1")).toBe("a");
    expect(hitTest(s, 25, 25, Z1, "page2")).toBe("b");
    // Default (nessun currentPageId): la PRIMA pagina.
    expect(hitTest(s, 25, 25, Z1)).toBe("a");
  });

  it("nodesIntersecting prende solo i nodi della pagina corrente", () => {
    const s = twoPages();
    const band = { x: 0, y: 0, width: 50, height: 50 };
    expect(nodesIntersecting(s, band, "page1")).toEqual(["a"]);
    expect(nodesIntersecting(s, band, "page2")).toEqual(["b"]);
    expect(nodesIntersecting(s, band)).toEqual(["a"]);
  });

  it("drawScene disegna solo le radici della pagina corrente", () => {
    const s = emptyScene("d", "n");
    s.pages = [{ id: "page1", name: "Page 1" }, { id: "page2", name: "Page 2" }];
    s.nodes = s.nodes.set("A", textAt("A", "page1", 0, 0));
    s.nodes = s.nodes.set("B", textAt("B", "page2", 0, 0));

    const f1 = fakeCtx();
    drawScene(f1.ctx, s, identityCam, "page1");
    expect(f1.fillText.map((c) => c.text)).toEqual(["A"]);

    const f2 = fakeCtx();
    drawScene(f2.ctx, s, identityCam, "page2");
    expect(f2.fillText.map((c) => c.text)).toEqual(["B"]);

    // Default: la prima pagina.
    const f3 = fakeCtx();
    drawScene(f3.ctx, s, identityCam);
    expect(f3.fillText.map((c) => c.text)).toEqual(["A"]);
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
    x: 10, y: 20, width: 320, height: 180, rotation: 0, fills: [], strokes: [], kind: "image", cornerRadius: 0, clipsContent: false,
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
    s.nodes = s.nodes.set("i", imageNode());
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
    s.nodes = s.nodes.set("i", imageNode());
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
    s.nodes = s.nodes.set("i", imageNode());
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
    s.nodes = s.nodes.set("i", imageNode());
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
    s.nodes = s.nodes.set("i", imageNode({ width: 0 }));
    const f = imageCtx();
    drawScene(f.ctx, s, { x: 0, y: 0, zoom: 1 } as Camera, { images: images(READY).source });
    expect(f.drawn).toEqual([]);
    expect(f.fillRects).toEqual([]);
  });

  it("senza una sorgente iniettata usa la cache condivisa, e non lancia", () => {
    // È il percorso VERO (App.tsx non inietta niente): in jsdom l'immagine non
    // si carica mai, quindi resta "loading" -- ma il loop non deve morire.
    const s = emptyScene("doc-1", "n");
    s.nodes = s.nodes.set("i", imageNode());
    const f = imageCtx();
    expect(() => drawScene(f.ctx, s, { x: 0, y: 0, zoom: 1 } as Camera)).not.toThrow();
    expect(f.drawn).toEqual([]);
  });
});

// --- ISTANZE (M4) ------------------------------------------------------------
//
// Un'istanza rende il sottoalbero del suo MASTER, spostato all'origine
// dell'istanza, con gli override per nodo. È OPACA dall'esterno: si disegna, si
// colpisce e si prende col marquee come UN'UNITÀ, mai i nodi del master singoli.
// I master qui vivono sotto parentId "components", NON raggiungibile da page1:
// così non si disegnano per conto loro e si vede solo la resa virtuale
// dell'istanza (esattamente come un componente reale sta su una pagina a parte).

function instanceNode(
  id: string, componentId: string, x: number, y: number,
  overrides: import("../store/types").InstanceOverrideLite[] = [], over: Partial<NodeLite> = {},
): NodeLite {
  return { ...rect(id, x, y, "a0"), kind: "instance", fills: [], instance: { componentId, overrides }, ...over };
}

// Un ctx che REGISTRA la fillStyle al momento della fill: serve a osservare che
// un override cambia il COLORE del solo nodo sovrascritto. jsdom non ha Path2D,
// quindi i test che passano di qui stubano FakePath2D.
function fillStyleCtx() {
  const fills: string[] = [];
  const ctx = {
    canvas: { width: 800, height: 600 },
    font: "", textBaseline: "", textAlign: "", fillStyle: "", strokeStyle: "",
    lineWidth: 0, globalAlpha: 1, lineCap: "", lineJoin: "",
    setTransform: () => {}, clearRect: () => {}, save: () => {}, restore: () => {},
    translate: () => {}, rotate: () => {}, transform: () => {},
    measureText: (s: string) => ({ width: s.length * 10 }),
    fill: () => { fills.push(ctx.fillStyle); },
    stroke: () => {}, clip: () => {}, fillText: () => {}, strokeText: () => {},
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, fills };
}

describe("drawScene with an instance", () => {
  it("draws the master subtree at the instance origin, shifted by -masterRoot.x/y", () => {
    const s = emptyScene("d", "n");
    // Master: un gruppo a (20,10) con un testo figlio a (5,5), fuori da page1.
    s.nodes = s.nodes.set("gm", { ...rect("gm", 20, 10, "a0"), kind: "group", parentId: "components", width: 0, height: 0 });
    s.nodes = s.nodes.set("tc", textAt("tc", "gm", 5, 5));
    s.components["comp"] = { rootNodeId: "gm", name: "Comp" };
    s.nodes = s.nodes.set("i", instanceNode("i", "comp", 100, 50));
    const f = fakeCtx();
    drawScene(f.ctx, s, identityCam);
    // L'origine del master (20,10) cade sull'origine dell'istanza (100,50); il
    // figlio a (5,5) DAL master finisce a (105,55). La resa non dipende da DOVE
    // sta la radice del master, solo dall'origine dell'istanza.
    expect(f.fillText).toEqual([{ text: "tc", x: 105, y: 55 + ASCENT }]);
  });

  it("does not draw the master standalone when it is unreachable from the page", () => {
    // Solo l'istanza è figlia di page1; il master no. Una sola resa: quella
    // virtuale. (Se il master fosse su page1 comparirebbe DUE volte, ed è
    // corretto -- ma qui verifichiamo che l'irraggiungibile non si disegna.)
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("mt", textAt("mt", "components", 0, 0));
    s.components["comp"] = { rootNodeId: "mt", name: "Comp" };
    s.nodes = s.nodes.set("i", instanceNode("i", "comp", 100, 50));
    const f = fakeCtx();
    drawScene(f.ctx, s, identityCam);
    expect(f.fillText).toEqual([{ text: "mt", x: 100, y: 50 + ASCENT }]);
  });

  it("applies a TEXT override to the overridden node only, leaving siblings from the master", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("gm", { ...rect("gm", 0, 0, "a0"), kind: "group", parentId: "components", width: 0, height: 0 });
    s.nodes = s.nodes.set("mt", textAt("mt", "gm", 0, 0, "a0"));
    s.nodes = s.nodes.set("mt2", textAt("mt2", "gm", 0, 20, "a1"));
    s.components["comp"] = { rootNodeId: "gm", name: "Comp" };
    s.nodes = s.nodes.set("i", instanceNode("i", "comp", 0, 0, [{ masterNodeId: "mt", text: "OVR" }]));
    const f = fakeCtx();
    drawScene(f.ctx, s, identityCam);
    // mt sovrascritto, mt2 dal master intatto.
    expect(f.fillText.map((c) => c.text)).toEqual(["OVR", "mt2"]);
  });

  it("applies a FILL override to the overridden node only", () => {
    vi.stubGlobal("Path2D", FakePath2D);
    try {
      const s = emptyScene("d", "n");
      s.nodes = s.nodes.set("gm", { ...rect("gm", 0, 0, "a0"), kind: "group", parentId: "components", width: 0, height: 0 });
      // Due rettangoli neri nel master; l'override rende ROSSO solo il primo.
      s.nodes = s.nodes.set("mr1", { ...rect("mr1", 0, 0, "a0"), parentId: "gm" });
      s.nodes = s.nodes.set("mr2", { ...rect("mr2", 0, 60, "a1"), parentId: "gm" });
      s.components["comp"] = { rootNodeId: "gm", name: "Comp" };
      s.nodes = s.nodes.set("i", instanceNode("i", "comp", 0, 0, [{ masterNodeId: "mr1", fills: [{ r: 1, g: 0, b: 0, a: 1 }] }]));
      const f = fillStyleCtx();
      drawScene(f.ctx, s, identityCam);
      // mr1 col colore dell'override, mr2 col nero del master.
      expect(f.fills).toEqual(["rgba(255, 0, 0, 1)", "rgba(0, 0, 0, 1)"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a missing component (or missing master) renders nothing", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("i", instanceNode("i", "nope", 100, 50));
    // componente presente ma radice assente
    s.nodes = s.nodes.set("j", instanceNode("j", "comp", 100, 50, [], { orderKey: "a1" }));
    s.components["comp"] = { rootNodeId: "gone", name: "Comp" };
    const f = fakeCtx();
    expect(() => drawScene(f.ctx, s, identityCam)).not.toThrow();
    expect(f.fillText).toEqual([]);
  });
});

describe("hitTest with an instance", () => {
  // Master: un rettangolo 50x50 a (0,0), fuori da page1. L'istanza a (100,100)
  // ne rende il contenuto a (100,100)-(150,150).
  function withInstance(): SceneState {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("mr", { ...rect("mr", 0, 0, "a0"), parentId: "components" });
    s.components["comp"] = { rootNodeId: "mr", name: "Comp" };
    s.nodes = s.nodes.set("i", instanceNode("i", "comp", 100, 100));
    return s;
  }

  it("a point over the instance content returns the INSTANCE id, never a master node", () => {
    const s = withInstance();
    expect(hitTest(s, 110, 110, Z1)).toBe("i");
  });

  it("a point outside the rendered content returns null (an instance has no box of its own)", () => {
    const s = withInstance();
    expect(hitTest(s, 200, 200, Z1)).toBeNull();
  });

  it("a missing component is not hit where its content would be", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("i", instanceNode("i", "nope", 100, 100));
    expect(hitTest(s, 110, 110, Z1)).toBeNull();
  });
});

describe("nodesIntersecting with an instance", () => {
  function withInstance(): SceneState {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("mr", { ...rect("mr", 0, 0, "a0"), parentId: "components" });
    s.components["comp"] = { rootNodeId: "mr", name: "Comp" };
    s.nodes = s.nodes.set("i", instanceNode("i", "comp", 100, 100));
    return s;
  }

  it("collects the instance by its derived bounds, returning the instance id", () => {
    const s = withInstance();
    expect(nodesIntersecting(s, { x: 105, y: 105, width: 10, height: 10 })).toEqual(["i"]);
  });

  it("does not collect the instance when the band misses its content", () => {
    const s = withInstance();
    expect(nodesIntersecting(s, { x: 300, y: 300, width: 10, height: 10 })).toEqual([]);
  });
});

// CICLO: un componente il cui master (transitivamente) contiene un'istanza di sé
// stesso ricorrerebbe all'infinito. La guardia per componentId lo ferma; qui
// verifichiamo solo che le tre discese TERMINANO.
describe("instance cycle guard", () => {
  function selfRef(): SceneState {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("gs", { ...rect("gs", 0, 0, "a0"), kind: "group", parentId: "components", width: 0, height: 0 });
    s.nodes = s.nodes.set("ci", instanceNode("ci", "self", 0, 0, [], { parentId: "gs" }));
    s.components["self"] = { rootNodeId: "gs", name: "Self" };
    s.nodes = s.nodes.set("i", instanceNode("i", "self", 0, 0));
    return s;
  }

  it("draw, hit-test and marquee all terminate on a self-referential component", () => {
    const s = selfRef();
    const f = fakeCtx();
    expect(() => drawScene(f.ctx, s, identityCam)).not.toThrow();
    expect(hitTest(s, 10, 10, Z1)).toBeNull();
    expect(nodesIntersecting(s, { x: 0, y: 0, width: 100, height: 100 })).toEqual([]);
  });
});
