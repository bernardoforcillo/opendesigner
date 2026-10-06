import { describe, it, expect } from "vitest";
import { applyTransform } from "../canvas/transform";
import { isTranslationM, lengthScaleOf, parseTransform, similarityOf } from "./transform";

const pt = (t: ReturnType<typeof parseTransform>, x: number, y: number) => {
  const p = applyTransform(t.matrix, x, y);
  return [Math.round(p.x * 1e6) / 1e6, Math.round(p.y * 1e6) / 1e6];
};

describe("parseTransform", () => {
  it("empty = valid identity", () => {
    expect(parseTransform("").ok).toBe(true);
    expect(parseTransform(null).matrix).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
  });
  it("translate (one and two arguments), scale (one and two)", () => {
    expect(pt(parseTransform("translate(10)"), 1, 1)).toEqual([11, 1]);
    expect(pt(parseTransform("translate(10, 5)"), 1, 1)).toEqual([11, 6]);
    expect(pt(parseTransform("scale(2)"), 3, 4)).toEqual([6, 8]);
    expect(pt(parseTransform("scale(2 -1)"), 3, 4)).toEqual([6, -4]);
  });
  it("rotate: positive = clockwise in a system with y pointing down; with center", () => {
    expect(pt(parseTransform("rotate(90)"), 1, 0)).toEqual([0, 1]);
    expect(pt(parseTransform("rotate(90 10 10)"), 20, 10)).toEqual([10, 20]);
    expect(pt(parseTransform("rotate(180 5 5)"), 0, 0)).toEqual([10, 10]);
  });
  it("skewX e skewY", () => {
    expect(pt(parseTransform("skewX(45)"), 0, 10)).toEqual([10, 10]);
    expect(pt(parseTransform("skewY(45)"), 10, 0)).toEqual([10, 10]);
  });
  it("matrix(a b c d e f)", () => {
    expect(pt(parseTransform("matrix(1 0 0.5 1 10 20)"), 2, 4)).toEqual([14, 24]);
    expect(parseTransform("matrix(1 2 3)").ok).toBe(false);
  });
  it("composition in SVG order: the last applies first to the points", () => {
    // translate(10 0) scale(2): the point (1,0) first scales (2,0) then translates (12,0)
    expect(pt(parseTransform("translate(10 0) scale(2)"), 1, 0)).toEqual([12, 0]);
    expect(pt(parseTransform("scale(2) translate(10 0)"), 1, 0)).toEqual([22, 0]);
  });
  it("CSS syntax: deg/rad/px units, commas, uppercase", () => {
    expect(pt(parseTransform("rotate(90deg)"), 1, 0)).toEqual([0, 1]);
    expect(pt(parseTransform("rotate(1.5707963rad)"), 1, 0)).toEqual([0, 1]);
    expect(pt(parseTransform("translate(10px, 20px)"), 0, 0)).toEqual([10, 20]);
    expect(pt(parseTransform("TRANSLATE(5,5)rotate(0)"), 0, 0)).toEqual([5, 5]);
    expect(pt(parseTransform("translate(1 2),scale(2)"), 1, 1)).toEqual([3, 4]);
  });
  it("invalid functions: ok=false but the valid ones apply; garbage = identity not ok", () => {
    const t = parseTransform("translate(5 5) bogus(1) scale(2)");
    expect(t.ok).toBe(false);
    expect(pt(t, 1, 1)).toEqual([7, 7]);
    expect(parseTransform("garbage").ok).toBe(false);
    expect(parseTransform("translate(1e999 0)").ok).toBe(false);
  });
});

describe("similarityOf / isTranslationM / lengthScaleOf", () => {
  const m = (s: string) => parseTransform(s).matrix;
  it("translation+uniform scale+rotation is a similarity", () => {
    expect(similarityOf(m("translate(10 10) scale(3)"))).toEqual({ s: 3, rotation: 0 });
    const r = similarityOf(m("rotate(30) scale(2)"));
    expect(r?.s).toBeCloseTo(2, 9);
    expect(r?.rotation).toBeCloseTo(30, 6);
    expect(similarityOf(m("rotate(-90)"))?.rotation).toBeCloseTo(270, 6);
  });
  it("reflection, non-uniform scale and skew are NOT", () => {
    expect(similarityOf(m("scale(1 -1)"))).toBeNull();
    expect(similarityOf(m("scale(2 1)"))).toBeNull();
    expect(similarityOf(m("skewX(10)"))).toBeNull();
    expect(similarityOf(m("scale(0)"))).toBeNull();
  });
  it("numeric noise around 360 does not become a rotation", () => {
    expect(similarityOf(m("rotate(360)"))?.rotation).toBe(0);
    expect(similarityOf({ a: 1, b: -1e-12, c: 1e-12, d: 1, e: 0, f: 0 })?.rotation).toBe(0);
  });
  it("isTranslationM e lengthScaleOf", () => {
    expect(isTranslationM(m("translate(3 4)"))).toBe(true);
    expect(isTranslationM(m("scale(2)"))).toBe(false);
    expect(lengthScaleOf(m("scale(2 8)"))).toBeCloseTo(4, 9);
  });
});
