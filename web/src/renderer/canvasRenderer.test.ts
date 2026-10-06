import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { hitTest, nodesIntersecting, resizeCanvasToDisplaySize, drawScene } from "./canvasRenderer";
import type { CachedImage } from "./imageCache";
import { VECTOR_STROKE_PX } from "./shapes";
import type { Camera } from "../canvas/camera";
import { emptyScene } from "../store/types";
import { contentWorldBounds } from "../store/groups";
import type { FillLite, NodeLite, SceneState, AnchorLite, SubPathLite } from "../store/types";

function frameNode(id: string, parentId: string, x: number, y: number, w: number, h: number, clips: boolean, order = "a0"): NodeLite {
  return { id, parentId, orderKey: order, name: id, visible: true, opacity: 1,
    x, y, width: w, height: h, rotation: 0, fills: [{ r: 0.9, g: 0.9, b: 0.9, a: 1 }],
    strokes: [], kind: "frame", cornerRadius: 0, clipsContent: clips };
}

// Duck-typed stand-in for HTMLCanvasElement: resizeCanvasToDisplaySize only
// touches clientWidth/clientHeight/width/height, so a plain object is enough
// to test it under Node without a DOM (there is no jsdom/canvas setup here).
function fakeCanvas(clientWidth: number, clientHeight: number, width = 0, height = 0) {
  return { clientWidth, clientHeight, width, height } as unknown as HTMLCanvasElement;
}

function rect(id: string, x: number, y: number, order: string, visible = true): NodeLite {
  return { id, parentId: "page1", orderKey: order, name: id, visible, opacity: 1,
    x, y, width: 50, height: 50, rotation: 0, fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [],
    kind: "rect", cornerRadius: 0, clipsContent: false };
}

function childRect(id: string, parentId: string, x: number, y: number, order: string, over: Partial<NodeLite> = {}): NodeLite {
  return { ...rect(id, x, y, order), parentId, ...over };
}

function anchor(a: Partial<AnchorLite>): AnchorLite {
  return { x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0, ...a };
}

// Fake Path2D: jsdom does not have it. It records the primitives called, so a test
// can say not just "it clipped/stroked" but "with THIS shape". A superset
// that serves both the stroke (rect/roundRect/ellipse/addPath) and the vector
// (moveTo/lineTo/bezierCurveTo/closePath): the exact shape of a vector
// path is proven in shapes.test.ts anyway, here what matters is WHICH path
// ends up in fill and which in stroke.
class FakePath2D {
  ops: { op: string; args: unknown[] }[] = [];
  rect(...args: number[]) { this.ops.push({ op: "rect", args }); }
  roundRect(...args: unknown[]) { this.ops.push({ op: "roundRect", args }); }
  ellipse(...args: number[]) { this.ops.push({ op: "ellipse", args }); }
  addPath(p: unknown) { this.ops.push({ op: "addPath", args: [p] }); }
  moveTo(...args: number[]) { this.ops.push({ op: "moveTo", args }); }
  lineTo(...args: number[]) { this.ops.push({ op: "lineTo", args }); }
  bezierCurveTo(...args: number[]) { this.ops.push({ op: "bezierCurveTo", args }); }
  closePath() { this.ops.push({ op: "closePath", args: [] }); }
}

function vectorNode(id: string, subpaths: SubPathLite[], over: Partial<NodeLite> = {}): NodeLite {
  return { ...rect(id, 0, 0, "a0"), kind: "vector", vector: { subpaths }, ...over };
}

// Zoom only enters the vector's grab tolerance: at zoom 1 a screen
// px and a world unit coincide, and that is what the tests on shapes
// whose target does not depend on the camera use.
const Z1 = 1;

describe("hitTest", () => {
  it("returns the topmost node under the point", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("a", rect("a", 0, 0, "a0"));
    s.nodes = s.nodes.set("b", rect("b", 10, 10, "a1")); // on top (greater orderKey)
    expect(hitTest(s, 25, 25, Z1)).toBe("b");
    expect(hitTest(s, 5, 5, Z1)).toBe("a");
    expect(hitTest(s, 200, 200, Z1)).toBeNull();
  });

  it("returns the topmost node by orderKey when two nodes overlap", () => {
    const s = emptyScene("d", "n");
    // Exactly the same overlapping rectangle: "b" has the greater orderKey so it wins.
    s.nodes = s.nodes.set("a", rect("a", 0, 0, "a0"));
    s.nodes = s.nodes.set("b", rect("b", 0, 0, "a1"));
    expect(hitTest(s, 25, 25, Z1)).toBe("b");
  });

  it("skips invisible nodes", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("a", rect("a", 0, 0, "a0", false)); // visible: false, on top by orderKey
    s.nodes = s.nodes.set("b", rect("b", 0, 0, "a-1", true)); // below, but visible
    // "a" has the greater orderKey but is not visible: it must never be returned.
    expect(hitTest(s, 25, 25, Z1)).toBe("b");

    const onlyInvisible = emptyScene("d", "n");
    onlyInvisible.nodes = onlyInvisible.nodes.set("a", rect("a", 0, 0, "a0", false));
    expect(hitTest(onlyInvisible, 25, 25, Z1)).toBeNull();
  });

  it("carries the ZOOM down to the vector's grab tolerance", () => {
    // The conduit: without it, a path would be grabbed at different distances depending on
    // the zoom, and at high zoom it would become almost impossible to click.
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("v", vectorNode("v", [{
      anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 100, y: 0 })], closed: false,
    }], { width: 100, height: 0 }));
    expect(hitTest(s, 50, 3, 1)).toBe("v");     // 3 world units = 3 px
    expect(hitTest(s, 50, 3, 4)).toBeNull();    // 3 world units = 12 px
    expect(hitTest(s, 50, 12, 0.25)).toBe("v"); // 12 world units = 3 px
  });

  it("an OPEN vector does not steal clicks from the shapes inside it", () => {
    // The rectangle below and, on top, three sides of a square surrounding it
    // without closing. Clicking at the center must take the rectangle: the open
    // outline has no ink there.
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("r", rect("r", 0, 0, "a0"));
    s.nodes = s.nodes.set("v", vectorNode("v", [{
      anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 0, y: 50 }),
        anchor({ x: 50, y: 50 }), anchor({ x: 50, y: 0 })],
      closed: false,
    }], { orderKey: "a1" }));
    expect(hitTest(s, 25, 25, Z1)).toBe("r");
    expect(hitTest(s, 25, 49, Z1)).toBe("v");  // on the side, where the ink is
  });
});

// page1 > g(100,50) > h(10,20) > k(3,4): three levels, each level with a
// non-zero offset on both axes. In WORLD coordinates
// the corner of "k" lands at (113,74) and its 50x50 box reaches (163,124).
function nestedScene() {
  const s = emptyScene("d", "n");
  s.nodes = s.nodes.set("g", childRect("g", "page1", 100, 50, "a0", { width: 400, height: 400 }));
  s.nodes = s.nodes.set("h", childRect("h", "g", 10, 20, "a0", { width: 200, height: 200 }));
  s.nodes = s.nodes.set("k", childRect("k", "h", 3, 4, "a0"));
  return s;
}

describe("hitTest with nesting", () => {
  it("finds a nested node at its WORLD position, not at its local one", () => {
    const s = nestedScene();
    // The center of "k" in world coordinates: 113+25, 74+25.
    expect(hitTest(s, 138, 99, Z1)).toBe("k");
    // Its LOCAL coordinates (3,4) are not a point of "k" in the world: there
    // below there is only its great-grandfather "g"... actually not even it, "g" starts at
    // (100,50). A hit-test that stayed flat would answer "k".
    expect(hitTest(s, 5, 6, Z1)).toBeNull();
  });

  it("returns the innermost node: a child is drawn above its container", () => {
    const s = nestedScene();
    // (120, 80) is inside g, inside h, and inside k: the innermost wins.
    expect(hitTest(s, 120, 80, Z1)).toBe("k");
    // Inside g and h but outside k (k ends at x=163).
    expect(hitTest(s, 200, 100, Z1)).toBe("h");
    // Only inside g (h ends at x=310 in the world).
    expect(hitTest(s, 400, 100, Z1)).toBe("g");
  });

  it("orders across containers by the tree, not by a flat orderKey comparison", () => {
    const s = emptyScene("d", "n");
    // Two overlapping containers: "below" has the smaller orderKey, so its
    // subtree sits ENTIRELY below that of "above" -- even if the child of
    // "below" has the greatest orderKey of all.
    s.nodes = s.nodes.set("below", childRect("below", "page1", 0, 0, "a0", { width: 200, height: 200 }));
    s.nodes = s.nodes.set("above", childRect("above", "page1", 0, 0, "a1", { width: 200, height: 200 }));
    s.nodes = s.nodes.set("childBelow", childRect("childBelow", "below", 0, 0, "z9"));
    s.nodes = s.nodes.set("childAbove", childRect("childAbove", "above", 0, 0, "a0"));
    expect(hitTest(s, 25, 25, Z1)).toBe("childAbove");
  });

  it("skips the whole subtree of an invisible container", () => {
    const s = nestedScene();
    s.nodes = s.nodes.set("h", { ...s.nodes.at("h"), visible: false });
    // "k" is visible but sits inside a hidden container: it is not drawn,
    // so it is not clicked. "g" remains below, which is visible.
    expect(hitTest(s, 138, 99, Z1)).toBe("g");
  });

  it("ignores a node whose parent does not exist (unreachable from any page)", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("orphan", childRect("orphan", "vanished", 0, 0, "a0"));
    expect(hitTest(s, 25, 25, Z1)).toBeNull();
  });

  // A group is never the hit-test's answer: it has no geometry of its own and
  // draws nothing, so there is no pixel of its own under the pointer. That
  // the CLICK then selects the group is a selection policy
  // (store/groups.ts), and lives there on purpose.
  it("never returns a group: it returns the child, and nothing in the empty space between children", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("g", { ...childRect("g", "page1", 0, 0, "a0"), kind: "group", width: 400, height: 400 });
    s.nodes = s.nodes.set("c", childRect("c", "g", 10, 10, "a0"));
    expect(hitTest(s, 25, 25, Z1)).toBe("c");
    // Inside the union of the children but on no child: nothing to select.
    expect(hitTest(s, 300, 300, Z1)).toBeNull();
  });
});

