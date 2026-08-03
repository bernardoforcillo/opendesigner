import { describe, it, expect } from "vitest";
import { nodesToSvg } from "./svg";
import type { NodeLite, TextStyleLite } from "../store/types";

// Misura FINTA e deterministica: 10 unità per carattere. È l'unico modo di
// testare il generatore come funzione pura -- misurare i glifi davvero
// richiederebbe un canvas, e il risultato cambierebbe da font a font.
const measure = (s: string) => s.length * 10;

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

function text(over: Partial<NodeLite> & { id: string }, content: string, s = style()): NodeLite {
  return node({ kind: "text", width: 100, height: 40, text: { content, style: s }, ...over });
}

const FULL = { x: 0, y: 0, width: 100, height: 100 };

describe("nodesToSvg — il documento", () => {
  it("radice: xmlns, dimensioni e viewBox presi dalla REGIONE", () => {
    const svg = nodesToSvg([node({ id: "a" })], { x: 10, y: 20, width: 300, height: 150 }, measure);
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain('width="300"');
    expect(svg).toContain('height="150"');
    // Il viewBox porta l'ORIGINE della regione: le coordinate dei nodi restano
    // quelle del modello, nessuna traslazione cotta dentro.
    expect(svg).toContain('viewBox="10 20 300 150"');
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
  });

  it("le coordinate sono quelle del MONDO, non dello schermo", () => {
    // Nessun parametro camera esiste in questa firma: è il punto. Un nodo a
    // (250, 400) si scrive 250, 400 comunque fosse messa la vista.
    const svg = nodesToSvg(
      [node({ id: "a", x: 250, y: 400, width: 20, height: 30 })],
      { x: 250, y: 400, width: 20, height: 30 },
      measure,
    );
    expect(svg).toContain('<rect x="250" y="400" width="20" height="30"');
  });

  it("conserva l'ordine di disegno: il primo nodo è il primo elemento", () => {
    const svg = nodesToSvg(
      [node({ id: "sotto" }), node({ id: "sopra", kind: "ellipse" })],
      FULL, measure,
    );
    expect(svg.indexOf("<rect")).toBeLessThan(svg.indexOf("<ellipse"));
  });

  it("una regione senza nodi resta un documento SVG valido e vuoto", () => {
    const svg = nodesToSvg([], FULL, measure);
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
    expect(svg).not.toContain("<rect");
  });
});

describe("nodesToSvg — le forme", () => {
  it("rettangolo", () => {
    const svg = nodesToSvg([node({ id: "a", x: 1, y: 2, width: 30, height: 40 })], FULL, measure);
    expect(svg).toContain('<rect x="1" y="2" width="30" height="40" fill="rgb(0,0,0)"/>');
  });

  it("rettangolo arrotondato: rx dal corner radius", () => {
    const svg = nodesToSvg(
      [node({ id: "a", width: 40, height: 40, cornerRadius: 8 })], FULL, measure,
    );
    expect(svg).toContain('rx="8"');
  });

  it("il raggio si CLAMPA a metà del lato più corto, come fa roundRect", () => {
    // Senza clamp i due renderer disegnerebbero forme diverse a partire dallo
    // stesso modello: il canvas riduce i raggi troppo grandi, l'SVG grezzo no
    // (dipende dal visualizzatore).
    const svg = nodesToSvg(
      [node({ id: "a", width: 40, height: 20, cornerRadius: 999 })], FULL, measure,
    );
    expect(svg).toContain('rx="10"');
  });

  it("niente rx quando il raggio è zero", () => {
    const svg = nodesToSvg([node({ id: "a" })], FULL, measure);
    expect(svg).not.toContain("rx=");
  });

  it("ellisse: centro e semiassi, non un rettangolo", () => {
    const svg = nodesToSvg(
      [node({ id: "a", kind: "ellipse", x: 10, y: 20, width: 100, height: 50 })], FULL, measure,
    );
    expect(svg).toContain('<ellipse cx="60" cy="45" rx="50" ry="25" fill="rgb(0,0,0)"/>');
    expect(svg).not.toContain("<rect");
  });
});

