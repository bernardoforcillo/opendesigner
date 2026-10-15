import { describe, it, expect } from "vitest";
import { create } from "@bufbuild/protobuf";
import {
  ComponentPropertySchema, ComponentPropertyType, CreateComponentSchema, CreateNodeSchema, NodeSchema, OpSchema,
  SetComponentPropertiesSchema, SetInstancePropertySchema, SwapInstanceSchema,
} from "../gen/opendesigner/v1/opendesigner_pb";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { applyOp } from "./applyOp";
import { invertOp } from "./history";
import { emptyScene, type SceneState } from "./types";
import { renderOverrideMap, visibleUnder } from "./instances";
import { contentWorldBounds } from "./groups";
import { hitTest } from "../renderer/canvasRenderer";

// Parity with internal/core/properties_test.go, plus what only the client does:
// the property effects reach the render override map, hit-test and the bounds.

const op = (kind: Op["kind"]) => create(OpSchema, { opId: "o", docId: "d", kind });
const prop = (name: string, type: ComponentPropertyType, nodeId: string, defaultValue = "") =>
  create(ComponentPropertySchema, { name, type, nodeId, defaultValue });
const defineProps = (componentId: string, ...properties: ReturnType<typeof prop>[]) =>
  op({ case: "setComponentProperties", value: create(SetComponentPropertiesSchema, { componentId, properties }) });
const setValue = (instanceId: string, name: string, value: string) =>
  op({ case: "setInstanceProperty", value: create(SetInstancePropertySchema, { instanceId, name, value }) });
const node = (init: Parameters<typeof create<typeof NodeSchema>>[1]) =>
  op({ case: "createNode", value: create(CreateNodeSchema, { node: create(NodeSchema, { visible: true, opacity: 1, orderKey: "a0", parentId: "page1", ...(init as object) }) }) });

// A master GROUP (a frame would itself be hit over its whole box) with a text label and a
// 20x20 icon at x=70; component "c"; an instance "i" at (200, 0).
function scene(): SceneState {
  let s = emptyScene("d", "d");
  s = applyOp(s, node({ id: "m", name: "Button", shape: { case: "group", value: {} } }));
  s = applyOp(s, node({ id: "label", parentId: "m", name: "Label", width: 60, height: 20, shape: { case: "text", value: { content: "Master", style: { fontSize: 12 } } } }));
  s = applyOp(s, node({ id: "icon", parentId: "m", name: "Icon", x: 70, width: 20, height: 20, fills: [{ kind: { case: "solid", value: { color: { r: 1, g: 0, b: 1, a: 1 } } } }], shape: { case: "rect", value: { cornerRadius: 0 } } }));
  s = applyOp(s, op({ case: "createComponent", value: create(CreateComponentSchema, { componentId: "c", rootNodeId: "m", name: "Button" }) }));
  s = applyOp(s, node({ id: "i", name: "Inst", x: 200, width: 100, height: 40, orderKey: "z", shape: { case: "instance", value: { componentId: "c", overrides: [] } } }));
  return applyOp(s, defineProps("c",
    prop("Label", ComponentPropertyType.TEXT, "label", "Click"),
    prop("Icon", ComponentPropertyType.BOOLEAN, "icon", "false")));
}

describe("component property definitions", () => {
  it("stores them, defaulting a boolean to true, and refuses what Go refuses", () => {
    const s = scene();
    expect(s.components.c.properties).toEqual([
      { name: "Label", type: "text", nodeId: "label", defaultValue: "Click" },
      { name: "Icon", type: "boolean", nodeId: "icon", defaultValue: "false" },
    ]);
    const t = applyOp(s, defineProps("c", prop("Show", ComponentPropertyType.BOOLEAN, "icon")));
    expect(t.components.c.properties![0].defaultValue).toBe("true");
    for (const bad of [
      defineProps("ghost", prop("X", ComponentPropertyType.BOOLEAN, "icon")),
      defineProps("c", prop("X", ComponentPropertyType.BOOLEAN, "icon"), prop("X", ComponentPropertyType.TEXT, "label")),
      defineProps("c", prop("", ComponentPropertyType.BOOLEAN, "icon")),
      defineProps("c", prop("X", ComponentPropertyType.BOOLEAN, "i")),                    // outside the master
      defineProps("c", prop("X", ComponentPropertyType.BOOLEAN, "ghost")),
      defineProps("c", prop("X", ComponentPropertyType.TEXT, "icon")),                    // text on a rectangle
      defineProps("c", prop("X", ComponentPropertyType.BOOLEAN, "icon", "maybe")),
      defineProps("c", prop("X", ComponentPropertyType.UNSPECIFIED, "icon")),
    ]) expect(applyOp(s, bad)).toBe(s);
  });
});

