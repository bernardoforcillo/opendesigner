import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { baseScene } from "../flow/testSupport";
import { useScene } from "../store/store";
import type { ClipLite, SceneState } from "../store/types";
import { makeSetPropsOp } from "../tools/ops";
import { recordFinal, recordPreview, propChangesOfOps, setRecordHook } from "./recordHook";
import {
  addPropertyTracks, commitClip, createClip, duplicateClipOp, removeClip, useTimeline,
} from "./timelineStore";
import { isPosing, posedScene } from "./posedScene";
import { isValidClip } from "./validate";

const clip = (over: Partial<ClipLite> = {}): ClipLite => ({
  id: "k", name: "k", duration: 1000, trigger: "enter", delay: 0, repeat: 0, yoyo: false, targetId: "A",
  tracks: [{ nodeId: "btn", prop: "opacity", keyframes: [{ time: 0, value: 0, easing: "" }, { time: 1000, value: 1, easing: "" }] }],
  ...over,
});

function install(s: SceneState = { ...baseScene(), clips: { k: clip() } }) {
  useScene.setState({ undoStack: [], redoStack: [], gesture: null, sync: null, selection: [] });
  useScene.getState().setScene(s);
}
const sc = () => useScene.getState().scene!;
const tl = () => useTimeline.getState();

