import { localToWorld } from "@/canvas/transform";
import { anchorPoint, inHandlePoint, outHandlePoint } from "@/store/vectorGeometry";
import { childrenOf } from "@/store/tree";
import type { FillLite, NodeLite, SceneState } from "@/store/types";
import { xmlEscape } from "@/export/epub";
import { zipStore, type ZipEntry } from "@/export/zip";

// PPTX (PowerPoint, OOXML): one slide per page, in the page's own size. What is written: rectangles (with rounded corners),
// ellipses, vectors (as custom geometry), text boxes (one paragraph per line of the story, font, size, weight, italic, colour,
// alignment), and PNG/JPEG images; solid and two-stop linear gradient fills, strokes, opacity and rotation. What is NOT: other
// image types, effects (shadows, blurs), masks, auto layout, master pages (their content is drawn on each slide), rich-text
// styles beyond the node's own, and fonts are named, not embedded. Checked by reading the file back with python-pptx; not opened
// in PowerPoint itself.

export interface PptxImage { bytes: Uint8Array; mime: string }

const EMU = 9525; // one px (96 dpi)
const emu = (v: number) => Math.round(v * EMU);
const enc = new TextEncoder();
const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const hex2 = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, "0").toUpperCase();
const rgb = (c: { r: number; g: number; b: number }) => `${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
const clr = (c: { r: number; g: number; b: number; a: number }, extraAlpha = 1) => {
  const a = c.a * extraAlpha;
  return `<a:srgbClr val="${rgb(c)}">${a < 1 ? `<a:alpha val="${Math.round(a * 100000)}"/>` : ""}</a:srgbClr>`;
};

function fillXml(f: FillLite | undefined, opacity: number): string {
  if (!f) return "<a:noFill/>";
  if (f.gradient && f.gradient.kind === "linear" && f.gradient.stops.length >= 2) {
    const g = f.gradient;
    const ang = Math.round(((Math.atan2(g.y2 - g.y1, g.x2 - g.x1) * 180) / Math.PI + 360) % 360 * 60000);
    return `<a:gradFill rotWithShape="1"><a:gsLst>${g.stops.map((s) => `<a:gs pos="${Math.round(Math.max(0, Math.min(1, s.position)) * 100000)}">${clr(s.color, opacity)}</a:gs>`).join("")}</a:gsLst><a:lin ang="${ang}" scaled="0"/></a:gradFill>`;
  }
  return `<a:solidFill>${clr(f, opacity)}</a:solidFill>`;
}

function lineXml(n: NodeLite): string {
  const s = n.strokes[0];
  if (!s || s.weight <= 0) return "<a:ln><a:noFill/></a:ln>";
  return `<a:ln w="${emu(s.weight)}"><a:solidFill>${clr(s.color, n.opacity)}</a:solidFill></a:ln>`;
}

interface Ctx { scene: SceneState; images: ReadonlyMap<string, PptxImage>; media: Map<string, { name: string; img: PptxImage }>; rels: { id: string; target: string; type: string }[]; nextId: number; skipped: Set<string> }

function geom(n: NodeLite, c: Ctx): { xfrm: string; geometry: string } | null {
  const w = c.scene.nodes.has(n.parentId) ? localToWorld(c.scene, n.parentId, n.x, n.y) : { x: n.x, y: n.y };
  const rot = n.rotation ? ` rot="${Math.round((((n.rotation % 360) + 360) % 360) * 60000)}"` : "";
  const xfrm = `<a:xfrm${rot}><a:off x="${emu(w.x)}" y="${emu(w.y)}"/><a:ext cx="${Math.max(1, emu(n.width))}" cy="${Math.max(1, emu(n.height))}"/></a:xfrm>`;
  if (n.kind === "ellipse") return { xfrm, geometry: '<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>' };
  if (n.kind === "vector" && n.vector) {
    const pt = (p: { x: number; y: number }) => `<a:pt x="${emu(p.x - n.x)}" y="${emu(p.y - n.y)}"/>`;
    let path = "";
    for (const sp of n.vector.subpaths) {
      if (sp.anchors.length < 2) continue;
      path += `<a:moveTo>${pt(anchorPoint(n, sp.anchors[0]!))}</a:moveTo>`;
      const segs = sp.closed ? sp.anchors.length : sp.anchors.length - 1;
      for (let i = 0; i < segs; i++) {
        const a = sp.anchors[i]!, b = sp.anchors[(i + 1) % sp.anchors.length]!;
        path += `<a:cubicBezTo>${pt(outHandlePoint(n, a))}${pt(inHandlePoint(n, b))}${pt(anchorPoint(n, b))}</a:cubicBezTo>`;
      }
      if (sp.closed) path += "<a:close/>";
    }
    if (path === "") return null;
    return { xfrm, geometry: `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst><a:path w="${Math.max(1, emu(n.width))}" h="${Math.max(1, emu(n.height))}">${path}</a:path></a:pathLst></a:custGeom>` };
  }
  if (n.cornerRadius > 0) {
    const adj = Math.round(Math.min(50000, (n.cornerRadius / Math.max(1, Math.min(n.width, n.height))) * 100000));
    return { xfrm, geometry: `<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ${adj}"/></a:avLst></a:prstGeom>` };
  }
  return { xfrm, geometry: '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' };
}

