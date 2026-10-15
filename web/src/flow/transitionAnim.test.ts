import { describe, it, expect } from "vitest";
import { nodesOf } from "../store/nodeMap";
import { emptyScene } from "../store/types";
import type { NodeLite, SceneState, TransitionLite } from "../store/types";
import { animOf, layersAt, progressOf, smartScene, DEFAULT_DURATION_MS } from "./transitionAnim";
import { PROTO_PAGE_ID } from "./protoScene";

const t = (over: Partial<TransitionLite> = {}): TransitionLite => ({
  id: "t", flowId: "f", fromId: "a", toId: "b", label: "", trigger: "click", elementId: "", guard: "", effect: "", ...over,
});
const node = (id: string, parentId: string, over: Partial<NodeLite> = {}): NodeLite => ({
  id, parentId, orderKey: `a${id}`, name: id, visible: true, opacity: 1, x: 0, y: 0, width: 100, height: 50, rotation: 0,
  fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false, ...over,
});

describe("animOf", () => {
  it("a cut has no animation; known ones carry their defaults", () => {
    expect(animOf(t())).toBeNull();
    expect(animOf(t({ animation: "dissolve" }))).toMatchObject({ kind: "dissolve", durationMs: DEFAULT_DURATION_MS, easing: "easeInOut" });
    expect(animOf(t({ animation: "push-up", durationMs: 500, easing: "linear" }))).toEqual({ kind: "push", dir: "up", durationMs: 500, easing: "linear" });
    expect(animOf(t({ animation: "wipe" }))).toBeNull();
  });
});

describe("progress and layers", () => {
  const slide = animOf(t({ animation: "slide-left", easing: "linear", durationMs: 200 }))!;
  it("progress is clamped and eased", () => {
    expect(progressOf(slide, -5)).toBe(0);
    expect(progressOf(slide, 100)).toBeCloseTo(0.5);
    expect(progressOf(slide, 999)).toBe(1);
  });
  it("slide-left: the new screen comes in from the right over a still one", () => {
    expect(layersAt(slide, 0).to).toMatchObject({ dx: 1, dy: 0 });
    expect(layersAt(slide, 1).to).toMatchObject({ dx: 0, dy: 0 });
    expect(layersAt(slide, 0.5).from).toMatchObject({ dx: 0 });
  });
  it("push-up: both move, the old one out to the top", () => {
    const push = animOf(t({ animation: "push-up" }))!;
    expect(layersAt(push, 1).from).toMatchObject({ dy: -1 });
    expect(layersAt(push, 0).to).toMatchObject({ dy: 1 });
  });
  it("dissolve: the new screen fades in over the old one", () => {
    const d = animOf(t({ animation: "dissolve" }))!;
    expect(layersAt(d, 0.25)).toEqual({ from: { dx: 0, dy: 0, alpha: 1 }, to: { dx: 0, dy: 0, alpha: 0.25 } });
  });
});

describe("smartScene", () => {
  const scene = (): SceneState => ({
    ...emptyScene("d", "t"),
    nodes: nodesOf({
      a: node("a", "page1", { kind: "frame", fills: [{ r: 1, g: 1, b: 1, a: 1 }] }),
      b: node("b", "page1", { kind: "frame", x: 500, fills: [{ r: 0, g: 0, b: 0, a: 1 }] }),
      a1: node("a1", "a", { name: "card", x: 0, y: 0, width: 100, opacity: 1 }),
      b1: node("b1", "b", { name: "card", x: 100, y: 40, width: 200, opacity: 0.5 }),
      aOnly: node("aOnly", "a", { name: "old" }),
      bOnly: node("bOnly", "b", { name: "new" }),
    }),
  });

  it("matched nodes move halfway, new ones fade in, old ones fade out", () => {
    const s = smartScene(scene(), "a", "b", 0.5)!;
    expect(s.pages).toEqual([{ id: PROTO_PAGE_ID, name: "Prototype" }]);
    expect(s.nodes.at("b").parentId).toBe(PROTO_PAGE_ID);
    expect(s.nodes.at("b").fills[0]).toMatchObject({ r: 0.5, g: 0.5, b: 0.5 });
    expect(s.nodes.at("b1")).toMatchObject({ x: 50, y: 20, width: 150, opacity: 0.75 });
    expect(s.nodes.at("bOnly").opacity).toBeCloseTo(0.5);
    expect(s.nodes.at("__from__aOnly")).toMatchObject({ parentId: "b" });
    expect(s.nodes.at("__from__aOnly").opacity).toBeCloseTo(0.5);
  });

  it("at 0 it looks like the source and at 1 like the destination", () => {
    expect(smartScene(scene(), "a", "b", 0)!.nodes.at("b1")).toMatchObject({ x: 0, y: 0, width: 100, opacity: 1 });
    const end = smartScene(scene(), "a", "b", 1)!;
    expect(end.nodes.at("b1")).toMatchObject({ x: 100, y: 40, width: 200, opacity: 0.5 });
    expect(end.nodes.at("__from__aOnly").opacity).toBe(0);
  });

  it("does not touch the source scene, and needs both screens", () => {
    const s = scene();
    smartScene(s, "a", "b", 0.5);
    expect(s.nodes.at("b1").x).toBe(100);
    expect(smartScene(s, "a", "nope", 0.5)).toBeNull();
  });
});
