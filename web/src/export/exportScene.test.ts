import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runExport, exportFileName, downloadBlob } from "./exportScene";
import type { ExportDeps, DocumentExportDeps } from "./exportScene";
import { runDocumentExport, runPackage } from "./exportScene";
import { useScene } from "../store/store";
import { emptyScene } from "../store/types";
import type { NodeLite, SceneState } from "../store/types";

function node(over: Partial<NodeLite> & { id: string }): NodeLite {
  return {
    parentId: "page1", orderKey: "a1", name: over.id, visible: true, opacity: 1,
    x: 0, y: 0, width: 10, height: 10, rotation: 0,
    fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false,
    ...over,
  };
}

// A text node with the box of a node just created with a click: wrap width
// 100 and height of ONE line (16 * 1.2 = 19.2). With the fake measure (10
// units per character) "abcdefghij klm" takes TWO: it is the case in which the model's
// box and what the canvas paints do not coincide.
function overflowingText(id: string): NodeLite {
  return node({
    id, kind: "text", x: 0, y: 0, width: 100, height: 19.2,
    text: {
      content: "abcdefghij klm",
      style: { fontFamily: "", fontSize: 16, fontWeight: "", lineHeight: 0, align: "left" },
    },
  });
}

afterEach(() => vi.unstubAllGlobals());

/** A PDF blob read back with pdf.js. */
async function openPdf(blob: Blob) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(await blob.arrayBuffer());
  return pdfjs.getDocument({ data, useWorkerFetch: false, isEvalSupported: false, verbosity: 0 }).promise;
}
const textOf = async (doc: Awaited<ReturnType<typeof openPdf>>, page: number) =>
  (await (await doc.getPage(page)).getTextContent()).items.map((i) => ("str" in i ? i.str : "")).join("");

function install(scene: SceneState | null, selection: string[] = []): void {
  useScene.setState({ scene, selection, gesture: null, notice: null, camera: { x: 0, y: 0, zoom: 1 } });
}

function sceneWith(name: string, ...nodes: NodeLite[]): SceneState {
  const s = emptyScene("doc", name);
  for (const n of nodes) s.nodes = s.nodes.set(n.id, n);
  return s;
}

// The offscreen canvas and the PNG encoding are doubles: jsdom has neither a 2D
// context nor toBlob. Here the PATH is verified (who is called, with
// what file name, with what blob type), not the pixels.
class FakePath2D {
  rect() {}
  roundRect() {}
  ellipse() {}
}

function fakeCanvas(): HTMLCanvasElement {
  const canvas = {
    width: 0, height: 0,
    getContext: () => ctx,
  } as unknown as HTMLCanvasElement;
  const ctx = {
    canvas,
    font: "", textBaseline: "", textAlign: "", fillStyle: "", strokeStyle: "", lineWidth: 0,
    globalAlpha: 1,
    setTransform: () => {}, clearRect: () => {},
    measureText: (s: string) => ({ width: s.length * 10 }),
    fillText: () => {}, fill: () => {},
    // The image branch of drawScene: either `drawImage`, or the placeholder. Recorded
    // because it is the only way, without real pixels, to know WHICH of the two
    // ended up in the file.
    drawImage: (img: unknown) => { drawn.push(img); },
    fillRect: () => {}, strokeRect: () => {},
    beginPath: () => {}, moveTo: () => {}, lineTo: () => {}, stroke: () => { crosses++; },
  } as unknown as CanvasRenderingContext2D;
  return canvas;
}

// What the PNG actually drew in the last export: the images passed
// to drawImage and how many placeholders (the only `stroke()` in drawScene is theirs).
let drawn: unknown[] = [];
let crosses = 0;

function deps(): ExportDeps & { saved: { blob: Blob; filename: string }[] } {
  const saved: { blob: Blob; filename: string }[] = [];
  return {
    saved,
    createCanvas: fakeCanvas,
    toPngBlob: async () => new Blob(["png"], { type: "image/png" }),
    download: (blob, filename) => { saved.push({ blob, filename }); },
    measure: (s: string) => s.length * 10,
  };
}

beforeEach(() => {
  vi.stubGlobal("Path2D", FakePath2D);
  install(null);
  drawn = [];
  crosses = 0;
});

