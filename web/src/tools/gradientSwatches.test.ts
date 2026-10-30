import { describe, expect, it } from "vitest";
import { applyOp } from "@/store/applyOp";
import { emptyScene, type NodeLite, type SceneState } from "@/store/types";
import { createSwatchOps } from "@/tools/swatches";
import {
  applyGradientSwatchOps, createGradientSwatchOps, deleteGradientSwatchOps, gradientCss, gradientSwatchesOf, gradientSwatchFromNodeOps, renameGradientSwatchOps,
} from "@/tools/gradientSwatches";

const rect = (id: string, fill: NodeLite["fills"][number] = { r: 0, g: 0, b: 0, a: 1 }): NodeLite => ({
  id, parentId: "page1", orderKey: "a" + id, name: id, visible: true, opacity: 1, x: 0, y: 0, width: 10, height: 10, rotation: 0,
  fills: [fill], strokes: [{ color: { r: 0, g: 0, b: 0, a: 1 }, weight: 1, align: "center" }], kind: "rect", cornerRadius: 0, clipsContent: false,
});
const run = (s: SceneState, ops: Parameters<typeof applyOp>[1][]) => ops.reduce(applyOp, s);
const base = (): SceneState => ({ ...emptyScene("d", "d"), nodes: emptyScene("d", "d").nodes.set("a", rect("a")) });

describe("gradient swatches", () => {
  it("builds a gradient between two colour swatches and lists it", () => {
    let s = base();
    const red = createSwatchOps(s, { name: "Red", cmyk: { c: 0, m: 100, y: 100, k: 0 } })!; s = run(s, red.ops);
    const blue = createSwatchOps(s, { name: "Blue", rgb: { r: 0, g: 0, b: 1 } })!; s = run(s, blue.ops);
    const g = createGradientSwatchOps(s, { name: "Sunset", angle: 90, stops: [{ swatchId: red.id }, { swatchId: blue.id }] })!;
    s = run(s, g.ops);
    const def = s.paintStyles[g.id]!;
    expect(def.name).toBe("Sunset");
    const grad = def.paints[0]!.gradient!;
    expect(grad.kind).toBe("linear");
    expect(grad.stops.map((x) => x.position)).toEqual([0, 1]);
    expect(grad.stops[0]!.color).toMatchObject({ r: 1, g: 0, b: 0 });
    expect(grad.stops[1]!.color).toMatchObject({ r: 0, g: 0, b: 1 });
    // 90 degrees runs top to bottom
    expect(grad).toMatchObject({ x1: 0.5, y1: 0, x2: 0.5, y2: 1 });
    expect(gradientSwatchesOf(s).map((d) => d.name)).toEqual(["Sunset"]);
  });

  it("refuses fewer than two stops, an unknown swatch and an empty name", () => {
    const s = base();
    expect(createGradientSwatchOps(s, { name: "x", stops: [{ rgb: { r: 0, g: 0, b: 0 } }] })).toBeNull();
    expect(createGradientSwatchOps(s, { name: "x", stops: [{ swatchId: "nope" }, { rgb: { r: 0, g: 0, b: 0 } }] })).toBeNull();
    expect(createGradientSwatchOps(s, { name: "  ", stops: [{ rgb: { r: 0, g: 0, b: 0 } }, { rgb: { r: 1, g: 1, b: 1 } }] })).toBeNull();
  });

  it("applies to a fill and a stroke, renames, and deletes (the node keeps its own paint)", () => {
    let s = base();
    const g = createGradientSwatchOps(s, { name: "G", kind: "radial", stops: [{ rgb: { r: 1, g: 1, b: 1 } }, { rgb: { r: 0, g: 0, b: 0 }, position: 0.8 }] })!;
    s = run(s, g.ops);
    s = run(s, applyGradientSwatchOps(s, ["a"], "fill", g.id));
    s = run(s, applyGradientSwatchOps(s, ["a"], "stroke", g.id));
    expect(s.nodes.get("a")).toMatchObject({ fillStyleId: g.id, strokeStyleId: g.id });
    s = run(s, renameGradientSwatchOps(s, g.id, "Glow"));
    expect(s.paintStyles[g.id]!.name).toBe("Glow");
    expect(renameGradientSwatchOps(s, g.id, "Glow")).toEqual([]);
    s = run(s, deleteGradientSwatchOps(s, g.id));
    expect(s.paintStyles[g.id]).toBeUndefined();
    expect(s.nodes.get("a")!.fillStyleId ?? "").toBe("");
  });

  it("only treats gradient styles as gradient swatches", () => {
    let s = base();
    const flat = { id: "flat", name: "Flat", paints: [{ r: 1, g: 0, b: 0, a: 1 }] };
    s = { ...s, paintStyles: { flat } };
    expect(gradientSwatchesOf(s)).toEqual([]);
    expect(applyGradientSwatchOps(s, ["a"], "fill", "flat")).toEqual([]);
    expect(deleteGradientSwatchOps(s, "flat")).toEqual([]);
  });

  it("makes a swatch from a node's gradient fill, and gives CSS for the chip", () => {
    const grad = { kind: "linear" as const, stops: [{ color: { r: 1, g: 0, b: 0, a: 1 }, position: 0 }, { color: { r: 0, g: 0, b: 1, a: 1 }, position: 1 }], x1: 0, y1: 0.5, x2: 1, y2: 0.5 };
    const node = rect("g", { r: 1, g: 0, b: 0, a: 1, gradient: grad });
    expect(gradientSwatchFromNodeOps(rect("p"), "Flat")).toBeNull();
    let s = base();
    const made = gradientSwatchFromNodeOps(node, "From node")!;
    s = run(s, made.ops);
    expect(gradientCss(s.paintStyles[made.id]!)).toBe("linear-gradient(90deg, #ff0000 0%, #0000ff 100%)");
  });
});
