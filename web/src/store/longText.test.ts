import { describe, it, expect } from "vitest";
import { deriveTextTokens, destinationsOf, editorialNotes, endnoteEntries, headingsOf, hideConditions, indexEntries, tokensOf, visibleText } from "@/store/textTokens";
import { emptyScene, type NodeLite, type PageLite, type SceneState, type TextStyleDefLite, type TextStyleLite } from "@/store/types";

const STYLE: TextStyleLite = { fontFamily: "", fontSize: 10, fontWeight: "", lineHeight: 1.2, align: "left" };
const text = (id: string, parentId: string, content: string, over: Partial<NodeLite> = {}, extra: Partial<NonNullable<NodeLite["text"]>> = {}): NodeLite => ({
  id, parentId, orderKey: "a" + id, name: id, visible: true, opacity: 1, x: 0, y: 0, width: 200, height: 40, rotation: 0,
  fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind: "text", cornerRadius: 0, clipsContent: false, text: { content, style: STYLE, ...extra }, ...over,
});
function scene(pages: PageLite[], nodes: NodeLite[], over: Partial<SceneState> = {}): SceneState {
  let s: SceneState = { ...emptyScene("d", "Doc"), pages, ...over };
  for (const n of nodes) s = { ...s, nodes: s.nodes.set(n.id, n) };
  return s;
}
const P = (n: number): PageLite[] => Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: String(i + 1) }));
const contentOf = (s: SceneState, id: string) => deriveTextTokens(s).nodes.get(id)!.text!.content;

describe("the new tokens", () => {
  it("are found with their kinds", () => {
    expect(tokensOf("a[=intro]b[>intro]c[>intro:text]d[*end]e[!todo]f[?Web]g[/?]").map((t) => [t.kind, t.text, t.format])).toEqual([
      ["dest", "intro", undefined], ["xref", "intro", "page"], ["xref", "intro", "text"], ["endnote", "end", undefined], ["note", "todo", undefined], ["cond", "Web", undefined], ["endcond", "", undefined],
    ]);
    expect(tokensOf("[>bad name] [=] [?] [>x:other]")).toEqual([]);
  });
});

describe("cross-references", () => {
  const s = scene(P(3), [
    text("a", "p1", "See page [>intro] and “[>intro:text]”, also [>missing]."),
    text("b", "p3", "[=intro]The Beginning of Everything\nnext paragraph", {}),
  ], { pages: [{ id: "p1", name: "1" }, { id: "p2", name: "2" }, { id: "p3", name: "3", sectionStart: true, numberStyle: "I", numberStart: 5 }] });

  it("find the page and the paragraph of an anchor, in the page's own numbering", () => {
    expect(destinationsOf(s).get("intro")).toEqual({ pageId: "p3", paragraph: "The Beginning of Everything" });
    expect(contentOf(s, "a")).toBe("See page V and “The Beginning of Everything”, also ??.");
  });
  it("follow the anchor when it moves to another page", () => {
    const moved = { ...s, nodes: s.nodes.set("b", { ...s.nodes.get("b")!, parentId: "p2" }) };
    expect(contentOf(moved, "a")).toContain("See page 2 ");
  });
  it("draw nothing for the anchor itself", () => {
    expect(contentOf(s, "b")).toBe("The Beginning of Everything\nnext paragraph");
  });
});

describe("endnotes and editorial notes", () => {
  const s = scene(P(2), [
    text("a", "p1", "First[*Source A] and second[*Source B][!check this] here"),
    text("b", "p2", "Third[*Source C]"),
  ]);
  it("number the references in their own sequence and list the notes", () => {
    expect(contentOf(s, "a")).toBe("First¹ and second² here");
    expect(contentOf(s, "b")).toBe("Third³");
    expect(endnoteEntries(s)).toEqual([{ n: 1, text: "Source A" }, { n: 2, text: "Source B" }, { n: 3, text: "Source C" }]);
  });
  it("keep editorial notes out of the text and list them with their context", () => {
    expect(contentOf(s, "a")).not.toContain("check this");
    const notes = editorialNotes(s);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ nodeId: "a", pageId: "p1", text: "check this", at: s.nodes.get("a")!.text!.content.indexOf("[!") });
    expect(notes[0]!.context.endsWith("and second")).toBe(true);
  });
});

