import { describe, it, expect } from "vitest";
import {
  drawOverlay,
  selectionFrame,
  selectionWorldBounds,
  worldBoundsToScreen,
  handlePositions,
  HANDLE_SIZE,
  ROTATE_MARKER_OFFSET,
  ROTATE_MARKER_RADIUS,
  rotateMarkerPositions,
  PEN_ANCHOR_SIZE,
  PEN_ANCHOR_GRAB_PX,
} from "./overlayRenderer";
import { emptyScene } from "../store/types";
import type { AnchorLite, NodeLite } from "../store/types";
import type { PenPreview } from "../store/vectorGeometry";
import type { Camera } from "../canvas/camera";

function rect(id: string, x: number, y: number, w = 50, h = 50): NodeLite {
  return {
    id, parentId: "page1", orderKey: "a0", name: id, visible: true, opacity: 1,
    x, y, width: w, height: h, rotation: 0, fills: [], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false,
  };
}

const identityCam: Camera = { x: 0, y: 0, zoom: 1 };

// The geometry is extracted on purpose to be testable without ctx/DOM (there is no
// jsdom/canvas in this project, see renderer/canvasRenderer.test.ts).
describe("selectionWorldBounds", () => {
  it("returns null for an empty selection (nothing to draw)", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("a", rect("a", 0, 0));
    expect(selectionWorldBounds(s, [])).toBeNull();
  });

  it("returns null when the selection references ids no longer in the scene", () => {
    const s = emptyScene("d", "n");
    expect(selectionWorldBounds(s, ["ghost"])).toBeNull();
  });

  it("is the union of the bounds of the selected nodes (via unionBounds)", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("a", rect("a", 0, 0, 50, 50));
    s.nodes = s.nodes.set("b", rect("b", 100, 100, 50, 50));
    expect(selectionWorldBounds(s, ["a", "b"])).toEqual({ x: 0, y: 0, width: 150, height: 150 });
  });

  it("ignores selected ids that no longer exist while keeping the rest", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("a", rect("a", 0, 0, 50, 50));
    expect(selectionWorldBounds(s, ["a", "ghost"])).toEqual({ x: 0, y: 0, width: 50, height: 50 });
  });

  it("puts a nested node's box where the node is drawn: MONDO, not local", () => {
    // page1 > g(100,50) > h(10,20) > k(3,4): the box of "k" in the world starts at
    // (113,74). The selection bbox is drawn in screen space starting
    // from here: if it stayed local, the frame would appear very far from the node.
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("g", { ...rect("g", 100, 50, 400, 400), parentId: "page1" });
    s.nodes = s.nodes.set("h", { ...rect("h", 10, 20, 200, 200), parentId: "g" });
    s.nodes = s.nodes.set("k", { ...rect("k", 3, 4, 50, 50), parentId: "h" });
    expect(selectionWorldBounds(s, ["k"])).toEqual({ x: 113, y: 74, width: 50, height: 50 });
    // Union of two nodes at DIFFERENT depths: both in world coordinates.
    expect(selectionWorldBounds(s, ["g", "k"])).toEqual({ x: 100, y: 50, width: 400, height: 400 });
  });

  // A group has no box of its own: reading it would give a 0x0 rectangle
  // at the origin, that is frame and handles in the wrong corner of the screen
  // for a group that is perfectly visible (see store/groups.ts).
  it("for a group it is the union of its CHILDREN, translated by the group", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("g", { ...rect("g", 0, 0, 0, 0), kind: "group" });
    s.nodes = s.nodes.set("c1", { ...rect("c1", 10, 10, 50, 50), parentId: "g" });
    s.nodes = s.nodes.set("c2", { ...rect("c2", 100, 0, 20, 20), parentId: "g" });
    expect(selectionWorldBounds(s, ["g"])).toEqual({ x: 10, y: 0, width: 110, height: 60 });

    // Once the group is dragged, the frame follows it: its x/y is the translation
    // of the children.
    s.nodes = s.nodes.set("g", { ...s.nodes.at("g"), x: 5, y: 7 });
    expect(selectionWorldBounds(s, ["g"])).toEqual({ x: 15, y: 7, width: 110, height: 60 });
  });

  it("skips an empty group instead of framing its origin", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("g", { ...rect("g", 300, 300, 0, 0), kind: "group" });
    s.nodes = s.nodes.set("a", rect("a", 0, 0, 50, 50));
    expect(selectionWorldBounds(s, ["g"])).toBeNull();
    expect(selectionWorldBounds(s, ["a", "g"])).toEqual({ x: 0, y: 0, width: 50, height: 50 });
  });

  // The renderer skips an invisible node and its whole subtree
  // (canvasRenderer.ts): the selection frame must measure THE SAME
  // geometry, or frame and handles stretch over empty canvas -- the
  // see-vs-select divergence, taken from the overlay's side.
  function groupWithHiddenChild() {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("g", { ...rect("g", 0, 0, 0, 0), kind: "group" });
    s.nodes = s.nodes.set("c1", { ...rect("c1", 10, 10, 50, 50), parentId: "g", visible: false });
    s.nodes = s.nodes.set("c2", { ...rect("c2", 100, 0, 20, 20), parentId: "g" });
    return s;
  }

  it("a group frames only its VISIBLE children: a hidden one does not stretch the box", () => {
    const s = groupWithHiddenChild();
    // With c1 (hidden) inside the union would be {10,0,110,60}.
    expect(selectionWorldBounds(s, ["g"])).toEqual({ x: 100, y: 0, width: 20, height: 20 });
  });

  it("the 8 handles sit on the visible content, not around empty canvas", () => {
    const s = groupWithHiddenChild();
    const box = worldBoundsToScreen(selectionWorldBounds(s, ["g"])!, identityCam);
    const p = handlePositions(box);
    // The visible box is (100,0)-(120,20): every handle sits on it.
    expect(p.nw).toEqual({ x: 100, y: 0 });
    expect(p.se).toEqual({ x: 120, y: 20 });
    expect(p.n).toEqual({ x: 110, y: 0 });
    expect(p.w).toEqual({ x: 100, y: 10 });
    // No handle on the hidden child (which lives on the left, from x=10).
    for (const q of Object.values(p)) expect(q.x).toBeGreaterThanOrEqual(100);
  });

  it("a group whose children are ALL hidden behaves like an empty one: no frame at all", () => {
    const s = groupWithHiddenChild();
    s.nodes = s.nodes.set("c2", { ...s.nodes.at("c2"), visible: false });
    expect(selectionWorldBounds(s, ["g"])).toBeNull();
  });

  // SAME rule, from the frame's CLIP side: the renderer does not draw (nor
  // click, nor does the marquee take) a child beyond the box of a frame with
  // clipsContent. The frame and the 8 handles must measure that same
  // geometry, or they appear -- and become GRABBABLE -- on empty canvas outside
  // the frame.
  function frameWithOverflowingChild() {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("f", { ...rect("f", 10, 20, 100, 80), kind: "frame", clipsContent: true });
    s.nodes = s.nodes.set("c", { ...rect("c", 5, 5, 500, 500), parentId: "f" }); // mondo (15,25)-(515,525)
    return s;
  }

  it("clips an overflowing child's frame to the visible region inside the frame", () => {
    const s = frameWithOverflowingChild();
    // Only the part inside f (10,20)-(110,100): (15,25)-(110,100).
    expect(selectionWorldBounds(s, ["c"])).toEqual({ x: 15, y: 25, width: 95, height: 75 });
  });

  it("keeps every one of the 8 handles inside the frame box, none on clipped-away canvas", () => {
    const s = frameWithOverflowingChild();
    const box = worldBoundsToScreen(selectionWorldBounds(s, ["c"])!, identityCam);
    const p = handlePositions(box);
    // The frame reaches (110,100): no handle goes beyond it.
    for (const q of Object.values(p)) {
      expect(q.x).toBeLessThanOrEqual(110);
      expect(q.y).toBeLessThanOrEqual(100);
    }
    expect(p.se).toEqual({ x: 110, y: 100 });
  });

  it("is null for a child ENTIRELY outside a clipping frame: no frame, no grabbable handles", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("f", { ...rect("f", 0, 0, 100, 100), kind: "frame", clipsContent: true });
    s.nodes = s.nodes.set("c", { ...rect("c", 200, 200, 50, 50), parentId: "f" });
    expect(selectionWorldBounds(s, ["c"])).toBeNull();
  });

  it("does NOT clip when the frame's clipsContent is false: the child is framed whole", () => {
    const s = frameWithOverflowingChild();
    s.nodes = s.nodes.set("f", { ...s.nodes.at("f"), clipsContent: false });
    expect(selectionWorldBounds(s, ["c"])).toEqual({ x: 15, y: 25, width: 500, height: 500 });
  });
});

