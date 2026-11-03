import { describe, it, expect } from "vitest";
import { compile, findAll, replaceOps } from "@/store/findReplace";
import { expandReplacement, translateGrep, translateReplacement } from "@/store/grep";
import { emptyScene, type NodeLite, type SceneState, type TextStyleLite } from "@/store/types";

const STYLE: TextStyleLite = { fontFamily: "", fontSize: 12, fontWeight: "", lineHeight: 1.2, align: "left" };
const text = (id: string, content: string): NodeLite => ({
  id, parentId: "p1", orderKey: "a" + id, name: id, visible: true, opacity: 1, x: 0, y: 0, width: 300, height: 40, rotation: 0,
  fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind: "text", cornerRadius: 0, clipsContent: false, text: { content, style: STYLE },
});
const doc = (content: string): SceneState => {
  const s = emptyScene("d", "d");
  return { ...s, pages: [{ id: "p1", name: "1" }], nodes: s.nodes.set("t", text("t", content)) };
};
const found = (content: string, query: string, extra = {}) => {
  const r = findAll(doc(content), { query, grep: true, matchCase: true, ...extra });
  if (!Array.isArray(r)) throw new Error(r.error);
  return r.map((m) => m.text);
};

describe("GREP dialect", () => {
  it("translates the tilde characters", () => {
    expect(found("a\u2014b \u2013 c\u00a0d\u2003e", "~_")).toEqual(["\u2014"]);
    expect(found("a\u2014b \u2013 c\u00a0d\u2003e", "~=")).toEqual(["\u2013"]);
    expect(found("c\u00a0d", "c~sd")).toEqual(["c\u00a0d"]);
    expect(found("x\u2003y\u2002z", "~m")).toEqual(["\u2003"]);
    expect(found("a~b", "a~~b")).toEqual(["a~b"]);
  });
  it("knows case classes, digits and Unicode word characters", () => {
    expect(found("Hello World ab", "\\u\\l+")).toEqual(["Hello", "World"]);
    expect(found("città 42", "\\w+")).toEqual(["città", "42"]);
    expect(found("a1 b22", "\\d+")).toEqual(["1", "22"]);
    expect(found("a1 b22", "[[:digit:]]+")).toEqual(["1", "22"]);
    expect(found("Ab, c!", "[[:punct:]]")).toEqual([",", "!"]);
    expect(found("Ab cD", "[[:upper:]]")).toEqual(["A", "D"]);
  });
  it("matches paragraph starts and ends, and word edges", () => {
    expect(found("one two\nthree four", "^\\w+")).toEqual(["one", "three"]);
    expect(found("one two\nthree four", "\\w+$")).toEqual(["two", "four"]);
    expect(found("one\ntwo", "\\r")).toEqual(["\n"]);
    expect(found("cat concat", "\\<cat")).toEqual(["cat"]);
    expect(found("cat concat", "cat\\>")).toEqual(["cat", "cat"]);
  });
  it("supports hex characters, horizontal space and lookaround", () => {
    expect(found("a\u00a0b c", "\\x{00A0}")).toEqual(["\u00a0"]);
    expect(found("a\u00a0b c\td", "\\h")).toEqual(["\u00a0", " ", "\t"]);
    expect(found("price 10 and 20", "(?<=price )\\d+")).toEqual(["10"]);
  });
  it("honours a leading (?i) and is case sensitive otherwise", () => {
    expect(found("Cat cat", "cat")).toEqual(["cat"]);
    expect(found("Cat cat", "(?i)cat")).toEqual(["Cat", "cat"]);
    expect(found("Cat cat", "cat", { matchCase: false })).toEqual(["Cat", "cat"]);
  });
  it("reports what it does not support", () => {
    for (const q of ["~q", "\\q", "a++", "[abc", "[[:foo:]]", "(?z)", "\\x{zz}", "x\\"]) {
      const r = compile({ query: q, grep: true });
      expect(r && "error" in r, q).toBe(true);
    }
  });
  it("keeps escaped syntax literal", () => {
    expect(found("a.b axb", "a\\.b")).toEqual(["a.b"]);
    expect(found("a-b", "a\\-b")).toEqual(["a-b"]);
    expect(found("a+b", "a\\+b")).toEqual(["a+b"]);
  });
  it("passes plain JavaScript syntax through", () => {
    expect(translateGrep("(a|b)+?c{2}").source).toBe("(a|b)+?c{2}");
  });
});

describe("GREP replacement", () => {
  it("expands $0 and groups, and the tilde characters", () => {
    expect(expandReplacement(translateReplacement("[$0] $2-$1"), "ab", ["a", "b"])).toBe("[ab] b-a");
    expect(translateReplacement("a~_b~mc")).toBe("a\u2014b\u2003c");
    expect(expandReplacement(translateReplacement("\\$1"), "x", ["y"])).toBe("$1");
    expect(translateReplacement("\\t\\r")).toBe("\t\n");
  });
  it("changes with groups, also behind a lookbehind", () => {
    const s = doc("price 10 and 20, then 30");
    const m = findAll(s, { query: "(?<=price )(\\d)(\\d)", grep: true });
    if (!Array.isArray(m)) throw new Error(m.error);
    const ops = replaceOps(s, m, { query: "", grep: true }, "$2$1");
    expect(ops).toHaveLength(1);
    expect(JSON.stringify(ops[0], (_, v) => (typeof v === "bigint" ? v.toString() : v))).toContain("price 01 and 20, then 30");
  });
});