describe("runExport — SVG", () => {
  it("exports the page and delivers the markup", async () => {
    install(sceneWith("Untitled", node({ id: "a", x: 10, y: 20, width: 30, height: 40 })));
    const d = deps();
    await expect(runExport({ format: "svg", scope: "page", scale: 1 }, d)).resolves.toBe(true);
    expect(d.saved).toHaveLength(1);
    expect(d.saved[0].filename).toBe("Untitled.svg");
    expect(d.saved[0].blob.type).toContain("image/svg+xml");
    const text = await d.saved[0].blob.text();
    expect(text).toContain('<rect x="10" y="20" width="30" height="40"');
    expect(text).toContain('viewBox="10 20 30 40"');
  });

  it("exports the SELECTION: only the chosen nodes, and it shows in the file name", async () => {
    install(
      sceneWith("Untitled", node({ id: "a" }), node({ id: "b", orderKey: "a2", kind: "ellipse", x: 100 })),
      ["b"],
    );
    const d = deps();
    await runExport({ format: "svg", scope: "selection", scale: 1 }, d);
    const text = await d.saved[0].blob.text();
    expect(text).toContain("<ellipse");
    expect(text).not.toContain("<rect");
    expect(d.saved[0].filename).toBe("Untitled-selection.svg");
  });

  it("does NOT depend on the camera: the view does not enter the file", async () => {
    install(sceneWith("Untitled", node({ id: "a", x: 10, y: 20, width: 30, height: 40 })));
    const d1 = deps();
    await runExport({ format: "svg", scope: "page", scale: 1 }, d1);
    const first = await d1.saved[0].blob.text();

    // Same scene, completely different view (scrolled and zoomed).
    useScene.setState({ camera: { x: -3000, y: 812.5, zoom: 7.5 } });
    const d2 = deps();
    await runExport({ format: "svg", scope: "page", scale: 1 }, d2);
    expect(await d2.saved[0].blob.text()).toBe(first);
  });

  it("text that overflows its box stays INSIDE the viewBox", async () => {
    // The viewBox is the file's crop: the SVG root hides everything that
    // stays outside it. With the height of the model's box (19.2) the second row's
    // tspans would still be written in the file, and still invisible
    // -- an export that looks successful and has lost half the text.
    install(sceneWith("Untitled", overflowingText("t")));
    const d = deps();
    await runExport({ format: "svg", scope: "page", scale: 1 }, d);
    const text = await d.saved[0].blob.text();
    expect(text).toContain('viewBox="0 0 100 38.4"');
    expect(text).toContain('height="38.4"');
    // the two lines, both above the viewBox's bottom edge
    expect(text).toContain('<tspan x="0" y="14.4">abcdefghij</tspan>');
    expect(text).toContain('<tspan x="0" y="33.6">klm</tspan>');
  });
});

describe("runExport — PDF", () => {
  it("downloads a real PDF sized to the region, and opens no print dialog", async () => {
    install(sceneWith("Untitled", node({ id: "a", x: 10, y: 20, width: 30, height: 40 })));
    const d = deps();
    const ok = await runExport({ format: "pdf", scope: "page", scale: 1 }, d);
    expect(ok).toBe(true);
    expect(d.saved).toHaveLength(1);
    expect(d.saved[0].filename).toBe("Untitled.pdf");
    expect(d.saved[0].blob.type).toBe("application/pdf");
    const doc = await openPdf(d.saved[0].blob);
    expect(doc.numPages).toBe(1);
    expect((await doc.getPage(1)).view).toEqual([0, 0, 22.5, 30]); // 30 x 40 px at 0.75 pt
  });

  it("keeps text as text", async () => {
    install(sceneWith("Untitled", overflowingText("t")));
    const d = deps();
    await runExport({ format: "pdf", scope: "page", scale: 1 }, d);
    expect(await textOf(await openPdf(d.saved[0].blob), 1)).toContain("abcdefghij");
  });
});

