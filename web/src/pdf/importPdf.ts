import { create } from "@bufbuild/protobuf";
import { NodeSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "../store/store";
import { nextOrderKey } from "../store/orderKey";
import { uploadAsset, type AssetRef } from "../rpc/assets";
import { makeCreateNodeOp, makeCreatePageOp, uuid } from "../tools/ops";
import { importSvg } from "../svg/importSvg";
import { pdfPageToSvg } from "./pdfToSvg";

// IMPORTING A PDF (document menu → Import PDF…).
//
// Every PDF page becomes a PAGE of the document, sized in PDF points (1/72 in). Two modes:
//   "editable" (default): the page is read as SVG (pdf/pdfToSvg.ts) and goes through the
//      normal SVG importer, so text, vector shapes and embedded images become real nodes you
//      can edit. A page the importer cannot take (too many shapes) falls back to a picture.
//   "image": the page rendered to a PNG in one image node -- a faithful picture to annotate
//      or trace over.
// The whole import is ONE gesture: a single undo removes every imported page.
//
// pdf.js is loaded on demand: it is large and only this command needs it.

/** Long side, in pixels, of the raster of an imported page (sharp, but bounded memory). */
export const RASTER_LONG_SIDE = 2000;
/** The largest number of pages one import takes; beyond it the rest are left out and said so. */
export const MAX_PDF_PAGES = 200;

export interface RenderedPage {
  png: Blob;
  /** The page size in PDF points: what the node is sized to. */
  width: number;
  height: number;
}

export interface ExtractedPage {
  /** The page described as SVG (see pdf/pdfToSvg.ts). */
  svg: string;
  warnings: string[];
  width: number;
  height: number;
}

export type PdfImportMode = "editable" | "image";

export interface PdfRenderer {
  numPages: number;
  renderPage(index: number): Promise<RenderedPage>;
  /** Text, vectors and images of a page as SVG; absent in renderers that only rasterise. */
  extractPage?(index: number): Promise<ExtractedPage>;
  destroy(): void;
}

export interface PdfImportDeps {
  open(data: Uint8Array): Promise<PdfRenderer>;
  upload(docId: string, file: Blob): Promise<AssetRef>;
}

export interface PdfImportResult {
  ok: boolean;
  message: string;
  pages: number;
}

/** The default renderer: pdf.js drawing into an offscreen canvas. */
export async function openWithPdfjs(data: Uint8Array): Promise<PdfRenderer> {
  const pdfjs = await import("pdfjs-dist");
  const worker = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = worker;
  const doc = await pdfjs.getDocument({ data }).promise;
  return {
    numPages: doc.numPages,
    async renderPage(index) {
      const page = await doc.getPage(index + 1);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(4, RASTER_LONG_SIDE / Math.max(base.width, base.height));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("the 2D canvas is not available");
      await page.render({ canvasContext: ctx, viewport }).promise;
      const png = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
      page.cleanup();
      if (!png) throw new Error("could not encode the page");
      return { png, width: base.width, height: base.height };
    },
    async extractPage(index) {
      const page = await doc.getPage(index + 1);
      const viewport = page.getViewport({ scale: 1 });
      const ops = await page.getOperatorList();
      const content = await page.getTextContent();
      const OPS = pdfjs.OPS as unknown as Record<string, number>;

      // Images: decode every referenced object to a PNG data URI (kept in file order).
      const images: Record<string, string> = {};
      let inline = 0;
      for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i];
        const args = ops.argsArray[i] as unknown[];
        if (fn === OPS.paintImageXObject) {
          const id = String(args[0]);
          const store = id.startsWith("g_") ? page.commonObjs : page.objs;
          const obj = await new Promise<unknown>((res) => store.get(id, res));
          const uri = imageToDataUrl(obj);
          if (uri) images[id] = uri;
        } else if (fn === OPS.paintInlineImageXObject) {
          const uri = imageToDataUrl(args[0]);
          if (uri) images[`inline:${inline}`] = uri;
          inline++;
        }
      }

      const fontNames: Record<string, string> = {};
      const runs = content.items.filter((it): it is Extract<typeof it, { str: string }> => "str" in it);
      for (const name of new Set(runs.map((t) => t.fontName))) {
        try {
          if (page.commonObjs.has(name)) fontNames[name] = String((page.commonObjs.get(name) as { name?: string }).name ?? "");
        } catch { /* font not loaded: the generic family from the style is used */ }
      }
      const t = viewport.transform as [number, number, number, number, number, number];
      const res = pdfPageToSvg({
        width: viewport.width, height: viewport.height, viewTransform: t,
        fnArray: ops.fnArray, argsArray: ops.argsArray, OPS,
        text: runs.map((x) => ({ str: x.str, transform: x.transform, width: x.width, fontName: x.fontName })),
        fontNames, images,
      });
      page.cleanup();
      return { ...res, width: viewport.width, height: viewport.height };
    },
    destroy: () => void doc.destroy(),
  };
}


