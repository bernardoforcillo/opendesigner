import { describe, it, expect } from "vitest";
import {
  drawOverlay,
  selectionWorldBounds,
  worldBoundsToScreen,
  handlePositions,
  HANDLE_SIZE,
} from "./overlayRenderer";
import { emptyScene } from "../store/types";
import type { NodeLite } from "../store/types";
import type { Camera } from "../canvas/camera";

function rect(id: string, x: number, y: number, w = 50, h = 50): NodeLite {
  return {
    id, parentId: "page1", orderKey: "a0", name: id, visible: true, opacity: 1,
    x, y, width: w, height: h, rotation: 0, fills: [], kind: "rect", cornerRadius: 0,
  };
}

const identityCam: Camera = { x: 0, y: 0, zoom: 1 };

// La geometria è estratta apposta per essere testabile senza ctx/DOM (non c'è
// jsdom/canvas in questo progetto, vedi renderer/canvasRenderer.test.ts).
describe("selectionWorldBounds", () => {
  it("returns null for an empty selection (nothing to draw)", () => {
    const s = emptyScene("d", "n");
    s.nodes["a"] = rect("a", 0, 0);
    expect(selectionWorldBounds(s, [])).toBeNull();
  });

  it("returns null when the selection references ids no longer in the scene", () => {
    const s = emptyScene("d", "n");
    expect(selectionWorldBounds(s, ["ghost"])).toBeNull();
  });

  it("is the union of the bounds of the selected nodes (via unionBounds)", () => {
    const s = emptyScene("d", "n");
    s.nodes["a"] = rect("a", 0, 0, 50, 50);
    s.nodes["b"] = rect("b", 100, 100, 50, 50);
    expect(selectionWorldBounds(s, ["a", "b"])).toEqual({ x: 0, y: 0, width: 150, height: 150 });
  });

  it("ignores selected ids that no longer exist while keeping the rest", () => {
    const s = emptyScene("d", "n");
    s.nodes["a"] = rect("a", 0, 0, 50, 50);
    expect(selectionWorldBounds(s, ["a", "ghost"])).toEqual({ x: 0, y: 0, width: 50, height: 50 });
  });
});

describe("worldBoundsToScreen", () => {
  it("scales and offsets bounds by the camera, matching worldToScreen on both corners", () => {
    const cam: Camera = { x: 10, y: 20, zoom: 2 };
    expect(worldBoundsToScreen({ x: 0, y: 0, width: 50, height: 50 }, cam))
      .toEqual({ x: 10, y: 20, width: 100, height: 100 });
  });

  it("is the identity at zoom 1 / camera at origin", () => {
    expect(worldBoundsToScreen({ x: 5, y: 5, width: 10, height: 10 }, identityCam))
      .toEqual({ x: 5, y: 5, width: 10, height: 10 });
  });
});

describe("handlePositions", () => {
  it("places the 8 handles at the corners and edge midpoints of the box", () => {
    const positions = handlePositions({ x: 0, y: 0, width: 100, height: 50 });
    expect(positions.nw).toEqual({ x: 0, y: 0 });
    expect(positions.n).toEqual({ x: 50, y: 0 });
    expect(positions.ne).toEqual({ x: 100, y: 0 });
    expect(positions.e).toEqual({ x: 100, y: 25 });
    expect(positions.se).toEqual({ x: 100, y: 50 });
    expect(positions.s).toEqual({ x: 50, y: 50 });
    expect(positions.sw).toEqual({ x: 0, y: 50 });
    expect(positions.w).toEqual({ x: 0, y: 25 });
    expect(Object.keys(positions)).toHaveLength(8);
  });
});

// ctx finto che registra solo i NOMI delle chiamate: smoke test per verificare
// che drawOverlay invochi le API canvas attese senza crashare, senza dover
// verificare i pixel esatti (nessun canvas reale in Node qui).
function fakeCtx(width: number, height: number) {
  const calls: string[] = [];
  const ctx: Record<string, unknown> = {
    canvas: { width, height },
    setTransform: (..._a: unknown[]) => { calls.push("setTransform"); },
    clearRect: (..._a: unknown[]) => { calls.push("clearRect"); },
    strokeRect: (..._a: unknown[]) => { calls.push("strokeRect"); },
    fillRect: (..._a: unknown[]) => { calls.push("fillRect"); },
    lineWidth: 0,
    strokeStyle: "",
    fillStyle: "",
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

describe("drawOverlay smoke test", () => {
  it("clears the canvas but draws nothing else when there is no selection and no marquee", () => {
    const s = emptyScene("d", "n");
    const { ctx, calls } = fakeCtx(800, 600);
    drawOverlay(ctx, s, identityCam, [], null);
    expect(calls).toContain("clearRect");
    expect(calls).not.toContain("strokeRect");
    expect(calls).not.toContain("fillRect");
  });

  it("draws the bbox border and 8 handle squares when there is a selection", () => {
    const s = emptyScene("d", "n");
    s.nodes["a"] = rect("a", 0, 0);
    const { ctx, calls } = fakeCtx(800, 600);
    drawOverlay(ctx, s, identityCam, ["a"], null);
    expect(calls.filter((c) => c === "fillRect")).toHaveLength(8); // una per maniglia
    expect(calls.filter((c) => c === "strokeRect")).toHaveLength(9); // 1 bbox + 8 bordi maniglia
  });

  it("draws nothing for a selection whose ids no longer exist in the scene", () => {
    const s = emptyScene("d", "n");
    const { ctx, calls } = fakeCtx(800, 600);
    drawOverlay(ctx, s, identityCam, ["ghost"], null);
    expect(calls).not.toContain("strokeRect");
    expect(calls).not.toContain("fillRect");
  });

  it("draws the marquee rectangle (fill + stroke) when set, even without a selection", () => {
    const s = emptyScene("d", "n");
    const { ctx, calls } = fakeCtx(800, 600);
    drawOverlay(ctx, s, identityCam, [], { x: 0, y: 0, width: 50, height: 50 });
    expect(calls.filter((c) => c === "strokeRect")).toHaveLength(1);
    expect(calls.filter((c) => c === "fillRect")).toHaveLength(1);
  });

  it("draws both the selection bbox/handles and the marquee together", () => {
    const s = emptyScene("d", "n");
    s.nodes["a"] = rect("a", 0, 0);
    const { ctx, calls } = fakeCtx(800, 600);
    drawOverlay(ctx, s, identityCam, ["a"], { x: 200, y: 200, width: 20, height: 20 });
    expect(calls.filter((c) => c === "strokeRect")).toHaveLength(10); // 9 selezione + 1 marquee
    expect(calls.filter((c) => c === "fillRect")).toHaveLength(9); // 8 maniglie + 1 marquee
  });

  it("HANDLE_SIZE is exported and used to size the handle squares (8px, constant regardless of zoom)", () => {
    expect(HANDLE_SIZE).toBe(8);
  });
});
