import { describe, it, expect } from "vitest";
import { applyOp } from "./applyOp";
import { compile, findAll, replaceOps, replacementFor } from "./findReplace";
import { emptyScene, type NodeLite, type SceneState, type TextStyleLite } from "./types";

const STYLE: TextStyleLite = { fontFamily: "", fontSize: 12, fontWeight: "", lineHeight: 1.2, align: "left" };
const text = (id: string, parentId: string, content: string, y = 0, extra: Partial<NodeLite["text"] & object> = {}, over: Partial<NodeLite> = {}): NodeLite => ({
  id, parentId, orderKey: "a" + id, name: id, visible: true, opacity: 1, x: 0, y, width: 300, height: 40, rotation: 0,
  fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind: "text", cornerRadius: 0, clipsContent: false, text: { content, style: STYLE, ...extra }, ...over,
});
function doc(nodes: NodeLite[]): SceneState {
  let s: SceneState = { ...emptyScene("d", "d"), pages: [{ id: "p1", name: "1" }, { id: "p2", name: "2" }, { id: "m", name: "M", isMaster: true }],
    textStyles: { b: { id: "b", name: "B", kind: "character", style: { ...STYLE, fontWeight: "700", fontSize: 0, lineHeight: 0 } } } };
  for (const n of nodes) s = { ...s, nodes: s.nodes.set(n.id, n) };
  return s;
}
const ok = (r: ReturnType<typeof findAll>) => { if (!Array.isArray(r)) throw new Error(r.error); return r; };

describe("find", () => {
  const s = doc([text("b", "p2", "the cat"), text("a", "p1", "Cat and cat, concatenate", 5), text("m", "m", "cat on a master"), text("z", "p1", "Cat", 0)]);
  it("finds in reading order across pages, ignoring case by default", () => {
    expect(ok(findAll(s, { query: "cat" })).map((m) => [m.nodeId, m.start])).toEqual([["z", 0], ["a", 0], ["a", 8], ["a", 16], ["b", 4], ["m", 0]]);
  });
  it("matches case, whole words and regular expressions", () => {
    expect(ok(findAll(s, { query: "cat", matchCase: true }))).toHaveLength(4);
    expect(ok(findAll(s, { query: "cat", wholeWord: true })).map((m) => m.nodeId)).toEqual(["z", "a", "a", "b", "m"]);
    expect(ok(findAll(s, { query: "c[a-z]t", regex: true }))).toHaveLength(6);
    expect(ok(findAll(s, { query: ".", regex: false }))).toEqual([]);
  });
  it("reports a bad pattern and treats an empty query as no match", () => {
    expect(findAll(s, { query: "(", regex: true })).toHaveProperty("error");
    expect(findAll(s, { query: "" })).toEqual([]);
    expect(compile({ query: "" })).toBeNull();
  });
  it("skips the later frames of a thread: their text is the first frame's story", () => {
    const t = doc([text("h", "p1", "story cat", 0, {}, { meta: { "text.next": "f" } }), text("f", "p2", "cat follower")]);
    expect(ok(findAll(t, { query: "cat" })).map((m) => m.nodeId)).toEqual(["h"]);
  });
});

describe("change", () => {
  it("replaces every match and keeps the runs attached to their characters", () => {
    const s = doc([text("a", "p1", "cat and cat", 0, { runs: [{ start: 8, end: 11, styleId: "b" }], paragraphStyles: [] })]);
    const matches = ok(findAll(s, { query: "cat" }));
    const next = replaceOps(s, matches, { query: "cat" }, "elephant").reduce(applyOp, s);
    expect(next.nodes.get("a")!.text!.content).toBe("elephant and elephant");
    // The bold run was the second "cat": it now covers the second "elephant".
    expect(next.nodes.get("a")!.text!.runs).toEqual([{ start: 13, end: 21, styleId: "b" }]);
  });
  it("changes one match and leaves the others", () => {
    const s = doc([text("a", "p1", "one two one")]);
    const matches = ok(findAll(s, { query: "one" }));
    const next = replaceOps(s, [matches[1]], { query: "one" }, "1").reduce(applyOp, s);
    expect(next.nodes.get("a")!.text!.content).toBe("one two 1");
  });
  it("expands groups for a regular expression", () => {
    const s = doc([text("a", "p1", "2024-05-06")]);
    const opts = { query: "(\\d+)-(\\d+)-(\\d+)", regex: true };
    const matches = ok(findAll(s, opts));
    expect(replacementFor(matches[0], opts, "$3/$2/$1")).toBe("06/05/2024");
    expect(replaceOps(s, matches, opts, "$3/$2/$1").reduce(applyOp, s).nodes.get("a")!.text!.content).toBe("06/05/2024");
  });
  it("can delete matches with an empty replacement", () => {
    const s = doc([text("a", "p1", "a--b--c")]);
    expect(replaceOps(s, ok(findAll(s, { query: "--" })), { query: "--" }, "").reduce(applyOp, s).nodes.get("a")!.text!.content).toBe("abc");
  });
});