function shapeXml(n: NodeLite, c: Ctx): string {
  const id = c.nextId++;
  const name = xmlEscape(n.name || `Shape ${id}`);
  if (n.kind === "image") {
    const hash = n.image?.assetHash ?? "";
    const img = c.images.get(hash);
    if (!img || (img.mime !== "image/png" && img.mime !== "image/jpeg")) { c.skipped.add(img ? `${img.mime} image` : "missing image"); return ""; }
    let m = c.media.get(hash);
    if (!m) { m = { name: `image${c.media.size + 1}.${img.mime === "image/png" ? "png" : "jpg"}`, img }; c.media.set(hash, m); }
    const rid = `rId${c.rels.length + 2}`;
    c.rels.push({ id: rid, target: `../media/${m.name}`, type: "image" });
    const g = geom({ ...n, kind: "rect", cornerRadius: 0 }, c)!;
    return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${name}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${g.xfrm}${g.geometry}</p:spPr></p:pic>`;
  }
  const g = geom(n, c);
  if (!g) return "";
  if (n.kind === "text" && n.text) {
    const st = n.text.style;
    const color = n.fills[0] ?? { r: 0, g: 0, b: 0, a: 1 };
    const align = st.align === "center" ? "ctr" : st.align === "right" ? "r" : st.align === "justify" ? "just" : "l";
    const sz = Math.max(100, Math.round(st.fontSize * 0.75 * 100));
    const bold = Number(st.fontWeight) >= 600 || st.fontWeight === "bold";
    const paras = n.text.content.replace(/\r\n?/g, "\n").split("\n").map((line) => {
      const rPr = `<a:rPr lang="en-US" sz="${sz}"${bold ? ' b="1"' : ""}${st.italic ? ' i="1"' : ""}${st.underline ? ' u="sng"' : ""} dirty="0"><a:solidFill>${clr(color, n.opacity)}</a:solidFill>${st.fontFamily ? `<a:latin typeface="${xmlEscape(st.fontFamily)}"/>` : ""}</a:rPr>`;
      return `<a:p><a:pPr algn="${align}">${st.lineHeight ? `<a:lnSpc><a:spcPct val="${Math.round(st.lineHeight * 100000)}"/></a:lnSpc>` : ""}</a:pPr>${line === "" ? `<a:endParaRPr lang="en-US" sz="${sz}"/>` : `<a:r>${rPr}<a:t>${xmlEscape(line)}</a:t></a:r>`}</a:p>`;
    });
    return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${g.xfrm}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0"><a:noAutofit/></a:bodyPr><a:lstStyle/>${paras.join("")}</p:txBody></p:sp>`;
  }
  if (n.kind !== "rect" && n.kind !== "ellipse" && n.kind !== "vector") return "";
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${g.xfrm}${g.geometry}${n.vector && !n.fills.length ? "<a:noFill/>" : fillXml(n.fills.find((f) => !f.image) ?? n.fills[0], n.opacity)}${lineXml(n)}</p:spPr></p:sp>`;
}

const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const rels = (list: { id: string; type: string; target: string }[]) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.map((r) => `<Relationship Id="${r.id}" Type="${r.type.startsWith("http") ? r.type : `${REL}/${r.type}`}" Target="${r.target}"/>`).join("")}</Relationships>`;
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const THEME = `${XML}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;

/** The visible nodes under `parentId` in drawing order, children right after their parent (a hidden node hides its subtree). */
function drawOrder(scene: SceneState, parentId: string, depth = 0): NodeLite[] {
  if (depth > 64) return [];
  return childrenOf(scene, parentId).filter((n) => n.visible).flatMap((n) => [n, ...drawOrder(scene, n.id, depth + 1)]);
}

export interface PptxResult { bytes: Uint8Array; slides: number; skipped: string[] }

/** The deck. `images` holds the bytes of each image asset by hash. Pages without a size use `fallback` (width x height). */
export function buildPptx(scene: SceneState, images: ReadonlyMap<string, PptxImage>, title: string, fallback = { width: 960, height: 540 }): PptxResult | null {
  const pages = scene.pages.filter((p) => !p.isMaster);
  if (pages.length === 0) return null;
  const size = { width: pages[0]!.width || fallback.width, height: pages[0]!.height || fallback.height };
  const media = new Map<string, { name: string; img: PptxImage }>();
  const skipped = new Set<string>();
  const slideFiles: ZipEntry[] = [];
  pages.forEach((page, i) => {
    const ctx: Ctx = { scene, images, media, rels: [{ id: "rId1", target: "../slideLayouts/slideLayout1.xml", type: "slideLayout" }], nextId: 2, skipped };
    const nodes = drawOrder(scene, page.id);
    const shapes = nodes.map((n) => shapeXml(n, ctx)).join("");
    slideFiles.push(
      { name: `ppt/slides/slide${i + 1}.xml`, data: enc.encode(`${XML}<p:sld ${NS}><p:cSld name="${xmlEscape(page.name)}"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`) },
      { name: `ppt/slides/_rels/slide${i + 1}.xml.rels`, data: enc.encode(rels(ctx.rels)) },
    );
  });
  // Descendants of a page whose own width differs are drawn at the first page's slide size; pages of other sizes keep their content but
  // share the deck's size (a deck has one).
  const entries: ZipEntry[] = [
    { name: "[Content_Types].xml", data: enc.encode(`${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpg" ContentType="image/jpeg"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${pages.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("")}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`) },
    { name: "_rels/.rels", data: enc.encode(rels([{ id: "rId1", type: "officeDocument", target: "ppt/presentation.xml" }, { id: "rId2", type: "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties", target: "docProps/core.xml" }])) },
    { name: "docProps/core.xml", data: enc.encode(`${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xmlEscape(title)}</dc:title></cp:coreProperties>`) },
    { name: "ppt/presentation.xml", data: enc.encode(`${XML}<p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${pages.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join("")}</p:sldIdLst><p:sldSz cx="${emu(size.width)}" cy="${emu(size.height)}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`) },
    { name: "ppt/_rels/presentation.xml.rels", data: enc.encode(rels([{ id: "rId1", type: "slideMaster", target: "slideMasters/slideMaster1.xml" }, ...pages.map((_, i) => ({ id: `rId${i + 2}`, type: "slide", target: `slides/slide${i + 1}.xml` })), { id: `rId${pages.length + 2}`, type: "theme", target: "theme/theme1.xml" }])) },
    { name: "ppt/slideMasters/slideMaster1.xml", data: enc.encode(`${XML}<p:sldMaster ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`) },
    { name: "ppt/slideMasters/_rels/slideMaster1.xml.rels", data: enc.encode(rels([{ id: "rId1", type: "slideLayout", target: "../slideLayouts/slideLayout1.xml" }, { id: "rId2", type: "theme", target: "../theme/theme1.xml" }])) },
    { name: "ppt/slideLayouts/slideLayout1.xml", data: enc.encode(`${XML}<p:sldLayout ${NS} type="blank"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`) },
    { name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels", data: enc.encode(rels([{ id: "rId1", type: "slideMaster", target: "../slideMasters/slideMaster1.xml" }])) },
    { name: "ppt/theme/theme1.xml", data: enc.encode(THEME) },
    ...slideFiles,
    ...[...media.values()].map((m) => ({ name: `ppt/media/${m.name}`, data: m.img.bytes })),
  ];
  return { bytes: zipStore(entries), slides: pages.length, skipped: [...skipped] };
}
