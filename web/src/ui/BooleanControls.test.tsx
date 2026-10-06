import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { useScene } from "../store/store";
import { nodesOf } from "../store/nodeMap";
import { emptyScene } from "../store/types";
import type { NodeLite } from "../store/types";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { BooleanControls } from "./BooleanControls";

// Double of the transport: confirms every op at once (as in selection/align.test.ts).
const sync = {
  submit(op: Op) {
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  },
};

const rect = (id: string, x: number): NodeLite => ({
  id, parentId: "page1", orderKey: `a${id}`, name: id, visible: true, opacity: 1, x, y: 0, width: 100, height: 100, rotation: 0,
  fills: [{ r: 1, g: 0, b: 0, a: 1 }], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false,
});

describe("BooleanControls", () => {
  afterEach(cleanup);
  beforeEach(() => {
    useScene.setState({ camera: { x: 0, y: 0, zoom: 1 }, selection: [], gesture: null, sync: null });
    useScene.getState().setScene({ ...emptyScene("d", "t"), nodes: nodesOf({ a: rect("a", 0), b: rect("b", 50) }) });
    useScene.setState({ sync: sync as never });
  });

  it("is hidden below two shapes", () => {
    useScene.setState({ selection: ["a"] });
    render(<BooleanControls />);
    expect(screen.queryByRole("group", { name: "Boolean operations" })).toBeNull();
  });

  it("with two shapes, Union replaces them by one selected vector", () => {
    useScene.setState({ selection: ["a", "b"] });
    render(<BooleanControls />);
    fireEvent.click(screen.getByRole("button", { name: "Union" }));
    const s = useScene.getState();
    expect(s.selection).toHaveLength(1);
    expect(s.scene!.nodes.at(s.selection[0]).kind).toBe("vector");
    expect(s.scene!.nodes.at("a")).toBeUndefined();
  });

  it("a single node with a stroke offers Outline stroke, which turns it into a vector", () => {
    const n = rect("a", 0);
    useScene.getState().setScene({
      ...emptyScene("d", "t"),
      nodes: nodesOf({ a: { ...n, strokes: [{ color: { r: 0, g: 0, b: 1, a: 1 }, weight: 4, align: "center" }] } }),
    });
    useScene.setState({ selection: ["a"] });
    render(<BooleanControls />);
    fireEvent.click(screen.getByRole("button", { name: "Outline stroke" }));
    const s = useScene.getState();
    expect(s.scene!.nodes.at(s.selection[0]).kind).toBe("vector");
    expect(s.scene!.nodes.at("a").strokes).toEqual([]);
  });

  it("Use as mask toggles the flag on a single shape", () => {
    useScene.setState({ selection: ["a"] });
    render(<BooleanControls />);
    fireEvent.click(screen.getByRole("button", { name: "Use as mask" }));
    expect(useScene.getState().scene!.nodes.at("a").isMask).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Use as mask" }));
    expect(useScene.getState().scene!.nodes.at("a").isMask).toBeUndefined();
  });
});
