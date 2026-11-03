import { describe, it, expect } from "vitest";
import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";
import { applyOp } from "@/store/applyOp";
import { emptyScene, toPbNode, type SceneState } from "@/store/types";
import { orderKeyBetween } from "@/store/orderKey";
import { makeCreateNodeOp } from "@/tools/ops";
import { overprintOps } from "@/tools/inks";
import { createSwatchOps } from "@/tools/swatches";
import { coverage, density, inkOf, overprintPreviewColor, overprintResult, platesOf, separationView, trapSuggestions, type Ink } from "@/tools/printPreview";

const run = (s: SceneState, ops: Op[]) => ops.reduce(applyOp, s);

function scene(): SceneState {
  let s = emptyScene("d", "d");
  for (const spec of [
    { name: "Cyan", cmyk: { c: 100, m: 0, y: 0, k: 0 } },
    { name: "Yellow", cmyk: { c: 0, m: 0, y: 100, k: 0 } },
    { name: "Gold", cmyk: { c: 10, m: 30, y: 90, k: 0 }, spotName: "PANTONE 871 C" },
  ]) s = run(s, createSwatchOps(s, spec)!.ops);
  const id = (name: string) => Object.values(s.variables).find((v) => v.name === name)!.id;
  const node = (nid: string, x: number, bound: string) => makeCreateNodeOp(toPbNode({ id: nid, parentId: "page1", orderKey: orderKeyBetween(null, null) + nid, name: nid, visible: true, opacity: 1, x, y: 0, width: 10, height: 10, rotation: 0, fills: [{ r: 1, g: 1, b: 1, a: 1 }], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false, bindings: { "fills.0": bound } }));
  return run(s, [node("c", 0, id("Cyan")), node("y", 10, id("Yellow")), node("g", 100, id("Gold"))]);
}

describe("separations", () => {
  it("lists the plates in use and what each carries", () => {
    const s = scene();
    expect(platesOf(s)).toEqual(["Cyan", "Yellow", "PANTONE 871 C"]);
    expect([...separationView(s, "Cyan").entries()]).toEqual([["c", 0]]);
    expect([...separationView(s, "PANTONE 871 C").keys()]).toEqual(["g"]);
    expect(separationView(s, "Magenta").size).toBe(0);
  });
  it("reads a spot as its own plate, not as process ink", () => {
    const s = scene();
    const ink = inkOf(s, s.nodes.get("g")!)!;
    expect(coverage(ink, "Yellow")).toBe(0);
    expect(coverage(ink, "PANTONE 871 C")).toBe(1);
  });
});

describe("overprint preview", () => {
  const cyan: Ink = { process: { c: 100, m: 0, y: 0, k: 0 } };
  const yellow: Ink = { process: { c: 0, m: 0, y: 100, k: 0 } };
  it("knocks out without overprint and merges plates with it", () => {
    expect(overprintResult(yellow, cyan, false)).toBe(yellow);
    expect(overprintResult(yellow, cyan, true).process).toEqual({ c: 100, m: 0, y: 100, k: 0 });
  });
  it("draws yellow over cyan as green only when the fill overprints", () => {
    const plain = overprintPreviewColor(yellow, cyan, undefined);
    expect(plain).toEqual({ r: 1, g: 1, b: 0 });
    expect(overprintPreviewColor(yellow, cyan, "fill")).toEqual({ r: 0, g: 1, b: 0 });
    expect(overprintPreviewColor(yellow, cyan, "stroke")).toEqual(plain);
  });
});

describe("trapping", () => {
  it("asks the lighter ink to spread into the darker where two plates would show a gap", () => {
    const s = scene();
    expect(density(inkOf(s, s.nodes.get("y")!)!)).toBeLessThan(density(inkOf(s, s.nodes.get("c")!)!));
    expect(trapSuggestions(s, 0.5)).toEqual([{ spread: "y", under: "c", width: 0.5, kind: "spread" }]);
  });
  it("skips shapes that are far apart", () => {
    const s = scene();
    const apart = run(s, [{ ...makeCreateNodeOp(toPbNode({ ...s.nodes.get("y")!, id: "y2", x: 500 })) }]);
    expect(trapSuggestions(apart).length).toBe(1);
  });
  it("skips shapes that overprint", () => {
    const s = scene();
    expect(trapSuggestions(run(s, overprintOps(s, ["y"], "fill") as Op[]))).toEqual([]);
  });
});
