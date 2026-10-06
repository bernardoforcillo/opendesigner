import { describe, it, expect } from "vitest";
import type { ClipLite } from "../store/types";
import { baseScene, child } from "../flow/testSupport";
import { nodesWith } from "../store/nodeMap";
import { isValidClip } from "./validate";

const SCENE = baseScene();
const valid = (c: ClipLite) => isValidClip(SCENE, c);
import {
  SNAP_MS, addKeyframe, addPropertyTrack, addTrack, clipsForSelection, defaultTargetId, deleteKeyframes, dragDelta,
  duplicateKeyframes, formatClock, formatTime, isInside, moveKeyframes, propsFor, recordChanges, removeTrack, rulerStep,
  rulerTicks, snapTime, unwrapDegrees, updateKeyframe, valueAt, withDuration, type KeyRef,
} from "./timelineLogic";

const clip = (over: Partial<ClipLite> = {}): ClipLite => ({
  id: "k", name: "k", duration: 1000, trigger: "enter", delay: 0, repeat: 0, yoyo: false, targetId: "A",
  tracks: [
    { nodeId: "btn", prop: "opacity", keyframes: [{ time: 0, value: 0, easing: "" }, { time: 400, value: 0.5, easing: "easeOut" }, { time: 1000, value: 1, easing: "" }] },
    { nodeId: "btn", prop: "x", keyframes: [{ time: 200, value: 10, easing: "" }, { time: 600, value: 50, easing: "" }] },
  ],
  ...over,
});
const times = (c: ClipLite, ti: number) => c.tracks[ti].keyframes.map((k) => k.time);
const ref = (track: number, key: number): KeyRef => ({ track, key });

describe("snapTime", () => {
  // [t, others, opts, expected]
  const table: [number, number[], { free?: boolean; thresholdMs?: number }, number][] = [
    [123, [], {}, 120],
    [126, [], {}, 130],
    [123, [128], {}, 128], // another keyframe within the threshold wins over the grid
    [123, [140], {}, 120], // outside the threshold: grid
    [123, [128, 126], {}, 126], // the closest among several targets
    [123, [], { free: true }, 123],
    [123.4, [128], { free: true }, 123], // free: no snap, rounded to the ms
    [-50, [], {}, 0],
    [5000, [], {}, 1000],
    [123, [140], { thresholdMs: 30 }, 140],
  ];
  it.each(table)("snapTime(%f, %j, %j) = %f", (t, others, opts, want) => {
    expect(snapTime(t, 1000, others, opts)).toBe(want);
  });
});

describe("moveKeyframes (drag)", () => {
  it("moves a keyframe; the result is a valid clip", () => {
    const r = moveKeyframes(clip(), [ref(0, 1)], 300); // 400 -> 700
    expect(times(r.clip, 0)).toEqual([0, 700, 1000]);
    expect(r.clip.tracks[0].keyframes[1].value).toBe(0.5);
    expect(valid(r.clip)).toBe(true);
  });

  it("past the end the delta is limited and the keyframe at the end is replaced", () => {
    const r = moveKeyframes(clip(), [ref(0, 1)], 700); // 400 -> 1100: limit 600, lands on 1000
    expect(times(r.clip, 0)).toEqual([0, 1000]);
    expect(r.clip.tracks[0].keyframes[1].value).toBe(0.5);
  });

  it("does not leave [0, duration]: the delta is limited", () => {
    const r = moveKeyframes(clip(), [ref(1, 0), ref(1, 1)], 900);
    expect(times(r.clip, 1)).toEqual([600, 1000]); // the group stops when the last one touches the end
    const l = moveKeyframes(clip(), [ref(1, 0), ref(1, 1)], -900);
    expect(times(l.clip, 1)).toEqual([0, 400]);
  });

  it("a group moves by the same step (the distances remain)", () => {
    const r = moveKeyframes(clip(), [ref(0, 0), ref(1, 0)], 100);
    expect(times(r.clip, 0)).toEqual([100, 400, 1000]);
    expect(times(r.clip, 1)).toEqual([300, 600]);
    expect(r.sel).toEqual([ref(0, 0), ref(1, 0)]);
  });

  it("jumping over another keyframe reorders and updates the selection", () => {
    const r = moveKeyframes(clip(), [ref(0, 0)], 500); // 0 -> 500, supera 400
    expect(times(r.clip, 0)).toEqual([400, 500, 1000]);
    expect(r.sel).toEqual([ref(0, 1)]);
  });

  it("landing on a NON-selected keyframe replaces it", () => {
    const r = moveKeyframes(clip(), [ref(0, 0)], 400);
    expect(times(r.clip, 0)).toEqual([400, 1000]);
    expect(r.clip.tracks[0].keyframes[0].value).toBe(0); // the value is that of the moved keyframe
    expect(r.sel).toEqual([ref(0, 0)]);
  });

  it("delta 0 or empty selection: the same clip", () => {
    const c = clip();
    expect(moveKeyframes(c, [ref(0, 0)], 0).clip).toBe(c);
    expect(moveKeyframes(c, [], 50).clip).toBe(c);
  });

  it("does not mutate the starting clip", () => {
    const c = clip();
    const before = JSON.stringify(c);
    moveKeyframes(c, [ref(0, 1)], 100);
    expect(JSON.stringify(c)).toBe(before);
  });
});

