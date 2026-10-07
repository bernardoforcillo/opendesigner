import { describe, expect, it } from "vitest";
import { fontFamiliesOnPage } from "./pageFonts";
import { nodesOf } from "../store/nodeMap";
import { emptyScene } from "../store/types";
import type { NodeLite } from "../store/types";

const base = { visible: true, opacity: 1, x: 0, y: 0, width: 10, height: 10, rotation: 0, fills: [], strokes: [], cornerRadius: 0, clipsContent: false };
const text = (id: string, parentId: string, family: string): NodeLite => ({ ...base, id, parentId, orderKey: id, name: id, kind: "text", text: { content: "x", style: { fontFamily: family, fontSize: 12, fontWeight: "400", lineHeight: 0, align: "left" } } });
const mk = (nodes: Record<string, NodeLite>) => ({ ...emptyScene("d", "t"), pages: [{ id: "p1", name: "1" }, { id: "p2", name: "2" }], nodes: nodesOf(nodes) });

describe("fontFamiliesOnPage", () => {
  it("lists the families of the page's text, nested ones included, and nothing from other pages", () => {
    const frame: NodeLite = { ...base, id: "f", parentId: "p1", orderKey: "a", name: "f", kind: "frame" };
    const s = mk({ f: frame, t1: text("t1", "f", "Alpha, sans-serif"), t2: text("t2", "p2", "Beta") });
    expect([...fontFamiliesOnPage(s, "p1")!]).toEqual(["alpha"]);
    expect([...fontFamiliesOnPage(s, "p2")!]).toEqual(["beta"]);
  });

  it("gives up (null = load all) on a page with an instance", () => {
    const inst: NodeLite = { ...base, id: "i", parentId: "p1", orderKey: "a", name: "i", kind: "instance" };
    expect(fontFamiliesOnPage(mk({ i: inst }), "p1")).toBeNull();
  });
});
