import { describe, it, expect } from "vitest";
import {
  SPRING_BEZIER, clipTimeline, cubicBezier, easingFn, isValidEasing, parseCubicBezier, sampleClip, sampleTrack, springEasing,
} from "./engine";
import type { ClipLite, KeyframeLite } from "../store/types";

const kf = (time: number, value: number, easing = ""): KeyframeLite => ({ time, value, easing });
const near = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe("easing: grammar", () => {
  it("accepts the names and well-formed cubic-beziers", () => {
    for (const s of ["", "linear", "easeIn", "easeOut", "easeInOut", "spring", "cubic-bezier(0,0,1,1)",
      "cubic-bezier( 0.1 , -2 , 0.9 , 3 )", "cubic-bezier(.4,0,.2,1)", "cubic-bezier(1e-1,0,1,1)"]) {
      expect(isValidEasing(s), s).toBe(true);
    }
  });
  it("rejects garbage", () => {
    for (const s of ["ease", "Linear", "cubic-bezier()", "cubic-bezier(0,0,1,1,1)", "cubic-bezier(a,b,c,d)",
      "cubic-bezier(0,0,1,)", "cubic-bezier(0,0,1,1) ", " linear", "cubic-bezier(-0.1,0,1,1)", "cubic-bezier(0,0,1.1,1)",
      "cubic-bezier(0,0,1,1e999)", "cubic-bezier(0x1,0,1,1)", "cubic-bezier(0,nan,1,1)", "cubic-bezier(0,Infinity,1,1)"]) {
      expect(isValidEasing(s), s).toBe(false);
    }
  });
  it("parseCubicBezier extracts the four numbers", () => {
    expect(parseCubicBezier("cubic-bezier(0.25, -0.5, .75, 1.5)")).toEqual([0.25, -0.5, 0.75, 1.5]);
    expect(parseCubicBezier("linear")).toBeNull();
  });
});

describe("easingFn", () => {
  const specs = ["linear", "easeIn", "easeOut", "easeInOut", "spring", "cubic-bezier(0.2,0.8,0.4,1)", "cubic-bezier(0.5,-1,0.5,2)"];
  it("every curve starts at 0 and ends at 1", () => {
    for (const s of specs) {
      const f = easingFn(s);
      near(f(0), 0); near(f(1), 1);
      near(f(-5), 0); near(f(7), 1);               // out of range: clamp to the ends
    }
  });
  it("linear and \"\" are the identity", () => {
    for (const s of ["", "linear"]) for (const p of [0, 0.1, 0.5, 0.99, 1]) near(easingFn(s)(p), p);
  });
  it("an invalid spec falls back to linear (the engine does not throw)", () => {
    near(easingFn("boh")(0.3), 0.3);
    near(easingFn("cubic-bezier(9,9,9,9)")(0.3), 0.3);
  });
  it("easeIn starts slow, easeOut starts fast, easeInOut is symmetric", () => {
    expect(easingFn("easeIn")(0.25)).toBeLessThan(0.25);
    expect(easingFn("easeOut")(0.25)).toBeGreaterThan(0.25);
    near(easingFn("easeInOut")(0.5), 0.5, 1e-5);
    near(easingFn("easeInOut")(0.2) + easingFn("easeInOut")(0.8), 1, 1e-5);
  });
  it("cubic-bezier: known values of the CSS ease curve (0.25,0.1,0.25,1)", () => {
    const f = cubicBezier(0.25, 0.1, 0.25, 1);
    // references computed with the parametric definition (high-precision Newton)
    near(f(0.5), 0.8024, 1e-3);
    near(f(0.25), 0.4094, 1e-3);
    near(f(0.75), 0.9604, 1e-3);
  });
  it("cubic-bezier with x1=x2=y1=y2 on the diagonal coincides with linear (precise solver)", () => {
    const f = cubicBezier(0.3, 0.3, 0.7, 0.7);
    for (let i = 0; i <= 20; i++) near(f(i / 20), i / 20, 1e-5);
  });
  it("cubic-bezier is monotonic when y in [0,1], and allows overshoot with y outside", () => {
    const f = cubicBezier(0.2, 0, 0.2, 1);
    let prev = -1;
    for (let i = 0; i <= 100; i++) { const v = f(i / 100); expect(v).toBeGreaterThanOrEqual(prev - 1e-9); prev = v; }
    const o = cubicBezier(0.3, 1.8, 0.6, 1);
    expect(Math.max(...Array.from({ length: 101 }, (_, i) => o(i / 100)))).toBeGreaterThan(1);
  });
  it("the solver handles the degenerate cases (flat derivative, x values at the ends)", () => {
    for (const [a, c] of [[0, 0], [1, 1], [0, 1], [1, 0]] as const) {
      const f = cubicBezier(a, 0, c, 1);
      for (let i = 0; i <= 50; i++) { const v = f(i / 50); expect(Number.isFinite(v)).toBe(true); }
    }
  });
  it("spring: critically damped, monotonic, no bounce, settled", () => {
    let prev = -1;
    for (let i = 0; i <= 200; i++) {
      const v = springEasing(i / 200);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-12);
      expect(v).toBeLessThanOrEqual(1 + 1e-12);
      prev = v;
    }
    expect(springEasing(0.5)).toBeGreaterThan(0.9);  // at the midpoint it is already almost settled
    expect(springEasing(0.1)).toBeLessThan(0.3);     // but it starts with a ramp, not a jump
  });
  it("SPRING_BEZIER approximates the spring within 0.04 (the exported code uses it)", () => {
    const f = cubicBezier(...SPRING_BEZIER);
    for (let i = 1; i < 100; i++) expect(Math.abs(f(i / 100) - springEasing(i / 100))).toBeLessThan(0.04);
  });
});