// SEE-vs-SELECT for a FRAME, hit-test side. A frame is hit on its
// OWN box (clicking the void = selecting the frame), and -- if clipsContent
// -- a point on the CLIPPED-AWAY part of a child does not hit the child,
// exactly as it is not drawn there. Without clip the child overflows and is clicked.
describe("hitTest with a frame", () => {
  // Frame F (0,0 100x100) with a child C (local 80,80 50x50): C overflows past
  // the frame's right/bottom edge (its world box reaches 130,130, the
  // frame ends at 100,100).
  function framed(clips: boolean): SceneState {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("F", frameNode("F", "page1", 0, 0, 100, 100, clips));
    s.nodes = s.nodes.set("C", childRect("C", "F", 80, 80, "a0"));
    return s;
  }

  it("clicking the empty body of a frame selects the FRAME (artboard convention)", () => {
    expect(hitTest(framed(true), 10, 10, Z1)).toBe("F");
  });

  it("clicking a child inside the frame selects the child, not the frame", () => {
    expect(hitTest(framed(true), 90, 90, Z1)).toBe("C");
  });

  it("does NOT hit a child on the part the frame clips away", () => {
    // (120,120) is on the child but OUTSIDE the frame's box: the clip hides it,
    // and there is not even the frame there -- so nothing.
    expect(hitTest(framed(true), 120, 120, Z1)).toBeNull();
  });

  it("DOES hit the overflowing child when the frame does not clip", () => {
    // Same point, but without clip the child overflows and is seen: it is clicked.
    expect(hitTest(framed(false), 120, 120, Z1)).toBe("C");
  });
});

// The third question on the same descent (the first is "draw", the second
// "what is under the pointer"): "what is inside this world rectangle".
// It must answer with the same nodes as the other two, otherwise the marquee
// selects what is not seen.
describe("nodesIntersecting", () => {
  it("returns the visible nodes whose WORLD box intersects, in draw order", () => {
    const s = nestedScene();
    // The world box of "k" is (113,74)-(163,124): a rectangle around its
    // corner takes k, and with it the ancestors that contain it.
    expect(nodesIntersecting(s, { x: 105, y: 70, width: 20, height: 20 })).toEqual(["g", "h", "k"]);
    // The LOCAL coordinates of "k" (3,4) are not a point of it in the world.
    expect(nodesIntersecting(s, { x: 0, y: 0, width: 10, height: 10 })).toEqual([]);
  });

  it("skips the whole subtree of an invisible container", () => {
    const s = nestedScene();
    s.nodes = s.nodes.set("h", { ...s.nodes.at("h"), visible: false });
    // "k" has visible: true, but sits inside a hidden container: it is not
    // drawn, so it cannot even be selected with the marquee -- "g" remains.
    // A flat filter on n.visible would answer ["g", "k"].
    expect(nodesIntersecting(s, { x: 105, y: 70, width: 20, height: 20 })).toEqual(["g"]);
  });

  it("ignores a node unreachable from any page", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("orphan", childRect("orphan", "vanished", 0, 0, "a0"));
    expect(nodesIntersecting(s, { x: 0, y: 0, width: 100, height: 100 })).toEqual([]);
  });

  it("keeps descending when a container's own box misses the rectangle", () => {
    // A group's box is ITS OWN, not the union of the children: pruning the descent
    // on the container's intersection would lose a child that is inside the
    // marquee while its container is outside it.
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("g", childRect("g", "page1", 0, 0, "a0", { width: 10, height: 10 }));
    s.nodes = s.nodes.set("c", childRect("c", "g", 500, 500, "a0"));
    expect(nodesIntersecting(s, { x: 490, y: 490, width: 30, height: 30 })).toEqual(["c"]);
  });

  it("excludes a node that only touches the rectangle at an edge", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("a", rect("a", 50, 0, "a0")); // 50x50 -> (50,0)-(100,50)
    expect(nodesIntersecting(s, { x: 0, y: 0, width: 50, height: 50 })).toEqual([]);
  });

  // The same rule as hitTest, from the other side: a group is not drawn,
  // so it cannot even be taken with the marquee. Its box is NOT its
  // frame, and at creation it is 0x0 at the parent's origin: without the
  // explicit branch a band around the origin would take it -- boundsIntersect
  // compares opposite edges with < / >, and a degenerate box STRICTLY inside the
  // band intersects. Putting it in the selection is the job of the policy
  // (store/groups.ts::selectionTargetsOf) starting from the children.
  it("never returns a group: its degenerate box at the parent origin is not a frame", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("g", { ...childRect("g", "page1", 0, 0, "a0"), kind: "group", width: 0, height: 0 });
    s.nodes = s.nodes.set("c", childRect("c", "g", 100, 100, "a0")); // 50x50 -> (100,100)-(150,150)
    // A band around the origin: the group's content is 100px away.
    expect(nodesIntersecting(s, { x: -5, y: -5, width: 10, height: 10 })).toEqual([]);
    // And when the band takes the child, the answer is the CHILD: the group is
    // added by selectionTargetsOf, not by this descent.
    expect(nodesIntersecting(s, { x: 90, y: 90, width: 30, height: 30 })).toEqual(["c"]);
  });

  it("never returns a group even when it carries a non-zero box", () => {
    // width/height on a group are not written by any gesture, but may arrive
    // from a document of another version: the branch is on the KIND, not on the
    // degenerate box, exactly as in drawNode and hitTestNode.
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("g", { ...childRect("g", "page1", 0, 0, "a0"), kind: "group", width: 400, height: 400 });
    s.nodes = s.nodes.set("c", childRect("c", "g", 300, 300, "a0"));
    expect(nodesIntersecting(s, { x: 10, y: 10, width: 20, height: 20 })).toEqual([]);
    expect(nodesIntersecting(s, { x: 310, y: 310, width: 20, height: 20 })).toEqual(["c"]);
  });
});

// SEE-vs-SELECT for a FRAME, marquee side. The band takes the frame on its
// box (like a rectangle); and -- if clipsContent -- does NOT take a child
// in the area the frame clips away, because there the child is not seen. Without
// clip the child overflows and the band takes it.
describe("nodesIntersecting with a frame", () => {
  function framed(clips: boolean): SceneState {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("F", frameNode("F", "page1", 0, 0, 100, 100, clips));
    s.nodes = s.nodes.set("C", childRect("C", "F", 80, 80, "a0")); // box mondo (80,80)-(130,130)
    return s;
  }

  it("takes the frame on its own box, and a child on its visible (in-frame) part", () => {
    // Band (85,85)-(95,95): inside the frame and on the visible part of C.
    expect(nodesIntersecting(framed(true), { x: 85, y: 85, width: 10, height: 10 })).toEqual(["F", "C"]);
  });

  it("does NOT take a child through the area the frame clips away", () => {
    // Band (110,110)-(120,120): entirely beyond the frame's edge, on the piece of C
    // clipped away. It takes neither C (clip) nor F (the band is outside its box).
    expect(nodesIntersecting(framed(true), { x: 110, y: 110, width: 10, height: 10 })).toEqual([]);
  });

  it("takes the overflowing child there when the frame does not clip", () => {
    // Same band: without clip the piece of C that overflows is seen, and is taken.
    expect(nodesIntersecting(framed(false), { x: 110, y: 110, width: 10, height: 10 })).toEqual(["C"]);
  });
});

