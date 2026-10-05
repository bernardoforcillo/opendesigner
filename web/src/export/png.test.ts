import { describe, it, expect, afterEach, vi } from "vitest";
import {
  renderRegionToCanvas,
  canvasToPngBlob,
  canvasLimitMessage,
  EXPORT_SCALES,
  MAX_CANVAS_SIDE,
  MAX_CANVAS_AREA,
} from "./png";
import { exportRegion } from "./region";
import { emptyScene } from "../store/types";
import type { NodeLite, SceneState } from "../store/types";

// jsdom has neither a 2D context nor Path2D: the canvas is a double that RECORDS
// instead of drawing. It is exactly what is needed here -- the pixel proof is in
// the browser, what can be done in Node is that the offscreen canvas is
// as large as it must be and transformed as it must be.
class FakePath2D {
  rect() {}
  roundRect() {}
  ellipse() {}
}

interface Recorded {
  transforms: number[][];
  fills: number;
  texts: string[];
}

function fakeCanvas(): { canvas: HTMLCanvasElement; rec: Recorded } {
  const rec: Recorded = { transforms: [], fills: 0, texts: [] };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ctx,
  } as unknown as HTMLCanvasElement;
  const ctx = {
    canvas,
    font: "", textBaseline: "", textAlign: "", fillStyle: "", globalAlpha: 1,
    setTransform: (a: number, b: number, c: number, d: number, e: number, f: number) => {
      rec.transforms.push([a, b, c, d, e, f]);
    },
    clearRect: () => {},
    measureText: (s: string) => ({ width: s.length * 10 }),
    fillText: (t: string) => { rec.texts.push(t); },
    fill: () => { rec.fills++; },
  } as unknown as CanvasRenderingContext2D;
  return { canvas, rec };
}

function node(over: Partial<NodeLite> & { id: string }): NodeLite {
  return {
    parentId: "page1", orderKey: "a1", name: over.id, visible: true, opacity: 1,
    x: 0, y: 0, width: 10, height: 10, rotation: 0,
    fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false,
    ...over,
  };
}

function sceneWith(...nodes: NodeLite[]): SceneState {
  const s = emptyScene("doc", "Untitled");
  for (const n of nodes) s.nodes = s.nodes.set(n.id, n);
  return s;
}

// The same fake measure as the ctx above (10 units per character): the
// region uses it to know how tall the text is, hence how tall the
// canvas must be.
const measure = (s: string) => s.length * 10;

function regionOf(scene: SceneState, selection: string[] = [], scope: "page" | "selection" = "page") {
  const r = exportRegion(scene, selection, scope, measure);
  if (!r) throw new Error("empty region in the test");
  return r;
}

// The LAST setTransform is the one used to draw (the first resets before
// clearing the canvas).
//
// `+ 0` normalizes NEGATIVE zero: a region starting at x = 0 produces a
// -0 translation, which for the canvas is the same translation as 0 but which
// toEqual distinguishes (it compares with Object.is). The sign of zero is not
// information, and must not become a reason to contort the code that
// computes the transform.
function drawTransform(rec: Recorded): number[] {
  return rec.transforms[rec.transforms.length - 1].map((v) => v + 0);
}

