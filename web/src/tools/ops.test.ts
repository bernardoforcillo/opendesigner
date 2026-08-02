import { describe, it, expect, beforeEach } from "vitest";
import { create } from "@bufbuild/protobuf";
import { NodeSchema } from "../gen/brawt/v1/brawt_pb";
import { makeCreateNodeOp, makeDeleteOp, makeSetPropsOp, makeSetTextOp } from "./ops";
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
    expect(scene.nodes["t1"].text?.content).toBe("dopo");
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
