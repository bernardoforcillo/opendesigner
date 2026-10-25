import { describe, expect, it } from "vitest";
import { create } from "@bufbuild/protobuf";
import { OpSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { applyOp } from "./applyOp";
import { invertOp } from "./history";
import { cmykField, deriveLayers, objectStyleChain, printedRgb, resolveObjectStyleNode, styleFromNode, swatchCmyk, tintCmyk, tintRgb } from "./graphics";
import { resolveScene } from "./variables";
import { hitTest } from "../renderer/canvasRenderer";
import { emptyScene, type NodeLite, type SceneState } from "./types";

const op = (kind: Op["kind"]): Op => create(OpSchema, { opId: "o", docId: "d", kind });
const rect = (id: string, over: Partial<NodeLite> = {}): NodeLite => ({
  id, parentId: "page1", orderKey: "a" + id, name: id, visible: true, opacity: 1, x: 0, y: 0, width: 100, height: 100, rotation: 0,
  fills: [{ r: 0, g: 0, b: 1, a: 1 }], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false, ...over,
});
const scene = (nodes: NodeLite[], extra: Partial<SceneState> = {}): SceneState => ({ ...nodes.reduce((s, n) => ({ ...s, nodes: s.nodes.set(n.id, n) }), emptyScene("d", "d")), ...extra });
const style = (id: string, over: Record<string, unknown> = {}) => op({ case: "setObjectStyleDef", value: { objectStyle: { id, name: id, sets: [], ...over } } } as unknown as Op["kind"]);

describe("object styles", () => {
  const s0 = scene([rect("a", { cornerRadius: 2 })]);
  const red = [{ kind: { case: "solid" as const, value: { color: { r: 1, g: 0, b: 0, a: 1 } } } }];

  it("draws a node with what the style sets, leaving the document's values", () => {
    let s = applyOp(s0, style("card", { sets: ["fills", "opacity", "corner_radius"], fills: red, opacity: 0.5, cornerRadius: 8 }));
    s = applyOp(s, op({ case: "setProps", value: { id: "a", patch: { objectStyleId: "card" }, mask: { paths: ["object_style_id"] } } } as Op["kind"]));
    expect(s.nodes.get("a")!.objectStyleId).toBe("card");
    const out = resolveScene(s).nodes.get("a")!;
    expect(out).toMatchObject({ opacity: 0.5, cornerRadius: 8 });
    expect(out.fills[0]).toMatchObject({ r: 1, g: 0, b: 0 });
    expect(s.nodes.get("a")).toMatchObject({ opacity: 1, cornerRadius: 2 });
  });

  it("starts a based-on style from its base, the nearest winning", () => {
    let s = applyOp(s0, style("card", { sets: ["fills", "opacity"], fills: red, opacity: 0.5 }));
    s = applyOp(s, style("soft", { basedOn: "card", sets: ["opacity"], opacity: 0.2 }));
    expect(objectStyleChain(s, "soft").map((d) => d.id)).toEqual(["card", "soft"]);
    const n = resolveObjectStyleNode(s, { ...s.nodes.get("a")!, objectStyleId: "soft" });
    expect(n.opacity).toBe(0.2);
    expect(n.fills[0]).toMatchObject({ r: 1 });
  });

  it("rejects what Go rejects", () => {
    const s = applyOp(s0, style("card", { sets: ["opacity"], opacity: 0.5 }));
    for (const bad of [
      style("x", { sets: ["width"] }), style("x", { sets: ["fills", "fills"] }), style("x", { sets: ["opacity"], opacity: 2 }),
      style("card", { basedOn: "card" }), style("x", { basedOn: "nope" }), style("x", { cornerRadius: -1 }),
      op({ case: "setProps", value: { id: "a", patch: { objectStyleId: "nope" }, mask: { paths: ["object_style_id"] } } } as Op["kind"]),
      op({ case: "deleteObjectStyleDef", value: { id: "nope" } } as Op["kind"]),
    ]) {
      expect(applyOp(s, bad)).toBe(s);
      // A rejected setProps has an inverse that is rejected too (the identity); the other ops have none.
      if (bad.kind.case !== "setProps") expect(invertOp(s, bad)).toBeNull();
    }
  });

  it("is not for groups", () => {
    const s = applyOp(scene([rect("g", { kind: "group" })]), style("card", { sets: ["opacity"] }));
    const bad = op({ case: "setProps", value: { id: "g", patch: { objectStyleId: "card" }, mask: { paths: ["object_style_id"] } } } as unknown as Op["kind"]);
    expect(applyOp(s, bad)).toBe(s);
  });

  it("deleting a style detaches its nodes, and undo brings the style, the nodes and the based-on link back", () => {
    let s = applyOp(s0, style("card", { sets: ["opacity"], opacity: 0.5 }));
    s = applyOp(s, style("soft", { basedOn: "card", sets: ["opacity"], opacity: 0.2 }));
    s = applyOp(s, op({ case: "setProps", value: { id: "a", patch: { objectStyleId: "card" }, mask: { paths: ["object_style_id"] } } } as Op["kind"]));
    const del = op({ case: "deleteObjectStyleDef", value: { id: "card" } } as unknown as Op["kind"]);
    const after = applyOp(s, del);
    expect(after.nodes.get("a")!.objectStyleId).toBeUndefined();
    expect(after.objectStyles.soft.basedOn).toBeUndefined();
    const back = invertOp(s, del)!.reduce(applyOp, after);
    expect(back.objectStyles).toEqual(s.objectStyles);
    expect(back.nodes.get("a")!.objectStyleId).toBe("card");
  });

  it("an upsert's inverse is the previous style, or the delete of a new one", () => {
    const s = applyOp(s0, style("card", { sets: ["opacity"], opacity: 0.5 }));
    const change = style("card", { sets: ["opacity"], opacity: 0.9 });
    expect(applyOp(applyOp(s, change), invertOp(s, change)![0]).objectStyles).toEqual(s.objectStyles);
    const fresh = style("new", { sets: ["opacity"] });
    expect(applyOp(applyOp(s, fresh), invertOp(s, fresh)![0]).objectStyles).toEqual(s.objectStyles);
  });

  it("makes a style from a node's look", () => {
    const n = rect("a", { opacity: 0.4, cornerRadius: 6, blendMode: "multiply" });
    expect(styleFromNode(n, ["opacity", "corner_radius", "blend_mode"])).toEqual({ sets: ["opacity", "corner_radius", "blend_mode"], opacity: 0.4, cornerRadius: 6, blendMode: "multiply" });
  });
});

describe("layers", () => {
  const layers = (...l: SceneState["layers"]) => l;
  it("keeps the order, upserts in place and detaches on delete (undo restores order and members)", () => {
    let s = scene([rect("a", { layerId: "l1" })]);
    for (const l of [{ id: "l1", name: "Art" }, { id: "l2", name: "Text" }]) s = applyOp(s, op({ case: "setLayer", value: { layer: l } } as Op["kind"]));
    s = applyOp(s, op({ case: "setLayer", value: { layer: { id: "l1", name: "Artwork", hidden: true } } } as Op["kind"]));
    expect(s.layers).toEqual([{ id: "l1", name: "Artwork", hidden: true }, { id: "l2", name: "Text" }]);
    const del = op({ case: "deleteLayer", value: { id: "l1" } } as unknown as Op["kind"]);
    const after = applyOp(s, del);
    expect(after.layers.map((l) => l.id)).toEqual(["l2"]);
    expect(after.nodes.get("a")!.layerId).toBeUndefined();
    const back = invertOp(s, del)!.reduce(applyOp, after);
    expect(back.layers).toEqual(s.layers);
    expect(back.nodes.get("a")!.layerId).toBe("l1");
  });
  it("rejects a missing layer and a layer without an id", () => {
    const s = scene([rect("a")], { layers: layers({ id: "l1", name: "Art" }) });
    for (const bad of [
      op({ case: "setProps", value: { id: "a", patch: { layerId: "nope" }, mask: { paths: ["layer_id"] } } } as Op["kind"]),
      op({ case: "setLayer", value: { layer: { id: "", name: "x" } } } as Op["kind"]),
      op({ case: "deleteLayer", value: { id: "nope" } } as Op["kind"]),
    ]) expect(applyOp(s, bad)).toBe(s);
  });
  it("hides the nodes of a hidden layer and locks those of a locked one, on every page", () => {
    const s = scene([
      rect("a", { layerId: "h" }), rect("b", { layerId: "k", parentId: "page2", x: 10 }), rect("c"),
    ], { layers: layers({ id: "h", name: "Hidden", hidden: true }, { id: "k", name: "Locked", locked: true }), pages: [{ id: "page1", name: "1" }, { id: "page2", name: "2" }] });
    const out = deriveLayers(s);
    expect(out.nodes.get("a")!.visible).toBe(false);
    expect(out.nodes.get("b")).toMatchObject({ locked: true, visible: true });
    expect(out.nodes.get("c")!.locked).toBeUndefined();
    expect(s.nodes.get("a")!.visible).toBe(true);
    expect(deriveLayers(scene([rect("a")]))).toBeDefined();
  });
  it("a locked object is drawn but not picked", () => {
    const s = scene([rect("a", { layerId: "k" })], { layers: layers({ id: "k", name: "Locked", locked: true }) });
    expect(hitTest(resolveScene(s), 50, 50, 1, "page1")).toBeNull();
    const unlocked = { ...s, layers: [{ id: "k", name: "Locked" }] };
    expect(hitTest(resolveScene(unlocked), 50, 50, 1, "page1")).toBe("a");
  });
});

describe("colour", () => {
  it("tints toward white, in RGB and in CMYK", () => {
    expect(tintRgb({ r: 1, g: 0, b: 0 }, 50)).toEqual({ r: 1, g: 0.5, b: 0.5 });
    expect(tintCmyk({ c: 0, m: 100, y: 80, k: 20 }, 50)).toEqual({ c: 0, m: 50, y: 40, k: 10 });
  });
  it("prints a screen color through the device conversion", () => {
    const p = printedRgb({ r: 0.2, g: 0.4, b: 0.9 });
    expect(p.r).toBeCloseTo(0.2); expect(p.b).toBeCloseTo(0.9);
  });
  it("goes between percent CMYK and a swatch's 0..1 channels", () => {
    expect(cmykField({ c: 0, m: 100, y: 50, k: 0 })).toEqual({ c: 0, m: 1, y: 0.5, k: 0 });
    expect(swatchCmyk({ cmyk: { c: 0, m: 1, y: 0.5, k: 0 } })).toEqual({ c: 0, m: 100, y: 50, k: 0 });
    expect(swatchCmyk({})).toBeNull();
  });
});

describe("colour mode, profile and image relink in the reducer", () => {
  it("sets and restores the colour settings", () => {
    const s = emptyScene("d", "d");
    const set = op({ case: "setDocSettings", value: { settings: { vertical: "", baselineIncrement: 0, baselineStart: 0, colorMode: "cmyk", iccProfile: "FOGRA39" } } } as unknown as Op["kind"]);
    const next = applyOp(s, set);
    expect(next.settings).toEqual({ colorMode: "cmyk", iccProfile: "FOGRA39" });
    expect(applyOp(next, invertOp(s, set)![0]).settings).toBeUndefined();
    for (const bad of [{ colorMode: "lab" }, { iccProfile: " x " }, { iccProfile: "a".repeat(65) }]) {
      const o = op({ case: "setDocSettings", value: { settings: { vertical: "", baselineIncrement: 0, baselineStart: 0, ...bad } } } as unknown as Op["kind"]);
      expect(applyOp(s, o)).toBe(s);
    }
  });
  it("relinks an image node and undoes it, keeping the box", () => {
    const s = scene([rect("img", { kind: "image", image: { assetHash: "a".repeat(64), originalName: "one.jpg", pixelWidth: 100, pixelHeight: 50 } }), rect("r")]);
    const relink = op({ case: "setImage", value: { id: "img", image: { assetHash: "b".repeat(64), originalName: "two.jpg", pixelWidth: 200, pixelHeight: 100 } } } as unknown as Op["kind"]);
    const next = applyOp(s, relink);
    expect(next.nodes.get("img")).toMatchObject({ width: 100, image: { originalName: "two.jpg", pixelWidth: 200 } });
    expect(applyOp(next, invertOp(s, relink)![0]).nodes.get("img")!.image).toEqual(s.nodes.get("img")!.image);
    for (const id of ["r", "nope"]) {
      const bad = op({ case: "setImage", value: { id, image: { assetHash: "b".repeat(64) } } } as unknown as Op["kind"]);
      expect(applyOp(s, bad)).toBe(s);
      expect(invertOp(s, bad)).toBeNull();
    }
  });
});
