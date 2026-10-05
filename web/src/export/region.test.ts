import { describe, it, expect } from "vitest";
import { exportRegion } from "./region";
import { emptyScene } from "../store/types";
import type { MeasureText } from "../renderer/text";
import type { NodeLite, SceneState, TextStyleLite } from "../store/types";

// FAKE and deterministic measure: 10 units per character, as in svg.test.ts.
// Measuring glyphs for real would need a canvas, and the result would change from
// font to font -- but with NO measure it is impossible to know where the
// text ends, which is half of this module's job.
const measure: MeasureText = (s) => s.length * 10;

function node(over: Partial<NodeLite> & { id: string }): NodeLite {
  return {
    parentId: "page1", orderKey: "a1", name: over.id, visible: true, opacity: 1,
    x: 0, y: 0, width: 10, height: 10, rotation: 0,
    fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false,
    ...over,
  };
}

function style(over: Partial<TextStyleLite> = {}): TextStyleLite {
  return { fontFamily: "", fontSize: 16, fontWeight: "", lineHeight: 0, align: "left", ...over };
}

// A text node. The default is the box of ONE node just created with a click:
// wrap width 200 and height of ONE line (16 * 1.2 = 19.2), that is
// exactly what the user finds themselves writing with.
function text(over: Partial<NodeLite> & { id: string }, content: string, s = style()): NodeLite {
  return node({ kind: "text", width: 200, height: 19.2, text: { content, style: s }, ...over });
}

function sceneWith(...nodes: NodeLite[]): SceneState {
  const s = emptyScene("doc", "Untitled");
  for (const n of nodes) s.nodes = s.nodes.set(n.id, n);
  return s;
}

describe("exportRegion", () => {
  it("the whole page: all visible nodes, in draw order", () => {
    const s = sceneWith(
      node({ id: "above", orderKey: "a2", x: 100, y: 100 }),
      node({ id: "below", orderKey: "a1", x: 0, y: 0 }),
    );
    const r = exportRegion(s, [], "page", measure);
    expect(r).not.toBeNull();
    expect(r!.nodes.map((n) => n.id)).toEqual(["below", "above"]);
    expect(r!.bounds).toEqual({ x: 0, y: 0, width: 110, height: 110 });
  });

  it("the selection: only the selected nodes, with THEIR bounds", () => {
    const s = sceneWith(
      node({ id: "a", x: 0, y: 0 }),
      node({ id: "b", x: 100, y: 200, orderKey: "a2" }),
    );
    const r = exportRegion(s, ["b"], "selection", measure);
    expect(r!.nodes.map((n) => n.id)).toEqual(["b"]);
    // The bounds are those of WHAT WAS EXPORTED, not of the page.
    expect(r!.bounds).toEqual({ x: 100, y: 200, width: 10, height: 10 });
  });

  it("the selection stays in DRAW order, not in the order in which it was clicked", () => {
    const s = sceneWith(
      node({ id: "below", orderKey: "a1" }),
      node({ id: "above", orderKey: "a2" }),
    );
    const r = exportRegion(s, ["above", "below"], "selection", measure);
    expect(r!.nodes.map((n) => n.id)).toEqual(["below", "above"]);
  });

  it("ignores selected ids that no longer exist in the scene", () => {
    const s = sceneWith(node({ id: "a" }));
    const r = exportRegion(s, ["a", "vanished"], "selection", measure);
    expect(r!.nodes.map((n) => n.id)).toEqual(["a"]);
  });

  it("an INVISIBLE node is not exported and does not widen the region", () => {
    const s = sceneWith(
      node({ id: "visible", x: 0, y: 0 }),
      node({ id: "hidden", x: 1000, y: 1000, visible: false }),
    );
    const r = exportRegion(s, [], "page", measure);
    expect(r!.nodes.map((n) => n.id)).toEqual(["visible"]);
    expect(r!.bounds).toEqual({ x: 0, y: 0, width: 10, height: 10 });
  });

  it("a DEGENERATE shape does not widen the region: the renderer does not draw it", () => {
    // A very distant 0x0 rectangle: drawScene skips it (isPaintable), so
    // including it in the union would produce a huge, almost empty image,
    // with the real content squashed into a corner.
    const s = sceneWith(
      node({ id: "vero", x: 0, y: 0, width: 20, height: 20 }),
      node({ id: "degenere", x: 5000, y: 5000, width: 0, height: 0 }),
    );
    const r = exportRegion(s, [], "page", measure);
    expect(r!.nodes.map((n) => n.id)).toEqual(["vero"]);
    expect(r!.bounds).toEqual({ x: 0, y: 0, width: 20, height: 20 });
  });

  it("a TEXT without a measured height stays exportable (same exception as the renderer)", () => {
    const s = sceneWith(text({ id: "t", width: 100, height: 0 }, "ciao"));
    expect(exportRegion(s, [], "page", measure)!.nodes.map((n) => n.id)).toEqual(["t"]);
  });

  it("null when there is nothing to export", () => {
    expect(exportRegion(emptyScene("doc", "Untitled"), [], "page", measure)).toBeNull();
    expect(exportRegion(sceneWith(node({ id: "a" })), [], "selection", measure)).toBeNull();
    expect(exportRegion(sceneWith(node({ id: "a", visible: false })), [], "page", measure)).toBeNull();
  });

  it("the reduced scene contains EXACTLY the exported nodes", () => {
    // It is the scene that ends up in drawScene: if an unselected node stayed
    // inside, the selection export would draw that one too.
    const s = sceneWith(node({ id: "a" }), node({ id: "b", orderKey: "a2" }));
    const r = exportRegion(s, ["b"], "selection", measure);
    expect([...r!.scene.nodes.ids()]).toEqual(["b"]);
    // the rest of the document's identity stays the real one
    expect(r!.scene.id).toBe("doc");
    expect(r!.scene.pages).toEqual(s.pages);
  });
});

