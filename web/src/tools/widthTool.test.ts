import { describe, it, expect, beforeEach, vi } from "vitest";
import { widthTool } from "./widthTool";
import type { ToolContext } from "./types";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "../store/store";
import { nodesOf } from "../store/nodeMap";
import { emptyScene } from "../store/types";
import type { NodeLite, WidthPointLite } from "../store/types";
import {
  addWidthPointInGap, dragWidth, insertWidthPoint, locateOnPath, movePointAlong, pickWidthHandle, sampleAt, setWidthPoint, widthHandles,
} from "../vector/widthEdit";

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
const pt = (x: number, y: number) => ({ x, y, inX: 0, inY: 0, outX: 0, outY: 0 });

// A horizontal line from (50,50) to (150,50) with a 10 wide stroke.
const vec = (profile?: WidthPointLite[]): NodeLite => ({
  id: "v", parentId: "page1", orderKey: "a", name: "v", visible: true, opacity: 1, x: 50, y: 50, width: 100, height: 0, rotation: 0,
  fills: [], strokes: [{ color: { r: 0, g: 0, b: 0, a: 1 }, weight: 10, align: "center", ...(profile ? { widthProfile: profile } : {}) }],
  kind: "vector", cornerRadius: 0, clipsContent: false, vector: { subpaths: [{ anchors: [pt(0, 0), pt(100, 0)], closed: false }] },
});
const node = () => useScene.getState().scene!.nodes.at("v");
const load = (n: NodeLite) => useScene.getState().setScene({ ...emptyScene("d", "t"), nodes: nodesOf({ v: n }) });

beforeEach(() => {
  sync = new FakeSync();
  useScene.setState({ camera: { x: 0, y: 0, zoom: 1 }, selection: ["v"], gesture: null, sync: null, widthEdit: { sel: null }, undoStack: [], redoStack: [] });
  load(vec());
  useScene.getState().setSync(sync);
});

describe("widthEdit helpers", () => {
  const sp = [{ anchors: [pt(0, 0), pt(100, 0)], closed: false }];
  it("samples and locates points by their fraction of the path", () => {
    expect(sampleAt(sp, 0, 0.25)).toMatchObject({ x: 25, y: 0 });
    // heading east, the left normal points north (y down)
    expect(sampleAt(sp, 0, 0.25)).toMatchObject({ nx: 0, ny: -1 });
    expect(locateOnPath(sp, 40, 3, 5)).toMatchObject({ t: 0.4, x: 40, y: 0 });
    expect(locateOnPath(sp, 40, 30, 5)).toBeNull();
  });
  it("inserting keeps the stroke's shape; an existing point is reused", () => {
    const base: WidthPointLite[] = [{ position: 0, left: 0, right: 0 }, { position: 1, left: 2, right: 2 }];
    const r = insertWidthPoint(base, 0.5)!;
    expect(r.index).toBe(1);
    expect(r.profile[1]).toEqual({ position: 0.5, left: 1, right: 1 });
    expect(insertWidthPoint(r.profile, 0.5001)!.profile).toHaveLength(3);
    expect(insertWidthPoint([], 0.3)!.profile).toEqual([{ position: 0.3, left: 1, right: 1 }]);
  });
  it("dragging a side sets that side only (or both), clamped to the range", () => {
    const p: WidthPointLite[] = [{ position: 0.5, left: 1, right: 1 }];
    expect(dragWidth(p, 0, "left", 10, 10, false)[0]).toEqual({ position: 0.5, left: 2, right: 1 });
    expect(dragWidth(p, 0, "right", 10, 10, true)[0]).toEqual({ position: 0.5, left: 2, right: 2 });
    expect(dragWidth(p, 0, "left", -4, 10, false)[0].left).toBe(0);
    expect(dragWidth(p, 0, "left", 9999, 10, false)[0].left).toBe(16);
  });
  it("a point never passes its neighbours", () => {
    const p: WidthPointLite[] = [{ position: 0.2, left: 1, right: 1 }, { position: 0.5, left: 1, right: 1 }, { position: 0.8, left: 1, right: 1 }];
    expect(movePointAlong(p, 1, 0.95)[1].position).toBe(0.8);
    expect(movePointAlong(p, 1, 0)[1].position).toBe(0.2);
    expect(setWidthPoint(p, 1, { position: 0.6, left: 40 })[1]).toEqual({ position: 0.6, left: 16, right: 1 });
  });
  it("a new point goes in the widest gap", () => {
    const r = addWidthPointInGap([{ position: 0.1, left: 1, right: 1 }, { position: 0.2, left: 1, right: 1 }])!;
    expect(r.profile[r.index].position).toBeCloseTo(0.6);
    expect(addWidthPointInGap([])!.profile[0].position).toBe(0.5);
  });
  it("handles sit at the stroke's edges; the nearest within tolerance is picked", () => {
    load(vec([{ position: 0.5, left: 1, right: 2 }]));
    const hs = widthHandles(node());
    expect(hs).toEqual([{ sub: 0, index: 0, side: "left", x: 50, y: -5 }, { sub: 0, index: 0, side: "right", x: 50, y: 10 }]);
    expect(pickWidthHandle(hs, 51, 9, 4)).toMatchObject({ side: "right" });
    expect(pickWidthHandle(hs, 80, 9, 4)).toBeNull();
  });
});

