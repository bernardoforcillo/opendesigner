import { describe, expect, it } from "vitest";
import { create } from "@bufbuild/protobuf";
import { NodeSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import { deriveConnectors } from "./connectors";
import { resolveScene } from "./variables";
import { emptyScene, toNodeLite } from "./types";
import { NodeMap } from "./nodeMap";
import { connectOps, setConnectorOps } from "../vector/connect";
import type { NodeLite, SceneState } from "./types";

function rect(id: string, x: number, y: number): NodeLite {
  return toNodeLite(create(NodeSchema, { id, parentId: "page1", orderKey: id, name: id, visible: true, opacity: 1, x, y, width: 50, height: 30, shape: { case: "rect", value: {} } }));
}

function sceneOf(...nodes: NodeLite[]): SceneState {
  return { ...emptyScene("d", "d"), nodes: NodeMap.from(nodes.map((n) => [n.id, n] as const)) };
}

function connectorIn(scene: SceneState, opts = {}): NodeLite {
  const res = connectOps(scene, "a", "b", opts)!;
  const op = res.ops[0];
  if (op.kind.case !== "createNode") throw new Error("expected a create");
  return toNodeLite(op.kind.value.node!);
}

describe("connectors", () => {
  it("draws from the edge of one box to the edge of the other", () => {
    const base = sceneOf(rect("a", 0, 0), rect("b", 200, 0));
    const c = connectorIn(base);
    expect(c.meta).toMatchObject({ "connector.from": "a", "connector.to": "b" });
    // Right edge of a (x 50) to left edge of b (x 200), mid height 15.
    expect(c.x).toBeCloseTo(50 - 0, 5);
    expect(c.y).toBeLessThanOrEqual(15);
  });

  it("follows the shapes when one moves", () => {
    const base = sceneOf(rect("a", 0, 0), rect("b", 200, 0));
    const c = connectorIn(base);
    const before = sceneOf(rect("a", 0, 0), rect("b", 200, 0), c);
    const after = sceneOf(rect("a", 0, 0), rect("b", 200, 300), c);
    const x0 = resolveScene(before).nodes.at(c.id)!;
    const x1 = resolveScene(after).nodes.at(c.id)!;
    expect(x1.height).toBeGreaterThan(x0.height + 100);
    // The document itself is untouched.
    expect(after.nodes.at(c.id)!.height).toBe(c.height);
  });

  it("is left alone when an end is missing", () => {
    const base = sceneOf(rect("a", 0, 0), rect("b", 200, 0));
    const c = connectorIn(base);
    const s = sceneOf(rect("a", 0, 0), c);
    expect(deriveConnectors(s)).toBe(s);
  });

  it("routes with an elbow and changes route through setProps", () => {
    const base = sceneOf(rect("a", 0, 0), rect("b", 200, 100));
    const c = connectorIn(base, { route: "elbow", head: "none" });
    const d = resolveScene(sceneOf(rect("a", 0, 0), rect("b", 200, 100), c)).nodes.at(c.id)!;
    expect(d.vector!.subpaths).toHaveLength(1);
    expect(d.vector!.subpaths[0].anchors.length).toBe(4);
    expect(setConnectorOps(c, { route: "elbow" })).toHaveLength(0);
    expect(setConnectorOps(c, { route: "straight" })).toHaveLength(1);
  });

  it("refuses to connect a node to itself", () => {
    expect(connectOps(sceneOf(rect("a", 0, 0)), "a", "a")).toBeNull();
  });
});
