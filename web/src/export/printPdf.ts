import { flattenStyle } from "@/store/richText";
import type { FontLite, NodeLite, PageLite, SceneState } from "@/store/types";
import type { Bounds } from "@/canvas/geometry";
import { headingsOf } from "@/store/textTokens";
import { isRightPage, pageNumbers } from "@/store/pageNumbers";
import { buildPdf, MARKS_MARGIN, type PdfLink, type PdfOutlineItem, type PdfPageSpec, type PdfReport, type PdfXMode } from "@/pdf/write/pdfDocument";
import { dataUrlBytes, prepareImage, type PreparedImage, type Rasterize } from "@/pdf/write/pdfImages";
import type { MeasureText } from "@/renderer/text";
import { contributorNames } from "@/export/onix";
import type { ExportRegion } from "@/export/region";

// THE PDF OF A DOCUMENT, from the resolved scene. This module decides WHAT goes on each PDF page (the
// sheet, its bleed, the marks and slug around it, a spread as one wide page) and gathers what the
// writer needs that lives outside the scene (image bytes, font bytes); pdf/write/* turns it into bytes.

export interface PrintPdfOptions {
  /** PDF/X identification ("none" = an ordinary PDF). */
  pdfx?: PdfXMode;
  /** Each sheet with its bleed area (a page's `bleed`). */
  bleed?: boolean;
  /** Crop marks and a page-info line outside the bleed. */
  marks?: boolean;
  /** The page's slug area (its `slug`), shown as extra paper around the sheet. */
  slug?: boolean;
  /** Facing pages as one wide page per spread. */
  spreads?: boolean;
  /** Bookmarks from headings and link annotations (default on). */
  interactive?: boolean;
  /** Booklet imposition: two pages per sheet side in saddle-stitch order (padded with blanks to a multiple of 4); overrides `spreads`. */
  booklet?: boolean;
  /** Tagged PDF: marked content and a structure tree (headings, paragraphs, figures with alt text). */
  tagged?: boolean;
}

export interface PrintPdfDeps {
  measure: MeasureText;
  loadAssetDataUrl: (docId: string, hash: string) => Promise<string | null>;
  rasterize?: Rasterize;
  now?: () => Date;
}

export interface PrintPdfResult { bytes: Uint8Array; report: PdfReport; missingImages: number; missingFonts: number }

/** Decodes any browser-supported image to RGBA through a canvas; null where the browser cannot. */
export const canvasRasterize: Rasterize = async (bytes, mime) => {
  try {
    const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
    const c = document.createElement("canvas");
    c.width = bmp.width; c.height = bmp.height;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0);
    return { width: bmp.width, height: bmp.height, rgba: ctx.getImageData(0, 0, bmp.width, bmp.height).data };
  } catch {
    return null;
  }
};

/** Image hashes a set of nodes draws: image nodes and image fills. */
export function imageHashes(nodes: readonly NodeLite[]): string[] {
  const out = new Set<string>();
  for (const n of nodes) {
    if (n.kind === "image" && n.image?.assetHash) out.add(n.image.assetHash);
    const f = n.fills[0];
    if (f?.image?.assetHash) out.add(f.image.assetHash);
  }
  return [...out];
}

async function loadImages(nodes: readonly NodeLite[], docId: string, deps: PrintPdfDeps) {
  const images = new Map<string, PreparedImage>();
  await Promise.all(imageHashes(nodes).map(async (hash) => {
    try {
      const uri = await deps.loadAssetDataUrl(docId, hash);
      const data = uri === null ? null : dataUrlBytes(uri);
      const img = data ? await prepareImage(data.bytes, data.mime, deps.rasterize) : null;
      if (img) images.set(hash, img);
    } catch { /* a missing image is a placeholder, not a failed export */ }
  }));
  const wanted = nodes.filter((n) => n.kind === "image" || n.fills[0]?.image);
  const missing = wanted.filter((n) => !images.has(n.kind === "image" ? n.image?.assetHash ?? "" : n.fills[0]!.image!.assetHash)).length;
  return { images, missing };
}

async function loadFaces(fonts: Record<string, FontLite>, docId: string, deps: PrintPdfDeps) {
  const faces: { face: FontLite; data: Uint8Array }[] = [];
  let missing = 0;
  await Promise.all(Object.values(fonts).map(async (face) => {
    try {
      const uri = await deps.loadAssetDataUrl(docId, face.assetHash);
      const data = uri === null ? null : dataUrlBytes(uri);
      if (data) faces.push({ face, data: data.bytes }); else missing++;
    } catch { missing++; }
  }));
  // Stable order, whatever order the downloads finished in.
  faces.sort((a, b) => (a.face.id < b.face.id ? -1 : 1));
  return { faces, missing };
}

