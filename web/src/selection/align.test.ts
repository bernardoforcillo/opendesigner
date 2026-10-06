import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  ALIGN_COMMANDS,
  alignDelta,
  alignOps,
  alignSelection,
  alignTarget,
  distributeDeltas,
  minSelection,
} from "./align";
import type { AlignKind } from "./align";
import { useScene } from "../store/store";
import { emptyScene } from "../store/types";
import type { NodeLite, SceneState } from "../store/types";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";

function node(over: Partial<NodeLite> & { id: string }): NodeLite {
  return {
    parentId: "page1", orderKey: "a0", name: over.id, visible: true, opacity: 1,
    x: 0, y: 0, width: 10, height: 10, rotation: 0,
    fills: [], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false,
    ...over,
  };
}

function sceneWith(nodes: NodeLite[]): SceneState {
  const s = emptyScene("doc-1", "u");
  for (const n of nodes) s.nodes = s.nodes.set(n.id, n);
  return s;
}

// Double of the transport (as in tools/selectTool.test.ts): records the ops that
// end up on the wire and confirms them immediately.
class FakeSync {
  sent: Op[] = [];
  submit(op: Op) {
    this.sent.push(op);
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
}

const B = { x: 10, y: 20, width: 100, height: 40 };
const TARGET = { x: 0, y: 0, width: 200, height: 200 };

describe("alignDelta", () => {
  it("left / right put the matching edge on the target's edge", () => {
    expect(alignDelta(B, TARGET, "left")).toEqual({ dx: -10, dy: 0 });
    expect(alignDelta(B, TARGET, "right")).toEqual({ dx: 90, dy: 0 });
  });

  it("top / bottom do the same vertically", () => {
    expect(alignDelta(B, TARGET, "top")).toEqual({ dx: 0, dy: -20 });
    expect(alignDelta(B, TARGET, "bottom")).toEqual({ dx: 0, dy: 140 });
  });

  it("centres put centre on centre", () => {
    // center of B: (60, 40); center of the target: (100, 100).
    expect(alignDelta(B, TARGET, "hcenter")).toEqual({ dx: 40, dy: 0 });
    expect(alignDelta(B, TARGET, "middle")).toEqual({ dx: 0, dy: 60 });
  });

  it("touches ONE axis, always — aligning left never moves anything vertically", () => {
    for (const kind of ["left", "hcenter", "right"] as const) {
      expect(alignDelta(B, TARGET, kind).dy).toBe(0);
    }
    for (const kind of ["top", "middle", "bottom"] as const) {
      expect(alignDelta(B, TARGET, kind).dx).toBe(0);
    }
  });

  it("is a no-op on a box already aligned", () => {
    expect(alignDelta(TARGET, TARGET, "left")).toEqual({ dx: 0, dy: 0 });
    expect(alignDelta(TARGET, TARGET, "middle")).toEqual({ dx: 0, dy: 0 });
  });
});

describe("distributeDeltas", () => {
  it("leaves fewer than three boxes alone — there is no gap to equalise", () => {
    const two = [{ x: 0, y: 0, width: 10, height: 10 }, { x: 100, y: 0, width: 10, height: 10 }];
    expect(distributeDeltas(two, "x")).toEqual([{ dx: 0, dy: 0 }, { dx: 0, dy: 0 }]);
    expect(distributeDeltas([], "x")).toEqual([]);
  });

  it("equalises the GAPS and keeps the two extremes where they are", () => {
    // Widths 10/20/10 between 0 and 100: free space 60, two gaps -> 30.
    const boxes = [
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 15, y: 0, width: 20, height: 10 },
      { x: 90, y: 0, width: 10, height: 10 },
    ];
    const d = distributeDeltas(boxes, "x");
    expect(d[0]).toEqual({ dx: 0, dy: 0 });
    expect(d[2]).toEqual({ dx: 0, dy: 0 });
    // The middle box starts at 40 (0 + 10 + 30).
    expect(d[1]).toEqual({ dx: 25, dy: 0 });
  });

  it("works vertically with the same rule", () => {
    const boxes = [
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 0, y: 5, width: 10, height: 10 },
      { x: 0, y: 50, width: 10, height: 10 },
    ];
    // Heights 10/10/10 between 0 and 60: free space 30, two gaps -> 15.
    const d = distributeDeltas(boxes, "y");
    expect(d[0]).toEqual({ dx: 0, dy: 0 });
    expect(d[1]).toEqual({ dx: 0, dy: 20 }); // from 5 to 25 (0 + 10 + 15)
    expect(d[2]).toEqual({ dx: 0, dy: 0 });
  });

