import { describe, it, expect } from "vitest";
import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";
import { applyOp } from "@/store/applyOp";
import { emptyScene, toPbNode, type SceneState } from "@/store/types";
import { orderKeyBetween } from "@/store/orderKey";
import { makeCreateNodeOp } from "@/tools/ops";
import { createSwatchOps } from "@/tools/swatches";
import { convertSpotsOps, inkReport, mergeSpotsOps, overprintOps } from "@/tools/inks";
import { preflightScene } from "@/export/preflight";

const run = (s: SceneState, ops: Op[]) => ops.reduce(applyOp, s);

function scene(): SceneState {
  let s = emptyScene("d", "d");
  for (const spec of [
    { name: "Process red", cmyk: { c: 0, m: 100, y: 100, k: 0 } },
    { name: "Rich black", cmyk: { c: 80, m: 70, y: 70, k: 90 } },
    { name: "Gold", cmyk: { c: 10, m: 30, y: 90, k: 0 }, spotName: "PANTONE 871 C" },
    { name: "Gold 2", cmyk: { c: 12, m: 30, y: 90, k: 0 }, spotName: "Gold-2" },
  ]) s = run(s, createSwatchOps(s, spec)!.ops);
  const node = (id: string, bound?: string) => makeCreateNodeOp(toPbNode({ id, parentId: "page1", orderKey: orderKeyBetween(null, null) + id, name: id, visible: true, opacity: 1, x: 0, y: 0, width: 10, height: 10, rotation: 0, fills: [{ r: 1, g: 1, b: 1, a: 1 }], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false, ...(bound ? { bindings: { "fills.0": bound } } : {}) }));
  const gold = Object.values(s.variables).find((v) => v.name === "Gold")!.id;
  return run(s, [node("a", gold), node("b", gold)]);
}

describe("ink manager", () => {
  it("reports process and spot inks with their use, and swatches over the ink limit", () => {
    const r = inkReport(scene());
    expect(r.process.swatches).toBe(2);
    expect(r.spots.map((s) => [s.name, s.objects]).sort()).toEqual([["Gold-2", 0], ["PANTONE 871 C", 2]]);
    expect(r.overLimit).toEqual([{ swatch: "Rich black", total: 310 }]);
  });
  it("converts a named spot, or all, to process; unknown names are refused", () => {
    const s = scene();
    const one = run(s, convertSpotsOps(s, ["PANTONE 871 C"]) as Op[]);
    expect(inkReport(one).spots.map((x) => x.name)).toEqual(["Gold-2"]);
    expect(inkReport(run(s, convertSpotsOps(s) as Op[])).spots).toEqual([]);
    expect(convertSpotsOps(s, ["nope"])).toMatch(/no spot ink/);
  });
  it("merges one spot into another as an alias", () => {
    const s = scene();
    const after = run(s, mergeSpotsOps(s, "Gold-2", "PANTONE 871 C") as Op[]);
    expect(inkReport(after).spots).toHaveLength(1);
    expect(inkReport(after).spots[0]!.swatches.sort()).toEqual(["Gold", "Gold 2"]);
    expect(mergeSpotsOps(s, "x", "y")).toMatch(/no spot ink/);
    expect(mergeSpotsOps(s, "Gold-2", "Gold-2")).toMatch(/same ink/);
  });
});

describe("overprint", () => {
  it("is set and cleared per node, and a white overprint is a preflight warning", () => {
    const s = scene();
    const on = run(s, overprintOps(s, ["a", "b"], "both") as Op[]);
    expect(on.nodes.get("a")!.meta!.overprint).toBe("both");
    expect(inkReport(on).overprint).toBe(2);
    expect(overprintOps(on, ["a"], "both")).toEqual([]);
    expect(preflightScene(on).filter((i) => i.code === "overprint-white")).toHaveLength(2); // the nodes are white
    const off = run(on, overprintOps(on, ["a", "b"], "off") as Op[]);
    expect(off.nodes.get("a")!.meta?.overprint).toBeUndefined();
    expect(overprintOps(s, ["zz"], "fill")).toMatch(/no node/);
    expect(overprintOps(s, ["a"], "weird" as never)).toMatch(/mode must be/);
  });
});