const shift = (n: NodeLite, dx: number): NodeLite => (dx === 0 ? n : { ...n, x: n.x + dx });

export interface PageGroup { pages: PageLite[]; width: number; height: number }

/** The output pages: one per page, or a facing-pages spread (left + right) as one wide page. */
export function groupPages(scene: SceneState, spreads: boolean): PageLite[][] {
  const pages = scene.pages.filter((p) => !p.isMaster);
  if (!spreads || scene.settings?.facingPages !== true) return pages.map((p) => [p]);
  const numbers = pageNumbers(scene.pages);
  const out: PageLite[][] = [];
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i]!, next = pages[i + 1];
    if (!isRightPage(numbers.get(p.id)) && next && isRightPage(numbers.get(next.id)) && !next.sectionStart) { out.push([p, next]); i++; }
    else out.push([p]);
  }
  return out;
}

/** The id prefix of a blank page added by booklet imposition. */
export const BLANK_PAGE = "blank:";

/**
 * Saddle-stitch imposition: the pages (padded with blanks to a multiple of 4) paired as they sit on the sheet, left then right:
 * N-1|1, 2|N-2, N-3|3, 4|N-4, ... Folded and nested, the sheets read in order.
 */
export function bookletGroups(scene: SceneState): PageLite[][] {
  const pages = scene.pages.filter((p) => !p.isMaster);
  if (pages.length === 0) return [];
  const ref = pages[0]!;
  const n = Math.ceil(pages.length / 4) * 4;
  const at = (i: number): PageLite => pages[i] ?? { id: `${BLANK_PAGE}${i}`, name: "Blank", width: ref.width, height: ref.height, bleed: ref.bleed, slug: ref.slug };
  const out: PageLite[][] = [];
  for (let s = 0; s < n / 4; s++) {
    out.push([at(n - 1 - 2 * s), at(2 * s)]);
    out.push([at(2 * s + 1), at(n - 2 - 2 * s)]);
  }
  return out;
}

/**
 * The whole document as a PDF, or null when every page is empty. `regionOf(pageId, sheet)` returns the page's
 * region for a given sheet rectangle (null sheet = the bounds of what is drawn), as export/region.ts builds it.
 */
export async function buildDocumentPdf(
  scene: SceneState,
  regionOf: (pageId: string, sheet: Bounds | null) => ExportRegion | null,
  opts: PrintPdfOptions,
  deps: PrintPdfDeps,
): Promise<PrintPdfResult | null> {
  const specs: PdfPageSpec[] = [];
  const pageIndex = new Map<string, number>(); // page id -> output page
  const offsetOf = new Map<string, number>(); // page id -> x shift inside its spread
  const noPrint = new Set(scene.layers.filter((l) => l.noPrint).map((l) => l.id));
  const regions: ExportRegion[] = [];

  for (const group of opts.booklet ? bookletGroups(scene) : groupPages(scene, opts.spreads === true)) {
    const w = group.reduce((s, p) => s + (p.width ?? 0), 0);
    const h = Math.max(...group.map((p) => p.height ?? 0));
    const sized = group.every((p) => (p.width ?? 0) > 0 && (p.height ?? 0) > 0);
    const bleed = opts.bleed ? Math.max(...group.map((p) => p.bleed ?? 0)) : 0;
    const slug = opts.slug ? Math.max(...group.map((p) => p.slug ?? 0)) : 0;
    const margin = bleed + Math.max(slug, opts.marks ? MARKS_MARGIN : 0);

    let x = 0;
    const nodes: NodeLite[] = [];
    let trim: Bounds | null = sized ? { x: 0, y: 0, width: w, height: h } : null;
    for (const p of group) {
      if (p.id.startsWith(BLANK_PAGE)) { x += p.width ?? 0; continue; }
      // An unbounded page is exported as what is drawn on it (its bounds become the trim).
      const probe = sized ? null : regionOf(p.id, null);
      if (!sized && !probe) continue;
      const region = regionOf(p.id, sized ? { x: -margin, y: -margin, width: (p.width ?? 0) + 2 * margin, height: (p.height ?? 0) + 2 * margin } : probe!.bounds);
      if (!region) continue;
      if (!sized) trim = probe!.bounds;
      regions.push(region);
      nodes.push(...region.nodes.map((n) => shift(n, x)));
      offsetOf.set(p.id, x);
      pageIndex.set(p.id, specs.length);
      x += p.width ?? 0;
    }
    if (!trim || nodes.length === 0 && !sized) continue;
    if (opts.booklet && nodes.length === 0 && group.every((p) => p.id.startsWith(BLANK_PAGE))) continue;
    specs.push({
      name: group.map((p) => p.name).join(" + "),
      trim, bleed,
      media: { x: trim.x - margin, y: trim.y - margin, width: trim.width + 2 * margin, height: trim.height + 2 * margin },
      nodes,
    });
  }
  if (specs.length === 0) return null;

  const allNodes = specs.flatMap((s) => s.nodes);
  const [{ images, missing }, { faces, missing: missingFonts }] = await Promise.all([loadImages(allNodes, scene.id, deps), loadFaces(scene.fonts, scene.id, deps)]);

  if (opts.interactive !== false) addInteractivity(scene, specs, pageIndex, offsetOf);
  const outline: PdfOutlineItem[] = opts.interactive === false ? [] : headingsOf(scene).flatMap((h) => {
    const page = pageIndex.get(h.pageId);
    const n = scene.nodes.get(h.nodeId);
    return page === undefined || !n ? [] : [{ title: h.text, level: h.level, page, top: n.y }];
  });

  const { bytes, report } = await buildPdf({
    pages: specs, images, faces, scene, measure: deps.measure,
    title: scene.settings?.book?.title || scene.name || "opendesigner", created: (deps.now?.() ?? new Date()),
    author: contributorNames(scene.settings?.book).join(", ") || undefined, subject: scene.settings?.book?.description,
    cmyk: scene.settings?.colorMode === "cmyk", pdfx: opts.pdfx ?? "none", condition: scene.settings?.iccProfile,
    marks: opts.marks === true, outline, docId: scene.id, tagged: opts.tagged === true, language: scene.settings?.book?.language || undefined, headingOf: (n) => headingLevelOf(scene, n),
    skip: (n) => !!n.layerId && noPrint.has(n.layerId),
  });
  return { bytes, report, missingImages: missing, missingFonts };
}

