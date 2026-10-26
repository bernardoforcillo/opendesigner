import { describe, it, expect } from "vitest";
import { applyOp } from "@/store/applyOp";
import { resolveScene } from "@/store/variables";
import { emptyScene, type NodeLite, type SceneState, type TextStyleLite } from "@/store/types";
import { contentsNode, generateContentsOps } from "@/tools/contents";

const STYLE: TextStyleLite = { fontFamily: "", fontSize: 12, fontWeight: "", lineHeight: 1.2, align: "left" };
const text = (id: string, parentId: string, content: string, paragraphStyles?: string[], y = 0): NodeLite => ({
  id, parentId, orderKey: "a" + id, name: id, visible: true, opacity: 1, x: 0, y, width: 300, height: 40, rotation: 0,
  fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind: "text", cornerRadius: 0, clipsContent: false, text: { content, style: STYLE, ...(paragraphStyles ? { paragraphStyles } : {}) },
});

function book(): SceneState {
  let s: SceneState = {
    ...emptyScene("d", "Book"),
    pages: [{ id: "front", name: "Front", numberStyle: "i", width: 400, height: 600, marginLeft: 30, marginRight: 30, marginTop: 40 }, { id: "p2", name: "2", sectionStart: true, width: 400, height: 600 }, { id: "p3", name: "3" }],
    textStyles: {
      h1: { id: "h1", name: "H1", style: STYLE, outlineLevel: 1 }, h2: { id: "h2", name: "H2", style: STYLE, basedOn: "h1", outlineLevel: 2 }, h3: { id: "h3", name: "H3", style: STYLE, outlineLevel: 3 },
      body: { id: "body", name: "Body", style: STYLE },
    },
  };
  for (const n of [
    text("a", "p2", "Start\nbody\nDetail", ["h1", "body", "h2"]),
    text("b", "p3", "Next\nWord[#word] and [#other]", ["h1", "body"]),
    text("c", "front", "Preface[#word]", ["h1"]),
  ]) s = { ...s, nodes: s.nodes.set(n.id, n) };
  return s;
}
const run = (s: SceneState, ops: Parameters<typeof applyOp>[1][]) => ops.reduce(applyOp, s);

describe("table of contents", () => {
  it("lists the headings with their pages, in styles with a right tab and a leader", () => {
    const s = book();
    const g = generateContentsOps(s, "toc", "front")!;
    const next = run(s, g.ops);
    const n = next.nodes.get(g.selection[0])!;
    expect(n.text!.content).toBe("Preface\ti\nStart\t1\nDetail\t1\nNext\t2");
    expect(n.text!.paragraphStyles).toEqual(["contents-1", "contents-1", "contents-2", "contents-1"]);
    expect(n).toMatchObject({ parentId: "front", x: 30, y: 40, width: 340, meta: { "contents.kind": "toc" } });
    expect(next.textStyles["contents-2"]).toMatchObject({ indentLeft: 18, tabStops: [{ position: 340, align: "right", leader: "." }] });
    // The resolved text carries the tab and the leader for the layout.
    const rich = resolveScene(next).nodes.get(n.id)!.text!.rich!;
    expect(rich.paragraphs[0].tabs).toEqual([{ position: 340, align: "right", leader: "." }]);
  });
  it("refreshes the same frame when the headings change", () => {
    let s = book();
    s = run(s, generateContentsOps(s, "toc", "front")!.ops);
    const id = contentsNode(s, "toc")!.id;
    s = { ...s, nodes: s.nodes.set("b", text("b", "p3", "Renamed\nbody", ["h1", "body"])) };
    const g = generateContentsOps(s, "toc", "p3")!;
    expect(g.selection).toEqual([id]);
    s = run(s, g.ops);
    expect(s.nodes.get(id)!.text!.content).toContain("Renamed\t2");
    expect([...s.nodes.values()].filter((n) => n.meta?.["contents.kind"] === "toc")).toHaveLength(1);
  });
  it("limits the levels and has nothing to write without headings", () => {
    const s = book();
    const g = generateContentsOps(s, "toc", "front", 1)!;
    expect(run(s, g.ops).nodes.get(g.selection[0])!.text!.content).not.toContain("Detail");
    expect(generateContentsOps(emptyScene("d", "d"), "toc", "page1")).toBeNull();
  });
});

describe("index", () => {
  it("lists the marked terms alphabetically with their pages", () => {
    const s = book();
    const g = generateContentsOps(s, "index", "p3")!;
    const n = run(s, g.ops).nodes.get(g.selection[0])!;
    expect(n.text!.content).toBe("other\t2\nword\ti, 2");
    expect(n.text!.paragraphStyles).toEqual(["index-entry", "index-entry"]);
  });
});
