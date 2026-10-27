import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { applyOp } from "@/store/applyOp";
import { emptyScene, toPbNode, type NodeLite, type SceneState } from "@/store/types";
import { makeCreateNodeOp, makeUpdatePageOp } from "@/tools/ops";
import { orderKeyBetween } from "@/store/orderKey";
import { zipStore } from "@/export/zip";
import { buildIdml, idmlOps, parseIdml, IdmlError } from "@/export/idml";

const base = (over: Partial<NodeLite>): NodeLite => ({ id: "x", parentId: "page1", orderKey: orderKeyBetween(null, null), name: "n", visible: true, opacity: 1, x: 10, y: 20, width: 100, height: 50, rotation: 0, fills: [{ r: 1, g: 0, b: 0, a: 1 }], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false, ...over });

function scene(): SceneState {
  let k = orderKeyBetween(null, null);
  const next = () => (k = orderKeyBetween(k, null));
  const nodes: NodeLite[] = [
    base({ id: "r", orderKey: k, name: "Box", strokes: [{ color: { r: 0, g: 0, b: 1, a: 1 }, weight: 3, align: "center" }] }),
    base({ id: "e", orderKey: next(), kind: "ellipse", x: 200, y: 100, width: 60, height: 40, fills: [{ r: 0, g: 1, b: 0, a: 1 }] }),
    base({ id: "t", orderKey: next(), kind: "text", x: 30, y: 200, width: 300, height: 80, fills: [{ r: 0.2, g: 0.4, b: 0.6, a: 1 }], text: { content: "Hello & <world>\nSecond", style: { fontFamily: "Inter", fontSize: 24, fontWeight: "700", lineHeight: 1.5, align: "center", italic: true } } }),
    base({ id: "v", orderKey: next(), kind: "vector", x: 50, y: 150, width: 60, height: 40, vector: { subpaths: [{ closed: true, anchors: [{ x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 }, { x: 60, y: 0, inX: -5, inY: 0, outX: 5, outY: 0 }, { x: 30, y: 40, inX: 0, inY: 0, outX: 0, outY: 0 }] }] } }),
  ];
  const s = applyOp(emptyScene("d", "Doc"), makeUpdatePageOp({ id: "page1", name: "Cover", width: 400, height: 600 }));
  return nodes.reduce((acc, n) => applyOp(acc, makeCreateNodeOp(toPbNode(n))), s);
}

