import { describe, it, expect, beforeEach, vi } from "vitest";
import { useScene } from "../store/store";
import { emptyScene, type NodeLite } from "../store/types";
import {
  importSvgAt, importSvgFile, importedNotice, isSvgFile, looksLikeSvg, pickSvgFile, viewportCenter,
  type SvgImportDeps,
} from "./svgImport";

const HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 60" width="100" height="60">
  <title>Test</title>
  <g id="group"><rect id="r" x="10" y="10" width="30" height="20" fill="#f00"/><circle id="c" cx="70" cy="30" r="10"/></g>
  <path id="p" d="M0 0 L50 50" stroke="#00f"/>
</svg>`;

function installScene(): void {
  useScene.setState({ gesture: null, lastError: null, notice: null, selection: [], camera: { x: 0, y: 0, zoom: 1 } });
  useScene.getState().setScene(emptyScene("doc-1", "Untitled"));
}

function nodes(): NodeLite[] {
  const s = useScene.getState().scene;
  return s ? [...s.nodes.values()] : [];
}

function deps(over: Partial<SvgImportDeps> = {}): SvgImportDeps {
  return { upload: async () => ({ hash: HASH, size: 10, contentType: "image/png" }), measureText: () => 10, ...over };
}

describe("looksLikeSvg / isSvgFile", () => {
  it("recognizes the <svg> root with or without prologue, comments and doctype", () => {
    expect(looksLikeSvg(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`)).toBe(true);
    expect(looksLikeSvg(`  \n<svg viewBox="0 0 1 1"/>`)).toBe(true);
    expect(looksLikeSvg(`<?xml version="1.0" encoding="UTF-8"?>\n<!-- Generator: x -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd">\n<svg width="1"></svg>`)).toBe(true);
    expect(looksLikeSvg(`<SVG viewBox="0 0 1 1"></SVG>`)).toBe(true);
  });
  it("and an <svg> root with surrounding text, as long as it closes", () => {
    expect(looksLikeSvg(`Here is the icon:\n<svg viewBox="0 0 1 1"><rect/></svg>\nbye`)).toBe(true);
    expect(looksLikeSvg(`<div><svg width="1"><path/></svg></div>`)).toBe(true);
  });
  it("does not confuse other text, nor a JSON payload that names an <svg>", () => {
    expect(looksLikeSvg("")).toBe(false);
    expect(looksLikeSvg("hello world")).toBe(false);
    expect(looksLikeSvg("<html><body>svg</body></html>")).toBe(false);
    // With the root at the start we give it a try (and the import will say why it fails) ...
    expect(looksLikeSvg("<svg unclosed")).toBe(true);
    // ... but a mention in the middle of text, without closing, is not enough.
    expect(looksLikeSvg("look: <svg unclosed")).toBe(false);
    expect(looksLikeSvg(`{"format":"opendesigner/clipboard","nodes":[{"name":"<svg a></svg>"}]}`)).toBe(false);
    expect(looksLikeSvg("<svgfoo></svgfoo>")).toBe(false);
  });
  it("isSvgFile: by MIME type or by extension", () => {
    expect(isSvgFile({ name: "a.svg", type: "image/svg+xml" })).toBe(true);
    expect(isSvgFile({ name: "A.SVG", type: "" })).toBe(true);
    expect(isSvgFile({ name: "a", type: "image/svg+xml" })).toBe(true);
    expect(isSvgFile({ name: "a.png", type: "image/png" })).toBe(false);
    expect(isSvgFile({ name: "svg.png", type: "" })).toBe(false);
  });
});

describe("importedNotice", () => {
  it("singular, plural and warnings", () => {
    expect(importedNotice(1, [])).toBe("Imported as 1 layer");
    expect(importedNotice(7, [])).toBe("Imported as 7 layers");
    expect(importedNotice(7, ["a"])).toBe("Imported as 7 layers · 1 warning: a");
    expect(importedNotice(7, ["a", "b (2×)"])).toBe("Imported as 7 layers · 2 warnings: a; b (2×)");
  });
});

