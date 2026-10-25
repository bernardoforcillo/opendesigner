import { afterEach, describe, expect, it } from "vitest";
import { layoutRich, type MeasureFor } from "../renderer/text";
import { applyOp } from "./applyOp";
import { anchorOps, anchorRef, anchorsOf, releaseAnchorOps } from "./anchored";
import { resolveScene } from "./variables";
import { setThreadMeasure } from "./threads";
import { emptyScene, type NodeLite, type SceneState, type TextStyleLite } from "./types";

const STYLE: TextStyleLite = { fontFamily: "", fontSize: 10, fontWeight: "", lineHeight: 1, align: "left" };
const node = (over: Partial<NodeLite> & { id: string }): NodeLite => ({
  parentId: "page1", orderKey: "a" + over.id, name: over.id, visible: true, opacity: 1, x: 0, y: 0, width: 50, height: 50, rotation: 0,
  fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false, ...over,
});
const text = (id: string, content: string, over: Partial<NodeLite> = {}) => node({ id, kind: "text", x: 40, y: 100, width: 200, height: 100, text: { content, style: STYLE }, ...over });
const scene = (nodes: NodeLite[]): SceneState => nodes.reduce((s, n) => ({ ...s, nodes: s.nodes.set(n.id, n) }), emptyScene("d", "d"));

// 5 units per character at size 10.
const mf: MeasureFor = (st) => (s) => s.length * (st.fontSize || 16) * 0.5;
afterEach(() => setThreadMeasure(null));
const measure = () => setThreadMeasure((st) => (s) => s.length * (st.fontSize || 16) * 0.5);

describe("anchored objects", () => {
  it("leaves a box in the line and puts the object there, standing on the baseline", () => {
    measure();
    const s = scene([text("t", "ab [@pic12345] cd"), node({ id: "pic12345xyz", width: 20, height: 30, x: 999, y: 999 })]);
    const out = resolveScene(s);
    const t = out.nodes.get("t")!.text!;
    expect(t.content).toBe("ab ￼ cd");
    expect(t.rich!.inlines).toEqual([{ at: 3, id: "pic12345xyz", width: 20, height: 30 }]);
    // "ab" + a space = 15 units; the line is as tall as the object, whose top is the line's top.
    expect(out.nodes.get("pic12345xyz")).toMatchObject({ x: 55, y: 100 });
    // The document keeps its own values.
    expect(s.nodes.get("pic12345xyz")).toMatchObject({ x: 999, y: 999 });
    expect(s.nodes.get("t")!.text!.content).toBe("ab [@pic12345] cd");
  });

  it("makes the line as tall as the object, so the next line starts below it", () => {
    const lay = layoutRich(mf, "\uFFFC\nnext", STYLE, {
      paragraphs: [{ style: STYLE, spaceBefore: 0, spaceAfter: 0, indentFirst: 0, indentLeft: 0 }, { style: STYLE, spaceBefore: 0, spaceAfter: 0, indentFirst: 0, indentLeft: 0 }],
      runs: [], inlines: [{ at: 0, id: "x", width: 20, height: 30 }],
    }, 200);
    expect(lay.lines[0].frags[0]).toMatchObject({ w: 20, inline: { id: "x", height: 30 } });
    expect(lay.lines[0].ascent).toBe(30);
    expect(lay.lines[0].height).toBe(32); // 30 above the baseline + the text's descent of 2
    expect(lay.lines[1].top).toBe(32);
    expect(lay.lines[0].end).toBe(1);
  });

  it("follows the text when it moves or is edited, and wraps with it", () => {
    measure();
    let s = scene([text("t", "aaaa bbbb [@pic12345] cc", { width: 60 }), node({ id: "pic12345xyz", width: 20, height: 10 })]);
    const before = resolveScene(s).nodes.get("pic12345xyz")!;
    // "aaaa bbbb " fills the first line (60 wide: 4+1+4 = 9 chars = 45; the object does not fit after the space) -> second line.
    expect(before.y).toBeGreaterThan(100);
    s = { ...s, nodes: s.nodes.set("t", { ...s.nodes.get("t")!, x: 140, y: 300 }) };
    const moved = resolveScene(s).nodes.get("pic12345xyz")!;
    expect(moved.x).toBeGreaterThanOrEqual(140);
    expect(moved.y).toBeGreaterThan(300);
  });

  it("works for groups, placing their content", () => {
    measure();
    const g = node({ id: "grp12345xyz", kind: "group" });
    const kid = node({ id: "kid", parentId: "grp12345xyz", x: 7, y: 9, width: 20, height: 10 });
    const s = scene([text("t", "ab [@grp12345] cd"), g, kid]);
    const out = resolveScene(s);
    // The group's content (starting at 7, 9) is moved to the box in the line (x 55, line top 100).
    expect(out.nodes.get("grp12345xyz")).toMatchObject({ x: 48, y: 91 });
  });

  it("drops a marker whose object is gone or ambiguous, and one that names the text itself", () => {
    measure();
    const s = scene([text("text1234", "a [@nothing1] b [@same1111] c [@text1234] d"), node({ id: "same1111a" }), node({ id: "same1111b" })]);
    expect(resolveScene(s).nodes.get("text1234")!.text!.content).toBe("a  b  c  d");
  });

  it("keeps the marker offsets right across the frames of a thread", () => {
    measure();
    const s = scene([
      text("a", "aaaa bbbb cccc [@pic12345] dddd", { width: 50, height: 10, meta: { "text.next": "b" } }),
      text("b", "", { y: 300, width: 200, height: 100 }),
      node({ id: "pic12345xyz", width: 10, height: 10 }),
    ]);
    const out = resolveScene(s);
    const second = out.nodes.get("b")!.text!;
    expect(second.inlineObjects).toHaveLength(1);
    expect(second.content[second.inlineObjects![0].at]).toBe("￼");
    expect(out.nodes.get("pic12345xyz")!.y).toBeGreaterThanOrEqual(300);
  });

  it("anchors an object with an op, and releases it by taking the marker out", () => {
    const s = scene([text("t", "hello"), node({ id: "pic12345xyz" })]);
    expect(anchorRef(s, "pic12345xyz")).toBe("pic12345");
    const next = anchorOps(s, "t", "pic12345xyz", 2).reduce(applyOp, s);
    expect(next.nodes.get("t")!.text!.content).toBe("he[@pic12345]llo");
    const [a] = anchorsOf(next, next.nodes.get("t")!);
    expect(a.node.id).toBe("pic12345xyz");
    const back = releaseAnchorOps(next, "t", a.at, a.end).reduce(applyOp, next);
    expect(back.nodes.get("t")!.text!.content).toBe("hello");
    expect(anchorOps(s, "t", "t")).toEqual([]);
  });

  it("uses a longer reference when ids share their start", () => {
    const s = scene([node({ id: "abcdefgh1" }), node({ id: "abcdefgh2" })]);
    expect(anchorRef(s, "abcdefgh1")).toBe("abcdefgh1");
  });
});
