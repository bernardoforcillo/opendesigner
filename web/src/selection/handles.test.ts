import { describe, it, expect } from "vitest";
import {
  resizeBounds,
  hitTestHandle,
  handleScreenRects,
  cursorForHandle,
  resizeTransform,
  transformBounds,
  HANDLE_SIZE,
  HANDLE_IDS,
  ROTATE_CURSOR,
  cursorForFrameHit,
  handleScreenPoints,
  hitTestFrame,
  resizeRotatedBounds,
  applyFrameResize,
  applyFrameResizeToNode,
  resizeFrame,
  movingEdgeLines,
  rotateMarkerPositions,
  ROTATE_MARKER_OFFSET,
  ROTATE_MARKER_RADIUS,
  CORNER_IDS,
} from "./handles";
import { rotatedAabb } from "../canvas/transform";
import { unionBounds } from "../canvas/geometry";

const b = { x: 100, y: 100, width: 200, height: 100 };
const cam = { x: 0, y: 0, zoom: 1 };

describe("resizeBounds", () => {
  it("se grows width and height", () => {
    expect(resizeBounds(b, "se", 50, 25)).toEqual({ x: 100, y: 100, width: 250, height: 125 });
  });
  it("nw moves the origin and shrinks", () => {
    expect(resizeBounds(b, "nw", 20, 10)).toEqual({ x: 120, y: 110, width: 180, height: 90 });
  });
  it("edge handles touch one axis only", () => {
    expect(resizeBounds(b, "e", 30, 999)).toEqual({ x: 100, y: 100, width: 230, height: 100 });
    expect(resizeBounds(b, "n", 999, -10)).toEqual({ x: 100, y: 90, width: 200, height: 110 });
  });
  it("flips instead of producing a negative size", () => {
    // drag the left handle 250px to the right: it passes the right edge (x=300)
    const r = resizeBounds(b, "w", 250, 0);
    expect(r.width).toBeGreaterThan(0);
    expect(r.x).toBeCloseTo(300, 6);
    expect(r.width).toBeCloseTo(50, 6);
  });
  it("keepAspect preserves the original ratio on corner handles", () => {
    const r = resizeBounds(b, "se", 100, 0, { keepAspect: true });
    expect(r.width / r.height).toBeCloseTo(b.width / b.height, 6);
  });
});

describe("hitTestHandle", () => {
  it("finds the corner handle near the corner", () => {
    expect(hitTestHandle(b, cam, 100, 100)).toBe("nw");
    expect(hitTestHandle(b, cam, 300, 200)).toBe("se");
  });
  it("returns null well inside the box", () => {
    expect(hitTestHandle(b, cam, 200, 150)).toBeNull();
  });
  it("keeps a constant screen-space grab area when zoomed", () => {
    const zoomed = { x: 0, y: 0, zoom: 4 };
    // the nw handle remains grabbable within ~HANDLE_SIZE SCREEN px of the corner
    expect(hitTestHandle(b, zoomed, 400 + 3, 400 + 3)).toBe("nw");
  });
});

// --- additional coverage beyond the brief's minimum ---------------------------

