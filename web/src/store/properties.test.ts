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

// --- number, option-list and instance-swap properties (parity with core/properties_test.go) ---

const instProp = (name: string, type: ComponentPropertyType, nodeId: string, extra: Partial<{ defaultValue: string; attribute: string; options: string[] }> = {}) =>
  create(ComponentPropertySchema, { name, type, nodeId, ...extra });

// A master group "Card" (component "card") with a text "Title", a rect "Bg" (radius 4) and a nested
// instance "icon" of component "star"; components "heart" and "dot" are other plain masters.
function cardScene(): SceneState {
  let s = emptyScene("d", "d");
  const frameShape = { shape: { case: "frame" as const, value: { clipsContent: false } } };
  for (const id of ["star", "heart", "dot"]) {
    s = applyOp(s, node({ id, name: id, width: id === "heart" ? 40 : 10, height: 10, orderKey: id, ...frameShape }));
    s = applyOp(s, op({ case: "createComponent", value: create(CreateComponentSchema, { componentId: id, rootNodeId: id, name: id }) }));
  }
  s = applyOp(s, node({ id: "card", name: "Card", shape: { case: "group", value: {} } }));
  s = applyOp(s, node({ id: "title", parentId: "card", name: "Title", width: 60, height: 20, shape: { case: "text", value: { content: "Card", style: { fontSize: 12 } } } }));
  s = applyOp(s, node({ id: "bg", parentId: "card", orderKey: "a1", name: "Bg", width: 60, height: 20, shape: { case: "rect", value: { cornerRadius: 4 } } }));
  s = applyOp(s, node({ id: "icon", parentId: "card", orderKey: "a2", name: "Icon", x: 70, width: 10, height: 10, shape: { case: "instance", value: { componentId: "star", overrides: [] } } }));
  s = applyOp(s, op({ case: "createComponent", value: create(CreateComponentSchema, { componentId: "card", rootNodeId: "card", name: "Card" }) }));
  s = applyOp(s, node({ id: "i", name: "Inst", x: 200, width: 100, height: 40, orderKey: "z", shape: { case: "instance", value: { componentId: "card", overrides: [] } } }));
  return applyOp(s, defineProps("card",
    instProp("Tone", ComponentPropertyType.TEXT, "title", { options: ["Info", "Warn"], defaultValue: "Info" }),
    instProp("Radius", ComponentPropertyType.NUMBER, "bg", { attribute: "corner_radius", defaultValue: "8" }),
    instProp("Fade", ComponentPropertyType.NUMBER, "bg", { attribute: "opacity" }),
    instProp("Size", ComponentPropertyType.NUMBER, "title", { attribute: "font_size" }),
    instProp("Icon", ComponentPropertyType.INSTANCE_SWAP, "icon", { defaultValue: "star" })));
}

describe("number properties", () => {
  it("are validated like Go: attribute, fitting node, numeric default", () => {
    const s = cardScene();
    expect(s.components.card.properties).toHaveLength(5);
    for (const bad of [
      defineProps("card", instProp("X", ComponentPropertyType.NUMBER, "bg")),                                        // no attribute
      defineProps("card", instProp("X", ComponentPropertyType.NUMBER, "bg", { attribute: "width" })),               // unknown attribute
      defineProps("card", instProp("X", ComponentPropertyType.NUMBER, "title", { attribute: "corner_radius" })),    // radius on a text
      defineProps("card", instProp("X", ComponentPropertyType.NUMBER, "bg", { attribute: "font_size" })),           // size on a rect
      defineProps("card", instProp("X", ComponentPropertyType.NUMBER, "bg", { attribute: "opacity", defaultValue: "lots" })),
    ]) expect(applyOp(s, bad)).toBe(s);
  });

  it("reach the render override map clamped, and a non-number value is refused", () => {
    let s = cardScene();
    const fx = (x: SceneState) => renderOverrideMap(x, x.nodes.at("i")).get("bg")!;
    expect(fx(s)).toMatchObject({ cornerRadius: 8 });                                  // the default; Fade has none, so no opacity
    expect(fx(s).opacity).toBeUndefined();
    s = applyOp(applyOp(s, setValue("i", "Fade", "7")), setValue("i", "Radius", "-3"));
    expect(fx(s)).toMatchObject({ opacity: 1, cornerRadius: 0 });                       // clamped, never negative
    expect(applyOp(s, setValue("i", "Radius", "wide"))).toBe(s);
    expect(renderOverrideMap(s, s.nodes.at("i")).get("title")).toMatchObject({ text: "Info" });
  });
});