describe("importSvgAt", () => {
  beforeEach(installScene);

  it("creates the nodes under the page, centered on the point, and selects the root", async () => {
    const id = await importSvgAt(SVG, { x: 500, y: 300 }, {}, deps());
    expect(id).not.toBeNull();
    const ns = nodes();
    expect(ns.length).toBe(5); // root, group, rect, circle, path
    const root = ns.find((n) => n.id === id)!;
    expect(root).toMatchObject({ kind: "group", name: "Test", parentId: "page1" });
    // 100x60 centered on (500,300)
    expect(root.x).toBe(450);
    expect(root.y).toBe(270);
    expect(useScene.getState().selection).toEqual([id]);
    expect(ns.find((n) => n.name === "group")).toBeTruthy();
  });

  it("is ONE gesture: an undo removes everything, a redo puts it back", async () => {
    await importSvgAt(SVG, { x: 0, y: 0 }, {}, deps());
    expect(nodes().length).toBe(5);
    useScene.getState().undo();
    expect(nodes().length).toBe(0);
    useScene.getState().redo();
    expect(nodes().length).toBe(5);
    useScene.getState().undo();
    expect(nodes().length).toBe(0);
  });

  it("reports what happened: 'Imported as N layers' plus the warnings", async () => {
    await importSvgAt(SVG, { x: 0, y: 0 }, {}, deps());
    expect(useScene.getState().notice).toBe("Imported as 5 layers");
    await importSvgAt(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="5" height="5" filter="url(#f)"/></svg>`, { x: 0, y: 0 }, {}, deps());
    expect(useScene.getState().notice).toMatch(/^Imported as 2 layers · 1 warning: /);
  });

  it("the file name is the fallback name of the root", async () => {
    const id = await importSvgAt(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="5" height="5"/></svg>`, { x: 0, y: 0 }, { name: "logo" }, deps());
    expect(nodes().find((n) => n.id === id)!.name).toBe("logo");
  });

  it("an invalid SVG does not change the document and says so in the notice, without throwing", async () => {
    const id = await importSvgAt("<svg><rect></svg>", { x: 0, y: 0 }, {}, deps());
    expect(id).toBeNull();
    expect(nodes().length).toBe(0);
    expect(useScene.getState().notice).toMatch(/^SVG import failed: /);
    expect(useScene.getState().lastError).toBeNull();
  });

  it("too large or too many nodes: clear error, document untouched", async () => {
    const many = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${"<rect width='1' height='1'/>".repeat(5100)}</svg>`;
    expect(await importSvgAt(many, { x: 0, y: 0 }, {}, deps())).toBeNull();
    expect(useScene.getState().notice).toMatch(/5000/);
    expect(nodes().length).toBe(0);
    const huge = `<svg xmlns="http://www.w3.org/2000/svg">${" ".repeat(6 * 1024 * 1024)}</svg>`;
    expect(await importSvgAt(huge, { x: 0, y: 0 }, {}, deps())).toBeNull();
    expect(useScene.getState().notice).toMatch(/5 MB/);
  });

  it("with a gesture open it does nothing (same guard as paste and drop)", async () => {
    useScene.getState().beginGesture();
    expect(await importSvgAt(SVG, { x: 0, y: 0 }, {}, deps())).toBeNull();
    expect(nodes().length).toBe(0);
    useScene.setState({ gesture: null });
  });

  it("without an open document it does nothing", async () => {
    useScene.setState({ scene: null });
    expect(await importSvgAt(SVG, { x: 0, y: 0 }, {}, deps())).toBeNull();
  });

  it("the parent is the current page, not necessarily the first", async () => {
    const s = emptyScene("doc-1", "x");
    s.pages = [{ id: "page1", name: "A" }, { id: "page2", name: "B" }];
    useScene.getState().setScene(s);
    useScene.setState({ currentPageId: "page2" });
    const id = await importSvgAt(SVG, { x: 0, y: 0 }, {}, deps());
    expect(nodes().find((n) => n.id === id)!.parentId).toBe("page2");
  });

  it("the root is queued above what is already there (next order key)", async () => {
    await importSvgAt(SVG, { x: 0, y: 0 }, {}, deps());
    const first = nodes().find((n) => n.parentId === "page1")!;
    const id2 = await importSvgAt(SVG, { x: 200, y: 0 }, {}, deps());
    const second = nodes().find((n) => n.id === id2)!;
    expect(second.orderKey > first.orderKey).toBe(true);
  });

  it("embedded images: uploaded FIRST, and the node receives the hash", async () => {
    const upload = vi.fn(async (_d: string, _f: Blob) => ({ hash: HASH, size: 1, contentType: "image/png" }));
    const id = await importSvgAt(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40"><image id="photo" width="40" height="40" preserveAspectRatio="none" href="data:image/png;base64,${PNG}"/></svg>`,
      { x: 0, y: 0 }, {}, deps({ upload }),
    );
    expect(id).not.toBeNull();
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0][0]).toBe("doc-1");
    expect(upload.mock.calls[0][1].type).toBe("image/png");
    const img = nodes().find((n) => n.name === "photo")!;
    expect(img.image?.assetHash).toBe(HASH);
  });

  it("a failed upload does not cancel the import: placeholder and warning", async () => {
    const id = await importSvgAt(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40"><rect id="r" width="5" height="5"/><image id="photo" width="40" height="40" href="data:image/png;base64,${PNG}"/></svg>`,
      { x: 0, y: 0 }, {}, deps({ upload: async () => { throw new Error("network"); } }),
    );
    expect(id).not.toBeNull();
    expect(nodes().find((n) => n.name === "photo")!.image?.assetHash).toBe("");
    expect(useScene.getState().notice).toMatch(/1 image not uploaded/);
  });

  it("if the document changes during the uploads, it applies nothing", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const p = importSvgAt(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40"><image width="40" height="40" href="data:image/png;base64,${PNG}"/></svg>`,
      { x: 0, y: 0 }, {}, deps({ upload: async () => { await gate; return { hash: HASH, size: 1, contentType: "image/png" }; } }),
    );
    useScene.getState().setScene(emptyScene("doc-2", "Other"));
    release();
    expect(await p).toBeNull();
    expect(nodes().length).toBe(0);
  });
});