describe("resizeBounds, other cases", () => {
  it("flips vertically too (n dragged past the bottom edge)", () => {
    const r = resizeBounds(b, "n", 0, 150); // top 100 -> 250, bottom still at 200
    expect(r).toEqual({ x: 100, y: 200, width: 200, height: 50 });
  });
  it("flips on both axes at once (nw dragged past the se corner)", () => {
    const r = resizeBounds(b, "nw", 250, 150);
    expect(r).toEqual({ x: 300, y: 200, width: 50, height: 50 });
  });
  it("a zero-delta drag leaves the bounds untouched, on every handle", () => {
    for (const h of HANDLE_IDS) expect(resizeBounds(b, h, 0, 0)).toEqual(b);
  });
  it("keepAspect on an edge handle scales the perpendicular axis too", () => {
    const r = resizeBounds(b, "e", 100, 0, { keepAspect: true });
    expect(r.width).toBeCloseTo(300, 6);
    expect(r.height).toBeCloseTo(150, 6);
    // the anchored side (left/top) does not move
    expect(r.x).toBeCloseTo(100, 6);
    expect(r.y).toBeCloseTo(100, 6);
  });
  it("keepAspect on a corner SHRINKS when the drag goes inward", () => {
    // se dragged 50px inward: without keepAspect it would give width 150.
    // With keepAspect it must shrink proportionally, NOT stay still:
    // with the max(|scale|) rule the still y axis's 1.0 won.
    const r = resizeBounds(b, "se", -50, 0, { keepAspect: true });
    expect(r).toEqual({ x: 100, y: 100, width: 150, height: 75 });
  });
  it("keepAspect on a corner: the axis dragged MORE commands, also shrinking", () => {
    // dx brings x to scale 0.5, dy brings y to scale 0.9: the 0.5 rules.
    const r = resizeBounds(b, "se", -100, -10, { keepAspect: true });
    expect(r).toEqual({ x: 100, y: 100, width: 100, height: 50 });
  });
  it("keepAspect on a corner: a shrink beats a smaller growth on the other axis", () => {
    // x grows by 10% (scale 1.1), y halves (scale 0.5): y rules.
    const r = resizeBounds(b, "se", 20, -50, { keepAspect: true });
    expect(r).toEqual({ x: 100, y: 100, width: 100, height: 50 });
  });
  it("keepAspect on the nw corner shrinks toward the anchored se corner", () => {
    const r = resizeBounds(b, "nw", 50, 0, { keepAspect: true });
    expect(r).toEqual({ x: 150, y: 125, width: 150, height: 75 });
  });
  it("keepAspect on a corner still grows by the more-dragged axis", () => {
    const r = resizeBounds(b, "se", 100, 0, { keepAspect: true });
    expect(r).toEqual({ x: 100, y: 100, width: 300, height: 150 });
  });
  it("keepAspect keeps the ratio through a flip", () => {
    const r = resizeBounds(b, "se", -300, 0, { keepAspect: true });
    expect(r.width / r.height).toBeCloseTo(b.width / b.height, 6);
    expect(r.width).toBeGreaterThan(0);
    expect(r.height).toBeGreaterThan(0);
  });
  it("degenerate bounds do not produce NaN (no division by zero)", () => {
    const flat = { x: 0, y: 0, width: 0, height: 50 };
    const r = resizeBounds(flat, "se", 10, 10, { keepAspect: true });
    expect(Number.isFinite(r.x)).toBe(true);
    expect(Number.isFinite(r.y)).toBe(true);
    expect(Number.isFinite(r.width)).toBe(true);
    expect(Number.isFinite(r.height)).toBe(true);
  });
});

describe("resizeTransform / transformBounds", () => {
  it("scales a sub-box relative to the group box (multi-selection resize)", () => {
    const group = { x: 0, y: 0, width: 100, height: 100 };
    const t = resizeTransform(group, "se", 100, 100); // doubles
    expect(transformBounds(group, t)).toEqual({ x: 0, y: 0, width: 200, height: 200 });
    expect(transformBounds({ x: 50, y: 50, width: 50, height: 50 }, t))
      .toEqual({ x: 100, y: 100, width: 100, height: 100 });
  });
  it("mirrors sub-boxes when the group flips", () => {
    const group = { x: 0, y: 0, width: 100, height: 100 };
    const t = resizeTransform(group, "w", 200, 0); // the left side passes the right one
    // the child that was on the left ends up to the right of the anchor (x=100)
    expect(transformBounds({ x: 0, y: 0, width: 20, height: 100 }, t))
      .toEqual({ x: 180, y: 0, width: 20, height: 100 });
  });
});

