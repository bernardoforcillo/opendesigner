import { describe, it, expect } from "vitest";
import { exportRegion } from "./region";
import { emptyScene } from "../store/types";
import type { MeasureText } from "../renderer/text";
import type { NodeLite, SceneState, TextStyleLite } from "../store/types";

// Misura FINTA e deterministica: 10 unità per carattere, come in svg.test.ts.
// Misurare i glifi davvero vorrebbe un canvas, e il risultato cambierebbe da
// font a font -- ma senza NESSUNA misura non si può sapere dove finisce il
// testo, che è metà del lavoro di questo modulo.
const measure: MeasureText = (s) => s.length * 10;

function node(over: Partial<NodeLite> & { id: string }): NodeLite {
  return {
    parentId: "page1", orderKey: "a1", name: over.id, visible: true, opacity: 1,
    x: 0, y: 0, width: 10, height: 10, rotation: 0,
    fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind: "rect", cornerRadius: 0,
    ...over,
  };
}

function style(over: Partial<TextStyleLite> = {}): TextStyleLite {
  return { fontFamily: "", fontSize: 16, fontWeight: "", lineHeight: 0, align: "left", ...over };
}

// Un nodo testo. Il default è il box di UN nodo appena creato con un click:
// larghezza di wrap 200 e altezza di UNA riga (16 * 1.2 = 19.2), cioè
// esattamente quello con cui l'utente si trova a scrivere.
function text(over: Partial<NodeLite> & { id: string }, content: string, s = style()): NodeLite {
  return node({ kind: "text", width: 200, height: 19.2, text: { content, style: s }, ...over });
}

function sceneWith(...nodes: NodeLite[]): SceneState {
  const s = emptyScene("doc", "Untitled");
  for (const n of nodes) s.nodes[n.id] = n;
  return s;
}

describe("exportRegion", () => {
  it("l'intera pagina: tutti i nodi visibili, in ordine di disegno", () => {
    const s = sceneWith(
      node({ id: "sopra", orderKey: "a2", x: 100, y: 100 }),
      node({ id: "sotto", orderKey: "a1", x: 0, y: 0 }),
    );
    const r = exportRegion(s, [], "page", measure);
    expect(r).not.toBeNull();
    expect(r!.nodes.map((n) => n.id)).toEqual(["sotto", "sopra"]);
    expect(r!.bounds).toEqual({ x: 0, y: 0, width: 110, height: 110 });
  });

  it("la selezione: solo i nodi selezionati, con i LORO bounds", () => {
    const s = sceneWith(
      node({ id: "a", x: 0, y: 0 }),
      node({ id: "b", x: 100, y: 200, orderKey: "a2" }),
    );
    const r = exportRegion(s, ["b"], "selection", measure);
    expect(r!.nodes.map((n) => n.id)).toEqual(["b"]);
    // I bounds sono quelli di CIÒ CHE È STATO ESPORTATO, non della pagina.
    expect(r!.bounds).toEqual({ x: 100, y: 200, width: 10, height: 10 });
  });

  it("la selezione resta in ordine di DISEGNO, non nell'ordine in cui è stata cliccata", () => {
    const s = sceneWith(
      node({ id: "sotto", orderKey: "a1" }),
      node({ id: "sopra", orderKey: "a2" }),
    );
    const r = exportRegion(s, ["sopra", "sotto"], "selection", measure);
    expect(r!.nodes.map((n) => n.id)).toEqual(["sotto", "sopra"]);
  });

  it("ignora gli id selezionati che non esistono più nella scena", () => {
    const s = sceneWith(node({ id: "a" }));
    const r = exportRegion(s, ["a", "sparito"], "selection", measure);
    expect(r!.nodes.map((n) => n.id)).toEqual(["a"]);
  });

  it("un nodo INVISIBILE non viene esportato e non allarga la regione", () => {
    const s = sceneWith(
      node({ id: "visibile", x: 0, y: 0 }),
      node({ id: "nascosto", x: 1000, y: 1000, visible: false }),
    );
    const r = exportRegion(s, [], "page", measure);
    expect(r!.nodes.map((n) => n.id)).toEqual(["visibile"]);
    expect(r!.bounds).toEqual({ x: 0, y: 0, width: 10, height: 10 });
  });

  it("una forma DEGENERE non allarga la regione: il renderer non la disegna", () => {
    // Un rettangolo 0x0 lontanissimo: drawScene lo salta (isPaintable), quindi
    // includerlo nell'unione produrrebbe un'immagine enorme e quasi vuota,
    // con il contenuto vero schiacciato in un angolo.
    const s = sceneWith(
      node({ id: "vero", x: 0, y: 0, width: 20, height: 20 }),
      node({ id: "degenere", x: 5000, y: 5000, width: 0, height: 0 }),
    );
    const r = exportRegion(s, [], "page", measure);
    expect(r!.nodes.map((n) => n.id)).toEqual(["vero"]);
    expect(r!.bounds).toEqual({ x: 0, y: 0, width: 20, height: 20 });
  });

  it("un TESTO senza altezza misurata resta esportabile (stessa eccezione del renderer)", () => {
    const s = sceneWith(text({ id: "t", width: 100, height: 0 }, "ciao"));
    expect(exportRegion(s, [], "page", measure)!.nodes.map((n) => n.id)).toEqual(["t"]);
  });

  it("null quando non c'è niente da esportare", () => {
    expect(exportRegion(emptyScene("doc", "Untitled"), [], "page", measure)).toBeNull();
    expect(exportRegion(sceneWith(node({ id: "a" })), [], "selection", measure)).toBeNull();
    expect(exportRegion(sceneWith(node({ id: "a", visible: false })), [], "page", measure)).toBeNull();
  });

  it("la scena ridotta contiene ESATTAMENTE i nodi esportati", () => {
    // È la scena che finisce in drawScene: se ci restasse dentro un nodo non
    // selezionato, l'export della selezione disegnerebbe anche quello.
    const s = sceneWith(node({ id: "a" }), node({ id: "b", orderKey: "a2" }));
    const r = exportRegion(s, ["b"], "selection", measure);
    expect(Object.keys(r!.scene.nodes)).toEqual(["b"]);
    // il resto dell'identità del documento resta quella vera
    expect(r!.scene.id).toBe("doc");
    expect(r!.scene.pages).toEqual(s.pages);
  });
});

