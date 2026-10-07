import { describe, it, expect } from "vitest";
import {
  SNAP_THRESHOLD_PX,
  snapAxis,
  snapBounds,
  snapLines,
  snapMoving,
  snapTargets,
  spacingSnap,
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
  for (const n of nodes) s.nodes = s.nodes.set(n.id, n);
  return s;
}

// --- THE DECISION, BARE ------------------------------------------------------
// snapAxis is the function where one-pixel errors live: candidates in,
// choice out, no DOM, no camera.

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
    // 95 and 105 are equidistant from 100: the smaller delta (-5) wins, and the
    // choice does not depend on how the candidates are ordered.
    expect(snapAxis([100], [95, 105], 5)).toEqual({ delta: -5, positions: [95] });
    expect(snapAxis([100], [105, 95], 5)).toEqual({ delta: -5, positions: [95] });
  });

  it("considers every moving line, not just the first", () => {
    // The left edge (0) has nothing near; the right one (10) does.
    expect(snapAxis([0, 5, 10], [12], 3)).toEqual({ delta: 2, positions: [12] });
  });

  it("reports every line the winning delta lands on", () => {
    // A single delta (+2) aligns the left edge to 2 AND the right to 12: two
    // guides, not one.
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

// --- THE THRESHOLD IS IN SCREEN PIXELS --------------------------------------

describe("worldThreshold", () => {
  it("shrinks in world units as the camera zooms in", () => {
    expect(worldThreshold({ x: 0, y: 0, zoom: 1 })).toBe(SNAP_THRESHOLD_PX);
    expect(worldThreshold({ x: 0, y: 0, zoom: 2 })).toBe(SNAP_THRESHOLD_PX / 2);
    expect(worldThreshold({ x: 0, y: 0, zoom: 0.5 })).toBe(SNAP_THRESHOLD_PX * 2);
  });
});

// --- FROM THE RECTANGLE TO THE GUIDE ----------------------------------------

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
    // target center: 50. A 20-wide box centered at 52 -> delta -2.
    const r = snapBounds({ x: 42, y: 0, width: 20, height: 100 }, [target], 4);
    expect(r.dx).toBe(-2);
    expect(r.guides.some((g) => g.axis === "x" && g.pos === 50)).toBe(true);
  });

  it("snaps both axes independently in one call", () => {
    // The right edge (112) snaps to 100 and the top edge (-3) to 0. The box is
    // 60 tall on purpose: with a square box it would be its CENTER (at 2)
    // winning on the y axis, which is correct but is not the case needed here.
    const r = snapBounds({ x: 102, y: -3, width: 10, height: 60 }, [target], 4);
    expect(r).toMatchObject({ dx: -2, dy: 3 });
    expect(r.guides.map((g) => g.axis)).toEqual(["x", "y"]);
  });

  it("lets a CENTRE snap to an edge — the six lines all play in the same pool", () => {
    // Box 10 tall with the top edge at -3 (distance 3 from edge 0) and the center at
    // 2 (distance 2): the center wins.
    expect(snapBounds({ x: 500, y: -3, width: 10, height: 10 }, [target], 4).dy).toBe(-2);
  });

  it("spans the guide across the moving box and every node it lines up with", () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    const b = { x: 0, y: 200, width: 10, height: 10 };
    const r = snapBounds({ x: 1, y: 90, width: 30, height: 10 }, [a, b], 4);
    // The vertical guide at x=0 touches both targets and the moved box:
    // from the top of `a` (0) to the bottom of `b` (210).
    expect(r.guides).toEqual([{ axis: "x", pos: 0, from: 0, to: 210 }]);
  });

  it("draws all three lines when a box of the same width lands on another", () => {
    // Equal widths: the same snap aligns left, center AND right.
    // They are three real alignments and each deserves its own guide.
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
    // Only the right edge (102) can snap: the left (50) and the center
    // (76) stay still even if they had a nearby candidate.
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
    // A 10x10 square at 45° has an AABB of side 10*sqrt(2) around the same
    // center: THAT is what serves as the target, not its slanted sides.
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

describe("spacingSnap", () => {
  const b = (x: number, y: number, w = 20, h = 20) => ({ x, y, width: w, height: h });

  it("centers a box between two neighbors (equal gaps)", () => {
    // left neighbor ends at 20, right starts at 100: free space 80, box 20 wide -> 30 each side -> x = 50
    const r = spacingSnap(b(53, 0), [b(0, 0), b(100, 0)], 6);
    expect(r.dx).toBe(-3);
    expect(r.guides).toEqual([
      { axis: "x", from: 20, to: 50, at: 10 },
      { axis: "x", from: 70, to: 100, at: 10 },
    ]);
  });

  it("repeats the gap the neighbors beside it already have", () => {
    // A (0..20), B (40..60): gap 20. A box dragged to the right of B lands at 80 (gap 20).
    const r = spacingSnap(b(83, 0), [b(0, 0), b(40, 0)], 6);
    expect(r.dx).toBe(-3);
    expect(r.guides[1]).toEqual({ axis: "x", from: 60, to: 80, at: 10 });
    // and on the left of A: the box ends 20 before A
    const l = spacingSnap(b(-42, 0), [b(0, 0), b(40, 0)], 6);
    expect(l.dx).toBe(2); // target x = 0 - 20 - 20 = -40
  });

  it("works on the vertical axis too, and only looks at neighbors the box faces", () => {
    const r = spacingSnap(b(0, 52), [b(0, 0), b(0, 100)], 6);
    expect(r.dy).toBe(-2);
    // A node that does not overlap the box on the other axis is not a neighbor.
    expect(spacingSnap(b(53, 0), [b(0, 500), b(100, 500)], 6)).toEqual({ dx: 0, dy: 0, guides: [] });
  });

  it("does nothing beyond the threshold or with one neighbor", () => {
    expect(spacingSnap(b(60, 0), [b(0, 0), b(100, 0)], 6).dx).toBe(0); // 10 away from equal gaps
    expect(spacingSnap(b(50, 0), [b(0, 0)], 6)).toEqual({ dx: 0, dy: 0, guides: [] });
  });
});