describe("handleScreenRects", () => {
  it("returns 8 HANDLE_SIZE squares centred on the screen-space bbox", () => {
    const rects = handleScreenRects(b, cam);
    expect(Object.keys(rects)).toHaveLength(8);
    expect(rects.nw).toEqual({ x: 100 - HANDLE_SIZE / 2, y: 100 - HANDLE_SIZE / 2, width: HANDLE_SIZE, height: HANDLE_SIZE });
    expect(rects.se).toEqual({ x: 300 - HANDLE_SIZE / 2, y: 200 - HANDLE_SIZE / 2, width: HANDLE_SIZE, height: HANDLE_SIZE });
    expect(rects.e).toEqual({ x: 300 - HANDLE_SIZE / 2, y: 150 - HANDLE_SIZE / 2, width: HANDLE_SIZE, height: HANDLE_SIZE });
  });

  it("keeps the squares the same SCREEN size at any zoom (only their position moves)", () => {
    const zoomed = handleScreenRects(b, { x: 0, y: 0, zoom: 4 });
    expect(zoomed.nw).toEqual({ x: 400 - HANDLE_SIZE / 2, y: 400 - HANDLE_SIZE / 2, width: HANDLE_SIZE, height: HANDLE_SIZE });
    expect(zoomed.se.width).toBe(HANDLE_SIZE);
  });
});

describe("hitTestHandle, other cases", () => {
  it("prefers a corner over an edge handle when both grab areas overlap (tiny box)", () => {
    const tiny = { x: 0, y: 0, width: 2, height: 2 };
    expect(hitTestHandle(tiny, cam, 0, 0)).toBe("nw");
  });
  it("finds the edge handles at the midpoints of the sides", () => {
    expect(hitTestHandle(b, cam, 200, 100)).toBe("n");
    expect(hitTestHandle(b, cam, 300, 150)).toBe("e");
    expect(hitTestHandle(b, cam, 200, 200)).toBe("s");
    expect(hitTestHandle(b, cam, 100, 150)).toBe("w");
  });
  it("returns null far outside the box", () => {
    expect(hitTestHandle(b, cam, 1000, 1000)).toBeNull();
  });
  it("accounts for the camera offset", () => {
    const panned = { x: 50, y: 20, zoom: 1 };
    expect(hitTestHandle(b, panned, 150, 120)).toBe("nw");
    expect(hitTestHandle(b, panned, 100, 100)).toBeNull();
  });
});

// --- rotation ----------------------------------------------------------------
// A FRAME is the selection bbox PLUS its rotation (degrees, clockwise,
// around the center -- see canvas/transform.ts). The handles live in the
// frame's LOCAL space: drawing and hitting them means rotating them with it.

function expectPoint(p: { x: number; y: number }, x: number, y: number) {
  expect(p.x).toBeCloseTo(x, 9);
  expect(p.y).toBeCloseTo(y, 9);
}

function expectBounds(b: { x: number; y: number; width: number; height: number }, x: number, y: number, w: number, h: number) {
  expect(b.x).toBeCloseTo(x, 9);
  expect(b.y).toBeCloseTo(y, 9);
  expect(b.width).toBeCloseTo(w, 9);
  expect(b.height).toBeCloseTo(h, 9);
}

// 100x50 at the origin: center (50, 25). With an identity camera the screen
// coordinates coincide with the world ones.
const small = { x: 0, y: 0, width: 100, height: 50 };

describe("handleScreenPoints", () => {
  it("is the plain handle grid when the frame is not rotated", () => {
    const p = handleScreenPoints({ bounds: small, rotation: 0 }, cam);
    expect(p.nw).toEqual({ x: 0, y: 0 });
    expect(p.e).toEqual({ x: 100, y: 25 });
    expect(p.s).toEqual({ x: 50, y: 50 });
  });

  it("carries the handles around with the frame: at +90 the east handle is due SOUTH", () => {
    const p = handleScreenPoints({ bounds: small, rotation: 90 }, cam);
    expectPoint(p.e, 50, 75);
    expectPoint(p.nw, 75, -25);
    expectPoint(p.se, 25, 75);
  });

  it("still scales and offsets with the camera", () => {
    const p = handleScreenPoints({ bounds: small, rotation: 90 }, { x: 10, y: 20, zoom: 2 });
    expectPoint(p.e, 10 + 50 * 2, 20 + 75 * 2);
  });
});