/** A pdf.js image object (ImageBitmap or raw RGB / RGBA bytes) as a PNG data URI, or null. */
function imageToDataUrl(obj: unknown): string | null {
  const img = obj as { width?: number; height?: number; data?: Uint8ClampedArray | Uint8Array; kind?: number; bitmap?: ImageBitmap } | null;
  if (!img || !img.width || !img.height) return null;
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  if (img.bitmap) {
    ctx.drawImage(img.bitmap, 0, 0);
  } else if (img.data && (img.kind === 3 || img.kind === 2)) {
    const px = img.width * img.height;
    const rgba = new Uint8ClampedArray(px * 4);
    for (let i = 0; i < px; i++) {
      if (img.kind === 3) {
        rgba.set(img.data.subarray(i * 4, i * 4 + 4), i * 4);
      } else {
        rgba[i * 4] = img.data[i * 3]; rgba[i * 4 + 1] = img.data[i * 3 + 1]; rgba[i * 4 + 2] = img.data[i * 3 + 2]; rgba[i * 4 + 3] = 255;
      }
    }
    ctx.putImageData(new ImageData(rgba, img.width, img.height), 0, 0);
  } else {
    return null;
  }
  return canvas.toDataURL("image/png");
}

const defaultDeps: PdfImportDeps = {
  open: openWithPdfjs,
  upload: (docId, file) => uploadAsset(docId, file),
};

