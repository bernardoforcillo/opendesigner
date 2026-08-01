import { create } from "@bufbuild/protobuf";
import { OpSchema, NodeSchema } from "../gen/brawt/v1/brawt_pb";
import type { Op } from "../gen/brawt/v1/brawt_pb";
import { hitTest } from "../renderer/canvasRenderer";
import { useScene } from "../store/store";
import { nextOrderKey } from "../store/orderKey";
import type { SyncClient } from "../rpc/syncClient";
import { screenToWorld } from "../canvas/camera";

function uuid(): string { return crypto.randomUUID(); }

export function makeRectOp(x: number, y: number, w: number, h: number): Op {
  const node = create(NodeSchema, {
    id: uuid(), parentId: "page1", orderKey: nextOrderKey(useScene.getState().scene), name: "Rectangle",
    visible: true, opacity: 1, x, y, width: w, height: h,
    fills: [{ kind: { case: "solid", value: { color: { r: 0.6, g: 0.6, b: 0.65, a: 1 } } } }],
    shape: { case: "rect", value: { cornerRadius: 0 } },
  });
  return create(OpSchema, { opId: uuid(), docId: useScene.getState().scene?.id ?? "", kind: { case: "createNode", value: { node } } });
}

export function makeMoveOp(id: string, x: number, y: number): Op {
  return create(OpSchema, { opId: uuid(), docId: useScene.getState().scene?.id ?? "", kind: { case: "setProps", value: {
    id, patch: create(NodeSchema, { x, y }), mask: { paths: ["x", "y"] } } } });
}

type Mode = "select" | "rect";

export function attachRectTool(canvas: HTMLCanvasElement, sync: SyncClient, getMode: () => Mode): () => void {
  let dragging: { id: string; offx: number; offy: number } | null = null;
  let creating: { x: number; y: number } | null = null;

  const toWorld = (e: PointerEvent) => {
    const cam = useScene.getState().camera;
    const rect = canvas.getBoundingClientRect();
    return screenToWorld(cam, e.clientX - rect.left, e.clientY - rect.top);
  };

  const onDown = (e: PointerEvent) => {
    const { x, y } = toWorld(e);
    if (getMode() === "rect") { creating = { x, y }; return; }
    const id = hitTest(useScene.getState().scene!, x, y);
    if (id) { const n = useScene.getState().scene!.nodes[id]; dragging = { id, offx: x - n.x, offy: y - n.y }; }
  };
  const onMove = (e: PointerEvent) => {
    if (!dragging) return;
    const { x, y } = toWorld(e);
    sync.submit(makeMoveOp(dragging.id, x - dragging.offx, y - dragging.offy));
  };
  const onUp = (e: PointerEvent) => {
    if (creating) {
      const { x, y } = toWorld(e);
      const w = Math.abs(x - creating.x) || 100, h = Math.abs(y - creating.y) || 80;
      sync.submit(makeRectOp(Math.min(x, creating.x), Math.min(y, creating.y), w, h));
      creating = null;
    }
    dragging = null;
  };

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  return () => {
    canvas.removeEventListener("pointerdown", onDown);
    canvas.removeEventListener("pointermove", onMove);
    canvas.removeEventListener("pointerup", onUp);
  };
}