describe("option-list properties", () => {
  it("accept only their options", () => {
    const s = cardScene();
    expect(applyOp(s, setValue("i", "Tone", "Warn")).nodes.at("i").instance!.propertyValues).toEqual({ Tone: "Warn" });
    expect(applyOp(s, setValue("i", "Tone", "Danger"))).toBe(s);
    for (const bad of [
      defineProps("card", instProp("T", ComponentPropertyType.TEXT, "title", { options: ["A", "A"] })),
      defineProps("card", instProp("T", ComponentPropertyType.TEXT, "title", { options: ["A", ""] })),
      defineProps("card", instProp("T", ComponentPropertyType.TEXT, "title", { options: ["A"], defaultValue: "B" })),
    ]) expect(applyOp(s, bad)).toBe(s);
  });
});

describe("instance-swap properties", () => {
  it("are validated: a nested instance, an existing component, never itself", () => {
    const s = cardScene();
    for (const bad of [
      defineProps("card", instProp("X", ComponentPropertyType.INSTANCE_SWAP, "title")),                               // not an instance
      defineProps("card", instProp("X", ComponentPropertyType.INSTANCE_SWAP, "icon", { defaultValue: "ghost" })),
      defineProps("card", instProp("X", ComponentPropertyType.INSTANCE_SWAP, "icon", { defaultValue: "card" })),     // into itself
    ]) expect(applyOp(s, bad)).toBe(s);
    expect(applyOp(s, setValue("i", "Icon", "ghost"))).toBe(s);
  });

  it("make the nested instance show another component: drawn there, hit there, counted there", () => {
    let s = cardScene();
    // star is 10 wide at the icon's x=70, so the instance's content spans 0..80 (60 for the card + the icon at 70..80).
    expect(contentWorldBounds(s, s.nodes.at("i"))!.width).toBe(80);
    s = applyOp(s, setValue("i", "Icon", "heart"));                                    // heart is 40 wide
    expect(renderOverrideMap(s, s.nodes.at("i")).get("icon")).toMatchObject({ componentId: "heart" });
    expect(contentWorldBounds(s, s.nodes.at("i"))!.width).toBe(110);                    // 70 + 40
    expect(hitTest(s, 200 + 105, 5, 1)).toBe("i");                                      // inside heart, outside star
    const back = applyOp(s, setValue("i", ""+"Icon", ""));
    expect(contentWorldBounds(back, back.nodes.at("i"))!.width).toBe(80);
    expect(hitTest(back, 200 + 105, 5, 1)).toBeNull();
  });

  it("a swapped nested instance reads the properties of the component it was swapped to", () => {
    let s = cardScene();
    // heart gets its own boolean property on a child; the instance's values name it.
    s = applyOp(s, node({ id: "h-badge", parentId: "heart", name: "Badge", width: 5, height: 5, shape: { case: "rect", value: { cornerRadius: 0 } } }));
    s = applyOp(s, defineProps("heart", prop("Badge", ComponentPropertyType.BOOLEAN, "h-badge", "false")));
    s = applyOp(s, setValue("i", "Icon", "heart"));
    // The outer instance has no value for "Badge" (it is not one of card's properties), so the default applies.
    const outer = renderOverrideMap(s, s.nodes.at("i"));
    const inner = renderOverrideMap(s, s.nodes.at("icon"), outer);
    expect(inner.get("h-badge")).toMatchObject({ visible: false });
  });
});

describe("undo of the new kinds", () => {
  it("restores definitions with their attribute and options", () => {
    const s = cardScene();
    const redefine = defineProps("card", instProp("Only", ComponentPropertyType.BOOLEAN, "bg"));
    const back = invertOp(s, redefine)!.reduce(applyOp, applyOp(s, redefine));
    expect(back.components.card.properties).toEqual(s.components.card.properties);
    expect(back.components.card.properties![0].options).toEqual(["Info", "Warn"]);
    expect(back.components.card.properties![1].attribute).toBe("corner_radius");
  });
});

describe("what withOverride draws for number properties", () => {
  it("writes opacity, radius (rect only) and font size (text only), never to the wrong node", async () => {
    const { withOverride } = await import("../renderer/canvasRenderer");
    const s = cardScene();
    const bg = withOverride(s.nodes.at("bg"), { masterNodeId: "bg", opacity: 0.25, cornerRadius: 12, fontSize: 30 });
    expect(bg).toMatchObject({ opacity: 0.25, cornerRadius: 12 });
    const title = withOverride(s.nodes.at("title"), { masterNodeId: "title", cornerRadius: 12, fontSize: 30 });
    expect(title.text!.style.fontSize).toBe(30);
    expect(title.cornerRadius).toBe(s.nodes.at("title").cornerRadius);             // a text has no radius to set
    expect(bg.text).toBeUndefined();                                               // a rect has no font size
  });
});
