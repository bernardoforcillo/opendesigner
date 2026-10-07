import { nodesOf, nodesFromEntries , nodesWith } from "../store/nodeMap";
import { describe, it, expect } from "vitest";
import { applyOp } from "../store/applyOp";
import { emptyScene } from "../store/types";
import type { AutoLayoutLite, NodeLite, SceneState } from "../store/types";
import { computeLayoutDrop, layoutDropOps, reorderableParent } from "./layoutDrop";

const AL: AutoLayoutLite = {
  direction: "horizontal", spacing: 10, paddingLeft: 0, paddingTop: 0, paddingRight: 0, paddingBottom: 0,
  mainAlign: "start", crossAlign: "start", hugWidth: false, hugHeight: false,
};

function node(id: string, parentId: string, key: string, over: Partial<NodeLite> = {}): NodeLite {
  return {
    id, parentId, orderKey: key, name: id, visible: true, opacity: 1, x: 0, y: 0, width: 20, height: 10, rotation: 0,
    fills: [], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false, ...over,
  };
}

// A row at 0, 30, 60 (20x10 boxes, spacing 10) inside a 300x100 frame at (100, 50).
function row(al: Partial<AutoLayoutLite> = {}): SceneState {
  const frame = node("f", "page1", "a0", { kind: "frame", x: 100, y: 50, width: 300, height: 100, autoLayout: { ...AL, ...al } });
  const s = emptyScene("d", "t");
  const nodes = [frame, node("a", "f", "a"), node("b", "f", "b"), node("c", "f", "c")];
  // Goes through the real layout: it decides the positions.
  let scene: SceneState = { ...s, nodes: nodesFromEntries(nodes.map((n) => [n.id, n])) };
  scene = applyOp(scene, {
    kind: { case: "setProps", value: { id: "a", patch: { x: 0 }, mask: { paths: ["x"] } } },
  } as never);
  return scene;
}

describe("reorderableParent", () => {
  it("is the auto layout frame when ALL the nodes are direct children that participate", () => {
    const s = row();
    expect(reorderableParent(s, ["b"])).toBe("f");
    expect(reorderableParent(s, ["a", "c"])).toBe("f");
  });

  it("null for a child of a normal frame, of a page, or of non-homogeneous nodes", () => {
    const s = row();
    expect(reorderableParent(s, ["f"])).toBeNull();
    expect(reorderableParent(s, [])).toBeNull();
    expect(reorderableParent(s, ["ghost"])).toBeNull();
    const plain: SceneState = { ...s, nodes: nodesWith(s.nodes, { f: { ...s.nodes.at("f"), autoLayout: undefined } }) };
    delete (plain.nodes.at("f") as { autoLayout?: unknown }).autoLayout;
    expect(reorderableParent(plain, ["b"])).toBeNull();
    const mixed: SceneState = { ...s, nodes: nodesWith(s.nodes, { z: node("z", "page1", "a9") }) };
    expect(reorderableParent(mixed, ["a", "z"])).toBeNull();
  });

  it("a node that the layout does not arrange (group, hidden) is not reordered", () => {
    const s = row();
    const g: SceneState = { ...s, nodes: nodesWith(s.nodes, { a: { ...s.nodes.at("a"), kind: "group" } }) };
    expect(reorderableParent(g, ["a"])).toBeNull();
    const h: SceneState = { ...s, nodes: nodesWith(s.nodes, { a: { ...s.nodes.at("a"), visible: false } }) };
    expect(reorderableParent(h, ["a"])).toBeNull();
  });
});