beforeEach(() => {
  setRecordHook(null);
  useTimeline.setState({
    open: false, clipId: null, playhead: 0, playing: false, loop: false, speed: 1, record: false, posed: false,
    zoom: 1, selection: [], draftClip: null, recordDraft: null, collapsed: false,
  });
  install();
});
afterEach(() => {
  tl().setOpen(false);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("recording OFF: the hook is not there and nothing changes", () => {
  it("the two doors are the identity", () => {
    const ops = [makeSetPropsOp("btn", { x: 5 }, ["x"])];
    expect(recordPreview(ops[0])).toBe(false);
    expect(recordFinal(ops)).toBe(ops); // the SAME array
  });

  it("a normal drag changes the node, not the clip", () => {
    const st = useScene.getState();
    st.beginGesture();
    st.applyLocal(makeSetPropsOp("btn", { x: 300, y: 7 }, ["x", "y"]));
    expect(sc().nodes.at("btn").x).toBe(300);
    st.endGesture([makeSetPropsOp("btn", { x: 300, y: 7 }, ["x", "y"])]);
    expect(sc().nodes.at("btn").x).toBe(300);
    expect(sc().clips.k).toEqual(clip());
  });

  it("even with the clip open, as long as Record is off", () => {
    tl().openClip("k");
    const st = useScene.getState();
    st.beginGesture();
    st.endGesture([makeSetPropsOp("btn", { x: 300 }, ["x"])]);
    expect(sc().nodes.at("btn").x).toBe(300);
    expect(sc().clips.k.tracks).toHaveLength(1);
  });
});

describe("propChangesOfOps", () => {
  const sp = (paths: string[], patch: object = { x: 1, y: 2, rotation: 3, opacity: 0.5 }) =>
    makeSetPropsOp("n", patch, paths as never);
  it("recordable: setProps with only the x/y/rotation/opacity mask", () => {
    expect(propChangesOfOps([sp(["x", "y"])])).toEqual([{ nodeId: "n", prop: "x", value: 1 }, { nodeId: "n", prop: "y", value: 2 }]);
    expect(propChangesOfOps([sp(["opacity"])])).toEqual([{ nodeId: "n", prop: "opacity", value: 0.5 }]);
    expect(propChangesOfOps([sp(["x", "y", "rotation"])])).toHaveLength(3);
  });
  it("all or nothing: one non-recordable field is enough", () => {
    expect(propChangesOfOps([sp(["x", "width"], { x: 1, width: 5 })])).toBeNull();
    expect(propChangesOfOps([sp(["x"]), sp(["height"], { height: 3 })])).toBeNull();
    expect(propChangesOfOps([])).toBeNull();
  });
});

describe("registrazione ON", () => {
  beforeEach(() => {
    tl().openClip("k");
    tl().setPlayhead(600);
    tl().setRecord(true);
  });

  it("the preview goes into the draft and does not touch the node; the canvas shows the draft", () => {
    const st = useScene.getState();
    st.beginGesture();
    st.applyLocal(makeSetPropsOp("btn", { x: 300, y: 70 }, ["x", "y"]));
    expect(sc().nodes.at("btn").x).toBe(60);
    expect(tl().recordDraft?.get("btn")).toEqual({ x: 300, y: 70 });
    expect(posedScene()!.nodes.at("btn").x).toBe(300);
    expect(isPosing()).toBe(true);
  });

  it("the release writes ONE SetClip: keyframe at the playhead (with the starting point at 0) and node intact", () => {
    const st = useScene.getState();
    st.beginGesture();
    st.applyLocal(makeSetPropsOp("btn", { x: 300, y: 70 }, ["x", "y"]));
    st.endGesture([makeSetPropsOp("btn", { x: 300, y: 70 }, ["x", "y"])]);
    const c = sc().clips.k;
    const x = c.tracks.find((t) => t.prop === "x")!;
    expect(x.keyframes.map((k) => [k.time, k.value])).toEqual([[0, 60], [600, 300]]);
    expect(c.tracks.find((t) => t.prop === "y")!.keyframes.map((k) => [k.time, k.value])).toEqual([[0, 200], [600, 70]]);
    expect(sc().nodes.at("btn").x).toBe(60);
    expect(isValidClip(sc(), c)).toBe(true);
    expect(tl().recordDraft).toBeNull();
    // a single undo step for the whole gesture
    expect(useScene.getState().undoStack).toHaveLength(1);
    useScene.getState().undo();
    expect(sc().clips.k).toEqual(clip());
  });

  it("opacity: records on the existing track without touching the other keyframes", () => {
    const st = useScene.getState();
    st.beginGesture();
    st.endGesture([makeSetPropsOp("btn", { opacity: 0.2 }, ["opacity"])]);
    expect(sc().clips.k.tracks[0].keyframes.map((k) => [k.time, k.value])).toEqual([[0, 0], [600, 0.2], [1000, 1]]);
  });

  it("rotation does not jump over 0/360: records the determination that does not jump", () => {
    useTimeline.getState().setPlayhead(0);
    const st = useScene.getState();
    st.beginGesture();
    st.endGesture([makeSetPropsOp("btn", { rotation: 350 }, ["rotation"])]);
    useTimeline.getState().setPlayhead(500);
    st.beginGesture();
    st.endGesture([makeSetPropsOp("btn", { rotation: 10 }, ["rotation"])]);
    const rot = sc().clips.k.tracks.find((t) => t.prop === "rotation")!;
    // 0 -> 350 is a step of -10 (the shortest), then 10 is +20 forward: never a whole turn backwards
    expect(rot.keyframes.map((k) => k.value)).toEqual([-10, 10]);
  });

  it("a gesture with something else in it (resize) passes through as is: the node changes and the clip does not", () => {
    const st = useScene.getState();
    st.beginGesture();
    st.endGesture([makeSetPropsOp("btn", { x: 1, width: 99 }, ["x", "width"])]);
    expect(sc().nodes.at("btn").width).toBe(99);
    expect(sc().clips.k.tracks).toHaveLength(1);
  });

  it("a node OUTSIDE the target is modified normally", () => {
    const st = useScene.getState();
    st.beginGesture();
    st.applyLocal(makeSetPropsOp("loose", { x: 77 }, ["x"]));
    expect(sc().nodes.at("loose").x).toBe(77);
    st.endGesture([makeSetPropsOp("loose", { x: 77 }, ["x"])]);
    expect(sc().clips.k.tracks).toHaveLength(1);
  });

  it("Esc mid-gesture: the draft is thrown away and nothing is written", () => {
    const st = useScene.getState();
    st.beginGesture();
    st.applyLocal(makeSetPropsOp("btn", { x: 300 }, ["x"]));
    expect(tl().recordDraft).not.toBeNull();
    st.cancelGesture();
    expect(tl().recordDraft).toBeNull();
    expect(sc().clips.k.tracks).toHaveLength(1);
  });

  it("turning Record off restores the identity", () => {
    tl().setRecord(false);
    const ops = [makeSetPropsOp("btn", { x: 5 }, ["x"])];
    expect(recordFinal(ops)).toBe(ops);
  });

  it("without an open clip it cannot be armed", () => {
    tl().setRecord(false);
    tl().openClip(null);
    tl().setRecord(true);
    expect(tl().record).toBe(false);
  });
});

describe("writes to the document: one op per gesture", () => {
  it("createClip / duplicate / delete", () => {
    const before = useScene.getState().undoStack.length;
    const c = createClip(sc(), ["btn"])!;
    expect(c.targetId).toBe("A");
    expect(sc().clips[c.id]).toBeDefined();
    expect(tl().clipId).toBe(c.id);
    expect(useScene.getState().undoStack.length).toBe(before + 1);
    duplicateClipOp(sc(), "k");
    expect(Object.keys(sc().clips)).toHaveLength(3);
    tl().openClip(c.id);
    removeClip(c.id);
    expect(sc().clips[c.id]).toBeUndefined();
    expect(tl().clipId).toBeNull();
  });

  it("addPropertyTracks: without an open clip it creates one; with one it fills it; skips nodes outside the target", () => {
    const n = addPropertyTracks(sc(), ["btn"], "scale");
    expect(n).toBe(1);
    const created = Object.values(sc().clips).find((c) => c.id !== "k")!;
    expect(created.tracks.map((t) => t.prop)).toEqual(["scale"]);
    expect(tl().clipId).toBe(created.id);
    // the same property again: nothing to add
    expect(addPropertyTracks(sc(), ["btn"], "scale")).toBe(0);
    // a node outside the target (loose sits on the page) is not added
    expect(addPropertyTracks(sc(), ["loose"], "opacity")).toBe(0);
    expect(isValidClip(sc(), sc().clips[created.id])).toBe(true);
  });

  it("commitClip writes the whole clip (upsert)", () => {
    commitClip(clip({ name: "rinominata" }));
    expect(sc().clips.k.name).toBe("rinominata");
  });
});

describe("riproduzione", () => {
  let queue: ((t: number) => void)[] = [];
  let now = 1000;
  beforeEach(() => {
    queue = [];
    now = 1000;
    vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => { queue.push(cb); return queue.length; });
    vi.stubGlobal("cancelAnimationFrame", () => { queue = []; });
    vi.spyOn(performance, "now").mockImplementation(() => now);
    tl().openClip("k");
    queue = [];
  });
  // The loop limits a single jump to 100 ms (background tab): it advances in steps of 50.
  const frame = (dt: number) => {
    for (let left = dt; left > 0; left -= 50) {
      const cb = queue.shift();
      now += Math.min(50, left);
      cb?.(now);
    }
  };

  it("with the timeline stopped it schedules NO frame", () => {
    expect(queue).toHaveLength(0);
    tl().setPlayhead(300);
    tl().stop();
    expect(queue).toHaveLength(0);
    // closing the panel asks for ONE resize (the canvas changes height), then nothing
    tl().setOpen(false);
    queue.splice(0).forEach((cb) => cb(now));
    expect(queue).toHaveLength(0);
  });

  it("play advances the playhead with real time and stops at the end", () => {
    tl().play();
    expect(tl().playing).toBe(true);
    expect(queue).toHaveLength(1);
    frame(250);
    expect(tl().playhead).toBe(250);
    frame(250);
    expect(tl().playhead).toBe(500);
    frame(600);
    expect(tl().playing).toBe(false);
    expect(tl().playhead).toBe(1000);
    expect(queue).toHaveLength(0); // no frames after the end
  });

  it("speed scales the time", () => {
    tl().setSpeed(0.5);
    tl().play();
    frame(400);
    expect(tl().playhead).toBe(200);
    tl().setSpeed(2);
    expect(tl().speed).toBe(2);
    tl().setSpeed(3); // not allowed: goes back to 1
    expect(tl().speed).toBe(1);
  });

  it("loop restarts from the beginning; pause stops the loop; stop resets", () => {
    tl().setLoop(true);
    tl().play();
    frame(1100);
    expect(tl().playing).toBe(true);
    expect(tl().playhead).toBe(100); // it restarted from the beginning at 1000 ms
    expect(queue).toHaveLength(1);
    frame(300);
    tl().pause();
    expect(tl().playing).toBe(false);
    expect(queue).toHaveLength(0);
    tl().stop();
    expect(tl().playhead).toBe(0);
    expect(tl().posed).toBe(false);
  });

  it("the loop trigger runs forever even with repeat 0; yoyo goes back", () => {
    install({ ...baseScene(), clips: { k: clip({ trigger: "loop" }), y: clip({ id: "y", yoyo: true, repeat: 1 }) } });
    tl().openClip("k");
    queue = [];
    tl().play();
    frame(1500);
    expect(tl().playing).toBe(true);
    expect(tl().playhead).toBe(500);
    tl().openClip("y");
    queue = [];
    tl().play();
    frame(1500); // second cycle, backwards: 1500 -> 1000-500
    expect(tl().playhead).toBe(500);
    frame(100);
    expect(tl().playhead).toBe(400);
  });

  it("scrubbing pauses and turns on the pose; closing turns it off", () => {
    tl().play();
    tl().setPlayhead(250);
    expect(tl().playing).toBe(false);
    expect(tl().posed).toBe(true);
    expect(posedScene()!.nodes.at("btn").opacity).toBeCloseTo(0.25);
    expect(sc().nodes.at("btn").opacity).toBe(1);
    tl().setOpen(false);
    expect(isPosing()).toBe(false);
    expect(posedScene()).toBe(sc());
  });

  it("posedScene is memoized on the same (scene, clip, playhead)", () => {
    tl().setPlayhead(100);
    expect(posedScene()).toBe(posedScene());
  });

  it("a drag draft is sampled in place of the document clip", () => {
    tl().setPlayhead(500);
    const before = posedScene()!.nodes.at("btn").opacity;
    tl().setDraftClip(clip({ tracks: [{ nodeId: "btn", prop: "opacity", keyframes: [{ time: 0, value: 0, easing: "" }, { time: 500, value: 1, easing: "" }, { time: 1000, value: 1, easing: "" }] }] }));
    expect(before).toBeCloseTo(0.5);
    expect(posedScene()!.nodes.at("btn").opacity).toBe(1);
  });
});
