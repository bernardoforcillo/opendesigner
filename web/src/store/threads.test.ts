import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { applyOp } from "./applyOp";
import { canLink, chainsOf, deriveThreads, flowStory, headOf, isThreaded, META_NEXT, setThreadMeasure, threadOps, unlinkOps } from "./threads";
import { resolveScene } from "./variables";
import { emptyScene, type NodeLite, type SceneState, type TextStyleLite } from "./types";

// 10 units per character; line height 20 (font 16 x 1.25).
const STYLE: TextStyleLite = { fontFamily: "", fontSize: 16, fontWeight: "", lineHeight: 1.25, align: "left" };
beforeEach(() => setThreadMeasure(() => (s) => s.length * 10));
afterEach(() => setThreadMeasure(null));

const frame = (id: string, over: Partial<NodeLite> = {}, content = ""): NodeLite => ({
  id, parentId: "page1", orderKey: "a" + id, name: id, visible: true, opacity: 1, x: 0, y: 0, width: 100, height: 40, rotation: 0,
  fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind: "text", cornerRadius: 0, clipsContent: false,
  text: { content, style: STYLE }, ...over,
});

function scene(...nodes: NodeLite[]): SceneState {
  let s = emptyScene("d", "t");
  for (const n of nodes) s = { ...s, nodes: s.nodes.set(n.id, n) };
  return s;
}
const link = (n: NodeLite, to: string): NodeLite => ({ ...n, meta: { ...(n.meta ?? {}), [META_NEXT]: to } });
const text = (s: SceneState, id: string) => s.nodes.get(id)!.text!.content;

describe("flowStory", () => {
  const style = STYLE;
  const m = (s: string) => s.length * 10;
  it("fills each frame with the lines that fit and hands the rest on", () => {
    // 10 chars per line, 2 lines per frame.
    const r = flowStory("aaaa bbbb cccc dddd eeee", [{ width: 100, height: 40 }, { width: 100, height: 40 }], style, m);
    expect(r.slices).toEqual(["aaaa bbbb\ncccc dddd", "eeee"]);
    expect(r.overset).toBe(false);
  });

  it("uses each frame's own width", () => {
    const r = flowStory("aaaa bbbb cccc dddd", [{ width: 50, height: 20 }, { width: 200, height: 40 }], style, m);
    expect(r.slices).toEqual(["aaaa", "bbbb cccc dddd"]);
  });

  it("keeps hard breaks and empty paragraphs", () => {
    const r = flowStory("one\n\ntwo\nthree", [{ width: 100, height: 40 }, { width: 100, height: 40 }], style, m);
    expect(r.slices).toEqual(["one\n", "two\nthree"]);
  });

  it("reports overset text and leaves later frames empty when nothing is left", () => {
    expect(flowStory("aaaa bbbb cccc dddd eeee ffff", [{ width: 100, height: 40 }], style, m)).toEqual({ slices: ["aaaa bbbb\ncccc dddd"], overset: true });
    expect(flowStory("hi", [{ width: 100, height: 40 }, { width: 100, height: 40 }], style, m)).toEqual({ slices: ["hi", ""], overset: false });
  });

  it("never loses or repeats a word, whatever the frame sizes", () => {
    const words = Array.from({ length: 60 }, (_, i) => `w${i}`);
    const story = words.join(" ");
    const frames = [{ width: 70, height: 60 }, { width: 130, height: 40 }, { width: 40, height: 100 }, { width: 300, height: 400 }];
    const { slices, overset } = flowStory(story, frames, STYLE, m);
    expect(overset).toBe(false);
    expect(slices.join(" ").split(/\s+/).filter(Boolean)).toEqual(words);
  });
});

