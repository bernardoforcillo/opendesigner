import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "../store/store";
import { emptyScene, type CollectionLite, type NodeLite, type VariableLite } from "../store/types";
import { VariablesDialog } from "./VariablesDialog";
import { VariablesSection } from "./VariablesSection";
import {
  MIXED, bindingOps, boundVariable, modeOps, newCollection, newVariable, pinnedMode, removeModeOps, variablesOfType, withMode,
} from "./variableOps";

// A server that accepts and echoes at once, like the other panel tests.
class FakeSync {
  sent: Op[] = [];
  submit(op: Op) {
    this.sent.push(op);
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
}

const rect = (id: string, over: Partial<NodeLite> = {}): NodeLite => ({
  id, parentId: "page1", orderKey: id, name: id, visible: true, opacity: 1,
  x: 0, y: 0, width: 10, height: 10, rotation: 0,
  fills: [{ r: 1, g: 0, b: 0, a: 1 }], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false, ...over,
});

const THEME: CollectionLite = { id: "theme", name: "Theme", modes: [{ id: "light", name: "Light" }, { id: "dark", name: "Dark" }] };
const BG: VariableLite = { id: "bg", collectionId: "theme", name: "color/bg", type: "color", values: { light: { r: 1, g: 1, b: 1, a: 1 }, dark: { r: 0, g: 0, b: 0, a: 1 } } };
const DIM: VariableLite = { id: "dim", collectionId: "theme", name: "opacity/dim", type: "number", values: { light: 1, dark: 0.4 } };

function install(...nodes: NodeLite[]) {
  const scene = emptyScene("doc-1", "Untitled");
  for (const n of nodes) scene.nodes = scene.nodes.set(n.id, n);
  scene.collections = { theme: THEME };
  scene.variables = { bg: BG, dim: DIM };
  useScene.getState().setScene(scene);
  return useScene.getState().scene!;
}

let sync: FakeSync;
beforeEach(() => {
  sync = new FakeSync();
  useScene.setState({ camera: { x: 0, y: 0, zoom: 1 }, selection: [], marquee: null, gesture: null, editingNodeId: null });
  useScene.getState().setSync(sync);
});
afterEach(cleanup);

describe("variableOps", () => {
  it("bindingOps writes one setProps per node that changes and rejects a type mismatch", () => {
    const scene = install(rect("a"), rect("b", { bindings: { "fills.0": "bg" } }));
    const ops = bindingOps(scene, ["a", "b"], "fills.0", "bg");
    expect(ops).toHaveLength(1);                                   // b is already bound
    expect(ops[0].kind.case === "setProps" && ops[0].kind.value.id).toBe("a");
    expect(bindingOps(scene, ["a"], "fills.0", "dim")).toEqual([]); // number var on a color property
    expect(bindingOps(scene, ["a"], "bogus", "bg")).toEqual([]);
    expect(bindingOps(scene, ["b"], "fills.0", null)).toHaveLength(1); // detach
  });

  it("boundVariable / pinnedMode report none, one and mixed", () => {
    const scene = install(rect("a", { bindings: { opacity: "dim" }, modes: { theme: "dark" } }), rect("b"));
    expect(boundVariable(scene, ["a"], "opacity")).toBe("dim");
    expect(boundVariable(scene, ["b"], "opacity")).toBeNull();
    expect(boundVariable(scene, ["a", "b"], "opacity")).toBe(MIXED);
    expect(pinnedMode(scene, ["a"], "theme")).toBe("dark");
    expect(pinnedMode(scene, ["a", "b"], "theme")).toBe(MIXED);
  });

  it("modeOps refuses a mode the collection does not have", () => {
    const scene = install(rect("a"));
    expect(modeOps(scene, ["a"], "theme", "sepia")).toEqual([]);
    expect(modeOps(scene, ["a"], "theme", "dark")).toHaveLength(1);
    expect(modeOps(scene, ["a"], "theme", null)).toEqual([]);      // nothing pinned, nothing to clear
  });

  it("variablesOfType filters by type; new collections, modes and variables are consistent", () => {
    const scene = install(rect("a"));
    expect(variablesOfType(scene, "number").map((v) => v.id)).toEqual(["dim"]);
    const c = withMode(newCollection(scene));
    expect(c.modes).toHaveLength(2);
    const v = newVariable(c, "color", "x");
    expect(Object.keys(v.values)).toEqual(c.modes.map((m) => m.id));
    expect(removeModeOps(c, c.modes[0].id)).toHaveLength(1);
    expect(removeModeOps({ ...c, modes: [c.modes[0]] }, c.modes[0].id)).toEqual([]); // never the last mode
  });
});

describe("VariablesSection", () => {
  it("binds the opacity of the selection to a variable in one undoable gesture, and detaches it", () => {
    install(rect("a"));
    useScene.setState({ selection: ["a"] });
    render(<VariablesSection />);
    fireEvent.change(screen.getByRole("combobox", { name: "Opacity" }), { target: { value: "dim" } });
    expect(useScene.getState().scene!.nodes.at("a").bindings).toEqual({ opacity: "dim" });
    expect(useScene.getState().undoStack).toHaveLength(1);
    useScene.getState().undo();
    expect(useScene.getState().scene!.nodes.at("a").bindings).toBeUndefined();
    useScene.getState().redo();
    fireEvent.change(screen.getByRole("combobox", { name: "Opacity" }), { target: { value: "" } });
    expect(useScene.getState().scene!.nodes.at("a").bindings).toBeUndefined();
  });

  it("only offers variables of the right type, and pins a collection to a mode", () => {
    install(rect("a"));
    useScene.setState({ selection: ["a"] });
    render(<VariablesSection />);
    const fill = screen.getByRole("combobox", { name: "Fill" });
    expect(within(fill).getAllByRole("option").map((o) => o.textContent)).toEqual(["None", "Theme / color/bg"]);
    fireEvent.change(screen.getByRole("combobox", { name: "Theme" }), { target: { value: "dark" } });
    expect(useScene.getState().scene!.nodes.at("a").modes).toEqual({ theme: "dark" });
  });

  it("explains how to create variables when the document has none", () => {
    install(rect("a"));
    const scene = useScene.getState().scene!;
    useScene.getState().setScene({ ...scene, collections: {}, variables: {} });
    useScene.setState({ selection: ["a"] });
    render(<VariablesSection />);
    expect(screen.getByText(/No variables yet/)).toBeInTheDocument();
  });
});

describe("VariablesDialog", () => {
  it("creates a collection, a variable and a mode, then deletes the collection", () => {
    install(rect("a"));
    useScene.getState().setScene({ ...useScene.getState().scene!, collections: {}, variables: {} });
    render(<VariablesDialog isOpen onOpenChange={() => {}} />);
    fireEvent.click(screen.getAllByRole("button", { name: "New collection" })[0]);
    const st = () => useScene.getState().scene!;
    expect(Object.keys(st().collections)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Add mode" }));
    expect(Object.values(st().collections)[0].modes).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Color" }));
    const v = Object.values(st().variables)[0];
    expect(v.type).toBe("color");
    expect(Object.keys(v.values)).toHaveLength(2);                 // one value per mode, the second mode already existed
    fireEvent.click(screen.getByRole("button", { name: "Add mode" }));
    expect(Object.values(st().collections)[0].modes).toHaveLength(3);
    expect(Object.keys(Object.values(st().variables)[0].values)).toHaveLength(2); // the new mode has no value: it resolves to the default's
    fireEvent.click(screen.getByRole("button", { name: "Delete collection" }));
    expect(Object.keys(st().collections)).toHaveLength(0);
    expect(Object.keys(st().variables)).toHaveLength(0);
  });
});