// The region is what the file CROPS: what stays outside it vanishes from the
// PNG (canvas too small) and from the SVG (outside the viewBox, which the root
// crops). The model's box is NOT a limit for text drawing --
// drawText does not look at it, drawScene does not clip, and nobody rewrites into the node
// the measured height -- so taking it as good would throw away text that
// on screen is seen, silently and with a file that looks successful.
describe("exportRegion — text that overflows its box", () => {
  it("two lines in a box of ONE: the region widens downward, it does not crop", () => {
    // The everyday case: a node created with a click is one line tall
    // (19.2), and going to a new line the first time is enough to leave it.
    const s = sceneWith(text({ id: "t", x: 0, y: 0, width: 100 }, "abcdefghij klm"));
    const r = exportRegion(s, [], "page", measure);
    // two lines of 19.2, not the box's height
    expect(r!.bounds).toEqual({ x: 0, y: 0, width: 100, height: 38.4 });
  });

  it("the region follows the lines even when there are many", () => {
    const s = sceneWith(text({ id: "t", x: 5, y: 7, width: 100 }, "a\nb\nc\nd\ne"));
    expect(exportRegion(s, [], "page", measure)!.bounds).toEqual({
      x: 5, y: 7, width: 100, height: 5 * 19.2,
    });
  });

  it("a box LARGER than the text stays whole: it is a union, not a replacement", () => {
    // A box dragged by the user (or left so after deleting
    // lines) is part of what is exported, exactly as on screen.
    const s = sceneWith(text({ id: "t", width: 200, height: 100 }, "ciao"));
    expect(exportRegion(s, [], "page", measure)!.bounds).toEqual({
      x: 0, y: 0, width: 200, height: 100,
    });
  });

  it("without a wrap width the text does not wrap, and the region follows it to the RIGHT", () => {
    // Width 0 = no wrap (layoutText): the line leaves the box as far as it is
    // long. With the model's box the file would be zero wide.
    const s = sceneWith(text({ id: "t", width: 0 }, "ciao"));
    expect(exportRegion(s, [], "page", measure)!.bounds).toEqual({
      x: 0, y: 0, width: 40, height: 19.2,
    });
  });

  it("with RIGHT alignment the overflow sticks out to the left of the box", () => {
    // A glyph wider than the box is not broken (breakWord never rejects
    // a single character) and with align=right it ends up at NEGATIVE x relative to the
    // box: the region must start from there, or the first column of pixels is missing.
    const s = sceneWith(text({ id: "t", x: 0, width: 5 }, "ab", style({ align: "right" })));
    expect(exportRegion(s, [], "page", measure)!.bounds).toEqual({
      x: -5, y: 0, width: 10, height: 38.4,
    });
  });

  it("an EMPTY text is its box and nothing else", () => {
    // No line to measure: nothing to add, and no invented bounds.
    const s = sceneWith(text({ id: "t", width: 200, height: 19.2 }, ""));
    expect(exportRegion(s, [], "page", measure)!.bounds).toEqual({
      x: 0, y: 0, width: 200, height: 19.2,
    });
  });

  it("text widens the region together with shapes too", () => {
    const s = sceneWith(
      node({ id: "r", x: 0, y: 0, width: 50, height: 50 }),
      text({ id: "t", orderKey: "a2", x: 0, y: 40, width: 100 }, "abcdefghij klm"),
    );
    // the text reaches 40 + 38.4, well beyond its box (40 + 19.2)
    expect(exportRegion(s, [], "page", measure)!.bounds).toEqual({
      x: 0, y: 0, width: 100, height: 40 + 38.4,
    });
  });

  it("SHAPES ask for no measure: their box is all they paint", () => {
    // If one day the computation also measured rectangles, this test would
    // say so right away instead of letting a useless measure slip through (and, in
    // production, a canvas created for nothing).
    const boom: MeasureText = () => { throw new Error("no measure for a shape"); };
    const s = sceneWith(node({ id: "r" }), node({ id: "e", kind: "ellipse", orderKey: "a2" }));
    expect(exportRegion(s, [], "page", boom)!.bounds).toEqual({ x: 0, y: 0, width: 10, height: 10 });
  });
});