function textNode(over: Partial<NodeLite> = {}): NodeLite {
  return { id: "t", parentId: "page1", orderKey: "a1", name: "Text", visible: true, opacity: 1,
    x: 10, y: 20, width: 200, height: 40, rotation: 0, fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [],
    kind: "text", cornerRadius: 0, clipsContent: false,
    text: { content: "hi", style: { fontFamily: "", fontSize: 16, fontWeight: "", lineHeight: 0, align: "left" } },
    ...over };
}

// duck-typed ctx: jsdom has neither canvas 2D nor Path2D. A text-only scene
// never goes through nodePath, so drawScene is testable here.
//
// The fake ctx keeps the current TRANSLATION with a stack for save/restore, which
// is exactly what drawScene applies when descending the tree: the coordinates
// recorded in `fillText` are therefore the WORLD ones (tests use the identity
// camera), not the node's local ones. Without this, a wrong
// nesting would go unnoticed -- the text would be recorded with its local
// coordinates in any case.
function fakeCtx() {
  const fillText: { text: string; x: number; y: number }[] = [];
  const fills: { path: unknown; rule: unknown }[] = [];
  const strokes: { path: unknown; lineWidth: number; strokeStyle: string; cap: string }[] = [];
  const clips: unknown[] = [];
  // The calls that compose the transform of a ROTATED node, in order
  // (track 2): drawScene emits them only around nodes with rotation != 0,
  // so a still scene must leave this list empty.
  const xform: { op: string; args: number[] }[] = [];
  // The current translation and its stack (track 1, nesting): save/restore
  // and transform move it, so the coordinates recorded in fillText are
  // the WORLD ones (tests use the identity camera), not the node's local ones.
  let cur = { x: 0, y: 0 };
  const stack: { x: number; y: number }[] = [];
  const ctx = {
    canvas: { width: 800, height: 600 },
    font: "", textBaseline: "", textAlign: "", fillStyle: "", globalAlpha: 1,
    strokeStyle: "", lineWidth: 0, lineCap: "", lineJoin: "",
    setTransform: () => {},
    clearRect: () => {},
    save: () => { stack.push(cur); xform.push({ op: "save", args: [] }); },
    restore: () => { cur = stack.pop() ?? { x: 0, y: 0 }; xform.push({ op: "restore", args: [] }); },
    translate: (x: number, y: number) => { cur = { x: cur.x + x, y: cur.y + y }; xform.push({ op: "translate", args: [x, y] }); },
    rotate: (r: number) => { xform.push({ op: "rotate", args: [r] }); },
    transform: (a: number, b: number, c: number, d: number, e: number, f: number) => {
      // The descent into the tree: translations only for now (if a scale
      // or a rotation arrived between containers this fake ctx would have to become a matrix).
      // It does NOT enter `xform`, which records only the nodes' rotation.
      cur = { x: cur.x + e, y: cur.y + f };
      void a; void b; void c; void d;
    },
    measureText: (s: string) => ({ width: s.length * 10 }),
    fillText: (t: string, x: number, y: number) => { fillText.push({ text: t, x: cur.x + x, y: cur.y + y }); },
    strokeText: () => {},
    fill: (p: unknown, rule?: unknown) => { fills.push({ path: p, rule }); },
    stroke: (p: unknown) => {
      strokes.push({ path: p, lineWidth: ctx.lineWidth, strokeStyle: ctx.strokeStyle, cap: ctx.lineCap });
    },
    // A frame's clip: the received sub-path is recorded (a FakePath2D stub
    // with its ops) so the test can read the box the frame clips to.
    clip: (p: unknown) => { clips.push(p); },
  };
  return {
    ctx: ctx as unknown as CanvasRenderingContext2D,
    fillText,
    fills,
    strokes,
    clips,
    xform,
    // How many save()s have not yet received their restore().
    open: () => stack.length,
  };
}

describe("drawScene", () => {
  it("routes a text node to drawText instead of filling its box", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("t", textNode());
    const f = fakeCtx();
    drawScene(f.ctx, s, { x: 0, y: 0, zoom: 1 } as Camera);
    expect(f.fillText.map((c) => c.text)).toEqual(["hi"]);
    expect(f.fills).toEqual([]); // no fill of the rectangle under the text
  });

  it("still draws a text node whose height has not been measured yet", () => {
    // A text's height is produced by the LAYOUT, not by the box: a node with
    // height 0 must still appear, otherwise the just-written text
    // would stay invisible until someone updates height.
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("t", textNode({ height: 0 }));
    const f = fakeCtx();
    drawScene(f.ctx, s, { x: 0, y: 0, zoom: 1 } as Camera);
    expect(f.fillText.map((c) => c.text)).toEqual(["hi"]);
  });

  it("skips an invisible text node", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("t", textNode({ visible: false }));
    const f = fakeCtx();
    drawScene(f.ctx, s, { x: 0, y: 0, zoom: 1 } as Camera);
    expect(f.fillText).toEqual([]);
  });

  // --- rotation -------------------------------------------------------------
  // The node is always drawn with its UNROTATED path: it is the
  // CONTEXT that rotates, around the box CENTER (the canvas/transform.ts convention).

  it("rotates a node about the CENTRE of its box, and undoes the transform after", () => {
    const s = emptyScene("d", "n");
    // box (10,20) 200x40 -> centro (110, 40)
    s.nodes = s.nodes.set("t", textNode({ rotation: 90 }));
    const f = fakeCtx();
    drawScene(f.ctx, s, { x: 0, y: 0, zoom: 1 } as Camera);

    expect(f.xform.map((e) => e.op)).toEqual(["save", "translate", "rotate", "translate", "restore"]);
    expect(f.xform[1].args).toEqual([110, 40]);
    expect(f.xform[2].args[0]).toBeCloseTo(Math.PI / 2, 12); // gradi -> radianti
    expect(f.xform[3].args).toEqual([-110, -40]);
    // and the node is drawn anyway, at its usual coordinates
    expect(f.fillText.map((c) => c.text)).toEqual(["hi"]);
  });

  it("emits no transform at all for an unrotated scene", () => {
    // Text only: nodePath (and therefore Path2D, which does not exist here) does not come into
    // play -- same reason the tests above avoid it.
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("t", textNode());
    s.nodes = s.nodes.set("u", textNode({ id: "u", orderKey: "a2", rotation: 0 }));
    const f = fakeCtx();
    drawScene(f.ctx, s, { x: 0, y: 0, zoom: 1 } as Camera);
    expect(f.xform).toEqual([]);
  });
});

// --- the STROKE ----------------------------------------------------------------
//
// Canvas 2D can ONLY stroke centered: INSIDE and OUTSIDE are obtained by
// doubling the width (so the half that survives is exactly the requested
// weight) and CLIPPING the side that is not needed. These tests pin down the three
// recipes, because they are the only place where "align" becomes something
// observable on the canvas.

interface StrokeCall { path: unknown; lineWidth: number; strokeStyle: string }
interface ClipCall { path: unknown; rule?: string }

// Like fakeCtx, but with what the stroke needs: stroke/clip/save/restore and the
// two state attributes read at the time of the call (the ctx is stateful, and
// reading them AFTER would only tell the last value written).
function strokeCtx() {
  const fills: unknown[] = [];
  const strokes: StrokeCall[] = [];
  const clips: ClipCall[] = [];
  const strokeText: { text: string; x: number; y: number }[] = [];
  const order: string[] = [];
  const ctx = {
    canvas: { width: 800, height: 600 },
    font: "", textBaseline: "", textAlign: "",
    fillStyle: "", strokeStyle: "", lineWidth: 1, globalAlpha: 1,
    setTransform: () => {}, clearRect: () => {},
    save: () => { order.push("save"); },
    restore: () => { order.push("restore"); },
    translate: () => {}, rotate: () => {},
    measureText: (s: string) => ({ width: s.length * 10 }),
    fillText: () => { order.push("fillText"); },
    strokeText: (t: string, x: number, y: number) => {
      order.push("strokeText");
      strokeText.push({ text: t, x, y });
    },
    fill: (p: unknown) => { order.push("fill"); fills.push(p); },
    stroke: (p: unknown) => {
      order.push("stroke");
      strokes.push({ path: p, lineWidth: ctx.lineWidth, strokeStyle: ctx.strokeStyle });
    },
    clip: (p: unknown, rule?: string) => { order.push("clip"); clips.push({ path: p, rule }); },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, fills, strokes, clips, strokeText, order };
}

function strokedRect(over: Partial<NodeLite> = {}): NodeLite {
  return { ...rect("r", 0, 0, "a0"), ...over };
}

const RED: FillLite = { r: 1, g: 0, b: 0, a: 1 };

