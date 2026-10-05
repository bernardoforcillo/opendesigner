import { describe, it, expect } from "vitest";
import { baseScene } from "../flow/testSupport";
import type { ClipLite, SceneState } from "../store/types";
import { asPlayed, autoClipsForScreen, clipsUnder, pointerClipsForScreen, sampleRuns, startRuns } from "./runtime";

const clip = (id: string, over: Partial<ClipLite> = {}): ClipLite => ({
  id, name: id, duration: 1000, trigger: "enter", delay: 0, repeat: 0, yoyo: false, targetId: "A",
  tracks: [{ nodeId: "btn", prop: "opacity", keyframes: [{ time: 0, value: 0, easing: "" }, { time: 1000, value: 1, easing: "" }] }],
  ...over,
});
const withClips = (...cs: ClipLite[]): SceneState => ({ ...baseScene(), clips: Object.fromEntries(cs.map((c) => [c.id, c])) });

describe("which clips start with the screen", () => {
  it("enter and loop whose target is the screen or lies inside it; not those of another screen nor without tracks", () => {
    const s = withClips(
      clip("e"), clip("l", { trigger: "loop" }), clip("h", { trigger: "hover" }),
      clip("other", { targetId: "B" }), clip("empty", { tracks: [] }), clip("inner", { targetId: "btn" }),
    );
    expect(autoClipsForScreen(s, "A").map((c) => c.id)).toEqual(["e", "inner", "l"]);
    expect(autoClipsForScreen(s, "B").map((c) => c.id)).toEqual(["other"]);
    expect(pointerClipsForScreen(s, "A", "hover").map((c) => c.id)).toEqual(["h"]);
    expect(pointerClipsForScreen(s, "A", "tap")).toEqual([]);
  });

  it("clipsUnder: the point inside the target's world box", () => {
    const s = withClips(clip("h", { trigger: "hover", targetId: "btn" }), clip("f", { trigger: "hover", targetId: "A" }));
    const cs = Object.values(s.clips);
    // btn sits in A at (60,200) 80x30; A is at (0,0) 200x300
    expect(clipsUnder(s, cs, 70, 210).map((c) => c.id).sort()).toEqual(["f", "h"]);
    expect(clipsUnder(s, cs, 10, 10).map((c) => c.id)).toEqual(["f"]);
    expect(clipsUnder(s, cs, 500, 500)).toEqual([]);
  });
});

describe("sampleRuns", () => {
  it("samples with the elapsed time and says whether something is still running", () => {
    const runs = startRuns([clip("e")], 1000);
    const a = sampleRuns(runs, 1500);
    expect(a.anim.get("btn")!.opacity).toBeCloseTo(0.5);
    expect(a.live).toBe(true);
  });

  it("a finished clip STAYS on its last value and is no longer live", () => {
    const runs = startRuns([clip("e")], 0);
    const a = sampleRuns(runs, 5000);
    expect(a.anim.get("btn")!.opacity).toBe(1);
    expect(a.live).toBe(false);
  });

  it("before the delay the first keyframe holds (fill backwards)", () => {
    const a = sampleRuns(startRuns([clip("e", { delay: 500 })], 0), 100);
    expect(a.anim.get("btn")!.opacity).toBe(0);
    expect(a.live).toBe(true);
  });

  it("loop never ends; yoyo with repeat goes back", () => {
    const l = sampleRuns(startRuns([clip("l", { trigger: "loop" })], 0), 1_000_000 + 250);
    expect(l.live).toBe(true);
    expect(l.anim.get("btn")!.opacity).toBeCloseTo(0.25);
    const y = sampleRuns(startRuns([clip("y", { yoyo: true, repeat: 1 })], 0), 1250);
    expect(y.anim.get("btn")!.opacity).toBeCloseTo(0.75);
  });

  it("several clips: the last ones win on the same property", () => {
    const hold = clip("b", { tracks: [{ nodeId: "btn", prop: "opacity", keyframes: [{ time: 0, value: 0.3, easing: "" }] }] });
    const a = sampleRuns(startRuns([clip("a"), hold], 0), 500);
    expect(a.anim.get("btn")!.opacity).toBe(0.3);
  });

  it("no runs: nothing to sample", () => {
    const a = sampleRuns([], 10);
    expect(a.anim.size).toBe(0);
    expect(a.live).toBe(false);
  });

  it("asPlayed: loop = infinite, does not mutate the original", () => {
    const c = clip("l", { trigger: "loop" });
    expect(asPlayed(c).repeat).toBe(-1);
    expect(c.repeat).toBe(0);
    const e = clip("e");
    expect(asPlayed(e)).toBe(e);
  });
});