  it("does not depend on the order of the list, only on the positions", () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    const b = { x: 15, y: 0, width: 20, height: 10 };
    const c = { x: 90, y: 0, width: 10, height: 10 };
    // Same geometry, shuffled list: every box receives the same delta.
    const straight = distributeDeltas([a, b, c], "x");
    const shuffled = distributeDeltas([c, a, b], "x");
    expect(shuffled).toEqual([straight[2], straight[0], straight[1]]);
  });

  it("equalises even when the boxes overlap (the gap simply goes negative)", () => {
    const boxes = [
      { x: 0, y: 0, width: 40, height: 10 },
      { x: 5, y: 0, width: 40, height: 10 },
      { x: 20, y: 0, width: 40, height: 10 },
    ];
    const d = distributeDeltas(boxes, "x");
    const at = boxes.map((b, i) => b.x + d[i].dx);
    expect(at[1] - at[0]).toBeCloseTo(at[2] - at[1], 10);
  });

  // The two tests below look at the EXACT ZERO of the extremes, which the
  // round-number cases above cannot see: 0/15/90 with widths 10/20/10 makes
  // the math work out even with an accumulator, because every sum is exact in
  // binary. On arbitrary coordinates it does not -- and "almost zero" is not zero for
  // alignOps, which sends an op for it.
  it("keeps the two extremes EXACTLY put, on coordinates that are not round", () => {
    // Case found by brute force: with an accumulated `cursor += size + gap`,
    // the last box (at 969.9) receives -1.1368683772161603e-13 instead of 0.
    const boxes = [
      { x: 969.9, y: 0, width: 31.8, height: 10 },
      { x: 309.3, y: 0, width: 38.7, height: 10 },
      { x: 456.6, y: 0, width: 28.9, height: 10 },
    ];
    const d = distributeDeltas(boxes, "x");
    expect(d[0]).toEqual({ dx: 0, dy: 0 }); // the last one in position order
    expect(d[1]).toEqual({ dx: 0, dy: 0 }); // the first
    expect(d[2].dx).toBeCloseTo(187.9, 10); // the middle one really moves
  });

  it("keeps them exact over thousands of arbitrary layouts, not just the lucky ones", () => {
    // Deterministic PRNG (mulberry32): the test is not random, it is always the
    // SAME battery of layouts -- just chosen so as not to be round.
    let s = 0x2f6e2b1;
    const rnd = () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    // The violations are COLLECTED and asserted once: one expect
    // per round would cost seconds, and the useful error message is the
    // first layout that gets it wrong anyway, not the round number.
    const bad: unknown[] = [];
    for (let iter = 0; iter < 5000; iter++) {
      const n = 3 + Math.floor(rnd() * 4);
      const boxes = Array.from({ length: n }, () => ({
        x: rnd() * 1000, y: rnd() * 1000, width: 1 + rnd() * 200, height: 1 + rnd() * 200,
      }));
      for (const axis of ["x", "y"] as const) {
        const d = distributeDeltas(boxes, axis);
        const min = (b: typeof boxes[number]) => (axis === "x" ? b.x : b.y);
        const order = boxes.map((_, i) => i).sort((a, b) => min(boxes[a]) - min(boxes[b]) || a - b);
        for (const k of [order[0], order[n - 1]]) {
          if (d[k].dx !== 0 || d[k].dy !== 0) bad.push({ axis, boxes, delta: d[k] });
        }
      }
    }
    expect(bad.slice(0, 1)).toEqual([]);
  });
});

