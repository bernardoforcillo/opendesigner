import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";
import { ControlPanel } from "@/ui/shell/ControlPanel";
import { StatusBar } from "@/ui/shell/StatusBar";
import { StylesPanel } from "@/ui/shell/StylesPanel";
import { PreflightPanel } from "@/ui/shell/PreflightPanel";
import { useScene } from "@/store/store";
import { useDock } from "@/store/dock";
import { NodeMap } from "@/store/nodeMap";
import { emptyScene, type NodeLite, type SceneState } from "@/store/types";

class FakeSync {
  submit(op: Op) {
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
}

const style = { fontFamily: "Georgia", fontSize: 12, fontWeight: "400", lineHeight: 1.4, align: "left" as const };
const text = (id: string, page = "page1"): NodeLite => ({
  id, parentId: page, orderKey: id, name: id, visible: true, opacity: 1, x: 0, y: 0, width: 200, height: 100, rotation: 0,
  fills: [], strokes: [], kind: "text", cornerRadius: 0, clipsContent: false,
  text: { content: "One\nTwo", style },
});
const doc = (): SceneState => ({
  ...emptyScene("d", "Doc"),
  settings: { vertical: "publishing" },
  pages: [{ id: "page1", name: "One", width: 400, height: 600 }, { id: "page2", name: "Two" }],
  textStyles: {
    h: { id: "h", name: "Heading", style: { ...style, fontSize: 30 } },
    b: { id: "b", name: "Body", style },
    e: { id: "e", name: "Emphasis", kind: "character", style: { ...style, italic: true } },
  },
  nodes: NodeMap.from({ t: text("t") }),
});

function install(scene: SceneState, selection: string[] = []) {
  useScene.getState().setScene(scene);
  useScene.getState().setSync(new FakeSync());
  useScene.setState({ currentPageId: "page1", selection, gesture: null, undoStack: [], redoStack: [] });
}
afterEach(cleanup);
beforeEach(() => install(doc()));

describe("StylesPanel", () => {
  it("lists paragraph and character styles apart and disables them without a text selection", () => {
    render(<StylesPanel />);
    expect(screen.getByText("Select a text frame to apply a style.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Heading/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Emphasis/ })).toBeDisabled();
  });

  it("applies a paragraph style to the selected frame and marks it", () => {
    install(doc(), ["t"]);
    render(<StylesPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Heading/ }));
    expect(useScene.getState().scene!.nodes.at("t")!.text!.paragraphStyles).toEqual(["h", "h"]);
    expect(screen.getByRole("button", { name: /Heading/ })).toHaveAttribute("aria-pressed", "true");
    expect(useScene.getState().undoStack).toHaveLength(1);
  });

  it("applies a character style to the whole text, and None clears it", () => {
    install(doc(), ["t"]);
    render(<StylesPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Emphasis/ }));
    expect(useScene.getState().scene!.nodes.at("t")!.text!.runs).toEqual([{ start: 0, end: 7, styleId: "e" }]);
    const none = screen.getAllByRole("button", { name: "None" })[1]; // the second list is the character styles
    fireEvent.click(none);
    expect(useScene.getState().scene!.nodes.at("t")!.text!.runs ?? []).toEqual([]);
  });
});

describe("ControlPanel text controls", () => {
  it("does not show type controls without a text selection", () => {
    render(<ControlPanel />);
    expect(screen.queryByRole("combobox", { name: "Paragraph style" })).toBeNull();
  });

  it("picks a paragraph style, and the size follows the style", () => {
    install(doc(), ["t"]);
    render(<ControlPanel />);
    expect(screen.getByRole("textbox", { name: "Size" })).toHaveValue("12");
    fireEvent.change(screen.getByRole("combobox", { name: "Paragraph style" }), { target: { value: "h" } });
    expect(useScene.getState().scene!.nodes.at("t")!.text!.paragraphStyles).toEqual(["h", "h"]);
    expect(screen.getByRole("textbox", { name: "Size" })).toHaveValue("30");
    expect(screen.getByRole("textbox", { name: "Size" })).toBeDisabled();
  });

  it("sets the size and the alignment of the frame as one undo step each", () => {
    install(doc(), ["t"]);
    render(<ControlPanel />);
    const size = screen.getByRole("textbox", { name: "Size" });
    fireEvent.change(size, { target: { value: "18" } });
    fireEvent.blur(size);
    expect(useScene.getState().scene!.nodes.at("t")!.text!.style.fontSize).toBe(18);
    fireEvent.change(screen.getByRole("combobox", { name: "Alignment" }), { target: { value: "justify" } });
    expect(useScene.getState().scene!.nodes.at("t")!.text!.style.align).toBe("justify");
    expect(useScene.getState().undoStack).toHaveLength(2);
  });
});

describe("PreflightPanel", () => {
  it("lists what is wrong, grouped, and goes to the page when one is chosen", () => {
    render(<PreflightPanel />);
    expect(screen.getByRole("region", { name: "Warnings" })).toHaveTextContent(/Page "Two" has no size/);
    expect(screen.getByRole("region", { name: "Warnings" })).toHaveTextContent(/Font "Georgia" is not uploaded/);
    fireEvent.click(screen.getByRole("button", { name: /Page "Two" has no size/ }));
    expect(useScene.getState().currentPageId).toBe("page2");
  });

  it("selects the object of an issue", () => {
    render(<PreflightPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Font "Georgia"/ }));
    expect(useScene.getState().selection).toEqual(["t"]);
  });

  it("says so when there is nothing to fix", () => {
    install({ ...doc(), pages: [{ id: "page1", name: "One", width: 400, height: 600 }], nodes: NodeMap.empty });
    render(<PreflightPanel />);
    expect(screen.getByText("No errors")).toBeInTheDocument();
  });
});

describe("StatusBar preflight", () => {
  it("opens the Preflight tab of the dock", () => {
    useDock.getState().setTab("properties");
    render(<StatusBar />);
    fireEvent.click(screen.getByRole("button", { name: "Preflight" }));
    expect(useDock.getState().tab).toBe("preflight");
  });
});
