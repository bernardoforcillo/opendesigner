import { create } from "@bufbuild/protobuf";
import { NodeSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "../store/store";
import { nextOrderKey } from "../store/orderKey";
import { uploadAsset, type AssetRef } from "../rpc/assets";
import { makeCreateNodeOp, makeCreatePageOp, uuid } from "../tools/ops";

// IMPORTING A PDF (document menu → Import PDF…).
//
// Every PDF page becomes a PAGE of the document holding one image node: the page
// rendered to a PNG, uploaded as a content-addressed asset (the same path as a dropped
// image), sized in PDF points (1/72 in) so the page keeps its real proportions. The
// whole import is ONE gesture: a single undo removes every imported page.
//
// pdf.js is loaded on demand: it is large and only this command needs it. Rasterising
// (and not extracting text/vectors) is deliberate -- a PDF is a final-form format, and a
// faithful picture of each page is what a designer wants to annotate or trace over.

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

export interface PdfRenderer {
  numPages: number;
  renderPage(index: number): Promise<RenderedPage>;
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
    destroy: () => void doc.destroy(),
  };
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
export async function importPdfFile(file: File, deps: PdfImportDeps = defaultDeps): Promise<PdfImportResult> {
  const docId = useScene.getState().scene?.id;
  if (!docId) return { ok: false, message: "No document is open.", pages: 0 };
  if (useScene.getState().gesture) return { ok: false, message: "Another edit is in progress.", pages: 0 };

  let renderer: PdfRenderer | null = null;
  try {
    renderer = await deps.open(new Uint8Array(await file.arrayBuffer()));
    const count = Math.min(renderer.numPages, MAX_PDF_PAGES);
    if (count === 0) return { ok: false, message: "The PDF has no pages.", pages: 0 };

    // Page after page (not in parallel): rasterising holds a full-size canvas each.
    const done: { rendered: RenderedPage; ref: AssetRef }[] = [];
    for (let i = 0; i < count; i++) {
      const rendered = await renderer.renderPage(i);
      done.push({ rendered, ref: await deps.upload(docId, rendered.png) });
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
    done.forEach(({ rendered, ref }, i) => {
      const pageId = uuid();
      pageIds.push(pageId);
      ops.push(makeCreatePageOp(pageId, count === 1 ? name : `${name} ${i + 1}`));
      ops.push(
        makeCreateNodeOp(
          create(NodeSchema, {
            id: uuid(),
            parentId: pageId,
            // Each page is its own parent, so the same key can start every page.
            orderKey: key,
            name: `${name} p.${i + 1}`,
            visible: true,
            opacity: 1,
            x: 0,
            y: 0,
            width: rendered.width,
            height: rendered.height,
            shape: { case: "image", value: { assetHash: ref.hash } },
          }),
        ),
      );
    });
    store.beginGesture();
    useScene.getState().endGesture(ops);
    useScene.getState().setCurrentPage(pageIds[0]);

    const left = renderer.numPages - count;
    const tail = left > 0 ? ` ${left} more pages were left out (limit ${MAX_PDF_PAGES}).` : "";
    return { ok: true, message: `Imported ${count} ${count === 1 ? "page" : "pages"} from ${file.name}.${tail}`, pages: count };
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
