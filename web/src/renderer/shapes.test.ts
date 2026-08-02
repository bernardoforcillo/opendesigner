import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { hitTestNode, vectorPaths, VECTOR_HIT_PX } from "./shapes";
import type { NodeLite, SubPathLite, AnchorLite } from "../store/types";

function node(kind: "rect" | "ellipse"): NodeLite {
  return { id: "n", parentId: "page1", orderKey: "a0", name: kind, visible: true, opacity: 1,
    x: 0, y: 0, width: 100, height: 50, rotation: 0,
    fills: [{ r: 0, g: 0, b: 0, a: 1 }], kind, cornerRadius: 0 };
}

// Stile con lineHeight non specificato (0): il default 1.2 lo risolve il
// renderer, quindi una riga è alta 16 * 1.2 = 19.2.
function textNode(over: Partial<NodeLite> = {}, content = "hi"): NodeLite {
  return {
    ...node("rect"), kind: "text",
    text: { content, style: { fontFamily: "", fontSize: 16, fontWeight: "", lineHeight: 0, align: "left" } },
    ...over,
  };
}

function anchor(a: Partial<AnchorLite>): AnchorLite {
  return { x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0, ...a };
}

function vectorNode(subpaths: SubPathLite[], over: Partial<NodeLite> = {}): NodeLite {
  return { ...node("rect"), kind: "vector", vector: { subpaths }, ...over };
}

// Lo zoom entra nell'hit-test solo per convertire la tolleranza di presa da px
// SCHERMO a unità mondo: a zoom 1 i due valori coincidono, ed è quello che
// usano i test che non parlano di zoom.
const Z1 = 1;

describe("hitTestNode", () => {
  it("rect: inside and outside", () => {
    expect(hitTestNode(node("rect"), 50, 25, Z1)).toBe(true);
    expect(hitTestNode(node("rect"), 4, 2, Z1)).toBe(true);     // gli angoli appartengono al rect
    expect(hitTestNode(node("rect"), 120, 25, Z1)).toBe(false);
  });

  it("ellipse: center hits, corner misses", () => {
    const e = node("ellipse");
    expect(hitTestNode(e, 50, 25, Z1)).toBe(true);
    expect(hitTestNode(e, 4, 2, Z1)).toBe(false);               // <- il caso che l'AABB sbagliava
    expect(hitTestNode(e, 99, 25, Z1)).toBe(true);              // estremo dell'asse maggiore
  });

  it("handles zero-size nodes without dividing by zero", () => {
    const z = { ...node("ellipse"), width: 0, height: 0 };
    expect(hitTestNode(z, 0, 0, Z1)).toBe(false);
    // Una forma il cui INCHIOSTRO È IL BOX (rect, ellisse) resta non colpibile
    // da degenere: non c'è niente di disegnato da colpire, e drawScene la scarta
    // con lo stesso guard. Le esenzioni più sotto -- testo e vettoriale -- sono
    // i due casi in cui l'inchiostro NON è il box.
    expect(hitTestNode({ ...node("rect"), height: 0 }, 50, 0, Z1)).toBe(false);
  });

  it("text: hits the whole bounding box, not the glyphs", () => {
    const t: NodeLite = {
      ...node("rect"), kind: "text",
      text: { content: "a  b", style: { fontFamily: "", fontSize: 16, fontWeight: "", lineHeight: 0, align: "left" } },
    };
    expect(hitTestNode(t, 50, 25, Z1)).toBe(true);   // dentro il box, fra due glifi
    expect(hitTestNode(t, 99, 49, Z1)).toBe(true);   // angolo del box, ben oltre il testo
    expect(hitTestNode(t, 101, 25, Z1)).toBe(false); // fuori dal box
  });

  it("text: empty content is still hittable on its box", () => {
    // Un nodo testo appena creato è vuoto: se non fosse selezionabile
    // l'utente non potrebbe più raggiungerlo dal canvas.
    const t: NodeLite = {
      ...node("rect"), kind: "text",
      text: { content: "", style: { fontFamily: "", fontSize: 0, fontWeight: "", lineHeight: 0, align: "left" } },
    };
    expect(hitTestNode(t, 50, 25, Z1)).toBe(true);
  });

  it("text: a node whose height the layout has not produced yet is hittable on one line", () => {
    // Lo stesso nodo che drawScene disegna comunque (canvasRenderer.ts): se
    // l'hit-test lo scartasse per height 0, il testo appena creato sarebbe
    // visibile ma impossibile da cliccare. Il minimo è una riga: 16 * 1.2.
    const t = textNode({ height: 0 });
    expect(hitTestNode(t, 50, 0, Z1)).toBe(true);
    expect(hitTestNode(t, 50, 19, Z1)).toBe(true);
    expect(hitTestNode(t, 50, 20, Z1)).toBe(false);   // sotto la riga, di nuovo fuori
  });

  it("text: a caret-sized node keeps a click target on both axes", () => {
    // width 0 = nessuna larghezza di wrap: il box del modello è un punto, ma
    // il caret sullo schermo no.
    const t = textNode({ width: 0, height: 0 }, "");
    expect(hitTestNode(t, 0, 0, Z1)).toBe(true);
    expect(hitTestNode(t, 19, 19, Z1)).toBe(true);
    expect(hitTestNode(t, 20, 19, Z1)).toBe(false);
  });

  it("text: a missing text payload falls back to the renderer defaults", () => {
    // Stato che toNodeLite non produce, ma l'hit-test non deve esplodere.
    const t: NodeLite = { ...node("rect"), kind: "text", width: 0, height: 0 };
    expect(hitTestNode(t, 5, 5, Z1)).toBe(true);
    expect(hitTestNode(t, 25, 5, Z1)).toBe(false);
  });

  it("text: a box larger than one line is not shrunk to it", () => {
    expect(hitTestNode(textNode(), 99, 49, Z1)).toBe(true);
  });
});

