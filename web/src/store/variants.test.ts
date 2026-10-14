import { describe, it, expect } from "vitest";
import { create } from "@bufbuild/protobuf";
import {
  CreateComponentSchema, CreateNodeSchema, NodeSchema, OpSchema, SetComponentSetSchema, DeleteComponentSetSchema, SetComponentVariantSchema,
  SwapInstanceSchema, ComponentSetSchema, VariantPropertySchema, SetInstanceOverrideSchema, InstanceOverrideSchema,
} from "../gen/opendesigner/v1/opendesigner_pb";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { applyOp } from "./applyOp";
import { invertOp } from "./history";
import { emptyScene, type SceneState } from "./types";
import { variantWith } from "./variants";

// Parity with internal/core/variants_test.go: same ops, same accept/reject.

const op = (kind: Op["kind"]) => create(OpSchema, { opId: "o", docId: "d", kind });
const prop = (name: string, ...values: string[]) => create(VariantPropertySchema, { name, values });
const setOf = (id: string, name: string, ...props: ReturnType<typeof prop>[]) =>
  op({ case: "setComponentSet", value: create(SetComponentSetSchema, { set: create(ComponentSetSchema, { id, name, properties: props }) }) });
const variantOf = (componentId: string, setId: string, variant: Record<string, string>) =>
  op({ case: "setComponentVariant", value: create(SetComponentVariantSchema, { componentId, setId, variant }) });
const swap = (instanceId: string, componentId: string) =>
  op({ case: "swapInstance", value: create(SwapInstanceSchema, { instanceId, componentId }) });
const delSet = (id: string) => op({ case: "deleteComponentSet", value: create(DeleteComponentSetSchema, { id }) });

function node(id: string, name: string, parentId: string, shape: Parameters<typeof create<typeof NodeSchema>>[1] extends infer T ? T : never, order = "a0") {
  return op({ case: "createNode", value: create(CreateNodeSchema, { node: create(NodeSchema, {
    id, name, parentId, orderKey: order, visible: true, opacity: 1, width: 40, height: 20, ...(shape as object),
  }) }) });
}

// A master frame "Button" with a text child "Label", registered as component `id`.
function button(s: SceneState, id: string, order: string): SceneState {
  const frame = { shape: { case: "frame", value: { clipsContent: false } } } as never;
  const text = { shape: { case: "text", value: { content: id, style: { fontSize: 12 } } } } as never;
  s = applyOp(s, node(`${id}-root`, "Button", "page1", frame, order));
  s = applyOp(s, node(`${id}-label`, "Label", `${id}-root`, text));
  return applyOp(s, op({ case: "createComponent", value: create(CreateComponentSchema, { componentId: id, rootNodeId: `${id}-root`, name: `Button/${id}` }) }));
}

function scene(): SceneState {
  let s = emptyScene("d", "d");
  s = button(s, "a", "a");
  s = button(s, "b", "b");
  s = applyOp(s, setOf("s", "Button", prop("Size", "S", "L")));
  s = applyOp(s, variantOf("a", "s", { Size: "S" }));
  return applyOp(s, variantOf("b", "s", { Size: "L" }));
}