describe("alignTarget", () => {
  // A single node aligns AGAINST ITSELF, i.e. does not move. There is
  // no page in the model to align it against, and inventing one would
  // send it where the document is not: see the comment on alignTarget and the
  // "a single node" tests below.
  it("uses the node's OWN box for a single node — there is no page to align it to", () => {
    const scene = sceneWith([node({ id: "a", x: 5, y: 5 })]);
    expect(alignTarget(scene, ["a"])).toEqual({ x: 5, y: 5, width: 10, height: 10 });
  });

  it("uses the common bounding box for several", () => {
    const scene = sceneWith([node({ id: "a", x: 0, y: 0 }), node({ id: "b", x: 90, y: 40 })]);
    expect(alignTarget(scene, ["a", "b"])).toEqual({ x: 0, y: 0, width: 100, height: 50 });
  });

  it("takes the AABB of a rotated node into the common box", () => {
    const scene = sceneWith([
      node({ id: "a", x: 0, y: 0 }),
      node({ id: "r", x: 100, y: 0, width: 10, height: 10, rotation: 45 }),
    ]);
    const t = alignTarget(scene, ["a", "r"])!;
    expect(t.x + t.width).toBeCloseTo(105 + (10 * Math.SQRT2) / 2, 10);
  });

  it("is null for an empty selection", () => {
    expect(alignTarget(sceneWith([]), [])).toBeNull();
  });
});

