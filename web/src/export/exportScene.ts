import { resolveScene } from "../store/variables";
import { useScene } from "../store/store";
import { fontString } from "../renderer/text";
import { assetUrl } from "../rpc/assets";
import type { ImageSource } from "../renderer/canvasRenderer";
import type { NodeLite } from "../store/types";
import { exportRegion, type ExportRegion, type ExportScope } from "./region";
import { nodesToSvg, type MeasureText, type ResolveImageHref } from "./svg";
import { canvasToPngBlob, renderRegionToCanvas, type ExportScale } from "./png";

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

// "pdf" is the SVG handed to the browser's print dialog (Save as PDF): vector, with the
// fonts the page has. No second renderer and no PDF writer to keep in step with the canvas.
export type ExportFormat = "png" | "svg" | "pdf";

export interface ExportRequest {
  format: ExportFormat;
  scope: ExportScope;
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
  // PDF: opens the print dialog on the SVG markup, sized to `bounds`.
  printSvg?: (svg: string, bounds: { width: number; height: number }) => void;
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

/**
 * Hands the blob to the user as a download.
 *
 * The anchor really enters the document before the click: in some browsers a detached
 * element does not trigger the download. The URL is revoked in a timer and not
 * right after the click, because the download starts asynchronously and revoking
 * the URL in the same event turn would cancel it.
 */
/**
 * Prints the SVG: it goes into a hidden iframe whose @page is exactly the exported region,
 * so "Save as PDF" in the print dialog produces one page of that size, without margins.
 */
export function printSvgDocument(svg: string, bounds: { width: number; height: number }): void {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  Object.assign(frame.style, { position: "fixed", right: "0", bottom: "0", width: "0", height: "0", border: "0" });
  const w = Math.ceil(bounds.width), h = Math.ceil(bounds.height);
  frame.srcdoc = `<!doctype html><meta charset="utf-8"><style>@page{size:${w}px ${h}px;margin:0}html,body{margin:0}svg{display:block}</style>${svg}`;
  frame.onload = () => {
    const win = frame.contentWindow;
    if (!win) { frame.remove(); return; }
    win.addEventListener("afterprint", () => frame.remove());
    win.focus();
    win.print();
  };
  document.body.appendChild(frame);
}

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
  const { scene: raw, selection } = useScene.getState();
  if (!raw) return false;
  // What is exported is what is drawn: variables resolved for each node's active mode.
  const scene = resolveScene(raw);

  const createCanvas = deps.createCanvas ?? defaultCanvas;
  try {
    // The text measure is built BEFORE the region, and for BOTH
    // formats: it serves not only to wrap the SVG, it serves to know how tall
    // the text is -- that is to size the region, therefore the PNG's
    // canvas too (see export/region.ts). It sits inside the try because building it
    // needs a 2D context, which may not exist: one more reason an
    // export can fail, and it goes through the channel of all the others.
    const measure = deps.measure ?? canvasMeasure(createCanvas);

    const region = exportRegion(scene, selection, req.scope, measure);
    if (!region) {
      useScene.setState({ notice: req.scope === "selection" ? NOTHING_SELECTED : EMPTY_PAGE });
      return false;
    }

    const assets = await resolveAssets(region.nodes, scene.id, req.format, deps);
    if (req.format === "pdf") {
      (deps.printSvg ?? printSvgDocument)(svgMarkup(region, measure, assets), region.bounds);
    } else {
      const blob = await exportBlob(region, req, deps, createCanvas, measure, assets);
      (deps.download ?? downloadBlob)(blob, exportFileName(scene.name, req));
    }
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