// The selection FRAME: a single node carries ITS OWN rotation (and its
// box in WORLD coordinates), a multiple selection is AXIS-ALIGNED around the
// nodes' world boxes. The rotation of single nodes in a MULTIPLE selection
// no longer inflates the union (T1's clip-aware fix on selectionWorldBounds
// takes precedence): the one-node case, where rotation matters, is carried by the
// `rotation` field below.
describe("selectionFrame", () => {
  it("is null when there is nothing to frame", () => {
    const s = emptyScene("d", "n");
    expect(selectionFrame(s, [])).toBeNull();
    expect(selectionFrame(s, ["ghost"])).toBeNull();
  });

  it("a single node hands over its own bounds and its own rotation", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("a", { ...rect("a", 10, 20, 100, 50), rotation: 30 });
    expect(selectionFrame(s, ["a"])).toEqual({
      bounds: { x: 10, y: 20, width: 100, height: 50 },
      rotation: 30,
    });
  });

  it("a multiple selection is axis-aligned, around the nodes' world boxes", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("a", rect("a", 0, 0, 100, 50));
    s.nodes = s.nodes.set("b", rect("b", 100, 100, 50, 50));
    const f = selectionFrame(s, ["a", "b"])!;
    expect(f.rotation).toBe(0);
    expect(f.bounds).toEqual({ x: 0, y: 0, width: 150, height: 150 });
  });

  // An instance, like a group, has no box of its own: its frame is that
  // of the master's content (derived, store/groups.ts), axis-aligned -- not
  // the 0x0 rectangle at the origin that its raw box would give.
  it("frames a single instance by its derived content bounds, axis-aligned like a group", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("mr", { ...rect("mr", 10, 10, 50, 50), parentId: "components" });
    s.components["comp"] = { rootNodeId: "mr", name: "Comp" };
    s.nodes = s.nodes.set("i", { ...rect("i", 100, 100, 50, 50), kind: "instance", instance: { componentId: "comp", overrides: [] } });
    expect(selectionFrame(s, ["i"])).toEqual({ bounds: { x: 100, y: 100, width: 50, height: 50 }, rotation: 0 });
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

// fake ctx that records only the call NAMES: a smoke test to verify
// that drawOverlay invokes the expected canvas APIs without crashing, without having to
// verify the exact pixels (no real canvas in Node here).
function fakeCtx(width: number, height: number) {
  const calls: string[] = [];
  // The transform calls with their arguments: they serve the rotated
  // case, where what matters is not HOW MANY times it draws but AROUND
  // WHAT (the box center, in screen px).
  const xform: { op: string; args: number[] }[] = [];
  // The arcs of the ROTATION handle, with center and radius: it is the only
  // overlay drawing that is not a rectangle, and what matters is WHERE
  // it ends up (inside its own grab zone, see selection/handles.test.ts).
  const arcs: { x: number; y: number; r: number }[] = [];
  // The SEGMENTS (moveTo + lineTo): snap guides are the only
  // overlay drawing made of straight lines, and what matters is where they start and end.
  const segments: { x0: number; y0: number; x1: number; y1: number }[] = [];
  let pen = { x: 0, y: 0 };
  const record = (op: string) => (...args: number[]) => { calls.push(op); xform.push({ op, args }); };
  const ctx: Record<string, unknown> = {
    canvas: { width, height },
    moveTo: (x: number, y: number) => { calls.push("moveTo"); pen = { x, y }; },
    lineTo: (x: number, y: number) => {
      calls.push("lineTo");
      segments.push({ x0: pen.x, y0: pen.y, x1: x, y1: y });
    },
    setTransform: (..._a: unknown[]) => { calls.push("setTransform"); },
    clearRect: (..._a: unknown[]) => { calls.push("clearRect"); },
    strokeRect: (..._a: unknown[]) => { calls.push("strokeRect"); },
    fillRect: (..._a: unknown[]) => { calls.push("fillRect"); },
    beginPath: () => { calls.push("beginPath"); },
    arc: (x: number, y: number, r: number, ..._a: number[]) => { calls.push("arc"); arcs.push({ x, y, r }); },
    stroke: () => { calls.push("stroke"); },
    save: record("save"),
    restore: record("restore"),
    translate: record("translate"),
    rotate: record("rotate"),
    lineWidth: 0,
    strokeStyle: "",
    fillStyle: "",
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, xform, arcs, segments };
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
    s.nodes = s.nodes.set("a", rect("a", 0, 0));
    const { ctx, calls } = fakeCtx(800, 600);
    drawOverlay(ctx, s, identityCam, ["a"], null);
    expect(calls.filter((c) => c === "fillRect")).toHaveLength(8); // one per handle
    expect(calls.filter((c) => c === "strokeRect")).toHaveLength(9); // 1 bbox + 8 handle borders
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
    s.nodes = s.nodes.set("a", rect("a", 0, 0));
    const { ctx, calls } = fakeCtx(800, 600);
    drawOverlay(ctx, s, identityCam, ["a"], { x: 200, y: 200, width: 20, height: 20 });
    expect(calls.filter((c) => c === "strokeRect")).toHaveLength(10); // 9 selection + 1 marquee
    expect(calls.filter((c) => c === "fillRect")).toHaveLength(9); // 8 handles + 1 marquee
  });

  it("draws nothing for a group whose children are all hidden: it is an empty group", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("g", { ...rect("g", 0, 0, 0, 0), kind: "group" });
    s.nodes = s.nodes.set("c", { ...rect("c", 10, 10, 50, 50), parentId: "g", visible: false });
    const { ctx, calls } = fakeCtx(800, 600);
    drawOverlay(ctx, s, identityCam, ["g"], null);
    expect(calls).not.toContain("strokeRect"); // neither frame nor handle borders
    expect(calls).not.toContain("fillRect");
  });

  it("HANDLE_SIZE is exported and used to size the handle squares (8px, constant regardless of zoom)", () => {
    expect(HANDLE_SIZE).toBe(8);
  });

  it("turns the whole selection frame -- border AND handles -- with the node's rotation", () => {
    const s = emptyScene("d", "n");
    // box (0,0) 100x50 -> screen center (50, 25) at identity camera
    s.nodes = s.nodes.set("a", { ...rect("a", 0, 0, 100, 50), rotation: 90 });
    const { ctx, calls, xform } = fakeCtx(800, 600);
    drawOverlay(ctx, s, identityCam, ["a"], null);

    expect(xform.map((e) => e.op)).toEqual(["save", "translate", "rotate", "translate", "restore"]);
    expect(xform[1].args).toEqual([50, 25]);
    expect(xform[2].args[0]).toBeCloseTo(Math.PI / 2, 12);
    expect(xform[3].args).toEqual([-50, -25]);
    // the box and the 8 handles are drawn as always: it is the context
    // that rotates, not their geometry
    expect(calls.filter((c) => c === "fillRect")).toHaveLength(8);
    expect(calls.filter((c) => c === "strokeRect")).toHaveLength(9);
    // and the transform is closed BEFORE anything else
    expect(calls.indexOf("restore")).toBeGreaterThan(calls.lastIndexOf("strokeRect"));
  });

  it("leaves the marquee out of the rotation", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("a", { ...rect("a", 0, 0, 100, 50), rotation: 90 });
    const { ctx, calls } = fakeCtx(800, 600);
    drawOverlay(ctx, s, identityCam, ["a"], { x: 200, y: 200, width: 20, height: 20 });
    // the last two drawing calls (marquee fill + stroke) come AFTER
    // the restore: the selection rectangle is always axis-aligned
    expect(calls.lastIndexOf("fillRect")).toBeGreaterThan(calls.indexOf("restore"));
    expect(calls.lastIndexOf("strokeRect")).toBeGreaterThan(calls.indexOf("restore"));
  });

  // The rotation handle EXISTS on screen. Before it was not drawn
  // at all: the gesture was there, but the only way to discover it was hovering over it
  // with the mouse and noticing the cursor.
  it("draws a rotate marker just outside each of the 4 corners", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("a", rect("a", 0, 0, 100, 50));
    const { ctx, calls, arcs } = fakeCtx(800, 600);
    drawOverlay(ctx, s, identityCam, ["a"], null);

    expect(calls.filter((c) => c === "arc")).toHaveLength(4);
    const d = ROTATE_MARKER_OFFSET;
    const at = (x: number, y: number) => arcs.some((a) => a.x === x && a.y === y && a.r === ROTATE_MARKER_RADIUS);
    expect(at(-d, -d)).toBe(true); // nw
    expect(at(100 + d, -d)).toBe(true); // ne
    expect(at(100 + d, 50 + d)).toBe(true); // se
    expect(at(-d, 50 + d)).toBe(true); // sw
    // and it is not a little square: the drawn rectangles stay the same as before
    expect(calls.filter((c) => c === "fillRect")).toHaveLength(8);
    expect(calls.filter((c) => c === "strokeRect")).toHaveLength(9);
  });

  it("puts the markers exactly where rotateMarkerPositions says (one geometry, not two)", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("a", rect("a", 10, 20, 100, 50));
    const cam: Camera = { x: 7, y: 3, zoom: 2 };
    const { ctx, arcs } = fakeCtx(800, 600);
    drawOverlay(ctx, s, cam, ["a"], null);

    const expected = rotateMarkerPositions(worldBoundsToScreen({ x: 10, y: 20, width: 100, height: 50 }, cam));
    for (const p of Object.values(expected)) {
      expect(arcs.some((a) => a.x === p.x && a.y === p.y)).toBe(true);
    }
  });

  it("turns the markers with the frame, and closes the transform after them", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("a", { ...rect("a", 0, 0, 100, 50), rotation: 90 });
    const { ctx, calls, arcs } = fakeCtx(800, 600);
    drawOverlay(ctx, s, identityCam, ["a"], null);

    // drawn in the frame's UNROTATED space (it is the context that turns,
    // as for the box and the handles)...
    expect(arcs).toHaveLength(4);
    expect(arcs.some((a) => a.x === -ROTATE_MARKER_OFFSET && a.y === -ROTATE_MARKER_OFFSET)).toBe(true);
    // ...and inside the save/restore, not after
    expect(calls.indexOf("restore")).toBeGreaterThan(calls.lastIndexOf("arc"));
  });

  it("emits no transform for an unrotated selection", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("a", rect("a", 0, 0));
    const { ctx, xform } = fakeCtx(800, 600);
    drawOverlay(ctx, s, identityCam, ["a"], null);
    expect(xform).toEqual([]);
  });
});

