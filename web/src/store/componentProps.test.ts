import { describe, it, expect } from "vitest";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { ComponentPropertyType, NodeSchema, OpSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { hitTest, withOverride } from "../renderer/canvasRenderer";
import { applyOp } from "./applyOp";
import { effectiveOverrides, parseNumber, propertyValue } from "./components";
import { contentWorldBounds } from "./groups";
import { invertOp } from "./history";
import { instanceOverrideMap, resolveInstance } from "./instances";
import { emptyScene, type SceneState } from "./types";

// NUMBER / INSTANCE_SWAP properties and option lists on TEXT, and rename-aware set edits:
// the TypeScript half of internal/core/components_props_test.go.

type Kind = MessageInitShape<typeof OpSchema>["kind"];
const op = (kind: Kind): Op => create(OpSchema, { opId: crypto.randomUUID(), docId: "d", kind });
const node = (id: string, parent: string, shape: "frame" | "text" | "rect" | "instance", componentId = "", w = 40, h = 20, x = 0) =>
  op({ case: "createNode", value: { node: create(NodeSchema, {
    id, parentId: parent, orderKey: id, name: id, visible: true, opacity: 1, width: w, height: h, x,
    shape: shape === "text" ? { case: "text", value: { content: "Button", style: { fontSize: 14 } } }
      : shape === "instance" ? { case: "instance", value: { componentId } }
      : shape === "rect" ? { case: "rect", value: {} } : { case: "frame", value: {} },
  }) } });
const T = ComponentPropertyType;
interface PropInit { name: string; type: ComponentPropertyType; defaultValue: string; targetNodeIds: string[]; attribute?: string; options?: string[] }
const prop = (name: string, type: ComponentPropertyType, defaultValue: string, targetNodeIds: string[], more: Partial<PropInit> = {}): PropInit =>
  ({ name, type, defaultValue, targetNodeIds, ...more });
const def = (componentId: string, properties: PropInit[], setId = "", variant: Record<string, string> = {}) =>
  op({ case: "setComponentDef", value: { componentId, setId, variant, properties } });
const instProps = (instanceId: string, propertyValues: Record<string, string>, variantProps: Record<string, string> = {}) =>
  op({ case: "setInstanceProps", value: { instanceId, propertyValues, variantProps } });
const run = (ops: Op[], from: SceneState = emptyScene("d", "d")) => ops.reduce(applyOp, from);

// c1: master m1 { label (text), icon (rect), nest (instance of small) }; small and big masters.
const base = () => run([
  node("ms", "page1", "frame", "", 10, 10, 1000), node("mb", "page1", "frame", "", 100, 50, 1000),
  op({ case: "createComponent", value: { componentId: "small", rootNodeId: "ms", name: "Small" } }),
  op({ case: "createComponent", value: { componentId: "big", rootNodeId: "mb", name: "Big" } }),
  node("m1", "page1", "frame"), node("label", "m1", "text"), node("icon", "m1", "rect"), node("nest", "m1", "instance", "small", 10, 10),
  op({ case: "createComponent", value: { componentId: "c1", rootNodeId: "m1", name: "Card" } }),
  def("c1", [
    prop("Alpha", T.NUMBER, "0.5", ["label"], { attribute: "opacity" }),
    prop("Radius", T.NUMBER, "4", ["icon"], { attribute: "corner_radius" }),
    prop("Size", T.NUMBER, "16", ["label"], { attribute: "font_size" }),
    prop("Inner", T.INSTANCE_SWAP, "", ["nest"]),
    prop("Tone", T.TEXT, "a", ["label"], { options: ["a", "b"] }),
  ]),
  node("i", "page1", "instance", "c1"),
]);

describe("validation", () => {
  const unchanged = (s: SceneState, bad: Op) => expect(applyOp(s, bad), JSON.stringify(bad.kind).slice(0, 90)).toBe(s);

  it("refuses the invalid number, swap and option properties", () => {
    const s = base();
    unchanged(s, def("c1", [prop("X", T.NUMBER, "2", ["label"], { attribute: "opacity" })]));
    unchanged(s, def("c1", [prop("X", T.NUMBER, "1", ["label"])]));                              // no attribute
    unchanged(s, def("c1", [prop("X", T.NUMBER, "1", ["label"], { attribute: "width" })]));
    unchanged(s, def("c1", [prop("X", T.NUMBER, "0x10", ["label"], { attribute: "font_size" })]));
    unchanged(s, def("c1", [prop("X", T.NUMBER, "4", ["label"], { attribute: "corner_radius" })])); // not a rect
    unchanged(s, def("c1", [prop("X", T.NUMBER, "4", ["icon"], { attribute: "font_size" })]));     // not a text
    unchanged(s, def("c1", [prop("X", T.TEXT, "", ["label"], { attribute: "opacity" })]));
    unchanged(s, def("c1", [prop("X", T.INSTANCE_SWAP, "big", ["label"])]));                       // not an instance
    unchanged(s, def("c1", [prop("X", T.INSTANCE_SWAP, "ghost", ["nest"])]));
    unchanged(s, def("c1", [prop("X", T.INSTANCE_SWAP, "c1", ["nest"])]));                          // into itself
    unchanged(s, def("c1", [prop("X", T.TEXT, "z", ["label"], { options: ["a"] })]));               // default outside options
    unchanged(s, def("c1", [prop("X", T.TEXT, "a", ["label"], { options: ["a", "a"] })]));
    unchanged(s, def("c1", [prop("X", T.NUMBER, "1", ["label"], { attribute: "opacity", options: ["1"] })]));
  });

  it("validates the instance values per type", () => {
    const s = base();
    for (const v of <Record<string, string>[]>[{ Alpha: "0.2" }, { Radius: "8" }, { Size: "20" }, { Inner: "big" }, { Tone: "b" }]) {
      expect(applyOp(s, instProps("i", v)), JSON.stringify(v)).not.toBe(s);
    }
    for (const v of <Record<string, string>[]>[{ Alpha: "1.5" }, { Radius: "-1" }, { Size: "0" }, { Size: "NaN" }, { Inner: "ghost" }, { Tone: "free" }]) {
      unchanged(s, instProps("i", v));
    }
  });

  it("reads numbers like Go", () => {
    expect(parseNumber("opacity", "0.5")).toBe(0.5);
    expect(parseNumber("font_size", "1e2")).toBe(100);
    expect(parseNumber("font_size", ".5")).toBe(0.5);
    for (const v of ["", " 1", "0x10", "Infinity", "1_0", "--1"]) expect(parseNumber("font_size", v), v).toBeNull();
    expect(parseNumber("opacity", "-0.1")).toBeNull();
  });

  it("an invalid stored value falls back to the default", () => {
    const s = base();
    const p = s.components.c1.properties!.find((x) => x.name === "Alpha")!;
    expect(propertyValue(s, { propertyValues: { Alpha: "9" } }, p)).toBe("0.5");
    expect(propertyValue(s, { propertyValues: { Alpha: "0.9" } }, p)).toBe("0.9");
  });
});

describe("rendering overrides", () => {
  it("numbers and swaps derive overrides; withOverride writes the attributes", () => {
    const s = applyOp(base(), instProps("i", { Alpha: "0.25", Radius: "9", Size: "30", Inner: "big" }));
    const ov = effectiveOverrides(s, s.nodes.at("i"));
    expect(ov.get("label")).toMatchObject({ opacity: 0.25, fontSize: 30 });
    expect(ov.get("icon")?.cornerRadius).toBe(9);
    expect(ov.get("nest")?.componentId).toBe("big");
    const label = withOverride(s.nodes.at("label"), ov.get("label"));
    expect(label.opacity).toBe(0.25);
    expect(label.text?.style.fontSize).toBe(30);
    expect(withOverride(s.nodes.at("icon"), ov.get("icon")).cornerRadius).toBe(9);
    // A corner radius only reaches rectangles; defaults apply without values.
    expect(withOverride(s.nodes.at("label"), { masterNodeId: "label", cornerRadius: 9 }).cornerRadius).toBe(0);
    expect(effectiveOverrides(base(), base().nodes.at("i")).get("label")).toMatchObject({ opacity: 0.5, fontSize: 16, text: "a" });
    expect(effectiveOverrides(base(), base().nodes.at("i")).has("nest")).toBe(false);
  });

  it("a swapped nested instance resolves, measures and hits the component it was swapped to", () => {
    const plain = base();
    const swapped = applyOp(plain, instProps("i", { Inner: "big" }));
    const nest = (s: SceneState) => s.nodes.at("nest");
    const ovOf = (s: SceneState) => instanceOverrideMap(s, s.nodes.at("i"));
    expect(resolveInstance(plain, nest(plain), ovOf(plain))!.componentId).toBe("small");
    expect(resolveInstance(swapped, nest(swapped), ovOf(swapped))!.componentId).toBe("big");
    // The bounds follow: the big master (100 wide) sticks out of the 40 wide card.
    expect(contentWorldBounds(plain, plain.nodes.at("i"))!.width).toBe(40);
    expect(contentWorldBounds(swapped, swapped.nodes.at("i"))!.width).toBe(100);
    // ...and so does the hit-test (the instance is opaque to selection from outside).
    expect(hitTest(plain, 70, 10, 1)).toBeNull();
    expect(hitTest(swapped, 70, 10, 1)).toBe("i");
  });

  it("a swapped nested instance reads the properties of the component it was swapped to", () => {
    let s = applyOp(base(), def("big", [prop("Hide", T.BOOLEAN, "false", ["mb"])]));
    s = applyOp(s, instProps("i", { Inner: "big" }));
    const nested = instanceOverrideMap(s, s.nodes.at("nest"), instanceOverrideMap(s, s.nodes.at("i")));
    expect(nested.get("mb")?.hidden).toBe(true);
  });
});

describe("rename-aware set edits", () => {
  const SET = (axes: { name: string; options: string[] }[], axisRenames: Record<string, string> = {}, optionRenames: { axis: string; from: string; to: string }[] = []) =>
    op({ case: "setComponentSet", value: { componentSet: { id: "s", name: "Button", axes }, axisRenames, optionRenames } });
  const variants = () => run([
    node("m1", "page1", "frame"), node("m2", "page1", "frame"),
    op({ case: "createComponent", value: { componentId: "c1", rootNodeId: "m1", name: "Default" } }),
    op({ case: "createComponent", value: { componentId: "c2", rootNodeId: "m2", name: "Hover" } }),
    SET([{ name: "State", options: ["default", "hover"] }]),
    def("c1", [], "s", { State: "default" }), def("c2", [], "s", { State: "hover" }),
    node("i", "page1", "instance", "c1"),
    instProps("i", {}, { State: "hover" }),
  ]);
  const unchanged = (s: SceneState, bad: Op) => expect(applyOp(s, bad), JSON.stringify(bad.kind).slice(0, 90)).toBe(s);

  it("members and instances keep their choices over a rename; without it they are detached", () => {
    const s = variants();
    const plain = applyOp(s, SET([{ name: "Mode", options: ["default", "pressed"] }]));
    expect(plain.components.c1.setId).toBeUndefined();                      // no rename: detached, as before
    const next = applyOp(s, SET([{ name: "Mode", options: ["default", "pressed", "off"] }], { State: "Mode" }, [{ axis: "Mode", from: "hover", to: "pressed" }]));
    expect(next.components.c2).toMatchObject({ setId: "s", variant: { Mode: "pressed" } });
    expect(next.components.c1).toMatchObject({ setId: "s", variant: { Mode: "default" } });
    expect(next.nodes.at("i").instance!.variantProps).toEqual({ Mode: "pressed" });
    expect(resolveInstance(next, next.nodes.at("i"))!.componentId).toBe("c2");
  });

  it("refuses renames that are not one-to-one, point nowhere or merge members", () => {
    const s = variants();
    const two = [{ name: "Mode", options: ["default", "pressed"] }];
    unchanged(s, SET(two, { State: "Ghost" }));
    unchanged(s, SET(two, {}, [{ axis: "Mode", from: "hover", to: "huge" }]));
    unchanged(s, SET(two, {}, [{ axis: "Ghost", from: "a", to: "b" }]));
    unchanged(s, SET(two, { A: "Mode", B: "Mode" }));
    unchanged(s, SET(two, {}, [{ axis: "Mode", from: "hover", to: "default" }, { axis: "Mode", from: "x", to: "default" }]));
    unchanged(s, SET([{ name: "State", options: ["default", "off"] }], {}, [{ axis: "State", from: "hover", to: "default" }])); // merges c1 and c2
  });

  it("undo puts names, members and instances back", () => {
    const before = variants();
    const rename = SET([{ name: "Mode", options: ["default", "pressed", "off"] }], { State: "Mode" }, [{ axis: "Mode", from: "hover", to: "pressed" }]);
    const inverse = invertOp(before, rename);
    expect(inverse).not.toBeNull();
    const back = run(inverse!, applyOp(before, rename));
    for (const key of ["components", "componentSets", "nodes"] as const) expect(back[key], key).toEqual(before[key]);
    // A rename together with an option dropped: the detached member comes back too.
    const lossy = SET([{ name: "Mode", options: ["default"] }], { State: "Mode" });
    const after = applyOp(before, lossy);
    expect(after.components.c2.setId).toBeUndefined();
    const undone = run(invertOp(before, lossy)!, after);
    for (const key of ["components", "componentSets", "nodes"] as const) expect(undone[key], key).toEqual(before[key]);
  });
});