describe("dragDelta: snap during the drag", () => {
  it("to the grid", () => {
    expect(dragDelta(clip(), [ref(0, 1)], ref(0, 1), 33)).toBe(30); // 400 + 33 = 433 -> 430
  });
  it("to the other keyframes (not to those of the moving group)", () => {
    // the keyframe at 400 of track 0 towards 600 (keyframe 1 of the x track): snaps to 600 even at 596
    expect(dragDelta(clip(), [ref(0, 1)], ref(0, 1), 196)).toBe(200);
  });
  it("Shift = free", () => {
    expect(dragDelta(clip(), [ref(0, 1)], ref(0, 1), 33, { free: true })).toBe(33);
  });
  it("to the extra targets (the playhead)", () => {
    expect(dragDelta(clip(), [ref(0, 1)], ref(0, 1), 96, { extra: [500] })).toBe(100);
  });
  it("a nonexistent reference moves nothing", () => {
    expect(dragDelta(clip(), [ref(9, 9)], ref(9, 9), 50)).toBe(0);
  });
});

describe("add / delete / duplicate keyframes", () => {
  it("addKeyframe inserts in order with the given value", () => {
    const r = addKeyframe(clip(), 1, 400, 30);
    expect(times(r.clip, 1)).toEqual([200, 400, 600]);
    expect(r.ref).toEqual(ref(1, 1));
    expect(r.clip.tracks[1].keyframes[1].value).toBe(30);
    expect(valid(r.clip)).toBe(true);
  });
  it("at an already occupied time it changes the value instead of doubling", () => {
    const r = addKeyframe(clip(), 1, 200, 99);
    expect(r.clip.tracks[1].keyframes).toHaveLength(2);
    expect(r.clip.tracks[1].keyframes[0].value).toBe(99);
  });
  it("keeps opacity and draw in 0..1 and the time within the duration", () => {
    const r = addKeyframe(clip(), 0, 5000, 7);
    const last = r.clip.tracks[0].keyframes.at(-1)!;
    expect(last.time).toBe(1000);
    expect(last.value).toBe(1);
  });
  it("deleteKeyframes removes the selected ones and the track that is left empty", () => {
    const c = deleteKeyframes(clip(), [ref(1, 0), ref(1, 1), ref(0, 1)]);
    expect(c.tracks).toHaveLength(1);
    expect(times(c, 0)).toEqual([0, 1000]);
    expect(valid(c)).toBe(true);
  });
  it("duplicateKeyframes: the copy of the first lands at the given time, the others keep the distances", () => {
    const r = duplicateKeyframes(clip(), [ref(1, 0), ref(1, 1)], 500);
    // 200 -> 500, 600 -> 900; the old 200 and 600 remain
    expect(times(r.clip, 1)).toEqual([200, 500, 600, 900]);
    expect(r.sel.map((s) => r.clip.tracks[s.track].keyframes[s.key].time)).toEqual([500, 900]);
    expect(valid(r.clip)).toBe(true);
  });
  it("the copy is brought inside the duration", () => {
    const r = duplicateKeyframes(clip(), [ref(1, 0), ref(1, 1)], 900); // the pair is 400 wide: it would end at 1300
    expect(Math.max(...times(r.clip, 1))).toBe(1000);
  });
  it("a copy that lands on a keyframe replaces it", () => {
    const r = duplicateKeyframes(clip(), [ref(1, 0)], 600);
    expect(times(r.clip, 1)).toEqual([200, 600]);
    expect(r.clip.tracks[1].keyframes[1].value).toBe(10);
  });
});

