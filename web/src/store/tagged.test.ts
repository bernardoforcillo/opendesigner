import { describe, expect, it } from "vitest";
import { taggedOf } from "./tagged";
import { applyOp } from "./applyOp";
import { nodesOf } from "./nodeMap";
import { emptyScene } from "./types";
import type { NodeLite, SceneState } from "./types";
import { makeSetPropsOp } from "../tools/ops";

const base = { visible: true, opacity: 1, x: 0, y: 0, width: 10, height: 10, rotation: 0, fills: [], strokes: [], cornerRadius: 0, clipsContent: false };
const rect = (id: string, over: Partial<NodeLite> = {}): NodeLite => ({ ...base, id, parentId: "page1", orderKey: id, name: id, kind: "rect", ...over });
const scene = (...ns: NodeLite[]): SceneState => ({ ...emptyScene("d", "t"), nodes: nodesOf(Object.fromEntries(ns.map((n) => [n.id, n]))) });

describe("taggedOf", () => {
  it("finds booleans, connectors and bound nodes, and nothing in a plain document", () => {
    const s = scene(
      rect("a"),
      rect("g", { kind: "group", meta: { "boolean.op": "union" } }),
      rect("c", { kind: "vector", meta: { "connector.from": "a", "connector.to": "g" } }),
      rect("b", { bindings: { fill: "v" } }),
    );
    const t = taggedOf(s);
    expect([...t.booleans]).toEqual(["g"]);
    expect([...t.connectors]).toEqual(["c"]);
    expect([...t.bound]).toEqual(["b"]);
    const plain = taggedOf(scene(rect("a"), rect("b")));
    expect(plain.booleans.size + plain.connectors.size + plain.bound.size).toBe(0);
  });

  it("follows an edit from the previous scene, and reuses the sets when nothing tagged changed", () => {
    const s0 = scene(rect("a"), rect("b", { bindings: { fill: "v" } }));
    const t0 = taggedOf(s0);
    const s1 = applyOp(s0, makeSetPropsOp("a", { x: 5 }, ["x"]));
    expect(taggedOf(s1).bound).toBe(t0.bound); // same set: nothing was copied
    const s2 = applyOp(s1, makeSetPropsOp("a", { meta: { "boolean.op": "union" } }, ["meta"]));
    // A rect is not a group: not a boolean. Make it a group's meta through a created group instead.
    expect(taggedOf(s2).booleans.size).toBe(0);
    const s3 = scene(rect("g", { kind: "group" }));
    const t3 = taggedOf(s3);
    const s4 = applyOp(s3, makeSetPropsOp("g", { meta: { "boolean.op": "union" } }, ["meta"]));
    expect(taggedOf(s4).booleans.has("g")).toBe(true);
    const s5 = applyOp(s4, makeSetPropsOp("g", { meta: {} }, ["meta"]));
    expect(taggedOf(s5).booleans.has("g")).toBe(false);
    expect(t3.booleans.size).toBe(0);
  });
});
