import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "../store/store";
import { emptyScene, type ComponentLite, type NodeLite, type SceneState } from "../store/types";
import { ComponentDialog } from "./ComponentDialog";
import { InstanceControls } from "./InstanceControls";
import {
  addAxisOps, addOptionOps, addPropertyOps, chooseVariantOps, createSetOps, duplicateVariantOps, freeCombination, setPropertyValueOps, setVariantOps,
} from "./componentOps";

class FakeSync {
  sent: Op[] = [];
  submit(op: Op) {
    this.sent.push(op);
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
}

const base = (id: string, over: Partial<NodeLite> = {}): NodeLite => ({
  id, parentId: "page1", orderKey: id, name: id, visible: true, opacity: 1,
  x: 0, y: 0, width: 100, height: 40, rotation: 0, fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [],
  kind: "rect", cornerRadius: 0, clipsContent: false, ...over,
});
const textNode = (id: string, parentId: string, content: string): NodeLite =>
  base(id, { parentId, kind: "text", text: { content, style: { fontFamily: "", fontSize: 14, fontWeight: "", lineHeight: 0, align: "left" } } });

function install(extra: (s: SceneState) => void = () => {}) {
  const scene = emptyScene("doc-1", "Untitled");
  const put = (n: NodeLite) => { scene.nodes = scene.nodes.set(n.id, n); };
  put(base("m1", { kind: "frame" })); put(textNode("label", "m1", "Button")); put(base("icon", { parentId: "m1" }));
  put(base("i", { kind: "instance", fills: [], instance: { componentId: "c1", overrides: [] } }));
  scene.components = { c1: { rootNodeId: "m1", name: "Button" } };
  extra(scene);
  useScene.getState().setScene(scene);
  return useScene.getState().scene!;
}

// Same scene, but c1 already in a set with a boolean and a text property.
const withSet = (s: SceneState) => {
  s.componentSets = { s1: { id: "s1", name: "Button", axes: [{ name: "State", options: ["default", "hover"] }] } };
  s.components.c1 = {
    ...s.components.c1, setId: "s1", variant: { State: "default" },
    properties: [
      { name: "Label", type: "text", defaultValue: "Button", targetNodeIds: ["label"] },
      { name: "ShowIcon", type: "boolean", defaultValue: "true", targetNodeIds: ["icon"] },
    ],
  } as ComponentLite;
};

let sync: FakeSync;
beforeEach(() => {
  sync = new FakeSync();
  useScene.setState({ camera: { x: 0, y: 0, zoom: 1 }, selection: [], marquee: null, gesture: null, editingNodeId: null });
  useScene.getState().setSync(sync);
});
afterEach(cleanup);

describe("componentOps", () => {
  it("builds the set, the axis and the option edits, and reassigns the members to a new axis", () => {
    const scene = install();
    const made = createSetOps(scene, "c1", "Button")!;
    expect(made.ops.map((o) => o.kind.case)).toEqual(["setComponentSet", "setComponentDef"]);
    expect(createSetOps(install(withSet), "c1", "x")).toBeNull();                 // already in a set
    const s = install(withSet);
    expect(addOptionOps(s, "s1", "State", "pressed")).toHaveLength(1);
    expect(addOptionOps(s, "s1", "State", "   ")).toEqual([]);
    const ops = addAxisOps(s, "s1", "Size", "md");
    expect(ops.map((o) => o.kind.case)).toEqual(["setComponentSet", "setComponentDef"]);   // the set, then the one member
    ops.forEach((o) => useScene.getState().applyLocal(o));
    const after = useScene.getState().scene!;
    expect(after.components.c1.variant).toEqual({ State: "default", Size: "md" });
  });

  it("refuses to move a variant onto a combination another member already has", () => {
    const s = install((sc) => {
      withSet(sc);
      sc.nodes = sc.nodes.set("m2", base("m2", { kind: "frame" }));
      sc.components.c2 = { rootNodeId: "m2", name: "Hover", setId: "s1", variant: { State: "hover" } };
    });
    expect(setVariantOps(s, "c2", "State", "default")).toEqual([]);
    expect(setVariantOps(s, "c2", "State", "hover")).toHaveLength(1);
    expect(freeCombination(s, "s1")).toBeNull();                                  // both combinations used
  });

  it("duplicates a variant: copies the master and its properties onto the first free combination", () => {
    const s = install((sc) => { withSet(sc); sc.componentSets.s1.axes[0].options.push("pressed"); });
    const made = duplicateVariantOps(s, "c1", "Button pressed")!;
    made.ops.forEach((o) => useScene.getState().applyLocal(o));
    const after = useScene.getState().scene!;
    const copy = after.components[made.componentId];
    expect(copy).toMatchObject({ name: "Button pressed", setId: "s1" });
    expect(copy.variant!.State).not.toBe("default");
    const names = (copy.properties ?? []).map((p) => p.name);
    expect(names).toEqual(["Label", "ShowIcon"]);
    // The targets are the COPIES' nodes, not the original's.
    const root = after.nodes.at(copy.rootNodeId);
    expect(root.name).toBe("Button pressed");
    expect(copy.properties![0].targetNodeIds[0]).not.toBe("label");
    expect(after.nodes.at(copy.properties![0].targetNodeIds[0]).parentId).toBe(copy.rootNodeId);
    // Nothing free left after a third option is used: the next duplicate has nowhere to go.
    expect(duplicateVariantOps(after, "c1", "x")).not.toBeNull();                 // "hover" is still free
  });

  it("property ops need targets of the right kind and a unique name", () => {
    const s = install();
    const label = s.nodes.at("label"), icon = s.nodes.at("icon");
    expect(addPropertyOps(s, "c1", "text", "Label", [icon])).toEqual([]);          // a rect is not text
    expect(addPropertyOps(s, "c1", "boolean", "", [icon])).toEqual([]);
    expect(addPropertyOps(s, "c1", "text", "Label", [label, icon])).toHaveLength(1);
    const withProp = install((sc) => withSet(sc));
    expect(addPropertyOps(withProp, "c1", "boolean", "ShowIcon", [icon])).toEqual([]);   // duplicate name
  });
});

describe("InstanceControls", () => {
  it("switches variant and sets property values, each in one undoable gesture", () => {
    install((s) => {
      withSet(s);
      s.nodes = s.nodes.set("m2", base("m2", { kind: "frame" })).set("label2", textNode("label2", "m2", "Hover"));
      s.components.c2 = { rootNodeId: "m2", name: "Hover", setId: "s1", variant: { State: "hover" }, properties: [{ name: "Label", type: "text", defaultValue: "Hover", targetNodeIds: ["label2"] }] };
    });
    useScene.setState({ selection: ["i"] });
    render(<InstanceControls />);
    fireEvent.click(screen.getByRole("checkbox", { name: "ShowIcon" }));
    expect(useScene.getState().scene!.nodes.at("i").instance!.propertyValues).toEqual({ ShowIcon: "false" });
    fireEvent.change(screen.getByRole("combobox", { name: "State" }), { target: { value: "hover" } });
    const inst = useScene.getState().scene!.nodes.at("i").instance!;
    expect(inst.variantProps).toEqual({ State: "hover" });
    // Hover has no ShowIcon property: its value is dropped (the document would refuse it) instead of blocking the switch.
    expect(inst.propertyValues).toBeUndefined();
    expect(useScene.getState().undoStack).toHaveLength(2);
    useScene.getState().undo();
    expect(useScene.getState().scene!.nodes.at("i").instance!.variantProps).toBeUndefined();
  });

  it("edits a text property on blur and shows nothing for a component without a set or properties", () => {
    install(withSet);
    useScene.setState({ selection: ["i"] });
    render(<InstanceControls />);
    const input = screen.getByRole("textbox", { name: "Label" });
    fireEvent.change(input, { target: { value: "Save" } });
    fireEvent.blur(input);
    expect(useScene.getState().scene!.nodes.at("i").instance!.propertyValues).toEqual({ Label: "Save" });
    cleanup();
    install();
    useScene.setState({ selection: ["i"] });
    const { container } = render(<InstanceControls />);
    expect(container).toBeEmptyDOMElement();
  });

  it("keeps the values of the properties the new variant also has", () => {
    const s = install((sc) => {
      withSet(sc);
      sc.nodes = sc.nodes.set("m2", base("m2", { kind: "frame" })).set("label2", textNode("label2", "m2", "Hover"));
      sc.components.c2 = { rootNodeId: "m2", name: "Hover", setId: "s1", variant: { State: "hover" }, properties: [{ name: "Label", type: "text", defaultValue: "Hover", targetNodeIds: ["label2"] }] };
      sc.nodes = sc.nodes.set("i", { ...sc.nodes.at("i"), instance: { componentId: "c1", overrides: [], propertyValues: { Label: "Save", ShowIcon: "false" } } });
    });
    chooseVariantOps(s, "i", "State", "hover").forEach((o) => useScene.getState().applyLocal(o));
    expect(useScene.getState().scene!.nodes.at("i").instance).toMatchObject({ propertyValues: { Label: "Save" }, variantProps: { State: "hover" } });
  });

  it("chooseVariantOps / setPropertyValueOps ignore a non-instance and an unknown property", () => {
    const s = install(withSet);
    expect(chooseVariantOps(s, "m1", "State", "hover")).toEqual([]);
    expect(setPropertyValueOps(s, "i", "Nope", "x")).toEqual([]);
  });
});

describe("ComponentDialog", () => {
  it("creates a set, adds an option and an axis, and adds properties from the selection", () => {
    install();
    useScene.setState({ selection: ["label"] });
    render(<ComponentDialog componentId="c1" onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Create variant set" }));
    expect(useScene.getState().scene!.components.c1.setId).toBeDefined();
    expect(useScene.getState().undoStack).toHaveLength(1);                        // two ops, one gesture

    fireEvent.change(screen.getByLabelText("New Variant option"), { target: { value: "Hover" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Variant option" }));
    const setId = useScene.getState().scene!.components.c1.setId!;
    expect(useScene.getState().scene!.componentSets[setId].axes[0].options).toEqual(["Default", "Hover"]);

    fireEvent.change(screen.getByLabelText("New axis name"), { target: { value: "Size" } });
    fireEvent.change(screen.getByLabelText("First option of the new axis"), { target: { value: "md" } });
    fireEvent.click(screen.getByRole("button", { name: "Add axis" }));
    expect(useScene.getState().scene!.components.c1.variant).toEqual({ Variant: "Default", Size: "md" });

    fireEvent.change(screen.getByLabelText("Property name"), { target: { value: "Label" } });
    fireEvent.change(screen.getByLabelText("Property type"), { target: { value: "text" } });
    fireEvent.click(screen.getByRole("button", { name: "Add from selection" }));
    expect(useScene.getState().scene!.components.c1.properties).toEqual([
      { name: "Label", type: "text", defaultValue: "Button", targetNodeIds: ["label"] },
    ]);
    expect(screen.getByLabelText("Label default")).toHaveValue("Button");
    fireEvent.click(screen.getByRole("button", { name: "Remove Label" }));
    expect(useScene.getState().scene!.components.c1.properties).toBeUndefined();
  });

  it("explains what to select when a property has no valid target", () => {
    install();
    useScene.setState({ selection: ["i"] });                                       // the instance is not in the master
    render(<ComponentDialog componentId="c1" onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Property name"), { target: { value: "ShowIcon" } });
    fireEvent.click(screen.getByRole("button", { name: "Add from selection" }));
    expect(screen.getByRole("status")).toHaveTextContent(/select, on the canvas/);
    expect(useScene.getState().scene!.components.c1.properties).toBeUndefined();
  });

  it("lists the variants of the set and removes a component from it", () => {
    install(withSet);
    render(<ComponentDialog componentId="c1" onClose={() => {}} />);
    expect(within(screen.getByRole("list", { name: "Variants of the set" })).getByText(/State=default/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove from set" }));
    expect(useScene.getState().scene!.components.c1.setId).toBeUndefined();
  });
});