describe("drawScene: stroke", () => {
  beforeEach(() => { vi.stubGlobal("Path2D", FakePath2D); });
  afterEach(() => { vi.unstubAllGlobals(); });

  function sceneWith(n: NodeLite) {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set(n.id, n);
    return s;
  }

  it("a node WITHOUT strokes strokes nothing and clips nothing", () => {
    const f = strokeCtx();
    drawScene(f.ctx, sceneWith(strokedRect()), { x: 0, y: 0, zoom: 1 } as Camera);
    expect(f.strokes).toEqual([]);
    expect(f.clips).toEqual([]);
    expect(f.order).toEqual(["fill"]);
  });

  it("CENTER: strokes the SAME path as the fill, with lineWidth = weight, after the fill", () => {
    const f = strokeCtx();
    const n = strokedRect({ strokes: [{ color: RED, weight: 6, align: "center" }] });
    drawScene(f.ctx, sceneWith(n), { x: 0, y: 0, zoom: 1 } as Camera);

    expect(f.strokes).toHaveLength(1);
    // THE SAME object: the stroke follows the fill's geometry by
    // construction, not by a second construction destined to diverge.
    expect(f.strokes[0].path).toBe(f.fills[0]);
    expect(f.strokes[0].lineWidth).toBe(6);
    expect(f.strokes[0].strokeStyle).toBe("rgba(255, 0, 0, 1)");
    // The stroke sits ABOVE the fill, as in every editor.
    expect(f.order).toEqual(["fill", "stroke"]);
    // No clip: the centered one is the only one the canvas can do by itself.
    expect(f.clips).toEqual([]);
  });

  it("INSIDE: clips INSIDE the shape and doubles the width", () => {
    const f = strokeCtx();
    const n = strokedRect({ strokes: [{ color: RED, weight: 6, align: "inside" }] });
    drawScene(f.ctx, sceneWith(n), { x: 0, y: 0, zoom: 1 } as Camera);

    expect(f.clips).toHaveLength(1);
    // The clip is the shape's own path, with no fill rule.
    expect(f.clips[0].path).toBe(f.fills[0]);
    expect(f.clips[0].rule).toBeUndefined();
    // 12 and not 6: half falls outside and is clipped, the half that stays INSIDE
    // is exactly the requested weight.
    expect(f.strokes[0].lineWidth).toBe(12);
    // And the clip is confined to a save/restore: it must not outlive the node.
    expect(f.order).toEqual(["fill", "save", "clip", "stroke", "restore"]);
  });

  it("OUTSIDE: clips the COMPLEMENT of the shape (evenodd) and doubles the width", () => {
    const f = strokeCtx();
    const n = strokedRect({ strokes: [{ color: RED, weight: 6, align: "outside" }] });
    drawScene(f.ctx, sceneWith(n), { x: 0, y: 0, zoom: 1 } as Camera);

    expect(f.clips).toHaveLength(1);
    expect(f.clips[0].rule).toBe("evenodd");
    const clip = f.clips[0].path as FakePath2D;
    // A rectangle that covers the whole outer band PLUS the shape: with
    // evenodd, points inside the shape cross two edges (even) and stay
    // OUTSIDE the clip. It is the complement, without having to invert a path.
    expect(clip.ops.map((o) => o.op)).toEqual(["rect", "addPath"]);
    // rect: the node's box (50x50 at 0,0) widened by as much as the stroke can
    // overhang, with a margin so the clip rectangle does not cut the outer
    // edge of the band.
    const [rx, ry, rw, rh] = clip.ops[0].args as number[];
    expect(rx).toBeLessThanOrEqual(-6);
    expect(ry).toBeLessThanOrEqual(-6);
    expect(rx + rw).toBeGreaterThanOrEqual(56);
    expect(ry + rh).toBeGreaterThanOrEqual(56);
    expect(clip.ops[1].args[0]).toBe(f.fills[0]);
    expect(f.strokes[0].lineWidth).toBe(12);
    expect(f.order).toEqual(["fill", "save", "clip", "stroke", "restore"]);
  });

  it("a non-positive weight strokes nothing (it is not a very thin stroke: it does not exist)", () => {
    const f = strokeCtx();
    const n = strokedRect({ strokes: [
      { color: RED, weight: 0, align: "center" },
      { color: RED, weight: -3, align: "outside" },
    ] });
    drawScene(f.ctx, sceneWith(n), { x: 0, y: 0, zoom: 1 } as Camera);
    expect(f.strokes).toEqual([]);
    expect(f.clips).toEqual([]);
  });

  it("several strokes are drawn IN THE LIST'S ORDER, the last on top", () => {
    const f = strokeCtx();
    const n = strokedRect({ strokes: [
      { color: RED, weight: 8, align: "center" },
      { color: { r: 0, g: 0, b: 1, a: 1 }, weight: 2, align: "center" },
    ] });
    drawScene(f.ctx, sceneWith(n), { x: 0, y: 0, zoom: 1 } as Camera);
    expect(f.strokes.map((s) => [s.lineWidth, s.strokeStyle])).toEqual([
      [8, "rgba(255, 0, 0, 1)"],
      [2, "rgba(0, 0, 255, 1)"],
    ]);
  });

  it("an INVISIBLE node strokes nothing", () => {
    const f = strokeCtx();
    const n = strokedRect({ visible: false, strokes: [{ color: RED, weight: 6, align: "center" }] });
    drawScene(f.ctx, sceneWith(n), { x: 0, y: 0, zoom: 1 } as Camera);
    expect(f.strokes).toEqual([]);
  });

  it("TEXT is stroked with strokeText, line by line, on top of the filled glyphs", () => {
    const f = strokeCtx();
    const n = { ...textNode(), strokes: [{ color: RED, weight: 3, align: "center" as const }] };
    drawScene(f.ctx, sceneWith(n), { x: 0, y: 0, zoom: 1 } as Camera);

    expect(f.strokeText.map((c) => c.text)).toEqual(["hi"]);
    expect(f.order).toEqual(["fillText", "strokeText"]);
    // No clip: a glyph has no Path2D to clip, so the text's stroke
    // is ALWAYS centered -- see the comment in renderer/text.ts.
    expect(f.clips).toEqual([]);
  });

  it("text does not clip even with align inside/outside: it stays centered", () => {
    const f = strokeCtx();
    const n = { ...textNode(), strokes: [{ color: RED, weight: 3, align: "outside" as const }] };
    drawScene(f.ctx, sceneWith(n), { x: 0, y: 0, zoom: 1 } as Camera);
    expect(f.clips).toEqual([]);
    expect(f.order).toEqual(["fillText", "strokeText"]);
  });

  it("still draws a vector node with a degenerate axis, but not a degenerate RECT", () => {
    // A vector node's box is the EXACT bbox of its geometry
    // (proto invariant), so a horizontal segment really has height
    // 0. Discarding it here would make it invisible -- and, with the same guard
    // in hit-test, not even clickable: reachable only from the layers
    // panel.
    //
    // The degenerate rectangle instead stays discarded: there the ink IS the box and
    // there is nothing to fill. It is the distinction that lives in
    // shapes.ts::inkIsBox, shared by drawing and hit-test.
    vi.stubGlobal("Path2D", FakePath2D);
    try {
      const s = emptyScene("d", "n");
      s.nodes = s.nodes.set("v", vectorNode("v", [{
        anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 50, y: 0 })], closed: false,
      }], { height: 0 }));
      const f = fakeCtx();
      drawScene(f.ctx, s, { x: 0, y: 0, zoom: 1 } as Camera);
      expect(f.strokes).toHaveLength(1);

      const s2 = emptyScene("d", "n");
      s2.nodes = s2.nodes.set("r", { ...rect("r", 0, 0, "a0"), height: 0 });
      const f2 = fakeCtx();
      drawScene(f2.ctx, s2, { x: 0, y: 0, zoom: 1 } as Camera);
      expect(f2.fills).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a CLOSED vector is filled with the even-odd rule, and stroked anyway", () => {
    // The rule is not the canvas default ("nonzero"), so it must be passed
    // explicitly -- and it is the same one hit-test uses. With nonzero an inner
    // outline traversed in the same direction as the outer one would NOT
    // be a hole, and the drawing would stop matching the click.
    vi.stubGlobal("Path2D", FakePath2D);
    try {
      const s = emptyScene("d", "n");
      s.nodes = s.nodes.set("v", vectorNode("v", [{
        anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 10, y: 0 }), anchor({ x: 10, y: 10 })],
        closed: true,
      }]));
      const f = fakeCtx();
      drawScene(f.ctx, s, { x: 0, y: 0, zoom: 1 } as Camera);
      expect(f.fills).toHaveLength(1);
      expect(f.fills[0].rule).toBe("evenodd");
      // The stroke is here too. On color it is invisible (it is the same tint as the
      // fill, half a thickness more of shape), but it is what keeps visible
      // a closed outline of ZERO AREA -- see the test below.
      expect(f.strokes).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a CLOSED vector of ZERO AREA is painted all the same: the stroke is there", () => {
    // A -> B -> A, what the pen tool produces by closing a two-point path.
    // The fill paints nothing (even-odd on an outline with no area), so
    // without the stroke the node would be INVISIBLE. The case is reachable with
    // three clicks, it is not a limit.
    vi.stubGlobal("Path2D", FakePath2D);
    try {
      const s = emptyScene("d", "n");
      s.nodes = s.nodes.set("v", vectorNode("v", [{
        anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 50, y: 0 })], closed: true,
      }], { height: 0 }));
      const f = fakeCtx();
      drawScene(f.ctx, s, { x: 0, y: 0, zoom: 1 } as Camera);
      expect(f.strokes).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("an OPEN vector is STROKED, with a constant on-screen thickness in px", () => {
    // An open outline is not filled: without a stroke it would not exist on
    // screen, and the pen tool would draw blind. The ctx is already in
    // world transform (zoom applied), so the thickness must be divided by
    // the zoom -- otherwise the line would thicken along with the drawing.
    vi.stubGlobal("Path2D", FakePath2D);
    try {
      const s = emptyScene("d", "n");
      s.nodes = s.nodes.set("v", vectorNode("v", [{
        anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 50, y: 50 })], closed: false,
      }]));
      for (const zoom of [1, 4, 0.5]) {
        const f = fakeCtx();
        drawScene(f.ctx, s, { x: 0, y: 0, zoom } as Camera);
        expect(f.fills).toEqual([]);
        expect(f.strokes).toHaveLength(1);
        expect(f.strokes[0].lineWidth).toBeCloseTo(VECTOR_STROKE_PX / zoom, 10);
        // The model has no stroke color: the fill's is used,
        // the only tint it knows.
        expect(f.strokes[0].strokeStyle).toBe("rgba(0, 0, 0, 1)");
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a node with open AND closed outlines pays one fill and one stroke", () => {
    vi.stubGlobal("Path2D", FakePath2D);
    try {
      const s = emptyScene("d", "n");
      s.nodes = s.nodes.set("v", vectorNode("v", [
        { anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 10, y: 0 }), anchor({ x: 0, y: 10 })], closed: true },
        { anchors: [anchor({ x: 50, y: 0 }), anchor({ x: 50, y: 30 })], closed: false },
      ]));
      const f = fakeCtx();
      drawScene(f.ctx, s, { x: 0, y: 0, zoom: 1 } as Camera);
      expect(f.fills).toHaveLength(1);
      expect(f.strokes).toHaveLength(1);
      // Two DIFFERENT Path2Ds: in the same one, the canvas would implicitly close
      // the open outline too and fill it.
      expect(f.fills[0].path).not.toBe(f.strokes[0].path);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a vector without geometry paints nothing", () => {
    // No empty fill and no empty stroke: it is also the reason hit-test
    // does not hit it (no ink, no target).
    vi.stubGlobal("Path2D", FakePath2D);
    try {
      const s = emptyScene("d", "n");
      s.nodes = s.nodes.set("v", vectorNode("v", []));
      const f = fakeCtx();
      drawScene(f.ctx, s, { x: 0, y: 0, zoom: 1 } as Camera);
      expect(f.fills).toEqual([]);
      expect(f.strokes).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// A text node with fontSize 16 and unspecified lineHeight: line spacing
// 16*1.2 = 19.2 and ascent (19.2-16)/2 + 16*0.8 = 14.4 (see renderer/text.ts).
// The baseline of the first line therefore falls at y + 14.4.
const ASCENT = 14.4;
const identityCam = { x: 0, y: 0, zoom: 1 } as Camera;

function textAt(id: string, parentId: string, x: number, y: number, order = "a0", over: Partial<NodeLite> = {}): NodeLite {
  return { ...textNode(), id, parentId, orderKey: order, x, y, name: id,
    text: { content: id, style: { fontFamily: "", fontSize: 16, fontWeight: "", lineHeight: 0, align: "left" } }, ...over };
}

describe("drawScene with nesting", () => {
  it("draws a container BEFORE its children, and the child at its world position", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("P", textAt("P", "page1", 100, 50));
    s.nodes = s.nodes.set("C", textAt("C", "P", 3, 4));
    const f = fakeCtx();
    drawScene(f.ctx, s, identityCam);
    expect(f.fillText).toEqual([
      { text: "P", x: 100, y: 50 + ASCENT },
      // (3,4) is RELATIVE to P: in the world it lands at (103, 54).
      { text: "C", x: 103, y: 54 + ASCENT },
    ]);
  });

  it("accumulates the transform three levels deep", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("P", textAt("P", "page1", 100, 50));
    s.nodes = s.nodes.set("Q", textAt("Q", "P", 10, 20));
    s.nodes = s.nodes.set("R", textAt("R", "Q", 3, 4));
    const f = fakeCtx();
    drawScene(f.ctx, s, identityCam);
    expect(f.fillText.map((c) => [c.text, c.x, c.y])).toEqual([
      ["P", 100, 50 + ASCENT],
      ["Q", 110, 70 + ASCENT],
      ["R", 113, 74 + ASCENT],
    ]);
  });

  it("draws the children of a container in orderKey order", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("P", textAt("P", "page1", 0, 0));
    s.nodes = s.nodes.set("b", textAt("b", "P", 0, 0, "a2"));
    s.nodes = s.nodes.set("a", textAt("a", "P", 0, 0, "a1"));
    const f = fakeCtx();
    drawScene(f.ctx, s, identityCam);
    expect(f.fillText.map((c) => c.text)).toEqual(["P", "a", "b"]);
  });

  it("descends into a container with a degenerate box (a group has no box of its own)", () => {
    // The size guard skips DRAWING the container, not the
    // descent: a group (track 1, task 3) has nothing to fill but its
    // children must appear, and at their world position.
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("g", { ...rect("g", 100, 50, "a0"), width: 0, height: 0 });
    s.nodes = s.nodes.set("C", textAt("C", "g", 3, 4));
    const f = fakeCtx();
    drawScene(f.ctx, s, identityCam);
    expect(f.fills).toEqual([]); // no Path2D for the degenerate container
    expect(f.fillText).toEqual([{ text: "C", x: 103, y: 54 + ASCENT }]);
  });

  // The test above covers the DEGENERATE container; a group is NEVER drawn,
  // not even with a box on it -- it has no geometry of its own (its bounds
  // are the union of the children, see store/groups.ts). Without the explicit branch
  // a solid rectangle the user never drew would appear.
  it("never fills a group, whatever box it carries, but draws its children", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("g", { ...rect("g", 100, 50, "a0"), kind: "group", width: 400, height: 400 });
    s.nodes = s.nodes.set("C", textAt("C", "g", 3, 4));
    const f = fakeCtx();
    drawScene(f.ctx, s, identityCam);
    expect(f.fills).toEqual([]);
    expect(f.fillText).toEqual([{ text: "C", x: 103, y: 54 + ASCENT }]);
  });

  it("hides the whole subtree of an invisible group, like any other container", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("g", { ...rect("g", 0, 0, "a0"), kind: "group", visible: false });
    s.nodes = s.nodes.set("C", textAt("C", "g", 3, 4));
    const f = fakeCtx();
    drawScene(f.ctx, s, identityCam);
    expect(f.fillText).toEqual([]);
  });

  it("hides the whole subtree of an invisible container", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("P", textAt("P", "page1", 0, 0, "a0", { visible: false }));
    s.nodes = s.nodes.set("C", textAt("C", "P", 3, 4));
    const f = fakeCtx();
    drawScene(f.ctx, s, identityCam);
    expect(f.fillText).toEqual([]);
  });

  it("does not draw a node unreachable from any page", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("orphan", textAt("orphan", "vanished", 0, 0));
    const f = fakeCtx();
    drawScene(f.ctx, s, identityCam);
    expect(f.fillText).toEqual([]);
  });

  it("leaves the ctx transform stack balanced", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("P", textAt("P", "page1", 100, 50));
    s.nodes = s.nodes.set("Q", textAt("Q", "P", 10, 20));
    s.nodes = s.nodes.set("R", textAt("R", "Q", 3, 4));
    const f = fakeCtx();
    drawScene(f.ctx, s, identityCam);
    expect(f.open()).toBe(0);
  });
});