describe("component sets", () => {
  it("validates the set shape like Go", () => {
    const s = emptyScene("d", "d");
    for (const bad of [
      setOf("", "B"), setOf("s", ""), setOf("s", "B", prop("", "a")), setOf("s", "B", prop("Size", "a"), prop("Size", "b")),
      setOf("s", "B", prop("Size")), setOf("s", "B", prop("Size", "a", "a")), setOf("s", "B", prop("Size", "")),
    ]) expect(applyOp(s, bad)).toBe(s);
    expect(applyOp(s, setOf("s", "B", prop("Size", "S", "L"))).componentSets!.s.properties).toHaveLength(1);
  });

  it("assigns variants and refuses duplicates, bad values and incomplete combinations", () => {
    const s = scene();
    expect(s.components.a).toMatchObject({ setId: "s", variant: { Size: "S" } });
    for (const bad of [
      variantOf("b", "s", { Size: "S" }),            // duplicate combination
      variantOf("b", "s", { Size: "XL" }),           // unknown value
      variantOf("b", "s", {}),                       // missing property
      variantOf("b", "s", { Size: "L", Color: "red" }),   // extra property
      variantOf("b", "ghost", { Size: "L" }),        // unknown set
      variantOf("ghost", "s", { Size: "L" }),        // unknown component
      variantOf("b", "", { Size: "L" }),             // variant without a set
    ]) expect(applyOp(s, bad)).toBe(s);
  });

  it("refuses a set edit that would merge two variants, accepts adding a value", () => {
    const s = scene();
    expect(applyOp(s, setOf("s", "Button", prop("Size", "X")))).toBe(s);        // both members would become Size=X
    expect(applyOp(s, setOf("s", "Button", prop("Size", "S", "L", "XL"))).componentSets!.s.properties[0].values).toHaveLength(3);
  });

  it("migrates members when properties change (parity with core.migrateVariant)", () => {
    let s = applyOp(scene(), setOf("s", "Button", prop("Size", "S", "L"), prop("State", "Default", "Hover")));
    expect(s.components.a.variant).toEqual({ Size: "S", State: "Default" });     // a new property: first value
    expect(s.components.b.variant).toEqual({ Size: "L", State: "Default" });
    // Dropping L would move b to S/Default, where a already is: refused, nothing changes.
    expect(applyOp(s, setOf("s", "Button", prop("Size", "S", "XL"), prop("State", "Default", "Hover")))).toBe(s);
    s = applyOp(s, variantOf("a", "s", { Size: "S", State: "Hover" }));
    s = applyOp(s, setOf("s", "Button", prop("Size", "S", "XL"), prop("State", "Default", "Hover")));
    expect(s.components.b.variant).toEqual({ Size: "S", State: "Default" });     // L is gone: first value
  });

  it("detaches a component, and deleting the set detaches its members", () => {
    let s = applyOp(scene(), variantOf("b", "", {}));
    expect(s.components.b.setId).toBeUndefined();
    s = applyOp(s, delSet("s"));
    expect(s.components.a.setId).toBeUndefined();
    expect(s.componentSets).toEqual({});
    expect(applyOp(s, delSet("s"))).toBe(s);
  });

  it("finds the member that differs in one property", () => {
    expect(variantWith(scene(), "a", "Size", "L")).toBe("b");
    expect(variantWith(scene(), "a", "Size", "XL")).toBeUndefined();
  });
});

describe("swapping an instance", () => {
  function withInstance(): SceneState {
    let s = scene();
    s = applyOp(s, node("i", "Inst", "page1", { shape: { case: "instance", value: { componentId: "a", overrides: [] } } } as never, "z"));
    s = applyOp(s, node("a-extra", "Only in A", "a-root", { shape: { case: "rect", value: { cornerRadius: 0 } } } as never, "b"));
    s = applyOp(s, op({ case: "setInstanceOverride", value: create(SetInstanceOverrideSchema, { instanceId: "i",
      override: create(InstanceOverrideSchema, { masterNodeId: "a-label", textPresent: true, text: "Custom" }) }) }));
    return applyOp(s, op({ case: "setInstanceOverride", value: create(SetInstanceOverrideSchema, { instanceId: "i",
      override: create(InstanceOverrideSchema, { masterNodeId: "a-extra", textPresent: true, text: "orphan" }) }) }));
  }

  it("moves overrides to the same name path under the new master and drops the orphans", () => {
    const s = applyOp(withInstance(), swap("i", "b"));
    const inst = s.nodes.at("i").instance!;
    expect(inst.componentId).toBe("b");
    expect(inst.overrides).toEqual([{ masterNodeId: "b-label", text: "Custom" }]);
  });

  it("refuses unknown instance/component, a non-instance, and a component swallowing its own instance", () => {
    const s = withInstance();
    expect(applyOp(s, swap("ghost", "a"))).toBe(s);
    expect(applyOp(s, swap("i", "ghost"))).toBe(s);
    expect(applyOp(s, swap("a-root", "a"))).toBe(s);
    let t = applyOp(s, node("in", "Inside", "a-root", { shape: { case: "instance", value: { componentId: "b", overrides: [] } } } as never, "c"));
    expect(applyOp(t, swap("in", "a"))).toBe(t);
    t = applyOp(t, swap("in", "b"));            // same component: allowed
    expect(t.nodes.at("in").instance!.componentId).toBe("b");
  });
});

