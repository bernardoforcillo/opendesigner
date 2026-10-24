import { describe, it, expect, beforeEach, vi } from "vitest";
import { importPdfFile, isPdfFile, MAX_PDF_PAGES, type PdfImportDeps, type PdfRenderer } from "./importPdf";
import { useScene } from "../store/store";
import { emptyScene } from "../store/types";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";

function fakeDeps(pages: number, over: Partial<PdfImportDeps> = {}) {
  const destroy = vi.fn();
  const renderer: PdfRenderer = {
    numPages: pages,
    renderPage: async (i) => ({ png: new Blob([`p${i}`], { type: "image/png" }), width: 595, height: 842 }),
    destroy,
  };
  const upload = vi.fn(async (_d: string, f: Blob) => ({ hash: "a".repeat(64), size: f.size, contentType: "image/png" }));
  return { deps: { open: async () => renderer, upload, ...over } as PdfImportDeps, upload, destroy };
}

const pdf = () => new File([new Uint8Array([37, 80, 68, 70])], "report.pdf", { type: "application/pdf" });

// A server double that accepts and echoes at once.
const sync = {
  submit(op: Op) {
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  },
};

beforeEach(() => {
  useScene.setState({ selection: [], gesture: null, notice: null, undoStack: [], redoStack: [] });
  useScene.getState().setScene(emptyScene("doc", "Doc"));
  useScene.getState().setSync(sync);
});

describe("importPdfFile", () => {
  it("creates one page per PDF page with an image node sized in points", async () => {
    const { deps, upload, destroy } = fakeDeps(3);
    const r = await importPdfFile(pdf(), deps);
    expect(r).toMatchObject({ ok: true, pages: 3 });
    expect(upload).toHaveBeenCalledTimes(3);
    expect(destroy).toHaveBeenCalled();
    const { scene, currentPageId } = useScene.getState();
    expect(scene!.pages.map((p) => p.name)).toEqual(expect.arrayContaining(["report 1", "report 2", "report 3"]));
    const images = [...scene!.nodes.values()].filter((n) => n.kind === "image");
    expect(images).toHaveLength(3);
    expect(images[0]).toMatchObject({ width: 595, height: 842 });
    expect(currentPageId).toBe(scene!.pages[1].id);
  });

  it("names a single page after the file", async () => {
    const { deps } = fakeDeps(1);
    await importPdfFile(pdf(), deps);
    expect(useScene.getState().scene!.pages.map((p) => p.name)).toContain("report");
  });

  it("caps the number of pages and says so", async () => {
    const { deps, upload } = fakeDeps(MAX_PDF_PAGES + 5);
    const r = await importPdfFile(pdf(), deps);
    expect(upload).toHaveBeenCalledTimes(MAX_PDF_PAGES);
    expect(r.message).toContain("5 more pages were left out");
  });

  it("reports an unreadable PDF without touching the document", async () => {
    const { deps } = fakeDeps(1, { open: async () => { throw new Error("Invalid PDF structure"); } });
    const before = useScene.getState().scene!.pages.length;
    const r = await importPdfFile(pdf(), deps);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Invalid PDF structure");
    expect(useScene.getState().scene!.pages.length).toBe(before);
  });

  it("fails cleanly on an upload error", async () => {
    const { deps } = fakeDeps(2, { upload: async () => { throw new Error("too large"); } });
    const r = await importPdfFile(pdf(), deps);
    expect(r).toMatchObject({ ok: false, pages: 0 });
  });
});

describe("editable import", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200" viewBox="0 0 300 200"><rect width="300" height="200" fill="#fff"/><rect x="20" y="20" width="100" height="60" fill="#f80"/><text x="30" y="100" font-size="18" fill="#080">Hello</text></svg>';
  const withExtract = (extract: PdfRenderer["extractPage"]) =>
    fakeDeps(2, {
      open: async () => ({
        numPages: 2,
        renderPage: async () => ({ png: new Blob(["x"], { type: "image/png" }), width: 300, height: 200 }),
        extractPage: extract,
        destroy() {},
      }),
    });

  it("makes real nodes (rect, text) instead of one picture", async () => {
    const { deps, upload } = withExtract(async () => ({ svg, warnings: ["clipping was not carried over"], width: 300, height: 200 }));
    const r = await importPdfFile(pdf(), deps);
    expect(r.ok).toBe(true);
    expect(r.message).toContain("Not carried over: clipping was not carried over");
    expect(upload).not.toHaveBeenCalled();
    const kinds = [...useScene.getState().scene!.nodes.values()].map((n) => n.kind);
    expect(kinds).toEqual(expect.arrayContaining(["rect", "text"]));
    expect(kinds).not.toContain("image");
  });

  it("falls back to a picture for a page it cannot extract", async () => {
    let n = 0;
    const { deps, upload } = withExtract(async () => {
      if (n++ === 0) throw new Error("boom");
      return { svg, warnings: [], width: 300, height: 200 };
    });
    const r = await importPdfFile(pdf(), deps);
    expect(r.message).toContain("1 page was imported as a picture");
    expect(upload).toHaveBeenCalledTimes(1);
    const kinds = [...useScene.getState().scene!.nodes.values()].map((n) => n.kind);
    expect(kinds).toContain("image");
    expect(kinds).toContain("text");
  });

  it("image mode never extracts", async () => {
    const extract = vi.fn();
    const { deps } = withExtract(extract);
    await importPdfFile(pdf(), deps, "image");
    expect(extract).not.toHaveBeenCalled();
  });
});

describe("isPdfFile", () => {
  it("accepts by mime type or extension", () => {
    expect(isPdfFile(pdf())).toBe(true);
    expect(isPdfFile(new File([""], "X.PDF"))).toBe(true);
    expect(isPdfFile(new File([""], "x.png", { type: "image/png" }))).toBe(false);
  });
});
