import { localToWorld } from "../canvas/transform";
import { anchorPoint, inHandlePoint, outHandlePoint } from "../store/vectorGeometry";
import { childrenOf } from "../store/tree";
import { orderKeyBetween } from "../store/orderKey";
import { toPbNode, type AnchorLite, FillLite, NodeLite, SceneState, SubPathLite, TextStyleLite } from "../store/types";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { makeCreateNodeOp, makeCreatePageWithMasterOp, uuid } from "../tools/ops";
import { openZip, readZipText } from "./zipRead";
import { xmlEscape } from "./epub";
import { zipStore, type ZipEntry } from "./zip";

// IDML (InDesign Markup Language), the open interchange format of InDesign. EXPORT writes one spread per page with rectangles,
// ellipses, vectors and text frames (the story with its font, size, bold/italic and colour per frame), RGB swatches, and a
// paragraph style per text style used. IMPORT reads the same things from any IDML (including InDesign's own): pages and their
// sizes, rectangles/ovals/polygons/lines/text frames with their transforms, solid fills and strokes (CMYK is converted naively),
// and the text of the stories.
// Not carried over either way: images and links, effects, master pages' items, gradients, character styles, tables, footnotes,
// tracking and OpenType features. The package follows the IDML structure but was NOT opened in InDesign; the tests read it back
// with the importer below.

const PT = 0.75; // one document px in points
const IDPKG = 'xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const enc = new TextEncoder();
const f = (v: number) => String(Math.round(v * 10000) / 10000);

export interface IdmlResult { bytes: Uint8Array; pages: number; skipped: string[] }

function drawOrder(scene: SceneState, parentId: string, depth = 0): NodeLite[] {
  if (depth > 64) return [];
  return childrenOf(scene, parentId).filter((n) => n.visible).flatMap((n) => [n, ...drawOrder(scene, n.id, depth + 1)]);
}