describe("nodesToSvg — colore e opacità", () => {
  it("la tinta diventa rgb() con i canali su 255", () => {
    const svg = nodesToSvg(
      [node({ id: "a", fills: [{ r: 1, g: 0.5, b: 0, a: 1 }] })], FULL, measure,
    );
    expect(svg).toContain('fill="rgb(255,128,0)"');
  });

  it("un nodo senza tinte prende lo STESSO grigio di default del canvas", () => {
    const svg = nodesToSvg([node({ id: "a", fills: [] })], FULL, measure);
    expect(svg).toContain('fill="rgb(204,204,204)"'); // 0.8 * 255
  });

  it("l'alfa della tinta diventa fill-opacity, l'opacità del nodo opacity", () => {
    const svg = nodesToSvg(
      [node({ id: "a", opacity: 0.5, fills: [{ r: 0, g: 0, b: 0, a: 0.25 }] })], FULL, measure,
    );
    expect(svg).toContain('fill-opacity="0.25"');
    expect(svg).toContain('opacity="0.5"');
  });

  it("gli attributi di opacità si omettono quando valgono 1", () => {
    const svg = nodesToSvg([node({ id: "a" })], FULL, measure);
    expect(svg).not.toContain("opacity");
  });
});

describe("nodesToSvg — il testo", () => {
  it("esce come <text> VERO, non come un tracciato", () => {
    const svg = nodesToSvg([text({ id: "t", x: 10, y: 20 }, "ciao")], FULL, measure);
    expect(svg).toContain("<text");
    expect(svg).toContain(">ciao<");
    expect(svg).not.toContain("<path");
  });

  it("porta famiglia, corpo e peso RISOLTI dai default del renderer", () => {
    const svg = nodesToSvg([text({ id: "t" }, "ciao")], FULL, measure);
    expect(svg).toContain('font-family="Inter, sans-serif"');
    expect(svg).toContain('font-size="16"');
    expect(svg).toContain('font-weight="400"');
  });

  it("uno stile esplicito vince sui default", () => {
    const svg = nodesToSvg(
      [text({ id: "t" }, "ciao", style({ fontFamily: "Georgia", fontSize: 32, fontWeight: "700" }))],
      FULL, measure,
    );
    expect(svg).toContain('font-family="Georgia"');
    expect(svg).toContain('font-size="32"');
    expect(svg).toContain('font-weight="700"');
  });

  it("una riga per tspan, posizionata come la posiziona il canvas", () => {
    // width 100 e 10 unità per carattere: "abcdefghij klm" va a capo.
    const svg = nodesToSvg([text({ id: "t", x: 10, y: 20 }, "abcdefghij klm")], FULL, measure);
    // ascent = (19.2-16)/2 + 16*0.8 = 14.4 ; lineHeight = 19.2
    expect(svg).toContain('<tspan x="10" y="34.4">abcdefghij</tspan>');
    expect(svg).toContain('<tspan x="10" y="53.6">klm</tspan>');
  });

  it("i tspan sono ATTACCATI: nessuno spazio bianco fra loro", () => {
    // Con xml:space="preserve" anche un a capo fra due tspan diventa uno
    // spazio disegnato: il testo esportato avrebbe rientri che nel canvas non
    // ci sono.
    const svg = nodesToSvg([text({ id: "t" }, "abcdefghij klm")], FULL, measure);
    expect(svg).toContain("</tspan><tspan");
    expect(svg).not.toMatch(/<\/tspan>\s+<tspan/);
  });

  it("xml:space=preserve, così gli spazi iniziali restano dove sono", () => {
    const svg = nodesToSvg([text({ id: "t" }, "  ciao")], FULL, measure);
    expect(svg).toContain('xml:space="preserve"');
    expect(svg).toContain(">  ciao<");
  });

  it("allineamento a destra e al centro: sposta la x della riga", () => {
    const right = nodesToSvg(
      [text({ id: "t", x: 0, width: 100 }, "ciao", style({ align: "right" }))], FULL, measure,
    );
    expect(right).toContain('<tspan x="60"'); // 100 - 4*10
    const center = nodesToSvg(
      [text({ id: "t", x: 0, width: 100 }, "ciao", style({ align: "center" }))], FULL, measure,
    );
    expect(center).toContain('<tspan x="30"'); // (100 - 40) / 2
  });

  it("un testo VUOTO non produce nessun elemento (come il canvas non disegna nulla)", () => {
    const svg = nodesToSvg([text({ id: "t" }, "")], FULL, measure);
    expect(svg).not.toContain("<text");
  });

  it("una riga vuota non si disegna ma occupa il suo posto", () => {
    const svg = nodesToSvg([text({ id: "t", x: 0, y: 0 }, "a\n\nb")], FULL, measure);
    expect(svg).toContain('<tspan x="0" y="14.4">a</tspan>');
    // "b" è la TERZA riga: y = ascent + 2 * lineHeight = 14.4 + 38.4
    expect(svg).toContain('<tspan x="0" y="52.8">b</tspan>');
    expect(svg).not.toContain("<tspan></tspan>");
  });

  it("il contenuto viene ESCAPATO: &, < e > non rompono il documento", () => {
    const svg = nodesToSvg([text({ id: "t", width: 1000 }, 'a & b < c > "d"')], FULL, measure);
    expect(svg).toContain("a &amp; b &lt; c &gt; &quot;d&quot;");
    expect(svg).not.toContain("b < c");
  });

  it("anche la famiglia del font viene escapata (finisce in un attributo)", () => {
    const svg = nodesToSvg(
      [text({ id: "t" }, "x", style({ fontFamily: '"Comic" & co' }))], FULL, measure,
    );
    expect(svg).toContain('font-family="&quot;Comic&quot; &amp; co"');
  });
});

