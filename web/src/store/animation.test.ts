import { describe, it, expect } from "vitest";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { OpSchema, NodeSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { applyOp, cascadeClips } from "./applyOp";
import { invertOp } from "./history";
import { emptyScene, toClipLite, toPbClip } from "./types";
import type { ClipLite, SceneState } from "./types";
import { isValidClip } from "../animation/validate";

const op = (kind: MessageInitShape<typeof OpSchema>["kind"]): Op => create(OpSchema, { opId: crypto.randomUUID(), docId: "d", kind });
const node = (id: string, parentId = "page1", shape: "rect" | "text" | "vector" | "ellipse" | "frame" = "rect") => op({
  case: "createNode",
  value: {
    node: create(NodeSchema, {
      id, parentId, orderKey: id, name: id, visible: true, opacity: 1, width: 10, height: 10,
      shape: shape === "text" ? { case: "text", value: { content: "x" } }
        : shape === "vector" ? { case: "vector", value: { subpaths: [] } }
        : shape === "frame" ? { case: "frame", value: {} }
        : shape === "ellipse" ? { case: "ellipse", value: {} }
        : { case: "rect", value: {} },
    }),
  },
});
const clip = (over: Partial<ClipLite> = {}): ClipLite => ({
  id: "k1", name: "k", duration: 500, trigger: "hover", delay: 0, repeat: 0, yoyo: false, targetId: "a",
  tracks: [{ nodeId: "b", prop: "opacity", keyframes: [{ time: 0, value: 0, easing: "" }, { time: 500, value: 1, easing: "easeOut" }] }],
  ...over,
});
const setClip = (c: ClipLite) => op({ case: "setClip", value: { clip: toPbClip(c) } });
const delClip = (id: string) => op({ case: "deleteClip", value: { id } });
const delNode = (id: string) => op({ case: "deleteNode", value: { id } });

const build = (ops: Op[]): SceneState => ops.reduce((s, o) => applyOp(s, o), emptyScene("d", "t"));
const base = () => build([node("a"), node("b", "a"), node("t", "a", "text"), node("v", "a", "vector"), setClip(clip())]);

function roundTrip(scene: SceneState, o: Op): SceneState {
  const inv = invertOp(scene, o);
  expect(inv).not.toBeNull();
  const after = applyOp(scene, o);
  expect(after).not.toEqual(scene);
  return (inv as Op[]).reduce((s, i) => applyOp(s, i), after);
}

describe("clip: applyOp", () => {
  it("setClip is an absolute upsert", () => {
    const s = base();
    expect(s.clips.k1.tracks).toHaveLength(1);
    const s2 = applyOp(s, setClip(clip({ tracks: [], name: "nuova" })));
    expect(s2.clips.k1.tracks).toHaveLength(0);
    expect(s2.clips.k1.name).toBe("nuova");
  });

  it("rejected ops leave the scene unchanged (same object)", () => {
    const s = base();
    const tr = (prop: string, ...kfs: [number, number, string?][]) => ({
      nodeId: "b", prop, keyframes: kfs.map(([time, value, easing]) => ({ time, value, easing: easing ?? "" })),
    });
    const bad: ClipLite[] = [
      clip({ id: "" }),
      clip({ duration: 0 }), clip({ duration: -1 }), clip({ duration: NaN }), clip({ duration: Infinity }),
      clip({ delay: -1 }), clip({ delay: NaN }), clip({ repeat: -2 }),
      clip({ trigger: "scroll" }),
      clip({ targetId: "ghost" }), clip({ targetId: "" }),
      clip({ tracks: [{ ...tr("opacity", [0, 0]), nodeId: "ghost" }] }),
      clip({ tracks: [tr("width", [0, 0])] }),
      clip({ tracks: [tr("x")] }),
      clip({ tracks: [tr("x", [-1, 0])] }),
      clip({ tracks: [tr("x", [501, 0])] }),
      clip({ tracks: [tr("x", [300, 0], [200, 1])] }),
      clip({ tracks: [tr("x", [NaN, 0])] }),
      clip({ tracks: [tr("x", [0, NaN])] }),
      clip({ tracks: [tr("x", [0, Infinity])] }),
      clip({ tracks: [tr("opacity", [0, 1.5])] }),
      clip({ tracks: [tr("opacity", [0, -0.1])] }),
      clip({ tracks: [tr("draw", [0, 2])] }),
      clip({ tracks: [tr("x", [0, 0, "bounce"])] }),
      clip({ tracks: [tr("x", [0, 0, "cubic-bezier(0,0,1)"])] }),
      clip({ tracks: [tr("x", [0, 0, "cubic-bezier(2,0,1,1)"])] }),
      clip({ tracks: [tr("x", [0, 0]), tr("x", [0, 1])] }),
      clip({ tracks: [{ ...tr("draw", [0, 0], [500, 1]), nodeId: "t" }] }),
    ];
    for (const c of bad) {
      expect(applyOp(s, setClip(c)), JSON.stringify(c)).toBe(s);
      expect(isValidClip(s, c)).toBe(false);
    }
    expect(applyOp(s, op({ case: "setClip", value: {} }))).toBe(s);
    expect(applyOp(s, delClip("ghost"))).toBe(s);
  });

  it("accepts: valid easings, draw on vector/rect/ellipse/frame, empty trigger, clip without tracks", () => {
    const s = build([node("a"), node("r", "a"), node("e", "a", "ellipse"), node("f", "a", "frame"), node("v", "a", "vector")]);
    const drawAll = clip({
      trigger: "", tracks: ["r", "e", "f", "v"].map((nodeId) => ({
        nodeId, prop: "draw", keyframes: [{ time: 0, value: 0, easing: "cubic-bezier(.4,0,.2,1)" }, { time: 500, value: 1, easing: "spring" }],
      })),
    });
    expect(applyOp(s, setClip(drawAll)).clips.k1.tracks).toHaveLength(4);
    expect(applyOp(s, setClip(clip({ tracks: [] }))).clips.k1.tracks).toHaveLength(0);
  });

  it("deleteClip", () => {
    expect(applyOp(base(), delClip("k1")).clips).toEqual({});
  });

  it("round-trip pb: toClipLite(toPbClip(c)) = c", () => {
    const c = clip({ yoyo: true, repeat: -1, delay: 30 });
    expect(toClipLite(toPbClip(c))).toEqual(c);
  });
});

describe("clip: cascade", () => {
  const s0 = () => build([
    node("a"), node("b", "a"), node("c", "a"), node("z"),
    setClip(clip({ tracks: [
      { nodeId: "b", prop: "opacity", keyframes: [{ time: 0, value: 0, easing: "" }] },
      { nodeId: "c", prop: "x", keyframes: [{ time: 0, value: 0, easing: "" }] },
    ] })),
    setClip(clip({ id: "k2", targetId: "z", tracks: [{ nodeId: "b", prop: "y", keyframes: [{ time: 0, value: 1, easing: "" }] }] })),
  ]);

  it("deleting a node removes its tracks, the clip stays if the target is alive", () => {
    const s = applyOp(s0(), delNode("b"));
    expect(s.clips.k1.tracks.map((t) => t.nodeId)).toEqual(["c"]);
    expect(s.clips.k2.tracks).toEqual([]);
  });
  it("deleting the target deletes the clip", () => {
    const s = applyOp(s0(), delNode("a"));     // a and its subtree (b, c)
    expect(Object.keys(s.clips)).toEqual(["k2"]);
    expect(s.clips.k2.tracks).toEqual([]);
  });
  it("cascadeClips does not mutate clips and does not create objects if nothing changes", () => {
    const s = s0();
    const snap = JSON.stringify(s.clips);
    expect(cascadeClips(s, new Set(["ghost"]))).toEqual({});
    cascadeClips(s, new Set(["b", "z"]));
    expect(JSON.stringify(s.clips)).toBe(snap);
  });
  it("deleting a page cascades onto clips", () => {
    const s = build([
      op({ case: "createPage", value: { page: { id: "p2", name: "P2" } } }),
      node("a"), node("q", "p2"),
      setClip(clip({ tracks: [{ nodeId: "q", prop: "x", keyframes: [{ time: 0, value: 0, easing: "" }] }] })),
    ]);
    const after = applyOp(s, op({ case: "deletePage", value: { id: "p2" } }));
    expect(after.clips.k1.tracks).toEqual([]);
  });
});

describe("clip: undo", () => {
  it("new setClip: the inverse is a delete", () => {
    const s = build([node("a"), node("b", "a")]);
    expect(roundTrip(s, setClip(clip()))).toEqual(s);
  });
  it("setClip on an existing one: the inverse restores the previous clip", () => {
    const s = base();
    expect(roundTrip(s, setClip(clip({ name: "other", duration: 900, tracks: [] })))).toEqual(s);
  });
  it("deleteClip: l'inverso la rimette", () => {
    const s = base();
    expect(roundTrip(s, delClip("k1"))).toEqual(s);
  });
  it("rejected ops have no inverse", () => {
    const s = base();
    expect(invertOp(s, delClip("ghost"))).toBeNull();
    expect(invertOp(s, setClip(clip({ duration: 0 })))).toBeNull();
    expect(invertOp(s, setClip(clip({ targetId: "ghost" })))).toBeNull();
    expect(invertOp(s, op({ case: "setClip", value: {} }))).toBeNull();
  });
  it("deleteNode: the undo re-creates the nodes AND puts back the removed tracks", () => {
    const s = base();
    expect(roundTrip(s, delNode("b"))).toEqual(s);
  });
  it("deleteNode of the target: the undo also re-creates the deleted clip", () => {
    const s = base();
    const r = roundTrip(s, delNode("a"));
    expect(r.clips).toEqual(s.clips);
    expect(r.nodes.at("b")).toEqual(s.nodes.at("b"));
  });
  it("deletePage: the undo re-creates nodes, tracks and clips", () => {
    const s = build([
      op({ case: "createPage", value: { page: { id: "p2", name: "P2" } } }),
      node("a"), node("q", "p2"), node("r", "q"),
      setClip(clip({ id: "k1", targetId: "q", tracks: [{ nodeId: "r", prop: "x", keyframes: [{ time: 0, value: 3, easing: "" }] }] })),
      setClip(clip({ id: "k2", targetId: "a", tracks: [{ nodeId: "r", prop: "opacity", keyframes: [{ time: 0, value: 1, easing: "" }] }] })),
    ]);
    expect(roundTrip(s, op({ case: "deletePage", value: { id: "p2" } }))).toEqual(s);
  });
});