// Il vettoriale è il secondo caso in cui l'inchiostro non è il box, e per una
// ragione diversa dal testo: il box è la bbox ESATTA della geometria
// (invariante del proto), quindi un asse a zero non è uno stato transitorio ma
// il valore giusto -- un segmento orizzontale, o il path di un solo ancoraggio
// appena posato dal pen tool. Il box però non è nemmeno il BERSAGLIO: si
// colpisce l'inchiostro, cioè il riempimento di un contorno chiuso o la
// vicinanza alla curva di uno aperto.
describe("hitTestNode: vettoriale", () => {
  const SEGMENT: SubPathLite[] = [{
    anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 40, y: 0 })], closed: false,
  }];
  const SQUARE: SubPathLite[] = [{
    anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 100, y: 0 }),
      anchor({ x: 100, y: 50 }), anchor({ x: 0, y: 50 })],
    closed: true,
  }];

  it("un contorno APERTO si colpisce per vicinanza, anche con un asse degenere", () => {
    const line = vectorNode(SEGMENT, { width: 40, height: 0 });
    expect(hitTestNode(line, 20, 0, Z1)).toBe(true);
    expect(hitTestNode(line, 20, 4, Z1)).toBe(true);    // dentro la tolleranza di presa
    expect(hitTestNode(line, 20, -4, Z1)).toBe(true);   // si afferra da sopra come da sotto
    expect(hitTestNode(line, 20, 10, Z1)).toBe(false);
    // Oltre l'estremo del segmento: la presa avvolge la curva, non la sua retta.
    expect(hitTestNode(line, 60, 0, Z1)).toBe(false);
  });

  it("la tolleranza è in px SCHERMO: la stessa distanza mondo cambia esito con lo zoom", () => {
    // È la ragione per cui hitTestNode conosce lo zoom. A zoom 4 una distanza
    // di 2 unità mondo sono 8 px sullo schermo, ben oltre i 5 di presa; a zoom
    // 1 sono 2 px e la linea si afferra. Con una tolleranza in unità mondo la
    // stessa linea sarebbe impossibile da centrare a zoom 0.1 e larga mezzo
    // schermo a zoom 64.
    const line = vectorNode(SEGMENT, { width: 40, height: 0 });
    expect(hitTestNode(line, 20, 2, 1)).toBe(true);
    expect(hitTestNode(line, 20, 2, 4)).toBe(false);
    expect(hitTestNode(line, 20, 15, 0.25)).toBe(true);   // 15 unità mondo = 3.75 px
    expect(hitTestNode(line, 20, 25, 0.25)).toBe(false);  // 25 unità mondo = 6.25 px
    // La soglia è esattamente VECTOR_HIT_PX px schermo, a qualunque zoom.
    for (const zoom of [0.5, 1, 3]) {
      expect(hitTestNode(line, 20, (VECTOR_HIT_PX - 0.01) / zoom, zoom)).toBe(true);
      expect(hitTestNode(line, 20, (VECTOR_HIT_PX + 0.01) / zoom, zoom)).toBe(false);
    }
  });

  it("gli ancoraggi sono LOCALI: il bersaglio si sposta con l'origine del nodo", () => {
    const line = vectorNode(SEGMENT, { x: 100, y: 50, width: 40, height: 0 });
    expect(hitTestNode(line, 120, 50, Z1)).toBe(true);
    expect(hitTestNode(line, 20, 0, Z1)).toBe(false);   // dov'era prima di spostarlo
  });

  it("un contorno CHIUSO si colpisce sul riempimento, e NON su un alone attorno", () => {
    const v = vectorNode(SQUARE);
    expect(hitTestNode(v, 50, 25, Z1)).toBe(true);
    expect(hitTestNode(v, 103, 25, Z1)).toBe(false);  // 3 px fuori: nessun alone
    expect(hitTestNode(v, 50, 53, Z1)).toBe(false);
  });

  it("un contorno APERTO non riempie: l'interno resta delle forme sotto", () => {
    const u = vectorNode([{ ...SQUARE[0], closed: false }]);
    expect(hitTestNode(u, 50, 25, Z1)).toBe(false);
    expect(hitTestNode(u, 50, 1, Z1)).toBe(true);   // sul lato alto, che invece c'è
  });

  it("un contorno di UN ancoraggio (il primo click del pen tool) è colpibile", () => {
    const dot = vectorNode([{ anchors: [anchor({ x: 0, y: 0 })], closed: false }], { width: 0, height: 0 });
    expect(hitTestNode(dot, 0, 0, Z1)).toBe(true);
    expect(hitTestNode(dot, 3, 0, Z1)).toBe(true);
    expect(hitTestNode(dot, 10, 10, Z1)).toBe(false);
  });

  it("geometria assente o vuota: niente inchiostro, niente da colpire", () => {
    // Nessun ripiego sul box: un nodo che non disegna niente non deve nemmeno
    // rubare i click alle forme sotto. Resta raggiungibile dal pannello
    // livelli, che è l'unico posto in cui esiste ancora qualcosa da toccare.
    expect(hitTestNode(vectorNode([]), 50, 25, Z1)).toBe(false);
    const noPayload: NodeLite = { ...node("rect"), kind: "vector" };
    expect(hitTestNode(noPayload, 50, 25, Z1)).toBe(false);
  });
});

