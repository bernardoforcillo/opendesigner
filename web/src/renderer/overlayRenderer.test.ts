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
    x, y, width: w, height: h, rotation: 0, fills: [], kind: "rect", cornerRadius: 0, clipsContent: false,
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

  it("puts a nested node's box where the node is drawn: MONDO, not local", () => {
    // page1 > g(100,50) > h(10,20) > k(3,4): il box di "k" nel mondo parte a
    // (113,74). Il bbox della selezione è disegnato in spazio schermo a partire
    // da qui: se restasse locale, la cornice comparirebbe lontanissima dal nodo.
    const s = emptyScene("d", "n");
    s.nodes["g"] = { ...rect("g", 100, 50, 400, 400), parentId: "page1" };
    s.nodes["h"] = { ...rect("h", 10, 20, 200, 200), parentId: "g" };
    s.nodes["k"] = { ...rect("k", 3, 4, 50, 50), parentId: "h" };
    expect(selectionWorldBounds(s, ["k"])).toEqual({ x: 113, y: 74, width: 50, height: 50 });
    // Unione di due nodi a profondità DIVERSE: entrambi in coordinate mondo.
    expect(selectionWorldBounds(s, ["g", "k"])).toEqual({ x: 100, y: 50, width: 400, height: 400 });
  });

  // Un gruppo non ha un box proprio: leggerlo darebbe un rettangolo 0x0
  // all'origine, cioè cornice e maniglie nell'angolo sbagliato dello schermo
  // per un gruppo che si vede benissimo (vedi store/groups.ts).
  it("for a group it is the union of its CHILDREN, translated by the group", () => {
    const s = emptyScene("d", "n");
    s.nodes["g"] = { ...rect("g", 0, 0, 0, 0), kind: "group" };
    s.nodes["c1"] = { ...rect("c1", 10, 10, 50, 50), parentId: "g" };
    s.nodes["c2"] = { ...rect("c2", 100, 0, 20, 20), parentId: "g" };
    expect(selectionWorldBounds(s, ["g"])).toEqual({ x: 10, y: 0, width: 110, height: 60 });

    // Trascinato il gruppo, la cornice lo segue: la sua x/y è la traslazione
    // dei figli.
    s.nodes["g"] = { ...s.nodes["g"], x: 5, y: 7 };
    expect(selectionWorldBounds(s, ["g"])).toEqual({ x: 15, y: 7, width: 110, height: 60 });
  });

  it("skips an empty group instead of framing its origin", () => {
    const s = emptyScene("d", "n");
    s.nodes["g"] = { ...rect("g", 300, 300, 0, 0), kind: "group" };
    s.nodes["a"] = rect("a", 0, 0, 50, 50);
    expect(selectionWorldBounds(s, ["g"])).toBeNull();
    expect(selectionWorldBounds(s, ["a", "g"])).toEqual({ x: 0, y: 0, width: 50, height: 50 });
  });

  // Il renderer salta un nodo invisibile e tutto il suo sottoalbero
  // (canvasRenderer.ts): la cornice della selezione deve misurare LA STESSA
  // geometria, o cornice e maniglie si allungano su canvas vuoto -- la
  // divergenza vedi-vs-seleziona, presa dal lato dell'overlay.
  function groupWithHiddenChild() {
    const s = emptyScene("d", "n");
    s.nodes["g"] = { ...rect("g", 0, 0, 0, 0), kind: "group" };
    s.nodes["c1"] = { ...rect("c1", 10, 10, 50, 50), parentId: "g", visible: false };
    s.nodes["c2"] = { ...rect("c2", 100, 0, 20, 20), parentId: "g" };
    return s;
  }

  it("a group frames only its VISIBLE children: a hidden one does not stretch the box", () => {
    const s = groupWithHiddenChild();
    // Con c1 (nascosto) dentro l'unione sarebbe {10,0,110,60}.
    expect(selectionWorldBounds(s, ["g"])).toEqual({ x: 100, y: 0, width: 20, height: 20 });
  });

  it("the 8 handles sit on the visible content, not around empty canvas", () => {
    const s = groupWithHiddenChild();
    const box = worldBoundsToScreen(selectionWorldBounds(s, ["g"])!, identityCam);
    const p = handlePositions(box);
    // Il box visibile è (100,0)-(120,20): ogni maniglia ci sta sopra.
    expect(p.nw).toEqual({ x: 100, y: 0 });
    expect(p.se).toEqual({ x: 120, y: 20 });
    expect(p.n).toEqual({ x: 110, y: 0 });
    expect(p.w).toEqual({ x: 100, y: 10 });
    // Nessuna maniglia sul figlio nascosto (che vive a sinistra, da x=10).
    for (const q of Object.values(p)) expect(q.x).toBeGreaterThanOrEqual(100);
  });

  it("a group whose children are ALL hidden behaves like an empty one: no frame at all", () => {
    const s = groupWithHiddenChild();
    s.nodes["c2"] = { ...s.nodes["c2"], visible: false };
    expect(selectionWorldBounds(s, ["g"])).toBeNull();
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

  it("draws nothing for a group whose children are all hidden: it is an empty group", () => {
    const s = emptyScene("d", "n");
    s.nodes["g"] = { ...rect("g", 0, 0, 0, 0), kind: "group" };
    s.nodes["c"] = { ...rect("c", 10, 10, 50, 50), parentId: "g", visible: false };
    const { ctx, calls } = fakeCtx(800, 600);
    drawOverlay(ctx, s, identityCam, ["g"], null);
    expect(calls).not.toContain("strokeRect"); // né cornice né bordi delle maniglie
    expect(calls).not.toContain("fillRect");
  });

  it("HANDLE_SIZE is exported and used to size the handle squares (8px, constant regardless of zoom)", () => {
    expect(HANDLE_SIZE).toBe(8);
  });
});