describe("importSvgFile / pickSvgFile", () => {
  beforeEach(installScene);

  it("reads the file and imports, with the name without extension", async () => {
    const file = new File([SVG.replace("<title>Test</title>", "")], "my-logo.svg", { type: "image/svg+xml" });
    const id = await importSvgFile(file, { x: 0, y: 0 }, deps());
    expect(nodes().find((n) => n.id === id)!.name).toBe("my-logo");
  });

  it("an unreadable file ends up in the notice", async () => {
    const bad = { name: "x.svg", type: "image/svg+xml", text: () => Promise.reject(new Error("boom")) } as unknown as File;
    expect(await importSvgFile(bad, { x: 0, y: 0 }, deps())).toBeNull();
    expect(useScene.getState().notice).toMatch(/is not readable/);
  });

  it("pickSvgFile imports at the center of the view; if cancelled it does nothing", async () => {
    useScene.setState({ camera: { x: -100, y: -50, zoom: 2 } });
    const file = new File([SVG], "a.svg", { type: "image/svg+xml" });
    const id = await pickSvgFile(async () => file, deps());
    expect(id).not.toBeNull();
    // without a canvas in the DOM the center falls back to the 800x600 screen -> world (450, 325)
    const root = nodes().find((n) => n.id === id)!;
    const c = viewportCenter();
    expect(root.x + 50).toBeCloseTo(c.x, 3);
    expect(root.y + 30).toBeCloseTo(c.y, 3);
    expect(c).toEqual({ x: (400 + 100) / 2, y: (300 + 50) / 2 });
    const before = nodes().length;
    expect(await pickSvgFile(async () => null, deps())).toBeNull();
    expect(nodes().length).toBe(before);
  });
});
