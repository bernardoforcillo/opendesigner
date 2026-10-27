import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { applyOp } from "@/store/applyOp";
import { emptyScene, toPbNode, type NodeLite, type SceneState } from "@/store/types";
import { makeCreateNodeOp, makeUpdatePageOp } from "@/tools/ops";
import { orderKeyBetween } from "@/store/orderKey";
import { openZip, readZipText } from "@/export/zipRead";
import { buildPptx } from "@/export/pptx";

const base = (over: Partial<NodeLite>): NodeLite => ({ id: "x", parentId: "page1", orderKey: orderKeyBetween(null, null), name: "n", visible: true, opacity: 1, x: 10, y: 20, width: 100, height: 50, rotation: 0, fills: [{ r: 1, g: 0, b: 0, a: 1 }], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false, ...over });

function scene(): SceneState {
  let k = orderKeyBetween(null, null);
  const next = () => (k = orderKeyBetween(k, null));
  const nodes: NodeLite[] = [
    base({ id: "r", orderKey: k, name: "Box", cornerRadius: 8, strokes: [{ color: { r: 0, g: 0, b: 1, a: 1 }, weight: 2, align: "center" }] }),
    base({ id: "e", orderKey: next(), kind: "ellipse", x: 200, fills: [{ r: 0, g: 1, b: 0, a: 1, gradient: { kind: "linear", x1: 0, y1: 0, x2: 1, y2: 0, stops: [{ color: { r: 0, g: 1, b: 0, a: 1 }, position: 0 }, { color: { r: 0, g: 0, b: 0, a: 1 }, position: 1 }] } }] }),
    base({ id: "t", orderKey: next(), kind: "text", fills: [{ r: 0.1, g: 0.1, b: 0.1, a: 1 }], text: { content: "Hello & <world>\nSecond line", style: { fontFamily: "Inter", fontSize: 24, fontWeight: "700", lineHeight: 1.2, align: "center", italic: true } } }),
    base({ id: "v", orderKey: next(), kind: "vector", x: 50, y: 150, width: 60, height: 40, fills: [{ r: 0, g: 0, b: 0, a: 1 }], vector: { subpaths: [{ closed: true, anchors: [{ x: 50, y: 150, inX: 0, inY: 0, outX: 0, outY: 0 }, { x: 110, y: 150, inX: 0, inY: 0, outX: 0, outY: 0 }, { x: 80, y: 190, inX: 0, inY: 0, outX: 0, outY: 0 }] }] } }),
    base({ id: "i", orderKey: next(), kind: "image", x: 300, image: { assetHash: "a".repeat(64), originalName: "p.png", pixelWidth: 1, pixelHeight: 1 } }),
    base({ id: "hid", orderKey: next(), visible: false }),
  ];
  let s = emptyScene("d", "Deck");
  s = applyOp(s, makeUpdatePageOp({ id: "page1", name: "Page 1", width: 800, height: 450 }));
  return nodes.reduce((acc, n) => applyOp(acc, makeCreateNodeOp(toPbNode(n))), s);
}

// 1x1 PNG
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

describe("buildPptx", () => {
  it("writes a slide per page with the shapes, text and picture", async () => {
    const r = buildPptx(scene(), new Map([["a".repeat(64), { bytes: PNG, mime: "image/png" }]]), "Deck")!;
    if (process.env.PPTX_OUT) writeFileSync(process.env.PPTX_OUT, r.bytes);
    expect(r.slides).toBe(1);
    expect(r.skipped).toEqual([]);
    const zip = openZip(r.bytes);
    expect(zip.names).toContain("ppt/media/image1.png");
    const slide = (await readZipText(zip, "ppt/slides/slide1.xml"))!;
    expect(slide).toContain('prst="roundRect"');
    expect(slide).toContain('prst="ellipse"');
    expect(slide).toContain("<a:gradFill");
    expect(slide).toContain("Hello &amp; &lt;world&gt;");
    expect(slide).toContain('algn="ctr"');
    expect(slide).toContain("<a:custGeom>");
    expect(slide).toContain("<p:pic>");
    expect(slide).not.toContain('name="hid"');
    const pres = (await readZipText(zip, "ppt/presentation.xml"))!;
    expect(pres).toContain(`cx="${800 * 9525}" cy="${450 * 9525}"`);
  });
  it("reports images it cannot carry", () => {
    const r = buildPptx(scene(), new Map(), "Deck")!;
    expect(r.skipped).toEqual(["missing image"]);
  });
  it("has nothing to write without pages", () => {
    const s = { ...emptyScene("d", "d"), pages: [] };
    expect(buildPptx(s, new Map(), "x")).toBeNull();
  });
});
