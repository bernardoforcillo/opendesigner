import { describe, it, expect, beforeEach, vi } from "vitest";
import { builderTool } from "@/tools/builderTool";
import type { ToolContext } from "@/tools/types";
import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "@/store/store";
import { nodesOf } from "@/store/nodeMap";
import { emptyScene } from "@/store/types";
import type { NodeLite } from "@/store/types";

class FakeSync {
  submit(op: Op) {
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
}
const ctx = (): ToolContext => ({
  sync: new FakeSync(), getScene: () => useScene.getState().scene, getCamera: () => useScene.getState().camera,
  setCamera: vi.fn(), canvas: {} as HTMLCanvasElement, toWorld: (e: PointerEvent) => ({ x: e.clientX, y: e.clientY }),
}) as unknown as ToolContext;
const at = (x: number, y: number, extra: Partial<PointerEvent> = {}) => ({ clientX: x, clientY: y, ...extra }) as PointerEvent;
const rect = (id: string, x: number, y: number, w: number, h: number): NodeLite => ({
  id, parentId: "page1", orderKey: `a${id}`, name: id, visible: true, opacity: 1, x, y, width: w, height: h, rotation: 0,
  fills: [{ r: 1, g: 0, b: 0, a: 1 }], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false,
});
const all = () => [...useScene.getState().scene!.nodes.values()];
const vectors = () => all().filter((n) => n.kind === "vector");

beforeEach(() => {
  useScene.setState({ camera: { x: 0, y: 0, zoom: 1 }, selection: ["a", "b"], gesture: null, sync: null, builderPreview: null, undoStack: [], redoStack: [] });
  useScene.getState().setScene({ ...emptyScene("d", "t"), nodes: nodesOf({ a: rect("a", 0, 0, 100, 100), b: rect("b", 50, 50, 100, 100) }) });
  useScene.getState().setSync(new FakeSync());
});

describe("builderTool", () => {
  it("hovering previews the face under the pointer", () => {
    builderTool.onPointerMove!(at(75, 75), ctx());
    expect(useScene.getState().builderPreview).toMatchObject({ mode: "merge" });
    expect(useScene.getState().builderPreview!.faces).toHaveLength(1);
    builderTool.onPointerMove!(at(500, 500), ctx());
    expect(useScene.getState().builderPreview).toBeNull();
  });

  it("a drag across the three faces merges them into one vector, in ONE undo step", () => {
    const c = ctx();
    builderTool.onPointerDown!(at(10, 10), c);
    builderTool.onPointerMove!(at(75, 75), c);
    expect(useScene.getState().builderPreview!.faces).toHaveLength(2);
    builderTool.onPointerUp!(at(140, 140), c);
    expect(useScene.getState().builderPreview).toBeNull();
    expect(vectors()).toHaveLength(1);
    expect(all().some((n) => n.id === "a" || n.id === "b")).toBe(false);
    expect(useScene.getState().selection).toEqual([vectors()[0].id]);
    expect(useScene.getState().undoStack).toHaveLength(1);
  });

  it("Alt-drag removes the faces it crosses", () => {
    const c = ctx();
    builderTool.onPointerDown!(at(75, 75, { altKey: true }), c); // the overlap
    builderTool.onPointerUp!(at(75, 75, { altKey: true }), c);
    expect(vectors()).toHaveLength(2);
    expect(vectors().reduce((t, n) => t + n.width * n.height, 0)).toBeLessThanOrEqual(2 * 100 * 100);
  });

  it("with fewer than two shapes selected a click adds the shape under it to the selection", () => {
    useScene.setState({ selection: ["a"] });
    const c = ctx();
    builderTool.onPointerDown!(at(140, 140), c);
    expect(useScene.getState().selection).toEqual(["a", "b"]);
  });

  it("Escape abandons a drag without ops", () => {
    const c = ctx();
    builderTool.onPointerDown!(at(10, 10), c);
    builderTool.onPointerMove!(at(75, 75), c);
    builderTool.onKeyDown!({ key: "Escape" } as KeyboardEvent, c);
    builderTool.onPointerUp!(at(140, 140), c);
    expect(vectors()).toHaveLength(0);
    expect(useScene.getState().builderPreview).toBeNull();
  });
});
