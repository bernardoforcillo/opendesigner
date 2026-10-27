import type { FontLite, NodeLite, SceneState } from "@/store/types";
import type { Bounds } from "@/canvas/geometry";
import type { MeasureText } from "@/renderer/text";
import { PdfColors } from "@/pdf/write/pdfColor";
import { PdfFonts } from "@/pdf/write/pdfFonts";
import { effectivePpi, type PreparedImage } from "@/pdf/write/pdfImages";
import { PdfFile, num, pdfDate, pdfName, pdfText } from "@/pdf/write/pdfFile";
import { PT, renderPage } from "@/pdf/write/pdfPage";

// THE DOCUMENT: pages with their boxes, print marks, the outline (bookmarks), link annotations, the
// Info dictionary and, for print, the PDF/X identification and an output intent.
//
// HONEST SCOPE of "PDF/X". The file carries what a printer's checker looks for first -- a PDF/X
// version in Info and XMP, TrimBox and BleedBox on every page, an OutputIntent naming the print
// condition, every font embedded or flagged, CMYK/spot paints kept as such -- but NO ICC profile is
// embedded (the editor does not apply one), so it is "PDF/X-ready", not validated PDF/X. A printer's
// preflight (or Acrobat) remains the judge; the in-app preflight lists what it can see.

export type PdfXMode = "none" | "x1a" | "x3" | "x4";

export interface PdfLink { rect: Bounds; url?: string; page?: number }
export interface PdfOutlineItem { title: string; level: number; page: number; top: number }

export interface PdfPageSpec {
  name: string;
  /** The world rectangle the page's content stream covers (trim + bleed + marks area). */
  media: Bounds;
  /** The finished page, and the bleed around it (0 = none). */
  trim: Bounds;
  bleed: number;
  nodes: readonly NodeLite[];
  links?: readonly PdfLink[];
}

export interface PdfBuild {
  pages: readonly PdfPageSpec[];
  images: Map<string, PreparedImage>;
  faces: readonly { face: FontLite; data: Uint8Array }[];
  scene: Pick<SceneState, "variables" | "collections">;
  measure: MeasureText;
  title: string;
  author?: string;
  subject?: string;
  created: Date;
  /** The document is in CMYK mode (or PDF/X-1a forces it). */
  cmyk?: boolean;
  pdfx?: PdfXMode;
  /** The ICC profile / print condition named in the output intent. */
  condition?: string;
  marks?: boolean;
  outline?: readonly PdfOutlineItem[];
  skip?: (n: NodeLite) => boolean;
  docId?: string;
  /** Tagged PDF (marked content, structure tree, document language); `headingOf` gives a text node's outline level. */
  tagged?: boolean;
  headingOf?: (n: NodeLite) => number;
  language?: string;
}

export interface PdfReport {
  pages: number;
  pdfx: PdfXMode;
  substitutedFonts: string[];
  missingGlyphs: string[];
  embeddedFonts: number;
  spots: string[];
  usesRgb: boolean;
  usesCmyk: boolean;
  transparency: boolean;
  flattened: string[];
  lowResolution: { page: string; hash: string; ppi: number }[];
}

const PDFX_NAME: Record<Exclude<PdfXMode, "none">, string> = { x1a: "PDF/X-1a:2003", x3: "PDF/X-3:2003", x4: "PDF/X-4" };

const MARK_OFFSET = 9, MARK_LENGTH = 28;

/** The extra world margin around the bleed box that print marks need. */
export const MARKS_MARGIN = MARK_OFFSET + MARK_LENGTH + 2;

/** The box `b` (world) as a PDF rectangle, relative to the media box of the page. */
function box(b: Bounds, media: Bounds): string {
  const x0 = (b.x - media.x) * PT, x1 = (b.x + b.width - media.x) * PT;
  const y0 = (media.y + media.height - (b.y + b.height)) * PT, y1 = (media.y + media.height - b.y) * PT;
  return `[${num(x0)} ${num(y0)} ${num(x1)} ${num(y1)}]`;
}

/** Crop marks at the trim corners, in registration colour (every plate), plus a slug line naming the file. */
function marksContent(spec: PdfPageSpec, label: string, font: { res: string; encode(t: string): string }): string {
  const { trim, bleed } = spec;
  const off = bleed + MARK_OFFSET, len = MARK_LENGTH;
  let out = `q\n/CSReg CS 1 SCN 0.35 w\n`;
  for (const [cx, sx] of [[trim.x, -1], [trim.x + trim.width, 1]] as const) {
    for (const [cy, sy] of [[trim.y, -1], [trim.y + trim.height, 1]] as const) {
      out += `${num(cx + sx * off)} ${num(cy)} m ${num(cx + sx * (off + len))} ${num(cy)} l S\n`;
      out += `${num(cx)} ${num(cy + sy * off)} m ${num(cx)} ${num(cy + sy * (off + len))} l S\n`;
    }
  }
  out += `0 0 0 1 k\nBT ${pdfName(font.res)} 6 Tf 1 0 0 -1 ${num(trim.x)} ${num(trim.y + trim.height + bleed + MARK_OFFSET + 8)} Tm ${font.encode(label)} Tj ET\nQ\n`;
  return out;
}