describe("deriveThreads", () => {
  const story = "aaaa bbbb cccc dddd eeee ffff gggg";
  const chain = () => scene(link(frame("A", {}, story), "B"), link(frame("B", { x: 200 }), "C"), frame("C", { x: 400 }));

  it("is the identity without threads", () => {
    const s = scene(frame("A", {}, "x"));
    expect(deriveThreads(s)).toBe(s);
  });

  it("shows each frame's slice, in the first frame's style, and flags overset on the last", () => {
    const s = deriveThreads(chain());
    expect(text(s, "A")).toBe("aaaa bbbb\ncccc dddd");
    expect(text(s, "B")).toBe("eeee ffff\ngggg");
    expect(text(s, "C")).toBe("");
    expect(s.nodes.get("C")!.overset).toBeUndefined();
    const small = scene(link(frame("A", {}, story), "B"), frame("B", { x: 200, height: 20 }));
    const out = deriveThreads(small);
    expect(out.nodes.get("B")!.overset).toBe(true);
    expect(text(out, "B")).toBe("eeee ffff");
  });

  it("takes the follower frames' own style from the head", () => {
    const big: TextStyleLite = { ...STYLE, fontSize: 24, fontWeight: "700" };
    const s = deriveThreads(scene(link(frame("A", { text: { content: "x", style: big } }), "B"), frame("B")));
    expect(s.nodes.get("B")!.text!.style).toBe(big);
  });

  it("is part of resolveScene and does not touch the document", () => {
    const raw = chain();
    expect(text(resolveScene(raw), "B")).toBe("eeee ffff\ngggg");
    expect(text(raw, "B")).toBe("");
  });

  it("ignores dangling links, links to non-text nodes and cycles", () => {
    const dangling = scene(link(frame("A", {}, "hi"), "gone"));
    expect(deriveThreads(dangling)).toBe(dangling);
    const rect = frame("R", { kind: "rect", text: undefined });
    expect(chainsOf(scene(link(frame("A", {}, "hi"), "R"), rect))).toHaveLength(0);
    const cyc = scene(link(frame("A", {}, "x y"), "B"), link(frame("B"), "A"));
    expect(() => deriveThreads(cyc)).not.toThrow();
  });
});

describe("linking", () => {
  it("finds heads and membership", () => {
    const s = scene(link(frame("A", {}, "x"), "B"), link(frame("B"), "C"), frame("C"), frame("D"));
    expect(headOf(s, "C")).toBe("A");
    expect(headOf(s, "D")).toBe("D");
    expect(isThreaded(s, "B")).toBe(true);
    expect(isThreaded(s, "D")).toBe(false);
  });

  it("canLink refuses self, taken ports, targets already followed and cycles", () => {
    const s = scene(link(frame("A"), "B"), frame("B"), frame("C"), frame("R", { kind: "rect", text: undefined }));
    expect(canLink(s, "A", "A")).toBe(false);
    expect(canLink(s, "A", "C")).toBe(false); // A already has a next
    expect(canLink(s, "C", "B")).toBe(false); // B is already followed
    expect(canLink(s, "B", "A")).toBe(false); // would close a cycle
    expect(canLink(s, "B", "C")).toBe(true);
    expect(canLink(s, "B", "R")).toBe(false);
  });

  it("threadOps chains the frames and keeps all the text in the first one", () => {
    const s = scene(frame("A", {}, "first"), frame("B", {}, "second"), frame("C"));
    const ops = threadOps(s, ["A", "B", "C"])!;
    let next = s;
    for (const op of ops) next = applyOp(next, op);
    expect(next.nodes.get("A")!.meta![META_NEXT]).toBe("B");
    expect(next.nodes.get("B")!.meta![META_NEXT]).toBe("C");
    expect(text(next, "A")).toBe("first\nsecond");
    expect(text(next, "B")).toBe("");
    expect(chainsOf(next).map((c) => c.map((n) => n.id))).toEqual([["A", "B", "C"]]);
  });

  it("threadOps skips impossible pairs and returns null when nothing links", () => {
    const s = scene(link(frame("A", {}, "x"), "B"), frame("B"));
    expect(threadOps(s, ["B", "A"])).toBeNull();
    expect(threadOps(s, ["A"])).toBeNull();
  });

  it("unlinkOps cuts after a frame and keeps the story with the first part", () => {
    const s = scene(link(frame("A", {}, "x"), "B"), frame("B"));
    const next = applyOp(s, unlinkOps(s, "A")![0]);
    expect(next.nodes.get("A")!.meta?.[META_NEXT]).toBeUndefined();
    expect(chainsOf(next)).toHaveLength(0);
    expect(unlinkOps(next, "A")).toBeNull();
  });
});
