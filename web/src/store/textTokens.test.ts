import { describe, it, expect } from "vitest";
import { deriveMasters } from "@/store/masters";
import { resolveScene } from "@/store/variables";
import { deriveTextTokens, headingsOf, indexEntries, rewriteTokens, runningHeads, substituteVariables, superscript, tokensOf } from "@/store/textTokens";
import { emptyScene, type NodeLite, type PageLite, type SceneState, type TextStyleDefLite, type TextStyleLite } from "@/store/types";

const STYLE: TextStyleLite = { fontFamily: "", fontSize: 10, fontWeight: "", lineHeight: 1.2, align: "left" };
const text = (id: string, parentId: string, content: string, over: Partial<NodeLite> = {}, paragraphStyles?: string[]): NodeLite => ({
  id, parentId, orderKey: "a" + id, name: id, visible: true, opacity: 1, x: 0, y: 0, width: 200, height: 40, rotation: 0,
  fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind: "text", cornerRadius: 0, clipsContent: false,
  text: { content, style: STYLE, ...(paragraphStyles ? { paragraphStyles } : {}) }, ...over,
});
const h = (level: number): TextStyleDefLite => ({ id: `h${level}`, name: `H${level}`, style: STYLE, outlineLevel: level });

function scene(pages: PageLite[], nodes: NodeLite[], styles: TextStyleDefLite[] = []): SceneState {
  let s: SceneState = { ...emptyScene("d", "My Book"), pages, textStyles: Object.fromEntries(styles.map((d) => [d.id, d])) };
  for (const n of nodes) s = { ...s, nodes: s.nodes.set(n.id, n) };
  return s;
}

describe("tokens", () => {
  it("finds footnotes and index markers", () => {
    expect(tokensOf("a[^one]b[#term]c")).toEqual([
      { kind: "footnote", text: "one", at: 1, end: 7 }, { kind: "index", text: "term", at: 8, end: 15 },
    ]);
    expect(tokensOf("no [^ unclosed or [# also")).toEqual([]);
  });
  it("writes numbers as superscripts", () => {
    expect(superscript(12)).toBe("¹²");
  });
  it("rewrites tokens and moves the runs with their characters", () => {
    const t = rewriteTokens({ content: "ab[^x]cd", style: STYLE, runs: [{ start: 0, end: 1, styleId: "r" }, { start: 6, end: 8, styleId: "r2" }, { start: 3, end: 5, styleId: "inside" }] }, () => "¹");
    expect(t.content).toBe("ab¹cd");
    expect(t.runs).toEqual([{ start: 0, end: 1, styleId: "r" }, { start: 3, end: 5, styleId: "r2" }]);
  });
});

describe("footnotes", () => {
  const s = scene([{ id: "p1", name: "1", width: 300, height: 400, marginLeft: 20, marginRight: 20, marginBottom: 30 }, { id: "p2", name: "2", width: 300, height: 400 }], [
    text("a", "p1", "First[^Note one] and second[^Note two].", { y: 10 }),
    text("b", "p2", "Third[^Note three]", { y: 10 }),
  ]);
  it("numbers them through the document and draws them as superscripts", () => {
    const out = deriveTextTokens(s);
    expect(out.nodes.get("a")!.text!.content).toBe("First¹ and second².");
    expect(out.nodes.get("b")!.text!.content).toBe("Third³");
    // The raw document keeps its markers.
    expect(s.nodes.get("a")!.text!.content).toContain("[^Note one]");
  });
  it("sets the notes at the foot of each page, above the bottom margin", () => {
    const out = deriveTextTokens(s);
    const p1 = out.nodes.get("p1~fn")!;
    expect(p1.text!.content).toBe("¹ Note one\n² Note two");
    expect(p1.x).toBe(20);
    expect(p1.y + p1.height).toBeCloseTo(370);
    expect(p1.fromMaster).toBe(true);
    expect(out.nodes.get("p1~fn-rule")).toBeDefined();
    expect(out.nodes.get("p2~fn")!.text!.content).toBe("³ Note three");
  });
  it("returns the scene itself without markers", () => {
    const plain = scene([{ id: "p1", name: "1" }], [text("a", "p1", "nothing here")]);
    expect(deriveTextTokens(plain)).toBe(plain);
  });
  it("removes index markers from what is drawn", () => {
    const x = scene([{ id: "p1", name: "1" }], [text("a", "p1", "A word[#word] here")]);
    expect(deriveTextTokens(x).nodes.get("a")!.text!.content).toBe("A word here");
    expect(deriveTextTokens(x).nodes.get("p1~fn")).toBeUndefined();
  });
});

describe("headings, running heads and variables", () => {
  const pages: PageLite[] = [{ id: "m", name: "M", isMaster: true }, { id: "p1", name: "1", masterId: "m" }, { id: "p2", name: "2", masterId: "m" }, { id: "p3", name: "3", masterId: "m" }];
  const s = scene(pages, [
    text("t1", "p1", "Intro\nbody\nA section", { y: 0 }, ["h1", "", "h2"]),
    text("t2", "p2", "just text", { y: 0 }),
    text("t3", "p3", "Chapter two[^n]\nmore", { y: 0 }, ["h1", ""]),
    text("run", "m", "<h1> · <h2> · page <#> of <pages> · <doc>", { y: 0 }),
  ], [h(1), h(2)]);
  it("lists the headings in reading order, without markers", () => {
    expect(headingsOf(s).map((x) => [x.level, x.text, x.pageId])).toEqual([[1, "Intro", "p1"], [2, "A section", "p1"], [1, "Chapter two", "p3"]]);
  });
  it("carries the running head to the pages without a heading and resets deeper levels", () => {
    const heads = runningHeads(s);
    expect(heads.get("p1")).toEqual({ 1: "Intro", 2: "A section" });
    expect(heads.get("p2")).toEqual({ 1: "Intro", 2: "A section" });
    expect(heads.get("p3")).toEqual({ 1: "Chapter two" });
  });
  it("fills the variables of a master's text on each page", () => {
    const out = deriveMasters(s);
    expect(out.nodes.get("p1~run")!.text!.content).toBe("Intro · A section · page 1 of 3 · My Book");
    expect(out.nodes.get("p3~run")!.text!.content).toBe("Chapter two ·  · page 3 of 3 · My Book");
    expect(substituteVariables("<h3>|<unknown>", { name: "x" }, "1", 1, {})).toBe("|<unknown>");
  });
  it("draws through resolveScene", () => {
    expect(resolveScene(s).nodes.get("p2~run")!.text!.content).toContain("Intro");
  });
});

describe("index entries", () => {
  it("lists the terms alphabetically with the pages (in their numbering) they are on", () => {
    const s = scene([{ id: "p1", name: "1", numberStyle: "i" }, { id: "p2", name: "2" }], [
      text("a", "p1", "Zebra[#zebra] and apple[#apple]"), text("b", "p2", "More apple[#apple] and [#zebra]"), text("c", "p2", "[#] empty", { y: 50 }),
    ]);
    expect(indexEntries(s)).toEqual([{ term: "apple", level: 1, label: "apple", pages: ["i", "ii"] }, { term: "zebra", level: 1, label: "zebra", pages: ["i", "ii"] }]);
  });
});
