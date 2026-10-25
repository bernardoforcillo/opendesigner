import { describe, it, expect } from "vitest";
import { create } from "@bufbuild/protobuf";
import { OpSchema, TextStyleKind } from "../gen/opendesigner/v1/opendesigner_pb";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { applyOp } from "./applyOp";
import { invertOp } from "./history";
import { clampRich, isValidRich, paragraphCount, reconcileRich, richFields } from "./richText";
import { resolveScene } from "./variables";
import { emptyScene, toPbTextStyle, toPbTextStyleDef, type NodeLite, type SceneState, type TextLite, type TextStyleDefLite } from "./types";

const STYLE = { fontFamily: "", fontSize: 12, fontWeight: "", lineHeight: 0, align: "left" as const };
const def = (over: Partial<TextStyleDefLite> & { id: string }): TextStyleDefLite => ({ name: over.id, style: { ...STYLE, fontSize: 0 }, ...over });

function textNode(content: string, extra: Partial<TextLite> = {}): NodeLite {
  return {
    id: "t", parentId: "page1", orderKey: "a0", name: "t", visible: true, opacity: 1, x: 0, y: 0, width: 200, height: 20, rotation: 0,
    fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind: "text", cornerRadius: 0, clipsContent: false,
    text: { content, style: STYLE, ...extra },
  };
}
function doc(content = "one\ntwo\nthree", extra: Partial<TextLite> = {}): SceneState {
  const s = emptyScene("d", "d");
  s.textStyles = {
    body: def({ id: "body", style: { ...STYLE, fontSize: 14 }, nextStyleId: "body" }),
    h1: def({ id: "h1", style: { ...STYLE, fontSize: 30, fontWeight: "700" }, nextStyleId: "body" }),
    bold: def({ id: "bold", kind: "character", style: { ...STYLE, fontSize: 0, fontWeight: "700" } }),
  };
  s.nodes = s.nodes.set("t", textNode(content, extra));
  return s;
}
const op = (kind: Op["kind"]): Op => create(OpSchema, { opId: "o", docId: "d", kind });
const setText = (v: object) => op({ case: "setText", value: { id: "t", content: "", ...v } } as Op["kind"]);
const text = (s: SceneState) => s.nodes.at("t")!.text!;

describe("setText with rich text", () => {
  it("stores paragraph styles and runs and returns them to the previous state on undo", () => {
    const s = doc();
    const o = setText({ content: "one\ntwo\nthree", richPresent: true, paragraphStyles: ["h1", "", "body"], runs: [{ start: 0, end: 3, styleId: "bold" }] });
    const next = applyOp(s, o);
    expect(text(next).paragraphStyles).toEqual(["h1", "", "body"]);
    expect(text(next).runs).toEqual([{ start: 0, end: 3, styleId: "bold" }]);
    const inv = invertOp(s, o)!;
    expect(text(applyOp(next, inv[0]))).toEqual(text(s));
  });

  it("rejects what the Go core rejects, changing nothing", () => {
    const s = doc();
    const bad = [
      { paragraphStyles: ["h1", "h1", "h1", "h1"] },
      { paragraphStyles: ["bold"] },
      { paragraphStyles: ["nope"] },
      { runs: [{ start: 0, end: 1, styleId: "body" }] },
      { runs: [{ start: 0, end: 99, styleId: "bold" }] },
      { runs: [{ start: 2, end: 2, styleId: "bold" }] },
      { runs: [{ start: 0, end: 4, styleId: "bold" }, { start: 3, end: 5, styleId: "bold" }] },
    ];
    for (const b of bad) expect(applyOp(s, setText({ content: "one\ntwo\nthree", richPresent: true, ...b }))).toBe(s);
  });

  it("counts UTF-16 units: an emoji is two", () => {
    const s = doc("a😀b");
    expect(isValidRich(s, "a😀b", [], [{ start: 1, end: 3, styleId: "bold" }])).toBe(true);
    expect(isValidRich(s, "a😀b", [], [{ start: 1, end: 5, styleId: "bold" }])).toBe(false);
  });

  it("without richPresent the formatting follows the new content (parity with clampRich in Go)", () => {
    const s = doc("one\ntwo\nthree", { paragraphStyles: ["h1", "", "body"], runs: [{ start: 0, end: 3, styleId: "bold" }, { start: 8, end: 13, styleId: "bold" }] });
    let next = applyOp(s, setText({ content: "one\ntwo" }));
    expect(text(next).paragraphStyles).toEqual(["h1", "", "body"].slice(0, 2).length === 2 ? ["h1", ""] : []);
    expect(text(next).runs).toEqual([{ start: 0, end: 3, styleId: "bold" }]);
    next = applyOp(next, setText({ content: "on" }));
    expect(text(next).runs).toEqual([{ start: 0, end: 2, styleId: "bold" }]);
    next = applyOp(next, setText({ content: "" }));
    expect(text(next).runs).toBeUndefined();
    expect(clampRich({ content: "a", style: STYLE, paragraphStyles: ["h1", "h1"] }).paragraphStyles).toEqual(["h1"]);
  });

  it("richFields leaves out empty formatting", () => {
    expect(richFields(["", ""], [])).toEqual({});
    expect(richFields(["h1"], [])).toEqual({ paragraphStyles: ["h1"] });
  });
});

