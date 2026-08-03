import { describe, it, expect } from "vitest";
import { fontString, layoutText, alignOffsetX, drawText, placeTextLines, textPaintBounds } from "./text";
import type { NodeLite, TextStyleLite } from "../store/types";

// Misura finta DETERMINISTICA: 10px per carattere. È il motivo per cui
// layoutText prende una funzione di misura invece del ctx -- il layout è
// verificabile in Node senza font reali né canvas, e in produzione riceve
// (s) => ctx.measureText(s).width.
const measure = (s: string) => s.length * 10;

function style(over: Partial<TextStyleLite> = {}): TextStyleLite {
  return { fontFamily: "Inter, sans-serif", fontSize: 16, fontWeight: "400", lineHeight: 1.2, align: "left", ...over };
}

// Stile tutto a zero: è ciò che toTextStyleLite produce da uno style assente
// (vedi store/types.ts), quindi il renderer lo incontra davvero.
const zeroStyle: TextStyleLite = { fontFamily: "", fontSize: 0, fontWeight: "", lineHeight: 0, align: "left" };

function textNode(over: Partial<NodeLite> = {}, content = "aaa bbb ccc", st: TextStyleLite = style()): NodeLite {
  return {
    id: "t", parentId: "page1", orderKey: "a0", name: "Text", visible: true, opacity: 1,
    x: 100, y: 50, width: 200, height: 40, rotation: 0,
    fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind: "text", cornerRadius: 0,
    text: { content, style: st },
    ...over,
  };
}

interface FillTextCall { text: string; x: number; y: number }

// jsdom non implementa il canvas 2D: il ctx è un duck-type che registra le
// chiamate. È anche il modo giusto di testare drawText, che va asserito sulle
// chiamate emesse, non sui pixel.
function fakeCtx() {
  const calls: FillTextCall[] = [];
  const state = {
    font: "", textBaseline: "", textAlign: "", fillStyle: "",
    measureText: (s: string) => ({ width: measure(s) }),
    fillText: (t: string, x: number, y: number) => { calls.push({ text: t, x, y }); },
  };
  return { state, calls, ctx: state as unknown as CanvasRenderingContext2D };
}

describe("fontString", () => {
  it("builds a CSS font shorthand from the style", () => {
    expect(fontString(style({ fontWeight: "700" }))).toBe("700 16px Inter, sans-serif");
  });

  it("fills in the renderer defaults for an all-zero style", () => {
    // Il modello conserva lo zero (vedi store/types.ts): i default sono del
    // RENDERER, ed è qui che vengono risolti.
    expect(fontString(zeroStyle)).toBe("400 16px Inter, sans-serif");
  });
});