describe("runExport — PNG", () => {
  it("goes through the offscreen canvas and delivers the PNG bytes", async () => {
    install(sceneWith("Untitled", node({ id: "a", width: 30, height: 40 })));
    const d = deps();
    const canvases: HTMLCanvasElement[] = [];
    d.createCanvas = () => { const c = fakeCanvas(); canvases.push(c); return c; };
    await expect(runExport({ format: "png", scope: "page", scale: 2 }, d)).resolves.toBe(true);
    expect(d.saved[0].filename).toBe("Untitled@2x.png");
    expect(d.saved[0].blob.type).toBe("image/png");
    // the canvas is the region's for the chosen scale
    expect(canvases.at(-1)!.width).toBe(60);
    expect(canvases.at(-1)!.height).toBe(80);
  });

  it("an image beyond the canvas cap becomes a WARNING, not a blank PNG", async () => {
    // 6000×6000 units at 3x = 324 Mpx: beyond the canvas maximum. The browser
    // would not say so -- Chrome returns a context that does not draw and toBlob
    // produces a valid, empty PNG -- so the app must say it, and says it
    // through the same channel as every other failed export.
    install(sceneWith("Untitled", node({ id: "a", x: 0, y: 0, width: 6000, height: 6000 })));
    const d = deps();
    await expect(runExport({ format: "png", scope: "page", scale: 3 }, d)).resolves.toBe(false);
    expect(d.saved).toHaveLength(0);
    expect(useScene.getState().notice).toMatch(/too large/i);

    // ...and the same region at 1x, or as SVG, comes out fine: the cap
    // belongs to the canvas, not to the document.
    await expect(runExport({ format: "png", scope: "page", scale: 1 }, d)).resolves.toBe(true);
    await expect(runExport({ format: "svg", scope: "page", scale: 3 }, d)).resolves.toBe(true);
  });

  it("the canvas is as tall as the painted text, even without an injected measure", async () => {
    // No `measure` in the deps: runExport builds the measure from the
    // canvas, and it serves the PNG as much as the SVG -- it is what says how tall
    // the offscreen canvas must be. Without it, the PNG would come out 20 px
    // tall (the box) instead of 39 (the two lines) and would crop the second.
    install(sceneWith("Untitled", overflowingText("t")));
    const d = deps();
    d.measure = undefined;
    const canvases: HTMLCanvasElement[] = [];
    d.createCanvas = () => { const c = fakeCanvas(); canvases.push(c); return c; };
    await expect(runExport({ format: "png", scope: "page", scale: 1 }, d)).resolves.toBe(true);
    expect(canvases.at(-1)!.width).toBe(100);
    expect(canvases.at(-1)!.height).toBe(39); // ceil(38.4)
  });

  it("without a 2D context the export SAYS so, instead of blowing up", async () => {
    // The text measure is built from a canvas, and now it is needed even before
    // knowing how big the region is: if that canvas gives no context,
    // the reason must come out through the same channel as every other failed export.
    install(sceneWith("Untitled", node({ id: "a" })));
    const d = deps();
    d.measure = undefined;
    d.createCanvas = () => ({ getContext: () => null }) as unknown as HTMLCanvasElement;
    await expect(runExport({ format: "png", scope: "page", scale: 1 }, d)).resolves.toBe(false);
    expect(d.saved).toHaveLength(0);
    expect(useScene.getState().notice).toMatch(/2D context/i);
  });

  it("at 1x the file name carries no scale suffix", async () => {
    install(sceneWith("Untitled", node({ id: "a" })));
    const d = deps();
    await runExport({ format: "png", scope: "page", scale: 1 }, d);
    expect(d.saved[0].filename).toBe("Untitled.png");
  });
});

describe("runExport — when there is nothing to export", () => {
  it("no document: downloads nothing", async () => {
    install(null);
    const d = deps();
    await expect(runExport({ format: "svg", scope: "page", scale: 1 }, d)).resolves.toBe(false);
    expect(d.saved).toHaveLength(0);
  });

  it("empty selection: SAYS so instead of downloading an empty file", async () => {
    install(sceneWith("Untitled", node({ id: "a" })), []);
    const d = deps();
    await expect(runExport({ format: "svg", scope: "selection", scale: 1 }, d)).resolves.toBe(false);
    expect(d.saved).toHaveLength(0);
    expect(useScene.getState().notice).toMatch(/select/i);
  });

  it("empty page: same treatment", async () => {
    install(sceneWith("Untitled"), []);
    const d = deps();
    await expect(runExport({ format: "png", scope: "page", scale: 1 }, d)).resolves.toBe(false);
    expect(useScene.getState().notice).toBeTruthy();
  });

  it("an error during the export becomes a warning, not an exception in the air", async () => {
    install(sceneWith("Untitled", node({ id: "a" })));
    const d = deps();
    d.toPngBlob = async () => { throw new Error("encoding failed"); };
    await expect(runExport({ format: "png", scope: "page", scale: 1 }, d)).resolves.toBe(false);
    expect(d.saved).toHaveLength(0);
    expect(useScene.getState().notice).toContain("encoding failed");
  });
});

