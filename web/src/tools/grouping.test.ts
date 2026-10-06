import { describe, it, expect, beforeEach } from "vitest";
import { groupOps, ungroupOps } from "./grouping";
import { applyOp } from "../store/applyOp";
import { useScene } from "../store/store";
import { worldBoundsOfNode } from "../canvas/transform";
import { emptyScene, type NodeLite, type SceneState } from "../store/types";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";

function node(id: string, parentId: string, x: number, y: number, orderKey: string, extra: Partial<NodeLite> = {}): NodeLite {
  return {
    id, parentId, orderKey, name: id, visible: true, opacity: 1,
    x, y, width: 50, height: 50, rotation: 0, fills: [], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false, ...extra,
  };
}

function group(id: string, parentId: string, orderKey: string, extra: Partial<NodeLite> = {}): NodeLite {
  return node(id, parentId, 0, 0, orderKey, { kind: "group", width: 0, height: 0, ...extra });
}

function scene(nodes: NodeLite[]): SceneState {
  const s = emptyScene("doc1", "Untitled");
  for (const n of nodes) s.nodes = s.nodes.set(n.id, n);
  // The ops built by tools/ops.ts also read the docId from the store: the
  // scene must be installed there, not just passed to the functions.
  useScene.getState().setScene(s);
  return useScene.getState().scene!;
}

// page1 > r1, r2, r3 -- three siblings, increasing order keys (r3 the topmost).
function flat(): SceneState {
  return scene([
    node("r1", "page1", 0, 0, "a000001"),
    node("r2", "page1", 100, 0, "a000002"),
    node("r3", "page1", 200, 0, "a000003"),
  ]);
}

const kinds = (ops: Op[]) => ops.map((o) => o.kind.case);

function reparents(ops: Op[]): { id: string; parent: string; key: string }[] {
  return ops.flatMap((o) =>
    o.kind.case === "reparentNode"
      ? [{ id: o.kind.value.id, parent: o.kind.value.newParentId, key: o.kind.value.orderKey }]
      : [],
  );
}

function setPropsOf(ops: Op[], id: string): { x: number; y: number; paths: readonly string[] } | null {
  for (const o of ops) {
    if (o.kind.case === "setProps" && o.kind.value.id === id) {
      return { x: o.kind.value.patch?.x ?? 0, y: o.kind.value.patch?.y ?? 0, paths: o.kind.value.mask?.paths ?? [] };
    }
  }
  return null;
}

function createdNode(ops: Op[]): NodeLite | null {
  const op = ops.find((o) => o.kind.case === "createNode");
  if (!op || op.kind.case !== "createNode" || !op.kind.value.node) return null;
  const s = applyOp(emptyScene("doc1", "u"), op);
  return s.nodes.at(op.kind.value.node.id) ?? null;
}

const applyAll = (s: SceneState, ops: Op[]) => ops.reduce((acc, op) => applyOp(acc, op), s);

beforeEach(() => {
  useScene.setState({ selection: [], gesture: null, sync: null });
});