describe("computeLayoutDrop", () => {
  // In the world the children sit at x = 100, 130, 160 (20 wide), centers 110, 140, 170.
  it("the index counts the (non-dragged) siblings whose center is before the pointer", () => {
    const s = row();
    // I drag a: b (center 140) and c (170) remain -- but in the world the boxes are already there.
    const at = (x: number) => computeLayoutDrop(s, ["a"], "f", { x, y: 70 })!.index;
    expect(at(90)).toBe(0);
    expect(at(150)).toBe(1);
    expect(at(300)).toBe(2);
  });

  it("the line sits in the gap between neighbors, and is as tall as the frame (horizontal)", () => {
    const s = row();
    const d = computeLayoutDrop(s, ["a"], "f", { x: 150, y: 70 })!;
    expect(d.vertical).toBe(false);
    // Between b (130..150) and c (160..180): half the gap = 155; line of thickness 2.
    expect(d.indicator).toEqual({ x: 154, y: 50, width: 2, height: 100 });
  });

  it("vertical: the line is horizontal, as wide as the frame", () => {
    const s = row({ direction: "vertical" });
    const d = computeLayoutDrop(s, ["a"], "f", { x: 110, y: 60 })!;
    expect(d.vertical).toBe(true);
    expect(d.indicator.width).toBe(300);
    expect(d.indicator.height).toBe(2);
  });

  it("extremes: before the first and after the last, at half spacing from the sibling's edge", () => {
    const s = row();
    // Before the first: half spacing would be at 95, OUTSIDE the frame (which starts at
    // 100): the line stops at the edge.
    expect(computeLayoutDrop(s, ["c"], "f", { x: 90, y: 70 })!.indicator.x).toBe(100 - 1);
    const end = computeLayoutDrop(s, ["a"], "f", { x: 390, y: 70 })!;
    expect(end.index).toBe(2);
    expect(end.indicator.x).toBe(180 + 5 - 1);
  });

  it("releasing a bit outside every frame still reorders in the starting frame", () => {
    const s = row();
    const drop = computeLayoutDrop(s, ["a"], "f", { x: 410, y: 160 })!;      // 10 outside the frame's corner, inside the margin
    expect(drop.frameId).toBe("f");
    expect(drop.out).toBeUndefined();
  });

  it("a pointer well OUTSIDE the starting frame takes the node out of it, into the frame's parent", () => {
    const s = row();                                              // frame at (100,50) 300x100
    expect(computeLayoutDrop(s, ["b"], "f", { x: 700, y: 400 })).toMatchObject({ out: { parentId: "page1", x: 700, y: 400 } });
    // Within the margin it is still a reorder.
    const near = computeLayoutDrop(s, ["b"], "f", { x: 410, y: 100 })!;
    expect(near.out).toBeUndefined();
  });

  it("picks the INNERMOST auto layout frame under the pointer, never a dragged one", () => {
    const s = row();
    const inner = node("g", "f", "z", { kind: "frame", x: 0, y: 40, width: 120, height: 50, autoLayout: { ...AL } });
    const scene: SceneState = { ...s, nodes: nodesWith(s.nodes, { g: inner }) };
    // g sits at (100,90) in the world, 120x50. Pointer inside: g wins.
    expect(computeLayoutDrop(scene, ["a"], "f", { x: 150, y: 110 })!.frameId).toBe("g");
    // If g is the one being dragged, it cannot fall inside itself.
    expect(computeLayoutDrop(scene, ["g"], "f", { x: 150, y: 110 })!.frameId).toBe("f");
  });

  it("empty frame: the line sits at the start, after the padding", () => {
    const s = row({ paddingLeft: 8 });
    const only: SceneState = { ...s, nodes: nodesOf({ f: s.nodes.at("f"), a: s.nodes.at("a") }) };
    const d = computeLayoutDrop(only, ["a"], "f", { x: 200, y: 70 })!;
    expect(d.index).toBe(0);
    expect(d.indicator.x).toBe(100 + 8 - 1);
  });
});

function order(scene: SceneState, frame = "f"): string[] {
  return [...scene.nodes.values()]
    .filter((n) => n.parentId === frame)
    .sort((a, b) => (a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : a.id < b.id ? -1 : 1))
    .map((n) => n.id);
}

