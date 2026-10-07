import { describe, it, expect, beforeEach, vi } from "vitest";
import { nodeTool, pickNodeTarget } from "./nodeTool";
import type { ToolContext } from "./types";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "../store/store";
import { nodesOf } from "../store/nodeMap";
import { emptyScene } from "../store/types";
import type { AnchorLite, NodeLite, SubPathLite } from "../store/types";

class FakeSync {
  sent: Op[] = [];
  submit(op: Op) {
    this.sent.push(op);
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
}
let sync: FakeSync;
const ctx = (): ToolContext => ({
  sync, getScene: () => useScene.getState().scene, getCamera: () => useScene.getState().camera,
  setCamera: vi.fn(), canvas: {} as HTMLCanvasElement, toWorld: (e: PointerEvent) => ({ x: e.clientX, y: e.clientY }),
}) as unknown as ToolContext;
const at = (x: number, y: number, extra: Partial<PointerEvent> = {}) => ({ clientX: x, clientY: y, ...extra }) as PointerEvent;
const pt = (x: number, y: number): AnchorLite => ({ x, y, inX: 0, inY: 0, outX: 0, outY: 0 });
const path: SubPathLite = { anchors: [pt(0, 0), pt(100, 0), pt(100, 100)], closed: false };

const vec = (): NodeLite => ({
  id: "v", parentId: "page1", orderKey: "a", name: "v", visible: true, opacity: 1, x: 50, y: 50, width: 100, height: 100, rotation: 0,
  fills: [], strokes: [], kind: "vector", cornerRadius: 0, clipsContent: false, vector: { subpaths: [path] },
});
const subpaths = () => useScene.getState().scene!.nodes.at("v").vector!.subpaths;
const node = () => useScene.getState().scene!.nodes.at("v");

beforeEach(() => {
  sync = new FakeSync();
  useScene.setState({ camera: { x: 0, y: 0, zoom: 1 }, selection: ["v"], gesture: null, sync: null, nodeEdit: { sel: null }, undoStack: [], redoStack: [] });
  useScene.getState().setScene({ ...emptyScene("d", "t"), nodes: nodesOf({ v: vec() }) });
  useScene.getState().setSync(sync);
});

describe("pickNodeTarget", () => {
  it("prefers the selected anchor's handle, then anchors, then the outline", () => {
    const sp: SubPathLite = { anchors: [{ ...pt(0, 0), outX: 20, outY: 0 }, pt(100, 0)], closed: false };
    expect(pickNodeTarget([sp], 20, 1, 4, { sub: 0, index: 0 })).toMatchObject({ kind: "handle", which: "out" });
    expect(pickNodeTarget([sp], 20, 1, 4, null)).toMatchObject({ kind: "segment" });
    expect(pickNodeTarget([sp], 99, 1, 4, null)).toMatchObject({ kind: "anchor", index: 1 });
    expect(pickNodeTarget([sp], 50, 40, 4, null)).toBeNull();
  });
});

describe("nodeTool", () => {
  it("dragging an anchor moves it in ONE gesture and refits the box", () => {
    const c = ctx();
    nodeTool.onPointerDown!(at(150, 50), c); // anchor 1 is at (100,0) + origin (50,50)
    nodeTool.onPointerMove!(at(180, 50), c);
    nodeTool.onPointerUp!(at(190, 60), c);
    const sp = subpaths()[0];
    expect(sp.anchors).toHaveLength(3);
    expect(node().x).toBe(50);
    expect(node().width).toBeCloseTo(140);
    expect(useScene.getState().undoStack).toHaveLength(1);
    expect(useScene.getState().nodeEdit?.sel).toEqual({ sub: 0, index: 1 });
  });

  it("a click on the outline adds an anchor there; a double click flips corner/smooth", () => {
    const c = ctx();
    nodeTool.onPointerDown!(at(100, 50), c); // on the first segment, between (50,50) and (150,50)
    nodeTool.onPointerUp!(at(100, 50), c);
    expect(subpaths()[0].anchors).toHaveLength(4);
    expect(subpaths()[0].anchors[1].x).toBeCloseTo(50);
    const before = useScene.getState().undoStack.length;
    nodeTool.onPointerDown!(at(150, 50), c);
    nodeTool.onPointerUp!(at(150, 50), c);
    nodeTool.onPointerDown!(at(150, 50), c);
    nodeTool.onPointerUp!(at(150, 50), c);
    const a = subpaths()[0].anchors[2];
    expect(Math.abs(a.outX) + Math.abs(a.outY) + Math.abs(a.inX) + Math.abs(a.inY)).toBeGreaterThan(0);
    expect(useScene.getState().undoStack.length).toBe(before + 1);
  });

  it("Delete removes the selected anchor; Escape abandons a drag", () => {
    const c = ctx();
    nodeTool.onPointerDown!(at(150, 50), c);
    nodeTool.onPointerUp!(at(150, 50), c);
    nodeTool.onKeyDown!({ key: "Delete", preventDefault() {} } as unknown as KeyboardEvent, c);
    expect(subpaths()[0].anchors).toHaveLength(2);

    nodeTool.onPointerDown!(at(50, 50), c);
    nodeTool.onPointerMove!(at(300, 300), c);
    nodeTool.onKeyDown!({ key: "Escape" } as KeyboardEvent, c);
    nodeTool.onPointerUp!(at(300, 300), c);
    expect(subpaths()[0].anchors[0]).toMatchObject({ x: 0, y: 0 });
  });

  it("does nothing on a rotated vector", () => {
    useScene.getState().setScene({ ...emptyScene("d", "t"), nodes: nodesOf({ v: { ...vec(), rotation: 20 } }) });
    const c = ctx();
    nodeTool.onPointerDown!(at(150, 50), c);
    nodeTool.onPointerMove!(at(180, 50), c);
    nodeTool.onPointerUp!(at(180, 50), c);
    expect(sync.sent).toHaveLength(0);
  });
});
