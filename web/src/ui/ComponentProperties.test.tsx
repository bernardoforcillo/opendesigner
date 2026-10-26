import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "@/store/store";
import { emptyScene, type ComponentLite, type NodeLite, type SceneState } from "@/store/types";
import { ComponentDialog } from "@/ui/ComponentDialog";
import { InstanceControls } from "@/ui/InstanceControls";
import {
  addPropertyOps, renameAxisOps, renameOptionOps, setPropertyDefaultOps, setPropertyOptionsOps, setPropertyValueOps, swapChoices,
} from "@/ui/componentOps";

// Number, option-list and swap properties, and renames, in the component dialog, the instance
// controls and the pure op builders behind them.

class FakeSync {
  submit(op: Op) {
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
  put(base("m1", { kind: "frame" })); put(textNode("label", "m1", "Button")); put(base("icon", { parentId: "m1", cornerRadius: 6 }));
  put(base("nest", { parentId: "m1", kind: "instance", fills: [], instance: { componentId: "c2", overrides: [] } }));
  put(base("m2", { kind: "frame", x: 500 }));
  put(base("i", { kind: "instance", fills: [], instance: { componentId: "c1", overrides: [] } }));
  scene.components = { c1: { rootNodeId: "m1", name: "Card" }, c2: { rootNodeId: "m2", name: "Badge" } };
  extra(scene);
  useScene.getState().setScene(scene);
  return useScene.getState().scene!;
}

const withProps = (s: SceneState) => {
  s.components.c1 = {
    ...s.components.c1,
    properties: [
      { name: "Radius", type: "number", attribute: "corner_radius", defaultValue: "6", targetNodeIds: ["icon"] },
      { name: "Tone", type: "text", defaultValue: "a", options: ["a", "b"], targetNodeIds: ["label"] },
      { name: "Inner", type: "swap", defaultValue: "", targetNodeIds: ["nest"] },
    ],
  } as ComponentLite;
};

const withSet = (s: SceneState) => {
  s.componentSets = { s1: { id: "s1", name: "Card", axes: [{ name: "State", options: ["default", "hover"] }] } };
  s.components.c1 = { ...s.components.c1, setId: "s1", variant: { State: "default" } };
  s.components.c2 = { ...s.components.c2, setId: "s1", variant: { State: "hover" } };
};

beforeEach(() => {
  useScene.setState({ camera: { x: 0, y: 0, zoom: 1 }, selection: [], marquee: null, gesture: null, editingNodeId: null });
  useScene.getState().setSync(new FakeSync());
});
afterEach(cleanup);

describe("property builders", () => {
  it("addPropertyOps builds number and swap properties from the usable targets, with the current value as the default", () => {
    const s = install();
    const nodes = (...ids: string[]) => ids.map((id) => s.nodes.at(id));
    expect(addPropertyOps(s, "c1", "number", "Radius", nodes("icon"), "corner_radius")).toHaveLength(1);
    expect(addPropertyOps(s, "c1", "number", "Radius", nodes("label"), "corner_radius")).toEqual([]);   // not a rectangle
    expect(addPropertyOps(s, "c1", "number", "Size", nodes("icon"), "font_size")).toEqual([]);          // not a text
    expect(addPropertyOps(s, "c1", "swap", "Inner", nodes("label"))).toEqual([]);                       // not an instance
    expect(addPropertyOps(s, "c1", "swap", "Inner", nodes("nest"))).toHaveLength(1);
  });

  it("setPropertyValueOps validates per type, and an empty swap goes back to the default", () => {
    const s = install(withProps);
    expect(setPropertyValueOps(s, "i", "Radius", "-3")).toEqual([]);
    expect(setPropertyValueOps(s, "i", "Radius", "12")).toHaveLength(1);
    expect(setPropertyValueOps(s, "i", "Tone", "free")).toEqual([]);
    expect(setPropertyValueOps(s, "i", "Tone", "b")).toHaveLength(1);
    expect(setPropertyValueOps(s, "i", "Inner", "ghost")).toEqual([]);
    expect(setPropertyValueOps(s, "i", "Inner", "c2")).toHaveLength(1);
    expect(setPropertyValueOps(s, "i", "Inner", "")).toHaveLength(1);
    expect(swapChoices(s, "c1").map((c) => c.id)).toEqual(["c2"]);
  });

  it("setPropertyOptionsOps keeps the default when still allowed, else takes the first option", () => {
    const s = install(withProps);
    const apply = (ops: Op[]) => { ops.forEach((o) => useScene.getState().apply(o)); return useScene.getState().scene!; };
    const next = apply(setPropertyOptionsOps(s, "c1", "Tone", ["x", "y"]));
    expect(next.components.c1.properties!.find((p) => p.name === "Tone")).toMatchObject({ defaultValue: "x", options: ["x", "y"] });
    const free = apply(setPropertyOptionsOps(next, "c1", "Tone", []));
    expect(free.components.c1.properties!.find((p) => p.name === "Tone")!.options).toBeUndefined();
    expect(setPropertyDefaultOps(s, "c1", "Radius", "-1")).toEqual([]);
    expect(setPropertyDefaultOps(s, "c1", "Inner", "c1")).toEqual([]);
  });

  it("rename builders refuse empty, taken and unchanged names", () => {
    const s = install(withSet);
    expect(renameAxisOps(s, "s1", "State", "")).toEqual([]);
    expect(renameAxisOps(s, "s1", "State", "State")).toEqual([]);
    expect(renameAxisOps(s, "s1", "State", "Mode")).toHaveLength(1);
    expect(renameOptionOps(s, "s1", "State", "hover", "default")).toEqual([]);
    expect(renameOptionOps(s, "s1", "State", "hover", "pressed")).toHaveLength(1);
  });
});

describe("renames keep choices", () => {
  it("renaming an axis and an option in the dialog keeps the members and the instances", () => {
    install((s) => {
      withSet(s);
      s.nodes = s.nodes.set("i", { ...s.nodes.at("i"), instance: { componentId: "c1", overrides: [], variantProps: { State: "hover" } } });
    });
    render(<ComponentDialog componentId="c1" onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Rename State axis"), { target: { value: "Mode" } });
    fireEvent.blur(screen.getByLabelText("Rename State axis"));
    let scene = useScene.getState().scene!;
    expect(scene.components.c1.variant).toEqual({ Mode: "default" });
    expect(scene.components.c2.variant).toEqual({ Mode: "hover" });
    expect(scene.nodes.at("i").instance!.variantProps).toEqual({ Mode: "hover" });

    fireEvent.change(screen.getByLabelText("Rename Mode option hover"), { target: { value: "pressed" } });
    fireEvent.blur(screen.getByLabelText("Rename Mode option hover"));
    scene = useScene.getState().scene!;
    expect(scene.components.c2.variant).toEqual({ Mode: "pressed" });
    expect(scene.nodes.at("i").instance!.variantProps).toEqual({ Mode: "pressed" });
    expect(scene.componentSets.s1.axes).toEqual([{ name: "Mode", options: ["default", "pressed"] }]);

    useScene.getState().undo();
    useScene.getState().undo();
    scene = useScene.getState().scene!;
    expect(scene.components.c2.variant).toEqual({ State: "hover" });
    expect(scene.nodes.at("i").instance!.variantProps).toEqual({ State: "hover" });
  });
});

describe("controls", () => {
  it("the dialog adds a number property from the selection and lists it", () => {
    install();
    useScene.setState({ selection: ["icon"] });
    render(<ComponentDialog componentId="c1" onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Property name"), { target: { value: "Radius" } });
    fireEvent.change(screen.getByLabelText("Property type"), { target: { value: "number" } });
    fireEvent.change(screen.getByLabelText("Property attribute"), { target: { value: "corner_radius" } });
    fireEvent.click(screen.getByRole("button", { name: "Add from selection" }));
    expect(useScene.getState().scene!.components.c1.properties).toEqual([
      { name: "Radius", type: "number", attribute: "corner_radius", defaultValue: "6", targetNodeIds: ["icon"] },
    ]);
    expect(screen.getByLabelText("Radius default")).toHaveValue("6");
    // An invalid default is refused and the field goes back.
    fireEvent.change(screen.getByLabelText("Radius default"), { target: { value: "-4" } });
    fireEvent.blur(screen.getByLabelText("Radius default"));
    expect(useScene.getState().scene!.components.c1.properties![0].defaultValue).toBe("6");
    expect(screen.getByLabelText("Radius default")).toHaveValue("6");
  });

  it("the instance controls edit a number, an option list and a swap", () => {
    install(withProps);
    useScene.setState({ selection: ["i"] });
    render(<InstanceControls />);
    fireEvent.change(screen.getByLabelText("Radius"), { target: { value: "12" } });
    fireEvent.blur(screen.getByLabelText("Radius"));
    expect(useScene.getState().scene!.nodes.at("i").instance!.propertyValues).toEqual({ Radius: "12" });
    fireEvent.change(screen.getByLabelText("Radius"), { target: { value: "-1" } });       // refused: back to 12
    fireEvent.blur(screen.getByLabelText("Radius"));
    expect(screen.getByLabelText("Radius")).toHaveValue("12");
    fireEvent.change(screen.getByRole("combobox", { name: "Tone" }), { target: { value: "b" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Inner" }), { target: { value: "c2" } });
    expect(useScene.getState().scene!.nodes.at("i").instance!.propertyValues).toEqual({ Radius: "12", Tone: "b", Inner: "c2" });
    fireEvent.change(screen.getByRole("combobox", { name: "Inner" }), { target: { value: "" } });
    expect(useScene.getState().scene!.nodes.at("i").instance!.propertyValues).toEqual({ Radius: "12", Tone: "b" });
  });
});
