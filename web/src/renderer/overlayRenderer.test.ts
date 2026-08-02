import { describe, it, expect } from "vitest";
import {
  drawOverlay,
  selectionFrame,
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

  it("takes each node's ROTATION into account: the union is of what they really occupy", () => {
    const s = emptyScene("d", "n");
    // 100x50 in (0,0) ruotato di 90°: occupa davvero x in [25,75], y in [-25,75]
    s.nodes["a"] = { ...rect("a", 0, 0, 100, 50), rotation: 90 };
    const u = selectionWorldBounds(s, ["a"])!;
    expect(u.x).toBeCloseTo(25, 9);
    expect(u.y).toBeCloseTo(-25, 9);
    expect(u.width).toBeCloseTo(50, 9);
    expect(u.height).toBeCloseTo(100, 9);
  });
});

// Il FRAME della selezione: il rettangolo su cui vivono le maniglie PIÙ il suo
// angolo. La convenzione è dichiarata qui e vale ovunque: un nodo solo porta la
// PROPRIA rotazione, una selezione multipla è ASSE-ALLINEATA (non esiste un
// angolo comune a nodi ruotati diversamente).
describe("selectionFrame", () => {
  it("is null when there is nothing to frame", () => {
    const s = emptyScene("d", "n");
    expect(selectionFrame(s, [])).toBeNull();
    expect(selectionFrame(s, ["ghost"])).toBeNull();
  });

  it("a single node hands over its own bounds and its own rotation", () => {
    const s = emptyScene("d", "n");
    s.nodes["a"] = { ...rect("a", 10, 20, 100, 50), rotation: 30 };
    expect(selectionFrame(s, ["a"])).toEqual({
      bounds: { x: 10, y: 20, width: 100, height: 50 },
      rotation: 30,
    });
  });

  it("a multiple selection is axis-aligned, around what the nodes really occupy", () => {
    const s = emptyScene("d", "n");
    s.nodes["a"] = { ...rect("a", 0, 0, 100, 50), rotation: 90 }; // x [25,75], y [-25,75]
    s.nodes["b"] = rect("b", 100, 100, 50, 50);
    const f = selectionFrame(s, ["a", "b"])!;
    expect(f.rotation).toBe(0);
    expect(f.bounds.x).toBeCloseTo(25, 9);
    expect(f.bounds.y).toBeCloseTo(-25, 9);
    expect(f.bounds.width).toBeCloseTo(125, 9);
    expect(f.bounds.height).toBeCloseTo(175, 9);
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
  // Le chiamate di trasformazione con i loro argomenti: servono al caso
  // ruotato, dove ciò che conta non è QUANTE volte si disegna ma ATTORNO A
  // COSA (il centro del riquadro, in px schermo).
  const xform: { op: string; args: number[] }[] = [];
  const record = (op: string) => (...args: number[]) => { calls.push(op); xform.push({ op, args }); };
  const ctx: Record<string, unknown> = {
    canvas: { width, height },
    setTransform: (..._a: unknown[]) => { calls.push("setTransform"); },
    clearRect: (..._a: unknown[]) => { calls.push("clearRect"); },
    strokeRect: (..._a: unknown[]) => { calls.push("strokeRect"); },
    fillRect: (..._a: unknown[]) => { calls.push("fillRect"); },
    save: record("save"),
    restore: record("restore"),
    translate: record("translate"),
    rotate: record("rotate"),
    lineWidth: 0,
    strokeStyle: "",
    fillStyle: "",
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, xform };
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

  it("turns the whole selection frame -- border AND handles -- with the node's rotation", () => {
    const s = emptyScene("d", "n");
    // box (0,0) 100x50 -> centro schermo (50, 25) a camera identità
    s.nodes["a"] = { ...rect("a", 0, 0, 100, 50), rotation: 90 };
    const { ctx, calls, xform } = fakeCtx(800, 600);
    drawOverlay(ctx, s, identityCam, ["a"], null);

    expect(xform.map((e) => e.op)).toEqual(["save", "translate", "rotate", "translate", "restore"]);
    expect(xform[1].args).toEqual([50, 25]);
    expect(xform[2].args[0]).toBeCloseTo(Math.PI / 2, 12);
    expect(xform[3].args).toEqual([-50, -25]);
    // il riquadro e le 8 maniglie si disegnano come sempre: a ruotare è il
    // contesto, non la loro geometria
    expect(calls.filter((c) => c === "fillRect")).toHaveLength(8);
    expect(calls.filter((c) => c === "strokeRect")).toHaveLength(9);
    // e la trasformazione è chiusa PRIMA di ogni altra cosa
    expect(calls.indexOf("restore")).toBeGreaterThan(calls.lastIndexOf("strokeRect"));
  });

  it("leaves the marquee out of the rotation", () => {
    const s = emptyScene("d", "n");
    s.nodes["a"] = { ...rect("a", 0, 0, 100, 50), rotation: 90 };
    const { ctx, calls } = fakeCtx(800, 600);
    drawOverlay(ctx, s, identityCam, ["a"], { x: 200, y: 200, width: 20, height: 20 });
    // le ultime due chiamate di disegno (fill + stroke del marquee) stanno DOPO
    // il restore: il rettangolo di selezione è sempre asse-allineato
    expect(calls.lastIndexOf("fillRect")).toBeGreaterThan(calls.indexOf("restore"));
    expect(calls.lastIndexOf("strokeRect")).toBeGreaterThan(calls.indexOf("restore"));
  });

  it("emits no transform for an unrotated selection", () => {
    const s = emptyScene("d", "n");
    s.nodes["a"] = rect("a", 0, 0);
    const { ctx, xform } = fakeCtx(800, 600);
    drawOverlay(ctx, s, identityCam, ["a"], null);
    expect(xform).toEqual([]);
  });
});