describe("layoutText", () => {
  it("wraps greedily at maxWidth", () => {
    const l = layoutText(measure, "aaa bbb ccc", style(), 70);
    expect(l.lines).toEqual(["aaa bbb", "ccc"]);
    expect(l.width).toBe(70);
    expect(l.height).toBeCloseTo(2 * 19.2);
  });

  it("breaks a word wider than the box instead of looping forever", () => {
    const l = layoutText(measure, "aaaaaaaaaa", style(), 35);
    expect(l.lines).toEqual(["aaa", "aaa", "aaa", "a"]);
    expect(l.lines.join("")).toBe("aaaaaaaaaa");
  });

  it("terminates even when a single character does not fit", () => {
    // Il caso limite del loop infinito: maxWidth più stretto di un carattere.
    // Almeno un carattere per riga, sempre -- traboccare è accettabile,
    // non terminare no.
    const l = layoutText(measure, "abcde", style(), 5);
    expect(l.lines).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("keeps explicit newlines as lines, however short", () => {
    const l = layoutText(measure, "a\n\nb", style(), 1000);
    expect(l.lines).toEqual(["a", "", "b"]);
    expect(l.height).toBeCloseTo(3 * 19.2);
  });

  it("returns zero lines and zero height for empty content", () => {
    const l = layoutText(measure, "", style(), 200);
    expect(l.lines).toEqual([]);
    expect(l.height).toBe(0);
    expect(l.width).toBe(0);
    // L'altezza di riga resta risolta: serve al caret di un testo vuoto.
    expect(l.lineHeight).toBeCloseTo(19.2);
  });

  it("resolves the line-height multiplier and the baseline inside the line box", () => {
    const def = layoutText(measure, "a", style(), 100);
    expect(def.lineHeight).toBeCloseTo(19.2);          // 0 => 1.2 (default del proto)
    expect(def.ascent).toBeCloseTo(14.4);              // half-leading 1.6 + 0.8em
    const wide = layoutText(measure, "a", style({ lineHeight: 2 }), 100);
    expect(wide.lineHeight).toBeCloseTo(32);
    expect(wide.ascent).toBeCloseTo(20.8);             // half-leading 8 + 0.8em
    expect(wide.ascent).toBeLessThan(wide.lineHeight); // la baseline sta dentro la riga
  });

  it("does not wrap when maxWidth is zero or negative", () => {
    // Un nodo testo appena creato può avere width 0: meglio una riga lunga
    // che una riga per carattere.
    expect(layoutText(measure, "aaa bbb ccc", style(), 0).lines).toEqual(["aaa bbb ccc"]);
    expect(layoutText(measure, "aaa bbb ccc", style(), -5).lines).toEqual(["aaa bbb ccc"]);
  });

  it("lets a trailing space hang past the wrap width", () => {
    // Digitando "aaa bbb " lo spazio finale porterebbe la riga a 80 > 70 e
    // farebbe comparire una riga vuota sotto al testo a ogni parola. Come nei
    // browser, lo spazio finale non conta per il wrap (e non gonfia la
    // larghezza misurata).
    const l = layoutText(measure, "aaa bbb ", style(), 70);
    expect(l.lines).toEqual(["aaa bbb "]);
    expect(l.width).toBe(70);
  });

  it("keeps the whitespace that opens a line", () => {
    // Una riga "vuota" e una riga "su cui non è ancora stato piazzato niente"
    // non sono la stessa cosa: confonderle faceva sparire gli spazi iniziali,
    // cioè l'indentazione appena digitata dall'utente.
    expect(layoutText(measure, "  aaa", style(), 1000).lines).toEqual(["  aaa"]);
    expect(layoutText(measure, "aaa\n  bbb", style(), 1000).lines).toEqual(["aaa", "  bbb"]);
    expect(layoutText(measure, "aaa  bbb", style(), 1000).lines).toEqual(["aaa  bbb"]);
  });

  it("keeps a line made only of spaces", () => {
    const l = layoutText(measure, "  ", style(), 1000);
    expect(l.lines).toEqual(["  "]);
    expect(l.width).toBe(0); // gli spazi non si disegnano: larghezza 0
    expect(l.height).toBeCloseTo(19.2);
  });

  it("still terminates when a line opens with spaces", () => {
    // Gli spazi iniziali conservati non devono mandare in loop il breaker.
    // Delle due spaziature iniziali ne resta una: quella su cui avviene il
    // wrap viene consumata dal wrap stesso, come nei browser.
    const l = layoutText(measure, "  aaaaaaaaaa", style(), 35);
    expect(l.lines).toEqual([" ", "aaa", "aaa", "aaa", "a"]);
  });

  it("wraps each paragraph independently", () => {
    const l = layoutText(measure, "aaa bbb\nccc ddd eee", style(), 70);
    expect(l.lines).toEqual(["aaa bbb", "ccc ddd", "eee"]);
  });
});

describe("alignOffsetX", () => {
  it("computes the per-line x offset for each alignment", () => {
    expect(alignOffsetX("left", 70, 200)).toBe(0);
    expect(alignOffsetX("center", 70, 200)).toBe(65);
    expect(alignOffsetX("right", 70, 200)).toBe(130);
  });

  it("falls back to left when the box has no width", () => {
    expect(alignOffsetX("right", 70, 0)).toBe(0);
    expect(alignOffsetX("center", 70, -10)).toBe(0);
  });
});

describe("drawText", () => {
  it("draws one fillText per line with an explicit baseline", () => {
    const f = fakeCtx();
    drawText(f.ctx, textNode({ width: 70 }));
    expect(f.state.font).toBe("400 16px Inter, sans-serif");
    // Mai il default: `textBaseline` cambia fra browser, e la y delle righe
    // è calcolata dal layout assumendo la baseline alfabetica.
    expect(f.state.textBaseline).toBe("alphabetic");
    expect(f.calls.map((c) => c.text)).toEqual(["aaa bbb", "ccc"]);
    expect(f.calls[0].x).toBe(100);
    expect(f.calls[0].y).toBeCloseTo(50 + 14.4);
    expect(f.calls[1].y).toBeCloseTo(50 + 14.4 + 19.2);
  });

  it("offsets each line for center alignment", () => {
    const f = fakeCtx();
    drawText(f.ctx, textNode({ width: 200 }, "aaa bbb\nc", style({ align: "center" })));
    expect(f.calls[0].x).toBe(100 + (200 - 70) / 2);
    expect(f.calls[1].x).toBe(100 + (200 - 10) / 2);
  });

  it("draws nothing for a non-text node or empty content", () => {
    const rect = fakeCtx();
    drawText(rect.ctx, { ...textNode(), kind: "rect", text: undefined });
    expect(rect.calls).toEqual([]);

    const empty = fakeCtx();
    drawText(empty.ctx, textNode({}, ""));
    expect(empty.calls).toEqual([]);
  });

  it("does not paint a line of only spaces but keeps its slot", () => {
    // Gli spazi si conservano nel layout (sono contenuto) ma non si disegnano.
    const f = fakeCtx();
    drawText(f.ctx, textNode({ width: 1000 }, "a\n  \nb"));
    expect(f.calls.map((c) => c.text)).toEqual(["a", "b"]);
    expect(f.calls[1].y - f.calls[0].y).toBeCloseTo(2 * 19.2);
  });

  it("skips empty lines but keeps their vertical slot", () => {
    const f = fakeCtx();
    drawText(f.ctx, textNode({ width: 1000 }, "a\n\nb"));
    expect(f.calls.map((c) => c.text)).toEqual(["a", "b"]);
    expect(f.calls[1].y - f.calls[0].y).toBeCloseTo(2 * 19.2);
  });
});

describe("placeTextLines", () => {
  it("reports the painted width of each line", () => {
    // La larghezza serve a chi deve sapere quanto spazio occupa il testo
    // (textPaintBounds): senza, la misurerebbe una seconda volta.
    const lines = placeTextLines(measure, textNode({ width: 70 }));
    expect(lines.map((l) => l.text)).toEqual(["aaa bbb", "ccc"]);
    expect(lines.map((l) => l.width)).toEqual([70, 30]);
  });

  it("measures the PAINTED text, without the trailing spaces", () => {
    const lines = placeTextLines(measure, textNode({ width: 1000 }, "aaa   "));
    expect(lines[0].width).toBe(30);
  });
});

// Il box del modello non limita il disegno del testo: drawText piazza la riga i
// a y = n.y + ascent + i * lineHeight senza guardare n.height, drawScene non
// ritaglia, e nessuno riscrive l'altezza misurata dentro al nodo. Chi disegna
// se ne accorge appena (il canvas è grande quanto la finestra); chi RITAGLIA --
// l'export, che dimensiona il file sui bounds -- butterebbe via il testo di
// sotto in silenzio.
describe("textPaintBounds", () => {
  it("unites the model box with the lines the layout actually paints", () => {
    // Box di UNA riga (19.2) e due righe di contenuto: il caso di ogni giorno,
    // perché un nodo creato con un click nasce alto una riga.
    const b = textPaintBounds(measure, textNode({ x: 0, y: 0, width: 70, height: 19.2 }));
    expect(b).toEqual({ x: 0, y: 0, width: 70, height: 38.4 });
  });

  it("keeps a box that is larger than the text", () => {
    // Unione, non sostituzione: un box trascinato dall'utente resta parte di
    // ciò che si vede, quindi di ciò che si esporta.
    const b = textPaintBounds(measure, textNode({ x: 0, y: 0, width: 200, height: 100 }, "a"));
    expect(b).toEqual({ x: 0, y: 0, width: 200, height: 100 });
  });

  it("follows a line that overflows to the right when there is no wrap width", () => {
    // Larghezza 0 = nessun wrap (layoutText): la riga è lunga quanto è.
    const b = textPaintBounds(measure, textNode({ x: 0, y: 0, width: 0, height: 0 }, "ciao"));
    expect(b).toEqual({ x: 0, y: 0, width: 40, height: 19.2 });
  });

  it("follows a right-aligned overflow to the LEFT of the box", () => {
    // breakWord non rifiuta mai un carattere solo (o non terminerebbe): un
    // glifo più largo del box trabocca, e con align=right trabocca a sinistra.
    const b = textPaintBounds(
      measure,
      textNode({ x: 0, y: 0, width: 5, height: 0 }, "ab", style({ align: "right" })),
    );
    expect(b).toEqual({ x: -5, y: 0, width: 10, height: 38.4 });
  });

  it("is the plain box for an empty text and for a shape", () => {
    const box = { x: 1, y: 2, width: 3, height: 4 };
    expect(textPaintBounds(measure, textNode({ ...box }, ""))).toEqual(box);
    expect(textPaintBounds(measure, { ...textNode({ ...box }), kind: "rect", text: undefined }))
      .toEqual(box);
  });
});
