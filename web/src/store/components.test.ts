import { describe, it, expect } from "vitest";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { ComponentPropertyType, NodeSchema, OpSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { applyOp } from "./applyOp";
import { effectiveComponentId, effectiveOverrides } from "./components";
import { invertOp } from "./history";
import { instanceOverrideMap, hiddenMasterNodes, resolveInstance } from "./instances";
import { emptyScene, type SceneState } from "./types";

type Kind = MessageInitShape<typeof OpSchema>["kind"];
const op = (kind: Kind): Op => create(OpSchema, { opId: crypto.randomUUID(), docId: "d", kind });
const node = (id: string, parent: string, shape: "frame" | "text" | "rect" | "instance", componentId = "") =>
  op({ case: "createNode", value: { node: create(NodeSchema, {
    id, parentId: parent, orderKey: id, name: id, visible: true, opacity: 1, width: 40, height: 20,
    shape: shape === "text" ? { case: "text", value: { content: "Button", style: { fontSize: 14 } } }
      : shape === "instance" ? { case: "instance", value: { componentId } }
      : shape === "rect" ? { case: "rect", value: {} } : { case: "frame", value: {} },
  }) } });
const BOOL = ComponentPropertyType.BOOLEAN, TEXT = ComponentPropertyType.TEXT;
const prop = (name: string, type: ComponentPropertyType, defaultValue: string, targetNodeIds: string[]) => ({ name, type, defaultValue, targetNodeIds });
const def = (componentId: string, setId: string, variant: Record<string, string>, properties: ReturnType<typeof prop>[]) =>
  op({ case: "setComponentDef", value: { componentId, setId, variant, properties } });
const instProps = (instanceId: string, propertyValues: Record<string, string>, variantProps: Record<string, string>) =>
  op({ case: "setInstanceProps", value: { instanceId, propertyValues, variantProps } });
const run = (ops: Op[], from: SceneState = emptyScene("d", "d")) => ops.reduce(applyOp, from);

const base = () => run([
  node("m1", "page1", "frame"), node("label", "m1", "text"), node("icon", "m1", "rect"),
  node("m2", "page1", "frame"), node("label2", "m2", "text"), node("icon2", "m2", "rect"),
  op({ case: "createComponent", value: { componentId: "c1", rootNodeId: "m1", name: "Button" } }),
  op({ case: "createComponent", value: { componentId: "c2", rootNodeId: "m2", name: "Button hover" } }),
  op({ case: "setComponentSet", value: { componentSet: { id: "s", name: "Button", axes: [{ name: "State", options: ["default", "hover"] }] } } }),
  def("c1", "s", { State: "default" }, [prop("Label", TEXT, "Button", ["label"]), prop("ShowIcon", BOOL, "true", ["icon"])]),
  def("c2", "s", { State: "hover" }, [prop("Label", TEXT, "Button", ["label2"]), prop("ShowIcon", BOOL, "true", ["icon2"])]),
  node("i", "page1", "instance", "c1"),
]);

describe("resolution", () => {
  it("an instance renders the variant it chose, and keeps its other axes", () => {
    const s = base();
    expect(resolveInstance(s, s.nodes.at("i"))!.componentId).toBe("c1");
    const hover = applyOp(s, instProps("i", {}, { State: "hover" }));
    expect(resolveInstance(hover, hover.nodes.at("i"))!.componentId).toBe("c2");
    // A stale choice no member matches falls back to the base.
    const stale = { ...hover, nodes: hover.nodes.set("i", { ...hover.nodes.at("i"), instance: { componentId: "c1", overrides: [], variantProps: { State: "pressed" } } }) };
    expect(effectiveComponentId(stale, stale.nodes.at("i").instance!)).toBe("c1");
  });

  it("properties derive overrides by name across variants, explicit overrides win, and booleans hide", () => {
    let s = applyOp(base(), instProps("i", { Label: "Save", ShowIcon: "false" }, { State: "hover" }));
    const ov = effectiveOverrides(s, s.nodes.at("i"));
    expect(ov.get("label2")?.text).toBe("Save");
    expect(ov.get("icon2")?.hidden).toBe(true);
    expect(ov.has("label")).toBe(false);
    expect([...hiddenMasterNodes(s, s.nodes.at("i"))!]).toEqual(["icon2"]);
    s = applyOp(s, op({ case: "setInstanceOverride", value: { instanceId: "i", override: { masterNodeId: "label2", text: "Explicit", textPresent: true } } }));
    expect(instanceOverrideMap(s, s.nodes.at("i")).get("label2")?.text).toBe("Explicit");
  });

  it("an instance without properties pays nothing", () => {
    const s = run([node("m", "page1", "frame"), op({ case: "createComponent", value: { componentId: "c", rootNodeId: "m", name: "C" } }), node("i", "page1", "instance", "c")]);
    expect(hiddenMasterNodes(s, s.nodes.at("i"))).toBeNull();
  });
});

describe("validation", () => {
  const unchanged = (s: SceneState, bad: Op) => expect(applyOp(s, bad), JSON.stringify(bad.kind).slice(0, 80)).toBe(s);

  it("refuses the invalid sets, definitions and instance values", () => {
    const s = base();
    unchanged(s, op({ case: "setComponentSet", value: { componentSet: { id: "x", name: "x", axes: [] } } }));
    unchanged(s, op({ case: "setComponentSet", value: { componentSet: { id: "x", name: "x", axes: [{ name: "A", options: ["a", "a"] }] } } }));
    unchanged(s, op({ case: "setComponentSet", value: { componentSet: { id: "x", name: "x", axes: [{ name: "a;b", options: ["a"] }] } } }));
    unchanged(s, def("ghost", "s", { State: "default" }, []));
    unchanged(s, def("c1", "ghost", { State: "default" }, []));
    unchanged(s, def("c1", "s", {}, []));                                           // incomplete
    unchanged(s, def("c1", "s", { State: "pressed" }, []));                         // invalid option
    unchanged(s, def("c1", "", { State: "default" }, []));                          // variant without set
    unchanged(s, def("c2", "s", { State: "default" }, []));                         // duplicate combination
    unchanged(s, def("c1", "s", { State: "default" }, [prop("P", BOOL, "maybe", ["icon"])]));
    unchanged(s, def("c1", "s", { State: "default" }, [prop("P", BOOL, "true", ["icon2"])]));  // outside the master
    unchanged(s, def("c1", "s", { State: "default" }, [prop("P", TEXT, "x", ["icon"])]));      // not a text node
    unchanged(s, def("c1", "s", { State: "default" }, [prop("P", BOOL, "true", ["icon"]), prop("P", BOOL, "true", ["icon"])]));
    unchanged(s, def("c1", "s", { State: "default" }, [prop("P", BOOL, "true", [])]));
    unchanged(s, instProps("m1", {}, {}));                                          // not an instance
    unchanged(s, instProps("i", { Nope: "x" }, {}));
    unchanged(s, instProps("i", { ShowIcon: "yes" }, {}));
    unchanged(s, instProps("i", {}, { Color: "red" }));
    unchanged(s, instProps("i", {}, { State: "pressed" }));
    unchanged(s, instProps("i", { Label: "x".repeat(1001) }, {}));
  });

  it("counts a text value in BYTES, like Go", () => {
    const s = base();
    expect(applyOp(s, instProps("i", { Label: "x".repeat(1000) }, {})).nodes.at("i").instance!.propertyValues).toBeDefined();
    unchanged(s, instProps("i", { Label: "é".repeat(501) }, {}));      // 1002 bytes
  });
});

describe("cascades and undo", () => {
  const roundTrip = (before: SceneState, direct: Op) => {
    const inverse = invertOp(before, direct);
    expect(inverse, JSON.stringify(direct.kind).slice(0, 60)).not.toBeNull();
    const after = applyOp(before, direct);
    expect(after).not.toBe(before);
    const back = run(inverse!, after);
    for (const key of ["components", "componentSets", "nodes"] as const) expect(back[key], key).toEqual(before[key]);
    return after;
  };

  it("changing the axes detaches the members that no longer match; undo reattaches them", () => {
    const after = roundTrip(base(), op({ case: "setComponentSet", value: { componentSet: { id: "s", name: "Button", axes: [{ name: "State", options: ["default"] }] } } }));
    expect(after.components.c2.setId).toBeUndefined();
    expect(after.components.c1.setId).toBe("s");
  });

  it("deleting the set detaches every member; undo reattaches them", () => {
    const after = roundTrip(base(), op({ case: "deleteComponentSet", value: { id: "s" } }));
    expect(after.components.c1.setId).toBeUndefined();
    expect(after.components.c2.variant).toBeUndefined();
  });

  it("deleting a node removes it from the property targets; undo puts everything back", () => {
    const after = roundTrip(base(), op({ case: "deleteNode", value: { id: "icon" } }));
    expect(after.components.c1.properties!.map((p) => p.name)).toEqual(["Label"]);
    expect(after.components.c2.properties!.map((p) => p.name)).toEqual(["Label", "ShowIcon"]);
  });

  it("definition and instance edits are undone to the previous state", () => {
    roundTrip(base(), def("c1", "s", { State: "default" }, []));
    roundTrip(base(), instProps("i", { Label: "Save" }, { State: "hover" }));
    const set = applyOp(base(), instProps("i", { Label: "Save" }, {}));
    roundTrip(set, instProps("i", {}, {}));
  });

  it("rejected ops have no inverse", () => {
    const s = base();
    expect(invertOp(s, def("ghost", "", {}, []))).toBeNull();
    expect(invertOp(s, instProps("m1", {}, {}))).toBeNull();
    expect(invertOp(s, op({ case: "deleteComponentSet", value: { id: "ghost" } }))).toBeNull();
  });
});