describe("renderRegionToCanvas", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("the offscreen canvas is as large as the region for the scale", () => {
    vi.stubGlobal("Path2D", FakePath2D);
    const region = regionOf(sceneWith(node({ id: "a", x: 10, y: 20, width: 100, height: 50 })));
    const { canvas } = fakeCanvas();
    renderRegionToCanvas(region, 2, () => canvas);
    expect(canvas.width).toBe(200);
    expect(canvas.height).toBe(100);
  });

  it("the transform brings the region's CORNER to the origin, scaled", () => {
    vi.stubGlobal("Path2D", FakePath2D);
    const region = regionOf(sceneWith(node({ id: "a", x: 10, y: 20, width: 100, height: 50 })));
    const { canvas, rec } = fakeCanvas();
    renderRegionToCanvas(region, 2, () => canvas);
    // scale 2, and the translation is -origin * scale: the image's
    // pixel (0,0) is the world point (10, 20).
    expect(drawTransform(rec)).toEqual([2, 0, 0, 2, -20, -40]);
  });

  it("each of the offered scales", () => {
    vi.stubGlobal("Path2D", FakePath2D);
    const region = regionOf(sceneWith(node({ id: "a", x: 0, y: 0, width: 30, height: 40 })));
    for (const scale of EXPORT_SCALES) {
      const { canvas, rec } = fakeCanvas();
      renderRegionToCanvas(region, scale, () => canvas);
      expect(canvas.width).toBe(30 * scale);
      expect(canvas.height).toBe(40 * scale);
      expect(drawTransform(rec)).toEqual([scale, 0, 0, scale, 0, 0]);
    }
  });

  it("the machine's devicePixelRatio does NOT enter the export", () => {
    // The screen canvas scales by the dpr (canvasRenderer.ts) and must do
    // so; an offscreen canvas has no device. Without this
    // rule the same document exported at 2x would give a file twice as large
    // on a HiDPI laptop -- and cropped, because the canvas would be
    // of the requested size anyway.
    vi.stubGlobal("Path2D", FakePath2D);
    vi.stubGlobal("window", { devicePixelRatio: 3 });
    const region = regionOf(sceneWith(node({ id: "a", x: 0, y: 0, width: 100, height: 100 })));
    const { canvas, rec } = fakeCanvas();
    renderRegionToCanvas(region, 2, () => canvas);
    expect(canvas.width).toBe(200);
    expect(drawTransform(rec)).toEqual([2, 0, 0, 2, 0, 0]);
  });

  it("a fractional region is not CROPPED: it rounds up", () => {
    vi.stubGlobal("Path2D", FakePath2D);
    const region = regionOf(sceneWith(node({ id: "a", x: 0, y: 0, width: 10.2, height: 10.6 })));
    const { canvas } = fakeCanvas();
    renderRegionToCanvas(region, 1, () => canvas);
    expect(canvas.width).toBe(11);
    expect(canvas.height).toBe(11);
  });

  it("a canvas never has a zero side", () => {
    vi.stubGlobal("Path2D", FakePath2D);
    // A still-EMPTY text inside a box 0 tall: no line to measure,
    // so the region stays 0 tall -- and a canvas of null area makes
    // toBlob fail instead of producing an empty image.
    const region = regionOf(
      sceneWith(node({
        id: "t", kind: "text", width: 100, height: 0,
        text: { content: "", style: { fontFamily: "", fontSize: 16, fontWeight: "", lineHeight: 0, align: "left" } },
      })),
    );
    const { canvas } = fakeCanvas();
    renderRegionToCanvas(region, 1, () => canvas);
    expect(canvas.width).toBe(100);
    expect(canvas.height).toBe(1);
  });

  it("the canvas is as tall as the PAINTED text, not as its box", () => {
    vi.stubGlobal("Path2D", FakePath2D);
    // Two lines (10 units per character, wrap at 100) inside a box one
    // line tall: with the box height the canvas would be 20 px tall and the
    // second line would end up outside the PNG without a single warning.
    const region = regionOf(
      sceneWith(node({
        id: "t", kind: "text", x: 0, y: 0, width: 100, height: 19.2,
        text: {
          content: "abcdefghij klm",
          style: { fontFamily: "", fontSize: 16, fontWeight: "", lineHeight: 0, align: "left" },
        },
      })),
    );
    const { canvas, rec } = fakeCanvas();
    renderRegionToCanvas(region, 2, () => canvas);
    expect(canvas.width).toBe(200);
    expect(canvas.height).toBe(Math.ceil(38.4 * 2)); // 77, non 39
    // and both lines are truly there
    expect(rec.texts).toEqual(["abcdefghij", "klm"]);
  });

  it("draws ONLY the region's nodes", () => {
    vi.stubGlobal("Path2D", FakePath2D);
    const scene = sceneWith(
      node({ id: "a", orderKey: "a1" }),
      node({ id: "b", orderKey: "a2", x: 100 }),
    );
    const { canvas, rec } = fakeCanvas();
    renderRegionToCanvas(regionOf(scene, ["b"], "selection"), 1, () => canvas);
    expect(rec.fills).toBe(1);
    // and the canvas is as large as the selected node alone
    expect(canvas.width).toBe(10);
  });

  it("reuses the real renderer: a text node goes through drawText", () => {
    const scene = sceneWith(node({
      id: "t", kind: "text", x: 0, y: 0, width: 100, height: 40,
      text: { content: "ciao", style: { fontFamily: "", fontSize: 16, fontWeight: "", lineHeight: 0, align: "left" } },
    }));
    const { canvas, rec } = fakeCanvas();
    renderRegionToCanvas(regionOf(scene), 1, () => canvas);
    expect(rec.texts).toEqual(["ciao"]);
  });

  it("if the 2D context is not there, it says so instead of returning an empty canvas", () => {
    const canvas = { width: 0, height: 0, getContext: () => null } as unknown as HTMLCanvasElement;
    const region = regionOf(sceneWith(node({ id: "a" })));
    expect(() => renderRegionToCanvas(region, 1, () => canvas)).toThrow(/2D context/i);
  });

  // The null-context check above is NOT enough, and it is the reason for
  // these three tests: beyond the cap Chrome returns a regular context on a
  // bitmap that does not exist, draws into the void and produces a valid, EMPTY PNG.
  // Without the cap the user would download a white image with no
  // warning -- the worst way to fail, because it looks successful.
  it("a region beyond the AREA limit stops with a message, not with an empty PNG", () => {
    vi.stubGlobal("Path2D", FakePath2D);
    // 6000×6000 units at 3x = 18000×18000 = 324 Mpx, beyond the canvas's 268.4.
    const region = regionOf(sceneWith(node({ id: "a", x: 0, y: 0, width: 6000, height: 6000 })));
    let created = 0;
    const create = () => { created++; return fakeCanvas().canvas; };
    expect(() => renderRegionToCanvas(region, 3, create)).toThrow(/too large/i);
    // and it stops BEFORE allocating: there is no 324 Mpx canvas around.
    expect(created).toBe(0);
  });

  it("even a single SIDE beyond the limit stops, however thin the region is", () => {
    vi.stubGlobal("Path2D", FakePath2D);
    // A very long ribbon: the area is wide (327,680 px, a thousandth of the
    // cap) but the side is not, and a canvas with a side beyond the maximum is empty
    // just like one of excessive area.
    const region = regionOf(
      sceneWith(node({ id: "a", x: 0, y: 0, width: MAX_CANVAS_SIDE + 1, height: 10 })),
    );
    expect(() => renderRegionToCanvas(region, 1, () => fakeCanvas().canvas)).toThrow(/too large/i);
  });

  it("exactly at the area limit it passes: the cap is not an invented margin", () => {
    vi.stubGlobal("Path2D", FakePath2D);
    const side = Math.sqrt(MAX_CANVAS_AREA); // 16384, and no side out of range
    const region = regionOf(sceneWith(node({ id: "a", x: 0, y: 0, width: side, height: side })));
    const { canvas } = fakeCanvas();
    renderRegionToCanvas(region, 1, () => canvas);
    expect(canvas.width * canvas.height).toBe(MAX_CANVAS_AREA);
  });
});

