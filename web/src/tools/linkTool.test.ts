import { describe, it, expect, beforeEach, vi } from "vitest";
import { linkTool } from "./linkTool";
import type { ToolContext } from "./types";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "../store/store";
import { nodesOf } from "../store/nodeMap";
import { emptyScene } from "../store/types";
import type { NodeLite } from "../store/types";

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
const at = (x: number, y: number) => ({ clientX: x, clientY: y }) as PointerEvent;

const box = (id: string, x: number, parentId = "page1"): NodeLite => ({
  id, parentId, orderKey: `a${id}`, name: id, visible: true, opacity: 1, x, y: 0, width: 100, height: 100, rotation: 0,
  fills: [{ r: 1, g: 1, b: 0, a: 1 }], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false,
});

beforeEach(() => {
  sync = new FakeSync();
  useScene.setState({ camera: { x: 0, y: 0, zoom: 1 }, selection: [], gesture: null, sync: null, linkPreview: null });
  useScene.getState().setScene({ ...emptyScene("d", "t"), nodes: nodesOf({ a: box("a", 0), b: box("b", 300) }) });
  useScene.getState().setSync(sync);
});

function drag(from: [number, number], to: [number, number]) {
  const c = ctx();
  linkTool.onPointerDown!(at(...from), c);
  linkTool.onPointerMove!(at(...to), c);
  linkTool.onPointerUp!(at(...to), c);
}

describe("linkTool", () => {
  it("dragging from one node to another makes a connector that joins them, in ONE gesture", () => {
    drag([50, 50], [350, 50]);
    const s = useScene.getState();
    expect(s.selection).toHaveLength(1);
    const c = s.scene!.nodes.at(s.selection[0]);
    expect(c.meta).toMatchObject({ "connector.from": "a", "connector.to": "b" });
    expect(s.undoStack).toHaveLength(1);
    expect(s.linkPreview).toBeNull();
  });

  it("a click, or a release on nothing, makes nothing", () => {
    drag([50, 50], [50, 50]);
    drag([50, 50], [600, 600]);
    expect(sync.sent).toHaveLength(0);
  });

  it("shows the rubber band while dragging", () => {
    const c = ctx();
    linkTool.onPointerDown!(at(50, 50), c);
    linkTool.onPointerMove!(at(200, 80), c);
    expect(useScene.getState().linkPreview).toMatchObject({ x: 200, y: 80 });
    linkTool.onKeyDown!({ key: "Escape" } as KeyboardEvent, c);
    expect(useScene.getState().linkPreview).toBeNull();
  });
});
