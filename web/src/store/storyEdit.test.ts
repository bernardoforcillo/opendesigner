import { describe, it, expect } from "vitest";
import { applyOp } from "@/store/applyOp";
import { storyEditOp } from "@/store/storyEdit";
import { META_NEXT } from "@/store/threads";
import { emptyScene, type NodeLite, type SceneState } from "@/store/types";

const STYLE = { fontFamily: "", fontSize: 16, fontWeight: "", lineHeight: 1.25, align: "left" as const };
const frame = (id: string, text: NodeLite["text"], meta?: Record<string, string>): NodeLite => ({
  id, parentId: "page1", orderKey: id, name: id, visible: true, opacity: 1, x: 0, y: 0, width: 100, height: 40, rotation: 0,
  fills: [], strokes: [], kind: "text", cornerRadius: 0, clipsContent: false, text, ...(meta ? { meta } : {}),
});
const mk = (...n: NodeLite[]): SceneState => {
  let s = emptyScene("d", "t");
  for (const id of ["bold", "i"]) s = { ...s, textStyles: { ...s.textStyles, [id]: { id, name: id, style: STYLE, kind: "character" } } };
  for (const id of ["h", "b"]) s = { ...s, textStyles: { ...s.textStyles, [id]: { id, name: id, style: STYLE } } }; for (const x of n) s = { ...s, nodes: s.nodes.set(x.id, x) }; return s; };

describe("storyEditOp", () => {
  it("does nothing when the text is unchanged", () => {
    expect(storyEditOp(mk(frame("a", { content: "hi", style: STYLE })), "a", "hi")).toBeNull();
  });

  it("writes the story into the first frame of the chain", () => {
    let s = mk(frame("a", { content: "one", style: STYLE }, { [META_NEXT]: "b" }), frame("b", { content: "", style: STYLE }));
    s = applyOp(s, storyEditOp(s, "b", "one two")!);
    expect(s.nodes.get("a")!.text!.content).toBe("one two");
  });

  it("keeps character runs with their text when words are inserted before them", () => {
    let s = mk(frame("a", { content: "hello world", style: STYLE, runs: [{ start: 6, end: 11, styleId: "bold" }] }));
    s = applyOp(s, storyEditOp(s, "a", "well hello world")!);
    expect(s.nodes.get("a")!.text!.runs).toEqual([{ start: 11, end: 16, styleId: "bold" }]);
  });

  it("cuts a run that overlaps the change", () => {
    let s = mk(frame("a", { content: "hello world", style: STYLE, runs: [{ start: 0, end: 11, styleId: "i" }] }));
    s = applyOp(s, storyEditOp(s, "a", "hello big world")!);
    const runs = s.nodes.get("a")!.text!.runs!;
    expect(runs).toEqual([{ start: 0, end: 6, styleId: "i" }, { start: 10, end: 15, styleId: "i" }]);
  });

  it("keeps paragraph styles on their paragraphs", () => {
    let s = mk(frame("a", { content: "Title\nbody", style: STYLE, paragraphStyles: ["h", "b"] }));
    s = applyOp(s, storyEditOp(s, "a", "Title\nmore\nbody")!);
    expect(s.nodes.get("a")!.text!.paragraphStyles).toEqual(["h", "", "b"]);
  });
});
