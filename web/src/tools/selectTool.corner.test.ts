import { describe, it, expect, beforeEach, vi } from "vitest";
import { nodesOf } from "@/store/nodeMap";
import { createSelectTool } from "@/tools/selectTool";
import { cornerHandleOf, cornerHandleHit, cornerRadiusAt } from "@/selection/cornerHandle";
import type { ToolContext } from "@/tools/types";
import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "@/store/store";
import { emptyScene } from "@/store/types";
import type { NodeLite } from "@/store/types";

const rect = (id: string, extra: Partial<NodeLite> = {}): NodeLite => ({
  id, parentId: "page1", orderKey: id, name: id, visible: true, opacity: 1, x: 100, y: 100, width: 200, height: 120,
  rotation: 0, fills: [], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false, ...extra,
});

class FakeSync {
  sent: Op[] = [];
  submit(op: Op) {
    this.sent.push(op);
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
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
const radiusOf = (id: string) => useScene.getState().scene!.nodes.at(id)!.cornerRadius;

let sync: FakeSync;
function install(nodes: Record<string, NodeLite>, selection: string[]) {
  useScene.getState().setScene({ ...emptyScene("d", "u"), nodes: nodesOf(nodes) });
  useScene.setState({ camera: { x: 0, y: 0, zoom: 1 }, selection, gesture: null, snapGuides: [], marquee: null, undoStack: [], redoStack: [] });
  sync = new FakeSync();
  useScene.getState().setSync(sync);
}
beforeEach(() => install({ r: rect("r") }, ["r"]));

describe("cornerHandleOf", () => {
  const scene = () => useScene.getState().scene!;

  it("sits a few pixels in from the corner of a square-cornered rectangle, and rides the curve once rounded", () => {
    const h = cornerHandleOf(scene(), ["r"], 1)!;
    expect(h.world).toEqual({ x: 114, y: 114 });
    install({ r: rect("r", { cornerRadius: 30 }) }, ["r"]);
    expect(cornerHandleOf(scene(), ["r"], 1)!.world).toEqual({ x: 130, y: 130 });
    // zoomed in, the inset is still ~14 screen pixels
    install({ r: rect("r") }, ["r"]);
    expect(cornerHandleOf(scene(), ["r"], 2)!.world).toEqual({ x: 107, y: 107 });
  });

  it("only appears for one plain rectangle that is big enough on screen", () => {
    expect(cornerHandleOf(scene(), [], 1)).toBeNull();
    expect(cornerHandleOf(scene(), ["r", "r"], 1)).toBeNull();
    expect(cornerHandleOf(scene(), ["r"], 0.1)).toBeNull(); // 12 px tall on screen
    install({ e: rect("e", { kind: "ellipse" }) }, ["e"]);
    expect(cornerHandleOf(scene(), ["e"], 1)).toBeNull();
    install({ s: rect("s", { cornerSmoothing: 0.6 }) }, ["s"]);
    expect(cornerHandleOf(scene(), ["s"], 1)).toBeNull();
    install({ i: rect("i", { radii: { topLeft: 4, topRight: 4, bottomRight: 4, bottomLeft: 4 } }) }, ["i"]);
    expect(cornerHandleOf(scene(), ["i"], 1)).toBeNull();
    install({ h: rect("h", { visible: false }) }, ["h"]);
    expect(cornerHandleOf(scene(), ["h"], 1)).toBeNull();
  });

  it("is hit within a few screen pixels", () => {
    const h = cornerHandleOf(scene(), ["r"], 1)!;
    expect(cornerHandleHit(h, { x: 118, y: 114 }, 1)).toBe(true);
    expect(cornerHandleHit(h, { x: 130, y: 130 }, 1)).toBe(false);
  });
});

describe("cornerRadiusAt", () => {
  it("follows the pointer along the diagonal and stays between 0 and half the shorter side", () => {
    const scene = useScene.getState().scene!;
    expect(cornerRadiusAt(scene, "r", { x: 120, y: 120 })).toBe(20);
    expect(cornerRadiusAt(scene, "r", { x: 50, y: 50 })).toBe(0);
    expect(cornerRadiusAt(scene, "r", { x: 400, y: 400 })).toBe(60); // 120 / 2
  });

  it("works in a rotated rectangle's own space", () => {
    install({ r: rect("r", { rotation: 90 }) }, ["r"]);
    const scene = useScene.getState().scene!;
    // turned a quarter around its centre (200, 160): its top-left corner is now at the top-right
    expect(cornerRadiusAt(scene, "r", { x: 260 - 0, y: 60 + 0 })).toBe(0);
    expect(cornerRadiusAt(scene, "r", { x: 260 - 20, y: 60 + 20 })).toBe(20);
  });
});

describe("selectTool: dragging the corner handle", () => {
  it("rounds the rectangle live and commits one op, one undo step", () => {
    const tool = createSelectTool();
    const c = ctx();
    tool.onPointerDown!(at(114, 114), c);
    expect(useScene.getState().selection).toEqual(["r"]); // the handle did not start a marquee or change the selection
    tool.onPointerMove!(at(130, 130), c);
    expect(radiusOf("r")).toBe(30); // previewed
    expect(sync.sent).toHaveLength(0); // nothing on the wire yet
    tool.onPointerMove!(at(140, 140), c);
    tool.onPointerUp!(at(140, 140), c);
    expect(radiusOf("r")).toBe(40);
    expect(sync.sent).toHaveLength(1);
    expect(useScene.getState().undoStack).toHaveLength(1);
    useScene.getState().undo();
    expect(radiusOf("r")).toBe(0);
  });

  it("a click on the handle that does not move writes nothing", () => {
    const tool = createSelectTool();
    const c = ctx();
    tool.onPointerDown!(at(114, 114), c);
    tool.onPointerUp!(at(114, 114), c);
    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().undoStack).toHaveLength(0);
  });

  it("Escape puts the radius back", () => {
    const tool = createSelectTool();
    const c = ctx();
    tool.onPointerDown!(at(114, 114), c);
    tool.onPointerMove!(at(150, 150), c);
    expect(radiusOf("r")).toBe(50);
    tool.onKeyDown!({ key: "Escape", preventDefault: vi.fn() } as unknown as KeyboardEvent, c);
    expect(radiusOf("r")).toBe(0);
    expect(sync.sent).toHaveLength(0);
  });

  it("a press elsewhere does not touch the radius", () => {
    const tool = createSelectTool();
    const c = ctx();
    tool.onPointerDown!(at(250, 180), c); // inside the rectangle, away from the handle: a normal move drag
    tool.onPointerUp!(at(250, 180), c);
    expect(radiusOf("r")).toBe(0);
  });
});
