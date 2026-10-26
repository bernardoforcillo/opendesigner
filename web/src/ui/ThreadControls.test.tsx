import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "@/store/store";
import { emptyScene, type NodeLite } from "@/store/types";
import { META_NEXT, setThreadMeasure } from "@/store/threads";
import { ThreadControls } from "@/ui/ThreadControls";

class FakeSync {
  submit(op: Op) {
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
}

const frame = (id: string, over: Partial<NodeLite> = {}, content = ""): NodeLite => ({
  id, parentId: "page1", orderKey: "a0", name: id, visible: true, opacity: 1, x: 0, y: 0, width: 100, height: 40, rotation: 0,
  fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind: "text", cornerRadius: 0, clipsContent: false,
  text: { content, style: { fontFamily: "", fontSize: 16, fontWeight: "", lineHeight: 1.25, align: "left" } }, ...over,
});

function install(selection: string[], ...nodes: NodeLite[]) {
  const scene = emptyScene("doc-1", "Untitled");
  for (const n of nodes) scene.nodes = scene.nodes.set(n.id, n);
  useScene.getState().setScene(scene);
  useScene.setState({ selection, gesture: null, editingNodeId: null });
}
const node = (id: string) => useScene.getState().scene!.nodes.at(id)!;

beforeEach(() => {
  setThreadMeasure(() => (s) => s.length * 10);
  useScene.setState({ undoStack: [], redoStack: [] });
  useScene.getState().setSync(new FakeSync());
});
afterEach(() => { cleanup(); setThreadMeasure(null); });

describe("ThreadControls", () => {
  it("threads two selected frames in selection order, keeping every word in the first", () => {
    install(["B", "A"], frame("A", {}, "alpha"), frame("B", { x: 200 }, "beta"));
    render(<ThreadControls />);
    fireEvent.click(screen.getByRole("button", { name: "Thread frames" }));
    expect(node("B").meta?.[META_NEXT]).toBe("A");
    expect(node("B").text!.content).toBe("beta\nalpha");
    expect(node("A").text!.content).toBe("");
    useScene.getState().undo();
    expect(node("B").meta?.[META_NEXT]).toBeUndefined();
    expect(node("B").text!.content).toBe("beta");
    expect(node("A").text!.content).toBe("alpha");
  });

  it("adds a linked empty frame beside a single frame and selects it", () => {
    install(["A"], frame("A", { x: 10, y: 20 }, "story"));
    render(<ThreadControls />);
    fireEvent.click(screen.getByRole("button", { name: "Add next frame" }));
    const next = node("A").meta![META_NEXT];
    expect(next).toBeTruthy();
    expect(node(next)).toMatchObject({ x: 134, y: 20, width: 100, height: 40, kind: "text" });
    expect(node(next).text!.content).toBe("");
    expect(node(next).meta?.[META_NEXT]).toBeUndefined();
    expect(useScene.getState().selection).toEqual([next]);
    // One undo removes both the frame and the link.
    useScene.getState().undo();
    expect(useScene.getState().scene!.nodes.at(next)).toBeUndefined();
    expect(node("A").meta?.[META_NEXT]).toBeUndefined();
  });

  it("shows where a frame sits in its chain and unlinks after it", () => {
    install(["A"], frame("A", { meta: { [META_NEXT]: "B" } }, "story"), frame("B", { x: 200 }));
    render(<ThreadControls />);
    expect(screen.getByText(/Frame 1 of 2/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Unlink after this frame" }));
    expect(node("A").meta?.[META_NEXT]).toBeUndefined();
  });

  it("tells a follower frame to edit in the first one, and flags left-over text", () => {
    install(["B"], frame("A", { meta: { [META_NEXT]: "B" }, height: 20 }, "aaaa bbbb cccc dddd eeee ffff"), frame("B", { x: 200, height: 20 }));
    render(<ThreadControls />);
    expect(screen.getByText(/Frame 2 of 2 · text left over · edit the text in the first frame/)).toBeInTheDocument();
  });

  it("renders nothing for a non-text selection", () => {
    install(["R"], frame("R", { kind: "rect", text: undefined }));
    const { container } = render(<ThreadControls />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("editing a threaded story", () => {
  it("beginTextEditing on a follower edits the first frame; an emptied story is not deleted", () => {
    install([], frame("A", { meta: { [META_NEXT]: "B" } }, "story"), frame("B", { x: 200 }));
    useScene.getState().beginTextEditing("B");
    expect(useScene.getState().editingNodeId).toBe("A");
    useScene.getState().setScene(useScene.getState().scene!);
    // Emptied head of a chain survives endTextEditing (it has frames to refill).
    useScene.setState({ scene: { ...useScene.getState().scene!, nodes: useScene.getState().scene!.nodes.set("A", frame("A", { meta: { [META_NEXT]: "B" } }, "")) } });
    useScene.getState().endTextEditing();
    expect(useScene.getState().scene!.nodes.at("A")).toBeDefined();
  });
});
