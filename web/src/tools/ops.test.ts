import { describe, it, expect, beforeEach } from "vitest";
import { create } from "@bufbuild/protobuf";
import { NodeSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import {
  makeCreateComponentOp, makeCreateNodeOp, makeDeleteOp, makeInstanceNode,
  makeSetInstanceOverrideOp, makeSetPropsOp, makeSetTextOp,
} from "./ops";
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

// SetText è un op DEDICATO, non un path della mask: il contenuto vive dentro il
// oneof `shape` del Node, mentre la mask indirizza campi di primo livello (vedi
// store/applyOp.ts). Lo stile e il suo flag viaggiano insieme -- passare uno
// stile senza style_present lo farebbe ignorare da Go (e da applyOp), passare
// il flag senza stile azzererebbe il font.
describe("makeSetTextOp", () => {
  it("carries the content and leaves the style untouched when none is given", () => {
    const op = makeSetTextOp("t1", "ciao\nmondo");
    expect(op.docId).toBe("doc-1");
    expect(op.opId).not.toBe("");
    expect(op.kind.case).toBe("setText");
    if (op.kind.case !== "setText") throw new Error("wrong kind");
    expect(op.kind.value.id).toBe("t1");
    expect(op.kind.value.content).toBe("ciao\nmondo");
    // Senza stile il flag DEVE restare false: con true (e nessuno stile) ogni
    // battuta di tasto porterebbe il font a 0.
    expect(op.kind.value.stylePresent).toBe(false);
    expect(op.kind.value.style).toBeUndefined();
  });

  it("sets style_present together with the style, never one without the other", () => {
    const op = makeSetTextOp("t1", "ciao", {
      fontFamily: "Inter", fontSize: 24, fontWeight: "700", lineHeight: 1.5, align: "center",
    });
    if (op.kind.case !== "setText") throw new Error("wrong kind");
    expect(op.kind.value.stylePresent).toBe(true);
    expect(op.kind.value.style).toMatchObject({ fontFamily: "Inter", fontSize: 24, fontWeight: "700" });
  });

  it("round-trips through applyOp: the content lands on the node", () => {
    let scene = applyOp(
      useScene.getState().scene!,
      makeCreateNodeOp(create(NodeSchema, {
        id: "t1", parentId: "page1", width: 200, height: 20,
        shape: { case: "text", value: { content: "prima" } },
      })),
    );
    scene = applyOp(scene, makeSetTextOp("t1", "dopo"));
    expect(scene.nodes.at("t1").text?.content).toBe("dopo");
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

// --- componenti / istanze (M4) ---------------------------------------------

describe("makeCreateComponentOp", () => {
  it("carries componentId, rootNodeId and name, with docId + a fresh opId", () => {
    const a = makeCreateComponentOp("cmp1", "root1", "Bottone");
    const b = makeCreateComponentOp("cmp1", "root1", "Bottone");
    expect(a.docId).toBe("doc-1");
    expect(a.opId).not.toBe("");
    expect(a.opId).not.toBe(b.opId);
    expect(a.kind.case).toBe("createComponent");
    if (a.kind.case !== "createComponent") throw new Error("wrong kind");
    expect(a.kind.value.componentId).toBe("cmp1");
    expect(a.kind.value.rootNodeId).toBe("root1");
    expect(a.kind.value.name).toBe("Bottone");
  });

  it("round-trips through applyOp: the component is registered pointing at the master", () => {
    let scene = applyOp(
      emptyScene("doc-1", "Untitled"),
      makeCreateNodeOp(create(NodeSchema, { id: "root1", parentId: "page1", orderKey: "a000001" })),
    );
    scene = applyOp(scene, makeCreateComponentOp("cmp1", "root1", "Bottone"));
    expect(scene.components["cmp1"]).toEqual({ rootNodeId: "root1", name: "Bottone" });
  });
});

describe("makeSetInstanceOverrideOp", () => {
  it("marks fills_present when fills are given, and maps them to solid paints", () => {
    const op = makeSetInstanceOverrideOp("inst1", {
      masterNodeId: "m1",
      fills: [{ r: 1, g: 0, b: 0, a: 1 }],
    });
    expect(op.kind.case).toBe("setInstanceOverride");
    if (op.kind.case !== "setInstanceOverride") throw new Error("wrong kind");
    expect(op.kind.value.instanceId).toBe("inst1");
    const o = op.kind.value.override;
    expect(o?.masterNodeId).toBe("m1");
    expect(o?.fillsPresent).toBe(true);
    // Il testo NON è stato dato: text_present resta false (non azzera il testo
    // ereditato).
    expect(o?.textPresent).toBe(false);
    expect(o?.fills[0]?.kind.case).toBe("solid");
  });

  it("an override with neither fills nor text is a REMOVAL: both *_present false", () => {
    const op = makeSetInstanceOverrideOp("inst1", { masterNodeId: "m1" });
    if (op.kind.case !== "setInstanceOverride") throw new Error("wrong kind");
    const o = op.kind.value.override;
    expect(o?.fillsPresent).toBe(false);
    expect(o?.textPresent).toBe(false);
  });
});

describe("makeInstanceNode", () => {
  it("builds a kind-instance Node carrying the componentId and no overrides", () => {
    const node = makeInstanceNode({
      id: "inst1", parentId: "page1", orderKey: "a000005", name: "Bottone",
      x: 30, y: 40, width: 100, height: 50, componentId: "cmp1",
    });
    expect(node.id).toBe("inst1");
    expect(node.parentId).toBe("page1");
    expect(node.visible).toBe(true);
    expect(node.opacity).toBe(1);
    expect(node.x).toBe(30);
    expect(node.width).toBe(100);
    expect(node.shape.case).toBe("instance");
    if (node.shape.case !== "instance") throw new Error("wrong shape");
    expect(node.shape.value.componentId).toBe("cmp1");
    expect(node.shape.value.overrides).toEqual([]);
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
    expect(scene.nodes.at("n1").x).toBe(1);

    scene = applyOp(scene, makeSetPropsOp("n1", { x: 100, width: 50 }, ["x", "width"]));
    expect(scene.nodes.at("n1")).toMatchObject({ x: 100, y: 2, width: 50, height: 4 });

    scene = applyOp(scene, makeDeleteOp("n1"));
    expect(scene.nodes.at("n1")).toBeUndefined();
  });
});