describe("groupOps", () => {
  it("creates the group FIRST, then reparents into it (the parent must exist before its children point to it)", () => {
    const s = flat();
    const res = groupOps(s, ["r1", "r3"])!;
    expect(kinds(res.ops)).toEqual(["createNode", "reparentNode", "reparentNode"]);
    const g = createdNode(res.ops)!;
    expect(g.kind).toBe("group");
    expect(g.parentId).toBe("page1");
    // No geometry of its own: the bounds are the union of the children, and (0,0)
    // means that grouping does not move a pixel.
    expect(g).toMatchObject({ x: 0, y: 0, width: 0, height: 0, visible: true, opacity: 1 });
    expect(res.selection).toEqual([g.id]);
    expect(reparents(res.ops).map((r) => r.id)).toEqual(["r1", "r3"]);
    expect(reparents(res.ops).every((r) => r.parent === g.id)).toBe(true);
  });

  it("puts the group at the z-position of the TOPMOST selected node, under the sibling above it", () => {
    const s = flat();
    const g = createdNode(groupOps(s, ["r1", "r2"])!.ops)!;
    // Above r2 (the topmost of the selected) but below r3, which was not
    // selected and must stay in front of it.
    expect(g.orderKey > "a000002").toBe(true);
    expect(g.orderKey < "a000003").toBe(true);
  });

  it("puts the group above everything when the topmost selected node is the topmost sibling", () => {
    const s = flat();
    const g = createdNode(groupOps(s, ["r3"])!.ops)!;
    expect(g.orderKey > "a000003").toBe(true);
  });

  it("keeps the relative z-order of the grouped nodes, whatever the selection order", () => {
    const s = flat();
    const res = groupOps(s, ["r3", "r1", "r2"])!;
    const r = reparents(res.ops);
    expect(r.map((x) => x.id)).toEqual(["r1", "r2", "r3"]);
    expect(r[0].key < r[1].key).toBe(true);
    expect(r[1].key < r[2].key).toBe(true);
  });

  it("does not reparent a descendant selected together with its container: the container carries it", () => {
    const s = scene([
      node("box", "page1", 0, 0, "a000001"),
      node("inner", "box", 10, 10, "a000001"),
    ]);
    const res = groupOps(s, ["box", "inner"])!;
    expect(reparents(res.ops).map((r) => r.id)).toEqual(["box"]);
  });

  it("preserves the WORLD position of a node that changes coordinate space", () => {
    const s = scene([
      node("box", "page1", 100, 100, "a000001"),
      node("inner", "box", 10, 10, "a000001"),
      node("solo", "page1", 200, 200, "a000002"),
    ]);
    const res = groupOps(s, ["inner", "solo"])!;
    // "inner" lived in box's space (100,100): out of there its
    // coordinates are worth (110,110), or the node would shift by 100px.
    expect(setPropsOf(res.ops, "inner")).toEqual({ x: 110, y: 110, paths: ["x", "y"] });
    // "solo" changes parent but not space (the group is born at (0,0) under the
    // same page): no useless op.
    expect(setPropsOf(res.ops, "solo")).toBeNull();

    const after = applyAll(s, res.ops);
    expect(worldBoundsOfNode(after, after.nodes.at("inner"))).toMatchObject({ x: 110, y: 110 });
    expect(worldBoundsOfNode(after, after.nodes.at("solo"))).toMatchObject({ x: 200, y: 200 });
  });

  it("groups a single node too (it is a container, not a merge)", () => {
    const s = flat();
    const res = groupOps(s, ["r2"])!;
    expect(reparents(res.ops).map((r) => r.id)).toEqual(["r2"]);
  });

  it("is null when there is nothing to group", () => {
    const s = flat();
    expect(groupOps(s, [])).toBeNull();
    expect(groupOps(s, ["ghost"])).toBeNull();
  });
});

