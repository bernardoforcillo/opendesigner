import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { hitTest, resizeCanvasToDisplaySize, drawScene } from "./canvasRenderer";
import type { CachedImage } from "./imageCache";
import { VECTOR_STROKE_PX } from "./shapes";
import type { Camera } from "../canvas/camera";
import { emptyScene } from "../store/types";
import type { FillLite, NodeLite, AnchorLite, SubPathLite } from "../store/types";

// Duck-typed stand-in for HTMLCanvasElement: resizeCanvasToDisplaySize only
// touches clientWidth/clientHeight/width/height, so a plain object is enough
// to test it under Node without a DOM (there is no jsdom/canvas setup here).
function fakeCanvas(clientWidth: number, clientHeight: number, width = 0, height = 0) {
  return { clientWidth, clientHeight, width, height } as unknown as HTMLCanvasElement;
}

function rect(id: string, x: number, y: number, order: string, visible = true): NodeLite {
  return { id, parentId: "page1", orderKey: order, name: id, visible, opacity: 1,
    x, y, width: 50, height: 50, rotation: 0, fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [],
    kind: "rect", cornerRadius: 0 };
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
    x: 10, y: 20, width: 200, height: 40, rotation: 0, fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [],
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
  // Le chiamate che compongono la trasformazione di un nodo RUOTATO, in ordine:
  // drawScene le emette solo attorno ai nodi con rotation != 0 (vedi il
  // commento lì), quindi una scena ferma deve lasciare questa lista vuota.
  const xform: { op: string; args: number[] }[] = [];
  const record = (op: string) => (...args: number[]) => { xform.push({ op, args }); };
  const ctx = {
    canvas: { width: 800, height: 600 },
    font: "", textBaseline: "", textAlign: "", fillStyle: "", globalAlpha: 1,
    strokeStyle: "", lineWidth: 0, lineCap: "", lineJoin: "",
    setTransform: () => {},
    clearRect: () => {},
    save: record("save"),
    restore: record("restore"),
    translate: record("translate"),
    rotate: record("rotate"),
    measureText: (s: string) => ({ width: s.length * 10 }),
    fillText: (t: string, x: number, y: number) => { fillText.push({ text: t, x, y }); },
    fill: (p: unknown, rule?: unknown) => { fills.push({ path: p, rule }); },
    stroke: (p: unknown) => {
      strokes.push({ path: p, lineWidth: ctx.lineWidth, strokeStyle: ctx.strokeStyle, cap: ctx.lineCap });
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, fillText, fills, strokes, xform };
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

  // --- rotazione ------------------------------------------------------------
  // Il nodo si disegna sempre col suo path NON ruotato: a ruotare è il
  // CONTESTO, attorno al CENTRO del box (la convenzione di canvas/transform.ts).

  it("rotates a node about the CENTRE of its box, and undoes the transform after", () => {
    const s = emptyScene("d", "n");
    // box (10,20) 200x40 -> centro (110, 40)
    s.nodes["t"] = textNode({ rotation: 90 });
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
    s.nodes["t"] = textNode();
    s.nodes["u"] = textNode({ id: "u", orderKey: "a2", rotation: 0 });
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
    s.nodes[n.id] = n;
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

  it("un vettoriale CHIUSO si riempie con la regola even-odd, e si traccia comunque", () => {
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
      s.nodes["v"] = vectorNode("v", [{
        anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 50, y: 0 })], closed: true,
      }], { height: 0 });
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

// --- immagini (traccia 3) ----------------------------------------------------

function imageNode(over: Partial<NodeLite> = {}): NodeLite {
  return { id: "i", parentId: "page1", orderKey: "a1", name: "Image", visible: true, opacity: 1,
    x: 10, y: 20, width: 320, height: 180, rotation: 0, fills: [], strokes: [], kind: "image", cornerRadius: 0,
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
