import { describe, it, expect } from "vitest";
import {
  SNAP_THRESHOLD_PX,
  snapAxis,
  snapBounds,
  snapLines,
  snapMoving,
  snapTargets,
  worldThreshold,
} from "./snap";
import { emptyScene } from "../store/types";
import type { NodeLite, SceneState } from "../store/types";

function node(over: Partial<NodeLite> & { id: string }): NodeLite {
  return {
    parentId: "page1", orderKey: "a0", name: "n", visible: true, opacity: 1,
    x: 0, y: 0, width: 10, height: 10, rotation: 0,
    fills: [], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false,
    ...over,
  };
}

function sceneWith(nodes: NodeLite[]): SceneState {
  const s = emptyScene("d", "n");
  for (const n of nodes) s.nodes[n.id] = n;
  return s;
}

// --- LA DECISIONE, NUDA ------------------------------------------------------
// snapAxis è la funzione dove vivono gli errori di un pixel: candidati dentro,
// scelta fuori, nessun DOM, nessuna camera.

describe("snapAxis", () => {
  it("returns null when nothing is within the threshold", () => {
    expect(snapAxis([0], [10], 5)).toBeNull();
  });

  it("snaps to the nearest line and reports where the guide goes", () => {
    expect(snapAxis([100], [103], 5)).toEqual({ delta: 3, positions: [103] });
  });

  it("snaps backwards as happily as forwards", () => {
    expect(snapAxis([100], [97], 5)).toEqual({ delta: -3, positions: [97] });
  });

  it("includes the threshold itself and excludes anything past it", () => {
    expect(snapAxis([0], [5], 5)).toEqual({ delta: 5, positions: [5] });
    expect(snapAxis([0], [5.000001], 5)).toBeNull();
  });

  it("prefers the closest candidate, not the first", () => {
    expect(snapAxis([0], [4, 1, 3], 5)).toEqual({ delta: 1, positions: [1] });
  });

  it("breaks an exact tie deterministically, whatever the input order", () => {
    // 95 e 105 sono equidistanti da 100: vince il delta minore (-5), e la
    // scelta non dipende da come i candidati sono ordinati.
    expect(snapAxis([100], [95, 105], 5)).toEqual({ delta: -5, positions: [95] });
    expect(snapAxis([100], [105, 95], 5)).toEqual({ delta: -5, positions: [95] });
  });

  it("considers every moving line, not just the first", () => {
    // Il bordo sinistro (0) non ha nulla vicino; il destro (10) sì.
    expect(snapAxis([0, 5, 10], [12], 3)).toEqual({ delta: 2, positions: [12] });
  });

  it("reports every line the winning delta lands on", () => {
    // Un solo delta (+2) allinea il bordo sinistro a 2 E il destro a 12: due
    // guide, non una.
    expect(snapAxis([0, 10], [2, 12], 3)).toEqual({ delta: 2, positions: [2, 12] });
  });

  it("does not snap at all with a zero threshold unless it is already exact", () => {
    expect(snapAxis([0], [1], 0)).toBeNull();
    expect(snapAxis([0], [0], 0)).toEqual({ delta: 0, positions: [0] });
  });
});

describe("snapLines", () => {
  it("gives min, centre and max on each axis", () => {
    const b = { x: 10, y: 20, width: 100, height: 40 };
    expect(snapLines(b, "x")).toEqual([10, 60, 110]);
    expect(snapLines(b, "y")).toEqual([20, 40, 60]);
  });
});

// --- LA SOGLIA È IN PIXEL SCHERMO -------------------------------------------

describe("worldThreshold", () => {
  it("shrinks in world units as the camera zooms in", () => {
    expect(worldThreshold({ x: 0, y: 0, zoom: 1 })).toBe(SNAP_THRESHOLD_PX);
    expect(worldThreshold({ x: 0, y: 0, zoom: 2 })).toBe(SNAP_THRESHOLD_PX / 2);
    expect(worldThreshold({ x: 0, y: 0, zoom: 0.5 })).toBe(SNAP_THRESHOLD_PX * 2);
  });
});

// --- DAL RETTANGOLO ALLA GUIDA ----------------------------------------------