describe("drawOverlay — snap guides", () => {
  it("draws nothing extra when there is no active snap", () => {
    const s = emptyScene("d", "n");
    const { ctx, calls } = fakeCtx(800, 600);
    drawOverlay(ctx, s, identityCam, [], null, []);
    expect(calls).not.toContain("lineTo");
  });

  it("draws a vertical guide as a segment in SCREEN space", () => {
    const s = emptyScene("d", "n");
    const { ctx, segments } = fakeCtx(800, 600);
    drawOverlay(ctx, s, identityCam, [], null, [{ axis: "x", pos: 100, from: 20, to: 300 }]);
    // +0.5 like the rest of the overlay: a 1px stroke lands on a crisp
    // boundary instead of smearing over two rows.
    expect(segments).toEqual([{ x0: 100.5, y0: 20, x1: 100.5, y1: 300 }]);
  });

  it("draws a horizontal guide the other way round", () => {
    const s = emptyScene("d", "n");
    const { ctx, segments } = fakeCtx(800, 600);
    drawOverlay(ctx, s, identityCam, [], null, [{ axis: "y", pos: 40, from: 0, to: 200 }]);
    expect(segments).toEqual([{ x0: 0, y0: 40.5, x1: 200, y1: 40.5 }]);
  });

  it("passes through the camera: a zoomed guide lands where the camera puts it", () => {
    const s = emptyScene("d", "n");
    const cam: Camera = { x: 10, y: 5, zoom: 2 };
    const { ctx, segments } = fakeCtx(800, 600);
    drawOverlay(ctx, s, cam, [], null, [{ axis: "x", pos: 100, from: 20, to: 300 }]);
    // worldToScreen: world * zoom + cam
    expect(segments).toEqual([
      { x0: 100 * 2 + 10 + 0.5, y0: 20 * 2 + 5, x1: 100 * 2 + 10 + 0.5, y1: 300 * 2 + 5 },
    ]);
  });

  it("draws the guides OUTSIDE the frame's rotation — they are always axis-aligned", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("a", { ...rect("a", 0, 0, 100, 50), rotation: 90 });
    const { ctx, calls } = fakeCtx(800, 600);
    drawOverlay(ctx, s, identityCam, ["a"], null, [{ axis: "x", pos: 10, from: 0, to: 50 }]);
    // The segment falls AFTER the rotated box's restore: a guide turned
    // by 90° would no longer be the line on which the edges coincide.
    expect(calls.lastIndexOf("lineTo")).toBeGreaterThan(calls.lastIndexOf("restore"));
  });

  it("draws one segment per guide", () => {
    const s = emptyScene("d", "n");
    const { ctx, segments } = fakeCtx(800, 600);
    drawOverlay(ctx, s, identityCam, [], null, [
      { axis: "x", pos: 0, from: 0, to: 10 },
      { axis: "x", pos: 5, from: 0, to: 10 },
      { axis: "y", pos: 7, from: 0, to: 10 },
    ]);
    expect(segments).toHaveLength(3);
  });
});