export async function buildPdf(b: PdfBuild): Promise<{ bytes: Uint8Array; report: PdfReport }> {
  const mode = b.pdfx ?? "none";
  const file = new PdfFile();
  const fonts = new PdfFonts(b.faces);
  const colors = new PdfColors(b.scene, b.cmyk === true || mode === "x1a");
  const imageObjs = new Map<string, number>();
  const root = file.alloc(), pagesNode = file.alloc(), info = file.alloc();
  const pageIds = b.pages.map(() => file.alloc());

  let transparency = false;
  const flattened: string[] = [];
  const lowResolution: PdfReport["lowResolution"] = [];
  const regFont = b.marks ? fonts.fontFor({ fontFamily: "Helvetica", fontSize: 6, fontWeight: "400", lineHeight: 1, align: "left" }) : null;
  let usesMarks = false;

  const rendered = b.pages.map((spec) => {
    const r = renderPage({ file, fonts, colors, measure: b.measure, images: b.images, imageObjs, ...(b.tagged ? { tagged: { headingOf: b.headingOf ?? (() => 0) } } : {}) }, spec.nodes, spec.media, b.skip);
    transparency ||= r.transparency;
    flattened.push(...r.flattened);
    for (const pl of r.placed) {
      const img = b.images.get(pl.assetHash);
      if (!img) continue;
      const ppi = effectivePpi(img, pl.width, pl.height);
      if (ppi < 150) lowResolution.push({ page: spec.name, hash: pl.assetHash, ppi: Math.round(ppi) });
    }
    let content = r.content;
    if (regFont) {
      usesMarks = true;
      // Still in the page's flipped, scaled space: renderPage's matrix is set once, outside its q/Q pairs.
      content += marksContent(spec, `${b.title} - ${spec.name}`, regFont);
    }
    return { spec, r, content };
  });

  const fontRes = fonts.emit(file);
  const csRes = colors.emit(file) + (usesMarks ? `/CSReg [/Separation/All/DeviceCMYK ${file.add("<</FunctionType 2/Domain[0 1]/C0[0 0 0 0]/C1[1 1 1 1]/N 1>>")} 0 R] ` : "");

  rendered.forEach(({ spec, r, content }, i) => {
    const contentId = file.stream("", content);
    const annots = (spec.links ?? []).map((l) => {
      const rect = box(l.rect, spec.media).slice(1, -1);
      const action = l.url !== undefined ? `/A<</S/URI/URI${pdfText(l.url)}>>` : `/Dest[${pageIds[l.page ?? 0]} 0 R/Fit]`;
      return `${file.add(`<</Type/Annot/Subtype/Link/Rect[${rect}]/Border[0 0 0]${action}>>`)} 0 R`;
    });
    const media = box(spec.media, spec.media);
    const xBoxes = spec.bleed > 0 || mode !== "none" || b.marks
      ? `/TrimBox${box(spec.trim, spec.media)}/BleedBox${box({ x: spec.trim.x - spec.bleed, y: spec.trim.y - spec.bleed, width: spec.trim.width + 2 * spec.bleed, height: spec.trim.height + 2 * spec.bleed }, spec.media)}/ArtBox${box(spec.trim, spec.media)}`
      : "";
    file.set(
      pageIds[i]!,
      `<</Type/Page/Parent ${pagesNode} 0 R/MediaBox${media}${xBoxes}/Contents ${contentId} 0 R` +
      `/Resources<<${r.resources.replace("/XObject", "/XObject")}${fontRes ? `/Font<<${fontRes}>>` : ""}${csRes ? `/ColorSpace<<${csRes}>>` : ""}>>` +
      `${transparency && mode !== "x1a" ? "/Group<</S/Transparency/CS/DeviceRGB>>" : ""}${annots.length ? `/Annots[${annots.join(" ")}]` : ""}${b.tagged ? `/Tabs/S/StructParents ${i}` : ""}>>`,
    );
  });
  file.set(pagesNode, `<</Type/Pages/Count ${pageIds.length}/Kids[${pageIds.map((id) => `${id} 0 R`).join(" ")}]>>`);

  // OUTLINE (bookmarks): a tree built from the items' levels.
  let outlines = "";
  if (b.outline && b.outline.length > 0) {
    const items = b.outline.map((o) => ({ ...o, id: file.alloc(), kids: [] as number[], parent: -1 }));
    const top = file.alloc();
    const stack: typeof items = [];
    const roots: number[] = [];
    items.forEach((it, idx) => {
      while (stack.length && stack[stack.length - 1]!.level >= it.level) stack.pop();
      const parent = stack[stack.length - 1];
      if (parent) { it.parent = items.indexOf(parent); parent.kids.push(idx); } else roots.push(idx);
      stack.push(it);
    });
    const siblings = (list: number[], parentId: number) => list.forEach((idx, k) => {
      const it = items[idx]!;
      const spec = b.pages[it.page];
      const y = spec ? (spec.media.y + spec.media.height - it.top) * PT : 0;
      file.set(
        it.id,
        `<</Title${pdfText(it.title)}/Parent ${parentId} 0 R${k > 0 ? `/Prev ${items[list[k - 1]!]!.id} 0 R` : ""}${k < list.length - 1 ? `/Next ${items[list[k + 1]!]!.id} 0 R` : ""}` +
        `${it.kids.length ? `/First ${items[it.kids[0]!]!.id} 0 R/Last ${items[it.kids[it.kids.length - 1]!]!.id} 0 R/Count ${it.kids.length}` : ""}` +
        `/Dest[${pageIds[it.page] ?? pageIds[0]} 0 R/XYZ 0 ${num(y)} null]>>`,
      );
      if (it.kids.length) siblings(it.kids, it.id);
    });
    siblings(roots, top);
    file.set(top, `<</Type/Outlines/First ${items[roots[0]!]!.id} 0 R/Last ${items[roots[roots.length - 1]!]!.id} 0 R/Count ${items.length}>>`);
    outlines = `/Outlines ${top} 0 R/PageMode/UseOutlines`;
  }

  // TAGGED PDF: Document > one element per marked item (headings, paragraphs, figures), read top to bottom, left to right on each page.
  let tagged = "";
  if (b.tagged) {
    const docElem = file.alloc(), treeRoot = file.alloc(), parentTree = file.alloc();
    const kids: number[] = [];
    const nums: string[] = [];
    rendered.forEach(({ r }, i) => {
      const byMcid: number[] = [];
      for (const t of r.tags) {
        const id = file.add(`<</Type/StructElem/S/${t.role}/P ${docElem} 0 R/Pg ${pageIds[i]} 0 R/K ${t.mcid}${t.alt !== undefined ? `/Alt${pdfText(t.alt)}` : ""}>>`);
        byMcid[t.mcid] = id;
      }
      nums.push(`${i}[${byMcid.map((id) => `${id} 0 R`).join(" ")}]`);
      const order = [...r.tags].sort((a, c) => a.y - c.y || a.x - c.x);
      for (const t of order) kids.push(byMcid[t.mcid]!);
    });
    file.set(docElem, `<</Type/StructElem/S/Document/P ${treeRoot} 0 R/K[${kids.map((k) => `${k} 0 R`).join(" ")}]>>`);
    file.set(parentTree, `<</Nums[${nums.join(" ")}]>>`);
    file.set(treeRoot, `<</Type/StructTreeRoot/K ${docElem} 0 R/ParentTree ${parentTree} 0 R/ParentTreeNextKey ${rendered.length}>>`);
    tagged = `/MarkInfo<</Marked true>>/StructTreeRoot ${treeRoot} 0 R/Lang${pdfText(b.language || "en")}/ViewerPreferences<</DisplayDocTitle true>>`;
  }

  const intent = mode === "none" ? "" :
    `/OutputIntents[<</Type/OutputIntent/S/GTS_PDFX/OutputConditionIdentifier${pdfText(b.condition || "Custom")}/Info${pdfText(b.condition || "Custom")}/RegistryName(http://www.color.org)>>]`;
  const xmp = mode === "none" ? "" : `/Metadata ${file.stream(
    "/Type/Metadata/Subtype/XML",
    `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:pdfxid="http://www.npes.org/pdfx/ns/id/" xmlns:pdfx="http://ns.adobe.com/pdfx/1.3/" xmlns:dc="http://purl.org/dc/elements/1.1/"><pdfxid:GTS_PDFXVersion>${PDFX_NAME[mode]}</pdfxid:GTS_PDFXVersion><pdfx:GTS_PDFXVersion>${PDFX_NAME[mode]}</pdfx:GTS_PDFXVersion><dc:title>${escapeXml(b.title)}</dc:title></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`,
    false,
  )} 0 R`;
  file.set(root, `<</Type/Catalog/Pages ${pagesNode} 0 R${outlines}${tagged}${intent}${xmp}>>`);
  file.set(
    info,
    `<</Title${pdfText(b.title)}${b.author ? `/Author${pdfText(b.author)}` : ""}${b.subject ? `/Subject${pdfText(b.subject.slice(0, 2000))}` : ""}/Producer(OpenDesigner)/Creator(OpenDesigner)/CreationDate(${pdfDate(b.created)})/ModDate(${pdfDate(b.created)})` +
    `${mode === "none" ? "" : `/GTS_PDFXVersion(${PDFX_NAME[mode]})/Trapped/False`}>>`,
  );

  const header = mode === "x4" ? "%PDF-1.6\n" : mode === "none" ? "%PDF-1.7\n" : "%PDF-1.4\n";
  const bytes = await file.build(root, { info, fileId: b.docId ?? b.title, header });
  return {
    bytes,
    report: {
      pages: b.pages.length, pdfx: mode,
      substitutedFonts: [...fonts.substituted], missingGlyphs: [...fonts.missingGlyphs],
      embeddedFonts: b.faces.length, spots: [...colors.spots],
      usesRgb: colors.usesRgb, usesCmyk: colors.usesCmyk, transparency, flattened: [...new Set(flattened)], lowResolution,
    },
  };
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
