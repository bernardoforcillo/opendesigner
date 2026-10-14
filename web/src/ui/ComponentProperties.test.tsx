import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
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

const TEXT = { fontFamily: "Inter", fontSize: 12, fontWeight: "400", lineHeight: 1.2, align: "left" as const };

// A master group "Button" with a text "Title" and a rect "Icon"; component "c"; an instance "i".
function install(props?: SceneState["components"][string]["properties"], values?: Record<string, string>) {
  const scene: SceneState = {
    ...emptyScene("d", "d"),
    components: { c: { rootNodeId: "m", name: "Button", ...(props ? { properties: props } : {}) } },
  };
  const nodes = [
    node("m", { kind: "group", name: "Button", width: 0, height: 0 }),
    node("label", { parentId: "m", kind: "text", name: "Title", text: { content: "Master", style: TEXT } }),
    node("icon", { parentId: "m", orderKey: "a1", name: "Icon" }),
    node("i", { orderKey: "z", kind: "instance", name: "Inst", instance: { componentId: "c", overrides: [], ...(values ? { propertyValues: values } : {}) } }),
  ];
  for (const n of nodes) scene.nodes = scene.nodes.set(n.id, n);
  useScene.getState().setScene(scene);
}

let sync: FakeSync;
beforeEach(() => {
  sync = new FakeSync();
  useScene.setState({ camera: { x: 0, y: 0, zoom: 1 }, selection: [], marquee: null, gesture: null, editingNodeId: null });
  useScene.getState().setSync(sync);
});
afterEach(cleanup);

const kinds = () => sync.sent.map((o) => o.kind.case);

describe("defining component properties on the master", () => {
  it("adds a show/hide and a text property on sensible layers, one undo step each", async () => {
    install();
    useScene.getState().setSelection(["m"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Add a show/hide property" }));
    await user.click(screen.getByRole("button", { name: "Add a text property" }));

    expect(kinds()).toEqual(["setComponentProperties", "setComponentProperties"]);
    expect(useScene.getState().undoStack).toHaveLength(2);
    const props = useScene.getState().scene!.components.c.properties!;
    expect(props).toEqual([
      { name: "Show layer", type: "boolean", nodeId: "label", defaultValue: "true" },     // first child of the master
      { name: "Text", type: "text", nodeId: "label", defaultValue: "" },                  // the first text layer
    ]);
  });

  it("edits name, layer and default; text properties only offer text layers; removes", async () => {
    install([
      { name: "Show layer", type: "boolean", nodeId: "label", defaultValue: "true" },
      { name: "Text", type: "text", nodeId: "label", defaultValue: "" },
    ]);
    useScene.getState().setSelection(["m"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();

    const textLayers = within(screen.getByRole("combobox", { name: "Layer of Text" })).getAllByRole("option").map((o) => o.textContent);
    expect(textLayers).toEqual(["Button / Title"]);                                       // the rect is not offered
    const boolLayers = within(screen.getByRole("combobox", { name: "Layer of Show layer" })).getAllByRole("option").map((o) => o.textContent);
    expect(boolLayers).toEqual(["Button", "Button / Title", "Button / Icon"]);

    await user.selectOptions(screen.getByRole("combobox", { name: "Layer of Show layer" }), "icon");
    await user.click(screen.getByRole("checkbox", { name: "Default of Show layer" }));
    const name = screen.getByRole("textbox", { name: "Property name Show layer" });
    await user.clear(name);
    await user.type(name, "Icon{Enter}");
    let p = useScene.getState().scene!.components.c.properties!;
    expect(p[0]).toEqual({ name: "Icon", type: "boolean", nodeId: "icon", defaultValue: "false" });

    // A name another property has is ignored, not sent.
    const before = sync.sent.length;
    const clash = screen.getByRole("textbox", { name: "Property name Text" });
    await user.clear(clash);
    await user.type(clash, "Icon{Enter}");
    expect(sync.sent.length).toBe(before);

    await user.click(screen.getByRole("button", { name: "Remove property Icon" }));
    p = useScene.getState().scene!.components.c.properties!;
    expect(p.map((x) => x.name)).toEqual(["Text"]);
  });

  it("is not offered on an ordinary node", () => {
    install();
    useScene.getState().setSelection(["icon"]);
    render(<PropertiesPanel />);
    expect(screen.queryByRole("button", { name: "Add a show/hide property" })).toBeNull();
  });
});

describe("setting properties on an instance", () => {
  const defs = [
    { name: "Caption", type: "text" as const, nodeId: "label", defaultValue: "Click" },
    { name: "Icon", type: "boolean" as const, nodeId: "icon", defaultValue: "false" },
  ];

  it("shows the defaults and stores only what differs from them", async () => {
    install(defs);
    useScene.getState().setSelection(["i"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();
    expect(screen.getByRole("textbox", { name: "Caption" })).toHaveValue("Click");
    expect(screen.getByRole("checkbox", { name: "Icon" })).not.toBeChecked();

    await user.click(screen.getByRole("checkbox", { name: "Icon" }));
    expect(useScene.getState().scene!.nodes.at("i").instance!.propertyValues).toEqual({ Icon: "true" });
    const label = screen.getByRole("textbox", { name: "Caption" });
    await user.clear(label);
    await user.type(label, "Buy{Enter}");
    expect(useScene.getState().scene!.nodes.at("i").instance!.propertyValues).toEqual({ Icon: "true", Caption: "Buy" });

    // Going back to the default removes the entry instead of storing a copy of it.
    await user.click(screen.getByRole("checkbox", { name: "Icon" }));
    expect(useScene.getState().scene!.nodes.at("i").instance!.propertyValues).toEqual({ Caption: "Buy" });
    expect(kinds().every((k) => k === "setInstanceProperty")).toBe(true);
  });

  it("is absent for an instance of a component without properties", () => {
    install();
    useScene.getState().setSelection(["i"]);
    render(<PropertiesPanel />);
    expect(screen.queryByRole("textbox", { name: "Caption" })).toBeNull();
  });
});
