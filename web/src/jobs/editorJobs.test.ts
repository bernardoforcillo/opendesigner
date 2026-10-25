import { describe, it, expect, beforeEach } from "vitest";
import { executeJob } from "./editorJobs";
import { useScene } from "../store/store";
import { emptyScene } from "../store/types";
import type { NodeLite } from "../store/types";

const node = (over: Partial<NodeLite> & { id: string }): NodeLite => ({
  parentId: "page1", orderKey: "a1", name: over.id, visible: true, opacity: 1, x: 0, y: 0, width: 100, height: 50, rotation: 0,
  fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false, ...over,
});
const deps = { measure: (s: string) => s.length * 10, now: () => new Date("2026-01-01T00:00:00Z") };
const text = (r: { data?: Uint8Array }) => new TextDecoder("latin1").decode(r.data);

beforeEach(() => {
  const s = emptyScene("doc", "Job book");
  s.pages = [{ id: "page1", name: "One", width: 200, height: 100, bleed: 9 }, { id: "p2", name: "Two", width: 200, height: 100 }];
  s.nodes = s.nodes.set("a", node({ id: "a" })).set("b", node({ id: "b", parentId: "p2", width: 30, height: 30 }));
  useScene.setState({ scene: s, selection: [], gesture: null, notice: null, currentPageId: "page1" });
});

describe("executeJob", () => {
  it("makes a PDF with the print options it was given", async () => {
    const r = await executeJob("export_pdf", '{"standard":"x4","bleed":true,"marks":true}', deps);
    expect(r.ok).toBe(true);
    expect(r.filename).toBe("Job book.pdf");
    expect(r.contentType).toBe("application/pdf");
    expect(text(r).startsWith("%PDF-1.6")).toBe(true);
    expect(text(r)).toContain("/GTS_PDFXVersion(PDF/X-4)");
    expect(text(r)).toContain("/TrimBox");
  });

  it("makes the print package, the fixed and the reflowable EPUB", async () => {
    const pkg = await executeJob("export_package", "", deps);
    expect(pkg.ok && pkg.filename).toBe("Job book-package.zip");
    expect(text(pkg)).toContain("Report.txt");
    const fixed = await executeJob("export_epub", "{}", deps);
    expect(fixed.ok && fixed.filename).toBe("Job book.epub");
    expect(text(fixed)).toContain("pre-paginated");
    const empty = await executeJob("export_epub_reflow", "{}", deps);
    expect(empty.ok).toBe(false);
    expect(empty.message).toMatch(/nothing to export/);
  });

  it("exports an SVG of a page chosen by id, without moving the editor", async () => {
    const r = await executeJob("export_svg", '{"pageId":"p2"}', deps);
    expect(r.ok).toBe(true);
    expect(text(r)).toContain('viewBox="0 0 200 100"');
    expect(useScene.getState().currentPageId).toBe("page1");
    const sel = await executeJob("export_svg", '{"nodeIds":["b"]}', deps);
    expect(sel.ok).toBe(false); // b is on another page than the one on screen
  });

  it("returns the preflight as JSON text", async () => {
    const r = await executeJob("preflight", '{"standard":"x1a","marks":true}', deps);
    expect(r.ok).toBe(true);
    const out = JSON.parse(r.text!);
    expect(out.issues.map((i: { code: string }) => i.code)).toContain("no-bleed");
    expect(out.warnings).toBeGreaterThan(0);
  });

  it("refuses bad input with a reason, never throws", async () => {
    expect((await executeJob("export_pdf", "{nope", deps)).message).toBe("options are not valid JSON");
    expect((await executeJob("export_pdf", "[]", deps)).message).toBe("options must be a JSON object");
    expect((await executeJob("export_pdf", '{"standard":"x9"}', deps)).message).toMatch(/standard must be/);
    expect((await executeJob("export_pdf", '{"bleed":"yes"}', deps)).message).toBe("bleed must be true or false");
    expect((await executeJob("export_svg", '{"scale":7}', deps)).message).toMatch(/scale must be/);
    expect((await executeJob("make_coffee", "", deps)).message).toBe("unknown job kind make_coffee");
    useScene.setState({ scene: null });
    expect((await executeJob("export_pdf", "", deps)).message).toBe("the editor has no document open");
  });

  it("carries the editor's warnings back as the message", async () => {
    const s = useScene.getState().scene!;
    useScene.setState({ scene: { ...s, nodes: s.nodes.set("im", node({ id: "im", kind: "image", image: { assetHash: "gone" } } as Partial<NodeLite> & { id: string })) } });
    const r = await executeJob("export_pdf", "{}", { ...deps, loadAssetDataUrl: async () => null });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/PDF written with problems/);
  });
});