describe("hitTestFrame", () => {
  it("finds the resize handles of an unrotated frame exactly like hitTestHandle", () => {
    const f = { bounds: b, rotation: 0 };
    expect(hitTestFrame(f, cam, 100, 100)).toEqual({ kind: "resize", handle: "nw" });
    expect(hitTestFrame(f, cam, 300, 150)).toEqual({ kind: "resize", handle: "e" });
    expect(hitTestFrame(f, cam, 200, 150)).toBeNull(); // well inside the box
  });

  it("finds the resize handles WHERE THE ROTATION PUT THEM, not where the bbox says", () => {
    const f = { bounds: small, rotation: 90 };
    expect(hitTestFrame(f, cam, 50, 75)).toEqual({ kind: "resize", handle: "e" });
    // where the e handle used to be at rest there is now nothing
    expect(hitTestFrame(f, cam, 100, 25)).toBeNull();
  });

  it("gives the corner a rotate zone JUST OUTSIDE it", () => {
    const f = { bounds: b, rotation: 0 }; // se at (300, 200)
    expect(hitTestFrame(f, cam, 308, 208)).toEqual({ kind: "rotate", corner: "se" });
    expect(hitTestFrame(f, cam, 92, 92)).toEqual({ kind: "rotate", corner: "nw" });
    expect(hitTestFrame(f, cam, 308, 92)).toEqual({ kind: "rotate", corner: "ne" });
    expect(hitTestFrame(f, cam, 92, 208)).toEqual({ kind: "rotate", corner: "sw" });
  });

  it("the resize handle wins on the corner itself", () => {
    expect(hitTestFrame({ bounds: b, rotation: 0 }, cam, 300, 200))
      .toEqual({ kind: "resize", handle: "se" });
  });

  it("never steals a click from INSIDE the shape, however near the corner", () => {
    // 10px inside the box diagonally: outside the resize grab area, but
    // inside the box -- it must remain a click on the node, not a rotation.
    expect(hitTestFrame({ bounds: b, rotation: 0 }, cam, 290, 190)).toBeNull();
  });

  it("stops well before the empty canvas", () => {
    expect(hitTestFrame({ bounds: b, rotation: 0 }, cam, 330, 230)).toBeNull();
  });

  it("carries the rotate zone around with the frame too", () => {
    // Frame rotated by 90°: the se corner (local (100,50)) is at (25, 75), and its
    // outgoing diagonal points to (-1, +1) instead of (+1, +1).
    const f = { bounds: small, rotation: 90 };
    expect(hitTestFrame(f, cam, 25 - 8, 75 + 8)).toEqual({ kind: "rotate", corner: "se" });
    // in the direction the diagonal pointed at rest there is now nothing
    expect(hitTestFrame(f, cam, 25 + 12, 75 + 12)).toBeNull();
  });

  it("keeps both zones constant in SCREEN px at any zoom", () => {
    const zoomed = { x: 0, y: 0, zoom: 4 };
    const f = { bounds: b, rotation: 0 }; // se screen at (1200, 800)
    expect(hitTestFrame(f, zoomed, 1200, 800)).toEqual({ kind: "resize", handle: "se" });
    expect(hitTestFrame(f, zoomed, 1208, 808)).toEqual({ kind: "rotate", corner: "se" });
    expect(hitTestFrame(f, zoomed, 1230, 830)).toBeNull();
  });
});

describe("cursorForFrameHit", () => {
  it("keeps the resize cursors and gives rotation one of its own", () => {
    expect(cursorForFrameHit({ kind: "resize", handle: "nw" })).toBe(cursorForHandle("nw"));
    expect(cursorForFrameHit({ kind: "rotate", corner: "nw" })).toBe(ROTATE_CURSOR);
  });
});