// A FRAME IS DRAWN (unlike the group): its box filled with its
// fills, BEFORE the children (it is the artboard's background). If clipsContent, the children
// are clipped to the frame's box -- in the SAME local space in which they are
// drawn (the frame's origin is the children's origin), so the clip box
// is (0,0,width,height).
describe("drawScene with a frame", () => {
  beforeEach(() => { vi.stubGlobal("Path2D", FakePath2D); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("fills the frame's box (at its parent-space position) and still draws its children", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("F", frameNode("F", "page1", 20, 30, 100, 80, true));
    s.nodes = s.nodes.set("C", textAt("C", "F", 5, 5));
    const f = fakeCtx();
    drawScene(f.ctx, s, identityCam);
    // The frame's box is filled (a single fill: text does not go through fill).
    expect(f.fills.length).toBe(1);
    expect((f.fills[0].path as FakePath2D).ops).toEqual([{ op: "rect", args: [20, 30, 100, 80] }]);
    // And the children are drawn anyway, at their world position (inside F).
    expect(f.fillText.map((c) => c.text)).toEqual(["C"]);
  });

  it("draws a plain rect even if the frame carries a corner radius: a frame is rectangular", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("F", { ...frameNode("F", "page1", 0, 0, 100, 80, false), cornerRadius: 40 });
    const f = fakeCtx();
    drawScene(f.ctx, s, identityCam);
    expect((f.fills[0].path as FakePath2D).ops).toEqual([{ op: "rect", args: [0, 0, 100, 80] }]);
  });

  it("clips its children to its OWN local box when clipsContent", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("F", frameNode("F", "page1", 20, 30, 100, 80, true));
    s.nodes = s.nodes.set("C", textAt("C", "F", 5, 5));
    const f = fakeCtx();
    drawScene(f.ctx, s, identityCam);
    // The clip is at the LOCAL box (0,0,w,h) -- the children's space -- not at the frame's
    // x/y in the parent.
    expect(f.clips.length).toBe(1);
    expect((f.clips[0] as FakePath2D).ops).toEqual([{ op: "rect", args: [0, 0, 100, 80] }]);
  });

  it("does NOT clip when clipsContent is false: the children may overflow", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("F", frameNode("F", "page1", 20, 30, 100, 80, false));
    s.nodes = s.nodes.set("C", textAt("C", "F", 5, 5));
    const f = fakeCtx();
    drawScene(f.ctx, s, identityCam);
    expect(f.clips.length).toBe(0);
    expect(f.fillText.map((c) => c.text)).toEqual(["C"]); // drawn anyway
  });

  it("does not clip for a childless clipping frame (nothing to clip)", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("F", frameNode("F", "page1", 0, 0, 100, 80, true));
    const f = fakeCtx();
    drawScene(f.ctx, s, identityCam);
    expect(f.clips.length).toBe(0);
  });
});

