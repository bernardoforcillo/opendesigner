import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "../store/store";
import { emptyScene, type NodeLite } from "../store/types";
import { ArrowheadControls, ShapeControls, StrokeSidesControls } from "./ShapeControls";
import { EffectStyleControls, PaintStyleControls } from "./StyleControls";

class FakeSync {
  sent: Op[] = [];
  submit(op: Op) {
    this.sent.push(op);
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
}

const node = (id: string, over: Partial<NodeLite> = {}): NodeLite => ({
  id, parentId: "page1", orderKey: id, name: id, visible: true, opacity: 1,
  x: 0, y: 0, width: 100, height: 100, rotation: 0, fills: [{ r: 1, g: 0, b: 0, a: 1 }], strokes: [],
  kind: "rect", cornerRadius: 8, clipsContent: false, ...over,
});

function install(n: NodeLite) {
  const scene = emptyScene("doc-1", "Untitled");
  scene.nodes = scene.nodes.set(n.id, n);
  useScene.getState().setScene(scene);
  useScene.getState().setSelection([n.id]);
}

const run = (build: (ids: readonly string[]) => Op[]) => {
  const store = useScene.getState();
  const ops = build(store.selection);
  store.beginGesture();
  store.endGesture(ops);
};
const current = (id = "a") => useScene.getState().scene!.nodes.at(id);

let sync: FakeSync;
beforeEach(() => {
  sync = new FakeSync();
  useScene.setState({ camera: { x: 0, y: 0, zoom: 1 }, selection: [], marquee: null, gesture: null, editingNodeId: null });
  useScene.getState().setSync(sync);
});
afterEach(cleanup);

const commit = (label: string, value: string) => {
  const input = screen.getByRole("textbox", { name: label });
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
};

describe("ShapeControls", () => {
  it("a polygon's Sides field writes the side count", () => {
    install(node("a", { kind: "polygon", sides: 6 }));
    render(<ShapeControls run={run} />);
    commit("Sides", "9");
    expect(current().sides).toBe(9);
    expect(sync.sent.at(-1)?.kind.case).toBe("setProps");
  });

  it("a star has Points and Inner ratio", () => {
    install(node("a", { kind: "star", points: 5, innerRatio: 0.4 }));
    render(<ShapeControls run={run} />);
    commit("Points", "8");
    commit("Inner ratio", "25");
    expect(current()).toMatchObject({ points: 8, innerRatio: 0.25 });
  });

  it("an ellipse has Start, Sweep (360 when full) and Ring", () => {
    install(node("a", { kind: "ellipse" }));
    render(<ShapeControls run={run} />);
    expect(screen.getByRole("textbox", { name: "Sweep" })).toHaveValue("360");
    commit("Sweep", "90");
    commit("Ring", "40");
    expect(current()).toMatchObject({ arcSweep: 90, innerRatio: 0.4 });
  });

  it("a rectangle has Smoothing and Independent corners; checking it shows four radii", () => {
    install(node("a"));
    render(<ShapeControls run={run} />);
    commit("Smoothing", "60");
    expect(current().cornerSmoothing).toBe(0.6);
    fireEvent.click(screen.getByRole("checkbox", { name: "Independent corners" }));
    expect(current().radii).toEqual({ topLeft: 8, topRight: 8, bottomRight: 8, bottomLeft: 8 });
    commit("Bottom right", "24");
    expect(current().radii?.bottomRight).toBe(24);
    fireEvent.click(screen.getByRole("checkbox", { name: "Independent corners" }));
    expect(current().radii).toBeUndefined();
    useScene.getState().undo();
    expect(current().radii?.bottomRight).toBe(24);
  });

  it("renders nothing for other shapes", () => {
    install(node("a", { kind: "text" }));
    const { container } = render(<ShapeControls run={run} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("stroke controls", () => {
  const line = (over: Partial<NodeLite> = {}) => node("a", {
    kind: "vector", fills: [], strokes: [{ color: { r: 0, g: 0, b: 0, a: 1 }, weight: 2, align: "center" }],
    vector: { subpaths: [{ closed: false, anchors: [{ x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 }, { x: 50, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 }] }] },
    ...over,
  });

  it("arrowheads are picked per end for an open path", () => {
    install(line());
    render(<ArrowheadControls run={run} />);
    fireEvent.change(screen.getByRole("combobox", { name: "End" }), { target: { value: "triangle" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Start" }), { target: { value: "circle" } });
    expect(current().strokes[0]).toMatchObject({ endCap: "triangle", startCap: "circle" });
    fireEvent.change(screen.getByRole("combobox", { name: "End" }), { target: { value: "none" } });
    expect(current().strokes[0].endCap).toBeUndefined();
  });

  it("no arrowhead controls on a closed path", () => {
    install(line({ vector: { subpaths: [{ closed: true, anchors: [] }] } }));
    const { container } = render(<ArrowheadControls run={run} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("per-side weights: the checkbox starts from the weight, a side edit keeps weight at the widest", () => {
    install(node("a", { strokes: [{ color: { r: 0, g: 0, b: 0, a: 1 }, weight: 2, align: "inside" }] }));
    render(<StrokeSidesControls run={run} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Per-side weights" }));
    expect(current().strokes[0].sides).toEqual({ top: 2, right: 2, bottom: 2, left: 2 });
    commit("Bottom", "6");
    expect(current().strokes[0]).toMatchObject({ weight: 6, sides: { top: 2, right: 2, bottom: 6, left: 2 } });
  });
});

describe("style controls", () => {
  it("makes a fill style from the node, shows the picker, and detaches / deletes it", () => {
    install(node("a"));
    const { rerender } = render(<PaintStyleControls target="fill" />);
    fireEvent.click(screen.getByRole("button", { name: "New style" }));
    const scene = useScene.getState().scene!;
    const id = Object.keys(scene.paintStyles)[0];
    expect(current().fillStyleId).toBe(id);
    rerender(<PaintStyleControls target="fill" />);
    expect(screen.getByRole("combobox", { name: "Fill style" })).toHaveValue(id);
    fireEvent.click(screen.getByRole("button", { name: "Detach" }));
    expect(current().fillStyleId).toBeUndefined();
    fireEvent.change(screen.getByRole("combobox", { name: "Fill style" }), { target: { value: id } });
    expect(current().fillStyleId).toBe(id);
    fireEvent.click(screen.getByRole("button", { name: "Delete style" }));
    expect(useScene.getState().scene!.paintStyles[id]).toBeUndefined();
    expect(current().fillStyleId).toBeUndefined();
    useScene.getState().undo();
    expect(current().fillStyleId).toBe(id);
  });

  it("effect styles: made from the node's effects and applied by name", () => {
    install(node("a", { effects: [{ kind: "layerBlur", radius: 3 }] }));
    render(<EffectStyleControls />);
    fireEvent.click(screen.getByRole("button", { name: "New style" }));
    const id = Object.keys(useScene.getState().scene!.effectStyles)[0];
    expect(current().effectStyleId).toBe(id);
  });

  it("the paint style row hides when there is nothing to choose or make", () => {
    install(node("a", { fills: [] }));
    const { container } = render(<PaintStyleControls target="fill" />);
    expect(container).toBeEmptyDOMElement();
  });
});