describe("exportFileName", () => {
  it("starts from the document name", () => {
    expect(exportFileName("My poster", { format: "svg", scope: "page", scale: 1 })).toBe("My poster.svg");
  });

  it("removes the characters a file system does not accept", () => {
    // \ / : * ? " < > | cannot be in a file name on Windows, and a
    // document can be named however it likes.
    expect(exportFileName('a/b\\c:d*e?f"g<h>i|j', { format: "png", scope: "page", scale: 1 }))
      .toBe("a-b-c-d-e-f-g-h-i-j.png");
  });

  it("an empty name (or one made of only removed characters) falls back to a good name", () => {
    expect(exportFileName("", { format: "png", scope: "page", scale: 1 })).toBe("opendesigner.png");
    expect(exportFileName("///", { format: "svg", scope: "page", scale: 1 })).toBe("opendesigner.svg");
  });

  it("scale and scope appear in the name", () => {
    expect(exportFileName("Doc", { format: "png", scope: "selection", scale: 3 })).toBe("Doc-selection@3x.png");
  });
});

describe("downloadBlob", () => {
  it("creates a URL, clicks an <a download> and then revokes it", () => {
    const created: Blob[] = [];
    const revoked: string[] = [];
    vi.stubGlobal("URL", {
      createObjectURL: (b: Blob) => { created.push(b); return "blob:fake"; },
      revokeObjectURL: (u: string) => { revoked.push(u); },
    });
    vi.useFakeTimers();
    const blob = new Blob(["x"]);
    let clicked: HTMLAnchorElement | null = null;
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) { clicked = this; });

    downloadBlob(blob, "prova.svg");

    expect(created).toEqual([blob]);
    expect(click).toHaveBeenCalledOnce();
    expect(clicked!.download).toBe("prova.svg");
    expect(clicked!.href).toContain("blob:fake");
    // the anchor does not stay hanging in the document
    expect(document.querySelector("a[download]")).toBeNull();
    // the URL is revoked AFTER the click, not before: revoking it right away cancels the
    // download in some browsers.
    expect(revoked).toEqual([]);
    vi.runAllTimers();
    expect(revoked).toEqual(["blob:fake"]);

    click.mockRestore();
    vi.useRealTimers();
  });
});

// --- images in the export (track 3) ------------------------------------------

function imageNode(id: string, hash: string): NodeLite {
  return node({ id, kind: "image", x: 0, y: 0, width: 200, height: 100, image: { assetHash: hash } });
}

describe("runExport — images", () => {
  it("the SVG EMBEDS the bytes as a data URI, not a link to the local server", async () => {
    // An href to /assets-api/... would be broken as soon as the file leaves this
    // machine, that is as soon as it is useful for anything.
    install(sceneWith("Untitled", imageNode("i", "abc")));
    const d = { ...deps(), loadAssetDataUrl: async () => "data:image/png;base64,QUJD" };
    await expect(runExport({ format: "svg", scope: "page", scale: 1 }, d)).resolves.toBe(true);
    const text = await d.saved[0].blob.text();
    expect(text).toContain("<image");
    expect(text).toContain("data:image/png;base64,QUJD");
    expect(text).not.toContain("/assets-api/");
  });

  it("asks for the bytes ONCE per hash, even with the same asset repeated", async () => {
    install(sceneWith("Untitled",
      imageNode("i1", "abc"),
      node({ ...imageNode("i2", "abc"), id: "i2", orderKey: "a2", x: 300 }),
      node({ ...imageNode("i3", "def"), id: "i3", orderKey: "a3", x: 600 }),
    ));
    const asked: string[] = [];
    const d = {
      ...deps(),
      loadAssetDataUrl: async (_docId: string, hash: string) => {
        asked.push(hash);
        return `data:image/png;base64,${hash}`;
      },
    };
    await runExport({ format: "svg", scope: "page", scale: 1 }, d);
    expect(asked.sort()).toEqual(["abc", "def"]);
  });

  it("an unreachable asset does not fail the export: the placeholder comes out, and the user KNOWS", async () => {
    install(sceneWith("Untitled", imageNode("i", "abc")));
    const d = { ...deps(), loadAssetDataUrl: async () => { throw new Error("404"); } };
    await expect(runExport({ format: "svg", scope: "page", scale: 1 }, d)).resolves.toBe(true);
    const text = await d.saved[0].blob.text();
    expect(text).not.toContain("<image");
    expect(text).toContain("<path");
    // The export succeeded -- the document really contains a broken
    // reference, and the file shows it instead of not existing -- but a file delivered
    // with holes in place of photographs cannot come out silently.
    expect(useScene.getState().notice).toMatch(/one image was not included/);
  });

  it("an export without holes leaves no warning", async () => {
    install(sceneWith("Untitled", imageNode("i", "abc")));
    const d = { ...deps(), loadAssetDataUrl: async () => "data:image/png;base64,QUJD" };
    await runExport({ format: "svg", scope: "page", scale: 1 }, d);
    expect(useScene.getState().notice).toBeNull();
  });

  it("the warning counts the NODES that remain placeholders, empty hash included", async () => {
    install(sceneWith("Untitled",
      imageNode("i1", "abc"),
      node({ ...imageNode("i2", ""), id: "i2", orderKey: "a2", x: 300 }),
    ));
    const d = { ...deps(), loadAssetDataUrl: async () => null };
    await runExport({ format: "svg", scope: "page", scale: 1 }, d);
    // The node with the empty hash has nothing to ask for and does not ask, but
    // in the file it is a hole exactly like the other.
    expect(useScene.getState().notice).toMatch(/^2 images were not included/);
  });

  it("the region accounts for the image box", async () => {
    install(sceneWith("Untitled", imageNode("i", "abc")));
    const d = { ...deps(), loadAssetDataUrl: async () => null };
    await runExport({ format: "svg", scope: "page", scale: 1 }, d);
    const text = await d.saved[0].blob.text();
    expect(text).toContain('viewBox="0 0 200 100"');
  });
});

