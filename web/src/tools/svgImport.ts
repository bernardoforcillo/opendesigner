import { screenToWorld } from "../canvas/camera";
import { nextOrderKey } from "../store/orderKey";
import { useScene } from "../store/store";
import type { TextStyleLite } from "../store/types";
import { uploadAsset, type AssetRef } from "../rpc/assets";
import { fontString } from "../renderer/text";
import { SvgImportError, importSvg } from "../svg/importSvg";

// IMPORT AN SVG INTO THE DOCUMENT.
//
// A single entry point, `importSvgAt`, for the THREE ways an SVG can
// arrive: dragged onto the canvas (tools/imageDrop.ts), pasted as text
// (tools/clipboard.ts) and chosen from "Import SVG…" (ui/shell/DocMenu.tsx). All
// three end up here because the rules are the same and must stay so:
//   - ONE gesture = ONE undo entry, even for a hundred nodes;
//   - the imported root is selected immediately;
//   - the outcome is reported in the `notice` channel (not `lastError`: no change
//     was undone, it is information): "Imported as N layers" plus the
//     warnings about what the model cannot represent.
//
// The actual import (text -> ops) is pure and lives in svg/importSvg.ts; here is only
// what touches the store and the network: embedded assets (data URIs) are
// uploaded BEFORE applying the ops, for the same reason imageDrop
// uploads before creating -- the node needs the hash, and create-then-fix
// would mean two gestures for a single action.

export interface SvgImportDeps {
  upload: (docId: string, file: Blob) => Promise<AssetRef>;
  measureText?: (text: string, style: TextStyleLite) => number;
}

const defaultDeps: SvgImportDeps = {
  upload: (docId, file) => uploadAsset(docId, file),
};

// The width of a line measured the way the canvas measures it (same font
// string as the renderer): used to align `text-anchor`. Without a 2D context
// (jsdom) it returns undefined and the importer falls back to an estimate.
function canvasTextMeasure(): ((text: string, style: TextStyleLite) => number) | undefined {
  // Without a real 2D context (jsdom has none: CanvasRenderingContext2D does not
  // even exist as a global) we do not even try to create one.
  if (typeof document === "undefined" || typeof CanvasRenderingContext2D === "undefined") return undefined;
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = document.createElement("canvas").getContext("2d");
  } catch {
    ctx = null;
  }
  if (!ctx) return undefined;
  const c = ctx;
  return (text, style) => {
    c.font = fontString(style);
    return c.measureText(text).width;
  };
}

/** Is the text (probably) an SVG document? <svg> root, with or without an XML prologue. */
export function looksLikeSvg(text: string): boolean {
  const head = text.slice(0, 4096);
  if (/^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(head)) return true;
  // "contains an <svg> root": text with surroundings (a comment, a
  // snippet pasted from a site) -- but one that really closes the element.
  return /<svg[\s>][\s\S]*<\/svg\s*>/i.test(text) && !text.trimStart().startsWith("{");
}

/** An SVG file, by declared type or by extension (the type may be empty). */
export function isSvgFile(file: { name?: string; type?: string }): boolean {
  return file.type === "image/svg+xml" || /\.svg$/i.test(file.name ?? "");
}

/** The center of the visible part of the canvas, in world coordinates. */
export function viewportCenter(): { x: number; y: number } {
  const cam = useScene.getState().camera;
  const el = typeof document === "undefined"
    ? null
    : (document.getElementById("overlay") ?? document.querySelector("canvas"));
  const r = el?.getBoundingClientRect();
  const w = r && r.width > 0 ? r.width : 800;
  const h = r && r.height > 0 ? r.height : 600;
  return screenToWorld(cam, w / 2, h / 2);
}

export function importedNotice(levels: number, warnings: readonly string[]): string {
  const head = `Imported as ${levels} ${levels === 1 ? "layer" : "layers"}`;
  if (warnings.length === 0) return head;
  return `${head} · ${warnings.length === 1 ? "1 warning" : `${warnings.length} warnings`}: ${warnings.join("; ")}`;
}

function failNotice(message: string): void {
  useScene.setState({ notice: `SVG import failed: ${message}` });
}

/**
 * Imports `source` (the text of an SVG) CENTERED on `point` (world coordinates)
 * in a single gesture, and selects the root group. Returns the root id,
 * or null (with a `notice`) if nothing was imported.
 */