/** The package, or null when the document has no pages. */
export function buildIdml(scene: SceneState, title: string, fallback = { width: 612 / PT, height: 792 / PT }): IdmlResult | null {
  const pages = scene.pages.filter((p) => !p.isMaster);
  if (pages.length === 0) return null;
  const skipped = new Set<string>();
  const colors = new Map<string, string>(); // swatch id -> "r g b"
  const colorRef = (c: { r: number; g: number; b: number }) => {
    const v = `${Math.round(c.r * 255)} ${Math.round(c.g * 255)} ${Math.round(c.b * 255)}`;
    const id = `Color/rgb_${v.replace(/ /g, "_")}`;
    colors.set(id, v);
    return id;
  };
  const stories: ZipEntry[] = [];
  const spreads: ZipEntry[] = [];
  const pstyles = new Map<string, string>(); // style id -> name
  let uid = 100;
  const nextId = () => `u${(uid++).toString(16)}`;

  pages.forEach((page, pi) => {
    const W = page.width || fallback.width, H = page.height || fallback.height;
    const spreadId = nextId(), pageId = nextId();
    let items = "";
    for (const n of drawOrder(scene, page.id)) {
      if (n.kind === "group" || n.kind === "frame" && false) continue;
      const w = scene.nodes.has(n.parentId) ? localToWorld(scene, n.parentId, n.x, n.y) : { x: n.x, y: n.y };
      // Spread coordinates are in points with the origin at the middle of the (single-page) spread.
      const tx = f((w.x - W / 2) * PT), ty = f((w.y - H / 2) * PT);
      const rot = n.rotation ? (n.rotation * Math.PI) / 180 : 0;
      const m = `${f(Math.cos(rot))} ${f(Math.sin(rot))} ${f(-Math.sin(rot))} ${f(Math.cos(rot))} ${tx} ${ty}`;
      const w1 = f(n.width * PT), h1 = f(n.height * PT);
      const rectPath = `<PathGeometry><GeometryPathType PathOpen="false"><PathPointArray>${[[0, 0], [0, h1], [w1, h1], [w1, 0]].map(([x, y]) => `<PathPointType Anchor="${x} ${y}" LeftDirection="${x} ${y}" RightDirection="${x} ${y}"/>`).join("")}</PathPointArray></GeometryPathType></PathGeometry>`;
      const fill = n.fills.find((x) => !x.image && !x.gradient) ?? n.fills[0];
      if (n.fills.some((x) => x.gradient)) skipped.add("gradients (first colour used)");
      if (n.effects?.length) skipped.add("effects");
      const paint = `FillColor="${fill && !fill.image ? colorRef(fill) : "Swatch/None"}" ${n.strokes[0] ? `StrokeColor="${colorRef(n.strokes[0].color)}" StrokeWeight="${f(n.strokes[0].weight * PT)}"` : 'StrokeColor="Swatch/None" StrokeWeight="0"'}`;
      const id = nextId();
      const common = `Self="${id}" Name="${xmlEscape(n.name)}" ItemTransform="${m}" ContentType=`;
      if (n.kind === "rect") items += `<Rectangle ${common}"Unassigned" ${paint}>${rectPath}</Rectangle>`;
      else if (n.kind === "ellipse") {
        const k = 0.5522847498;
        const cx = n.width * PT / 2, cy = n.height * PT / 2;
        const P = (ax: number, ay: number, lx: number, ly: number, rx: number, ry: number) => `<PathPointType Anchor="${f(ax)} ${f(ay)}" LeftDirection="${f(lx)} ${f(ly)}" RightDirection="${f(rx)} ${f(ry)}"/>`;
        items += `<Oval ${common}"Unassigned" ${paint}><PathGeometry><GeometryPathType PathOpen="false"><PathPointArray>${P(cx, 0, cx - k * cx, 0, cx + k * cx, 0)}${P(2 * cx, cy, 2 * cx, cy - k * cy, 2 * cx, cy + k * cy)}${P(cx, 2 * cy, cx + k * cx, 2 * cy, cx - k * cx, 2 * cy)}${P(0, cy, 0, cy + k * cy, 0, cy - k * cy)}</PathPointArray></GeometryPathType></PathGeometry></Oval>`;
      } else if (n.kind === "vector" && n.vector) {
        const paths = n.vector.subpaths.filter((s) => s.anchors.length >= 2).map((sp) => {
          const pt = (p: { x: number; y: number }) => `${f((p.x - n.x) * PT)} ${f((p.y - n.y) * PT)}`;
          return `<GeometryPathType PathOpen="${sp.closed ? "false" : "true"}"><PathPointArray>${sp.anchors.map((a) => `<PathPointType Anchor="${pt(anchorPoint(n, a))}" LeftDirection="${pt(inHandlePoint(n, a))}" RightDirection="${pt(outHandlePoint(n, a))}"/>`).join("")}</PathPointArray></GeometryPathType>`;
        }).join("");
        if (paths) items += `<Polygon ${common}"Unassigned" ${paint}><PathGeometry>${paths}</PathGeometry></Polygon>`;
      } else if (n.kind === "text" && n.text) {
        const sid = nextId();
        const st = n.text.style;
        const color = n.fills[0] ?? { r: 0, g: 0, b: 0, a: 1 };
        const paras = n.text.content.replace(/\r\n?/g, "\n").split("\n");
        const ps = paras.map((para, i) => {
          const styleId = n.text!.paragraphStyles?.[i];
          const def = styleId ? scene.textStyles[styleId] : undefined;
          if (styleId && def) pstyles.set(styleId, def.name);
          const applied = def ? `ParagraphStyle/${xmlEscape(def.name)}` : "ParagraphStyle/$ID/NormalParagraphStyle";
          const fs = [Number(st.fontWeight) >= 600 || st.fontWeight === "bold" ? "Bold" : "", st.italic ? "Italic" : ""].filter(Boolean).join(" ") || "Regular";
          return `<ParagraphStyleRange AppliedParagraphStyle="${applied}" Justification="${st.align === "center" ? "CenterAlign" : st.align === "right" ? "RightAlign" : st.align === "justify" ? "LeftJustified" : "LeftAlign"}"><CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]" FillColor="${colorRef(color)}" PointSize="${f(st.fontSize * PT)}" FontStyle="${fs}"${st.lineHeight ? ` Leading="${f(st.fontSize * st.lineHeight * PT)}"` : ""}>${st.fontFamily ? `<Properties><AppliedFont type="string">${xmlEscape(st.fontFamily)}</AppliedFont></Properties>` : ""}<Content>${xmlEscape(para)}</Content>${i < paras.length - 1 ? "<Br/>" : ""}</CharacterStyleRange></ParagraphStyleRange>`;
        }).join("");
        stories.push({ name: `Stories/Story_${sid}.xml`, data: enc.encode(`${XML}<idPkg:Story ${IDPKG} DOMVersion="8.0"><Story Self="${sid}" AppliedTOCStyle="n" TrackChanges="false" StoryTitle="${xmlEscape(n.name)}" AppliedNamedGrid="n"><StoryPreference OpticalMarginAlignment="false" OpticalMarginSize="12" FrameType="TextFrameType" StoryOrientation="Horizontal" StoryDirection="LeftToRightDirection"/>${ps}</Story></idPkg:Story>`) });
        items += `<TextFrame ${common}"TextType" ParentStory="${sid}" PreviousTextFrame="n" NextTextFrame="n" ${`FillColor="Swatch/None" StrokeColor="Swatch/None" StrokeWeight="0"`}><Properties/>${rectPath}<TextFramePreference TextColumnCount="1" TextColumnGutter="12"/></TextFrame>`;
      } else if (n.kind === "image") skipped.add("images");
      else if (n.kind === "instance") skipped.add("component instances");
    }
    spreads.push({
      name: `Spreads/Spread_${spreadId}.xml`,
      data: enc.encode(`${XML}<idPkg:Spread ${IDPKG} DOMVersion="8.0"><Spread Self="${spreadId}" PageCount="1" BindingLocation="0" AllowPageShuffle="true" ShowMasterItems="true" ItemTransform="1 0 0 1 0 0"><Page Self="${pageId}" Name="${pi + 1}" AppliedMaster="n" GeometricBounds="0 0 ${f(H * PT)} ${f(W * PT)}" ItemTransform="1 0 0 1 ${f((-W * PT) / 2)} ${f((-H * PT) / 2)}" MasterPageTransform="1 0 0 1 0 0" OverrideList="" TabOrder="" AppliedTrapPreset="n"><Properties><Descriptor type="list"><ListItem type="string">${xmlEscape(page.name)}</ListItem></Descriptor></Properties></Page>${items}</Spread></idPkg:Spread>`),
    });
  });

  const swatches = [...colors].map(([id, v]) => `<Color Self="${id}" Model="Process" Space="RGB" ColorValue="${v}" Name="${xmlEscape(id.replace("Color/", ""))}"/>`).join("");
  const graphic = `${XML}<idPkg:Graphic ${IDPKG} DOMVersion="8.0"><Color Self="Color/Black" Model="Process" Space="CMYK" ColorValue="0 0 0 100" Name="Black"/><Color Self="Color/Paper" Model="Process" Space="CMYK" ColorValue="0 0 0 0" Name="Paper"/>${swatches}<Swatch Self="Swatch/None" Name="None"/></idPkg:Graphic>`;
  const styleList = [...pstyles].map(([, name]) => `<ParagraphStyle Self="ParagraphStyle/${xmlEscape(name)}" Name="${xmlEscape(name)}"/>`).join("");
  const styles = `${XML}<idPkg:Styles ${IDPKG} DOMVersion="8.0"><RootCharacterStyleGroup Self="rcsg"><CharacterStyle Self="CharacterStyle/$ID/[No character style]" Name="$ID/[No character style]"/></RootCharacterStyleGroup><RootParagraphStyleGroup Self="rpsg"><ParagraphStyle Self="ParagraphStyle/$ID/NormalParagraphStyle" Name="$ID/NormalParagraphStyle"/>${styleList}</RootParagraphStyleGroup></idPkg:Styles>`;
  const first = pages[0]!;
  const prefs = `${XML}<idPkg:Preferences ${IDPKG} DOMVersion="8.0"><DocumentPreference PageHeight="${f((first.height || fallback.height) * PT)}" PageWidth="${f((first.width || fallback.width) * PT)}" PagesPerDocument="${pages.length}" FacingPages="false" DocumentBleedTopOffset="0" DocumentBleedBottomOffset="0" DocumentBleedInsideOrLeftOffset="0" DocumentBleedOutsideOrRightOffset="0"/></idPkg:Preferences>`;
  const designmap = `${XML}<Document ${IDPKG} DOMVersion="8.0" Self="d" StoryList="${stories.map((s) => /Story_(\w+)\.xml/.exec(s.name)![1]).join(" ")}" Name="${xmlEscape(title)}"><idPkg:Graphic src="Resources/Graphic.xml"/><idPkg:Fonts src="Resources/Fonts.xml"/><idPkg:Styles src="Resources/Styles.xml"/><idPkg:Preferences src="Resources/Preferences.xml"/>${spreads.map((s) => `<idPkg:Spread src="${s.name}"/>`).join("")}${stories.map((s) => `<idPkg:Story src="${s.name}"/>`).join("")}</Document>`;
  const entries: ZipEntry[] = [
    { name: "mimetype", data: enc.encode("application/vnd.adobe.indesign-idml-package") },
    { name: "META-INF/container.xml", data: enc.encode(`${XML}<container><rootfiles><rootfile full-path="designmap.xml" media-type="text/xml"/></rootfiles></container>`) },
    { name: "designmap.xml", data: enc.encode(designmap) },
    { name: "Resources/Graphic.xml", data: enc.encode(graphic) },
    { name: "Resources/Fonts.xml", data: enc.encode(`${XML}<idPkg:Fonts ${IDPKG} DOMVersion="8.0"/>`) },
    { name: "Resources/Styles.xml", data: enc.encode(styles) },
    { name: "Resources/Preferences.xml", data: enc.encode(prefs) },
    ...spreads,
    ...stories,
  ];
  return { bytes: zipStore(entries), pages: pages.length, skipped: [...skipped] };
}