// SCOPING TO THE CURRENT PAGE. The canvas shows ONE page at a time: what
// is DRAWN, what hit-test HITS and what the marquee TAKES all answer
// on the roots of the CURRENT page ONLY (rootsOf). currentPageId is a
// renderer parameter, not a scene field; absent it falls back to the first
// page (the store's default), which is the single-page behavior of the
// tests above.
describe("scoping to the current page", () => {
  // Two pages, one node per page, EXACTLY overlapping in the world
  // (both at (0,0), 50x50): the point (25,25) and a band over (0,0)-(50,50)
  // fall on both, so only the scoping decides which one answers.
  function twoPages(): SceneState {
    const s = emptyScene("d", "n");
    s.pages = [{ id: "page1", name: "Page 1" }, { id: "page2", name: "Page 2" }];
    s.nodes = s.nodes.set("a", rect("a", 0, 0, "a0")); // parentId "page1"
    s.nodes = s.nodes.set("b", childRect("b", "page2", 0, 0, "a0"));
    return s;
  }

  it("hitTest hits only the node of the current page", () => {
    const s = twoPages();
    expect(hitTest(s, 25, 25, Z1, "page1")).toBe("a");
    expect(hitTest(s, 25, 25, Z1, "page2")).toBe("b");
    // Default (no currentPageId): the FIRST page.
    expect(hitTest(s, 25, 25, Z1)).toBe("a");
  });

  it("nodesIntersecting takes only the nodes of the current page", () => {
    const s = twoPages();
    const band = { x: 0, y: 0, width: 50, height: 50 };
    expect(nodesIntersecting(s, band, "page1")).toEqual(["a"]);
    expect(nodesIntersecting(s, band, "page2")).toEqual(["b"]);
    expect(nodesIntersecting(s, band)).toEqual(["a"]);
  });

  it("drawScene draws only the roots of the current page", () => {
    const s = emptyScene("d", "n");
    s.pages = [{ id: "page1", name: "Page 1" }, { id: "page2", name: "Page 2" }];
    s.nodes = s.nodes.set("A", textAt("A", "page1", 0, 0));
    s.nodes = s.nodes.set("B", textAt("B", "page2", 0, 0));

    const f1 = fakeCtx();
    drawScene(f1.ctx, s, identityCam, "page1");
    expect(f1.fillText.map((c) => c.text)).toEqual(["A"]);

    const f2 = fakeCtx();
    drawScene(f2.ctx, s, identityCam, "page2");
    expect(f2.fillText.map((c) => c.text)).toEqual(["B"]);

    // Default: the first page.
    const f3 = fakeCtx();
    drawScene(f3.ctx, s, identityCam);
    expect(f3.fillText.map((c) => c.text)).toEqual(["A"]);
  });
});

describe("resizeCanvasToDisplaySize", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to DPR 1 when window is unavailable (no jsdom in this project)", () => {
    const canvas = fakeCanvas(800, 600);
    expect(resizeCanvasToDisplaySize(canvas)).toBe(true);
    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(600);
  });

  it("scales the backing store by devicePixelRatio and rounds", () => {
    vi.stubGlobal("window", { devicePixelRatio: 2.5 });
    const canvas = fakeCanvas(801, 600); // 801 * 2.5 = 2002.5 -> rounds to 2003
    expect(resizeCanvasToDisplaySize(canvas)).toBe(true);
    expect(canvas.width).toBe(2003);
    expect(canvas.height).toBe(1500);
  });

  it("returns false and leaves the backing store untouched when size is unchanged", () => {
    vi.stubGlobal("window", { devicePixelRatio: 2 });
    const canvas = fakeCanvas(400, 300, 800, 600); // already at CSS size * dpr
    expect(resizeCanvasToDisplaySize(canvas)).toBe(false);
    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(600);
  });

  it("returns true and resizes when only one dimension changed", () => {
    vi.stubGlobal("window", { devicePixelRatio: 1 });
    const canvas = fakeCanvas(400, 300, 400, 999);
    expect(resizeCanvasToDisplaySize(canvas)).toBe(true);
    expect(canvas.width).toBe(400);
    expect(canvas.height).toBe(300);
  });

  it("falls back to DPR 1 when window.devicePixelRatio is falsy (e.g. 0)", () => {
    vi.stubGlobal("window", { devicePixelRatio: 0 });
    const canvas = fakeCanvas(400, 300);
    resizeCanvasToDisplaySize(canvas);
    expect(canvas.width).toBe(400);
    expect(canvas.height).toBe(300);
  });
});

// --- images (track 3) --------------------------------------------------------

function imageNode(over: Partial<NodeLite> = {}): NodeLite {
  return { id: "i", parentId: "page1", orderKey: "a1", name: "Image", visible: true, opacity: 1,
    x: 10, y: 20, width: 320, height: 180, rotation: 0, fills: [], strokes: [], kind: "image", cornerRadius: 0, clipsContent: false,
    image: { assetHash: "abc" }, ...over };
}

// The fake ctx gains what the image branch needs. The placeholder is
// drawn with fillRect/strokeRect/moveTo and NOT with a Path2D of its own because
// it must remain verifiable here: jsdom has no Path2D.
function imageCtx() {
  const drawn: { src: unknown; x: number; y: number; w: number; h: number }[] = [];
  const fillRects: { x: number; y: number; w: number; h: number }[] = [];
  const strokeRects: { x: number; y: number; w: number; h: number }[] = [];
  const lines: { x: number; y: number }[] = [];
  const ctx = {
    canvas: { width: 800, height: 600 },
    fillStyle: "", strokeStyle: "", lineWidth: 0, globalAlpha: 1,
    setTransform: () => {},
    clearRect: () => {},
    fill: () => {},
    drawImage: (src: unknown, x: number, y: number, w: number, h: number) => {
      drawn.push({ src, x, y, w, h });
    },
    fillRect: (x: number, y: number, w: number, h: number) => { fillRects.push({ x, y, w, h }); },
    strokeRect: (x: number, y: number, w: number, h: number) => { strokeRects.push({ x, y, w, h }); },
    beginPath: () => {},
    moveTo: (x: number, y: number) => { lines.push({ x, y }); },
    lineTo: (x: number, y: number) => { lines.push({ x, y }); },
    stroke: () => {},
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, drawn, fillRects, strokeRects, lines };
}

function images(entry: CachedImage) {
  const asked: { docId: string; hash: string }[] = [];
  return {
    asked,
    source: {
      get(docId: string, hash: string) {
        asked.push({ docId, hash });
        return entry;
      },
    },
  };
}

