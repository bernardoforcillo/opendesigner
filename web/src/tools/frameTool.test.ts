import { describe, it, expect, beforeEach, vi } from "vitest";
import { createFrameTool, DEFAULT_FRAME_HEIGHT, DEFAULT_FRAME_WIDTH } from "./frameTool";
import type { ToolContext } from "./types";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "../store/store";
import { emptyScene } from "../store/types";

class FakeSync {
  sent: Op[] = [];
  submit(op: Op) {
    this.sent.push(op);
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
}

function fakeCtx() {
  const sync = new FakeSync();
  useScene.getState().setSync(sync);
  const ctx = {
    sync,
    getScene: () => useScene.getState().scene,
    getCamera: () => useScene.getState().camera,
    setCamera: vi.fn(),
    canvas: {} as HTMLCanvasElement,
    toWorld: (e: PointerEvent) => ({ x: e.clientX, y: e.clientY }),
  } as unknown as ToolContext;
  return { ctx, sent: sync.sent };
}
const at = (x: number, y: number) => ({ clientX: x, clientY: y }) as PointerEvent;

function created(op: Op) {
  if (op.kind.case !== "createNode" || !op.kind.value.node) throw new Error(`expected createNode, got ${op.kind.case}`);
  return op.kind.value.node;
}

describe("frameTool", () => {
  beforeEach(() => {
    useScene.setState({ camera: { x: 0, y: 0, zoom: 1 }, selection: [], marquee: null, gesture: null });
    useScene.getState().setScene(emptyScene("doc1", "t"));
  });

  it("un drag crea un FRAME bianco che ritaglia i figli, sul box trascinato", () => {
    const tool = createFrameTool();
    const { ctx, sent } = fakeCtx();
    tool.onPointerDown!(at(10, 20), ctx);
    tool.onPointerUp!(at(210, 120), ctx);
    expect(sent).toHaveLength(1);
    const n = created(sent[0]);
    expect(n.shape.case).toBe("frame");
    expect(n.shape.case === "frame" && n.shape.value.clipsContent).toBe(true);
    expect(n).toMatchObject({ name: "Frame", x: 10, y: 20, width: 200, height: 100, parentId: "page1" });
    const fill = n.fills[0].kind;
    expect(fill.case === "solid" && fill.value.color).toMatchObject({ r: 1, g: 1, b: 1, a: 1 });
    // Nessun auto layout di partenza: i figli stanno dove li si mette.
    expect(n.shape.case === "frame" && n.shape.value.autoLayout).toBeUndefined();
  });

  it("un semplice click crea un frame della misura di default", () => {
    const tool = createFrameTool();
    const { ctx, sent } = fakeCtx();
    tool.onPointerDown!(at(5, 5), ctx);
    tool.onPointerUp!(at(5, 5), ctx);
    expect(created(sent[0])).toMatchObject({ width: DEFAULT_FRAME_WIDTH, height: DEFAULT_FRAME_HEIGHT });
  });

  it("il rettangolo continua ad avere il suo grigio (la config fill non lo tocca)", async () => {
    const { createRectTool } = await import("./rectTool");
    const tool = createRectTool();
    const { ctx, sent } = fakeCtx();
    tool.onPointerDown!(at(0, 0), ctx);
    tool.onPointerUp!(at(50, 50), ctx);
    const fill = created(sent[0]).fills[0].kind;
    expect(fill.case === "solid" && fill.value.color).toMatchObject({ r: 0.6, g: 0.6, b: 0.65 });
  });
});
