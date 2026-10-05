import { describe, it, expect } from "vitest";
import { baseScene, child } from "../flow/testSupport";
import { nodesWith } from "../store/nodeMap";
import { sceneIndexOf, buildIndex } from "../renderer/sceneIndex";
import { worldTransformOf } from "../canvas/transform";
import type { SceneState } from "../store/types";
import { canDraw, mergeAnim, poseScene, sampleWithDraft } from "./pose";
import type { NodeAnim } from "./engine";

const anim = (o: Record<string, NodeAnim>) => new Map(Object.entries(o));

function scene(): SceneState {
  const s = baseScene();
  return {
    ...s,
    nodes: nodesWith(s.nodes, {
      grp: { ...child("grp", "A", 0, 0), kind: "group", width: 0, height: 0 },
      g1: child("g1", "grp", 10, 20),
      g2: child("g2", "grp", 110, 20),
      vec: { ...child("vec", "A", 0, 100), kind: "vector", vector: { subpaths: [] } },
      txt: { ...child("txt", "A", 0, 150), kind: "text" },
    }),
  };
}

describe("poseScene", () => {
  it("nothing to animate (or values equal to the base): the SAME scene", () => {
    const s = scene();
    expect(poseScene(s, anim({}))).toBe(s);
    expect(poseScene(s, anim({ btn: { x: 60, y: 200, opacity: 1, rotation: 0 } }))).toBe(s);
    expect(poseScene(s, anim({ gone: { x: 5 } }))).toBe(s);
    expect(poseScene(s, anim({ btn: { scale: 1 } }))).toBe(s);
  });

  it("x, y, rotation, opacity become real fields of the node, without touching the base scene", () => {
    const s = scene();
    const p = poseScene(s, anim({ btn: { x: 5, y: 6, rotation: 45, opacity: 0.25 } }));
    expect(p).not.toBe(s);
    const n = p.nodes.at("btn");
    expect([n.x, n.y, n.rotation, n.opacity]).toEqual([5, 6, 45, 0.25]);
    expect(s.nodes.at("btn").x).toBe(60); // the document does not change
    expect(p.nodes.at("btn").animScale).toBeUndefined();
    expect(p.nodes.at("B")).toBe(s.nodes.at("B")); // untouched nodes remain the same objects
  });

  it("scale and draw go in the transient fields; draw only where there is a path", () => {
    const s = scene();
    const p = poseScene(s, anim({ btn: { scale: 1.5, draw: 0.4 }, vec: { draw: 0.5 }, txt: { draw: 0.5 } }));
    expect(p.nodes.at("btn").animScale).toBe(1.5);
    expect(p.nodes.at("btn").animDraw).toBe(0.4);
    expect(p.nodes.at("vec").animDraw).toBe(0.5);
    expect(p.nodes.at("txt")).toBe(s.nodes.at("txt")); // a text ignores draw
    expect(p.anim?.hasDraw).toBe(true);
    expect(p.anim?.scaled.has("btn")).toBe(true);
    expect([...p.anim!.ancestors]).toEqual(["A"]);
  });

  it("draw = 1 is the whole path: it does not force the GPU renderer to fall back", () => {
    const s = scene();
    expect(poseScene(s, anim({ vec: { draw: 1 } })).anim?.hasDraw).toBe(false);
    expect(poseScene(s, anim({ vec: { draw: 0.99 } })).anim?.hasDraw).toBe(true);
  });

  it("the scale pivot of a GROUP is the center of its contents and follows animated x/y", () => {
    const s = scene();
    const p = poseScene(s, anim({ grp: { scale: 2 } }));
    // the children cover x 10..190, y 20..50: center (100, 35) in the parent's space (A, at 0,0)
    expect(p.nodes.at("grp").animPivot).toEqual({ x: 100, y: 35 });
    const moved = poseScene(s, anim({ grp: { scale: 2, x: 30 } }));
    expect(moved.nodes.at("grp").animPivot).toEqual({ x: 130, y: 35 });
  });

  it("the scale enters the children's transformation, around the center", () => {
    const s = scene();
    const p = poseScene(s, anim({ A: { scale: 2 } }));
    // A is 200x300 at (0,0): scale 2 around (100,150). The children's (0,0) corner goes to (-100,-150).
    const t = worldTransformOf(p, "A");
    expect(t.a).toBe(2);
    expect(t.e).toBe(-100);
    expect(t.f).toBe(-150);
  });

  it("the recorded provenance makes the index update without rebuilding it and gives right extents to x/y", () => {
    const s = scene();
    const base = sceneIndexOf(s);
    const p = poseScene(s, anim({ btn: { x: 500, y: 400 } }));
    const idx = sceneIndexOf(p);
    const fresh = buildIndex(p);
    expect(idx.extent.get("btn")).toEqual(fresh.extent.get("btn"));
    expect(idx.extent.get("btn")).not.toEqual(base.extent.get("btn"));
    expect(sceneIndexOf(s)).toBe(base); // the base scene still has its index
  });
});

describe("sampleWithDraft / mergeAnim", () => {
  it("the draft wins over the sampling, property by property", () => {
    const clip = { tracks: [{ nodeId: "btn", prop: "x", keyframes: [{ time: 0, value: 10, easing: "" }] }, { nodeId: "btn", prop: "y", keyframes: [{ time: 0, value: 20, easing: "" }] }] };
    const m = sampleWithDraft(clip, 0, anim({ btn: { x: 99 } }));
    expect(m.get("btn")).toEqual({ x: 99, y: 20 });
    expect(sampleWithDraft(clip, 0, null).get("btn")).toEqual({ x: 10, y: 20 });
  });
  it("mergeAnim: the last ones win, it does not mutate the source", () => {
    const src = anim({ a: { x: 1 } });
    const dst = mergeAnim(anim({ a: { x: 0, y: 5 } }), src);
    expect(dst.get("a")).toEqual({ x: 1, y: 5 });
    dst.get("a")!.x = 77;
    expect(src.get("a")!.x).toBe(1);
  });
  it("canDraw", () => {
    expect(["vector", "rect", "ellipse", "frame"].every((kind) => canDraw({ kind: kind as never }))).toBe(true);
    expect(["text", "image", "group", "instance"].some((kind) => canDraw({ kind: kind as never }))).toBe(false);
  });
});
