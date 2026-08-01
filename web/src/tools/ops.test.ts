import { describe, it, expect, beforeEach } from "vitest";
import { create } from "@bufbuild/protobuf";
import { NodeSchema } from "../gen/brawt/v1/brawt_pb";
import { makeCreateNodeOp, makeDeleteOp, makeSetPropsOp } from "./ops";
import { useScene } from "../store/store";
import { applyOp } from "../store/applyOp";
import { emptyScene } from "../store/types";

beforeEach(() => {
  useScene.setState({
    scene: emptyScene("doc-1", "Untitled"),
    camera: { x: 0, y: 0, zoom: 1 },
    selection: [],
    marquee: null,
  });
});

describe("makeCreateNodeOp", () => {
  it("wraps the node and stamps docId from the store + a unique opId", () => {
    const node = create(NodeSchema, { id: "n1", parentId: "page1", width: 10, height: 20 });
    const a = makeCreateNodeOp(node);
    const b = makeCreateNodeOp(node);

    expect(a.docId).toBe("doc-1");
    expect(a.kind.case).toBe("createNode");
    expect(a.kind.case === "createNode" && a.kind.value.node?.id).toBe("n1");
    expect(a.opId).not.toBe("");
    expect(a.opId).not.toBe(b.opId);
  });

  it("falls back to an empty docId when no document is loaded", () => {
    useScene.setState({ scene: null });
    expect(makeCreateNodeOp(create(NodeSchema, { id: "n1" })).docId).toBe("");
  });
});

describe("makeSetPropsOp", () => {
  it("carries the patch and the mask paths", () => {
    const op = makeSetPropsOp("n1", { x: 5, y: 7 }, ["x", "y"]);
    expect(op.docId).toBe("doc-1");
    expect(op.kind.case).toBe("setProps");
    if (op.kind.case !== "setProps") throw new Error("wrong kind");
    expect(op.kind.value.id).toBe("n1");
    expect(op.kind.value.patch?.x).toBe(5);
    expect(op.kind.value.patch?.y).toBe(7);
    expect(op.kind.value.mask?.paths).toEqual(["x", "y"]);
  });
});

describe("makeDeleteOp", () => {
  it("targets the id", () => {
    const op = makeDeleteOp("n1");
    expect(op.docId).toBe("doc-1");
    expect(op.kind.case).toBe("deleteNode");
    expect(op.kind.case === "deleteNode" && op.kind.value.id).toBe("n1");
  });
});

describe("ops feed applyOp", () => {
  it("create -> setProps -> delete round-trips through the reducer", () => {
    let scene = emptyScene("doc-1", "Untitled");
    scene = applyOp(
      scene,
      makeCreateNodeOp(
        create(NodeSchema, {
          id: "n1", parentId: "page1", orderKey: "a000000", visible: true, opacity: 1,
          x: 1, y: 2, width: 3, height: 4, shape: { case: "rect", value: { cornerRadius: 0 } },
        }),
      ),
    );
    expect(scene.nodes["n1"].x).toBe(1);

    scene = applyOp(scene, makeSetPropsOp("n1", { x: 100, width: 50 }, ["x", "width"]));
    expect(scene.nodes["n1"]).toMatchObject({ x: 100, y: 2, width: 50, height: 4 });

    scene = applyOp(scene, makeDeleteOp("n1"));
    expect(scene.nodes["n1"]).toBeUndefined();
  });
});