describe("resizeRotatedBounds", () => {
  it("is resizeBounds, number for number, when the rotation is zero", () => {
    for (const h of HANDLE_IDS) {
      expect(resizeRotatedBounds(b, 0, h, 37, -11)).toEqual(resizeBounds(b, h, 37, -11));
      expect(resizeRotatedBounds(b, 0, h, 37, -11, { keepAspect: true }))
        .toEqual(resizeBounds(b, h, 37, -11, { keepAspect: true }));
    }
  });

  it("widens a 90-degree node along its OWN axis: the drag that counts is the one down the screen", () => {
    // e handle on a node rotated by 90°: its local x axis points down
    // on screen, so it is a VERTICAL drag that widens it.
    expectBounds(resizeRotatedBounds(small, 90, "e", 0, 30), -15, 15, 130, 50);
  });

  it("ignores the component of the drag across that axis", () => {
    // Same node, HORIZONTAL drag: on the handle's local e axis
    // there is no displacement, so the width does not change.
    const r = resizeRotatedBounds(small, 90, "e", 30, 0);
    expect(r.width).toBeCloseTo(100, 9);
    expect(r.height).toBeCloseTo(50, 9);
  });

  it("keeps the anchored edge nailed where it is IN THE WORLD", () => {
    // The anchor of the e handle is the west side: in world coordinates, for a
    // node at 90°, the point (50, -25). The resize must not move it.
    const before = { x: 50, y: -25 };
    const after = resizeRotatedBounds(small, 90, "e", 0, 30);
    // midpoint of the west side of the new box, brought back to the world
    const c = { x: after.x + after.width / 2, y: after.y + after.height / 2 };
    const dx = after.x - c.x;
    const dy = after.y + after.height / 2 - c.y;
    // rotation by +90 of (dx, dy) around c: (x,y) -> (-y, x)
    expectPoint({ x: c.x - dy, y: c.y + dx }, before.x, before.y);
  });

  it("still flips and still keeps the aspect ratio once rotated", () => {
    const flipped = resizeRotatedBounds(small, 90, "w", 0, 300); // past the anchor
    expect(flipped.width).toBeGreaterThan(0);
    expect(flipped.height).toBeGreaterThan(0);
    const kept = resizeRotatedBounds(small, 90, "se", 0, 100, { keepAspect: true });
    expect(kept.width / kept.height).toBeCloseTo(small.width / small.height, 9);
  });
});

// The DRAWN rotation handle. Before, nothing was drawn at all: the only
// affordance was the cursor on an invisible ring, i.e. no affordance.
describe("rotateMarkerPositions", () => {
  const box = { x: 0, y: 0, width: 100, height: 50 };

  it("puts one marker outside each corner, along its outgoing diagonal", () => {
    const m = rotateMarkerPositions(box);
    const d = ROTATE_MARKER_OFFSET;
    expect(m.nw).toEqual({ x: -d, y: -d });
    expect(m.ne).toEqual({ x: 100 + d, y: -d });
    expect(m.se).toEqual({ x: 100 + d, y: 50 + d });
    expect(m.sw).toEqual({ x: -d, y: 50 + d });
    expect(Object.keys(m)).toHaveLength(4);
  });

  // The invariant that holds the drawing and the hit-test together: if one day one
  // of the constants changes, it breaks HERE -- not in the user's hands, who
  // would see a sign that, when clicked, resizes or does nothing.
  it("draws only where it grabs: every pixel of every marker is that corner's rotate zone", () => {
    const f = { bounds: b, rotation: 0 };
    const m = rotateMarkerPositions(b); // identity camera: screen === world
    for (const id of CORNER_IDS) {
      expect(hitTestFrame(f, cam, m[id].x, m[id].y)).toEqual({ kind: "rotate", corner: id });
      for (let k = 0; k < 16; k++) {
        const a = (k * Math.PI) / 8;
        const x = m[id].x + Math.cos(a) * ROTATE_MARKER_RADIUS;
        const y = m[id].y + Math.sin(a) * ROTATE_MARKER_RADIUS;
        expect(hitTestFrame(f, cam, x, y)).toEqual({ kind: "rotate", corner: id });
      }
    }
  });
});

