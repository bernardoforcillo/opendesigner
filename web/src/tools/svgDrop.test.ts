import { describe, it, expect, beforeEach, vi } from "vitest";
import { useScene } from "../store/store";
import { emptyScene, type NodeLite } from "../store/types";
import { STACK_OFFSET, attachImageDrop, dropImages, type ImageDropDeps } from "./imageDrop";

// Dropping an SVG file onto the canvas: editable nodes, not a raster image.
// (The rest of the drop -- PNG/JPEG/GIF/WebP -- is in imageDrop.test.ts.)

const HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50" width="100" height="50"><rect id="r" width="40" height="20"/><circle id="c" cx="70" cy="25" r="10"/></svg>`;

function installScene(): void {
  useScene.setState({ gesture: null, lastError: null, notice: null, selection: [] });
  useScene.getState().setScene(emptyScene("doc-1", "Untitled"));
}

function nodes(): NodeLite[] {
  const s = useScene.getState().scene;
  return s ? [...s.nodes.values()] : [];
}

function deps(over: Partial<ImageDropDeps> = {}): ImageDropDeps {
  return {
    measure: async () => ({ width: 200, height: 100 }),
    upload: async () => ({ hash: HASH, size: 1234, contentType: "image/png" }),
    ...over,
  };
}

const svgFile = (name = "logo.svg", type = "image/svg+xml") => new File([SVG], name, { type });
const pngFile = (name = "a.png") => ({ name, type: "image/png", size: 10 }) as unknown as File;

describe("dropping an SVG file", () => {
  beforeEach(installScene);

  it("becomes a group of editable nodes centered on the point, without going through measure and upload", async () => {
    const measure = vi.fn(async () => ({ width: 1, height: 1 }));
    const upload = vi.fn(async () => ({ hash: HASH, size: 1, contentType: "image/png" }));
    const ids = await dropImages([svgFile()], { x: 500, y: 300 }, deps({ measure, upload }));

    expect(measure).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    expect(ids.length).toBe(1);
    const ns = nodes();
    expect(ns.map((n) => n.kind).sort()).toEqual(["ellipse", "group", "rect"]);
    expect(ns.find((n) => n.kind === "image")).toBeUndefined();
    const root = ns.find((n) => n.id === ids[0])!;
    // 100x50 centered on (500,300)
    expect(root).toMatchObject({ kind: "group", name: "logo", x: 450, y: 275 });
    expect(useScene.getState().selection).toEqual([ids[0]]);
    expect(useScene.getState().notice).toBe("Imported as 3 layers");
  });

  it("also with an empty type (extension only) and with an uppercase .SVG", async () => {
    const ids = await dropImages([svgFile("A.SVG", "")], { x: 0, y: 0 }, deps());
    expect(ids.length).toBe(1);
    expect(nodes().some((n) => n.kind === "group")).toBe(true);
  });

  it("one drop = one undo", async () => {
    await dropImages([svgFile()], { x: 0, y: 0 }, deps());
    expect(nodes().length).toBe(3);
    useScene.getState().undo();
    expect(nodes().length).toBe(0);
  });

  it("together with a PNG: the SVG becomes nodes and the PNG takes the usual path", async () => {
    const upload = vi.fn(async () => ({ hash: HASH, size: 1, contentType: "image/png" }));
    const ids = await dropImages([pngFile(), svgFile()], { x: 0, y: 0 }, deps({ upload }));
    expect(upload).toHaveBeenCalledTimes(1);
    expect(ids.length).toBe(2);
    expect(nodes().filter((n) => n.kind === "image").length).toBe(1);
    expect(nodes().filter((n) => n.kind === "group").length).toBe(1);
  });

  it("several SVGs: each its own group, offset by STACK_OFFSET", async () => {
    const ids = await dropImages([svgFile("a.svg"), svgFile("b.svg")], { x: 0, y: 0 }, deps());
    expect(ids.length).toBe(2);
    const [a, b] = ids.map((id) => nodes().find((n) => n.id === id)!);
    expect(b.x - a.x).toBe(STACK_OFFSET);
    expect(b.y - a.y).toBe(STACK_OFFSET);
  });

  it("a broken SVG does not throw away the drop: notice and no node", async () => {
    const ids = await dropImages([new File(["<svg><rect></svg>"], "broken.svg", { type: "image/svg+xml" })], { x: 0, y: 0 }, deps());
    expect(ids).toEqual([]);
    expect(nodes().length).toBe(0);
    expect(useScene.getState().notice).toMatch(/SVG import failed/);
  });

  it("the canvas listener intercepts it: preventDefault and import at the point in world coordinates", async () => {
    const handlers: Record<string, (e: Event) => void> = {};
    attachImageDrop(
      { addEventListener: (t, h) => { handlers[t] = h; }, removeEventListener: () => {} },
      () => ({ x: 200, y: 100 }),
      deps(),
    );
    const drop = { preventDefault: vi.fn(), dataTransfer: { files: [svgFile()], types: ["Files"] } };
    handlers.drop(drop as unknown as Event);
    expect(drop.preventDefault).toHaveBeenCalled();
    await vi.waitFor(() => expect(nodes().length).toBe(3));
    expect(nodes().find((n) => n.kind === "group")).toMatchObject({ x: 150, y: 75 });
  });
});