describe("canvasLimitMessage", () => {
  it("under the two limits it has nothing to say", () => {
    expect(canvasLimitMessage(1, 1)).toBeNull();
    expect(canvasLimitMessage(16_384, 16_384)).toBeNull();
    expect(canvasLimitMessage(MAX_CANVAS_SIDE, 8_000)).toBeNull();
  });

  it("area and side are two INDEPENDENT limits, and exceeding one is enough", () => {
    // Area beyond (327 Mpx), both sides inside.
    expect(canvasLimitMessage(MAX_CANVAS_SIDE, 10_000)).toBeTruthy();
    // Side beyond, area amply inside (65,536 px).
    expect(canvasLimitMessage(MAX_CANVAS_SIDE + 1, 2)).toBeTruthy();
  });

  it("states the requested size, the limit and how to get out", () => {
    // A warning that said only "too large" would leave the user guessing
    // what to change.
    const msg = canvasLimitMessage(18000, 18000)!;
    expect(msg).toContain("18000×18000");
    expect(msg).toContain("324.0 Mpx");
    expect(msg).toContain("268.4 Mpx");
    expect(msg).toMatch(/lower scale/i);
  });
});

describe("canvasToPngBlob", () => {
  it("asks for image/png and resolves with the blob", async () => {
    const blob = new Blob(["x"], { type: "image/png" });
    const types: (string | undefined)[] = [];
    const canvas = {
      toBlob: (cb: (b: Blob | null) => void, type?: string) => { types.push(type); cb(blob); },
    } as unknown as HTMLCanvasElement;
    await expect(canvasToPngBlob(canvas)).resolves.toBe(blob);
    expect(types).toEqual(["image/png"]);
  });

  it("a null blob becomes an error, not an empty download", async () => {
    const canvas = {
      toBlob: (cb: (b: Blob | null) => void) => cb(null),
    } as unknown as HTMLCanvasElement;
    await expect(canvasToPngBlob(canvas)).rejects.toThrow();
  });
});