const READY = { status: "ready", image: { naturalWidth: 40, naturalHeight: 20 } as HTMLImageElement } as CachedImage;

describe("drawScene: images", () => {
  it("draws the decoded image in the node's box", () => {
    const s = emptyScene("doc-1", "n");
    s.nodes = s.nodes.set("i", imageNode());
    const f = imageCtx();
    const src = images(READY);
    drawScene(f.ctx, s, { x: 0, y: 0, zoom: 1 } as Camera, { images: src.source });

    expect(f.drawn).toEqual([{ src: READY.image, x: 10, y: 20, w: 320, h: 180 }]);
    // The hash is requested for the scene's DOCUMENT: the same hash in
    // another document is another file.
    expect(src.asked).toEqual([{ docId: "doc-1", hash: "abc" }]);
    // No fill underneath: a gray rectangle behind an image with
    // transparency would show through.
    expect(f.fillRects).toEqual([]);
  });

  it("a MISSING asset becomes a visible placeholder, not an exception", () => {
    const s = emptyScene("doc-1", "n");
    s.nodes = s.nodes.set("i", imageNode());
    const f = imageCtx();
    const src = images({ status: "missing", image: null });

    expect(() =>
      drawScene(f.ctx, s, { x: 0, y: 0, zoom: 1 } as Camera, { images: src.source }),
    ).not.toThrow();

    expect(f.drawn).toEqual([]);
    expect(f.fillRects).toEqual([{ x: 10, y: 20, w: 320, h: 180 }]);
    expect(f.strokeRects.length).toBe(1);
    // The cross: two diagonals, that is four points. It is what distinguishes "missing"
    // from "loading", which would otherwise be the same gray rectangle.
    expect(f.lines.length).toBe(4);
  });

  it("an asset STILL LOADING is a placeholder WITHOUT a cross", () => {
    const s = emptyScene("doc-1", "n");
    s.nodes = s.nodes.set("i", imageNode());
    const f = imageCtx();
    const src = images({ status: "loading", image: null });
    drawScene(f.ctx, s, { x: 0, y: 0, zoom: 1 } as Camera, { images: src.source });

    expect(f.drawn).toEqual([]);
    expect(f.fillRects.length).toBe(1);
    expect(f.lines).toEqual([]);
  });

  it("the placeholder's border is ONE SCREEN PIXEL thick at every zoom", () => {
    // The ctx is transformed into world coordinates: a lineWidth in world units
    // would vanish at zoom 0.1 and become a fat border at zoom 8.
    const s = emptyScene("doc-1", "n");
    s.nodes = s.nodes.set("i", imageNode());
    for (const zoom of [0.25, 1, 4]) {
      const f = imageCtx();
      drawScene(f.ctx, s, { x: 0, y: 0, zoom } as Camera, {
        images: images({ status: "missing", image: null }).source,
      });
      expect(f.ctx.lineWidth).toBeCloseTo(1 / zoom);
    }
  });

  it("a degenerate image node draws nothing (like any shape without area)", () => {
    const s = emptyScene("doc-1", "n");
    s.nodes = s.nodes.set("i", imageNode({ width: 0 }));
    const f = imageCtx();
    drawScene(f.ctx, s, { x: 0, y: 0, zoom: 1 } as Camera, { images: images(READY).source });
    expect(f.drawn).toEqual([]);
    expect(f.fillRects).toEqual([]);
  });

  it("without an injected source it uses the shared cache, and does not throw", () => {
    // It is the REAL path (App.tsx injects nothing): in jsdom the image
    // never loads, so it stays "loading" -- but the loop must not die.
    const s = emptyScene("doc-1", "n");
    s.nodes = s.nodes.set("i", imageNode());
    const f = imageCtx();
    expect(() => drawScene(f.ctx, s, { x: 0, y: 0, zoom: 1 } as Camera)).not.toThrow();
    expect(f.drawn).toEqual([]);
  });
});

// --- INSTANCES (M4) ----------------------------------------------------------
//
// An instance renders the subtree of its MASTER, moved to the instance's
// origin, with per-node overrides. It is OPAQUE from outside: it is drawn, hit
// and taken with the marquee as ONE UNIT, never the master's single nodes.
// The masters here live under parentId "components", NOT reachable from page1:
// so they are not drawn on their own and only the virtual rendering of the
// instance is seen (exactly as a real component sits on a separate page).

function instanceNode(
  id: string, componentId: string, x: number, y: number,
  overrides: import("../store/types").InstanceOverrideLite[] = [], over: Partial<NodeLite> = {},
): NodeLite {
  return { ...rect(id, x, y, "a0"), kind: "instance", fills: [], instance: { componentId, overrides }, ...over };
}

// A ctx that RECORDS fillStyle at the time of the fill: it serves to observe that
// an override changes the COLOR of the overridden node only. jsdom has no Path2D,
// so the tests going through here stub FakePath2D.
function fillStyleCtx() {
  const fills: string[] = [];
  const ctx = {
    canvas: { width: 800, height: 600 },
    font: "", textBaseline: "", textAlign: "", fillStyle: "", strokeStyle: "",
    lineWidth: 0, globalAlpha: 1, lineCap: "", lineJoin: "",
    setTransform: () => {}, clearRect: () => {}, save: () => {}, restore: () => {},
    translate: () => {}, rotate: () => {}, transform: () => {},
    measureText: (s: string) => ({ width: s.length * 10 }),
    fill: () => { fills.push(ctx.fillStyle); },
    stroke: () => {}, clip: () => {}, fillText: () => {}, strokeText: () => {},
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, fills };
}