// La regione è quello che il file RITAGLIA: ciò che ne resta fuori sparisce dal
// PNG (canvas troppo piccolo) e dall'SVG (fuori dal viewBox, che la radice
// ritaglia). Il box del modello NON è un limite per il disegno del testo --
// drawText non lo guarda, drawScene non ritaglia, e nessuno riscrive nel nodo
// l'altezza misurata -- quindi prenderlo per buono butterebbe via del testo che
// sullo schermo si vede, in silenzio e con un file che sembra riuscito.
describe("exportRegion — il testo che trabocca il suo box", () => {
  it("due righe in un box da UNA: la regione si allarga in basso, non taglia", () => {
    // Il caso di ogni giorno: un nodo creato con un click è alto una riga
    // (19.2), e basta andare a capo la prima volta per uscirne.
    const s = sceneWith(text({ id: "t", x: 0, y: 0, width: 100 }, "abcdefghij klm"));
    const r = exportRegion(s, [], "page", measure);
    // due righe da 19.2, non l'altezza del box
    expect(r!.bounds).toEqual({ x: 0, y: 0, width: 100, height: 38.4 });
  });

  it("la regione segue le righe anche quando sono molte", () => {
    const s = sceneWith(text({ id: "t", x: 5, y: 7, width: 100 }, "a\nb\nc\nd\ne"));
    expect(exportRegion(s, [], "page", measure)!.bounds).toEqual({
      x: 5, y: 7, width: 100, height: 5 * 19.2,
    });
  });

  it("un box PIÙ GRANDE del testo resta intero: è un'unione, non una sostituzione", () => {
    // Un box trascinato dall'utente (o rimasto tale dopo aver cancellato delle
    // righe) fa parte di ciò che si esporta, esattamente come a schermo.
    const s = sceneWith(text({ id: "t", width: 200, height: 100 }, "ciao"));
    expect(exportRegion(s, [], "page", measure)!.bounds).toEqual({
      x: 0, y: 0, width: 200, height: 100,
    });
  });

  it("senza larghezza di wrap il testo non va a capo, e la regione lo segue a DESTRA", () => {
    // Larghezza 0 = nessun wrap (layoutText): la riga esce dal box quanto è
    // lunga. Con il box del modello il file sarebbe largo zero.
    const s = sceneWith(text({ id: "t", width: 0 }, "ciao"));
    expect(exportRegion(s, [], "page", measure)!.bounds).toEqual({
      x: 0, y: 0, width: 40, height: 19.2,
    });
  });

  it("con l'allineamento a DESTRA il traboccamento sporge a sinistra del box", () => {
    // Un glifo più largo del box non viene spezzato (breakWord non rifiuta mai
    // un carattere solo) e con align=right finisce a x NEGATIVA rispetto al
    // box: la regione deve partire da lì, o la prima colonna di pixel manca.
    const s = sceneWith(text({ id: "t", x: 0, width: 5 }, "ab", style({ align: "right" })));
    expect(exportRegion(s, [], "page", measure)!.bounds).toEqual({
      x: -5, y: 0, width: 10, height: 38.4,
    });
  });

  it("un testo VUOTO è il suo box e nient'altro", () => {
    // Nessuna riga da misurare: niente da aggiungere, e nessun bounds inventato.
    const s = sceneWith(text({ id: "t", width: 200, height: 19.2 }, ""));
    expect(exportRegion(s, [], "page", measure)!.bounds).toEqual({
      x: 0, y: 0, width: 200, height: 19.2,
    });
  });

  it("il testo allarga la regione anche insieme alle forme", () => {
    const s = sceneWith(
      node({ id: "r", x: 0, y: 0, width: 50, height: 50 }),
      text({ id: "t", orderKey: "a2", x: 0, y: 40, width: 100 }, "abcdefghij klm"),
    );
    // il testo arriva a 40 + 38.4, ben oltre il suo box (40 + 19.2)
    expect(exportRegion(s, [], "page", measure)!.bounds).toEqual({
      x: 0, y: 0, width: 100, height: 40 + 38.4,
    });
  });

  it("le FORME non chiedono nessuna misura: il loro box è tutto ciò che dipingono", () => {
    // Se un giorno il calcolo misurasse anche i rettangoli, questo test lo
    // direbbe subito invece di lasciar passare una misura inutile (e, in
    // produzione, un canvas creato per niente).
    const boom: MeasureText = () => { throw new Error("nessuna misura per una forma"); };
    const s = sceneWith(node({ id: "r" }), node({ id: "e", kind: "ellipse", orderKey: "a2" }));
    expect(exportRegion(s, [], "page", boom)!.bounds).toEqual({ x: 0, y: 0, width: 10, height: 10 });
  });
});
