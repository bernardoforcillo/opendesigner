import { describe, it, expect, beforeEach, vi } from "vitest";
import { nodesOf } from "@/store/nodeMap";
import { createSelectTool } from "@/tools/selectTool";
import { threadPortHit, threadPortOf } from "@/selection/threadPort";
import { META_NEXT } from "@/store/threads";
import type { ToolContext } from "@/tools/types";
import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "@/store/store";
import { emptyScene } from "@/store/types";
import type { NodeLite } from "@/store/types";

const frame = (id: string, x: number, extra: Partial<NodeLite> = {}): NodeLite => ({
  id, parentId: "page1", orderKey: id, name: id, visible: true, opacity: 1, x, y: 100, width: 200, height: 120,
  rotation: 0, fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind: "text", cornerRadius: 0, clipsContent: false,
  text: { content: "story", style: { fontFamily: "", fontSize: 16, fontWeight: "", lineHeight: 1.25, align: "left" } }, ...extra,
});

class FakeSync {
  sent: Op[] = [];
  submit(op: Op) { this.sent.push(op); useScene.getState().applyPending(op); useScene.getState().apply(op); }
}
function ctx(): ToolContext {
  return {
    sync: { submit: vi.fn() },
    getScene: () => useScene.getState().scene,
    getCamera: () => useScene.getState().camera,
    setCamera: vi.fn(),
    canvas: { style: { cursor: "" } } as unknown as HTMLCanvasElement,
    toWorld: (e: PointerEvent) => ({ x: e.clientX, y: e.clientY }),
  } as unknown as ToolContext;
}
const at = (x: number, y: number) => ({ clientX: x, clientY: y, shiftKey: false }) as PointerEvent;

beforeEach(() => {
  useScene.getState().setScene({ ...emptyScene("d", "u"), nodes: nodesOf({ a: frame("a", 0), b: frame("b", 400) }) });
  useScene.setState({ camera: { x: 0, y: 0, zoom: 1 }, selection: ["a"], gesture: null, snapGuides: [], marquee: null, undoStack: [], redoStack: [] });
  useScene.getState().setSync(new FakeSync());
});

describe("thread port", () => {
  it("sits inside the bottom-right corner of the selected frame", () => {
    const p = threadPortOf(useScene.getState().scene!, ["a"], 1)!;
    expect(p.world).toEqual({ x: 196, y: 216 });
    expect(threadPortHit(p, { x: 197, y: 217 }, 1)).toBe(true);
    expect(threadPortHit(p, { x: 150, y: 150 }, 1)).toBe(false);
  });

  it("is not offered for a frame that already flows on", () => {
    const s = useScene.getState().scene!;
    const linked = { ...s, nodes: s.nodes.set("a", frame("a", 0, { meta: { [META_NEXT]: "b" } })) };
    expect(threadPortOf(linked, ["a"], 1)).toBeNull();
  });

  it("dragging it onto another frame links the two", () => {
    const tool = createSelectTool();
    const c = ctx();
    tool.onPointerDown!(at(196, 216), c);
    tool.onPointerMove!(at(300, 200), c);
    tool.onPointerUp!(at(450, 150), c);
    expect(useScene.getState().scene!.nodes.at("a")!.meta?.[META_NEXT]).toBe("b");
  });

  it("released over empty space does nothing", () => {
    const tool = createSelectTool();
    const c = ctx();
    tool.onPointerDown!(at(196, 216), c);
    tool.onPointerUp!(at(900, 900), c);
    expect(useScene.getState().scene!.nodes.at("a")!.meta?.[META_NEXT]).toBeUndefined();
  });
});