describe("updateKeyframe", () => {
  it("changes value and easing without moving it", () => {
    const r = updateKeyframe(clip(), ref(0, 1), { value: 0.9, easing: "cubic-bezier(0.1,0.2,0.3,0.4)" });
    expect(r.clip.tracks[0].keyframes[1]).toEqual({ time: 400, value: 0.9, easing: "cubic-bezier(0.1,0.2,0.3,0.4)" });
    expect(r.ref).toEqual(ref(0, 1));
    expect(valid(r.clip)).toBe(true);
  });
  it("changing the time reorders and rejects out-of-range values", () => {
    const r = updateKeyframe(clip(), ref(0, 0), { time: 700, value: 4 });
    expect(times(r.clip, 0)).toEqual([400, 700, 1000]);
    expect(r.clip.tracks[0].keyframes[1].value).toBe(1);
    expect(r.ref).toEqual(ref(0, 1));
  });
});

describe("tracks and duration", () => {
  it("addTrack does not duplicate the (node, property) pair", () => {
    const c = clip();
    expect(addTrack(c, "btn", "x", 0)).toBe(c);
    const n = addTrack(c, "btn", "y", 5, 300);
    expect(n.tracks).toHaveLength(3);
    expect(n.tracks[2].keyframes).toEqual([{ time: 300, value: 5, easing: "easeInOut" }]);
  });
  it("addPropertyTrack: two keyframes with the base value (draw goes from 0 to 1)", () => {
    const base = { id: "btn", x: 60, y: 200, rotation: 0, opacity: 0.8 };
    const o = addPropertyTrack(clip({ tracks: [] }), base, "opacity");
    expect(o.tracks[0].keyframes.map((k) => [k.time, k.value])).toEqual([[0, 0.8], [1000, 0.8]]);
    const d = addPropertyTrack(clip({ tracks: [] }), base, "draw");
    expect(d.tracks[0].keyframes.map((k) => [k.time, k.value])).toEqual([[0, 0], [1000, 1]]);
    const s = addPropertyTrack(clip({ tracks: [] }), base, "scale");
    expect(s.tracks[0].keyframes.map((k) => k.value)).toEqual([1, 1]);
    expect(valid(o)).toBe(true);
  });
  it("removeTrack", () => {
    expect(removeTrack(clip(), 0).tracks.map((t) => t.prop)).toEqual(["x"]);
  });
  it("withDuration brings to the end the keyframes that exceed it and stays valid", () => {
    const c = withDuration(clip(), 500);
    expect(c.duration).toBe(500);
    expect(times(c, 0)).toEqual([0, 400, 500]);
    expect(valid(c)).toBe(true);
    const d = withDuration(clip({ tracks: [{ nodeId: "btn", prop: "x", keyframes: [{ time: 800, value: 1, easing: "" }, { time: 900, value: 2, easing: "" }] }] }), 500);
    expect(d.tracks[0].keyframes).toEqual([{ time: 500, value: 2, easing: "" }]);
  });
  it("valueAt samples the track (with the easing)", () => {
    expect(valueAt(clip(), 1, 400)).toBeCloseTo(30);
    expect(valueAt(clip(), 5, 0)).toBeUndefined();
  });
  it("propsFor: draw only for nodes with a path", () => {
    expect(propsFor({ kind: "text" })).not.toContain("draw");
    expect(propsFor({ kind: "vector" })).toContain("draw");
    expect(propsFor({ kind: "group" })).toEqual(["opacity", "x", "y", "scale", "rotation"]);
  });
});

describe("recordChanges (maps the changes into keyframes at the playhead)", () => {
  const before = (_id: string, prop: string) => ({ x: 60, y: 200, opacity: 1, rotation: 0 })[prop as "x"];

  it("new track at t > 0: keyframe at 0 with the previous value + keyframe at t with the new one", () => {
    const r = recordChanges(clip({ tracks: [] }), [{ nodeId: "btn", prop: "x", value: 300 }], 600, before);
    expect(r.tracks).toHaveLength(1);
    expect(r.tracks[0].keyframes.map((k) => [k.time, k.value])).toEqual([[0, 60], [600, 300]]);
    expect(valid(r)).toBe(true);
  });
  it("new track at t = 0: a single keyframe", () => {
    const r = recordChanges(clip({ tracks: [] }), [{ nodeId: "btn", prop: "x", value: 300 }], 0, before);
    expect(r.tracks[0].keyframes.map((k) => [k.time, k.value])).toEqual([[0, 300]]);
  });
  it("existing track: inserts the keyframe, or changes the one already there at that time", () => {
    const a = recordChanges(clip(), [{ nodeId: "btn", prop: "x", value: 99 }], 400, before);
    expect(a.tracks[1].keyframes.map((k) => [k.time, k.value])).toEqual([[200, 10], [400, 99], [600, 50]]);
    const b = recordChanges(clip(), [{ nodeId: "btn", prop: "x", value: 99 }], 600, before);
    expect(b.tracks[1].keyframes.map((k) => [k.time, k.value])).toEqual([[200, 10], [600, 99]]);
  });
  it("several properties at once are separate tracks; the time is rounded and limited", () => {
    const r = recordChanges(clip({ tracks: [] }), [
      { nodeId: "btn", prop: "x", value: 1 }, { nodeId: "btn", prop: "y", value: 2 }, { nodeId: "btn", prop: "opacity", value: 3 },
    ], 333.6, before);
    expect(r.tracks.map((t) => t.prop)).toEqual(["x", "y", "opacity"]);
    expect(r.tracks.every((t) => t.keyframes[1].time === 334)).toBe(true);
    expect(r.tracks[2].keyframes[1].value).toBe(1); // opacity clamped
    expect(valid(r)).toBe(true);
  });
  it("unknown previous value: a single keyframe at t", () => {
    const r = recordChanges(clip({ tracks: [] }), [{ nodeId: "btn", prop: "x", value: 5 }], 500, () => undefined);
    expect(r.tracks[0].keyframes.map((k) => [k.time, k.value])).toEqual([[500, 5]]);
  });
});

