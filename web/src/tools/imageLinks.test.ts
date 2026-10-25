import { afterEach, describe, expect, it } from "vitest";
import { applyOp } from "../store/applyOp";
import { useScene } from "../store/store";
import { emptyScene, type NodeLite, type SceneState } from "../store/types";
import { effectivePpi, fitImageOps, imageLinks, ppiStatus, relinkImage } from "./imageLinks";

const image = (id: string, over: Partial<NodeLite> = {}): NodeLite => ({
  id, parentId: "page1", orderKey: "a" + id, name: id, visible: true, opacity: 1, x: 0, y: 0, width: 144, height: 72, rotation: 0,
  fills: [], strokes: [], kind: "image", cornerRadius: 0, clipsContent: false,
  image: { assetHash: "a".repeat(64), originalName: "photo.jpg", pixelWidth: 1200, pixelHeight: 600 }, ...over,
});
const scene = (nodes: NodeLite[], pages = [{ id: "page1", name: "One" }, { id: "page2", name: "Two" }]): SceneState =>
  nodes.reduce((s, n) => ({ ...s, nodes: s.nodes.set(n.id, n) }), { ...emptyScene("d", "d"), pages });
const run = (s: SceneState, ops: Parameters<typeof applyOp>[1][]) => ops.reduce(applyOp, s);

describe("image links", () => {
  it("computes the effective resolution at the size placed (72 units to the inch)", () => {
    expect(effectivePpi(image("a"))).toBe(600); // 1200 px over 144 units = 2 inches
    expect(effectivePpi(image("a", { width: 1200 }))).toBe(72);
    expect(effectivePpi(image("a", { image: { assetHash: "a".repeat(64) } }))).toBeNull();
    expect(ppiStatus(72)).toBe("low");
    expect(ppiStatus(300)).toBe("ok");
    expect(ppiStatus(null)).toBe("unknown");
  });

  it("lists the images in document order with their link", () => {
    const s = scene([image("b", { parentId: "page2" }), image("a", { y: 50 }), image("c", { y: 10 }), { ...image("m"), fromMaster: true }]);
    expect(imageLinks(s).map((l) => [l.id, l.pageId])).toEqual([["c", "page1"], ["a", "page1"], ["b", "page2"]]);
    expect(imageLinks(s)[0]).toMatchObject({ originalName: "photo.jpg", pixelWidth: 1200, ppi: 600 });
  });

  it("fits an image from its pixel size", () => {
    const s = scene([image("a", { height: 10 })]);
    expect(run(s, fitImageOps(s, ["a"], "proportions")).nodes.get("a")).toMatchObject({ width: 144, height: 72 });
    expect(run(s, fitImageOps(s, ["a"], "actual")).nodes.get("a")).toMatchObject({ width: 1200, height: 600 });
    expect(run(s, fitImageOps(s, ["a"], "print")).nodes.get("a")).toMatchObject({ width: 288, height: 144 });
    const same = scene([image("a")]);
    expect(fitImageOps(same, ["a"], "proportions")).toEqual([]);
    expect(fitImageOps(scene([image("a", { image: { assetHash: "a".repeat(64) } })]), ["a"], "actual")).toEqual([]);
  });
});

describe("relinkImage", () => {
  afterEach(() => useScene.setState({ notice: null }));
  class FakeSync { submit(op: Parameters<typeof applyOp>[1]) { useScene.getState().applyPending(op); useScene.getState().apply(op); } }
  const install = (s: SceneState) => {
    useScene.getState().setScene(s);
    useScene.getState().setSync(new FakeSync() as never);
    useScene.setState({ gesture: null, undoStack: [], redoStack: [] });
  };
  const deps = { measure: async () => ({ width: 800, height: 200 }), upload: async () => ({ hash: "c".repeat(64) }) } as never;

  it("replaces the source in one gesture, keeping the width and taking the new shape", async () => {
    install(scene([image("a")]));
    const file = new File(["x"], "new.png", { type: "image/png" });
    expect(await relinkImage("a", file, deps)).toBe(true);
    const n = useScene.getState().scene!.nodes.get("a")!;
    expect(n.image).toMatchObject({ assetHash: "c".repeat(64), originalName: "new.png", pixelWidth: 800, pixelHeight: 200 });
    expect(n).toMatchObject({ width: 144, height: 36 });
    useScene.getState().undo();
    expect(useScene.getState().scene!.nodes.get("a")).toMatchObject({ image: { originalName: "photo.jpg" }, height: 72 });
  });

  it("refuses a file that is not an image, and reports upload failures", async () => {
    install(scene([image("a")]));
    expect(await relinkImage("a", new File(["x"], "doc.pdf", { type: "application/pdf" }), deps)).toBe(false);
    expect(useScene.getState().notice).toMatch(/not an image/);
    const failing = { measure: async () => ({ width: 1, height: 1 }), upload: async () => { throw new Error("offline"); } } as never;
    expect(await relinkImage("a", new File(["x"], "a.png", { type: "image/png" }), failing)).toBe(false);
    expect(useScene.getState().notice).toMatch(/offline/);
  });
});
