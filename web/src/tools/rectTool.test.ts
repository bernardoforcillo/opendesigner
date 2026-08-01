import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRectTool, DEFAULT_RECT_HEIGHT, DEFAULT_RECT_WIDTH } from "./rectTool";
import type { ToolContext } from "./types";
import type { Op } from "../gen/brawt/v1/brawt_pb";
import { useScene } from "../store/store";
import { emptyScene } from "../store/types";
import type { NodeLite } from "../store/types";

function node(id: string, orderKey: string): NodeLite {
  return { id, parentId: "page1", orderKey, name: id, visible: true, opacity: 1,
    x: 0, y: 0, width: 10, height: 10, rotation: 0, fills: [], kind: "rect", cornerRadius: 0 };
}

// Doppio del ToolContext: toWorld è l'identità su clientX/clientY, così i test
// ragionano direttamente in coordinate mondo. La conversione vera è testata in
// canvas/camera.test.ts.
function fakeCtx(zoom = 1) {
  const submitted: Op[] = [];
  const ctx = {
    sync: { submit: (op: Op) => submitted.push(op) },
    getScene: () => useScene.getState().scene,
    getCamera: () => ({ ...useScene.getState().camera, zoom }),
    setCamera: vi.fn(),
    canvas: {} as HTMLCanvasElement,
    toWorld: (e: PointerEvent) => ({ x: e.clientX, y: e.clientY }),
  } as unknown as ToolContext;
  return { ctx, submitted };
}

const at = (x: number, y: number) => ({ clientX: x, clientY: y }) as PointerEvent;

function createdNode(op: Op) {
  if (op.kind.case !== "createNode") throw new Error(`expected createNode, got ${op.kind.case}`);
  const n = op.kind.value.node;
  if (!n) throw new Error("createNode without node");
  return n;
}

beforeEach(() => {
  useScene.setState({
    scene: emptyScene("doc-1", "Untitled"),
    camera: { x: 0, y: 0, zoom: 1 },
    selection: [],
    marquee: null,
  });
});

describe("rectTool", () => {
  it("down/move/up emits exactly one createNode op with the dragged bounds", () => {
    const tool = createRectTool();
    const { ctx, submitted } = fakeCtx();

    tool.onPointerDown!(at(10, 20), ctx);
    tool.onPointerMove!(at(40, 50), ctx);
    tool.onPointerMove!(at(60, 80), ctx);
    expect(submitted).toHaveLength(0); // niente op durante il drag

    tool.onPointerUp!(at(60, 80), ctx);
    expect(submitted).toHaveLength(1);
    const n = createdNode(submitted[0]);
    expect({ x: n.x, y: n.y, width: n.width, height: n.height }).toEqual({ x: 10, y: 20, width: 50, height: 60 });
    expect(n.shape.case).toBe("rect");
    expect(n.parentId).toBe("page1");
    expect(n.visible).toBe(true);
  });

  it("normalizes a backwards drag", () => {
    const tool = createRectTool();
    const { ctx, submitted } = fakeCtx();
    tool.onPointerDown!(at(100, 100), ctx);
    tool.onPointerUp!(at(40, 60), ctx);
    const n = createdNode(submitted[0]);
    expect({ x: n.x, y: n.y, width: n.width, height: n.height }).toEqual({ x: 40, y: 60, width: 60, height: 40 });
  });

  it("uses the default size when the gesture is just a click", () => {
    const tool = createRectTool();
    const { ctx, submitted } = fakeCtx();
    tool.onPointerDown!(at(10, 20), ctx);
    tool.onPointerUp!(at(10, 20), ctx);
    const n = createdNode(submitted[0]);
    expect({ x: n.x, y: n.y, width: n.width, height: n.height })
      .toEqual({ x: 10, y: 20, width: DEFAULT_RECT_WIDTH, height: DEFAULT_RECT_HEIGHT });
  });

  it("treats a sub-pixel drag as a click at any zoom (threshold is in screen px)", () => {
    const tool = createRectTool();
    const { ctx, submitted } = fakeCtx(64); // molto zoomato: 0.02 unità mondo = ~1px schermo
    tool.onPointerDown!(at(10, 20), ctx);
    tool.onPointerMove!(at(10.02, 20.02), ctx);
    tool.onPointerUp!(at(10.02, 20.02), ctx);
    const n = createdNode(submitted[0]);
    expect(n.width).toBe(DEFAULT_RECT_WIDTH);
    expect(n.height).toBe(DEFAULT_RECT_HEIGHT);
  });

  it("derives the order key from the scene so it never collides after a reload", () => {
    useScene.setState({ scene: { ...emptyScene("doc-1", "u"), nodes: { a: node("a", "a000004") } } });
    const tool = createRectTool();
    const { ctx, submitted } = fakeCtx();
    tool.onPointerDown!(at(0, 0), ctx);
    tool.onPointerUp!(at(10, 10), ctx);
    expect(createdNode(submitted[0]).orderKey).toBe("a000005");
  });

  it("shows a live preview while dragging and clears it on up", () => {
    const tool = createRectTool();
    const { ctx } = fakeCtx();
    tool.onPointerDown!(at(10, 20), ctx);
    tool.onPointerMove!(at(60, 80), ctx);
    expect(useScene.getState().marquee).toEqual({ x: 10, y: 20, width: 50, height: 60 });
    tool.onPointerUp!(at(60, 80), ctx);
    expect(useScene.getState().marquee).toBeNull();
  });

  it("abandons the gesture on deactivate: no op, no preview, and the next up does nothing", () => {
    const tool = createRectTool();
    const { ctx, submitted } = fakeCtx();
    tool.onPointerDown!(at(10, 20), ctx);
    tool.onPointerMove!(at(60, 80), ctx);
    tool.onDeactivate!(ctx);
    expect(submitted).toHaveLength(0);
    expect(useScene.getState().marquee).toBeNull();

    tool.onPointerUp!(at(60, 80), ctx);
    expect(submitted).toHaveLength(0);
  });

  it("does not move or select anything: pointermove without a pending create is inert", () => {
    const tool = createRectTool();
    const { ctx, submitted } = fakeCtx();
    useScene.setState({ scene: { ...emptyScene("doc-1", "u"), nodes: { a: node("a", "a000000") } }, selection: [] });
    tool.onPointerMove!(at(5, 5), ctx);
    tool.onPointerUp!(at(5, 5), ctx);
    expect(submitted).toHaveLength(0);
    expect(useScene.getState().selection).toEqual([]);
  });
});