describe("snapBounds", () => {
  const target = { x: 0, y: 0, width: 100, height: 100 };

  it("returns a zero delta and no guide when nothing is near", () => {
    const r = snapBounds({ x: 500, y: 500, width: 10, height: 10 }, [target], 4);
    expect(r).toEqual({ dx: 0, dy: 0, guides: [] });
  });

  it("snaps the left edge to the target's left edge", () => {
    const r = snapBounds({ x: 3, y: 500, width: 10, height: 10 }, [target], 4);
    expect(r.dx).toBe(-3);
    expect(r.dy).toBe(0);
    expect(r.guides).toEqual([{ axis: "x", pos: 0, from: 0, to: 510 }]);
  });

  it("snaps centre to centre", () => {
    // centro del bersaglio: 50. Box largo 20 centrato a 52 -> delta -2.
    const r = snapBounds({ x: 42, y: 0, width: 20, height: 100 }, [target], 4);
    expect(r.dx).toBe(-2);
    expect(r.guides.some((g) => g.axis === "x" && g.pos === 50)).toBe(true);
  });

  it("snaps both axes independently in one call", () => {
    // Il bordo destro (112) scatta a 100 e il bordo alto (-3) a 0. Il box è
    // alto 60 apposta: con un box quadrato sarebbe il suo CENTRO (a 2) a
    // vincere sull'asse y, che è corretto ma non è il caso che serve qui.
    const r = snapBounds({ x: 102, y: -3, width: 10, height: 60 }, [target], 4);
    expect(r).toMatchObject({ dx: -2, dy: 3 });
    expect(r.guides.map((g) => g.axis)).toEqual(["x", "y"]);
  });

  it("lets a CENTRE snap to an edge — the six lines all play in the same pool", () => {
    // Box alto 10 con il bordo alto a -3 (distanza 3 dal bordo 0) e il centro a
    // 2 (distanza 2): vince il centro.
    expect(snapBounds({ x: 500, y: -3, width: 10, height: 10 }, [target], 4).dy).toBe(-2);
  });

  it("spans the guide across the moving box and every node it lines up with", () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    const b = { x: 0, y: 200, width: 10, height: 10 };
    const r = snapBounds({ x: 1, y: 90, width: 30, height: 10 }, [a, b], 4);
    // La guida verticale a x=0 tocca entrambi i bersagli e il box mosso:
    // dall'alto di `a` (0) al fondo di `b` (210).
    expect(r.guides).toEqual([{ axis: "x", pos: 0, from: 0, to: 210 }]);
  });

  it("draws all three lines when a box of the same width lands on another", () => {
    // Larghezze uguali: lo stesso scatto allinea sinistra, centro E destra.
    // Sono tre allineamenti veri e ognuno merita la sua guida.
    const r = snapBounds({ x: 1, y: 90, width: 10, height: 10 }, [{ x: 0, y: 0, width: 10, height: 10 }], 4);
    expect(r.dx).toBe(-1);
    expect(r.guides.map((g) => g.pos)).toEqual([0, 5, 10]);
  });

  it("ignores an empty target list", () => {
    expect(snapBounds({ x: 1, y: 1, width: 10, height: 10 }, [], 4)).toEqual({ dx: 0, dy: 0, guides: [] });
  });
});

describe("snapMoving", () => {
  const target = { x: 0, y: 0, width: 100, height: 100 };

  it("snaps only the lines it is given — a lone right edge", () => {
    const box = { x: 50, y: 200, width: 52, height: 10 };
    // Solo il bordo destro (102) può scattare: il sinistro (50) e il centro
    // (76) restano fermi anche se avessero un candidato vicino.
    const r = snapMoving(box, { x: [box.x + box.width], y: [] }, [target], 4);
    expect(r).toMatchObject({ dx: -2, dy: 0 });
    expect(r.guides).toEqual([{ axis: "x", pos: 100, from: 0, to: 210 }]);
  });

  it("does nothing when no line is offered", () => {
    expect(snapMoving({ x: 1, y: 1, width: 10, height: 10 }, { x: [], y: [] }, [target], 4))
      .toEqual({ dx: 0, dy: 0, guides: [] });
  });
});

// --- I BERSAGLI --------------------------------------------------------------

describe("snapTargets", () => {
  it("takes every visible node except the ones being moved", () => {
    const scene = sceneWith([
      node({ id: "a", x: 0, y: 0 }),
      node({ id: "b", x: 50, y: 50 }),
      node({ id: "c", x: 90, y: 90, visible: false }),
    ]);
    expect(snapTargets(scene, ["a"])).toEqual([{ x: 50, y: 50, width: 10, height: 10 }]);
  });

  it("uses the AXIS-ALIGNED bounding box of a rotated node", () => {
    // Un quadrato 10x10 a 45° ha un AABB di lato 10*sqrt(2) attorno allo stesso
    // centro: è QUELLO che fa da bersaglio, non i suoi lati inclinati.
    const scene = sceneWith([node({ id: "r", x: 0, y: 0, width: 10, height: 10, rotation: 45 })]);
    const [t] = snapTargets(scene, []);
    const side = 10 * Math.SQRT2;
    expect(t.width).toBeCloseTo(side, 10);
    expect(t.height).toBeCloseTo(side, 10);
    expect(t.x).toBeCloseTo(5 - side / 2, 10);
  });

  it("ignores the stroke overhang — the snap follows the geometry", () => {
    const scene = sceneWith([
      node({ id: "s", x: 0, y: 0, strokes: [{ color: { r: 0, g: 0, b: 0, a: 1 }, weight: 20, align: "outside" }] }),
    ]);
    expect(snapTargets(scene, [])).toEqual([{ x: 0, y: 0, width: 10, height: 10 }]);
  });

  it("returns an empty list when everything is selected", () => {
    const scene = sceneWith([node({ id: "a" })]);
    expect(snapTargets(scene, ["a"])).toEqual([]);
  });
});