// --- the PEN TOOL's path in progress ----------------------------------------

// Like fakeCtx, but it also records the ARGUMENTS: the pen tool's preview is
// made of curves, and "it called bezierCurveTo" is not enough to say it has
// drawn them in the right place.
function penCtx() {
  const calls: string[] = [];
  const args: Record<string, unknown[][]> = {};
  const rec = (name: string) => (...a: unknown[]) => {
    calls.push(name);
    (args[name] ??= []).push(a);
  };
  const ctx: Record<string, unknown> = {
    canvas: { width: 800, height: 600 },
    setTransform: rec("setTransform"),
    clearRect: rec("clearRect"),
    strokeRect: rec("strokeRect"),
    fillRect: rec("fillRect"),
    beginPath: rec("beginPath"),
    moveTo: rec("moveTo"),
    lineTo: rec("lineTo"),
    bezierCurveTo: rec("bezierCurveTo"),
    arc: rec("arc"),
    stroke: rec("stroke"),
    fill: rec("fill"),
    setLineDash: rec("setLineDash"),
    lineWidth: 0,
    strokeStyle: "",
    fillStyle: "",
  };
  const count = (name: string) => calls.filter((c) => c === name).length;
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, args, count };
}

const corner = (x: number, y: number): AnchorLite => ({ x, y, inX: 0, inY: 0, outX: 0, outY: 0 });
const preview = (p: Partial<PenPreview> & Pick<PenPreview, "anchors">): PenPreview => ({
  next: null, active: null, closed: false, ...p,
});