describe("undo", () => {
  const roundTrip = (before: SceneState, o: Op) => {
    const inv = invertOp(before, o);
    expect(inv).not.toBeNull();
    const after = applyOp(before, o);
    expect(after).not.toBe(before);
    return inv!.reduce(applyOp, after);
  };

  it("undoes a set creation, an edit and a deletion (members come back)", () => {
    const s = scene();
    expect(roundTrip(emptyScene("d", "d"), setOf("x", "X", prop("P", "1"))).componentSets).toEqual({});
    expect(roundTrip(s, setOf("s", "Button", prop("Size", "S", "L", "XL"))).componentSets!.s.properties[0].values).toEqual(["S", "L"]);
    const back = roundTrip(s, delSet("s"));
    expect(back.componentSets!.s).toBeDefined();
    expect(back.components.a).toMatchObject({ setId: "s", variant: { Size: "S" } });
    expect(back.components.b).toMatchObject({ setId: "s", variant: { Size: "L" } });
  });

  it("undoes a set edit that migrated members: their combinations come back", () => {
    let s = applyOp(scene(), setOf("s", "Button", prop("Size", "S", "L"), prop("State", "Default", "Hover")));
    s = applyOp(s, variantOf("a", "s", { Size: "S", State: "Hover" }));
    // Dropping L moves b to S/Default (a is S/Hover, so no clash); undo must put b back on L.
    const edit = setOf("s", "Button", prop("Size", "S", "XL"), prop("State", "Default", "Hover"));
    expect(applyOp(s, edit).components.b.variant).toEqual({ Size: "S", State: "Default" });
    const back = roundTrip(s, edit);
    expect(back.componentSets!.s.properties[0].values).toEqual(["S", "L"]);
    expect(back.components.a.variant).toEqual({ Size: "S", State: "Hover" });
    expect(back.components.b.variant).toEqual({ Size: "L", State: "Default" });
  });

  it("undoes a variant assignment and a detach", () => {
    const s = scene();
    expect(roundTrip(s, variantOf("b", "", {})).components.b).toMatchObject({ setId: "s", variant: { Size: "L" } });
    const loose = applyOp(s, variantOf("b", "", {}));
    expect(roundTrip(loose, variantOf("b", "s", { Size: "L" })).components.b.setId).toBeUndefined();
  });

  it("undoes a swap and gets the original overrides back", () => {
    const before = (() => {
      let s = scene();
      s = applyOp(s, node("i", "Inst", "page1", { shape: { case: "instance", value: { componentId: "a", overrides: [] } } } as never, "z"));
      return applyOp(s, op({ case: "setInstanceOverride", value: create(SetInstanceOverrideSchema, { instanceId: "i",
        override: create(InstanceOverrideSchema, { masterNodeId: "a-label", textPresent: true, text: "Custom" }) }) }));
    })();
    const s = roundTrip(before, swap("i", "b"));
    expect(s.nodes.at("i").instance).toEqual(before.nodes.at("i").instance);
  });

  it("has no inverse for a rejected op", () => {
    const s = scene();
    expect(invertOp(s, variantOf("b", "s", { Size: "S" }))).toBeNull();
    expect(invertOp(s, swap("ghost", "a"))).toBeNull();
    expect(invertOp(s, delSet("ghost"))).toBeNull();
  });
});

describe("renames", () => {
  const renameSet = (id: string, name: string, props: Record<string, string>, values: { property: string; from: string; to: string }[], ...properties: ReturnType<typeof prop>[]) =>
    op({ case: "setComponentSet", value: create(SetComponentSetSchema, {
      set: create(ComponentSetSchema, { id, name, properties }), propertyRenames: props, valueRenames: values,
    }) });

  it("keeps members' choices through a property and a value rename (parity with core)", () => {
    const s = applyOp(scene(), renameSet("s", "Button", { Size: "Scale" }, [{ property: "Scale", from: "S", to: "Small" }], prop("Scale", "Small", "L")));
    expect(s.components.a.variant).toEqual({ Scale: "Small" });
    expect(s.components.b.variant).toEqual({ Scale: "L" });
  });

  it("refuses a rename to something the new set lacks", () => {
    const s = scene();
    expect(applyOp(s, renameSet("s", "Button", { Size: "Ghost" }, [], prop("Scale", "S", "L")))).toBe(s);
    expect(applyOp(s, renameSet("s", "Button", {}, [{ property: "Size", from: "S", to: "Huge" }], prop("Size", "S", "L")))).toBe(s);
    expect(applyOp(s, renameSet("s", "Button", {}, [{ property: "Ghost", from: "a", to: "b" }], prop("Size", "S", "L")))).toBe(s);
  });

  it("is undone: the old names and each member's choice come back", () => {
    const before = scene();
    const o = renameSet("s", "Button", { Size: "Scale" }, [{ property: "Scale", from: "S", to: "Small" }], prop("Scale", "Small", "L"));
    const inv = invertOp(before, o)!;
    const back = inv.reduce(applyOp, applyOp(before, o));
    expect(back.componentSets!.s.properties).toEqual([{ name: "Size", values: ["S", "L"] }]);
    expect(back.components.a.variant).toEqual({ Size: "S" });
    expect(back.components.b.variant).toEqual({ Size: "L" });
  });
});
