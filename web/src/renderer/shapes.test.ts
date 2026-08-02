import { describe, it, expect } from "vitest";
import { hitTestNode } from "./shapes";
import type { NodeLite } from "../store/types";

function node(kind: "rect" | "ellipse"): NodeLite {
  return { id: "n", parentId: "page1", orderKey: "a0", name: kind, visible: true, opacity: 1,
    x: 0, y: 0, width: 100, height: 50, rotation: 0,
    fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind, cornerRadius: 0 };
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
    // Una FORMA degenere resta non colpibile: non c'è niente di disegnato da
    // colpire (drawScene la scarta con lo stesso guard). L'esenzione qui sotto
    // è solo del testo.
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
});

// --- il TRATTO è colpibile ---------------------------------------------------
//
// Il tratto è pixel dipinti come il riempimento: quello che si vede si deve
// poter cliccare. Un tratto OUTSIDE da 20 su un rettangolo disegna una fascia
// larga 20 tutt'attorno, e senza questo l'unico modo di afferrarla sarebbe
// centrare la forma -- proprio il bordo, che è la parte che si mira quando si
// vuole spostare una forma senza riempimento, resterebbe cliccabile a vuoto.
describe("hitTestNode con il tratto", () => {
  function withStroke(n: NodeLite, weight: number, align: "center" | "inside" | "outside"): NodeLite {
    return { ...n, strokes: [{ color: { r: 0, g: 0, b: 0, a: 1 }, weight, align }] };
  }

  it("rect: un tratto ESTERNO si colpisce per tutta la sua larghezza", () => {
    const r = withStroke(node("rect"), 20, "outside");
    expect(hitTestNode(r, -19, 25)).toBe(true);   // dentro la fascia
    expect(hitTestNode(r, -20, 25)).toBe(true);   // sul suo bordo esterno
    expect(hitTestNode(r, -21, 25)).toBe(false);  // appena oltre
  });

  it("rect: un tratto CENTRATO sporge di metà peso", () => {
    const r = withStroke(node("rect"), 20, "center");
    expect(hitTestNode(r, -10, 25)).toBe(true);
    expect(hitTestNode(r, -11, 25)).toBe(false);
  });

  it("rect: un tratto INTERNO non allarga il bersaglio di un pixel", () => {
    const r = withStroke(node("rect"), 20, "inside");
    expect(hitTestNode(r, -1, 25)).toBe(false);
    expect(hitTestNode(r, 0, 25)).toBe(true);
  });

  it("ellipse: la fascia cresce sui RAGGI, non sull'AABB (l'angolo resta un miss)", () => {
    const e = withStroke(node("ellipse"), 20, "outside");
    // Estremo dell'asse maggiore + tutto il peso.
    expect(hitTestNode(e, 119, 25)).toBe(true);
    expect(hitTestNode(e, 121, 25)).toBe(false);
    // E l'angolo del rettangolo contenitore ALLARGATO resta fuori: il tratto
    // di un'ellisse è un anello, non una cornice quadrata.
    expect(hitTestNode(e, -19, -9)).toBe(false);
  });

  it("prende il tratto che sporge di più, non l'ultimo né la somma", () => {
    const r: NodeLite = { ...node("rect"), strokes: [
      { color: { r: 0, g: 0, b: 0, a: 1 }, weight: 20, align: "outside" },
      { color: { r: 0, g: 0, b: 0, a: 1 }, weight: 2, align: "center" },
    ] };
    expect(hitTestNode(r, -20, 25)).toBe(true);
    expect(hitTestNode(r, -21, 25)).toBe(false);
  });

  it("la fascia gira col nodo (è nello spazio LOCALE, non su quello dello schermo)", () => {
    const r = { ...withStroke(node("rect"), 20, "outside"), rotation: 90 };
    // Da fermo il rect occupa x∈[0,100], y∈[0,50] e il tratto arriva a x=-20.
    // A 90° attorno al centro (50,25) quella fascia finisce SOTTO: y=95.
    expect(hitTestNode(r, 50, 94)).toBe(true);
    expect(hitTestNode(r, 50, 96)).toBe(false);
    expect(hitTestNode(r, -19, 25)).toBe(false); // dov'era da ferma: ora è vuoto
  });

  it("un peso nullo lascia il bersaglio esattamente com'era", () => {
    const r = withStroke(node("rect"), 0, "outside");
    expect(hitTestNode(r, -1, 25)).toBe(false);
    expect(hitTestNode(r, 0, 25)).toBe(true);
  });

  it("una forma DEGENERE con un tratto resta non colpibile", () => {
    // Nessun perimetro da tracciare: il renderer la scarta con lo stesso
    // guard, e l'hit-test non deve inventare un bersaglio da 40x40 attorno a
    // un nodo che non si vede.
    const z = withStroke({ ...node("rect"), width: 0, height: 0 }, 20, "outside");
    expect(hitTestNode(z, 0, 0)).toBe(false);
  });
});