describe("instance property values", () => {
  it("override the defaults, and an empty value goes back", () => {
    let s = applyOp(scene(), setValue("i", "Label", "Buy"));
    expect(s.nodes.at("i").instance!.propertyValues).toEqual({ Label: "Buy" });
    s = applyOp(s, setValue("i", "Label", ""));
    expect(s.nodes.at("i").instance!.propertyValues).toBeUndefined();
  });

  it("are refused for an unknown property, a bad boolean, or a non-instance", () => {
    const s = scene();
    expect(applyOp(s, setValue("i", "Nope", "x"))).toBe(s);
    expect(applyOp(s, setValue("i", "Icon", "maybe"))).toBe(s);
    expect(applyOp(s, setValue("m", "Icon", "true"))).toBe(s);
    expect(applyOp(s, setValue("ghost", "Icon", "true"))).toBe(s);
  });

  it("survive a swap to another component and then apply only where defined", () => {
    let s = applyOp(scene(), setValue("i", "Icon", "true"));
    s = applyOp(s, node({ id: "m2", name: "Other", width: 10, height: 10, orderKey: "m", shape: { case: "frame", value: { clipsContent: false } } }));
    s = applyOp(s, op({ case: "createComponent", value: create(CreateComponentSchema, { componentId: "c2", rootNodeId: "m2", name: "Other" }) }));
    s = applyOp(s, op({ case: "swapInstance", value: create(SwapInstanceSchema, { instanceId: "i", componentId: "c2" }) }));
    expect(s.nodes.at("i").instance!.propertyValues).toEqual({ Icon: "true" });
    expect(renderOverrideMap(s, s.nodes.at("i")).size).toBe(0);                          // c2 declares nothing
  });
});

describe("what the properties do on the canvas", () => {
  it("the render override map carries the text and the visibility, the explicit map does not", () => {
    const s = scene();
    const m = renderOverrideMap(s, s.nodes.at("i"));
    expect(m.get("label")).toMatchObject({ text: "Click" });
    expect(m.get("icon")).toMatchObject({ visible: false });
    const t = applyOp(applyOp(s, setValue("i", "Icon", "true")), setValue("i", "Label", "Buy"));
    const m2 = renderOverrideMap(t, t.nodes.at("i"));
    expect(m2.get("label")!.text).toBe("Buy");
    expect(visibleUnder(t.nodes.at("icon"), m2)).toBe(true);
    expect(visibleUnder(s.nodes.at("icon"), renderOverrideMap(s, s.nodes.at("i")))).toBe(false);
  });

  it("a property wins over an explicit override of the same node", () => {
    let s = scene();
    s = applyOp(s, op({ case: "setInstanceOverride", value: { instanceId: "i", override: { masterNodeId: "label", text: "Explicit", textPresent: true, fillsPresent: false, fills: [] } } as never }));
    expect(renderOverrideMap(s, s.nodes.at("i")).get("label")!.text).toBe("Click");
  });

  it("a hidden node is neither hit nor counted in the instance's bounds; showing it brings both back", () => {
    const hidden = scene();
    // The icon sits at master x 70..90; the instance at x 200, so world x 270..290.
    expect(hitTest(hidden, 280, 10, 1)).toBeNull();
    expect(contentWorldBounds(hidden, hidden.nodes.at("i"))!.width).toBe(60);              // only the label's 60 are left
    const shown = applyOp(hidden, setValue("i", "Icon", "true"));
    expect(hitTest(shown, 280, 10, 1)).toBe("i");
    expect(contentWorldBounds(shown, shown.nodes.at("i"))!.width).toBe(90);
  });
});

describe("undo", () => {
  it("restores the definitions and the instance values", () => {
    const s = scene();
    const redefine = defineProps("c", prop("Only", ComponentPropertyType.BOOLEAN, "icon"));
    const back = invertOp(s, redefine)!.reduce(applyOp, applyOp(s, redefine));
    expect(back.components.c.properties).toEqual(s.components.c.properties);

    const set = setValue("i", "Label", "Buy");
    const withValue = applyOp(s, set);
    expect(invertOp(s, set)!.reduce(applyOp, withValue).nodes.at("i").instance!.propertyValues).toBeUndefined();
    const change = setValue("i", "Label", "Sell");
    expect(invertOp(withValue, change)!.reduce(applyOp, applyOp(withValue, change)).nodes.at("i").instance!.propertyValues).toEqual({ Label: "Buy" });
  });

  it("has no inverse for a rejected op", () => {
    const s = scene();
    expect(invertOp(s, setValue("i", "Nope", "x"))).toBeNull();
    expect(invertOp(s, defineProps("ghost"))).toBeNull();
  });
});

describe("deleting a target layer", () => {
  const del = (id: string) => op({ case: "deleteNode", value: { id } as never });

  it("drops the property that pointed at it and keeps the others", () => {
    const s = applyOp(scene(), del("icon"));
    expect(s.components.c.properties!.map((p) => p.name)).toEqual(["Label"]);
    expect(applyOp(s, del("label")).components.c.properties).toBeUndefined();
  });

  it("is undone: the nodes and the properties come back", () => {
    const s = scene();
    const o = del("icon");
    const back = invertOp(s, o)!.reduce(applyOp, applyOp(s, o));
    expect(back.nodes.get("icon")).toBeDefined();
    expect(back.components.c.properties).toEqual(s.components.c.properties);
  });
});
