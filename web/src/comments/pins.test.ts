import { describe, it, expect } from "vitest";
import { nodesOf } from "../store/nodeMap";
import { emptyScene } from "../store/types";
import type { CommentLite, NodeLite, SceneState } from "../store/types";
import { threadsOf } from "../store/comments";
import { draftWorld, pinAt, pinsOf, placement } from "./pins";

const frame = (over: Partial<NodeLite> = {}): NodeLite => ({
  id: "f", parentId: "page1", orderKey: "a0", name: "Card", visible: true, opacity: 1, x: 100, y: 50, width: 200, height: 100, rotation: 0,
  fills: [], strokes: [], kind: "frame", cornerRadius: 0, clipsContent: false, ...over,
});
const c = (over: Partial<CommentLite>): CommentLite => ({
  id: "c", parentId: "", nodeId: "", pageId: "page1", x: 0, y: 0, author: "A", text: "t", createdAt: 1, resolved: false, ...over,
});
const sceneWith = (comments: CommentLite[], nodes: NodeLite[] = [frame()]): SceneState => ({
  ...emptyScene("d", "t"),
  nodes: nodesOf(Object.fromEntries(nodes.map((n) => [n.id, n]))),
  comments: Object.fromEntries(comments.map((x) => [x.id, x])),
});

describe("pins", () => {
  it("a pin on a node follows the node; a free pin stays where it was put", () => {
    const s = sceneWith([c({ id: "a", nodeId: "f", pageId: "", x: 10, y: 5 }), c({ id: "b", x: 7, y: 9, createdAt: 2 })]);
    expect(pinsOf(s, "page1", false)).toMatchObject([{ threadId: "a", x: 110, y: 55, number: 1 }, { threadId: "b", x: 7, y: 9, number: 2 }]);
    const moved = { ...s, nodes: nodesOf({ f: frame({ x: 300 }) }) };
    expect(pinsOf(moved, "page1", false)[0]).toMatchObject({ x: 310, y: 55 });
  });

  it("a rotated node turns its pin with it", () => {
    // 90° around the centre (200, 100): the node-local origin (100,50) maps to (250, 0).
    const s = sceneWith([c({ id: "a", nodeId: "f", pageId: "", x: 0, y: 0 })], [frame({ rotation: 90 })]);
    const p = pinsOf(s, "page1", false)[0];
    expect(p.x).toBeCloseTo(250);
    expect(p.y).toBeCloseTo(0);
  });

  it("resolved threads are hidden unless asked, without renumbering the others", () => {
    const s = sceneWith([c({ id: "a", resolved: true }), c({ id: "b", createdAt: 2 })]);
    expect(pinsOf(s, "page1", false).map((p) => [p.threadId, p.number])).toEqual([["b", 2]]);
    expect(pinsOf(s, "page1", true)).toHaveLength(2);
  });

  it("pins of other pages and orphaned threads do not show", () => {
    const s = sceneWith([c({ id: "a", pageId: "page2" }), c({ id: "o", nodeId: "gone", pageId: "" })]);
    expect(pinsOf(s, "page1", true)).toEqual([]);
    expect(threadsOf(s, "page1").map((t) => [t.root.id, t.orphan])).toEqual([["o", true]]);
  });

  it("pinAt picks the bubble above the tip, the newest on top", () => {
    const pins = [{ threadId: "a", x: 0, y: 0, number: 1, resolved: false }, { threadId: "b", x: 0, y: 0, number: 2, resolved: false }];
    expect(pinAt(pins, 0, -11, 1)?.threadId).toBe("b");
    expect(pinAt(pins, 0, 30, 1)).toBeNull();
  });

  it("placement attaches to the node under the point, in its own space", () => {
    const s = sceneWith([]);
    expect(placement(s, "f", "page1", 150, 80)).toEqual({ nodeId: "f", pageId: "", x: 50, y: 30 });
    expect(placement(s, null, "page1", 150, 80)).toEqual({ nodeId: "", pageId: "page1", x: 150, y: 80 });
    expect(draftWorld(s, { nodeId: "f", x: 50, y: 30 })).toEqual({ x: 150, y: 80 });
  });

  it("threads keep replies in order under their root", () => {
    const s = sceneWith([c({ id: "r" }), c({ id: "r2", parentId: "r", createdAt: 5, pageId: "" }), c({ id: "r1", parentId: "r", createdAt: 3, pageId: "" })]);
    expect(threadsOf(s, "page1")[0].replies.map((r) => r.id)).toEqual(["r1", "r2"]);
  });
});
