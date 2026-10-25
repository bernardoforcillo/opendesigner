import { resolveScene } from "../store/variables";
import { useScene } from "../store/store";
import { fontString } from "../renderer/text";
import { assetUrl } from "../rpc/assets";
import type { ImageSource } from "../renderer/canvasRenderer";
import type { NodeLite, PageLite, SceneState } from "../store/types";
import { NodeMap } from "../store/nodeMap";
import { isReachableFrom } from "../store/tree";
import { exportRegion, type ExportRegion, type ExportScope } from "./region";
import { buildEpub, type EpubPage } from "./epub";
import { buildReflowEpub, type ReflowImage } from "./epubReflow";
import { dataUrlBytes } from "../pdf/write/pdfImages";
import { nodesToSvg, type MeasureText, type ResolveImageHref } from "./svg";
import { canvasToPngBlob, renderRegionToCanvas, type ExportScale } from "./png";
import { hasErrors, preflightReport, preflightScene, type PreflightIssue } from "./preflight";
import { buildPackage } from "./packageForPrint";
import { buildDocumentPdf, buildRegionPdf, canvasRasterize, type PrintPdfOptions } from "./printPdf";
import type { Rasterize } from "../pdf/write/pdfImages";

// EXPORT — the command.
//
// Why CLIENT SIDE. The original design had `ExportImage` as a
// server-stream RPC with progress. For a LOCAL editor it is the wrong shape: the
// browser already has the scene and already has the renderer that draws it: sending the
// document to Go, redrawing it there with a second renderer and bringing back
// the bytes would add a network round trip and -- above all -- a SECOND
// implementation of the drawing, destined to diverge from the one the user
// sees on screen. Export would be the only function of the app that does not show
// what the canvas shows. Progress, then, makes sense on a rendering that takes
// minutes, not on a canvas that draws in a frame.
//
// So: no `ExportImage` in the proto, no route on the server, no
// half-way path. The PNG goes through an offscreen canvas (export/png.ts) and
// the SVG through a pure generator (export/svg.ts).

// "pdf" is a real PDF written by pdf/write: vector, fonts embedded, images as the original bytes,
// CMYK/spot paints kept, the document's pages and boxes. It draws from the same nodes as the SVG.
export type ExportFormat = "png" | "svg" | "pdf";

export interface ExportRequest {
  format: ExportFormat;
  scope: ExportScope;
  /** The page to export (default: the one on screen) -- how an agent exports a page without moving the editor. */
  pageId?: string;
  /** For a selection export: these nodes instead of the editor's selection. */
  nodeIds?: readonly string[];
  // Used only by the PNG: the SVG is vector, a "scale" means nothing.
  scale: ExportScale;
}

// The OUTER dependencies (canvas, encoding, saving, text measuring),
// injectable because none of the four exists in Node: it is what makes the path
// verifiable without a browser.
export interface ExportDeps {
  createCanvas?: () => HTMLCanvasElement;
  toPngBlob?: (canvas: HTMLCanvasElement) => Promise<Blob>;
  download?: (blob: Blob, filename: string) => void;
  // PDF only: how to rasterize an image the writer cannot place as it is (alpha PNG, WebP...).
  rasterize?: Rasterize;
  measure?: MeasureText;
  // The bytes of an asset as a data URI. Injectable like the others: it needs `fetch`
  // and `FileReader`, which are not there in a test. BOTH formats use it --
  // the SVG to embed them, the PNG to decode and draw them.
  loadAssetDataUrl?: (docId: string, hash: string) => Promise<string | null>;
  // How to go from those bytes to something `drawImage` can draw, for the
  // PNG. Injectable because it needs `new Image()` and a real decode.
  decodeImage?: (dataUrl: string) => Promise<HTMLImageElement | null>;
}

const NOTHING_SELECTED =
  "nothing to export: select something, or export the whole page";
const EMPTY_PAGE = "nothing to export: the page is empty";