// --- the PNG WAITS for the images --------------------------------------------
//
// The defect these tests close: the PNG went through `drawScene` with the
// default source, that is the renderer's MUTABLE cache, and waited for
// nothing. Opening a document and exporting right away gave a file with placeholders;
// exporting a second later gave the photographs. Same document, two files, and
// no warning -- moreover in disagreement with the SVG of the same document,
// which has always re-downloaded the bytes.

const PIXEL = { naturalWidth: 4, naturalHeight: 4 } as unknown as HTMLImageElement;

describe("runExport — PNG and images", () => {
  it("asks for the bytes, decodes them and AWAITS them before drawing", async () => {
    install(sceneWith("Untitled", imageNode("i", "abc")));
    const asked: string[] = [];
    const decoded: string[] = [];
    const d = {
      ...deps(),
      loadAssetDataUrl: async (_doc: string, hash: string) => { asked.push(hash); return `data:image/png;base64,${hash}`; },
      decodeImage: async (uri: string) => { decoded.push(uri); return PIXEL; },
    };
    await expect(runExport({ format: "png", scope: "page", scale: 1 }, d)).resolves.toBe(true);
    expect(asked).toEqual(["abc"]);
    expect(decoded).toEqual(["data:image/png;base64,abc"]);
    // The real pixels ended up on the canvas, and no placeholder with them.
    expect(drawn).toEqual([PIXEL]);
    expect(crosses).toBe(0);
    expect(useScene.getState().notice).toBeNull();
  });

  it("does NOT read the renderer's cache: two exports of the same document give the same file", async () => {
    // The shared cache fills itself while the user looks at the screen: if
    // the export read it, the file would depend on how long the document has been
    // open. Here the source is local to the export, so the first export and the
    // second draw exactly the same things.
    install(sceneWith("Untitled", imageNode("i", "abc")));
    const d = {
      ...deps(),
      loadAssetDataUrl: async () => "data:image/png;base64,QUJD",
      decodeImage: async () => PIXEL,
    };
    await runExport({ format: "png", scope: "page", scale: 1 }, d);
    const first = [...drawn];
    drawn = [];
    await runExport({ format: "png", scope: "page", scale: 1 }, d);
    expect(drawn).toEqual(first);
    expect(drawn).toEqual([PIXEL]);
  });

  it("asks for and decodes ONCE per hash, even with the same asset repeated", async () => {
    install(sceneWith("Untitled",
      imageNode("i1", "abc"),
      node({ ...imageNode("i2", "abc"), id: "i2", orderKey: "a2", x: 300 }),
    ));
    const asked: string[] = [];
    const decode = vi.fn(async () => PIXEL);
    const d = {
      ...deps(),
      loadAssetDataUrl: async (_doc: string, hash: string) => { asked.push(hash); return "data:x"; },
      decodeImage: decode,
    };
    await runExport({ format: "png", scope: "page", scale: 1 }, d);
    expect(asked).toEqual(["abc"]);
    expect(decode).toHaveBeenCalledTimes(1);
    // A single asset, but drawn on both nodes.
    expect(drawn).toEqual([PIXEL, PIXEL]);
  });

  it("an unreachable asset becomes the placeholder, and the export SAYS so", async () => {
    install(sceneWith("Untitled", imageNode("i", "abc")));
    const d = { ...deps(), loadAssetDataUrl: async () => null, decodeImage: async () => PIXEL };
    await expect(runExport({ format: "png", scope: "page", scale: 1 }, d)).resolves.toBe(true);
    expect(drawn).toEqual([]);
    expect(crosses).toBe(1); // the placeholder's cross, not an image
    expect(useScene.getState().notice).toMatch(/one image was not included/);
  });

  it("downloaded bytes but not decodable: placeholder and warning, not an exception", async () => {
    install(sceneWith("Untitled", imageNode("i", "abc")));
    const d = { ...deps(), loadAssetDataUrl: async () => "data:x", decodeImage: async () => null };
    await expect(runExport({ format: "png", scope: "page", scale: 1 }, d)).resolves.toBe(true);
    expect(drawn).toEqual([]);
    expect(useScene.getState().notice).toMatch(/one image was not included/);
  });

  it("the SVG does not pay for decoding: the bytes are enough for it", async () => {
    install(sceneWith("Untitled", imageNode("i", "abc")));
    const decode = vi.fn(async () => PIXEL);
    const d = { ...deps(), loadAssetDataUrl: async () => "data:x", decodeImage: decode };
    await runExport({ format: "svg", scope: "page", scale: 1 }, d);
    expect(decode).not.toHaveBeenCalled();
  });

  it("PNG and SVG of the same document agree on what is missing", async () => {
    // They used to be two different paths: the SVG re-downloaded the bytes, the PNG
    // read the cache. The same document could come out with the image in one
    // format and with the placeholder in the other.
    install(sceneWith("Untitled", imageNode("i", "abc")));
    const d = { ...deps(), loadAssetDataUrl: async () => null, decodeImage: async () => PIXEL };
    await runExport({ format: "png", scope: "page", scale: 1 }, d);
    const pngNotice = useScene.getState().notice;
    useScene.setState({ notice: null });
    await runExport({ format: "svg", scope: "page", scale: 1 }, d);
    expect(useScene.getState().notice).toBe(pngNotice);
    expect(await d.saved[1].blob.text()).not.toContain("<image");
    expect(crosses).toBe(1); // the PNG drew the same cross
  });
});