describe("widthTool", () => {
  it("a click on the path adds a width point in ONE gesture and selects it", () => {
    const c = ctx();
    widthTool.onPointerDown!(at(100, 52), c); // the middle of the line, 2 off it
    widthTool.onPointerUp!(at(100, 52), c);
    expect(node().strokes[0].widthProfile).toEqual([{ position: 0.5, left: 1, right: 1 }]);
    expect(useScene.getState().widthEdit?.sel).toBe(0);
    expect(useScene.getState().undoStack).toHaveLength(1);
  });

  it("dragging a handle sets that side's width; Alt sets both; the drag is one gesture", () => {
    load(vec([{ position: 0.5, left: 1, right: 1 }]));
    const c = ctx();
    // the left handle is at (100, 45) in the world; drag it 5 further north: 10 off the path = 200%
    widthTool.onPointerDown!(at(100, 45), c);
    widthTool.onPointerMove!(at(100, 40), c);
    widthTool.onPointerUp!(at(100, 40), c);
    expect(node().strokes[0].widthProfile).toEqual([{ position: 0.5, left: 2, right: 1 }]);
    expect(useScene.getState().undoStack).toHaveLength(1);

    widthTool.onPointerDown!(at(100, 40), c);
    widthTool.onPointerMove!(at(100, 50), c); // onto the path: zero width
    widthTool.onPointerUp!(at(100, 50), c);
    expect(node().strokes[0].widthProfile![0].left).toBe(0);

    load(vec([{ position: 0.5, left: 1, right: 1 }]));
    widthTool.onPointerDown!(at(100, 45), c);
    widthTool.onPointerMove!(at(100, 35), c);
    widthTool.onPointerUp!(at(100, 35, { altKey: true }), c);
    expect(node().strokes[0].widthProfile).toEqual([{ position: 0.5, left: 3, right: 3 }]);
  });

  it("Escape abandons a drag; Delete removes the selected point", () => {
    load(vec([{ position: 0.5, left: 1, right: 1 }]));
    const c = ctx();
    widthTool.onPointerDown!(at(100, 45), c);
    widthTool.onPointerMove!(at(100, 20), c);
    widthTool.onKeyDown!({ key: "Escape" } as KeyboardEvent, c);
    widthTool.onPointerUp!(at(100, 20), c);
    expect(node().strokes[0].widthProfile).toEqual([{ position: 0.5, left: 1, right: 1 }]);

    widthTool.onPointerDown!(at(100, 45), c);
    widthTool.onPointerUp!(at(100, 45), c);
    expect(useScene.getState().widthEdit?.sel).toBe(0);
    widthTool.onKeyDown!({ key: "Delete", preventDefault() {} } as unknown as KeyboardEvent, c);
    expect(node().strokes[0].widthProfile).toBeUndefined();
  });

  it("does nothing on a rotated vector", () => {
    load({ ...vec(), rotation: 20 });
    const c = ctx();
    widthTool.onPointerDown!(at(100, 50), c);
    widthTool.onPointerUp!(at(100, 50), c);
    expect(node().strokes[0].widthProfile).toBeUndefined();
  });
});