describe("text style definitions with relations", () => {
  const upsert = (d: Parameters<typeof toDef>[0]) => op({ case: "setTextStyleDef", value: { textStyle: toDef(d) } } as Op["kind"]);
  function toDef(d: { id: string; name?: string; kind?: "character"; basedOn?: string; nextStyleId?: string; spaceBefore?: number; spaceAfter?: number; indentFirst?: number; indentLeft?: number; size?: number }) {
    return {
      id: d.id, name: d.name ?? d.id, style: toPbTextStyle({ ...STYLE, fontSize: d.size ?? 12 }),
      kind: d.kind === "character" ? TextStyleKind.CHARACTER : TextStyleKind.PARAGRAPH,
      basedOn: d.basedOn ?? "", nextStyleId: d.nextStyleId ?? "", spaceBefore: d.spaceBefore ?? 0, spaceAfter: d.spaceAfter ?? 0,
      indentFirst: d.indentFirst ?? 0, indentLeft: d.indentLeft ?? 0,
    };
  }

  it("accepts a style based on another and keeps its paragraph settings", () => {
    const s = applyOp(doc(), upsert({ id: "h2", basedOn: "h1", nextStyleId: "body", spaceBefore: 8, indentFirst: 4 }));
    expect(s.textStyles.h2).toMatchObject({ basedOn: "h1", nextStyleId: "body", spaceBefore: 8, indentFirst: 4 });
    expect(s.textStyles.h2.kind).toBeUndefined();
  });

  it("rejects a missing or looping base, other kinds, bad next styles and character styles with paragraph settings", () => {
    const s = doc();
    for (const d of [
      { id: "x", basedOn: "nope" }, { id: "x", basedOn: "x" },
      { id: "x", basedOn: "bold" }, { id: "x", nextStyleId: "nope" }, { id: "x", nextStyleId: "bold" },
      { id: "x", spaceBefore: -1 }, { id: "x", kind: "character" as const, spaceAfter: 2 }, { id: "x", kind: "character" as const, nextStyleId: "body" },
    ]) expect(applyOp(s, upsert(d))).toBe(s);
    // A loop through two styles.
    const withH2 = applyOp(s, upsert({ id: "h2", basedOn: "h1" }));
    expect(applyOp(withH2, upsert({ id: "h1", basedOn: "h2" }))).toBe(withH2);
    // "body" says nextStyleId: itself -- allowed.
    expect(applyOp(s, upsert({ id: "body", nextStyleId: "body" }))).not.toBe(s);
  });

  it("a whole-node shared style may be based on another; a character style cannot be applied to a node", () => {
    let s = applyOp(doc(), upsert({ id: "h2", basedOn: "h1", size: 0 }));
    const apply = (id: string) => op({ case: "setProps", value: { id: "t", patch: { textStyleId: id }, mask: { paths: ["text_style_id"] } } } as Op["kind"]);
    expect(applyOp(s, apply("bold"))).toBe(s);
    s = applyOp(s, apply("h2"));
    expect(resolveScene(s).nodes.at("t")!.text!.style).toMatchObject({ fontSize: 30, fontWeight: "700" });
  });
});