// The resize of a MULTIPLE selection that contains a ROTATED node. The group
// box is axis-aligned (see overlayRenderer::selectionFrame): the scale
// applies along the SCREEN axes, and a rotated member must be mapped by axes,
// not by scaling its local box.
describe("applyFrameResizeToNode", () => {
  it("is applyFrameResize, number for number, when the node is aligned with the frame", () => {
    const f = { bounds: b, rotation: 0 };
    for (const h of HANDLE_IDS) {
      const r = resizeFrame(f, h, 37, -11);
      const node = { x: 120, y: 110, width: 40, height: 20 };
      expect(applyFrameResizeToNode(node, 0, r)).toEqual({ bounds: applyFrameResize(node, r), rotation: 0 });
    }
  });

  // The review case, number by number. Group = A (0,0,100,50) at 90° +
  // B (200,0,50,50): the box sits on x [25,250], y [-25,75]. The
  // e handle is pulled by +225 (scale x2 horizontally, 1 vertically).
  it("grows a 90-degree member along the axis the pointer is really dragging", () => {
    const group = { x: 25, y: -25, width: 225, height: 100 };
    const r = resizeFrame({ bounds: group, rotation: 0 }, "e", 225, 0);
    const out = applyFrameResizeToNode({ x: 0, y: 0, width: 100, height: 50 }, 90, r);

    // the model box: 100x50 becomes 100x100 (the width follows the
    // VERTICAL screen axis, which the drag did not touch; the height follows
    // the horizontal one, doubled)
    expectBounds(out.bounds, 25, -25, 100, 100);
    expect(out.rotation).toBeCloseTo(90, 9);
  });

  it("keeps that member INSIDE the resized group frame (it used to overflow it)", () => {
    const group = { x: 25, y: -25, width: 225, height: 100 };
    const r = resizeFrame({ bounds: group, rotation: 0 }, "e", 225, 0);
    const after = transformBounds(group, r.transform);
    const out = applyFrameResizeToNode({ x: 0, y: 0, width: 100, height: 50 }, 90, r);
    const aabb = rotatedAabb(out.bounds, out.rotation);

    expect(aabb.x).toBeGreaterThanOrEqual(after.x - 1e-9);
    expect(aabb.y).toBeGreaterThanOrEqual(after.y - 1e-9);
    expect(aabb.x + aabb.width).toBeLessThanOrEqual(after.x + after.width + 1e-9);
    expect(aabb.y + aabb.height).toBeLessThanOrEqual(after.y + after.height + 1e-9);

    // and what it occupies REALLY grew horizontally, not vertically:
    // 50x100 -> 100x100 (before it became 50 wide and 200 tall)
    expect(aabb.width).toBeCloseTo(100, 9);
    expect(aabb.height).toBeCloseTo(100, 9);
  });

  // 90° is the EASY case: the axes swap and the mapped rectangle falls
  // exactly on the scaled AABB, so containment came for free. At 45°
  // it does not, and that is where round 1 still stuck out of the box. The review case,
  // number by number: 100x50 at 45° (AABB 106.07x106.07) + a straight neighbor,
  // e handle, kx=2, ky=1 (the box height is NEVER dragged).
  const at45 = () => {
    const node = { x: 0, y: 0, width: 100, height: 50 };
    const group = unionBounds([rotatedAabb(node, 45), { x: 200, y: 0, width: 50, height: 50 }])!;
    const r = resizeFrame({ bounds: group, rotation: 0 }, "e", group.width, 0);
    return { node, group, r, after: transformBounds(group, r.transform) };
  };

  it("keeps a 45-degree member inside the frame under a NON-uniform scale", () => {
    const { node, r, after } = at45();
    const out = applyFrameResizeToNode(node, 45, r);
    const aabb = rotatedAabb(out.bounds, out.rotation);

    expect(aabb.x).toBeGreaterThanOrEqual(after.x - 1e-9);
    expect(aabb.y).toBeGreaterThanOrEqual(after.y - 1e-9);
    expect(aabb.x + aabb.width).toBeLessThanOrEqual(after.x + after.width + 1e-9);
    expect(aabb.y + aabb.height).toBeLessThanOrEqual(after.y + after.height + 1e-9);

    // The REAL constraint, the one round 1 broke: the e handle did not
    // touch the box height, so it must not touch the member's either.
    // Before: 141.42 inside a box 106.07 tall (+33%).
    expect(aabb.height).toBeCloseTo(rotatedAabb(node, 45).height, 9);
    expect(aabb.height).toBeCloseTo(after.height, 9);
  });

  // The PRICE of containment, put in black and white: the member fills LESS
  // than its place along the dragged axis. If one day something better is found,
  // these numbers must change by hand -- not silently.
  it("pins what a 45-degree member becomes: contained, and under-filling the dragged axis", () => {
    const { node, r } = at45();
    const out = applyFrameResizeToNode(node, 45, r);

    // the AXES stay the mapped ones (26.565° = atan(1/2)): only the
    // lengths change, reduced by the factor 0.75 that puts the AABB back in its place
    expect(out.rotation).toBeCloseTo(26.56505117707799, 9);
    expect(out.bounds.width).toBeCloseTo(158.11388300841898 * 0.75, 9);
    expect(out.bounds.height).toBeCloseTo(79.05694150420948 * 0.75, 9);

    const aabb = rotatedAabb(out.bounds, out.rotation);
    // the reserved place is 212.13 wide: it occupies 132.58, and touches it at top
    // and bottom (where the place is 106.07)
    expect(aabb.width).toBeCloseTo(132.58252147247765, 9);
    expect(aabb.height).toBeCloseTo(106.06601717798212, 9);
    // the center stays the one mapped by the group transformation, intact
    expect(aabb.x + aabb.width / 2).toBeCloseTo(103.03300858899107, 9);
    expect(aabb.y + aabb.height / 2).toBeCloseTo(25, 9);
  });

  // The invariant, not a lucky case: ANY angle, ANY scale
  // (flips included). A member that starts inside the box stays there.
  it("never lets a member escape the frame, at any angle and any scale", () => {
    // The box is EXACTLY the node's AABB (the member touching all four
    // group edges -- the tightest case, and the only one that really
    // distinguishes: a small node in the center stays inside even when the
    // map is wrong).
    const node = { x: 0, y: 0, width: 100, height: 50 };
    for (let deg = 0; deg < 360; deg += 5) {
      const group = rotatedAabb(node, deg);
      // Fractions of the side, not px: the box changes size at every angle, and
      // a fixed delta would end up laying an edge EXACTLY on the anchor
      // (scale 0, i.e. a node truly squashed and not because of the
      // map). With the se handle: kx = 1 + fx, ky = 1 + fy.
      for (const [fx, fy] of [
        [1, 0], [0, 1], [3, -0.5], [-0.5, 3], [-2.5, 0], [0, -2.5], [-2.5, -4], [0.5, 0.5],
      ]) {
        const r = resizeFrame({ bounds: group, rotation: 0 }, "se", fx * group.width, fy * group.height);
        const after = transformBounds(group, r.transform);
        const out = applyFrameResizeToNode(node, deg, r);
        const aabb = rotatedAabb(out.bounds, out.rotation);
        const where = `deg=${deg} k=(${1 + fx},${1 + fy})`;
        expect(aabb.x, where).toBeGreaterThanOrEqual(after.x - 1e-6);
        expect(aabb.y, where).toBeGreaterThanOrEqual(after.y - 1e-6);
        expect(aabb.x + aabb.width, where).toBeLessThanOrEqual(after.x + after.width + 1e-6);
        expect(aabb.y + aabb.height, where).toBeLessThanOrEqual(after.y + after.height + 1e-6);
        // and it does not vanish: containing does not mean disappearing
        expect(out.bounds.width, where).toBeGreaterThan(0);
        expect(out.bounds.height, where).toBeGreaterThan(0);
      }
    }
  });

  it("leaves the angle alone (exactly) under a uniform scale", () => {
    const group = { x: 0, y: 0, width: 100, height: 100 };
    const r = resizeFrame({ bounds: group, rotation: 0 }, "se", 100, 100, { keepAspect: true });
    const out = applyFrameResizeToNode({ x: 0, y: 0, width: 40, height: 20 }, 30, r);

    expect(out.rotation).toBe(30); // not 29.999999999999996
    expectBounds(out.bounds, 0, 0, 80, 40);
  });

  it("MIRRORS the angle when the group flips: 30 degrees becomes 150", () => {
    const group = { x: 0, y: 0, width: 100, height: 100 };
    // e handle dragged 200px to the left: it passes the anchor (x=0) and flips
    const r = resizeFrame({ bounds: group, rotation: 0 }, "e", -200, 0);
    const out = applyFrameResizeToNode({ x: 0, y: 0, width: 40, height: 20 }, 30, r);

    expect(out.rotation).toBeCloseTo(150, 9);
    // a mirror does not deform: the measurements stay the same
    expect(out.bounds.width).toBeCloseTo(40, 9);
    expect(out.bounds.height).toBeCloseTo(20, 9);
    // and the center goes to the other side of the anchor
    expect(out.bounds.x + out.bounds.width / 2).toBeCloseTo(-20, 9);
  });

  it("swaps the axes at 90 degrees whichever handle is dragged", () => {
    const group = { x: 0, y: 0, width: 100, height: 100 };
    const r = resizeFrame({ bounds: group, rotation: 0 }, "s", 0, 100); // scala y x2
    const out = applyFrameResizeToNode({ x: 0, y: 0, width: 40, height: 20 }, 90, r);
    // at 90° the local x axis points along the screen DOWN: it is the width that
    // doubles, not the height
    expect(out.bounds.width).toBeCloseTo(80, 9);
    expect(out.bounds.height).toBeCloseTo(20, 9);
  });
});