describe("IDML", () => {
  it("round-trips pages, shapes, vectors and text through its own importer", async () => {
    const out = buildIdml(scene(), "Doc")!;
    if (process.env.IDML_OUT) writeFileSync(process.env.IDML_OUT, out.bytes);
    expect(out.pages).toBe(1);
    const { pages, notes } = await parseIdml(out.bytes);
    expect(notes).toEqual([]);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ name: "Cover", width: 400, height: 600 });
    const by = (kind: string) => pages[0]!.items.find((i) => i.kind === kind)!;
    expect(by("rect")).toMatchObject({ x: 10, y: 20, width: 100, height: 50, fill: { r: 1, g: 0, b: 0 }, stroke: { weight: 3, color: { b: 1 } } });
    expect(by("ellipse")).toMatchObject({ x: 200, y: 100, width: 60, height: 40 });
    const text = by("text");
    expect(text).toMatchObject({ x: 30, y: 200, width: 300, height: 80 });
    expect(text.text).toMatchObject({ content: "Hello & <world>\nSecond", style: { fontFamily: "Inter", fontSize: 24, fontWeight: "700", italic: true, align: "center" } });
    expect(text.fill!.b).toBeCloseTo(0.6, 2);
    const v = by("vector");
    expect(v.subpaths![0]!.anchors[1]).toMatchObject({ x: 110, y: 150, inX: -5, outX: 5 });
    expect(v.subpaths![0]!.closed).toBe(true);
  });

  it("turns an imported file into pages and nodes of the document", async () => {
    const { pages } = await parseIdml(buildIdml(scene(), "Doc")!.bytes);
    const made = idmlOps(emptyScene("n", "n"), pages);
    expect(made.nodes).toBe(4);
    const after = made.ops.reduce(applyOp, emptyScene("n", "n"));
    expect(after.pages.find((p) => p.id === made.pageIds[0])).toMatchObject({ width: 400, height: 600 });
    expect([...after.nodes.values()].map((n) => n.kind).sort()).toEqual(["ellipse", "rect", "text", "vector"]);
  });

  it("reads a facing-pages spread from InDesign, with CMYK swatches and a group", async () => {
    const P = 'xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="8.0"';
    const t = (s: string) => new TextEncoder().encode(s);
    const rect = (id: string, name: string, color: string, tf: string, w: number, h: number) => `<Rectangle Self="${id}" Name="${name}" FillColor="Color/${color}" ItemTransform="${tf}"><PathGeometry><GeometryPathType PathOpen="false"><PathPointArray><PathPointType Anchor="0 0" LeftDirection="0 0" RightDirection="0 0"/><PathPointType Anchor="0 ${h}" LeftDirection="0 ${h}" RightDirection="0 ${h}"/><PathPointType Anchor="${w} ${h}" LeftDirection="${w} ${h}" RightDirection="${w} ${h}"/><PathPointType Anchor="${w} 0" LeftDirection="${w} 0" RightDirection="${w} 0"/></PathPointArray></GeometryPathType></PathGeometry></Rectangle>`;
    const spread = `<idPkg:Spread ${P}><Spread Self="s1" PageCount="2" ItemTransform="1 0 0 1 0 0"><Page Self="p1" Name="1" GeometricBounds="0 0 200 100" ItemTransform="1 0 0 1 -100 -100"/><Page Self="p2" Name="2" GeometricBounds="0 0 200 100" ItemTransform="1 0 0 1 0 -100"/><Group Self="g" ItemTransform="1 0 0 1 10 0">${rect("r1", "Left", "Cyan", "1 0 0 1 -80 -50", 60, 30)}</Group>${rect("r2", "Right", "Black", "1 0 0 1 20 -50", 10, 10)}<Image Self="im"/></Spread></idPkg:Spread>`;
    const zip = zipStore([
      { name: "mimetype", data: t("application/vnd.adobe.indesign-idml-package") },
      { name: "designmap.xml", data: t(`<Document ${P}><idPkg:Graphic src="Resources/Graphic.xml"/><idPkg:Spread src="Spreads/Spread_s1.xml"/></Document>`) },
      { name: "Resources/Graphic.xml", data: t(`<idPkg:Graphic ${P}><Color Self="Color/Cyan" Space="CMYK" ColorValue="100 0 0 0"/><Color Self="Color/Black" Space="CMYK" ColorValue="0 0 0 100"/></idPkg:Graphic>`) },
      { name: "Spreads/Spread_s1.xml", data: t(spread) },
    ]);
    const { pages, notes } = await parseIdml(zip);
    expect(pages.map((p) => [p.name, p.width, p.height])).toEqual([["1", 100 / 0.75, 200 / 0.75], ["2", 100 / 0.75, 200 / 0.75]]);
    // the group moves "Left" by 10pt: spread x = -80 + 10 = -70 -> page 1 starts at -100 -> 30pt in
    expect(pages[0]!.items[0]).toMatchObject({ name: "Left", x: 30 / 0.75, y: 50 / 0.75, width: 60 / 0.75, fill: { r: 0, g: 1, b: 1 } });
    expect(pages[1]!.items[0]).toMatchObject({ name: "Right", x: 20 / 0.75, fill: { r: 0, g: 0, b: 0 } });
    expect(notes).toEqual([]);
  });

  it("refuses what is not IDML", async () => {
    await expect(parseIdml(new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(IdmlError);
    await expect(parseIdml(zipStore([{ name: "a.txt", data: new Uint8Array([65]) }]))).rejects.toThrow(/not an IDML/);
  });

  it("reports what it leaves out", () => {
    const s = applyOp(scene(), makeCreateNodeOp(toPbNode(base({ id: "g", orderKey: "zzzz", kind: "image", image: { assetHash: "a".repeat(64), originalName: "", pixelWidth: 1, pixelHeight: 1 } }))));
    expect(buildIdml(s, "d")!.skipped).toContain("images");
  });
});
