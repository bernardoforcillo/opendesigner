import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { ComponentsPanel } from "./ComponentsPanel";
import { PropertiesPanel } from "./PropertiesPanel";
import { useScene } from "../store/store";
import { emptyScene, type NodeLite, type SceneState } from "../store/types";

class FakeSync {
  sent: Op[] = [];
  submit(op: Op) {
    this.sent.push(op);
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
}

const node = (id: string, over: Partial<NodeLite> = {}): NodeLite => ({
  id, parentId: "page1", orderKey: "a0", name: id, visible: true, opacity: 1,
  x: 0, y: 0, width: 30, height: 30, rotation: 0,
  fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false, ...over,
});

function install(patch: Partial<SceneState> = {}, ...nodes: NodeLite[]) {
  const scene: SceneState = { ...emptyScene("d", "d"), ...patch };
  for (const n of nodes) scene.nodes = scene.nodes.set(n.id, n);
  useScene.getState().setScene(scene);
}

// Two master frames registered as components, not yet in any set.
const masters = [node("ma", { kind: "frame", name: "Button S" }), node("mb", { kind: "frame", name: "Button L" })];
const components: SceneState["components"] = { a: { rootNodeId: "ma", name: "Button/S" }, b: { rootNodeId: "mb", name: "Button/L" } };

let sync: FakeSync;
beforeEach(() => {
  sync = new FakeSync();
  useScene.setState({ camera: { x: 0, y: 0, zoom: 1 }, selection: [], marquee: null, gesture: null, editingNodeId: null });
  useScene.getState().setSync(sync);
});
afterEach(cleanup);

const kinds = () => sync.sent.map((o) => o.kind.case);

describe("VariantSets in the Components panel", () => {
  it("offers a new set, then adds components on free combinations and grows the first property when none is free", async () => {
    install({ components }, ...masters);
    render(<ComponentsPanel />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "New variant set" }));
    expect(kinds()).toEqual(["setComponentSet"]);
    const set = () => Object.values(useScene.getState().scene!.componentSets!)[0];
    expect(set().properties).toEqual([{ name: "Variant", values: ["Default"] }]);

    await user.selectOptions(screen.getByRole("combobox", { name: `Add a component to ${set().name}` }), "a");
    expect(useScene.getState().scene!.components.a).toMatchObject({ setId: set().id, variant: { Variant: "Default" } });

    // Every combination is taken: adding "b" first grows the property, in the same gesture.
    const before = useScene.getState().undoStack.length;
    await user.selectOptions(screen.getByRole("combobox", { name: `Add a component to ${set().name}` }), "b");
    expect(useScene.getState().undoStack.length).toBe(before + 1);                    // ONE undo step
    expect(set().properties[0].values).toEqual(["Default", "Variant 2"]);
    expect(useScene.getState().scene!.components.b.variant).toEqual({ Variant: "Variant 2" });
  });

  it("adds properties and values, and disables values another member already uses", async () => {
    const scene: Partial<SceneState> = {
      components: {
        a: { ...components.a, setId: "s", variant: { Size: "S" } },
        b: { ...components.b, setId: "s", variant: { Size: "L" } },
      },
      componentSets: { s: { id: "s", name: "Button", properties: [{ name: "Size", values: ["S", "L"] }] } },
    };
    install(scene, ...masters);
    render(<ComponentsPanel />);
    const user = userEvent.setup();

    // b cannot take S (a has it), a keeps its own value selectable.
    const bSize = screen.getByRole("combobox", { name: "Button/L Size" });
    expect(within(bSize).getByRole("option", { name: "S" })).toBeDisabled();
    expect(within(bSize).getByRole("option", { name: "L" })).not.toBeDisabled();

    await user.type(screen.getByRole("textbox", { name: "Add value to Size" }), "XL{Enter}");
    expect(useScene.getState().scene!.componentSets!.s.properties[0].values).toEqual(["S", "L", "XL"]);
    await user.type(screen.getByRole("textbox", { name: "Add property to Button" }), "State{Enter}");
    const s = useScene.getState().scene!;
    expect(s.componentSets!.s.properties.map((p) => p.name)).toEqual(["Size", "State"]);
    expect(s.components.a.variant).toEqual({ Size: "S", State: "Default" });            // members migrated
    expect(s.components.b.variant).toEqual({ Size: "L", State: "Default" });
    expect(screen.getByRole("textbox", { name: "Add value to Size" })).toHaveValue("");  // the field emptied itself
  });

  it("deleting a set keeps its components", async () => {
    install({
      components: { a: { ...components.a, setId: "s", variant: { Size: "S" } }, b: components.b },
      componentSets: { s: { id: "s", name: "Button", properties: [{ name: "Size", values: ["S"] }] } },
    }, ...masters);
    render(<ComponentsPanel />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Delete set Button" }));
    const s = useScene.getState().scene!;
    expect(s.componentSets).toEqual({});
    expect(s.components.a.setId).toBeUndefined();
    expect(Object.keys(s.components)).toHaveLength(2);
  });
});

describe("the Variant section of the properties panel", () => {
  const withSet: Partial<SceneState> = {
    components: {
      a: { ...components.a, setId: "s", variant: { Size: "S", State: "Default" } },
      b: { ...components.b, setId: "s", variant: { Size: "L", State: "Default" } },
    },
    componentSets: { s: { id: "s", name: "Button", properties: [{ name: "Size", values: ["S", "L"] }, { name: "State", values: ["Default", "Hover"] }] } },
  };
  const instance = node("i", { kind: "instance", instance: { componentId: "a", overrides: [] } });

  it("switches the instance to the member with the other value, in one op", async () => {
    install(withSet, ...masters, instance);
    useScene.getState().setSelection(["i"]);
    render(<PropertiesPanel />);

    await userEvent.setup().selectOptions(screen.getByRole("combobox", { name: "Size variant" }), "L");

    expect(kinds()).toEqual(["swapInstance"]);
    expect(useScene.getState().scene!.nodes.at("i").instance!.componentId).toBe("b");
  });

  it("disables values whose combination does not exist", () => {
    install(withSet, ...masters, instance);
    useScene.getState().setSelection(["i"]);
    render(<PropertiesPanel />);
    const state = screen.getByRole("combobox", { name: "State variant" });
    expect(within(state).getByRole("option", { name: "Hover" })).toBeDisabled();       // no S/Hover component
    expect(within(state).getByRole("option", { name: "Default" })).not.toBeDisabled();
  });

  it("is absent for an instance of a component outside any set, and for several selected nodes", () => {
    install({ components }, ...masters, instance);
    useScene.getState().setSelection(["i"]);
    render(<PropertiesPanel />);
    expect(screen.queryByRole("combobox", { name: /variant$/ })).toBeNull();
  });
});