describe("layoutDropOps", () => {
  const apply = (s: SceneState, ids: string[], index: number, frameId = "f") => {
    const ops = layoutDropOps(s, ids, { frameId, index, vertical: false, indicator: { x: 0, y: 0, width: 1, height: 1 } });
    return { ops, next: ops.reduce(applyOp, s) };
  };

  it("moves a child forward and backward in the row, and the layout recomputes the positions", () => {
    const s = row();
    const { next } = apply(s, ["a"], 2); // after c
    expect(order(next)).toEqual(["b", "c", "a"]);
    expect([next.nodes.at("b").x, next.nodes.at("c").x, next.nodes.at("a").x]).toEqual([0, 30, 60]);
    const back = apply(next, ["a"], 0);
    expect(order(back.next)).toEqual(["a", "b", "c"]);
  });

  it("taking nodes out reparents them on top of the frame's siblings, centered on the pointer, and the row closes up", () => {
    let s = row();
    const drop = computeLayoutDrop(s, ["b"], "f", { x: 700, y: 400 })!;
    const ops = layoutDropOps(s, ["b"], drop);
    expect(ops.map((o) => o.kind.case)).toEqual(["reparentNode", "setProps"]);
    for (const o of ops) s = applyOp(s, o);
    const b = s.nodes.at("b");
    expect(b.parentId).toBe("page1");
    // 20x10 box centered at (700,400): top-left (690,395) in the page's space.
    expect([b.x, b.y]).toEqual([690, 395]);
    expect(s.nodes.at("c").x).toBe(30);                              // the layout closed the gap: a at 0, c at 30
    // Several nodes keep their offsets, with the group centered on the pointer.
    const multi = layoutDropOps(row(), ["a", "c"], computeLayoutDrop(row(), ["a", "c"], "f", { x: 700, y: 400 })!);
    let t = row();
    for (const o of multi) t = applyOp(t, o);
    expect(t.nodes.at("c").x - t.nodes.at("a").x).toBe(60);
    expect((t.nodes.at("a").x + t.nodes.at("c").x + 20) / 2).toBe(700);
  });

  it("releasing where it already was produces no op", () => {
    const s = row();
    expect(apply(s, ["a"], 0).ops).toEqual([]); // b, c remain: a before everyone = as it was
    expect(apply(s, ["b"], 1).ops).toEqual([]);
    expect(apply(s, ["c"], 2).ops).toEqual([]);
  });

  it("more nodes together keep their relative order", () => {
    const s = row();
    const { next } = apply(s, ["a", "b"], 1); // only c remains: after c
    expect(order(next)).toEqual(["c", "a", "b"]);
  });

  it("towards another auto layout it is a reparent and the starting frame closes up", () => {
    const s = row();
    const other = node("g", "page1", "a1", { kind: "frame", x: 500, y: 50, width: 300, height: 100, autoLayout: { ...AL } });
    const withOther: SceneState = { ...s, nodes: nodesWith(s.nodes, { g: other, d: node("d", "g", "a") }) };
    const { ops, next } = apply(withOther, ["a"], 1, "g");
    expect(ops).toHaveLength(1);
    expect(ops[0].kind.case).toBe("reparentNode");
    expect(order(next, "g")).toEqual(["d", "a"]);
    expect(next.nodes.at("a").parentId).toBe("g");
    // The starting frame no longer has a: b starts from the beginning.
    expect(next.nodes.at("b")).toMatchObject({ x: 0, y: 0 });
    expect(next.nodes.at("a")).toMatchObject({ x: 30, y: 0 });
  });

  it("equal keys between neighbors do not blow up the gesture", () => {
    const s = row();
    const same: SceneState = { ...s, nodes: nodesWith(s.nodes, { b: { ...s.nodes.at("b"), orderKey: "a" }, c: { ...s.nodes.at("c"), orderKey: "a" } }) };
    expect(() => apply(same, ["a"], 1)).not.toThrow();
  });
});