describe("sampleTrack", () => {
  it("holds the first value before and the last after", () => {
    const t = { keyframes: [kf(100, 5), kf(300, 9)] };
    expect(sampleTrack(t, -50)).toBe(5);
    expect(sampleTrack(t, 0)).toBe(5);
    expect(sampleTrack(t, 100)).toBe(5);
    expect(sampleTrack(t, 300)).toBe(9);
    expect(sampleTrack(t, 9999)).toBe(9);
  });
  it("a single keyframe is a constant", () => {
    for (const x of [-1, 0, 1, 1e6]) expect(sampleTrack({ keyframes: [kf(50, 7)] }, x)).toBe(7);
  });
  it("interpolates linearly with empty easing", () => {
    const t = { keyframes: [kf(0, 0), kf(1000, 100)] };
    near(sampleTrack(t, 250), 25);
    near(sampleTrack(t, 500), 50);
  });
  it("uses the easing of the keyframe that OPENS the segment, per segment", () => {
    const t = { keyframes: [kf(0, 0, "easeIn"), kf(100, 10, "easeOut"), kf(200, 0)] };
    // first segment easeIn: at the midpoint below the line
    expect(sampleTrack(t, 50)).toBeLessThan(5);
    // second segment easeOut (10 -> 0): at the midpoint it is already past halfway
    expect(sampleTrack(t, 150)).toBeLessThan(5);
    near(sampleTrack(t, 100), 10);
    near(sampleTrack(t, 200), 0);
  });
  it("keyframes with the same time = step: at that time the last one wins", () => {
    const t = { keyframes: [kf(0, 0), kf(50, 10), kf(50, 30), kf(100, 0)] };
    near(sampleTrack(t, 49.999), 10, 0.01);
    expect(sampleTrack(t, 50)).toBe(30);
    near(sampleTrack(t, 75), 15);
  });
  it("track without keyframes: NaN (and sampleClip skips it)", () => {
    expect(sampleTrack({ keyframes: [] }, 10)).toBeNaN();
    expect(sampleClip({ tracks: [{ nodeId: "a", prop: "x", keyframes: [] }] }, 0).size).toBe(0);
  });
  it("many long tracks: binary search correct everywhere", () => {
    const keyframes = Array.from({ length: 101 }, (_, i) => kf(i * 10, i));
    for (let t = 0; t <= 1000; t += 3) near(sampleTrack({ keyframes }, t), t / 10, 1e-9);
  });
});

