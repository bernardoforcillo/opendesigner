import { describe, it, expect, beforeEach, vi } from "vitest";
import { createSelectTool } from "./selectTool";
import type { ToolContext } from "./types";
import { useScene } from "../store/store";
import { emptyScene } from "../store/types";
import type { NodeLite } from "../store/types";

function node(id: string, x: number, orderKey: string): NodeLite {
  return { id, parentId: "page1", orderKey, name: id, visible: true, opacity: 1,
    x, y: 0, width: 50, height: 50, rotation: 0, fills: [], kind: "rect", cornerRadius: 0 };
}

function fakeCtx(): ToolContext {
  return {
    sync: { submit: vi.fn() },
    getScene: () => useScene.getState().scene,
    getCamera: () => useScene.getState().camera,
    setCamera: vi.fn(),
    canvas: {} as HTMLCanvasElement,
    toWorld: (e: PointerEvent) => ({ x: e.clientX, y: e.clientY }),
  } as unknown as ToolContext;
}

const at = (x: number, y: number, shiftKey = false) => ({ clientX: x, clientY: y, shiftKey }) as PointerEvent;

beforeEach(() => {
  useScene.setState({
    scene: { ...emptyScene("doc-1", "u"), nodes: { a: node("a", 0, "a000000"), b: node("b", 100, "a000001") } },
    camera: { x: 0, y: 0, zoom: 1 },
    selection: [],
    marquee: null,
  });
});

describe("selectTool", () => {
  it("selects the node under the pointer", () => {
    createSelectTool().onPointerDown!(at(120, 10), fakeCtx());
    expect(useScene.getState().selection).toEqual(["b"]);
  });

  it("shift-click toggles, plain click replaces", () => {
    const tool = createSelectTool();
    const ctx = fakeCtx();
    tool.onPointerDown!(at(10, 10), ctx);
    tool.onPointerDown!(at(120, 10, true), ctx);
    expect(useScene.getState().selection).toEqual(["a", "b"]);

    tool.onPointerDown!(at(120, 10, true), ctx);
    expect(useScene.getState().selection).toEqual(["a"]);

    tool.onPointerDown!(at(120, 10), ctx);
    expect(useScene.getState().selection).toEqual(["b"]);
  });

  it("clicking empty space clears, shift-clicking it keeps the selection", () => {
    const tool = createSelectTool();
    const ctx = fakeCtx();
    tool.onPointerDown!(at(10, 10), ctx);

    tool.onPointerDown!(at(900, 900, true), ctx);
    expect(useScene.getState().selection).toEqual(["a"]);

    tool.onPointerDown!(at(900, 900), ctx);
    expect(useScene.getState().selection).toEqual([]);
  });
});