describe("alignOps", () => {
  it("moves every selected node onto the common edge, and only x/y", () => {
    const scene = sceneWith([
      node({ id: "a", x: 0, y: 0 }),
      node({ id: "b", x: 90, y: 40 }),
    ]);
    const ops = alignOps(scene, ["a", "b"], "left");
    expect(ops).toHaveLength(1); // "a" is already at the left: no op for it
    const v = ops[0].kind.value as { id: string; patch?: { x: number; y: number }; mask?: { paths: string[] } };
    expect(v.id).toBe("b");
    expect(v.patch?.x).toBe(0);
    expect(v.patch?.y).toBe(40);
    expect(v.mask?.paths).toEqual(["x", "y"]);
  });

  it("emits nothing when the selection is already aligned", () => {
    const scene = sceneWith([node({ id: "a", x: 0 }), node({ id: "b", x: 0, y: 50 })]);
    expect(alignOps(scene, ["a", "b"], "left")).toEqual([]);
  });

  it("moves a ROTATED node by the delta of its AABB, leaving the angle alone", () => {
    const side = 10 * Math.SQRT2;
    const scene = sceneWith([
      node({ id: "a", x: 0, y: 0, width: 100, height: 10 }),
      node({ id: "r", x: 50, y: 50, width: 10, height: 10, rotation: 45 }),
    ]);
    const ops = alignOps(scene, ["a", "r"], "left");
    const v = ops[0].kind.value as { id: string; patch?: { x: number; y: number }; mask?: { paths: string[] } };
    expect(v.id).toBe("r");
    // The rotated node's AABB starts at 55 - side/2: bringing it to 0 means
    // writing an x of 50 - (55 - side/2).
    expect(v.patch?.x).toBeCloseTo(50 - (55 - side / 2), 10);
    expect(v.mask?.paths).toEqual(["x", "y"]);
  });

  it("distributes with a single command", () => {
    const scene = sceneWith([
      node({ id: "a", x: 0 }),
      node({ id: "b", x: 15 }),
      node({ id: "c", x: 90 }),
    ]);
    // Widths 10/10/10 between 0 and 100: free space 70, two gaps -> 35.
    const ops = alignOps(scene, ["a", "b", "c"], "distribute-h");
    expect(ops).toHaveLength(1); // the extremes do not move
    const v = ops[0].kind.value as { id: string; patch?: { x: number } };
    expect(v.id).toBe("b");
    expect(v.patch?.x).toBe(45);
  });

  // THE CASE YOU SEE: distribute, then redistribute. The second time the
  // layout is already right, so NOTHING must travel on the wire -- otherwise
  // an undo entry piles up that undoes nothing (the next Ctrl+Z does
  // nothing visible). With the floating-point accumulator the extreme received
  // a delta of -1.1e-13 and the op went out on every click, forever.
  it("emits nothing on a SECOND distribute — and on a third", () => {
    const ids = ["a", "b", "c"];
    const nodes = [
      node({ id: "a", x: 969.9, width: 31.8 }),
      node({ id: "b", x: 309.3, width: 38.7 }),
      node({ id: "c", x: 456.6, width: 28.9 }),
    ];
    let scene = sceneWith(nodes);
    const apply = (ops: Op[]) => {
      const next = sceneWith(ids.map((id) => scene.nodes.at(id)));
      for (const op of ops) {
        const v = op.kind.value as { id: string; patch?: { x: number; y: number } };
        next.nodes = next.nodes.set(v.id, { ...next.nodes.at(v.id), x: v.patch!.x, y: v.patch!.y });
      }
      scene = next;
    };

    const first = alignOps(scene, ids, "distribute-h");
    expect(first).toHaveLength(1); // only the middle one moves
    apply(first);
    expect(alignOps(scene, ids, "distribute-h")).toEqual([]);
    expect(alignOps(scene, ids, "distribute-h")).toEqual([]);
  });

  // A SINGLE NODE DOES NOT MOVE, for NONE of the eight commands.
  //
  // The canvas is INFINITE and the camera starts at {0, 0, zoom: 1}: a document can
  // legitimately live at x = 10000 and there is no 1920x1080 sheet there
  // underneath. Aligning a single rectangle against a rectangle invented
  // at the origin would teleport it off screen -- and since it vanishes
  // from view, it is indistinguishable from "I deleted it by mistake": the only
  // remedy would be guessing a Ctrl+Z.
  describe("a single node", () => {
    const ALIGNS: AlignKind[] = ["left", "hcenter", "right", "top", "middle", "bottom"];

    it("does not move: no command produces an op", () => {
      const scene = sceneWith([node({ id: "a", x: 500, y: 500 })]);
      for (const cmd of ALIGN_COMMANDS) {
        expect({ cmd: cmd.id, ops: alignOps(scene, ["a"], cmd.id) }).toEqual({ cmd: cmd.id, ops: [] });
      }
    });

    it("stays where it is even very far from the origin (x = 10000)", () => {
      const scene = sceneWith([node({ id: "far", x: 10000, y: 10000, width: 50, height: 50 })]);
      for (const kind of ALIGNS) {
        expect(alignDelta(
          { x: 10000, y: 10000, width: 50, height: 50 },
          alignTarget(scene, ["far"])!,
          kind,
        )).toEqual({ dx: 0, dy: 0 });
      }
      expect(alignOps(scene, ["far"], "left")).toEqual([]);
      expect(alignOps(scene, ["far"], "hcenter")).toEqual([]);
    });

    it("not even if it is ROTATED (its AABB is still the common box)", () => {
      const scene = sceneWith([node({ id: "r", x: 700, y: 700, width: 10, height: 10, rotation: 30 })]);
      expect(alignOps(scene, ["r"], "left")).toEqual([]);
      expect(alignOps(scene, ["r"], "middle")).toEqual([]);
    });

    it("has nothing to distribute with a lone node", () => {
      const scene = sceneWith([node({ id: "a", x: 500 })]);
      expect(alignOps(scene, ["a"], "distribute-h")).toEqual([]);
    });
  });

  it("covers every command in ALIGN_COMMANDS", () => {
    const scene = sceneWith([node({ id: "a", x: 0 }), node({ id: "b", x: 15 }), node({ id: "c", x: 90, y: 33 })]);
    for (const cmd of ALIGN_COMMANDS) {
      // No command blows up and none touches fields other than x/y.
      for (const op of alignOps(scene, ["a", "b", "c"], cmd.id)) {
        expect((op.kind.value as { mask?: { paths: string[] } }).mask?.paths).toEqual(["x", "y"]);
      }
    }
  });
});