describe("conditional text", () => {
  const conditions = [{ name: "Print", visible: true }, { name: "Web", visible: false }];
  const t = (content: string, extra = {}) => ({ content, style: STYLE, ...extra });

  it("hides the span of a hidden condition and keeps the others", () => {
    const hidden = new Set(["Web"]);
    expect(hideConditions(t("A [?Web]online only[/?]B [?Print]for print[/?]C"), hidden).content).toBe("A B [?Print]for print[/?]C");
    expect(hideConditions(t("nothing"), hidden).content).toBe("nothing");
    expect(hideConditions(t("a[?Web]b[/?]c"), new Set()).content).toBe("a[?Web]b[/?]c");
  });
  it("handles nesting and an unclosed span", () => {
    const hidden = new Set(["Web"]);
    expect(hideConditions(t("a[?Print]b[?Web]c[/?]d[/?]e"), hidden).content).toBe("a[?Print]bd[/?]e");
    expect(hideConditions(t("a[?Web]b[?Print]c[/?]d[/?]e"), hidden).content).toBe("ae");
    expect(hideConditions(t("keep[?Web] to the end"), hidden).content).toBe("keep");
  });
  it("moves style runs and merges the paragraphs a hidden break swallows", () => {
    const out = hideConditions(t("one\n[?Web]two\nthree[/?] four\nfive", { runs: [{ start: 4 + 22, end: 4 + 26, styleId: "r" }], paragraphStyles: ["a", "b", "c", "d"] }), new Set(["Web"]));
    expect(out.content).toBe("one\n four\nfive");
    expect(out.paragraphStyles).toEqual(["a", "b", "d"]);
  });
  it("applies in the drawn scene, drops the markers of visible conditions, and leaves headings and the index right", () => {
    const heading: TextStyleDefLite = { id: "h1", name: "H", style: STYLE, outlineLevel: 1 };
    const s = scene(P(1), [
      text("a", "p1", "Intro[?Print] (print)[/?][?Web] (web)[/?]\nHidden heading[?Web]x[/?]", {}, { paragraphStyles: ["", "h1"] }),
      text("b", "p1", "Term[?Web][#secret][/?][#shown]", { y: 100 }),
    ], { settings: { conditions }, textStyles: { h1: heading } });
    expect(contentOf(s, "a")).toBe("Intro (print)\nHidden heading");
    expect(headingsOf(s).map((x) => x.text)).toEqual(["Hidden heading"]);
    expect(indexEntries(s).map((e) => e.term)).toEqual(["shown"]);
    expect(visibleText(s, s.nodes.get("a")!.text!).content).toContain("Intro[?Print] (print)[/?]");
  });
  it("shows everything when every condition is visible or undefined", () => {
    const s = scene(P(1), [text("a", "p1", "x[?Mystery]y[/?]z")], { settings: { conditions: [{ name: "Print", visible: false }] } });
    expect(contentOf(s, "a")).toBe("xyz");
  });
});

describe("index sub-entries", () => {
  it("nest under their parent, which is listed even with no pages of its own", () => {
    const s = scene(P(2), [
      text("a", "p1", "[#Fruit:Apple]x[#Fruit:Pear]y[#Fruit]z[#Veg:Kale:Curly]"),
      text("b", "p2", "[#Fruit:Apple]"),
    ]);
    expect(indexEntries(s)).toEqual([
      { term: "Fruit", level: 1, label: "Fruit", pages: ["1"] },
      { term: "Fruit:Apple", level: 2, label: "Apple", pages: ["1", "2"] },
      { term: "Fruit:Pear", level: 2, label: "Pear", pages: ["1"] },
      { term: "Veg", level: 1, label: "Veg", pages: [] },
      { term: "Veg:Kale", level: 2, label: "Kale", pages: [] },
      { term: "Veg:Kale:Curly", level: 3, label: "Curly", pages: ["1"] },
    ]);
  });
});