// Path2D non esiste sotto jsdom: un doppio che REGISTRA i comandi rende
// verificabile la forma esatta del path, che è l'unica cosa che conta qui.
class RecordingPath2D {
  calls: string[] = [];
  moveTo(x: number, y: number) { this.calls.push(`M ${x} ${y}`); }
  lineTo(x: number, y: number) { this.calls.push(`L ${x} ${y}`); }
  bezierCurveTo(a: number, b: number, c: number, d: number, e: number, f: number) {
    this.calls.push(`C ${a} ${b} ${c} ${d} ${e} ${f}`);
  }
  closePath() { this.calls.push("Z"); }
}

function callsOf(p: Path2D | null): string[] | null {
  return p ? (p as unknown as RecordingPath2D).calls : null;
}

describe("vectorPaths", () => {
  beforeEach(() => { vi.stubGlobal("Path2D", RecordingPath2D); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("un contorno APERTO va nel path del CONTORNO, senza closePath", () => {
    // Origine (100, 50), ancoraggi locali, maniglie relative all'ancoraggio:
    // tutti diversi e non nulli, così una somma saltata non cade per caso sul
    // valore giusto.
    const n = vectorNode([{
      anchors: [anchor({ x: 10, y: 0, outX: 5, outY: -3 }), anchor({ x: 30, y: 20, inX: -7, inY: 2 })],
      closed: false,
    }], { x: 100, y: 50 });
    const { fill, stroke } = vectorPaths(n);
    expect(fill).toBeNull();
    expect(callsOf(stroke)).toEqual([
      "M 110 50",
      // controllo uscente = origine + ancoraggio + maniglia = (115, 47);
      // controllo entrante = (123, 72); arrivo = (130, 70).
      "C 115 47 123 72 130 70",
    ]);
  });

  it("un contorno CHIUSO va nel path del RIEMPIMENTO, con il ritorno e il closePath", () => {
    const n = vectorNode([{
      anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 10, y: 0 }), anchor({ x: 10, y: 10 })],
      closed: true,
    }]);
    const { fill, stroke } = vectorPaths(n);
    expect(stroke).toBeNull();
    // Il segmento di ritorno ultimo -> primo è una CURVA come le altre (le sue
    // maniglie esistono), quindi si disegna esplicitamente; closePath dopo non
    // aggiunge lunghezza -- serve a chiudere il contorno per il riempimento.
    expect(callsOf(fill)).toEqual([
      "M 0 0",
      "C 0 0 10 0 10 0",
      "C 10 0 10 10 10 10",
      "C 10 10 0 0 0 0",
      "Z",
    ]);
  });

  it("un ancoraggio senza maniglie dà una bezier con i controlli sugli estremi (la retta)", () => {
    const n = vectorNode([{
      anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 40, y: 0 })], closed: false,
    }]);
    // Nessun ramo per "maniglia assente": è il motivo per cui le maniglie sono
    // relative, e il canvas disegna esattamente il segmento.
    expect(callsOf(vectorPaths(n).stroke)).toEqual(["M 0 0", "C 0 0 40 0 40 0"]);
  });

  it("contorni aperti e chiusi nello stesso nodo finiscono in path DIVERSI", () => {
    const n = vectorNode([
      { anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 10, y: 0 }), anchor({ x: 0, y: 10 })], closed: true },
      { anchors: [anchor({ x: 50, y: 0 }), anchor({ x: 50, y: 30 })], closed: false },
    ]);
    const { fill, stroke } = vectorPaths(n);
    // Uno si riempie, l'altro no: se stessero nello stesso Path2D il canvas
    // chiuderebbe implicitamente anche l'aperto e lo riempirebbe.
    expect(callsOf(fill)?.filter((c) => c === "Z")).toEqual(["Z"]);
    expect(callsOf(stroke)).toEqual(["M 50 0", "C 50 0 50 30 50 30"]);
  });

  it("un contorno di un solo ancoraggio è un PUNTO nel path del contorno", () => {
    // Il lineTo su se stesso non ha lunghezza ma con lineCap tondo il canvas lo
    // disegna: è il pallino che il pen tool lascia dopo il primo click. Senza,
    // il nodo appena nato sarebbe invisibile finché non arriva il secondo.
    const n = vectorNode([{ anchors: [anchor({ x: 7, y: 9 })], closed: false }]);
    expect(callsOf(vectorPaths(n).stroke)).toEqual(["M 7 9", "L 7 9"]);
    // `closed` non cambia niente: un punto non ha area da riempire.
    const c = vectorNode([{ anchors: [anchor({ x: 7, y: 9 })], closed: true }]);
    expect(vectorPaths(c).fill).toBeNull();
    expect(callsOf(vectorPaths(c).stroke)).toEqual(["M 7 9", "L 7 9"]);
  });

  it("geometria assente o vuota: nessun path (non un path vuoto)", () => {
    expect(vectorPaths(vectorNode([]))).toEqual({ fill: null, stroke: null });
    expect(vectorPaths(vectorNode([{ anchors: [], closed: true }]))).toEqual({ fill: null, stroke: null });
    const noPayload: NodeLite = { ...node("rect"), kind: "vector" };
    expect(vectorPaths(noPayload)).toEqual({ fill: null, stroke: null });
  });
});