export async function importSvgAt(
  source: string,
  point: { x: number; y: number },
  opts: { name?: string } = {},
  deps: SvgImportDeps = defaultDeps,
): Promise<string | null> {
  const first = useScene.getState();
  const docId = first.scene?.id;
  if (!first.scene || !docId) return null;
  // Same guard as paste and image drop: with a gesture open the ops
  // would enter the base of the gesture in progress.
  if (first.gesture) return null;

  let result;
  try {
    result = importSvg(source, {
      docId,
      parentId: first.currentPageId ?? first.scene.pages[0]?.id ?? "",
      orderKey: nextOrderKey(first.scene),
      name: opts.name,
      measureText: deps.measureText ?? canvasTextMeasure(),
    });
  } catch (err) {
    failNotice(err instanceof SvgImportError ? err.message : "the file is not readable");
    return null;
  }
  const warnings = [...result.warnings];

  // The embedded assets: each is uploaded and its hash goes into the node. A
  // failed upload leaves the node with an empty hash, which the renderer draws as a
  // placeholder -- better than the whole import aborted over one image.
  if (result.assets.length > 0) {
    const nodeOps = new Map(result.ops.map((op) => [op.kind.case === "createNode" ? op.kind.value.node?.id : "", op] as const));
    let failed = 0;
    await Promise.all(result.assets.map(async (a) => {
      try {
        const buf = new Uint8Array(a.bytes).buffer as ArrayBuffer;
        const ref = await deps.upload(docId, new Blob([buf], { type: a.mime }));
        const op = nodeOps.get(a.nodeId);
        const node = op?.kind.case === "createNode" ? op.kind.value.node : undefined;
        if (node && node.shape.case === "image") node.shape.value.assetHash = ref.hash;
      } catch {
        failed++;
      }
    }));
    if (failed > 0) warnings.push(`${failed} ${failed === 1 ? "image not uploaded" : "images not uploaded"}: placeholder in its place`);
  }

  // The store is RE-READ now: during the uploads the user kept
  // working (order key, gesture, page, document may have changed).
  const store = useScene.getState();
  const scene = store.scene;
  if (!scene || scene.id !== docId || store.gesture) return null;
  const root = result.ops[0];
  const rootNode = root.kind.case === "createNode" ? root.kind.value.node : undefined;
  if (!rootNode) return null;
  rootNode.orderKey = nextOrderKey(scene);
  rootNode.parentId = store.currentPageId ?? scene.pages[0]?.id ?? "";
  rootNode.x = Math.round((point.x - result.size.width / 2) * 1e4) / 1e4;
  rootNode.y = Math.round((point.y - result.size.height / 2) * 1e4) / 1e4;

  store.beginGesture();
  useScene.getState().setSelection([result.rootId]);
  useScene.getState().endGesture(result.ops);
  useScene.setState({ notice: importedNotice(result.nodeCount, warnings) });
  return result.rootId;
}

/** Reads the text of a file/blob (Blob.text() where available, FileReader otherwise). */
export function readFileText(file: Blob): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ""));
    r.onerror = () => reject(r.error ?? new Error("file read failed"));
    r.readAsText(file);
  });
}

/** Imports an SVG file (drop or picker) centered on `point`. */
export async function importSvgFile(
  file: File,
  point: { x: number; y: number },
  deps?: SvgImportDeps,
): Promise<string | null> {
  let text: string;
  try {
    text = await readFileText(file);
  } catch {
    failNotice(`${file.name || "the file"} is not readable`);
    return null;
  }
  return importSvgAt(text, point, { name: (file.name ?? "").replace(/\.svg$/i, "") }, deps);
}

/**
 * Opens the file picker and imports the chosen SVG at the center of the view
 * ("Import SVG…" in the menu). `picker` is injectable for tests: in jsdom
 * there is no real file picker.
 */
export function pickSvgFile(
  picker: () => Promise<File | null> = defaultPicker,
  deps?: SvgImportDeps,
): Promise<string | null> {
  return picker().then((file) => (file ? importSvgFile(file, viewportCenter(), deps) : null));
}

function defaultPicker(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".svg,image/svg+xml";
    input.style.display = "none";
    const done = (f: File | null) => { input.remove(); resolve(f); };
    input.addEventListener("change", () => done(input.files?.[0] ?? null));
    // Cancelling the picker does not emit `change`: `cancel` exists in recent
    // browsers; in those that do not emit it the promise stays pending at no
    // cost (no resource held).
    input.addEventListener("cancel", () => done(null));
    document.body.appendChild(input);
    input.click();
  });
}
