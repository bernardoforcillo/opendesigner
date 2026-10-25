import { describe, it, expect } from "vitest";
import { create } from "@bufbuild/protobuf";
import { OpSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import { applyOp } from "../store/applyOp";
import { invertOp } from "../store/history";
import { resolveScene } from "../store/variables";
import { swatchCmyk, swatchesOf } from "../store/graphics";
import { emptyScene, type NodeLite, type SceneState } from "../store/types";
import { applySwatchOps, createSwatchOps, deleteSwatchOps, swatchFromColor, updateSwatchOps } from "./swatches";

const rect = (id: string): NodeLite => ({
  id, parentId: "page1", orderKey: "a" + id, name: id, visible: true, opacity: 1, x: 0, y: 0, width: 10, height: 10, rotation: 0,
  fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [{ color: { r: 0, g: 0, b: 0, a: 1 }, weight: 1, align: "center" }], kind: "rect", cornerRadius: 0, clipsContent: false,
});
const run = (s: SceneState, ops: Parameters<typeof applyOp>[1][]) => ops.reduce(applyOp, s);
const base = (): SceneState => ({ ...emptyScene("d", "d"), nodes: emptyScene("d", "d").nodes.set("a", rect("a")) });

describe("swatches", () => {
  it("creates the Swatches collection once, with CMYK process, spot and tint swatches", () => {
    let s = base();
    const red = createSwatchOps(s, { name: "Red", cmyk: { c: 0, m: 100, y: 100, k: 0 } })!;
    s = run(s, red.ops);
    const spot = createSwatchOps(s, { name: "Brand", rgb: { r: 0.2, g: 0.4, b: 0.8 }, spotName: "PANTONE 485 C" })!;
    expect(spot.ops).toHaveLength(1); // the collection exists now
    s = run(s, spot.ops);
    const tint = createSwatchOps(s, { name: "Red 50", tintOf: red.id, tint: 50 })!;
    s = run(s, tint.ops);
    expect(Object.keys(s.collections)).toHaveLength(1);
    const r = s.variables[red.id];
    expect(r).toMatchObject({ swatch: true, cmyk: { c: 0, m: 1, y: 1, k: 0 } });
    expect(r.values[Object.keys(r.values)[0]]).toMatchObject({ r: 1, g: 0, b: 0 });
    expect(s.variables[spot.id]).toMatchObject({ swatch: true, spotName: "PANTONE 485 C" });
    const t = s.variables[tint.id];
    expect(t).toMatchObject({ tintOf: red.id, tint: 50, cmyk: { m: 0.5, y: 0.5 } });
    expect(t.values[Object.keys(t.values)[0]]).toMatchObject({ r: 1, g: 0.5, b: 0.5 });
    expect(swatchesOf(s).map((v) => v.name)).toEqual(["Brand", "Red", "Red 50"]);
  });

  it("refuses a tint of something that is not a swatch", () => {
    expect(createSwatchOps(base(), { name: "x", tintOf: "nope", tint: 50 })).toBeNull();
  });

  it("changes a swatch and re-derives its tints, and the tints of tints", () => {
    let s = base();
    const a = createSwatchOps(s, { name: "A", cmyk: { c: 100, m: 0, y: 0, k: 0 } })!; s = run(s, a.ops);
    const b = createSwatchOps(s, { name: "A 50", tintOf: a.id, tint: 50 })!; s = run(s, b.ops);
    const c = createSwatchOps(s, { name: "A 25", tintOf: b.id, tint: 50 })!; s = run(s, c.ops);
    s = run(s, updateSwatchOps(s, a.id, { cmyk: { c: 0, m: 100, y: 0, k: 0 } }));
    expect(swatchCmyk(s.variables[b.id])).toMatchObject({ m: 50, c: 0 });
    expect(swatchCmyk(s.variables[c.id])).toMatchObject({ m: 25 });
    const colour = (id: string) => Object.values(s.variables[id].values)[0];
    expect(colour(c.id)).toMatchObject({ r: 1, g: 0.75, b: 1 });
  });

  it("renames without touching the colour, and edits a tint's percentage", () => {
    let s = base();
    const a = createSwatchOps(s, { name: "A", cmyk: { c: 0, m: 0, y: 100, k: 0 } })!; s = run(s, a.ops);
    const t = createSwatchOps(s, { name: "T", tintOf: a.id, tint: 40 })!; s = run(s, t.ops);
    s = run(s, updateSwatchOps(s, a.id, { name: "Yellow" }));
    expect(s.variables[a.id].name).toBe("Yellow");
    expect(swatchCmyk(s.variables[a.id])).toMatchObject({ y: 100 });
    s = run(s, updateSwatchOps(s, t.id, { tint: 80 }));
    expect(s.variables[t.id].tint).toBe(80);
    expect(swatchCmyk(s.variables[t.id])).toMatchObject({ y: 80 });
  });

  it("uses a swatch on a fill: change the swatch and the fill follows; deleting it detaches", () => {
    let s = base();
    const a = createSwatchOps(s, { name: "A", cmyk: { c: 0, m: 100, y: 100, k: 0 } })!; s = run(s, a.ops);
    s = run(s, applySwatchOps(s, ["a"], "fill", a.id));
    expect(s.nodes.get("a")!.bindings).toEqual({ "fills.0": a.id });
    expect(resolveScene(s).nodes.get("a")!.fills[0]).toMatchObject({ r: 1, g: 0, b: 0 });
    s = run(s, updateSwatchOps(s, a.id, { cmyk: { c: 100, m: 0, y: 0, k: 0 } }));
    expect(resolveScene(s).nodes.get("a")!.fills[0]).toMatchObject({ r: 0, g: 1, b: 1 });
    s = run(s, applySwatchOps(s, ["a"], "stroke", a.id));
    expect(s.nodes.get("a")!.bindings).toMatchObject({ "strokes.0": a.id });
    s = run(s, deleteSwatchOps(s, a.id));
    expect(s.variables[a.id]).toBeUndefined();
    expect(s.nodes.get("a")!.bindings).toBeUndefined();
  });

  it("deleting a base swatch keeps its tints as plain swatches", () => {
    let s = base();
    const a = createSwatchOps(s, { name: "A", cmyk: { c: 100, m: 0, y: 0, k: 0 } })!; s = run(s, a.ops);
    const t = createSwatchOps(s, { name: "T", tintOf: a.id, tint: 50 })!; s = run(s, t.ops);
    s = run(s, deleteSwatchOps(s, a.id));
    expect(s.variables[t.id]).toBeDefined();
    expect(s.variables[t.id].tintOf).toBeUndefined();
    expect(s.variables[t.id].swatch).toBe(true);
  });

  it("a plain variable delete keeps the tints too, and its undo brings the tint link back", () => {
    let s = base();
    const a = createSwatchOps(s, { name: "A", cmyk: { c: 100, m: 0, y: 0, k: 0 } })!; s = run(s, a.ops);
    const t = createSwatchOps(s, { name: "T", tintOf: a.id, tint: 50 })!; s = run(s, t.ops);
    const del = create(OpSchema, { opId: "x", docId: "d", kind: { case: "deleteVariable", value: { id: a.id } } });
    const after = applyOp(s, del);
    expect(after.variables[t.id].tintOf).toBeUndefined();
    const back = invertOp(s, del)!.reduce(applyOp, after);
    expect(back.variables[a.id]).toBeDefined();
    expect(back.variables[t.id]).toMatchObject({ tintOf: a.id, tint: 50 });
  });

  it("names a swatch made from a color after its hex value", () => {
    expect(swatchFromColor({ r: 1, g: 0.5, b: 0 }).name).toBe("#FF8000");
  });
});