describe("ungroupOps", () => {
  // page1 > g(group moved to 5,7) > c1, c2 ; and "above" above the group.
  function grouped(): SceneState {
    return scene([
      group("g", "page1", "a000002", { x: 5, y: 7 }),
      node("c1", "g", 10, 10, "a000001"),
      node("c2", "g", 30, 30, "a000002"),
      node("above", "page1", 500, 0, "a000003"),
    ]);
  }

  it("reparents the children out and deletes the group LAST", () => {
    const s = grouped();
    const res = ungroupOps(s, ["g"])!;
    expect(kinds(res.ops).at(-1)).toBe("deleteNode");
    expect(reparents(res.ops).map((r) => r.id)).toEqual(["c1", "c2"]);
    expect(reparents(res.ops).every((r) => r.parent === "page1")).toBe(true);
    // The freed children are the new selection: the group no longer exists.
    expect(res.selection).toEqual(["c1", "c2"]);
  });

  it("keeps the children in the group's z-slot and in their relative order", () => {
    const s = grouped();
    const r = reparents(ungroupOps(s, ["g"])!.ops);
    expect(r[0].key > "a000002").toBe(true); // above the group's place
    expect(r[0].key < r[1].key).toBe(true);  // c1 stays below c2
    expect(r[1].key < "a000003").toBe(true); // and both below "above"
  });

  it("preserves the WORLD position of the children of a group that has been moved", () => {
    const s = grouped();
    const res = ungroupOps(s, ["g"])!;
    // The group translated the children by (5,7): out of there the translation must be
    // written into their coordinates.
    expect(setPropsOf(res.ops, "c1")).toEqual({ x: 15, y: 17, paths: ["x", "y"] });
    expect(setPropsOf(res.ops, "c2")).toEqual({ x: 35, y: 37, paths: ["x", "y"] });

    const before = worldBoundsOfNode(s, s.nodes.at("c1"));
    const after = applyAll(s, res.ops);
    expect(worldBoundsOfNode(after, after.nodes.at("c1"))).toEqual(before);
    expect(after.nodes.at("g")).toBeUndefined();
  });

  it("sends no setProps when the group never moved", () => {
    const s = scene([
      group("g", "page1", "a000001"),
      node("c1", "g", 10, 10, "a000001"),
    ]);
    expect(kinds(ungroupOps(s, ["g"])!.ops)).toEqual(["reparentNode", "deleteNode"]);
  });

  it("just deletes an empty group", () => {
    const s = scene([group("g", "page1", "a000001")]);
    const res = ungroupOps(s, ["g"])!;
    expect(kinds(res.ops)).toEqual(["deleteNode"]);
    expect(res.selection).toEqual([]);
  });

  it("ignores the selected nodes that are not groups", () => {
    const s = grouped();
    const res = ungroupOps(s, ["g", "above"])!;
    expect(kinds(res.ops).filter((k) => k === "deleteNode")).toEqual(["deleteNode"]);
    expect(res.selection).toEqual(["c1", "c2"]);
  });

  it("is null when nothing selected is a group", () => {
    const s = grouped();
    expect(ungroupOps(s, ["above"])).toBeNull();
    expect(ungroupOps(s, [])).toBeNull();
  });

  // With a group AND its containing group selected, ungrouping both
  // in one go would produce ops built on a state that the first has already
  // changed: the outermost is ungrouped, exactly as deletion
  // deletes the subtree (tree.ts::topmostOf).
  it("ungroups only the outermost group when a group and one of its own groups are selected", () => {
    const s = scene([
      group("outer", "page1", "a000001"),
      group("inner", "outer", "a000001"),
      node("c", "inner", 0, 0, "a000001"),
    ]);
    const res = ungroupOps(s, ["outer", "inner"])!;
    expect(reparents(res.ops).map((r) => r.id)).toEqual(["inner"]);
    expect(res.selection).toEqual(["inner"]);
  });

  it("round trip: group then ungroup puts everything back where it was", () => {
    const s = scene([
      node("box", "page1", 100, 100, "a000001"),
      node("inner", "box", 10, 10, "a000001"),
      node("solo", "page1", 200, 200, "a000002"),
    ]);
    const worldBefore = ["inner", "solo"].map((id) => worldBoundsOfNode(s, s.nodes.at(id)));

    const g = groupOps(s, ["inner", "solo"])!;
    const grouped = applyAll(s, g.ops);
    const u = ungroupOps(grouped, g.selection)!;
    const after = applyAll(grouped, u.ops);

    // The world coordinates are the same; "inner" does NOT go back into "box" (the
    // group had taken it out) but has not moved by a pixel.
    expect(["inner", "solo"].map((id) => worldBoundsOfNode(after, after.nodes.at(id)))).toEqual(worldBefore);
    expect([...after.nodes.values()].some((n) => n.kind === "group")).toBe(false);
    expect(after.nodes.at("solo").parentId).toBe("page1");
  });
});