describe("runDocumentExport", () => {
  const fakeDeps = (): DocumentExportDeps & { saved: { blob: Blob; filename: string }[] } => {
    const saved: { blob: Blob; filename: string }[] = [];
    return {
      saved,
      measure: (s) => s.length * 10,
      download: (blob, filename) => { saved.push({ blob, filename }); },
      now: () => new Date("2026-01-01T00:00:00Z"),
    };
  };

  function twoPages(): SceneState {
    const s = sceneWith("Book", node({ id: "a", parentId: "page1", width: 100, height: 50 }), node({ id: "b", parentId: "p2", width: 30, height: 40 }));
    s.pages = [...s.pages, { id: "p2", name: "Second" }];
    return s;
  }

  it("writes every non-empty page with its own size", async () => {
    install(twoPages());
    const d = fakeDeps();
    expect(await runDocumentExport("pdf", d)).toBe(true);
    expect(d.saved[0].filename).toBe("Book.pdf");
    const doc = await openPdf(d.saved[0].blob);
    expect(doc.numPages).toBe(2);
    expect((await (await doc.getPage(1)).view)).toEqual([0, 0, 75, 37.5]);
    expect((await (await doc.getPage(2)).view)).toEqual([0, 0, 22.5, 30]);
  });

  it("downloads an EPUB with one spine item per page", async () => {
    install(twoPages());
    const d = fakeDeps();
    expect(await runDocumentExport("epub", d)).toBe(true);
    expect(d.saved[0].filename).toBe("Book.epub");
    const text = new TextDecoder().decode(new Uint8Array(await d.saved[0].blob.arrayBuffer()));
    expect(text).toContain("page-001.xhtml");
    expect(text).toContain("page-002.xhtml");
    expect(text).toContain("Second");
  });

  it("imposes a booklet: sheet sides of two pages, blanks padded in", async () => {
    install(twoPages());
    const sc = useScene.getState().scene!;
    useScene.getState().setScene({ ...sc, pages: sc.pages.map((p) => ({ ...p, width: 100, height: 50 })) });
    const d = fakeDeps();
    expect(await runDocumentExport("pdf", d, { booklet: true })).toBe(true);
    const doc = await openPdf(d.saved[0].blob);
    // 2 pages -> padded to 4 -> two sheet sides: (blank | 1) and (2 | blank)
    expect(doc.numPages).toBe(2);
    const widths = [(await doc.getPage(1)).view[2], (await doc.getPage(2)).view[2]];
    expect(widths).toEqual([150, 150]); // two pages of 100 px = 75 pt, side by side
  });

  it("downloads one HTML file with a section per page", async () => {
    install(twoPages());
    const d = fakeDeps();
    expect(await runDocumentExport("html", d)).toBe(true);
    expect(d.saved[0].filename).toBe("Book.html");
    const html = await d.saved[0].blob.text();
    expect(html).toContain("<!doctype html>");
    expect(html).toContain('id="page-1"');
    expect(html).toContain('id="page-2"');
    expect(html).toContain("Second");
  });

  it("downloads a PowerPoint deck and an IDML package, saying what they leave out", async () => {
    install(twoPages());
    const d = fakeDeps();
    expect(await runDocumentExport("pptx", d)).toBe(true);
    expect(d.saved[0].filename).toBe("Book.pptx");
    expect(useScene.getState().notice).toMatch(/slides?\)?\. Effects/);
    expect(await runDocumentExport("idml", d)).toBe(true);
    expect(d.saved[1].filename).toBe("Book.idml");
    expect(useScene.getState().notice).toMatch(/IDML written/);
    const bytes = new Uint8Array(await d.saved[1].blob.arrayBuffer());
    expect(new TextDecoder().decode(bytes.subarray(30, 30 + 8))).toBe("mimetype");
  });

  it("skips empty pages and refuses an entirely empty document", async () => {
    const empty = sceneWith("E");
    install(empty);
    const d = fakeDeps();
    expect(await runDocumentExport("epub", d)).toBe(false);
    expect(useScene.getState().notice).toMatch(/every page is empty/);
    expect(d.saved).toHaveLength(0);
  });
});