describe("alignSelection", () => {
  let sync: FakeSync;

  beforeEach(() => {
    sync = new FakeSync();
    useScene.setState({ camera: { x: 0, y: 0, zoom: 1 }, selection: [], gesture: null, sync: null });
    useScene.getState().setScene(sceneWith([
      node({ id: "a", x: 0, y: 0 }),
      node({ id: "b", x: 90, y: 40 }),
      node({ id: "c", x: 200, y: 80 }),
    ]));
    useScene.setState({ sync });
  });

  it("is ONE gesture — one undo entry, however many nodes move", () => {
    useScene.setState({ selection: ["a", "b", "c"] });
    alignSelection("left");
    expect(useScene.getState().scene!.nodes.at("b").x).toBe(0);
    expect(useScene.getState().scene!.nodes.at("c").x).toBe(0);
    expect(sync.sent).toHaveLength(2);
    expect(useScene.getState().undoStack).toHaveLength(1);
    useScene.getState().undo();
    expect(useScene.getState().scene!.nodes.at("b").x).toBe(90);
    expect(useScene.getState().scene!.nodes.at("c").x).toBe(200);
  });

  it("leaves no gesture open", () => {
    useScene.setState({ selection: ["a", "b"] });
    alignSelection("top");
    expect(useScene.getState().gesture).toBeNull();
  });

  it("does nothing at all when there is nothing to move", () => {
    useScene.setState({ selection: [] });
    alignSelection("left");
    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().undoStack).toHaveLength(0);
    expect(useScene.getState().gesture).toBeNull();
  });

  it("opens no gesture when every node is already where it should be", () => {
    const begin = vi.spyOn(useScene.getState(), "beginGesture");
    useScene.setState({ selection: ["a", "b"] });
    alignSelection("left");
    sync.sent = [];
    alignSelection("left"); // already aligned
    expect(sync.sent).toHaveLength(0);
    begin.mockRestore();
  });

  it("with a SINGLE node it sends nothing and opens no gesture", () => {
    useScene.setState({ selection: ["a"] });
    for (const cmd of ALIGN_COMMANDS) alignSelection(cmd.id);
    expect(useScene.getState().scene!.nodes.at("a")).toMatchObject({ x: 0, y: 0 });
    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().undoStack).toHaveLength(0);
    expect(useScene.getState().gesture).toBeNull();
  });
});

// The threshold the panel uses to DISABLE a button. It lives here, next to
// the rule it describes, and not in the panel: it is the same thing alignOps
// does silently (below the minimum it produces no op), said beforehand and out loud.
describe("minSelection", () => {
  it("asks for TWO nodes to align and THREE to distribute", () => {
    for (const cmd of ["left", "hcenter", "right", "top", "middle", "bottom"] as const) {
      expect({ cmd, n: minSelection(cmd) }).toEqual({ cmd, n: 2 });
    }
    for (const cmd of ["distribute-h", "distribute-v"] as const) {
      expect({ cmd, n: minSelection(cmd) }).toEqual({ cmd, n: 3 });
    }
  });

  it("covers every command of the list", () => {
    for (const cmd of ALIGN_COMMANDS) expect(minSelection(cmd.id)).toBeGreaterThanOrEqual(2);
  });

  // THE GUARD: the threshold is not a hand-written number next to the buttons,
  // it must be the point where alignOps stops producing ops. With exactly
  // minSelection - 1 nodes (all out of place) nothing must go out; with
  // minSelection nodes something must go out.
  it("is exactly the point where alignOps starts producing ops", () => {
    const nodes = [
      node({ id: "a", x: 0, y: 0 }),
      node({ id: "b", x: 40, y: 40 }),
      node({ id: "c", x: 200, y: 90 }),
    ];
    const scene = sceneWith(nodes);
    const ids = ["a", "b", "c"];
    for (const cmd of ALIGN_COMMANDS) {
      const n = minSelection(cmd.id);
      expect({ cmd: cmd.id, ops: alignOps(scene, ids.slice(0, n - 1), cmd.id) })
        .toEqual({ cmd: cmd.id, ops: [] });
      expect(alignOps(scene, ids.slice(0, n), cmd.id).length).toBeGreaterThan(0);
    }
  });
});