export function isPdfFile(file: File): boolean {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

const baseName = (n: string) => n.replace(/\.pdf$/i, "") || "PDF";

/** Imports `file` as new pages at the end of the open document. */
export async function importPdfFile(
  file: File,
  deps: PdfImportDeps = defaultDeps,
  mode: PdfImportMode = "editable",
): Promise<PdfImportResult> {
  const docId = useScene.getState().scene?.id;
  if (!docId) return { ok: false, message: "No document is open.", pages: 0 };
  if (useScene.getState().gesture) return { ok: false, message: "Another edit is in progress.", pages: 0 };

  let renderer: PdfRenderer | null = null;
  try {
    renderer = await deps.open(new Uint8Array(await file.arrayBuffer()));
    const count = Math.min(renderer.numPages, MAX_PDF_PAGES);
    if (count === 0) return { ok: false, message: "The PDF has no pages.", pages: 0 };

    // Page after page (not in parallel): rasterising holds a full-size canvas each.
    type Done =
      | { kind: "image"; rendered: RenderedPage; ref: AssetRef }
      | { kind: "nodes"; width: number; height: number; svg: string };
    const done: Done[] = [];
    const notes = new Set<string>();
    let fallbacks = 0;
    for (let i = 0; i < count; i++) {
      if (mode === "editable" && renderer.extractPage) {
        try {
          const ex = await renderer.extractPage(i);
          ex.warnings.forEach((w) => notes.add(w));
          done.push({ kind: "nodes", width: ex.width, height: ex.height, svg: ex.svg });
          continue;
        } catch {
          fallbacks++; // this page is taken as a picture below
        }
      }
      const rendered = await renderer.renderPage(i);
      done.push({ kind: "image", rendered, ref: await deps.upload(docId, rendered.png) });
    }

    // The store is read NOW: the user kept working while pages rendered.
    const store = useScene.getState();
    const scene = store.scene;
    if (!scene || scene.id !== docId || store.gesture) {
      return { ok: false, message: "The document changed during the import: try again.", pages: 0 };
    }

    const name = baseName(file.name);
    const ops: Op[] = [];
    const pageIds: string[] = [];
    const key = nextOrderKey(scene);
    for (const [i, d] of done.entries()) {
      const pageId = uuid();
      pageIds.push(pageId);
      ops.push(makeCreatePageOp(pageId, count === 1 ? name : `${name} ${i + 1}`));
      if (d.kind === "image") {
        ops.push(
          makeCreateNodeOp(
            create(NodeSchema, {
              id: uuid(), parentId: pageId, orderKey: key, name: `${name} p.${i + 1}`,
              visible: true, opacity: 1, x: 0, y: 0, width: d.rendered.width, height: d.rendered.height,
              shape: { case: "image", value: { assetHash: d.ref.hash } },
            }),
          ),
        );
        continue;
      }
      try {
        const res = importSvg(d.svg, { docId, parentId: pageId, orderKey: key, name: `${name} p.${i + 1}`, scale: 1, at: { x: 0, y: 0 } });
        res.warnings.forEach((w) => notes.add(w));
        // Embedded images: uploaded now, the hash goes into the node (a failure leaves a placeholder).
        const byId = new Map(res.ops.map((op) => [op.kind.case === "createNode" ? op.kind.value.node?.id : "", op] as const));
        await Promise.all(res.assets.map(async (a) => {
          try {
            const ref = await deps.upload(docId, new Blob([new Uint8Array(a.bytes).buffer as ArrayBuffer], { type: a.mime }));
            const op = byId.get(a.nodeId);
            const node = op?.kind.case === "createNode" ? op.kind.value.node : undefined;
            if (node && node.shape.case === "image") node.shape.value.assetHash = ref.hash;
          } catch {
            notes.add("some images were not uploaded");
          }
        }));
        ops.push(...res.ops);
      } catch {
        // Too many shapes (or unreadable): this page becomes a picture.
        fallbacks++;
        const rendered = await renderer.renderPage(i);
        const ref = await deps.upload(docId, rendered.png);
        ops.push(
          makeCreateNodeOp(
            create(NodeSchema, {
              id: uuid(), parentId: pageId, orderKey: key, name: `${name} p.${i + 1}`,
              visible: true, opacity: 1, x: 0, y: 0, width: rendered.width, height: rendered.height,
              shape: { case: "image", value: { assetHash: ref.hash } },
            }),
          ),
        );
      }
    }
    // The store may have changed during the uploads above.
    if (useScene.getState().gesture || useScene.getState().scene?.id !== docId) {
      return { ok: false, message: "The document changed during the import: try again.", pages: 0 };
    }
    useScene.getState().beginGesture();
    useScene.getState().endGesture(ops);
    useScene.getState().setCurrentPage(pageIds[0]);

    const left = renderer.numPages - count;
    const tail = left > 0 ? ` ${left} more pages were left out (limit ${MAX_PDF_PAGES}).` : "";
    const fb = fallbacks > 0 ? ` ${fallbacks} ${fallbacks === 1 ? "page was" : "pages were"} imported as a picture.` : "";
    const nt = notes.size > 0 ? ` Not carried over: ${[...notes].join("; ")}.` : "";
    return { ok: true, message: `Imported ${count} ${count === 1 ? "page" : "pages"} from ${file.name}.${tail}${fb}${nt}`, pages: count };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return { ok: false, message: /password/i.test(reason) ? "The PDF is password protected." : `Could not read the PDF: ${reason}`, pages: 0 };
  } finally {
    renderer?.destroy();
  }
}

/** The file picker for PDFs. */
export function pickPdfFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".pdf,application/pdf";
    input.style.display = "none";
    const done = (f: File | null) => { input.remove(); resolve(f); };
    input.addEventListener("change", () => done(input.files?.[0] ?? null));
    input.addEventListener("cancel", () => done(null));
    document.body.appendChild(input);
    input.click();
  });
}