// The characters Windows does not accept in a file name (other systems
// forbid fewer, so this set is fine everywhere), plus control
// characters. The document name is written by the user and may contain them.
const ILLEGAL_IN_FILENAME = /[\\/:*?"<>|\x00-\x1f]/g;

// Spaces, hyphens and dots at the START or END: a name ending with a dot
// is invalid on Windows, one starting with a dot is a hidden file on
// Unix, and hyphens at the ends are almost always the leftover of the characters
// just removed (a document named "///" would give "---").
const TRIM_FROM_FILENAME = /^[-\s.]+|[-\s.]+$/g;

const FALLBACK_NAME = "opendesigner";

/**
 * The file name proposed for the download: document name, the scope if it is
 * a selection, the scale if it is not 1x, and the extension.
 *
 * The scale suffix is the one design editors use (`@2x`), and it serves
 * one concrete thing: exporting the same document at two scales must not
 * produce two files with the same name.
 */
export function exportFileName(docName: string, req: ExportRequest): string {
  const base =
    docName.replace(ILLEGAL_IN_FILENAME, "-").replace(TRIM_FROM_FILENAME, "") || FALLBACK_NAME;
  const scope = req.scope === "selection" ? "-selection" : "";
  const scale = req.format === "png" && req.scale !== 1 ? `@${req.scale}x` : "";
  return `${base}${scope}${scale}.${req.format}`;
}

/** The sheet of a sized page as a rectangle at the origin, or null for an unbounded page. */
export function sheetOf(page: PageLite | undefined, bleed = false): { x: number; y: number; width: number; height: number } | null {
  const w = page?.width ?? 0, h = page?.height ?? 0;
  if (!(w > 0) || !(h > 0)) return null;
  const b = bleed ? page?.bleed ?? 0 : 0;
  return { x: -b, y: -b, width: w + 2 * b, height: h + 2 * b };
}

/** `scene` reduced to the nodes that hang from page `pageId` (master copies included). */
function onPage(scene: SceneState, pageId: string): SceneState {
  const own = [...scene.nodes.values()].filter((n) => isReachableFrom(scene, n.id, pageId));
  return { ...scene, nodes: NodeMap.from(own.map((n) => [n.id, n] as const)) };
}

/**
 * Hands the blob to the user as a download.
 *
 * The anchor really enters the document before the click: in some browsers a detached
 * element does not trigger the download. The URL is revoked in a timer and not
 * right after the click, because the download starts asynchronously and revoking
 * the URL in the same event turn would cancel it.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * The text measure for the SVG, taken from a real canvas.
 *
 * It is the SAME measure the canvas uses to wrap (`ctx.measureText` with
 * `ctx.font` set by `fontString`), so the exported SVG breaks lines
 * exactly where the screen breaks them. Approximating it here -- so many pixels per
 * character -- would give a file that resembles the document without being it.
 */
export function canvasMeasure(createCanvas: () => HTMLCanvasElement): MeasureText {
  const ctx = createCanvas().getContext("2d");
  if (!ctx) throw new Error("the export canvas's 2D context is not available");
  return (text, style) => {
    ctx.font = fontString(style);
    return ctx.measureText(text).width;
  };
}

function defaultCanvas(): HTMLCanvasElement {
  return document.createElement("canvas");
}

// `charset=utf-8` is not decorative: without it, an SVG file with accented
// text opened by a browser is interpreted as latin-1.
const SVG_MIME = "image/svg+xml;charset=utf-8";

/**
 * The bytes of an asset as a `data:` URI, taken from the route that serves them.
 *
 * It goes through the ORIGINAL BYTES and not through a canvas re-encoding: a JPEG
 * rewritten as PNG would change size and (for a lossy image) quality,
 * inside a file the user exports precisely to hand it to someone else.
 * The decoded image in the renderer's cache is of no use here: what
 * is needed is the bytes, and the response almost always comes from the browser's
 * HTTP cache (the route is `immutable`).
 */
export async function fetchAssetDataUrl(docId: string, hash: string): Promise<string | null> {
  const res = await fetch(assetUrl(docId, hash));
  if (!res.ok) return null;
  const blob = await res.blob();
  return await new Promise<string | null>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    // An unreadable asset does not make the export fail: it becomes a placeholder, as
    // on the canvas.
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

/**
 * A data URI into a drawable element. It NEVER throws: an asset that does not
 * decode is a missing image, not a failed export.
 *
 * Null dimensions count as failure for the same reason as the renderer's
 * cache: some browsers emit `load` on unreadable bytes, and drawing
 * that element produces no pixels -- better the placeholder than nothing.
 */
export function decodeDataUrl(dataUrl: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth > 0 && img.naturalHeight > 0 ? img : null);
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

// The region's assets, RESOLVED and AWAITED: the hrefs for the SVG, the decoded
// images for the PNG, and how many image nodes will remain a placeholder.
interface ResolvedAssets {
  href: ResolveImageHref;
  images: ImageSource;
  missing: number;
}

// No image for that hash. It NEVER returns "loading": the export has already
// waited, so every node is either drawn or placeholder -- not "arriving".
const NO_IMAGE = { status: "missing", image: null } as const;

/**
 * Resolves the image nodes' assets in advance, for both formats.
 *
 * BEFORE and not during, for two different and equally binding reasons.
 * `nodesToSvg` is a PURE, synchronous function and must stay so -- it is what
 * makes the markup's correctness verifiable on paper. And `drawScene` is
 * SYNCHRONOUS by construction (it runs in a render loop): if the images are not
 * already ready when it starts drawing, it draws the placeholder and there is no
 * second round. Taking the pixels from the renderer's cache -- which fills itself
 * when it can -- would mean the same document exported twice
 * gives two different files depending on what this session has already seen
 * go by: exporting right after opening would give the placeholder's crosses, exporting
 * a second later the photographs. Here the bytes are asked for and AWAITED, always,
 * and the images' source is LOCAL to this export.
 *
 * Hashes are deduplicated: the same image used by ten nodes is downloaded
 * (and decoded) only once. Decoding is done only by the PNG: for the SVG the
 * bytes are enough as they are, and it is also the reason the SVG embeds the
 * ORIGINAL file instead of a re-encoding.
 */
async function resolveAssets(
  nodes: readonly NodeLite[],
  docId: string,
  format: ExportFormat,
  deps: ExportDeps,
): Promise<ResolvedAssets> {
  const load = deps.loadAssetDataUrl ?? fetchAssetDataUrl;
  const decode = deps.decodeImage ?? decodeDataUrl;
  const imageNodes = nodes.filter((n) => n.kind === "image");
  const hashes = [...new Set(imageNodes.map((n) => n.image?.assetHash ?? "").filter((h) => h !== ""))];

  const uris = new Map<string, string>();
  const decoded = new Map<string, HTMLImageElement>();
  await Promise.all(
    hashes.map(async (hash) => {
      try {
        const uri = await load(docId, hash);
        if (uri === null) return;
        uris.set(hash, uri);
        if (format !== "png") return;
        const img = await decode(uri);
        if (img) decoded.set(hash, img);
      } catch {
        // An asset that does not download is a MISSING image, not a failed
        // export: the document really contains a broken reference, and the
        // file shows it instead of not existing.
      }
    }),
  );

  // NODES are counted and not hashes: it is what the user sees missing from the
  // file, and it is also the only way to count nodes whose hash is empty -- which
  // have nothing to ask for and still remain a placeholder.
  const ok = format === "png" ? decoded : uris;
  const missing = imageNodes.filter((n) => !ok.has(n.image?.assetHash ?? "")).length;

  return {
    href: (hash) => uris.get(hash) ?? null,
    images: {
      get: (_docId, hash) => {
        const img = decoded.get(hash);
        return img ? { status: "ready", image: img } : NO_IMAGE;
      },
    },
    missing,
  };
}

/** What is said when the file comes out with holes. */
function missingImagesNotice(count: number): string {
  return count === 1
    ? "one image was not included: its file is not reachable, and a placeholder takes its place"
    : `${count} images were not included: their files are not reachable, and placeholders take their place`;
}

// The file's bytes. The two roads are truly different -- the PNG goes through a
// canvas and an asynchronous encoding, the SVG through a pure function -- and keeping them
// in two readable branches instead of a nested ternary is all the advantage
// of this function.
async function exportBlob(
  region: ExportRegion,
  req: ExportRequest,
  deps: ExportDeps,
  createCanvas: () => HTMLCanvasElement,
  measure: MeasureText,
  assets: ResolvedAssets,
): Promise<Blob> {
  if (req.format === "png") {
    // Images come from here and NOT from the renderer's cache: they are already
    // decoded and already awaited, so the drawing is deterministic.
    const canvas = renderRegionToCanvas(region, req.scale, createCanvas, assets.images);
    return (deps.toPngBlob ?? canvasToPngBlob)(canvas);
  }
  return new Blob([nodesToSvg(region.nodes, region.bounds, measure, assets.href)], { type: SVG_MIME });
}

// The SVG markup of a region (the PDF's source).
function svgMarkup(region: ExportRegion, measure: MeasureText, assets: ResolvedAssets): string {
  return nodesToSvg(region.nodes, region.bounds, measure, assets.href);
}

/**
 * Runs an export. Returns `false` (without downloading anything) when there is
 * nothing to export or when something goes wrong: in both cases the reason
 * ends up in `notice`, the store's informational channel.
 *
 * It goes through `notice` and not `lastError`: no change was undone --
 * export does not touch the document, and in fact it opens no gesture and
 * produces no op. It is the only function of the app that only reads the scene.
 */
export async function runExport(req: ExportRequest, deps: ExportDeps = {}): Promise<boolean> {
  const state = useScene.getState();
  const { scene: raw } = state;
  const selection = req.nodeIds ?? state.selection;
  const currentPageId = req.pageId ?? state.currentPageId;
  if (!raw) return false;
  // What is exported is what is drawn: variables resolved for each node's active mode, the
  // master page's content in place, and only the page on screen.
  const resolved = resolveScene(raw);
  const scene = onPage(resolved, currentPageId ?? resolved.pages[0]?.id ?? "");

  const createCanvas = deps.createCanvas ?? defaultCanvas;
  try {
    // The text measure is built BEFORE the region, and for BOTH
    // formats: it serves not only to wrap the SVG, it serves to know how tall
    // the text is -- that is to size the region, therefore the PNG's
    // canvas too (see export/region.ts). It sits inside the try because building it
    // needs a 2D context, which may not exist: one more reason an
    // export can fail, and it goes through the channel of all the others.
    const measure = deps.measure ?? canvasMeasure(createCanvas);

    // A sized page exports as its sheet (see PageSetupDialog); an unbounded one as what is drawn on it.
    const page = resolved.pages.find((p) => p.id === (currentPageId ?? resolved.pages[0]?.id));
    const region = exportRegion(scene, selection, req.scope, measure, sheetOf(page));
    if (!region) {
      useScene.setState({ notice: req.scope === "selection" ? NOTHING_SELECTED : EMPTY_PAGE });
      return false;
    }

    if (req.format === "pdf") {
      const pdf = await buildRegionPdf(scene, region, printDeps(deps, measure));
      (deps.download ?? downloadBlob)(new Blob([pdf.bytes as BlobPart], { type: PDF_MIME }), exportFileName(scene.name, req));
      const holes = pdf.missingImages;
      if (holes > 0) useScene.setState({ notice: missingImagesNotice(holes) });
      return true;
    }
    const assets = await resolveAssets(region.nodes, scene.id, req.format, deps);
    const blob = await exportBlob(region, req, deps, createCanvas, measure, assets);
    (deps.download ?? downloadBlob)(blob, exportFileName(scene.name, req));
    // The file is there and is the requested one, but it contains placeholders in place of
    // photographs: an export that succeeds HALFWAY and does not say so is the
    // worst way to fail, because the user finds out from someone else.
    if (assets.missing > 0) useScene.setState({ notice: missingImagesNotice(assets.missing) });
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    useScene.setState({ notice: `export failed: ${reason}` });
    return false;
  }
}

// ---------------------------------------------------------------------------
// THE WHOLE DOCUMENT: every page, as one PDF (print dialog) or one EPUB (file).

export type DocumentExportFormat = "pdf" | "epub" | "epub-reflow";

export interface DocumentExportDeps extends ExportDeps {
  now?: () => Date;
}

const EPUB_MIME = "application/epub+zip";
const PDF_MIME = "application/pdf";

function printDeps(deps: ExportDeps, measure: MeasureText) {
  return { measure, loadAssetDataUrl: deps.loadAssetDataUrl ?? fetchAssetDataUrl, rasterize: deps.rasterize ?? canvasRasterize };
}

/** The download name of a whole-document export (`<name>.epub`). */
export function documentFileName(docName: string, format: DocumentExportFormat): string {
  return exportFileName(docName, { format: "svg", scope: "page", scale: 1 }).replace(/\.svg$/, `.${format === "epub-reflow" ? "epub" : format}`);
}

/**
 * Exports EVERY page of the open document. Empty pages are skipped (and not counted as an
 * error); if all are empty there is nothing to export. Same channels as `runExport`:
 * `false` plus a `notice` when nothing was produced.
 *
 * `opts` shapes a PDF for print (see export/printPdf.ts): bleed, marks, slug, spreads, a PDF/X mode.
 * The EPUB ignores them -- it is a screen format.
 */
export async function runDocumentExport(
  format: DocumentExportFormat,
  deps: DocumentExportDeps = {},
  opts: PrintPdfOptions = {},
): Promise<boolean> {
  const { scene: raw } = useScene.getState();
  if (!raw) return false;
  const scene = resolveScene(raw);
  try {
    const measure = deps.measure ?? canvasMeasure(deps.createCanvas ?? defaultCanvas);

    if (format === "pdf") {
      const pdf = await buildDocumentPdf(
        scene,
        (pageId, sheet) => exportRegion(onPage(scene, pageId), [], "page", measure, sheet ?? sheetOf(scene.pages.find((p) => p.id === pageId))),
        opts,
        { ...printDeps(deps, measure), now: deps.now },
      );
      if (!pdf) {
        useScene.setState({ notice: "nothing to export: every page is empty" });
        return false;
      }
      (deps.download ?? downloadBlob)(new Blob([pdf.bytes as BlobPart], { type: PDF_MIME }), documentFileName(scene.name, "pdf"));
      // What the writer saw while writing -- resolution, glyphs, effects it could not reproduce -- as one line.
      const found = preflightReport(pdf.report, opts, pdf.missingImages, pdf.missingFonts);
      if (found.length > 0) {
        const worst = hasErrors(found) ? "with problems" : "with warnings";
        useScene.setState({ notice: `PDF written ${worst}: ${found.slice(0, 3).map((i) => i.message).join(" ")}${found.length > 3 ? ` (+${found.length - 3} more)` : ""}` });
      }
      return true;
    }

    if (format === "epub-reflow") {
      // Stories flow as text: the RAW scene is read (footnote markers are still in the content), images by hash.
      const load = deps.loadAssetDataUrl ?? fetchAssetDataUrl;
      const images = new Map<string, ReflowImage>();
      await Promise.all([...new Set([...raw.nodes.values()].filter((n) => n.kind === "image" && n.image?.assetHash).map((n) => n.image!.assetHash))].map(async (hash) => {
        try {
          const uri = await load(raw.id, hash);
          const d = uri === null ? null : dataUrlBytes(uri);
          if (d) images.set(hash, { bytes: d.bytes, mime: d.mime });
        } catch { /* an unreachable image is left out of the book */ }
      }));
      const data = buildReflowEpub(raw, { title: scene.name || FALLBACK_NAME, identifier: `urn:opendesigner:${scene.id}`, modified: (deps.now?.() ?? new Date()).toISOString(), book: scene.settings?.book }, images);
      (deps.download ?? downloadBlob)(new Blob([data as BlobPart], { type: EPUB_MIME }), documentFileName(scene.name, "epub").replace(/\.epub$/, "-reflow.epub"));
      return true;
    }

    const pages: (EpubPage & { region: ExportRegion })[] = [];
    // Master pages are templates, not pages of the output: their content already shows through
    // the pages that apply them.
    for (const page of scene.pages.filter((p) => !p.isMaster)) {
      const region = exportRegion(onPage(scene, page.id), [], "page", measure, sheetOf(page));
      if (region) pages.push({ name: page.name, svg: "", width: region.bounds.width, height: region.bounds.height, region });
    }
    if (pages.length === 0) {
      useScene.setState({ notice: "nothing to export: every page is empty" });
      return false;
    }
    const all = pages.flatMap((p) => p.region.nodes);
    const assets = await resolveAssets(all, scene.id, "svg", deps);
    for (const p of pages) p.svg = svgMarkup(p.region, measure, assets);

    const data = buildEpub(pages, { title: scene.name || FALLBACK_NAME, identifier: `urn:opendesigner:${scene.id}`, modified: (deps.now?.() ?? new Date()).toISOString(), book: scene.settings?.book });
    (deps.download ?? downloadBlob)(new Blob([data as BlobPart], { type: EPUB_MIME }), documentFileName(scene.name, "epub"));
    if (assets.missing > 0) useScene.setState({ notice: missingImagesNotice(assets.missing) });
    return true;
  } catch (err) {
    useScene.setState({ notice: `export failed: ${err instanceof Error ? err.message : String(err)}` });
    return false;
  }
}

/**
 * Exports the document as a PACKAGE FOR PRINT (see export/packageForPrint.ts): the PDF with the chosen
 * options, the uploaded fonts, the placed image files and a text report, in one zip.
 */
export async function runPackage(deps: DocumentExportDeps = {}, opts: PrintPdfOptions = {}): Promise<boolean> {
  const { scene: raw } = useScene.getState();
  if (!raw) return false;
  const scene = resolveScene(raw);
  try {
    const measure = deps.measure ?? canvasMeasure(deps.createCanvas ?? defaultCanvas);
    const pd = { ...printDeps(deps, measure), now: deps.now };
    const pdf = await buildDocumentPdf(scene, (pageId, sheet) => exportRegion(onPage(scene, pageId), [], "page", measure, sheet ?? sheetOf(scene.pages.find((p) => p.id === pageId))), opts, pd);
    if (!pdf) {
      useScene.setState({ notice: "nothing to export: every page is empty" });
      return false;
    }
    const issues = [...preflightScene(scene, opts, measure), ...preflightReport(pdf.report, opts, pdf.missingImages, pdf.missingFonts)];
    const pkg = await buildPackage({ scene, pdf: pdf.bytes, report: pdf.report, issues, now: deps.now?.() ?? new Date() }, { loadAssetDataUrl: pd.loadAssetDataUrl });
    (deps.download ?? downloadBlob)(new Blob([pkg.bytes as BlobPart], { type: "application/zip" }), documentFileName(scene.name, "pdf").replace(/\.pdf$/, "-package.zip"));
    if (pkg.missing.length > 0) useScene.setState({ notice: `Package written without: ${pkg.missing.join(", ")} (not reachable).` });
    return true;
  } catch (err) {
    useScene.setState({ notice: `export failed: ${err instanceof Error ? err.message : String(err)}` });
    return false;
  }
}

/**
 * The preflight of the document as the editor would show it: what the document says (fonts, bleed, overset text...)
 * plus what the PDF writer finds while writing it (image resolution, missing glyphs, transparency under X-1a...).
 * Nothing is downloaded. `null` when there is no document or every page is empty.
 */
export async function runPreflight(deps: DocumentExportDeps = {}, opts: PrintPdfOptions = {}): Promise<PreflightIssue[] | null> {
  const { scene: raw } = useScene.getState();
  if (!raw) return null;
  const scene = resolveScene(raw);
  const measure = deps.measure ?? canvasMeasure(deps.createCanvas ?? defaultCanvas);
  const pdf = await buildDocumentPdf(scene, (pageId, sheet) => exportRegion(onPage(scene, pageId), [], "page", measure, sheet ?? sheetOf(scene.pages.find((p) => p.id === pageId))), opts, { ...printDeps(deps, measure), now: deps.now });
  if (!pdf) return null;
  return [...preflightScene(scene, opts, measure), ...preflightReport(pdf.report, opts, pdf.missingImages, pdf.missingFonts)];
}