describe("sampleClip", () => {
  const clip: Pick<ClipLite, "tracks"> = {
    tracks: [
      { nodeId: "a", prop: "opacity", keyframes: [kf(0, 0), kf(100, 1)] },
      { nodeId: "a", prop: "x", keyframes: [kf(0, 0), kf(100, 50)] },
      { nodeId: "b", prop: "rotation", keyframes: [kf(0, 0), kf(100, 90)] },
      { nodeId: "b", prop: "draw", keyframes: [kf(0, 0), kf(100, 1)] },
    ],
  };
  it("groups by node", () => {
    const m = sampleClip(clip, 50);
    expect([...m.keys()]).toEqual(["a", "b"]);
    expect(m.get("a")).toEqual({ opacity: 0.5, x: 25 });
    expect(m.get("b")).toEqual({ rotation: 45, draw: 0.5 });
  });
  it("at the ends and beyond it keeps the values", () => {
    expect(sampleClip(clip, 0).get("a")).toEqual({ opacity: 0, x: 0 });
    expect(sampleClip(clip, 1e9).get("b")).toEqual({ rotation: 90, draw: 1 });
  });
  it("clip without tracks: empty map", () => {
    expect(sampleClip({ tracks: [] }, 10).size).toBe(0);
  });
});

describe("clipTimeline", () => {
  const c = (over: Partial<ClipLite> = {}) => ({ duration: 1000, delay: 0, repeat: 0, yoyo: false, ...over });
  it("without repeats: rises and then is done at the end point", () => {
    expect(clipTimeline(c(), 0)).toEqual({ t: 0, done: false });
    expect(clipTimeline(c(), 400)).toEqual({ t: 400, done: false });
    expect(clipTimeline(c(), 999)).toEqual({ t: 999, done: false });
    expect(clipTimeline(c(), 1000)).toEqual({ t: 1000, done: true });
    expect(clipTimeline(c(), 5000)).toEqual({ t: 1000, done: true });
  });
  it("negative or NaN time: still at 0", () => {
    expect(clipTimeline(c(), -10)).toEqual({ t: 0, done: false });
    expect(clipTimeline(c(), NaN)).toEqual({ t: 0, done: false });
  });
  it("the delay holds the clip at 0 and then starts it", () => {
    const k = c({ delay: 300 });
    expect(clipTimeline(k, 100)).toEqual({ t: 0, done: false });
    expect(clipTimeline(k, 300)).toEqual({ t: 0, done: false });
    expect(clipTimeline(k, 800)).toEqual({ t: 500, done: false });
    expect(clipTimeline(k, 1300)).toEqual({ t: 1000, done: true });
  });
  it("finite repeat: restarts from 0 on every cycle, done after the last", () => {
    const k = c({ repeat: 2 });                      // 3 cycles in total
    expect(clipTimeline(k, 1500)).toEqual({ t: 500, done: false });
    expect(clipTimeline(k, 2250)).toEqual({ t: 250, done: false });
    expect(clipTimeline(k, 2999)).toEqual({ t: 999, done: false });
    expect(clipTimeline(k, 3000)).toEqual({ t: 1000, done: true });
  });
  it("yoyo: odd cycles go backwards", () => {
    const k = c({ repeat: 1, yoyo: true });          // there + back
    expect(clipTimeline(k, 250)).toEqual({ t: 250, done: false });
    expect(clipTimeline(k, 1250)).toEqual({ t: 750, done: false });
    expect(clipTimeline(k, 1999)).toEqual({ t: 1, done: false });
    expect(clipTimeline(k, 2000)).toEqual({ t: 0, done: true });   // the last cycle is a return
  });
  it("yoyo with an odd number of cycles ends on the end point", () => {
    const k = c({ repeat: 2, yoyo: true });          // su, giu', su
    expect(clipTimeline(k, 2500)).toEqual({ t: 500, done: false });
    expect(clipTimeline(k, 3000)).toEqual({ t: 1000, done: true });
  });
  it("infinite repeat: never done, keeps cycling (even yoyo)", () => {
    const k = c({ repeat: -1 });
    expect(clipTimeline(k, 1e9 + 250)).toEqual({ t: 250, done: false });
    const y = c({ repeat: -1, yoyo: true });
    expect(clipTimeline(y, 1250)).toEqual({ t: 750, done: false });
    expect(clipTimeline(y, 2250)).toEqual({ t: 250, done: false });
    expect(clipTimeline(y, 1e7).done).toBe(false);
  });
  it("infinite repeat with delay", () => {
    const k = c({ repeat: -1, delay: 500 });
    expect(clipTimeline(k, 400)).toEqual({ t: 0, done: false });
    expect(clipTimeline(k, 1750)).toEqual({ t: 250, done: false });
  });
  it("invalid duration: does not throw and does not advance", () => {
    expect(clipTimeline(c({ duration: 0 }), 100)).toEqual({ t: 0, done: false });
  });
});