// --- movingEdgeLines ---------------------------------------------------------
//
// The table from which the resize snap decides WHICH lines may
// snap (see tools/selectTool.ts::resizeDelta). Getting one wrong is never visible
// directly -- the box grows anyway -- but it makes the FIXED edge snap,
// i.e. the anchor: the node MOVES instead of resizing, and the only
// point the resize promises not to move moves.
describe("movingEdgeLines", () => {
  // Four edges all different, so a left/right or top/bottom swap
  // cannot go unnoticed: left 10, right 110, top 20, bottom 60.
  const box = { x: 10, y: 20, width: 100, height: 40 };

  it("names the exact edges of each of the eight handles", () => {
    expect(movingEdgeLines(box, "nw")).toEqual({ x: [10], y: [20] });
    expect(movingEdgeLines(box, "n")).toEqual({ x: [], y: [20] });
    expect(movingEdgeLines(box, "ne")).toEqual({ x: [110], y: [20] });
    expect(movingEdgeLines(box, "e")).toEqual({ x: [110], y: [] });
    expect(movingEdgeLines(box, "se")).toEqual({ x: [110], y: [60] });
    expect(movingEdgeLines(box, "s")).toEqual({ x: [], y: [60] });
    expect(movingEdgeLines(box, "sw")).toEqual({ x: [10], y: [60] });
    expect(movingEdgeLines(box, "w")).toEqual({ x: [10], y: [] });
  });

  // THE REAL GUARD: the table is anchored to the resize math instead of
  // a second hand-written list. If MOVES and movingEdgeLines
  // drifted apart (a left/right swap, a forgotten edge), here the
  // declared edge would no longer be what the drag really moves.
  it("names exactly the edges that a drag on that handle MOVES, and no others", () => {
    for (const h of HANDLE_IDS) {
      // Small delta on both axes: no flip, and every axis
      // the handle touches really moves.
      const out = resizeBounds(box, h, 7, 5);
      const moved = { x: [] as number[], y: [] as number[] };
      if (out.x !== box.x) moved.x.push(box.x);
      if (out.x + out.width !== box.x + box.width) moved.x.push(box.x + box.width);
      if (out.y !== box.y) moved.y.push(box.y);
      if (out.y + out.height !== box.y + box.height) moved.y.push(box.y + box.height);
      expect({ handle: h, ...movingEdgeLines(box, h) }).toEqual({ handle: h, ...moved });
    }
  });

  it("never offers the CENTRE — it moves by half a delta, so snapping it would move an anchored edge", () => {
    const cx = box.x + box.width / 2; // 60
    const cy = box.y + box.height / 2; // 40
    for (const h of HANDLE_IDS) {
      const lines = movingEdgeLines(box, h);
      expect(lines.x).not.toContain(cx);
      expect(lines.y).not.toContain(cy);
    }
  });
});

describe("cursorForHandle", () => {
  it("maps opposite handles to the same diagonal/axial cursor", () => {
    expect(cursorForHandle("nw")).toBe(cursorForHandle("se"));
    expect(cursorForHandle("ne")).toBe(cursorForHandle("sw"));
    expect(cursorForHandle("n")).toBe(cursorForHandle("s"));
    expect(cursorForHandle("e")).toBe(cursorForHandle("w"));
    expect(cursorForHandle("nw")).toBe("nwse-resize");
    expect(cursorForHandle("ne")).toBe("nesw-resize");
    expect(cursorForHandle("n")).toBe("ns-resize");
    expect(cursorForHandle("e")).toBe("ew-resize");
  });
});
