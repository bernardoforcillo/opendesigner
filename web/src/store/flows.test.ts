import { describe, it, expect } from "vitest";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { OpSchema, NodeSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { applyOp } from "./applyOp";
import { invertOp } from "./history";
import { emptyScene } from "./types";
import type { SceneState } from "./types";

const op = (kind: MessageInitShape<typeof OpSchema>["kind"]): Op => create(OpSchema, { opId: crypto.randomUUID(), docId: "d", kind });
const node = (id: string, parentId = "page1") => op({
  case: "createNode",
  value: { node: create(NodeSchema, { id, parentId, orderKey: id, name: id, visible: true, opacity: 1, width: 10, height: 10, shape: { case: "rect", value: {} } }) },
});
const flow = (id: string, startId = "") => op({ case: "setFlow", value: { flow: { id, name: id, description: "", startId } } });
const tr = (id: string, flowId: string, fromId: string, toId: string, elementId = "") =>
  op({ case: "setTransition", value: { transition: { id, flowId, fromId, toId, label: "", trigger: "click", elementId, guard: "", effect: "" } } });

function build(ops: Op[]): SceneState {
  return ops.reduce((s, o) => applyOp(s, o), emptyScene("d", "t"));
}

// Applies `o`, then its inverse: the scene must go back EXACTLY as it was.
function roundTrip(scene: SceneState, o: Op): SceneState {
  const inv = invertOp(scene, o);
  expect(inv).not.toBeNull();
  const after = applyOp(scene, o);
  expect(after).not.toEqual(scene);
  return (inv as Op[]).reduce((s, i) => applyOp(s, i), after);
}

describe("flows: applyOp", () => {
  const base = () => build([node("a"), node("b"), node("btn", "a"), flow("f1", "a"), tr("t1", "f1", "a", "b", "btn")]);

  it("rejects nonexistent references (scene unchanged)", () => {
    const s = base();
    expect(applyOp(s, flow("f2", "ghost"))).toBe(s);
    expect(applyOp(s, tr("t2", "nope", "a", "b"))).toBe(s);
    expect(applyOp(s, tr("t2", "f1", "a", "ghost"))).toBe(s);
    expect(applyOp(s, tr("t2", "f1", "a", "b", "ghost"))).toBe(s);
    expect(applyOp(s, op({ case: "deleteFlow", value: { id: "ghost" } }))).toBe(s);
    expect(applyOp(s, op({ case: "deleteTransition", value: { id: "ghost" } }))).toBe(s);
  });

  it("deleting a node removes the transitions, empties the start and resets the hotspot", () => {
    const s = base();
    const noBtn = applyOp(s, op({ case: "deleteNode", value: { id: "btn" } }));
    expect(noBtn.transitions.t1.elementId).toBe("");
    const noA = applyOp(s, op({ case: "deleteNode", value: { id: "a" } }));
    expect(noA.transitions).toEqual({});
    expect(noA.flows.f1.startId).toBe("");
  });

  it("deleting a flow deletes its transitions", () => {
    const s = base();
    const after = applyOp(s, op({ case: "deleteFlow", value: { id: "f1" } }));
    expect(after.flows).toEqual({});
    expect(after.transitions).toEqual({});
  });
});

describe("flows: undo (invertOp round-trip)", () => {
  const base = () => build([node("a"), node("b"), node("btn", "a"), flow("f1", "a"), tr("t1", "f1", "a", "b", "btn")]);

  it.each([
    ["setFlow nuovo", flow("f2")],
    ["setFlow su esistente", op({ case: "setFlow", value: { flow: { id: "f1", name: "Nuovo", description: "x", startId: "b" } } })],
    ["deleteFlow (with transitions)", op({ case: "deleteFlow", value: { id: "f1" } })],
    ["setTransition nuova", tr("t2", "f1", "b", "a")],
    ["setTransition su esistente", op({ case: "setTransition", value: { transition: { id: "t1", flowId: "f1", fromId: "a", toId: "b", label: "L", trigger: "submit", elementId: "", guard: "g", effect: "e" } } })],
    ["deleteTransition", op({ case: "deleteTransition", value: { id: "t1" } })],
    ["deleteNode dell'hotspot", op({ case: "deleteNode", value: { id: "btn" } })],
    ["deleteNode of a screen with start and edges", op({ case: "deleteNode", value: { id: "a" } })],
    ["deleteNode of the destination", op({ case: "deleteNode", value: { id: "b" } })],
  ])("%s", (_name, o) => {
    const s = base();
    expect(roundTrip(s, o)).toEqual(s);
  });

  it("deletePage brings back nodes, start and edges", () => {
    const s = build([
      op({ case: "createPage", value: { page: { id: "p2", name: "P2" } } }),
      node("a"), node("c", "p2"), flow("f1", "c"), tr("t1", "f1", "a", "c"),
    ]);
    expect(roundTrip(s, op({ case: "deletePage", value: { id: "p2" } }))).toEqual(s);
  });

  it("a rejected op has no inverse", () => {
    const s = base();
    expect(invertOp(s, tr("t2", "f1", "a", "ghost"))).toBeNull();
    expect(invertOp(s, op({ case: "deleteFlow", value: { id: "ghost" } }))).toBeNull();
  });
});
