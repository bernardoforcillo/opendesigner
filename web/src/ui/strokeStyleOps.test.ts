import { describe, it, expect } from "vitest";
import { nodesOf } from "../store/nodeMap";
import { applyOp } from "../store/applyOp";
import { emptyScene } from "../store/types";
import type { NodeLite, SceneState } from "../store/types";
import { normalizeDash, strokeStyleOps } from "./strokeStyleOps";

const scene = (meta?: Record<string, string>): SceneState => ({
  ...emptyScene("d", "t"),
  nodes: nodesOf({
    a: {
      id: "a", parentId: "page1", orderKey: "a0", name: "a", visible: true, opacity: 1, x: 0, y: 0, width: 10, height: 10, rotation: 0,
      fills: [], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false, ...(meta ? { meta } : {}),
    } as NodeLite,
  }),
});
const run = (s: SceneState, p: Parameters<typeof strokeStyleOps>[2]) => strokeStyleOps(["a"], (id) => s.nodes.at(id), p).reduce(applyOp, s).nodes.at("a");

describe("strokeStyleOps", () => {
  it("writes the keys the renderers read and keeps other meta", () => {
    const n = run(scene({ keep: "me" }), { cap: "round", join: "bevel", dash: "4, 2", miter: 6, dashOffset: 1 });
    expect(n.meta).toEqual({
      keep: "me", "stroke.cap": "round", "stroke.join": "bevel", "stroke.dash": "4,2", "stroke.miter": "6", "stroke.dashOffset": "1",
    });
  });

  it("the defaults and an empty dash remove their keys (and the whole map when it empties)", () => {
    const n = run(scene({ "stroke.cap": "round", "stroke.dash": "3,3" }), { cap: "butt", dash: "" });
    expect(n.meta).toBeUndefined();
  });

  it("nothing to write when nothing changes", () => {
    const s = scene({ "stroke.cap": "round" });
    expect(strokeStyleOps(["a"], (id) => s.nodes.at(id), { cap: "round" })).toEqual([]);
  });

  it("normalizeDash accepts commas and spaces and rejects nonsense", () => {
    expect(normalizeDash("4 2")).toBe("4,2");
    expect(normalizeDash("0,0")).toBeUndefined();
    expect(normalizeDash("a,b")).toBeUndefined();
    expect(normalizeDash("-1,2")).toBeUndefined();
  });
});
