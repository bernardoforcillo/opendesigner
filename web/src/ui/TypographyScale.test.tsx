import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "@/store/store";
import { emptyScene, type NodeLite } from "@/store/types";
import { TypographyControls } from "@/ui/TypographyControls";

class FakeSync {
  submit(op: Op) {
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
}

const text = (id: string): NodeLite => ({
  id, parentId: "page1", orderKey: id, name: id, visible: true, opacity: 1,
  x: 0, y: 0, width: 100, height: 20, rotation: 0, fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [],
  kind: "text", cornerRadius: 0, clipsContent: false,
  text: { content: "Hello", style: { fontFamily: "Inter, sans-serif", fontSize: 16, fontWeight: "400", lineHeight: 0, align: "left" } },
});

const styleOf = (id: string) => useScene.getState().scene!.nodes.at(id).text!.style;

beforeEach(() => {
  const scene = emptyScene("doc-1", "Untitled");
  scene.nodes = scene.nodes.set("a", text("a"));
  useScene.getState().setScene(scene);
  useScene.setState({ camera: { x: 0, y: 0, zoom: 1 }, selection: ["a"], marquee: null, gesture: null, editingNodeId: null });
  useScene.getState().setSync(new FakeSync());
});
afterEach(cleanup);

describe("TypographyControls — horizontal scale", () => {
  const commit = (value: string) => {
    const input = screen.getByLabelText("Scale %");
    fireEvent.change(input, { target: { value } });
    fireEvent.blur(input);
  };

  it("shows 100 by default, sets a percentage as one undo step and clears at 100", () => {
    render(<TypographyControls />);
    expect(screen.getByLabelText("Scale %")).toHaveValue("100");
    commit("150");
    expect(styleOf("a").textScale).toBe(150);
    expect(useScene.getState().undoStack).toHaveLength(1);
    commit("100");
    expect(styleOf("a").textScale).toBeUndefined();
  });

  it("clamps to 1000", () => {
    render(<TypographyControls />);
    commit("5000");
    expect(styleOf("a").textScale).toBe(1000);
  });
});