function fakeDeps2(): DocumentExportDeps & { saved: { blob: Blob; filename: string }[] } {
  const saved: { blob: Blob; filename: string }[] = [];
  return { saved, measure: (s) => s.length * 10, download: (blob, filename) => { saved.push({ blob, filename }); } };
}

describe("master pages in the export", () => {
  it("draws a master's content on each page that applies it and skips the master itself", async () => {
    const s = sceneWith("Book",
      node({ id: "body", parentId: "page1", x: 100, y: 100, width: 20, height: 20 }),
      node({ id: "band", parentId: "m1", x: 0, y: 0, width: 400, height: 10 }),
      node({ id: "n", parentId: "m1", kind: "text", x: 0, y: 20, width: 100, height: 20, text: { content: "No. <#>", style: { fontFamily: "", fontSize: 16, fontWeight: "", lineHeight: 0, align: "left" } } }),
      node({ id: "b2", parentId: "p2", x: 0, y: 0, width: 5, height: 5 }),
    );
    s.pages = [{ id: "page1", name: "One", masterId: "m1" }, { id: "m1", name: "A-Master", isMaster: true }, { id: "p2", name: "Two", masterId: "m1" }];
    install(s);
    const d = fakeDeps2();
    expect(await runDocumentExport("pdf", d)).toBe(true);
    // Two output pages (the master is not one), each with the master's band at width 400.
    const doc = await openPdf(d.saved[0].blob);
    expect(doc.numPages).toBe(2);
    expect((await doc.getPage(1)).view[2]).toBe(300); // 400 px
    expect(await textOf(doc, 1)).toContain("No. 1");
    expect(await textOf(doc, 2)).toContain("No. 2");
  });

  it("exports only the page on screen, master content included", async () => {
    const s = sceneWith("Book",
      node({ id: "a", parentId: "page1", width: 10, height: 10 }),
      node({ id: "other", parentId: "p2", x: 500, y: 500, width: 10, height: 10 }),
    );
    s.pages = [{ id: "page1", name: "One" }, { id: "p2", name: "Two" }];
    install(s);
    useScene.setState({ currentPageId: "page1" });
    const d = deps();
    await runExport({ format: "svg", scope: "page", scale: 1 }, d);
    const svg = await d.saved[0].blob.text();
    expect(svg).toContain('width="10"');
    expect(svg).not.toContain("510");
  });
});

describe("threaded text frames in the export", () => {
  it("exports each frame with the part of the story that flows into it", async () => {
    const style = { fontFamily: "", fontSize: 16, fontWeight: "", lineHeight: 1.25, align: "left" as const };
    const a = node({ id: "A", kind: "text", x: 0, y: 0, width: 100, height: 20, meta: { "text.next": "B" }, text: { content: "aaaa bbbb cccc dddd", style } });
    const b = node({ id: "B", kind: "text", x: 200, y: 0, width: 100, height: 40, text: { content: "", style } });
    install(sceneWith("Story", a, b));
    const d = deps();
    expect(await runExport({ format: "svg", scope: "page", scale: 1 }, d)).toBe(true);
    const svg = await d.saved[0].blob.text();
    expect(svg).toContain(">aaaa bbbb<");
    expect(svg).toContain(">cccc dddd<");
  });
});