describe("unwrapDegrees", () => {
  const table: [number, number, number][] = [
    [10, 350, 370], // after 350° you reach 10° moving forward: 370
    [350, 10, -10],
    [90, 80, 90],
    [0, 720, 720],
    [30, 30, 30],
  ];
  it.each(table)("unwrapDegrees(%f, %f) = %f", (deg, ref, want) => expect(unwrapDegrees(deg, ref)).toBe(want));
});

describe("righello", () => {
  it("the step grows when zooming out", () => {
    expect(rulerStep(1)).toBe(100); // 1 px/ms: 100 ms = 100 px >= 64
    expect(rulerStep(0.1)).toBe(1000);
    expect(rulerStep(10)).toBe(10);
    expect(rulerStep(0.0001)).toBe(300_000);
  });
  it("the ticks cover the interval and the major ones fall on multiples of the step", () => {
    const ticks = rulerTicks(0.5, 0, 1000); // passo 200
    expect(ticks[0]).toEqual({ t: 0, major: true });
    expect(ticks.filter((t) => t.major).map((t) => t.t)).toEqual([0, 200, 400, 600, 800, 1000]);
    expect(ticks.at(-1)!.t).toBeLessThanOrEqual(1000 + 1e-6);
  });
  it("formati", () => {
    expect(formatTime(250)).toBe("250 ms");
    expect(formatTime(1200)).toBe("1.2 s");
    expect(formatTime(65_000)).toBe("1:05");
    expect(formatClock(1250)).toBe("0:01.250");
    expect(formatClock(-5)).toBe("0:00.000");
  });
});

describe("target and selection", () => {
  const scene = () => {
    const s = baseScene();
    return {
      ...s,
      nodes: nodesWith(s.nodes, {
        grp: { ...child("grp", "A", 0, 0), kind: "group" },
        inner: child("inner", "grp", 5, 5),
      }),
    };
  };
  it("defaultTargetId: the closest container (the node itself if it is one)", () => {
    const s = scene();
    expect(defaultTargetId(s, ["btn"])).toBe("A");
    expect(defaultTargetId(s, ["inner"])).toBe("grp");
    expect(defaultTargetId(s, ["A"])).toBe("A");
    expect(defaultTargetId(s, ["loose"])).toBe("loose"); // without containers: the node itself
    expect(defaultTargetId(s, [])).toBe("");
  });
  it("isInside", () => {
    const s = scene();
    expect(isInside(s, "inner", "A")).toBe(true);
    expect(isInside(s, "A", "A")).toBe(true);
    expect(isInside(s, "btn", "B")).toBe(false);
  });
  it("clipsForSelection: by target or by track; empty selection = all", () => {
    const s = scene();
    const ca = clip({ id: "ca", name: "a", targetId: "A", tracks: [] });
    const cb = clip({ id: "cb", name: "b", targetId: "B", tracks: [] });
    const cl = clip({ id: "cl", name: "c", targetId: "B", tracks: [{ nodeId: "btn", prop: "x", keyframes: [{ time: 0, value: 1, easing: "" }] }] });
    const withClips = { ...s, clips: { ca, cb, cl } };
    expect(clipsForSelection(withClips, []).map((c) => c.id)).toEqual(["ca", "cb", "cl"]);
    expect(clipsForSelection(withClips, ["btn"]).map((c) => c.id)).toEqual(["ca", "cl"]);
    expect(clipsForSelection(withClips, ["inner"]).map((c) => c.id)).toEqual(["ca"]);
  });
});

describe("costanti", () => {
  it("the grid is 10 ms", () => expect(SNAP_MS).toBe(10));
});