describe("drawScene with an instance", () => {
  it("draws the master subtree at the instance origin, shifted by -masterRoot.x/y", () => {
    const s = emptyScene("d", "n");
    // Master: a group at (20,10) with a text child at (5,5), outside page1.
    s.nodes = s.nodes.set("gm", { ...rect("gm", 20, 10, "a0"), kind: "group", parentId: "components", width: 0, height: 0 });
    s.nodes = s.nodes.set("tc", textAt("tc", "gm", 5, 5));
    s.components["comp"] = { rootNodeId: "gm", name: "Comp" };
    s.nodes = s.nodes.set("i", instanceNode("i", "comp", 100, 50));
    const f = fakeCtx();
    drawScene(f.ctx, s, identityCam);
    // The master's origin (20,10) lands on the instance's origin (100,50); the
    // child at (5,5) FROM the master ends up at (105,55). The rendering does not depend on WHERE
    // the master's root sits, only on the instance's origin.
    expect(f.fillText).toEqual([{ text: "tc", x: 105, y: 55 + ASCENT }]);
  });

  it("does not draw the master standalone when it is unreachable from the page", () => {
    // Only the instance is a child of page1; the master is not. A single rendering: the
    // virtual one. (If the master were on page1 it would appear TWICE, which is
    // correct -- but here we verify that the unreachable is not drawn.)
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("mt", textAt("mt", "components", 0, 0));
    s.components["comp"] = { rootNodeId: "mt", name: "Comp" };
    s.nodes = s.nodes.set("i", instanceNode("i", "comp", 100, 50));
    const f = fakeCtx();
    drawScene(f.ctx, s, identityCam);
    expect(f.fillText).toEqual([{ text: "mt", x: 100, y: 50 + ASCENT }]);
  });

  it("applies a TEXT override to the overridden node only, leaving siblings from the master", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("gm", { ...rect("gm", 0, 0, "a0"), kind: "group", parentId: "components", width: 0, height: 0 });
    s.nodes = s.nodes.set("mt", textAt("mt", "gm", 0, 0, "a0"));
    s.nodes = s.nodes.set("mt2", textAt("mt2", "gm", 0, 20, "a1"));
    s.components["comp"] = { rootNodeId: "gm", name: "Comp" };
    s.nodes = s.nodes.set("i", instanceNode("i", "comp", 0, 0, [{ masterNodeId: "mt", text: "OVR" }]));
    const f = fakeCtx();
    drawScene(f.ctx, s, identityCam);
    // mt overridden, mt2 from the master untouched.
    expect(f.fillText.map((c) => c.text)).toEqual(["OVR", "mt2"]);
  });

  it("applies a FILL override to the overridden node only", () => {
    vi.stubGlobal("Path2D", FakePath2D);
    try {
      const s = emptyScene("d", "n");
      s.nodes = s.nodes.set("gm", { ...rect("gm", 0, 0, "a0"), kind: "group", parentId: "components", width: 0, height: 0 });
      // Two black rectangles in the master; the override makes only the first RED.
      s.nodes = s.nodes.set("mr1", { ...rect("mr1", 0, 0, "a0"), parentId: "gm" });
      s.nodes = s.nodes.set("mr2", { ...rect("mr2", 0, 60, "a1"), parentId: "gm" });
      s.components["comp"] = { rootNodeId: "gm", name: "Comp" };
      s.nodes = s.nodes.set("i", instanceNode("i", "comp", 0, 0, [{ masterNodeId: "mr1", fills: [{ r: 1, g: 0, b: 0, a: 1 }] }]));
      const f = fillStyleCtx();
      drawScene(f.ctx, s, identityCam);
      // mr1 with the override's color, mr2 with the master's black.
      expect(f.fills).toEqual(["rgba(255, 0, 0, 1)", "rgba(0, 0, 0, 1)"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a missing component (or missing master) renders nothing", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("i", instanceNode("i", "nope", 100, 50));
    // component present but root absent
    s.nodes = s.nodes.set("j", instanceNode("j", "comp", 100, 50, [], { orderKey: "a1" }));
    s.components["comp"] = { rootNodeId: "gone", name: "Comp" };
    const f = fakeCtx();
    expect(() => drawScene(f.ctx, s, identityCam)).not.toThrow();
    expect(f.fillText).toEqual([]);
  });
});

describe("hitTest with an instance", () => {
  // Master: a 50x50 rectangle at (0,0), outside page1. The instance at (100,100)
  // renders its content at (100,100)-(150,150).
  function withInstance(): SceneState {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("mr", { ...rect("mr", 0, 0, "a0"), parentId: "components" });
    s.components["comp"] = { rootNodeId: "mr", name: "Comp" };
    s.nodes = s.nodes.set("i", instanceNode("i", "comp", 100, 100));
    return s;
  }

  it("a point over the instance content returns the INSTANCE id, never a master node", () => {
    const s = withInstance();
    expect(hitTest(s, 110, 110, Z1)).toBe("i");
  });

  it("a point outside the rendered content returns null (an instance has no box of its own)", () => {
    const s = withInstance();
    expect(hitTest(s, 200, 200, Z1)).toBeNull();
  });

  it("a missing component is not hit where its content would be", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("i", instanceNode("i", "nope", 100, 100));
    expect(hitTest(s, 110, 110, Z1)).toBeNull();
  });
});

describe("nodesIntersecting with an instance", () => {
  function withInstance(): SceneState {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("mr", { ...rect("mr", 0, 0, "a0"), parentId: "components" });
    s.components["comp"] = { rootNodeId: "mr", name: "Comp" };
    s.nodes = s.nodes.set("i", instanceNode("i", "comp", 100, 100));
    return s;
  }

  it("collects the instance by its derived bounds, returning the instance id", () => {
    const s = withInstance();
    expect(nodesIntersecting(s, { x: 105, y: 105, width: 10, height: 10 })).toEqual(["i"]);
  });

  it("does not collect the instance when the band misses its content", () => {
    const s = withInstance();
    expect(nodesIntersecting(s, { x: 300, y: 300, width: 10, height: 10 })).toEqual([]);
  });
});

// CYCLE: a component whose master (transitively) contains an instance of itself
// would recurse forever. The guard by componentId stops it; here
// we only verify that the three descents TERMINATE.
describe("instance cycle guard", () => {
  function selfRef(): SceneState {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("gs", { ...rect("gs", 0, 0, "a0"), kind: "group", parentId: "components", width: 0, height: 0 });
    s.nodes = s.nodes.set("ci", instanceNode("ci", "self", 0, 0, [], { parentId: "gs" }));
    s.components["self"] = { rootNodeId: "gs", name: "Self" };
    s.nodes = s.nodes.set("i", instanceNode("i", "self", 0, 0));
    return s;
  }

  it("draw, hit-test and marquee all terminate on a self-referential component", () => {
    const s = selfRef();
    const f = fakeCtx();
    expect(() => drawScene(f.ctx, s, identityCam)).not.toThrow();
    expect(hitTest(s, 10, 10, Z1)).toBeNull();
    expect(nodesIntersecting(s, { x: 0, y: 0, width: 100, height: 100 })).toEqual([]);
  });
});

// VARIANTS AND PROPERTIES: an instance renders the variant it has chosen, a text property
// sets the content of its text target, and a false boolean property hides its target --
// in drawing, hit-test and bounds alike (see-vs-select).
describe("an instance with variants and properties", () => {
  // The masters hold rectangles, which need Path2D (jsdom has none).
  beforeEach(() => { vi.stubGlobal("Path2D", FakePath2D); });
  afterEach(() => { vi.unstubAllGlobals(); });
  // Two masters outside page1: "Button" (default) and "Button hover", in the set "s"
  // (axis State), both with a text property Label and a boolean ShowIcon.
  function variants(): SceneState {
    const s = emptyScene("d", "n");
    const root = (id: string): NodeLite => ({ ...rect(id, 0, 0, "a0"), kind: "group", parentId: "components", width: 0, height: 0 });
    s.nodes = s.nodes
      .set("m1", root("m1")).set("l1", textAt("l1", "m1", 0, 0, "a0")).set("i1", { ...rect("i1", 300, 0, "a1"), parentId: "m1" })
      .set("m2", root("m2")).set("l2", textAt("l2", "m2", 0, 0, "a0")).set("i2", { ...rect("i2", 300, 0, "a1"), parentId: "m2" });
    s.componentSets = { s: { id: "s", name: "Button", axes: [{ name: "State", options: ["default", "hover"] }] } };
    const props = (label: string, icon: string) => [
      { name: "Label", type: "text" as const, defaultValue: "Button", targetNodeIds: [label] },
      { name: "ShowIcon", type: "boolean" as const, defaultValue: "true", targetNodeIds: [icon] },
    ];
    s.components = {
      c1: { rootNodeId: "m1", name: "Button", setId: "s", variant: { State: "default" }, properties: props("l1", "i1") },
      c2: { rootNodeId: "m2", name: "Button hover", setId: "s", variant: { State: "hover" }, properties: props("l2", "i2") },
    };
    return s;
  }
  const withInstance = (s: SceneState, instance: Partial<NonNullable<NodeLite["instance"]>>) => {
    s.nodes = s.nodes.set("i", { ...instanceNode("i", "c1", 0, 0), instance: { componentId: "c1", overrides: [], ...instance } });
    return s;
  };

  it("draws the master of the chosen variant", () => {
    const f = fakeCtx();
    drawScene(f.ctx, withInstance(variants(), {}), identityCam);
    expect(f.fillText.map((c) => c.text)).toEqual(["Button"]);
    const g = fakeCtx();
    // The label is the property's text, so both variants draw "Button"; tell them apart by the box.
    const s = withInstance(variants(), { variantProps: { State: "hover" } });
    s.nodes = s.nodes.set("l2", { ...s.nodes.at("l2"), x: 7 });
    drawScene(g.ctx, s, identityCam);
    expect(g.fillText[0].x).toBe(7);
  });

  it("a text property sets the content of the master's text node, by property name across variants", () => {
    const f = fakeCtx();
    drawScene(f.ctx, withInstance(variants(), { propertyValues: { Label: "Save" }, variantProps: { State: "hover" } }), identityCam);
    expect(f.fillText.map((c) => c.text)).toEqual(["Save"]);
  });

  it("an explicit override wins over the property", () => {
    const f = fakeCtx();
    drawScene(f.ctx, withInstance(variants(), { propertyValues: { Label: "Save" }, overrides: [{ masterNodeId: "l1", text: "Explicit" }] }), identityCam);
    expect(f.fillText.map((c) => c.text)).toEqual(["Explicit"]);
  });

  it("a false boolean property hides its target: not drawn, not hit, not in the bounds", () => {
    const shown = withInstance(variants(), {});
    const hidden = withInstance(variants(), { propertyValues: { ShowIcon: "false" } });
    // The icon is a 50x50 rect at (300,0) in the master, clear of the 200x40 label at (0,0).
    const a = fillStyleCtx();
    drawScene(a.ctx, shown, identityCam);
    const b = fillStyleCtx();
    drawScene(b.ctx, hidden, identityCam);
    expect(a.fills.length - b.fills.length).toBe(1);
    expect(hitTest(shown, 320, 20, Z1)).toBe("i");
    expect(hitTest(hidden, 320, 20, Z1)).toBeNull();
    expect(nodesIntersecting(shown, { x: 330, y: 10, width: 10, height: 10 })).toEqual(["i"]);
    expect(nodesIntersecting(hidden, { x: 330, y: 10, width: 10, height: 10 })).toEqual([]);
    expect(contentWorldBounds(shown, shown.nodes.at("i"))!.width).toBe(350);
    expect(contentWorldBounds(hidden, hidden.nodes.at("i"))!.width).toBe(200);
  });

  it("an invalid stored value falls back to the default instead of hiding", () => {
    const f = fakeCtx();
    drawScene(f.ctx, withInstance(variants(), { propertyValues: { ShowIcon: "perhaps", Label: "x".repeat(2000) } }), identityCam);
    expect(f.fillText.map((c) => c.text)).toEqual(["Button"]);
  });
});