describe("reconcileRich", () => {
  const s = doc();
  const run = (a: number, b: number) => ({ start: a, end: b, styleId: "bold" });
  const rec = (prev: TextLite, next: string) => reconcileRich(s, prev, next);
  const t = (content: string, extra: Partial<TextLite> = {}): TextLite => ({ content, style: STYLE, ...extra });

  it("moves runs with their characters when text is inserted before or deleted before them", () => {
    const prev = t("hello world", { runs: [run(6, 11)] });
    expect(rec(prev, "oh hello world").runs).toEqual([run(9, 14)]);
    expect(rec(prev, "world").runs).toEqual([run(0, 5)]);
  });

  it("extends a run when typing at its end, but not at its start", () => {
    const prev = t("ab cd", { runs: [run(3, 5)] });
    expect(rec(prev, "ab cdX").runs).toEqual([run(3, 6)]);
    expect(rec(prev, "ab Xcd").runs).toEqual([run(4, 6)]);
  });

  it("drops a run whose text was deleted and trims a run that was partly deleted", () => {
    const prev = t("abcdef", { runs: [run(1, 3), run(4, 6)] });
    expect(rec(prev, "aef").runs).toEqual([run(1, 3)]);
    expect(rec(prev, "adef").runs).toEqual([run(2, 4)]);
  });

  it("gives a paragraph created by Enter at the end the previous style's next style", () => {
    const prev = t("Title\nBody", { paragraphStyles: ["h1", "body"] });
    expect(rec(prev, "Title\n\nBody").paragraphStyles).toEqual(["h1", "body", "body"]);
    // Enter at the end of the last paragraph too.
    expect(rec(t("Title", { paragraphStyles: ["h1"] }), "Title\n").paragraphStyles).toEqual(["h1", "body"]);
  });

  it("keeps the style on both halves of a paragraph split in the middle, and the first style when merging", () => {
    const prev = t("Title\nBody", { paragraphStyles: ["h1", "body"] });
    expect(rec(prev, "Ti\ntle\nBody").paragraphStyles).toEqual(["h1", "h1", "body"]);
    expect(rec(prev, "TitleBody").paragraphStyles).toEqual(["h1"]);
  });

  it("does nothing to text without formatting", () => {
    expect(rec(t("abc"), "abcd")).toEqual({});
    expect(paragraphCount("a\r\nb\rc")).toBe(3);
  });
});

describe("letter spacing and the baseline grid in styles", () => {
  const def2 = (over: Partial<TextStyleDefLite> & { id: string }): TextStyleDefLite => ({ name: over.id, style: { ...STYLE }, ...over });
  const upsert = (d: TextStyleDefLite) => op({ case: "setTextStyleDef", value: { textStyle: toPbTextStyleDef(d) } } as Op["kind"]);

  it("stores tracking and the grid flag, and rejects what Go rejects", () => {
    const s = doc();
    const tight = def2({ id: "tight", alignToGrid: true, style: { ...STYLE, letterSpacing: -0.5 } });
    const next = applyOp(s, upsert(tight));
    expect(next.textStyles.tight).toMatchObject({ alignToGrid: true, style: { letterSpacing: -0.5 } });
    expect(applyOp(s, upsert(def2({ id: "x", style: { ...STYLE, letterSpacing: 5000 } })))).toBe(s);
    expect(applyOp(s, upsert(def2({ id: "x", kind: "character", alignToGrid: true })))).toBe(s);
    expect(applyOp(s, upsert(def2({ id: "wide", kind: "character", style: { ...STYLE, fontSize: 0, letterSpacing: 2 } })))).not.toBe(s);
  });

  it("a character style tracks over its range and a based-on style inherits tracking", () => {
    let s = doc("abc");
    s.textStyles = {
      ...s.textStyles,
      wide: def2({ id: "wide", kind: "character", style: { ...STYLE, fontSize: 0, letterSpacing: 3 } }),
      a: def2({ id: "a", style: { ...STYLE, fontSize: 0, letterSpacing: 1 } }),
      b: def2({ id: "b", basedOn: "a", style: { ...STYLE, fontSize: 20 } }),
    };
    s = applyOp(s, setText({ content: "abc", richPresent: true, paragraphStyles: ["b"], runs: [{ start: 1, end: 2, styleId: "wide" }] }));
    const r = resolveScene(s).nodes.at("t")!.text!.rich!;
    expect(r.paragraphs[0].style).toMatchObject({ fontSize: 20, letterSpacing: 1 });
    expect(r.runs[0].style.letterSpacing).toBe(3);
  });

  it("builds the grid for paragraphs that align to it, with the box's place on the page", () => {
    let s = doc("a");
    s.textStyles = { ...s.textStyles, g: def2({ id: "g", alignToGrid: true, style: { ...STYLE } }) };
    s.settings = { baselineIncrement: 14, baselineStart: 6 };
    s.nodes = s.nodes.set("t", { ...s.nodes.at("t")!, y: 30 });
    s = applyOp(s, setText({ content: "a", richPresent: true, paragraphStyles: ["g"] }));
    expect(resolveScene(s).nodes.at("t")!.text!.rich!.grid).toEqual({ increment: 14, start: 6, boxY: 30 });
    // No grid in the document: nothing to align to.
    const bare = { ...s, settings: undefined };
    expect(resolveScene(bare).nodes.at("t")!.text!.rich!.grid).toBeUndefined();
  });
});
