import { describe, it, expect } from "vitest";
import { hitTestNode } from "./shapes";
import type { NodeLite } from "../store/types";

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

function vectorNode(over: Partial<NodeLite> = {}): NodeLite {
  return { ...node("rect"), kind: "vector", vector: { subpaths: [] }, ...over };
}

describe("hitTestNode", () => {
  it("rect: inside and outside", () => {
    expect(hitTestNode(node("rect"), 50, 25)).toBe(true);
    expect(hitTestNode(node("rect"), 4, 2)).toBe(true);     // gli angoli appartengono al rect
    expect(hitTestNode(node("rect"), 120, 25)).toBe(false);
  });

  it("ellipse: center hits, corner misses", () => {
    const e = node("ellipse");
    expect(hitTestNode(e, 50, 25)).toBe(true);
    expect(hitTestNode(e, 4, 2)).toBe(false);               // <- il caso che l'AABB sbagliava
    expect(hitTestNode(e, 99, 25)).toBe(true);              // estremo dell'asse maggiore
  });

  it("handles zero-size nodes without dividing by zero", () => {
    const z = { ...node("ellipse"), width: 0, height: 0 };
    expect(hitTestNode(z, 0, 0)).toBe(false);
    // Una forma il cui INCHIOSTRO È IL BOX (rect, ellisse) resta non colpibile
    // da degenere: non c'è niente di disegnato da colpire, e drawScene la scarta
    // con lo stesso guard. Le esenzioni più sotto -- testo e vettoriale -- sono
    // i due casi in cui l'inchiostro NON è il box.
    expect(hitTestNode({ ...node("rect"), height: 0 }, 50, 0)).toBe(false);
  });

  it("text: hits the whole bounding box, not the glyphs", () => {
    const t: NodeLite = {
      ...node("rect"), kind: "text",
      text: { content: "a  b", style: { fontFamily: "", fontSize: 16, fontWeight: "", lineHeight: 0, align: "left" } },
    };
    expect(hitTestNode(t, 50, 25)).toBe(true);   // dentro il box, fra due glifi
    expect(hitTestNode(t, 99, 49)).toBe(true);   // angolo del box, ben oltre il testo
    expect(hitTestNode(t, 101, 25)).toBe(false); // fuori dal box
  });

  it("text: empty content is still hittable on its box", () => {
    // Un nodo testo appena creato è vuoto: se non fosse selezionabile
    // l'utente non potrebbe più raggiungerlo dal canvas.
    const t: NodeLite = {
      ...node("rect"), kind: "text",
      text: { content: "", style: { fontFamily: "", fontSize: 0, fontWeight: "", lineHeight: 0, align: "left" } },
    };
    expect(hitTestNode(t, 50, 25)).toBe(true);
  });

  it("text: a node whose height the layout has not produced yet is hittable on one line", () => {
    // Lo stesso nodo che drawScene disegna comunque (canvasRenderer.ts): se
    // l'hit-test lo scartasse per height 0, il testo appena creato sarebbe
    // visibile ma impossibile da cliccare. Il minimo è una riga: 16 * 1.2.
    const t = textNode({ height: 0 });
    expect(hitTestNode(t, 50, 0)).toBe(true);
    expect(hitTestNode(t, 50, 19)).toBe(true);
    expect(hitTestNode(t, 50, 20)).toBe(false);   // sotto la riga, di nuovo fuori
  });

  it("text: a caret-sized node keeps a click target on both axes", () => {
    // width 0 = nessuna larghezza di wrap: il box del modello è un punto, ma
    // il caret sullo schermo no.
    const t = textNode({ width: 0, height: 0 }, "");
    expect(hitTestNode(t, 0, 0)).toBe(true);
    expect(hitTestNode(t, 19, 19)).toBe(true);
    expect(hitTestNode(t, 20, 19)).toBe(false);
  });

  it("text: a missing text payload falls back to the renderer defaults", () => {
    // Stato che toNodeLite non produce, ma l'hit-test non deve esplodere.
    const t: NodeLite = { ...node("rect"), kind: "text", width: 0, height: 0 };
    expect(hitTestNode(t, 5, 5)).toBe(true);
    expect(hitTestNode(t, 25, 5)).toBe(false);
  });

  it("text: a box larger than one line is not shrunk to it", () => {
    expect(hitTestNode(textNode(), 99, 49)).toBe(true);
  });

  // Il vettoriale è il SECONDO caso in cui l'inchiostro non è il box, e per una
  // ragione diversa dal testo: il box è la bbox ESATTA della geometria (è
  // l'invariante scritta nel proto), quindi un asse a zero non è uno stato
  // transitorio ma il valore giusto -- un path di un solo ancoraggio (il pen
  // tool dopo il primo click) o un segmento orizzontale. Con il guard generico
  // quel nodo sarebbe invisibile E non cliccabile: raggiungibile solo dal
  // pannello livelli, e cancellabile solo da lì.
  it("vector: a path with a degenerate axis is still clickable", () => {
    const line = vectorNode({ width: 40, height: 0 });
    expect(hitTestNode(line, 20, 0)).toBe(true);
    expect(hitTestNode(line, 20, 1.5)).toBe(true);    // dentro la tolleranza di presa
    expect(hitTestNode(line, 20, -1.5)).toBe(true);   // centrata: si afferra da sopra come da sotto
    expect(hitTestNode(line, 20, 10)).toBe(false);
  });

  it("vector: a single-anchor path (both axes degenerate) is still clickable", () => {
    const dot = vectorNode({ width: 0, height: 0 });
    expect(hitTestNode(dot, 0, 0)).toBe(true);
    expect(hitTestNode(dot, 10, 10)).toBe(false);
  });

  it("vector: a normal path is NOT inflated (no clicks stolen from the shapes below)", () => {
    const v = vectorNode({ width: 100, height: 50 });
    expect(hitTestNode(v, 100, 50)).toBe(true);
    expect(hitTestNode(v, 101, 25)).toBe(false);
    expect(hitTestNode(v, 50, 51)).toBe(false);
  });
});
