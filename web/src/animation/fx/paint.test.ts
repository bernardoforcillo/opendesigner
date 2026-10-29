import { describe, it, expect } from "vitest";
import { encodeStrokes, parseStrokes, simplify, strokesFit, writeOn, type Stroke } from "@/animation/fx/paint";
import { fxDef, resolveFx } from "@/animation/fx/library";
import { MAX_FX_TEXT_BYTES } from "@/animation/fx/props";

const S = (pts: [number, number][], extra: Partial<Stroke> = {}): Stroke => ({ size: 0.05, color: "#336699", opacity: 0.8, points: pts.map(([x, y]) => ({ x, y })), ...extra });

describe("recorded strokes", () => {
  it("round-trip through the compact text within its resolution", () => {
    const a = S([[0.1, 0.2], [0.5, 0.9], [1.1, -0.1]]);
    const back = parseStrokes(encodeStrokes([a, S([[0.3, 0.3]], { color: "#ff0000", size: 0.1, opacity: 1 })]));
    expect(back).toHaveLength(2);
    expect(back[0].color).toBe("#336699");
    expect(back[0].size).toBeCloseTo(0.05, 3);
    expect(back[0].opacity).toBeCloseTo(0.8, 2);
    back[0].points.forEach((p, i) => { expect(p.x).toBeCloseTo(a.points[i].x, 2); expect(p.y).toBeCloseTo(a.points[i].y, 2); });
    expect(back[1].points).toHaveLength(1);
  });
  it("skips what is malformed instead of throwing", () => {
    expect(parseStrokes("")).toEqual([]);
    expect(parseStrokes("junk;50.zzzzzz.100:0000;50.ff0000.100:000")).toEqual([]);
    expect(parseStrokes("50.ff0000.100:0000;nope")).toHaveLength(1);
  });
  it("simplify drops points on a straight line and keeps a corner", () => {
    const line = Array.from({ length: 50 }, (_, i) => ({ x: i / 49, y: 0.5 }));
    expect(simplify(line)).toHaveLength(2);
    expect(simplify([{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 0 }])).toHaveLength(3);
  });
  it("knows when the strokes no longer fit the parameter", () => {
    expect(strokesFit([S([[0, 0], [1, 1]])])).toBe(true);
    const many = Array.from({ length: 200 }, (_, i) => S([[i / 200, 0], [i / 200, 1], [(i + 1) / 200, 0.5]]));
    expect(encodeStrokes(many).length).toBeGreaterThan(MAX_FX_TEXT_BYTES);
    expect(strokesFit(many)).toBe(false);
  });
  it("write-on reveals strokes in order and cuts the one being drawn", () => {
    const strokes = [S([[0, 0], [1, 0]]), S([[0, 1], [1, 1]])];
    expect(writeOn(strokes, 0)).toEqual([]);
    expect(writeOn(strokes, 1)).toHaveLength(2);
    const half = writeOn(strokes, 0.25);
    expect(half).toHaveLength(1);
    expect(half[0].points[half[0].points.length - 1].x).toBeCloseTo(0.5, 5);
    const most = writeOn(strokes, 0.75);
    expect(most).toHaveLength(2);
    expect(most[1].points[1].x).toBeCloseTo(0.5, 5);
    expect(writeOn([S([[0.5, 0.5]])], 0.5)).toHaveLength(1); // a dot appears
  });
});

describe("the Paint effect", () => {
  const def = fxDef("ec.paint.paint")!;
  it("turns the stored strokes into a spec, scaled and written on", () => {
    const text = encodeStrokes([S([[0, 0], [1, 0]]), S([[0, 1], [1, 1]])]);
    const v = resolveFx(def, { writeOn: 25, brushScale: 200, opacity: 50 });
    const spec = def.paint!(v, { strokes: text });
    expect(spec.strokes).toHaveLength(1);
    expect(spec.strokes[0].size).toBeCloseTo(0.1, 3);
    expect(spec.opacity).toBeCloseTo(0.5);
    expect(def.paint!(resolveFx(def, {}), { strokes: "" }).strokes).toEqual([]);
  });
  it("only clears the node's own pixels when asked to paint on transparent", () => {
    expect(def.kernel!(resolveFx(def, {}), {}).skip).toBe(true);
    expect(def.kernel!(resolveFx(def, { onTransparent: 1 }), {}).skip).toBeUndefined();
  });
});
