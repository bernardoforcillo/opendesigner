import { describe, it, expect, vi } from "vitest";
import { createHandTool } from "./handTool";
import type { ToolContext } from "./types";
import type { Camera } from "../canvas/camera";

function fakeCtx(start: Camera = { x: 0, y: 0, zoom: 1 }) {
  let camera = start;
  const ctx = {
    sync: { submit: vi.fn() },
    getScene: () => null,
    getCamera: () => camera,
    setCamera: (c: Camera) => { camera = c; },
    canvas: {} as HTMLCanvasElement,
    toWorld: () => ({ x: 0, y: 0 }),
  } as unknown as ToolContext;
  return { ctx, camera: () => camera };
}

const at = (x: number, y: number) => ({ clientX: x, clientY: y }) as PointerEvent;

describe("handTool", () => {
  it("pans the camera by the screen delta of the drag", () => {
    const tool = createHandTool();
    const { ctx, camera } = fakeCtx({ x: 5, y: 5, zoom: 2 });

    tool.onPointerDown!(at(100, 100), ctx);
    tool.onPointerMove!(at(110, 120), ctx);
    expect(camera()).toEqual({ x: 15, y: 25, zoom: 2 });

    // il delta è incrementale rispetto all'ultima posizione, non all'ancora
    tool.onPointerMove!(at(115, 120), ctx);
    expect(camera()).toEqual({ x: 20, y: 25, zoom: 2 });
  });

  it("never changes the zoom", () => {
    const tool = createHandTool();
    const { ctx, camera } = fakeCtx({ x: 0, y: 0, zoom: 3 });
    tool.onPointerDown!(at(0, 0), ctx);
    tool.onPointerMove!(at(50, -50), ctx);
    expect(camera().zoom).toBe(3);
  });

  it("ignores moves outside a drag (before down, after up, after deactivate)", () => {
    const tool = createHandTool();
    const { ctx, camera } = fakeCtx();

    tool.onPointerMove!(at(50, 50), ctx);
    expect(camera()).toEqual({ x: 0, y: 0, zoom: 1 });

    tool.onPointerDown!(at(0, 0), ctx);
    tool.onPointerUp!(at(0, 0), ctx);
    tool.onPointerMove!(at(50, 50), ctx);
    expect(camera()).toEqual({ x: 0, y: 0, zoom: 1 });

    tool.onPointerDown!(at(0, 0), ctx);
    tool.onDeactivate!(ctx);
    tool.onPointerMove!(at(50, 50), ctx);
    expect(camera()).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it("never submits an op (pan is view-only, it must not touch the document)", () => {
    const tool = createHandTool();
    const { ctx } = fakeCtx();
    tool.onPointerDown!(at(0, 0), ctx);
    tool.onPointerMove!(at(10, 10), ctx);
    tool.onPointerUp!(at(10, 10), ctx);
    expect(ctx.sync.submit).not.toHaveBeenCalled();
  });
});
