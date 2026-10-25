import { describe, it, expect } from "vitest";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { ComponentPropertyType, NodeSchema, OpSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { applyOp } from "./applyOp";
import { invertOp } from "./history";
import { detachInstance, pageOf, resetInstance, swapInstance, swapSize } from "./instanceOps";
import { toPbNode, emptyScene, type SceneState } from "./types";
import { makeSetInstanceOp } from "../tools/ops";

// Swap, reset and detach of instances: the TypeScript half of internal/core/instances_test.go.

type Kind = MessageInitShape<typeof OpSchema>["kind"];
const op = (kind: Kind): Op => create(OpSchema, { opId: crypto.randomUUID(), docId: "d", kind });
const node = (id: string, parent: string, shape: "frame" | "text" | "rect" | "instance", componentId = "", w = 10, h = 10) =>
  op({ case: "createNode", value: { node: create(NodeSchema, {
    id, parentId: parent, orderKey: id, name: id.replace(/\d$/, ""), visible: true, opacity: 1, width: w, height: h,
    shape: shape === "text" ? { case: "text", value: { content: "Button", style: { fontSize: 14 } } }
      : shape === "instance" ? { case: "instance", value: { componentId } }
      : shape === "rect" ? { case: "rect", value: {} } : { case: "frame", value: {} },
  }) } });
const run = (ops: Op[], from: SceneState = emptyScene("d", "d")) => ops.reduce(applyOp, from);
const T = ComponentPropertyType;
const instProps = (propertyValues: Record<string, string>, variantProps: Record<string, string> = {}) =>
  op({ case: "setInstanceProps", value: { instanceId: "i", propertyValues, variantProps } });
const override = (masterNodeId: string, o: object) =>
  op({ case: "setInstanceOverride", value: { instanceId: "i", override: { masterNodeId, ...o } } });
const def = (componentId: string, label: string, icon: string, state: string) =>
  op({ case: "setComponentDef", value: { componentId, setId: "s", variant: { State: state }, properties: [
    { name: "Label", type: T.TEXT, defaultValue: "Button", targetNodeIds: [label], attribute: "", options: [] },
    { name: "ShowIcon", type: T.BOOLEAN, defaultValue: "true", targetNodeIds: [icon], attribute: "", options: [] },
  ] } });

const button = () => run([
  node("m1", "page1", "frame"), node("label", "m1", "text"), node("icon", "m1", "rect"),
  node("m2", "page1", "frame"), node("label2", "m2", "text"), node("icon2", "m2", "rect"),
  op({ case: "createComponent", value: { componentId: "c-default", rootNodeId: "m1", name: "Button" } }),
  op({ case: "createComponent", value: { componentId: "c-hover", rootNodeId: "m2", name: "Button hover" } }),
  op({ case: "setComponentSet", value: { componentSet: { id: "s", name: "Button", axes: [{ name: "State", options: ["default", "hover"] }] }, axisRenames: {}, optionRenames: [] } }),
  def("c-default", "label", "icon", "default"), def("c-hover", "label2", "icon2", "hover"),
  node("i", "page1", "instance", "c-default"),
]);

const withCard = (s: SceneState) => run([
  node("m3", "page1", "frame", "", 120, 80), node("label3", "m3", "text", "", 100, 20),
  node("icon3", "m3", "rect", "", 20, 20), node("extra3", "m3", "rect", "", 20, 20),
  op({ case: "createComponent", value: { componentId: "c-card", rootNodeId: "m3", name: "Card" } }),
], s);

const setInstance = (s: SceneState, inst: ReturnType<typeof swapInstance>) => applyOp(s, makeSetInstanceOp("i", inst!));

describe("swap", () => {
  it("carries over what fits, drops the rest", () => {
    let s = withCard(button());
    s = run([
      override("label", { text: "Pay", textPresent: true }),
      override("icon", { fills: [{ kind: { case: "solid", value: { color: { r: 1, g: 0, b: 0, a: 1 } } } }], fillsPresent: true }),
      instProps({ Label: "Pay", ShowIcon: "false" }),
    ], s);
    const next = swapInstance(s, "i", "c-card")!;
    expect(next.componentId).toBe("c-card");
    expect(next.propertyValues).toBeUndefined();
    expect(next.variantProps).toBeUndefined();
    expect(next.overrides.map((o) => [o.masterNodeId, o.text !== undefined, o.fills !== undefined]).sort())
      .toEqual([["icon3", false, true], ["label3", true, false]]);
    const swapped = setInstance(s, next);
    expect(swapped.nodes.at("i").instance?.componentId).toBe("c-card");
    expect(swapSize(swapped, swapped.nodes.at("i").instance!)).toEqual({ width: 120, height: 80 });
    // Undo is the previous payload.
    const inv = invertOp(s, makeSetInstanceOp("i", next))!;
    expect(run(inv, swapped).nodes.at("i")).toEqual(s.nodes.at("i"));
  });

  it("keeps property values and variant choice inside a set", () => {
    const s = run([instProps({ Label: "Go" }, { State: "hover" })], button());
    const same = swapInstance(s, "i", "c-hover")!;
    expect(same.propertyValues).toEqual({ Label: "Go" });
    expect(same.variantProps).toEqual({ State: "hover" });
  });

  it("rejects unknown components, stray overrides and cycles", () => {
    const s = withCard(button());
    const bad = (inst: object) => applyOp(s, op({ case: "setInstance", value: { instanceId: "i", instance: inst as never } }));
    expect(bad({ componentId: "nope" })).toBe(s);
    expect(bad({ componentId: "c-card", overrides: [{ masterNodeId: "label", text: "x", textPresent: true }] })).toBe(s);
    expect(bad({ componentId: "c-card", overrides: [{ masterNodeId: "label3" }] })).toBe(s);
    expect(bad({ componentId: "c-card", propertyValues: { Label: "x" } })).toBe(s);
    expect(bad({ componentId: "c-card", variantProps: { State: "hover" } })).toBe(s);
    // A rectangle is not an instance.
    expect(applyOp(s, op({ case: "setInstance", value: { instanceId: "icon", instance: { componentId: "c-card" } } }))).toBe(s);
    // A button instance inside the card's master cannot show the card.
    const nested = run([node("nested", "m3", "instance", "c-default")], s);
    expect(applyOp(nested, op({ case: "setInstance", value: { instanceId: "nested", instance: { componentId: "c-card" } } }))).toBe(nested);
  });
});

describe("reset", () => {
  it("clears overrides, property values and variant choice", () => {
    let s = run([override("label", { text: "Pay", textPresent: true }), instProps({ ShowIcon: "false" }, { State: "hover" })], button());
    s = setInstance(s, resetInstance(s, "i"));
    expect(s.nodes.at("i").instance).toEqual({ componentId: "c-default", overrides: [] });
  });
});

describe("detach", () => {
  it("copies the master with the overrides baked in, in place of the instance", () => {
    let s = run([
      op({ case: "setProps", value: { id: "i", mask: { paths: ["name", "x", "y", "width", "height"] }, patch: create(NodeSchema, { name: "Pay button", x: 40, y: 50, width: 90, height: 30 }) } }),
      override("label", { text: "Pay", textPresent: true }),
      instProps({ ShowIcon: "false" }),
    ], button());
    let n = 0;
    const nodes = detachInstance(s, "i", () => `d${++n}`)!;
    s = run([op({ case: "deleteNode", value: { id: "i" } }), ...nodes.map((x) => op({ case: "createNode", value: { node: toPbNode(x) } }))], s);
    const root = s.nodes.at("i");
    expect(root).toMatchObject({ kind: "frame", name: "Pay button", x: 40, y: 50, width: 90, height: 30, parentId: "page1" });
    const kids = [...s.nodes.values()].filter((x) => x.parentId === "i");
    expect(kids).toHaveLength(2);
    expect(kids.find((k) => k.kind === "text")?.text?.content).toBe("Pay");
    expect(kids.find((k) => k.kind === "rect")?.visible).toBe(false);
    expect(s.nodes.at("label").text?.content).toBe("Button");   // the master is untouched
    expect(detachInstance(s, "label", () => "x")).toBeNull();
  });

  it("finds the page of a master", () => {
    expect(pageOf(button(), "label")).toBe("page1");
  });
});
