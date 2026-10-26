import { describe, it, expect } from "vitest";
import { cjkBreaks, cjkSplit, hasCjk } from "@/renderer/cjk";
import { layoutText } from "@/renderer/text";
import { layoutRich } from "@/renderer/text";

describe("cjk breaks", () => {
  it("allows a break between ideographs and kana, not inside Latin words", () => {
    expect(cjkSplit("日本語")).toEqual(["日", "本", "語"]);
    expect(cjkSplit("hello")).toEqual(["hello"]);
    expect(cjkSplit("abc日本")).toEqual(["abc", "日", "本"]);
    expect(hasCjk("abc")).toBe(false);
  });
  it("never starts a line with closing punctuation or ends one with an opening bracket (kinsoku)", () => {
    expect(cjkBreaks("今日は。明日")).toEqual([1, 2, 4, 5].filter((i) => i !== 3)); // no break before 。 (offset 3)
    expect(cjkSplit("彼は「はい」と")).toEqual(["彼", "は", "「は", "い」", "と"]);
    expect(cjkSplit("ええー")).toEqual(["え", "えー"]); // the prolonged-sound mark stays with its kana
    expect(cjkSplit("待って……")).toEqual(["待っ", "て……"]); // small kana cannot start a line; an ellipsis pair is not split
  });
  it("does not break Hangul (written with spaces)", () => {
    expect(cjkSplit("한국어")).toEqual(["한국어"]);
  });
});

const measure = (s: string) => Array.from(s).length * 10; // every character 10 wide
const style = { fontFamily: "", fontSize: 10, fontWeight: "", lineHeight: 1.2, align: "left" as const };

describe("layoutText with CJK", () => {
  it("fills lines to the width without spaces, respecting kinsoku", () => {
    const l = layoutText(measure, "今日は晴れです。明日は雨", style, 60);
    expect(l.lines).toEqual(["今日は晴れで", "す。明日は雨"]);
    // a 。 that would fall first on the second line drags the last character before it down with it
    expect(layoutText(measure, "今日は晴れです。", style, 70).lines).toEqual(["今日は晴れで", "す。"]);
  });
});

describe("layoutRich with CJK", () => {
  it("wraps rich text the same way", () => {
    const rich = { paragraphs: [{ style, spaceBefore: 0, spaceAfter: 0, indentFirst: 0, indentLeft: 0 }], runs: [] } as never;
    const lines = layoutRich(() => measure, "今日は晴れです。明日", style, rich, 60).lines.map((l) => l.frags.map((f) => f.text).join(""));
    expect(lines.length).toBe(2);
    expect(lines.every((t) => !/^[。、]/.test(t))).toBe(true);
  });
});
