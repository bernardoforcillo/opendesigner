import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "@/store/store";
import { emptyScene, type NodeLite } from "@/store/types";
import { AutoLayoutControls } from "@/ui/AutoLayoutControls";
import { LayoutRelationControls } from "@/ui/LayoutRelationControls";

class FakeSync {
  submit(op: Op) {
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
}

const base = (id: string, over: Partial<NodeLite> = {}): NodeLite => ({
  id, parentId: "page1", orderKey: id, name: id, visible: true, opacity: 1,
  x: 0, y: 0, width: 200, height: 100, rotation: 0, fills: [], strokes: [],
  kind: "rect", cornerRadius: 0, clipsContent: false, ...over,
});

function install(grid: boolean) {
  const scene = emptyScene("doc-1", "Untitled");
  const al = { direction: "horizontal" as const, spacing: 8, paddingLeft: 0, paddingTop: 0, paddingRight: 0, paddingBottom: 0, mainAlign: "start" as const, crossAlign: "start" as const, hugWidth: false, hugHeight: false };
  scene.nodes = scene.nodes.set("f", base("f", { kind: "frame", autoLayout: grid ? { ...al, mode: "grid", columns: [{ kind: "fixed", size: 50 }, { kind: "fr", size: 1 }], rows: [{ kind: "hug", size: 0 }] } : al }));
  scene.nodes = scene.nodes.set("a", base("a", { parentId: "f", width: 20, height: 10 }));
  useScene.getState().setScene(scene);
}

const run = (build: Parameters<React.ComponentProps<typeof AutoLayoutControls>["run"]>[0]) => {
  const store = useScene.getState();
  store.beginGesture();
  store.endGesture(build(store.selection));
};

beforeEach(() => {
  useScene.setState({ camera: { x: 0, y: 0, zoom: 1 }, selection: ["f"], marquee: null, gesture: null, editingNodeId: null });
  useScene.getState().setSync(new FakeSync());
});
afterEach(cleanup);

describe("Auto layout panel, grid mode", () => {
  it("switches a flex layout to a grid with the mode buttons", async () => {
    install(false);
    render(<AutoLayoutControls run={run} />);
    expect(screen.queryByRole("combobox", { name: "Column 1 kind" })).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: "Grid" }));
    expect(useScene.getState().scene!.nodes.at("f").autoLayout).toMatchObject({ mode: "grid", columns: [{ kind: "fr" }, { kind: "fr" }] });
    expect(screen.getByRole("combobox", { name: "Column 2 kind" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Direction" })).toBeNull();
  });

  it("edits, adds and removes tracks", async () => {
    install(true);
    const user = userEvent.setup();
    render(<AutoLayoutControls run={run} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Row 1 kind" }), { target: { value: "fixed" } });
    expect(useScene.getState().scene!.nodes.at("f").autoLayout!.rows).toEqual([{ kind: "fixed", size: 0 }]);
    await user.click(screen.getByRole("button", { name: "Add column" }));
    expect(useScene.getState().scene!.nodes.at("f").autoLayout!.columns).toHaveLength(3);
    await user.click(screen.getByRole("button", { name: "Remove column 1" }));
    expect(useScene.getState().scene!.nodes.at("f").autoLayout!.columns).toEqual([{ kind: "fr", size: 1 }, { kind: "fr", size: 1 }]);
    expect(useScene.getState().undoStack).toHaveLength(3);
  });
});

describe("Grid cell section", () => {
  it("shows for a child of a grid and writes the cell", () => {
    install(true);
    useScene.setState({ selection: ["a"] });
    render(<LayoutRelationControls />);
    const column = screen.getByRole("textbox", { name: "Column" });
    fireEvent.change(column, { target: { value: "2" } });
    fireEvent.blur(column);
    expect(useScene.getState().scene!.nodes.at("a").gridCell).toEqual({ column: 2 });
  });

  it("is absent in a flex layout", () => {
    install(false);
    useScene.setState({ selection: ["a"] });
    render(<LayoutRelationControls />);
    expect(screen.queryByText("Grid cell")).toBeNull();
  });
});
