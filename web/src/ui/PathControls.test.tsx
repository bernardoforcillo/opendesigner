// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "../store/store";
import { nodesOf } from "../store/nodeMap";
import { emptyScene } from "../store/types";
import type { AnchorLite, NodeLite, SubPathLite } from "../store/types";
import { PathControls } from "./PathControls";

afterEach(cleanup);
const sync = { submit(op: Op) { useScene.getState().applyPending(op); useScene.getState().apply(op); } };
const pt = (x: number, y: number): AnchorLite => ({ x, y, inX: 0, inY: 0, outX: 0, outY: 0 });
const vec = (id: string, x: number, ...sps: SubPathLite[]): NodeLite => ({
  id, parentId: "page1", orderKey: `a${id}`, name: id, visible: true, opacity: 1, x, y: 0, width: 10, height: 10, rotation: 0,
  fills: [], strokes: [], kind: "vector", cornerRadius: 0, clipsContent: false, vector: { subpaths: sps },
});
const sq: SubPathLite = { anchors: [pt(0, 0), pt(100, 0), pt(100, 100), pt(0, 100)], closed: true };

beforeEach(() => {
  useScene.setState({ camera: { x: 0, y: 0, zoom: 1 }, selection: [], gesture: null, sync: null, undoStack: [], redoStack: [] });
});

function load(nodes: Record<string, NodeLite>, selection: string[]) {
  useScene.getState().setScene({ ...emptyScene("d", "t"), nodes: nodesOf(nodes) });
  useScene.setState({ sync: sync as never, selection });
}

describe("PathControls", () => {
  it("grows a shape by the distance in the field, as one undo step", () => {
    load({ a: vec("a", 0, sq) }, ["a"]);
    render(<PathControls />);
    fireEvent.change(screen.getByLabelText("Offset distance"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Grow" }));
    const n = useScene.getState().scene!.nodes.at("a");
    expect(n.width).toBeCloseTo(120, 0);
    expect(useScene.getState().undoStack).toHaveLength(1);
  });

  it("smooths every point", () => {
    load({ a: vec("a", 0, sq) }, ["a"]);
    render(<PathControls />);
    fireEvent.click(screen.getByRole("button", { name: "Smooth" }));
    expect(useScene.getState().scene!.nodes.at("a").vector!.subpaths[0].anchors.some((q) => q.outX !== 0 || q.outY !== 0)).toBe(true);
  });

  it("joins two open paths into the first", () => {
    const l = (x1: number, y1: number, x2: number, y2: number): SubPathLite => ({ anchors: [pt(x1, y1), pt(x2, y2)], closed: false });
    load({ a: vec("a", 0, l(0, 0, 10, 0)), b: vec("b", 10, l(0, 0, 0, 10)) }, ["a", "b"]);
    render(<PathControls />);
    fireEvent.click(screen.getByRole("button", { name: "Join paths" }));
    const s = useScene.getState();
    expect(s.selection).toEqual(["a"]);
    expect(s.scene!.nodes.get("b")).toBeUndefined();
    expect(s.scene!.nodes.at("a").vector!.subpaths[0].anchors).toHaveLength(3);
  });

  it("shows nothing for a non-path", () => {
    load({ a: { ...vec("a", 0, sq), kind: "rect" } }, ["a"]);
    render(<PathControls />);
    expect(screen.queryByRole("group")).toBeNull();
  });
});