// --- import -----------------------------------------------------------------------------------------------------------------

export class IdmlError extends Error {}

export interface IdmlItem { kind: "rect" | "ellipse" | "vector" | "text"; name: string; x: number; y: number; width: number; height: number; fill?: FillLite; stroke?: { color: FillLite; weight: number }; text?: { content: string; style: TextStyleLite; paragraphs: string[] }; subpaths?: SubPathLite[] }
export interface IdmlPage { name: string; width: number; height: number; items: IdmlItem[] }

type M = [number, number, number, number, number, number]; // a b c d tx ty
const ID: M = [1, 0, 0, 1, 0, 0];
const mul = (p: M, c: M): M => [p[0] * c[0] + p[2] * c[1], p[1] * c[0] + p[3] * c[1], p[0] * c[2] + p[2] * c[3], p[1] * c[2] + p[3] * c[3], p[0] * c[4] + p[2] * c[5] + p[4], p[1] * c[4] + p[3] * c[5] + p[5]];
const apply = (m: M, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const matrix = (s: string | null): M => { const v = (s ?? "").trim().split(/\s+/).map(Number); return v.length === 6 && v.every(Number.isFinite) ? (v as M) : ID; };
const nums = (s: string | null): number[] => (s ?? "").trim().split(/\s+/).map(Number);

const kids = (el: Element, name: string) => [...el.children].filter((c) => c.localName === name);
const deep = (el: Element | Document, name: string) => [...el.getElementsByTagNameNS("*", name)];
const parse = (text: string) => {
  const d = new DOMParser().parseFromString(text, "application/xml");
  if (d.getElementsByTagName("parsererror").length > 0) throw new IdmlError("an XML part of the file is damaged");
  return d;
};

function cmykToRgb(c: number, m: number, y: number, k: number) {
  const K = 1 - k / 100;
  return { r: (1 - c / 100) * K, g: (1 - m / 100) * K, b: (1 - y / 100) * K, a: 1 };
}

/** Pages and items of an IDML package (see the top of the file for what is read). */
export async function parseIdml(bytes: Uint8Array): Promise<{ pages: IdmlPage[]; notes: string[] }> {
  let zip;
  try { zip = openZip(bytes); } catch { throw new IdmlError("that is not an IDML file (not a zip)"); }
  const mime = await readZipText(zip, "mimetype");
  const mapText = await readZipText(zip, "designmap.xml");
  if (mapText === null || (mime !== null && !mime.startsWith("application/vnd.adobe.indesign-idml-package"))) throw new IdmlError("that is not an IDML file");
  const map = parse(mapText);
  const src = (name: string) => deep(map, name).map((e) => e.getAttribute("src") ?? "").filter(Boolean);
  const notes = new Set<string>();

  const colors = new Map<string, FillLite>();
  for (const g of src("Graphic")) {
    const t = await readZipText(zip, g);
    if (t === null) continue;
    for (const c of deep(parse(t), "Color")) {
      const v = nums(c.getAttribute("ColorValue"));
      const space = c.getAttribute("Space");
      if (space === "RGB" && v.length >= 3) colors.set(c.getAttribute("Self")!, { r: v[0]! / 255, g: v[1]! / 255, b: v[2]! / 255, a: 1 });
      else if (space === "CMYK" && v.length >= 4) colors.set(c.getAttribute("Self")!, cmykToRgb(v[0]!, v[1]!, v[2]!, v[3]!));
    }
  }
  const stories = new Map<string, { paragraphs: string[]; style: TextStyleLite; color?: FillLite }>();
  for (const s of src("Story")) {
    const t = await readZipText(zip, s);
    if (t === null) continue;
    for (const story of deep(parse(t), "Story")) {
      const paragraphs: string[] = [""];
      let style: TextStyleLite | null = null;
      let color: FillLite | undefined;
      for (const psr of deep(story, "ParagraphStyleRange")) {
        for (const csr of kids(psr, "CharacterStyleRange")) {
          if (!style) {
            color = colors.get(csr.getAttribute("FillColor") ?? "");
            const fs = csr.getAttribute("FontStyle") ?? "";
            const font = deep(csr, "AppliedFont")[0]?.textContent ?? csr.getAttribute("AppliedFont") ?? "";
            const ptSize = Number(csr.getAttribute("PointSize"));
            const lead = Number(csr.getAttribute("Leading"));
            style = { fontFamily: font, fontSize: Number.isFinite(ptSize) && ptSize > 0 ? ptSize / PT : 16, fontWeight: /bold|black|heavy/i.test(fs) ? "700" : "", lineHeight: Number.isFinite(lead) && ptSize > 0 ? lead / ptSize : 1.3, align: psr.getAttribute("Justification") === "CenterAlign" ? "center" : psr.getAttribute("Justification") === "RightAlign" ? "right" : "left", ...(/italic|oblique/i.test(fs) ? { italic: true } : {}) };
          }
          for (const c of csr.children) {
            if (c.localName === "Content") paragraphs[paragraphs.length - 1] += c.textContent ?? "";
            else if (c.localName === "Br") paragraphs.push("");
            else if (c.localName === "Table" || c.localName === "Rectangle" || c.localName === "TextFrame") notes.add("tables and anchored objects inside text");
          }
        }
      }
      while (paragraphs.length > 1 && paragraphs.at(-1) === "") paragraphs.pop();
      stories.set(story.getAttribute("Self")!, { paragraphs, ...(color ? { color } : {}), style: style ?? { fontFamily: "", fontSize: 16, fontWeight: "", lineHeight: 1.3, align: "left" } });
    }
  }

  const pages: IdmlPage[] = [];
  for (const sp of src("Spread")) {
    const t = await readZipText(zip, sp);
    if (t === null) continue;
    for (const spread of deep(parse(t), "Spread")) {
      const sm = matrix(spread.getAttribute("ItemTransform"));
      const here: { page: IdmlPage; ox: number; oy: number; w: number; h: number }[] = [];
      for (const pg of kids(spread, "Page")) {
        const b = nums(pg.getAttribute("GeometricBounds")); // top left bottom right
        if (b.length !== 4 || !b.every(Number.isFinite)) continue;
        const pm = mul(sm, matrix(pg.getAttribute("ItemTransform")));
        const [ox, oy] = apply(pm, b[1]!, b[0]!);
        const page: IdmlPage = { name: deep(pg, "ListItem")[0]?.textContent || pg.getAttribute("Name") || `Page ${pages.length + 1}`, width: (b[3]! - b[1]!) / PT, height: (b[2]! - b[0]!) / PT, items: [] };
        here.push({ page, ox, oy, w: b[3]! - b[1]!, h: b[2]! - b[0]! });
        pages.push(page);
      }
      if (here.length === 0) continue;
      const place = (el: Element, parent: M) => {
        const m = mul(parent, matrix(el.getAttribute("ItemTransform")));
        const name = el.localName;
        if (name === "Group") { for (const c of el.children) place(c, m); return; }
        const kind = name === "Rectangle" ? "rect" : name === "Oval" ? "ellipse" : name === "TextFrame" ? "text" : name === "Polygon" || name === "GraphicLine" ? "vector" : null;
        if (!kind) { if (!["Properties", "TextFramePreference", "FrameFittingOption", "TextWrapPreference", "ObjectExportOption"].includes(name) && /^[A-Z]/.test(name) && !["Image", "EPS", "PDF", "Link"].includes(name)) notes.add(name); return; }
        if (deep(el, "Image").length + deep(el, "PDF").length + deep(el, "EPS").length > 0) notes.add("images (placed pictures)");
        const paths: { pts: { a: [number, number]; l: [number, number]; r: [number, number] }[]; open: boolean }[] = [];
        for (const gp of deep(el, "GeometryPathType")) {
          const pts = deep(gp, "PathPointType").map((pp) => {
            const a = nums(pp.getAttribute("Anchor")), l = nums(pp.getAttribute("LeftDirection")), r = nums(pp.getAttribute("RightDirection"));
            return { a: apply(m, a[0]!, a[1]!), l: apply(m, l[0]!, l[1]!), r: apply(m, r[0]!, r[1]!) };
          });
          if (pts.length > 0) paths.push({ pts, open: gp.getAttribute("PathOpen") === "true" });
        }
        if (paths.length === 0) return;
        const all = paths.flatMap((p) => p.pts.map((q) => q.a));
        const minX = Math.min(...all.map((q) => q[0])), maxX = Math.max(...all.map((q) => q[0])), minY = Math.min(...all.map((q) => q[1])), maxY = Math.max(...all.map((q) => q[1]));
        const cx = (minX + maxX) / 2;
        const target = here.find((h) => cx >= h.ox && cx <= h.ox + h.w) ?? here[0]!;
        const px = (x: number) => (x - target.ox) / PT, py = (y: number) => (y - target.oy) / PT;
        const fillRef = el.getAttribute("FillColor") ?? "";
        const strokeRef = el.getAttribute("StrokeColor") ?? "";
        if (fillRef.startsWith("Gradient/")) notes.add("gradients");
        const item: IdmlItem = { kind, name: el.getAttribute("Name") ?? "", x: px(minX), y: py(minY), width: (maxX - minX) / PT, height: (maxY - minY) / PT, ...(colors.has(fillRef) ? { fill: colors.get(fillRef)! } : {}), ...(colors.has(strokeRef) && Number(el.getAttribute("StrokeWeight")) > 0 ? { stroke: { color: colors.get(strokeRef)!, weight: Number(el.getAttribute("StrokeWeight")) / PT } } : {}) };
        if (kind === "vector") {
          item.subpaths = paths.map((p) => ({ closed: !p.open, anchors: p.pts.map((q): AnchorLite => ({ x: px(q.a[0]), y: py(q.a[1]), inX: px(q.l[0]) - px(q.a[0]), inY: py(q.l[1]) - py(q.a[1]), outX: px(q.r[0]) - px(q.a[0]), outY: py(q.r[1]) - py(q.a[1]) })) }));
        }
        if (kind === "text") {
          const story = stories.get(el.getAttribute("ParentStory") ?? "");
          if (!story) return;
          item.text = { content: story.paragraphs.join("\n"), style: story.style, paragraphs: story.paragraphs };
          if (story.color) item.fill = story.color; else delete item.fill;
        }
        if (Math.abs(m[1]) > 1e-6 || Math.abs(m[2]) > 1e-6) notes.add("rotation and skew of rectangles, ovals and frames (drawn upright)");
        target.page.items.push(item);
      };
      for (const el of spread.children) if (el.localName !== "Page" && el.localName !== "FlattenerPreference") place(el, sm);
    }
  }
  if (pages.length === 0) throw new IdmlError("the file has no pages");
  return { pages, notes: [...notes] };
}

/** The node an imported item becomes (ids and keys are the caller's). */
export function idmlItemNode(item: IdmlItem, id: string, parentId: string, orderKey: string): NodeLite {
  const base = { id, parentId, orderKey, name: item.name || (item.kind === "text" ? "Text" : item.kind), visible: true, opacity: 1, x: item.x, y: item.y, width: Math.max(1, item.width), height: Math.max(1, item.height), rotation: 0, strokes: item.stroke ? [{ color: item.stroke.color, weight: item.stroke.weight, align: "center" as const }] : [], cornerRadius: 0, clipsContent: false };
  if (item.kind === "text") return { ...base, kind: "text", fills: [item.fill ?? { r: 0, g: 0, b: 0, a: 1 }], strokes: [], text: { content: item.text!.content, style: item.text!.style } };
  if (item.kind === "vector") return { ...base, kind: "vector", fills: item.fill ? [item.fill] : [], vector: { subpaths: item.subpaths! } };
  return { ...base, kind: item.kind, fills: item.fill ? [item.fill] : [] };
}

/** The ops that add the imported pages (sized as in the file) and their items to the document. */
export function idmlOps(scene: SceneState, pages: readonly IdmlPage[]): { ops: Op[]; pageIds: string[]; nodes: number } {
  const ops: Op[] = [];
  const pageIds: string[] = [];
  let nodes = 0;
  void scene;
  for (const page of pages) {
    const pageId = uuid();
    pageIds.push(pageId);
    ops.push(makeCreatePageWithMasterOp(pageId, page.name, { width: Math.round(page.width * 100) / 100, height: Math.round(page.height * 100) / 100 }));
    let key: string | null = null;
    for (const item of page.items) {
      key = orderKeyBetween(key, null);
      ops.push(makeCreateNodeOp(toPbNode(idmlItemNode(item, uuid(), pageId, key))));
      nodes++;
    }
  }
  return { ops, pageIds, nodes };
}