describe("drawOverlay: the pen tool preview", () => {
  const scene = emptyScene("d", "n");

  it("without a preview it draws no path (the overlay stays M1's)", () => {
    const { ctx, calls } = penCtx();
    drawOverlay(ctx, scene, identityCam, [], null, [], null);
    expect(calls).not.toContain("bezierCurveTo");
    expect(calls).not.toContain("fillRect");
  });

  it("a preview WITHOUT anchors draws nothing", () => {
    const { ctx, calls } = penCtx();
    drawOverlay(ctx, scene, identityCam, [], null, [], preview({ anchors: [] }));
    expect(calls).not.toContain("beginPath");
    expect(calls).not.toContain("fillRect");
  });

  it("a single anchor: no segments, only its little square", () => {
    const { ctx, count } = penCtx();
    drawOverlay(ctx, scene, identityCam, [], null, [], preview({ anchors: [corner(10, 10)] }));
    expect(count("bezierCurveTo")).toBe(0); // nothing to start from
    expect(count("fillRect")).toBe(1);
    expect(count("strokeRect")).toBe(1);
  });

  it("draws one curve per segment and one little square per anchor", () => {
    const { ctx, count } = penCtx();
    drawOverlay(ctx, scene, identityCam, [], null, [], preview({
      anchors: [corner(0, 0), corner(50, 0), corner(50, 50)],
    }));
    expect(count("bezierCurveTo")).toBe(2); // 3 ancoraggi = 2 segmenti
    expect(count("stroke")).toBe(1); // a single stroke for the whole outline
    expect(count("fillRect")).toBe(3);
  });

  // The return segment (last -> first) exists in the preview as soon as the
  // pointer presses on the first anchor: it is what the closing drag
  // is shaping, and without drawing it the user would pull a handle
  // whose curve they cannot see.
  it("a CLOSED preview also draws the return segment, last -> first", () => {
    const { ctx, count } = penCtx();
    drawOverlay(ctx, scene, identityCam, [], null, [], preview({
      anchors: [corner(0, 0), corner(50, 0), corner(50, 50)],
      closed: true,
    }));
    // 3 closed anchors = 3 segments (2 + the return), a single stroke.
    expect(count("bezierCurveTo")).toBe(3);
    expect(count("stroke")).toBe(1);
  });

  it("the return segment is drawn by the INCOMING handle of the first anchor", () => {
    const { ctx, args } = penCtx();
    drawOverlay(ctx, scene, identityCam, [], null, [], preview({
      anchors: [
        // The first's incoming handle is what the closing drag pulls.
        { x: 0, y: 0, inX: -20, inY: 10, outX: 0, outY: 0 },
        corner(50, 0),
      ],
      closed: true,
      active: 0,
    }));
    // Last curve: c1 = outgoing of the last anchor (null, so
    // the anchor itself), c2 = incoming of the FIRST (-20,10 relative to it),
    // arrival = the first anchor.
    expect(args["bezierCurveTo"].at(-1)).toEqual([50, 0, -20, 10, 0, 0]);
  });

  it("two closed anchors go A->B->A: the return is there anyway", () => {
    const { ctx, count } = penCtx();
    drawOverlay(ctx, scene, identityCam, [], null, [], preview({
      anchors: [corner(0, 0), corner(50, 0)],
      closed: true,
    }));
    expect(count("bezierCurveTo")).toBe(2);
  });

  it("it is drawn in SCREEN space: the camera converts every control point", () => {
    const cam: Camera = { x: 10, y: 20, zoom: 2 };
    const { ctx, args } = penCtx();
    drawOverlay(ctx, scene, cam, [], null, [], preview({
      // The second anchor has an incoming handle: its control
      // point must go through the camera like all the others.
      anchors: [corner(0, 0), { x: 50, y: 0, inX: -10, inY: 0, outX: 0, outY: 0 }],
    }));
    expect(args["moveTo"][0]).toEqual([10, 20]); // mondo (0,0)
    // c1 = outgoing of the first (null, so the anchor itself), c2 =
    // incoming of the second (world 40,0), arrival = world (50,0).
    expect(args["bezierCurveTo"][0]).toEqual([10, 20, 90, 20, 110, 20]);
  });

  it("the PENDING segment follows the cursor and is dashed", () => {
    const { ctx, count, args } = penCtx();
    drawOverlay(ctx, scene, identityCam, [], null, [], preview({
      anchors: [corner(0, 0)],
      next: { x: 60, y: 20 },
    }));
    expect(count("bezierCurveTo")).toBe(1);
    // The endpoint has no handle: the second control falls on it.
    expect(args["bezierCurveTo"][0]).toEqual([0, 0, 60, 20, 60, 20]);
    // Dash ON and OFF: leaving it on would dirty the next
    // overlay drawing (the little squares below, and the next frame).
    expect(args["setLineDash"].map((a) => a[0])).toEqual([[4, 3], []]);
  });

  it("shows the handles of the ACTIVE anchor only, and only the existing ones", () => {
    const { ctx, count } = penCtx();
    drawOverlay(ctx, scene, identityCam, [], null, [], preview({
      anchors: [
        { x: 0, y: 0, inX: -10, inY: 0, outX: 10, outY: 0 },
        { x: 50, y: 0, inX: -5, inY: 0, outX: 5, outY: 0 },
      ],
      active: 0,
    }));
    // Two sticks and two dots for anchor 0. Those of anchor 1
    // are NOT drawn: it is already-decided geometry, and showing them all
    // would turn the preview into a spiderweb.
    expect(count("lineTo")).toBe(2);
    expect(count("arc")).toBe(2);
    expect(count("fill")).toBe(2);
  });

  it("an active CORNER anchor does not draw zero-length handles", () => {
    const { ctx, count } = penCtx();
    drawOverlay(ctx, scene, identityCam, [], null, [], preview({
      anchors: [corner(0, 0)],
      active: 0,
    }));
    expect(count("lineTo")).toBe(0);
    expect(count("arc")).toBe(0);
  });

  it("coexists with the selection and the marquee without erasing them", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("a", rect("a", 0, 0));
    const { ctx, count } = penCtx();
    drawOverlay(ctx, s, identityCam, ["a"], { x: 0, y: 0, width: 10, height: 10 }, [],
      preview({ anchors: [corner(200, 200)] }));
    // 8 handles + 1 marquee + 1 pen anchor
    expect(count("fillRect")).toBe(10);
    // 1 bbox + 8 handle borders + 1 marquee
    expect(count("strokeRect")).toBe(11);
  });

  it("the anchor's measures are SCREEN px and the grab is more generous than the drawing", () => {
    // Same relationship as the resize handles (8px drawn, 6px grab
    // radius): the target is never smaller than what is seen.
    expect(PEN_ANCHOR_SIZE).toBe(6);
    expect(PEN_ANCHOR_GRAB_PX).toBeGreaterThanOrEqual(PEN_ANCHOR_SIZE / 2);
  });
});
