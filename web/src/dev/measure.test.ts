import { describe, it, expect } from "vitest";
import { measureNode } from "./measure";
import { emptyScene } from "../store/types";
import { NodeMap } from "../store/nodeMap";
import type { NodeLite } from "../store/types";

function node(over: Partial<NodeLite> & { id: string }): NodeLite {
  return { kind: "rect", parentId: "p", name: over.id, x: 0, y: 0, width: 10, height: 10, rotation: 0, visible: true, ...over } as NodeLite;
}

describe("measureNode", () => {
  it("measures the gaps to the parent and to the nearest sibling", () => {
    const list = [
      node({ id: "p", parentId: "page1", kind: "frame", x: 100, y: 100, width: 200, height: 100 }),
      node({ id: "a", x: 120, y: 110, width: 40, height: 20 }),
      node({ id: "b", x: 190, y: 112, width: 30, height: 20 }),
      node({ id: "c", x: 120, y: 160, width: 40, height: 20 }),
    ];
    const scene = { ...emptyScene("d", "d"), nodes: NodeMap.from(list.map((n) => [n.id, n] as const)) };
    const m = measureNode(scene, "a")!;
    expect(m).toMatchObject({ x: 20, y: 10, width: 40, height: 20 });
    expect(m.toParent).toEqual({ top: 10, left: 20, right: 140, bottom: 70 });
    expect(m.toSibling).toEqual({ top: null, left: null, right: 30, bottom: 30 });
  });
  it("is null for a missing node", () => {
    expect(measureNode(emptyScene("d", "d"), "x")).toBeNull();
  });
});
