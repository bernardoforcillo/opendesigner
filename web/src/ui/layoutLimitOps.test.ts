import { describe, it, expect } from "vitest";
import { create } from "@bufbuild/protobuf";
import { LayoutPositioning, NodeSchema, OpSchema } from "@/gen/opendesigner/v1/opendesigner_pb";
import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";
import { applyOp } from "@/store/applyOp";
import { emptyScene } from "@/store/types";
import { limitOf, limitOps, positioningOf, positioningOps } from "@/ui/layoutLimitOps";

const create1 = (id: string, parentId: string, shape: object, over: object = {}): Op =>
  create(OpSchema, { opId: id, docId: "d", kind: { case: "createNode", value: { node: create(NodeSchema, { id, parentId, orderKey: id, visible: true, opacity: 1, width: 40, height: 20, shape, ...over } as never) } } });

const scene = [
  create1("F", "page1", { case: "frame", value: { autoLayout: { spacing: 4 } } }, { width: 200, height: 50 }),
  create1("a", "F", { case: "rect", value: {} }),
  create1("b", "F", { case: "rect", value: {}, }, { maxWidth: 10 }),
].reduce(applyOp, emptyScene("d", "d"));

describe("limit and positioning ops", () => {
  it("reads a common value or undefined", () => {
    const a = scene.nodes.at("a"), b = scene.nodes.at("b");
    expect(limitOf([a], "maxWidth")).toBe(0);
    expect(limitOf([b], "maxWidth")).toBe(10);
    expect(limitOf([a, b], "maxWidth")).toBeUndefined();
    expect(positioningOf([a, b])).toBe("auto");
  });

  it("builds one op per node that differs, with the right mask", () => {
    const ops = limitOps(scene, ["a", "b"], "maxWidth", 10);
    expect(ops).toHaveLength(1);
    expect(ops[0].kind.case === "setProps" && ops[0].kind.value.mask?.paths).toEqual(["max_width"]);
    expect(limitOps(scene, ["a"], "minHeight", Number.NaN)).toHaveLength(0);
    const next = limitOps(scene, ["a"], "minHeight", 30).reduce(applyOp, scene);
    expect(next.nodes.at("a").minHeight).toBe(30);
    expect(next.nodes.at("a").height).toBe(30);
  });

  it("toggles absolute positioning", () => {
    const ops = positioningOps(scene, ["a"], "absolute");
    expect(ops).toHaveLength(1);
    expect(positioningOps(scene, ["a"], "auto")).toHaveLength(0);
    const next = ops.reduce(applyOp, scene);
    expect(next.nodes.at("a").layoutPositioning).toBe("absolute");
    expect(next.nodes.at("b").x).toBe(0);
    expect(LayoutPositioning.ABSOLUTE).toBe(1);
  });
});
