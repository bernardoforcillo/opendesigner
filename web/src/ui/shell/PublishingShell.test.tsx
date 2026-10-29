import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";
import { ControlPanel } from "@/ui/shell/ControlPanel";
import { StatusBar } from "@/ui/shell/StatusBar";
import { ToolDock } from "@/ui/shell/ToolDock";
import { useScene } from "@/store/store";
import { NodeMap } from "@/store/nodeMap";
import { emptyScene, type NodeLite, type SceneState } from "@/store/types";

class FakeSync {
  submit(op: Op) {
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
}

const sheet = { width: 400, height: 600 };
const rect = (id: string, x: number): NodeLite => ({
  id, parentId: "page1", orderKey: id, name: id, visible: true, opacity: 1, x, y: 20, width: 100, height: 50, rotation: 0,
  fills: [{ r: 1, g: 0, b: 0, a: 1 }], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false,
});
const book = (): SceneState => ({
  ...emptyScene("d", "Book"),
  settings: { vertical: "publishing" },
  pages: [
    { id: "page1", name: "Cover", ...sheet },
    { id: "m1", name: "A-Master", isMaster: true, ...sheet },
    { id: "p2", name: "Chapter", masterId: "m1", ...sheet },
  ],
  nodes: NodeMap.from({ a: rect("a", 10), b: rect("b", 30) }),
});

function install(scene: SceneState) {
  useScene.getState().setScene(scene);
  useScene.getState().setSync(new FakeSync());
  useScene.setState({ currentPageId: "page1", selection: [], gesture: null, undoStack: [], redoStack: [], camera: { x: 0, y: 0, zoom: 1 } });
}
afterEach(cleanup);
beforeEach(() => install(book()));

describe("ControlPanel", () => {
  it("is disabled and empty with nothing selected", () => {
    render(<ControlPanel />);
    expect(screen.getByText("Nothing selected")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "X" })).toBeDisabled();
  });

  it("shows the geometry of the selection and writes a typed value as one undo step", () => {
    useScene.setState({ selection: ["a"] });
    render(<ControlPanel />);
    expect(screen.getByRole("textbox", { name: "X" })).toHaveValue("10");
    expect(screen.getByRole("textbox", { name: "W" })).toHaveValue("100");
    const x = screen.getByRole("textbox", { name: "X" });
    fireEvent.change(x, { target: { value: "42" } });
    fireEvent.blur(x);
    expect(useScene.getState().scene!.nodes.at("a")!.x).toBe(42);
    expect(useScene.getState().undoStack).toHaveLength(1);
  });

  it("shows Mixed where a multiple selection differs", () => {
    useScene.setState({ selection: ["a", "b"] });
    render(<ControlPanel />);
    expect(screen.getByText("2 objects")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "X" })).toHaveAttribute("placeholder", "Mixed");
    expect(screen.getByRole("textbox", { name: "W" })).toHaveValue("100");
  });
});

describe("StatusBar", () => {
  it("shows the zoom and steps it around the canvas centre", () => {
    render(<StatusBar />);
    expect(screen.getByLabelText("Zoom")).toHaveTextContent("100%");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(useScene.getState().camera.zoom).toBeCloseTo(1.25);
    expect(screen.getByLabelText("Zoom")).toHaveTextContent("125%");
  });

  it("walks the regular pages (masters are not pages)", () => {
    render(<StatusBar />);
    expect(screen.getByLabelText("Page")).toHaveTextContent("1 / 2");
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(useScene.getState().currentPageId).toBe("p2");
    expect(screen.getByLabelText("Page")).toHaveTextContent("2 / 2");
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
  });

  it("reports the preflight verdict", () => {
    render(<StatusBar />);
    expect(screen.getByLabelText("Preflight")).toBeInTheDocument();
  });
});

describe("ToolDock rail", () => {
  it("is a vertical toolbar without the Animation button", () => {
    render(<ToolDock variant="rail" mode="design" toolId="select" onChoose={() => {}} tools={[{ id: "select", label: "Select" }, { id: "text", label: "Text" }]} />);
    const bar = screen.getByRole("toolbar");
    expect(bar).toHaveAttribute("aria-orientation", "vertical");
    expect(screen.queryByRole("button", { name: "Animation" })).toBeNull();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });
});
