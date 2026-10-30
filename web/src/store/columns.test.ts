import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { applyOp } from "@/store/applyOp";
import { columnId, columnWidth, columnsOf, deriveColumns, META_COLUMNS, META_GUTTER, setColumnsOps } from "@/store/columns";
import { META_NEXT, setThreadMeasure } from "@/store/threads";
import { resolveScene } from "@/store/variables";
import { emptyScene, type NodeLite, type SceneState, type TextStyleLite } from "@/store/types";

const STYLE: TextStyleLite = { fontFamily: "", fontSize: 16, fontWeight: "", lineHeight: 1.25, align: "left" };
beforeEach(() => setThreadMeasure(() => (s) => s.length * 10));
afterEach(() => setThreadMeasure(null));

const frame = (id: string, over: Partial<NodeLite> = {}, content = ""): NodeLite => ({
  id, parentId: "page1", orderKey: "a" + id, name: id, visible: true, opacity: 1, x: 10, y: 0, width: 224, height: 40, rotation: 0,
  fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind: "text", cornerRadius: 0, clipsContent: false,
  text: { content, style: STYLE }, ...over,
});
const scene = (...nodes: NodeLite[]): SceneState => {
  let s = emptyScene("d", "t");
  for (const n of nodes) s = { ...s, nodes: s.nodes.set(n.id, n) };
  return s;
};
const cols = (n: number, g = 24) => ({ meta: { [META_COLUMNS]: String(n), [META_GUTTER]: String(g) } });

describe("columns in one frame", () => {
  it("reads the count and the column width", () => {
    const n = frame("a", cols(3, 12));
    expect(columnsOf(n)).toBe(3);
    expect(columnWidth(n)).toBe(200 / 3);
    expect(columnsOf(frame("b"))).toBe(1);
    expect(columnsOf(frame("c", { meta: { [META_COLUMNS]: "99" } }))).toBe(8);
  });

  it("leaves a scene without columns alone", () => {
    const s = scene(frame("a", {}, "hello"));
    expect(deriveColumns(s)).toBe(s);
  });

  it("flows the story through side-by-side columns", () => {
    // 224 wide, 2 columns, gutter 24: columns of 100 (10 chars), 2 lines each.
    const s = scene(frame("a", cols(2), "aaaa bbbb cccc dddd eeee"));
    const d = resolveScene(s);
    const c1 = d.nodes.get("a")!, c2 = d.nodes.get(columnId("a", 1))!;
    expect(c1.width).toBe(100);
    expect(c2.x).toBe(10 + 124);
    expect(c1.text!.content).toBe("aaaa bbbb\ncccc dddd");
    expect(c2.text!.content).toBe("eeee");
    expect(c2.overset).toBeUndefined();
  });

  it("flags overset on the last column", () => {
    const s = scene(frame("a", cols(2), "aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii"));
    const d = resolveScene(s);
    expect(d.nodes.get(columnId("a", 1))!.overset).toBe(true);
  });

  it("continues into the frame it was linked to", () => {
    const s = scene(frame("a", { meta: { ...cols(2).meta, [META_NEXT]: "z" } }, "aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj"), frame("z", { y: 100 }));
    const d = resolveScene(s);
    expect(d.nodes.get("z")!.text!.content).not.toBe("");
  });

  it("ignores columns on a frame another frame flows into", () => {
    const s = scene(frame("a", { meta: { [META_NEXT]: "b" } }, "x"), frame("b", cols(2)));
    expect(deriveColumns(s)).toBe(s);
  });

  it("sets and clears the columns with ops", () => {
    let s = scene(frame("a"));
    for (const op of setColumnsOps(s.nodes.get("a")!, 3, 8)) s = applyOp(s, op);
    expect(columnsOf(s.nodes.get("a")!)).toBe(3);
    for (const op of setColumnsOps(s.nodes.get("a")!, 1)) s = applyOp(s, op);
    expect(columnsOf(s.nodes.get("a")!)).toBe(1);
  });
});