// --- rotazione ---------------------------------------------------------------
// Il punto di test viene portato nello spazio LOCALE del nodo (rotazione
// inversa attorno al CENTRO del box, vedi canvas/transform.ts) PRIMA di
// testare la forma: così un'ellisse ruotata continua a colpirsi da ellisse, e
// non dal suo rettangolo contenitore. I nodi qui sono 100x50 nell'origine,
// centro (50, 25).
describe("hitTestNode con rotazione", () => {
  it("ellipse: the rotated end of the major axis hits, its own AABB corner still misses", () => {
    const e = { ...node("ellipse"), rotation: 90 };
    // (99,25) era l'estremo dell'asse maggiore da fermo: a 90° quel punto
    // locale finisce a (50,74) e l'estremo NON è più dove era.
    expect(hitTestNode(e, 50, 74)).toBe(true);
    expect(hitTestNode(e, 99, 25)).toBe(false);
    // Il caso che l'AABB sbagliava, ruotato: l'angolo del rettangolo
    // contenitore della forma ruotata (che ora è alto 100 e largo 50) resta
    // fuori dall'ellisse.
    expect(hitTestNode(e, 27, -23)).toBe(false);
    expect(hitTestNode(e, 50, 25)).toBe(true); // il centro è fermo, sempre
  });

  it("ellipse: a 45 degree rotation still misses the four corners of its AABB", () => {
    const e = { ...node("ellipse"), width: 100, height: 100, rotation: 45 };
    // Un cerchio ruotato è sé stesso: gli angoli del box restano fuori.
    expect(hitTestNode(e, 4, 2)).toBe(false);
    expect(hitTestNode(e, 96, 98)).toBe(false);
    expect(hitTestNode(e, 50, 50)).toBe(true);
  });

  it("rect: hits where the shape actually IS, not where its unrotated box was", () => {
    const r = { ...node("rect"), rotation: 90 };
    // A 90° il rettangolo occupa x in [25,75] e y in [-25,75].
    expect(hitTestNode(r, 50, 70)).toBe(true);   // fuori dal box fermo, dentro quello ruotato
    expect(hitTestNode(r, 90, 25)).toBe(false);  // dentro il box fermo, fuori da quello ruotato
  });

  it("text: its box rotates with the node too", () => {
    const t = textNode({ rotation: 90 });
    expect(hitTestNode(t, 50, 70)).toBe(true);
    expect(hitTestNode(t, 90, 25)).toBe(false);
  });

  it("a full turn is indistinguishable from no rotation", () => {
    expect(hitTestNode({ ...node("ellipse"), rotation: 360 }, 99, 25)).toBe(true);
    expect(hitTestNode({ ...node("ellipse"), rotation: 360 }, 4, 2)).toBe(false);
  });

  it("a degenerate shape stays unhittable however it is rotated", () => {
    expect(hitTestNode({ ...node("ellipse"), width: 0, height: 0, rotation: 30 }, 0, 0)).toBe(false);
  });
});