/** The outline level (1..9) of a text node's first paragraph style, 0 for body text. */
function headingLevelOf(scene: SceneState, n: NodeLite): number {
  const id = n.text?.paragraphStyles?.[0];
  return id ? flattenStyle(scene.textStyles, id)?.outlineLevel ?? 0 : 0;
}

/** Link annotations: URLs from a node's `link.url`, and prototype transitions from an element to another page. */
function addInteractivity(scene: SceneState, specs: PdfPageSpec[], pageIndex: Map<string, number>, offsetOf: Map<string, number>): void {
  const pageOf = (id: string): string | null => {
    for (let cur = scene.nodes.get(id), guard = 0; cur && guard < 64; cur = scene.nodes.get(cur.parentId), guard++) {
      if (scene.pages.some((p) => p.id === cur!.parentId)) return cur.parentId;
    }
    return null;
  };
  const rect = (n: NodeLite, dx: number): Bounds => ({ x: n.x + dx, y: n.y, width: n.width, height: n.height });
  const add = (page: number, link: PdfLink) => { const s = specs[page]; if (s) s.links = [...(s.links ?? []), link]; };
  for (const n of scene.nodes.values()) {
    const url = n.meta?.["link.url"];
    const pid = url ? pageOf(n.id) : null;
    if (url && pid && pageIndex.has(pid)) add(pageIndex.get(pid)!, { rect: rect(n, offsetOf.get(pid) ?? 0), url });
  }
  for (const t of Object.values(scene.transitions)) {
    const el = t.elementId ? scene.nodes.get(t.elementId) : undefined;
    const from = el ? pageOf(el.id) : null;
    const to = pageOf(t.toId) ?? (scene.pages.some((p) => p.id === t.toId) ? t.toId : null);
    if (el && from && to && pageIndex.has(from) && pageIndex.has(to)) add(pageIndex.get(from)!, { rect: rect(el, offsetOf.get(from) ?? 0), page: pageIndex.get(to)! });
  }
}

/** A single region (a selection, or the page on screen) as a one-page PDF. */
export async function buildRegionPdf(scene: SceneState, region: ExportRegion, deps: PrintPdfDeps): Promise<PrintPdfResult> {
  const noPrint = new Set(scene.layers.filter((l) => l.noPrint).map((l) => l.id));
  const [{ images, missing }, { faces, missing: missingFonts }] = await Promise.all([loadImages(region.nodes, scene.id, deps), loadFaces(scene.fonts, scene.id, deps)]);
  const { bytes, report } = await buildPdf({
    pages: [{ name: scene.name, media: region.bounds, trim: region.bounds, bleed: 0, nodes: region.nodes }],
    images, faces, scene, measure: deps.measure, title: scene.settings?.book?.title || scene.name || "opendesigner", created: deps.now?.() ?? new Date(),
    author: contributorNames(scene.settings?.book).join(", ") || undefined, subject: scene.settings?.book?.description,
    cmyk: scene.settings?.colorMode === "cmyk", docId: scene.id, skip: (n) => !!n.layerId && noPrint.has(n.layerId),
  });
  return { bytes, report, missingImages: missing, missingFonts };
}