describe("sized pages in the export", () => {
  function sheetScene(): SceneState {
    const s = sceneWith("Book", node({ id: "a", parentId: "page1", x: 50, y: 60, width: 10, height: 10 }), node({ id: "off", parentId: "page1", x: 900, y: 900, width: 10, height: 10 }));
    s.pages = [{ id: "page1", name: "One", width: 400, height: 600, bleed: 9 }, { id: "p2", name: "Empty sheet", width: 400, height: 600, bleed: 9 }, { id: "free", name: "Free" }];
    return s;
  }

  it("exports a sized page as its sheet, cropping what lies outside and not its bounding box", async () => {
    install(sheetScene());
    useScene.setState({ currentPageId: "page1" });
    const d = deps();
    expect(await runExport({ format: "svg", scope: "page", scale: 1 }, d)).toBe(true);
    const svg = await d.saved[0].blob.text();
    expect(svg).toContain('viewBox="0 0 400 600"');
  });

  it("keeps an empty sheet as a page of the document export, and adds the bleed for print", async () => {
    install(sheetScene());
    const d = fakeDeps2();
    expect(await runDocumentExport("pdf", d)).toBe(true);
    // Two sheets (the empty one counts); the unbounded page is empty and is left out.
    const plain = await openPdf(d.saved[0].blob);
    expect(plain.numPages).toBe(2);
    expect((await plain.getPage(1)).view).toEqual([0, 0, 300, 450]);
    expect(await runDocumentExport("pdf", d, { bleed: true })).toBe(true);
    const bled = await openPdf(d.saved[1].blob);
    expect((await bled.getPage(1)).view).toEqual([0, 0, 313.5, 463.5]); // 418 x 618 px
    const raw = Buffer.from(await d.saved[1].blob.arrayBuffer()).toString("latin1");
    expect(raw).toContain("/TrimBox[6.75 6.75 306.75 456.75]");
  });
});

describe("runPackage", () => {
  it("zips the PDF, the uploaded fonts, the placed images and a report", async () => {
    const s = sceneWith("Print job", node({ id: "a", parentId: "page1", width: 100, height: 50 }), node({ id: "im", parentId: "page1", kind: "image", x: 0, y: 60, width: 40, height: 40, image: { assetHash: "h1", originalName: "photo.png" } } as Partial<NodeLite> & { id: string }));
    s.fonts = { f1: { id: "f1", family: "Acme Sans", weight: "700", style: "normal", assetHash: "fh" } };
    install(s);
    const saved: { blob: Blob; filename: string }[] = [];
    const bytes = (b: number[]) => `data:application/octet-stream;base64,${btoa(String.fromCharCode(...b))}`;
    const ok = await runPackage({
      measure: (t) => t.length * 10, download: (blob, filename) => { saved.push({ blob, filename }); },
      loadAssetDataUrl: async (_d, hash) => (hash === "fh" ? bytes([0, 1, 0, 0, 9, 9, 9, 9, 9, 9, 9, 9]) : hash === "h1" ? bytes([1, 2, 3]) : null),
      now: () => new Date("2026-01-01T00:00:00Z"),
    });
    expect(ok).toBe(true);
    expect(saved[0].filename).toBe("Print job-package.zip");
    const raw = Buffer.from(await saved[0].blob.arrayBuffer()).toString("latin1");
    for (const name of ["Print job/Print job.pdf", "Print job/Fonts/Acme Sans-700.ttf", "Print job/Links/photo.png", "Print job/Report.txt"]) expect(raw).toContain(name);
    const utf8 = Buffer.from(await saved[0].blob.arrayBuffer()).toString("utf8");
    expect(utf8).toContain("Acme Sans 700 → Fonts/Acme Sans-700.ttf");
    expect(utf8).toContain("photo.png → Links/photo.png");
  });

  it("says what could not be packed", async () => {
    install(sceneWith("P", node({ id: "a", parentId: "page1", width: 100, height: 50 }), node({ id: "im", parentId: "page1", kind: "image", y: 60, image: { assetHash: "gone" } } as Partial<NodeLite> & { id: string })));
    const saved: unknown[] = [];
    await runPackage({ measure: (t) => t.length * 10, download: (b) => { saved.push(b); }, loadAssetDataUrl: async () => null });
    expect(useScene.getState().notice).toMatch(/Package written without: image gone/);
  });
});