describe("nodesToSvg — i numeri", () => {
  it("niente code di virgola mobile", () => {
    const svg = nodesToSvg(
      [node({ id: "a", x: 0.1 + 0.2, width: 1 / 3 })],
      { x: 0, y: 0, width: 1 / 3, height: 1 },
      measure,
    );
    expect(svg).toContain('x="0.3"');
    expect(svg).toContain('width="0.333"');
    expect(svg).not.toContain("0.30000000000000004");
  });

  it("uno zero negativo si scrive 0", () => {
    const svg = nodesToSvg([node({ id: "a", x: -0 })], FULL, measure);
    expect(svg).toContain('x="0"');
    expect(svg).not.toContain('x="-0"');
  });
});

// --- immagini (traccia 3) ----------------------------------------------------
//
// Prima di questo giro un nodo immagine cadeva nel ramo di ripiego di
// `element()` e usciva come un <rect> GRIGIO: un file che non mostra quello che
// mostra il canvas, e senza un solo avviso. I due esiti possibili sono ora
// entrambi espliciti -- l'immagine, oppure il segnaposto.

function image(over: Partial<NodeLite> & { id: string }): NodeLite {
  return node({ kind: "image", width: 200, height: 100, image: { assetHash: "abc" }, ...over });
}

describe("nodesToSvg — immagini", () => {
  it("scrive un <image> con l'href risolto e il box del nodo", () => {
    const svg = nodesToSvg([image({ id: "i", x: 10, y: 20 })], FULL, measure, () => "data:image/png;base64,AAA");
    expect(svg).toContain("<image");
    expect(svg).toContain('href="data:image/png;base64,AAA"');
    expect(svg).toContain('x="10"');
    expect(svg).toContain('y="20"');
    expect(svg).toContain('width="200"');
    expect(svg).toContain('height="100"');
    // Nessun <rect> sotto: il segnaposto e l'immagine sono alternativi.
    expect(svg).not.toContain("<rect");
  });

  it("l'href viene chiesto per l'HASH del nodo", () => {
    const asked: string[] = [];
    nodesToSvg([image({ id: "i", image: { assetHash: "deadbeef" } })], FULL, measure, (h) => {
      asked.push(h);
      return null;
    });
    expect(asked).toEqual(["deadbeef"]);
  });

  it("l'opacità del nodo arriva sull'<image>", () => {
    const svg = nodesToSvg([image({ id: "i", opacity: 0.5 })], FULL, measure, () => "u");
    expect(svg).toContain('opacity="0.5"');
  });

  it("preserveAspectRatio=none: il box comanda, come sul canvas", () => {
    // Il canvas disegna con drawImage a quattro coordinate, cioè TIRA
    // l'immagine sul box. Il default SVG ("xMidYMid meet") la adatterebbe
    // dentro lasciando dei margini: stesso documento, due risultati diversi.
    const svg = nodesToSvg([image({ id: "i" })], FULL, measure, () => "u");
    expect(svg).toContain('preserveAspectRatio="none"');
  });

  it("un asset non risolvibile diventa il SEGNAPOSTO, non un rettangolo grigio", () => {
    const svg = nodesToSvg([image({ id: "i", x: 0, y: 0, width: 200, height: 100 })], FULL, measure, () => null);
    expect(svg).not.toContain("<image");
    // Un gruppo con il rettangolo e la croce: si vede che lì c'era un'immagine e
    // che manca, esattamente come sul canvas.
    expect(svg).toContain("<g");
    expect(svg).toContain("<rect");
    expect(svg).toContain("<path");
    expect(svg).toContain("M0 0L200 100");
  });

  it("senza risolutore ogni immagine è un segnaposto (default prudente)", () => {
    const svg = nodesToSvg([image({ id: "i" })], FULL, measure);
    expect(svg).not.toContain("<image");
    expect(svg).toContain("<g");
  });

  it("l'href è ESCAPATO: un URL con & non deve rompere il file", () => {
    const svg = nodesToSvg([image({ id: "i" })], FULL, measure, () => "/a?x=1&y=2");
    expect(svg).toContain('href="/a?x=1&amp;y=2"');
  });
});
