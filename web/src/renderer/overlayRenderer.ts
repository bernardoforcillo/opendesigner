import type { SceneState } from "../store/types";
import { type Camera, worldToScreen } from "../canvas/camera";
import { type Bounds, unionBounds, worldBoundsToScreen } from "../canvas/geometry";
import { contentWorldBounds, isGroup } from "../store/groups";
import { isInstance } from "../store/instances";
import { applyTransform, worldBoundsOfNode, worldTransformOf } from "../canvas/transform";
import { gridBands, gridLines } from "../store/layoutGrids";
import type { SnapGuide } from "../selection/snap";
import {
  CORNER_IDS,
  HANDLE_SIZE,
  handlePositions,
  ROTATE_CORNER_DIRS,
  ROTATE_MARKER_RADIUS,
  rotateMarkerPositions,
  type SelectionFrame,
} from "../selection/handles";
import {
  anchorPoint,
  hasInHandle,
  hasOutHandle,
  inHandlePoint,
  outHandlePoint,
} from "../store/vectorGeometry";
import type { PenPreview, PointLite } from "../store/vectorGeometry";
import { themeColors, withAlpha } from "./themeColors";

// The handles' geometry (positions, hit-test, resize) is ONE only and lives
// in selection/handles.ts: here we only draw. Re-exported because the
// renderer remains the natural entry point for whoever draws the overlay.
export {
  HANDLE_SIZE, handlePositions, ROTATE_MARKER_OFFSET, ROTATE_MARKER_RADIUS, rotateMarkerPositions,
  type HandleId, type SelectionFrame,
} from "../selection/handles";
export { worldBoundsToScreen } from "../canvas/geometry";

const DEG_TO_RAD = Math.PI / 180;
const TAU = Math.PI * 2;

// Opening of the rotation marker's arc: a quarter turn, facing the
// corner. A closed circle would read as another handle; an open
// arc is the sign with which editors say "rotate".
const ROTATE_ARC_GAP = Math.PI / 2;
const ROTATE_MARKER_WIDTH = 1.5;

// Snap guides are MAGENTA and not in the accent blue like the rest of the
// overlay, on purpose: blue says "this is selected", magenta says
// "this is the line you are snapping to". They are two different pieces of information and
// appear together -- with the same color the guide would read as another
// edge of the box. A warm magenta and not the previous red: red is the system's
// for "error" (danger), and a guide is not an error. The color lives in
// themeColors (one per theme, legible on light and dark canvas).
const SNAP_GUIDE_WIDTH = 1;

function devicePixelRatio(): number {
  return typeof window !== "undefined" && window.devicePixelRatio ? window.devicePixelRatio : 1;
}

// The interface blue (--accent token, resolved by themeColors): selection
// bbox, handles, marquee and the path in progress all speak the same language.
// A single source, so it cannot become two, and it follows the theme.

// A little square with rounded corners (2px). Where the context has no
// roundRect (the tests' fake ctxs, old browsers) it is the usual square: same
// geometry, just sharp corners.
function roundedSquare(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, fill: string, stroke: string): void {
  ctx.fillStyle = fill;
  ctx.strokeStyle = stroke;
  if (typeof ctx.roundRect === "function") {
    ctx.beginPath();
    ctx.roundRect(x + 0.5, y + 0.5, size - 1, size - 1, 2);
    ctx.fill();
    ctx.stroke();
    return;
  }
  ctx.fillRect(x, y, size, size);
  ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
}

// Side (SCREEN px) of a PEN TOOL anchor's little square. Smaller
// than the resize handles (HANDLE_SIZE = 8) on purpose: they are two different
// targets and must not look the same -- one resizes the box, the other
// is a point of the geometry.
export const PEN_ANCHOR_SIZE = 6;

// GRAB radius (SCREEN px) of the first anchor: how close the click that CLOSES
// the outline must land. More generous than the drawn little square,
// exactly as HANDLE_GRAB_PADDING is for the resize handles (6px are
// too few to hit with the mouse), and in SCREEN px because the grab must stay the
// same at every zoom level. tools/penTool.ts reads it: drawing and grab
// must come from the same place, or the target is no longer what is
// seen.
export const PEN_ANCHOR_GRAB_PX = 6;

// Radius (SCREEN px) of the dot at the tip of a bézier handle.
const PEN_HANDLE_DOT = 3;

// The dash pattern of the PENDING segment (the one following the cursor). Dashed
// and not a solid tint because that piece is not geometry yet: no click has
// placed it, and drawing it identical to the rest would promise a curve that
// the document does not contain.
const PEN_PENDING_DASH = [4, 3];

// The preview's anchors are already in WORLD coordinates (the node does not exist
// yet, so there is no origin to measure them from): the reading of the
// two-space rule remains vectorGeometry's, with origin at zero.
const PEN_ORIGIN = { x: 0, y: 0 };

// The path the pen tool is drawing, in SCREEN space like everything else
// in the overlay.
//
// The four control points of each segment are converted ONE BY ONE with
// worldToScreen and the bézier is drawn on screen: it is exact, not
// an approximation, because the camera transform is affine (uniform
// scale + translation) and Bézier curves are affine-covariant --
// transforming the controls transforms the curve. The advantage is that the stroke
// stays 1px at every zoom, like the selection handles.
function drawPenPreview(ctx: CanvasRenderingContext2D, cam: Camera, pen: PenPreview): void {
  const anchors = pen.anchors;
  const n = anchors.length;
  if (n === 0) return;
  const to = (p: PointLite) => worldToScreen(cam, p.x, p.y);
  const { accent: ACCENT } = themeColors();

  ctx.lineWidth = 1;
  ctx.strokeStyle = ACCENT;

  // 1. The outline already placed. A single anchor has no segments: only its
  //    little square is seen.
  //
  //    If the preview is CLOSED there is one more segment, the return one
  //    (last -> first): same loop, target index modulo n --
  //    identical to renderer/shapes.ts::traceSubpath, because it is the same
  //    geometry and must come from the same rule. It is the segment the
  //    closing drag is shaping (it pulls the INCOMING handle of the
  //    first anchor, that is the second control point of THIS curve):
  //    without drawing it, of that drag only the little stick
  //    and the dot would be seen, and the curve would appear only once the node is created.
  if (n > 1) {
    const segments = pen.closed ? n : n - 1;
    ctx.beginPath();
    const start = to(anchorPoint(PEN_ORIGIN, anchors[0]));
    ctx.moveTo(start.x, start.y);
    for (let i = 1; i <= segments; i++) {
      const a = anchors[i - 1];
      const b = anchors[i % n];
      const c1 = to(outHandlePoint(PEN_ORIGIN, a));
      const c2 = to(inHandlePoint(PEN_ORIGIN, b));
      const p = to(anchorPoint(PEN_ORIGIN, b));
      ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, p.x, p.y);
    }
    ctx.stroke();
  }

  // 2. The segment that would follow the cursor. The endpoint has no
  //    handle, so the second control falls on it: it is exactly the
  //    curve one would get by placing a corner anchor there, not a
  //    straight approximation.
  if (pen.next) {
    const last = anchors[n - 1];
    const a = to(anchorPoint(PEN_ORIGIN, last));
    const c1 = to(outHandlePoint(PEN_ORIGIN, last));
    const end = to(pen.next);
    ctx.setLineDash(PEN_PENDING_DASH);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.bezierCurveTo(c1.x, c1.y, end.x, end.y, end.x, end.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 3. The handles of the anchor being dragged: the stick up
  //    to the control point and its dot. Only the EXISTING ones (non-zero
  //    offset): a zero handle coincides with the anchor, and drawing it
  //    would be a dot over the little square that means nothing.
  const active = pen.active === null ? null : anchors[pen.active];
  if (active) {
    const c = to(anchorPoint(PEN_ORIGIN, active));
    const ends: PointLite[] = [];
    if (hasInHandle(active)) ends.push(inHandlePoint(PEN_ORIGIN, active));
    if (hasOutHandle(active)) ends.push(outHandlePoint(PEN_ORIGIN, active));
    for (const end of ends) {
      const p = to(end);
      ctx.beginPath();
      ctx.moveTo(c.x, c.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(p.x, p.y, PEN_HANDLE_DOT, 0, Math.PI * 2);
      ctx.fillStyle = ACCENT;
      ctx.fill();
    }
  }

  // 4. The anchors' little squares, on top of everything else. The FIRST is filled:
  //    it is the target that CLOSES the outline, and it must stand out from the others
  //    even before the pointer gets over it.
  const half = PEN_ANCHOR_SIZE / 2;
  for (let i = 0; i < n; i++) {
    const p = to(anchorPoint(PEN_ORIGIN, anchors[i]));
    // (+0.5 inside roundedSquare, as for the selection handles: the 1px stroke
    // lands on a crisp pixel boundary instead of smearing over two rows.)
    roundedSquare(ctx, p.x - half, p.y - half, PEN_ANCHOR_SIZE, i === 0 ? ACCENT : "#ffffff", ACCENT);
  }
}

// Union (in WORLD coordinates) of the bounds of the selected nodes. GEOMETRY, not
// the painted result: the stroke does NOT enter here, on purpose -- the box is the frame on
// which the handles live and the resize writes precisely to x/y/width/height, so
// including the stroke overhang would detach the handles from the edge. null if
// the selection is empty or no longer points to existing nodes -- the store already removes
// vanished ids (see store.ts), but this stays defensive so the overlay does not
// blow up on an incoherent transient state. Testable without ctx/DOM.
//
// WORLD bounds and not the model's: the model's box is written in the
// PARENT's space, while everything downstream from here (the frame, the handles, their
// hit-test) works in world and then in screen. For a child of a
// page the two coincide, and it is what keeps existing documents unchanged.
//
// contentWorldBounds and not worldBoundsOfNode: a GROUP has no box of its own
// (store/groups.ts), its bounds are the union of the children. Reading its box
// would give a 0x0 rectangle at the group's origin -- frame and handles
// in the wrong corner of the screen, on a group that is perfectly visible.
// An empty group contributes nothing (null), exactly like a vanished id.
// contentWorldBounds also clips to ancestor frames with clipsContent (a
// deliberate T1 fix), so the handles do not end up on empty canvas beyond the
// edge of a clipping frame. The ONE-node case, where its own rotation is needed,
// is handled separately by selectionFrame (boundsOfNode + rotation).
export function selectionWorldBounds(state: SceneState, selection: string[]): Bounds | null {
  const boxes: Bounds[] = [];
  for (const id of selection) {
    const n = state.nodes.at(id);
    if (!n) continue;
    const b = contentWorldBounds(state, n);
    if (b) boxes.push(b);
  }
  return unionBounds(boxes);
}

// The selection FRAME: the rectangle on which the handles live PLUS its
// angle. The convention, which holds everywhere (overlay, hit-test, resize):
//
//  - A SINGLE node: the frame is its UNROTATED box with ITS rotation, so
//    the handles sit on its true sides and the resize works in its local
//    space (dragging the handle widens it along its own axis).
//  - SEVERAL nodes: the frame is AXIS-ALIGNED around what the nodes
//    really occupy. There is no common angle for nodes rotated differently, and
//    inventing one (the first's? the average's?) would make the group
//    resize unpredictable. The single nodes stay rotated; it is the
//    group box that is not.
export function selectionFrame(state: SceneState, selection: string[]): SelectionFrame | null {
  const nodes = selection.map((id) => state.nodes.at(id)).filter((n) => n !== undefined);
  if (nodes.length === 0) return null;
  if (nodes.length === 1) {
    const n = nodes[0];
    // A GROUP has no box of its own: the frame is the union of the VISIBLE children
    // (contentWorldBounds, clip-aware), null when there is nothing to
    // frame (empty group or with all children hidden) -- so the overlay
    // draws neither frame nor handles on empty canvas.
    // An INSTANCE, like a group, has no box of its own: the frame is that of the
    // master's content (contentWorldBounds), axis-aligned -- its own
    // rotation is already baked into that box (store/groups.ts::
    // instanceContentBounds), so rotation 0 here, as for a group.
    if (isGroup(n) || isInstance(n)) {
      const b = contentWorldBounds(state, n);
      return b ? { bounds: b, rotation: 0 } : null;
    }
    // Any other node: its UNROTATED box in WORLD (worldBoundsOfNode uses
    // the PARENT's transform), and its rotation separately -- the overlay rotates
    // the frame around the center. For a page child the world box coincides
    // with the model's box; for a nested node it does not.
    return { bounds: worldBoundsOfNode(state, n), rotation: n.rotation };
  }
  const bounds = selectionWorldBounds(state, selection);
  return bounds ? { bounds, rotation: 0 } : null;
}

// Draws the selection bbox, its 8 handles, the marquee rectangle
// and the path the pen tool is drawing -- ALL in SCREEN space (CSS px).
// Unlike drawScene,
// here cam.zoom is NOT applied to the canvas transform: the world
// bounds are converted by hand via worldToScreen before drawing, so
// borders (1px) and handles (8px) stay constant size at every zoom
// level. The only transform applied is the scale for devicePixelRatio,
// needed because the canvas backing store is in physical pixels.
//
// The frame's ROTATION is the exception, and it is applied as in drawScene: to the
// CONTEXT, around the box center in screen px. The box and the
// little squares stay drawn with the exact same geometry as before --
// just rotated with the node. The camera is a similarity, so the world
// angle and the screen angle coincide and the handles do NOT deform with
// zoom. The marquee stays outside the transform: it is always axis-aligned.
// The snap GUIDES (in world coordinates, see selection/snap.ts) are drawn
// last and OUTSIDE any frame rotation: a guide is by
// definition a line of the screen -- it is the line on which the edges coincide
// -- and rotating it with the node would make it just any line.
// The layout grids of every frame that has them, drawn under the selection. They are editor
// guides: nothing here is exported. Coordinates are the frame's own, taken to the screen
// through its world transform, so a frame inside a rotated parent shows its grid turned too.
function drawLayoutGrids(ctx: CanvasRenderingContext2D, state: SceneState, cam: Camera): void {
  const dpr = devicePixelRatio();
  const viewW = ctx.canvas.width / dpr;
  const viewH = ctx.canvas.height / dpr;
  for (const n of state.nodes.values()) {
    if (n.kind !== "frame" || !n.visible || !n.layoutGrids || n.layoutGrids.length === 0) continue;
    const t = worldTransformOf(state, n.id);
    const px = (x: number, y: number) => {
      const w = applyTransform(t, x, y);
      return worldToScreen(cam, w.x, w.y);
    };
    const box = worldBoundsToScreen(worldBoundsOfNode(state, n), cam);
    if (box.x > viewW || box.y > viewH || box.x + box.width < 0 || box.y + box.height < 0) continue;
    const quad = (x0: number, y0: number, x1: number, y1: number) => {
      const a = px(x0, y0), b = px(x1, y0), c = px(x1, y1), d = px(x0, y1);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineTo(c.x, c.y);
      ctx.lineTo(d.x, d.y);
      ctx.closePath();
    };
    for (const g of n.layoutGrids) {
      const css = `rgb(${Math.round(g.color.r * 255)} ${Math.round(g.color.g * 255)} ${Math.round(g.color.b * 255)} / ${g.color.a})`;
      if (g.kind === "grid") {
        // Lines closer than 4 screen px are noise: the grid is not drawn that small.
        if (g.size * cam.zoom < 4) continue;
        ctx.strokeStyle = css;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (const x of gridLines(g, n.width)) {
          const a = px(x, 0), b = px(x, n.height);
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
        }
        for (const y of gridLines(g, n.height)) {
          const a = px(0, y), b = px(n.width, y);
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
        }
        ctx.stroke();
        continue;
      }
      ctx.fillStyle = css;
      for (const band of gridBands(g, g.kind === "columns" ? n.width : n.height)) {
        if (g.kind === "columns") quad(band.start, 0, band.end, n.height);
        else quad(0, band.start, n.width, band.end);
        ctx.fill();
      }
    }
  }
}

export function drawOverlay(
  ctx: CanvasRenderingContext2D,
  state: SceneState,
  cam: Camera,
  selection: string[],
  marquee: Bounds | null,
  guides: readonly SnapGuide[] = [],
  // The pen tool's path in progress (store::penPreview). Optional because it is
  // PREVIEW and not document: whoever is not drawing has none, and callers that
  // do not know the pen tool remain valid.
  pen: PenPreview | null = null,
  // The Link tool's rubber band, also PREVIEW: a dashed line from the node it starts from.
  link: { from: Bounds; x: number; y: number } | null = null,
): void {
  const { canvas } = ctx;
  const dpr = devicePixelRatio();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const { accent: ACCENT, guide: SNAP_GUIDE_COLOR } = themeColors();

  drawLayoutGrids(ctx, state, cam);

  const frame = selectionFrame(state, selection);
  if (frame) {
    const box = worldBoundsToScreen(frame.bounds, cam);
    const rotated = frame.rotation % 360 !== 0;
    if (rotated) {
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(frame.rotation * DEG_TO_RAD);
      ctx.translate(-cx, -cy);
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = ACCENT;
    // +0.5 so the 1px stroke lands on a crisp pixel boundary instead of
    // smearing over two rows (the classic canvas 2D trick).
    ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.width, box.height);

    const half = HANDLE_SIZE / 2;
    for (const p of Object.values(handlePositions(box))) {
      // WHITE square with an accent border and 2px corners, on both themes:
      // the handles sit above the design (which is light even in dark), not
      // above the interface.
      roundedSquare(ctx, p.x - half, p.y - half, HANDLE_SIZE, "#ffffff", ACCENT);
    }
    // The ROTATION HANDLE: an open arc just OUTSIDE each corner,
    // inside the grab zone that selection/handles.ts::hitTestFrame already
    // recognizes (same geometry, a single source -- see
    // rotateMarkerPositions). Not a little square: that means "drag to
    // resize", and here nothing is resized. The opening faces
    // the box, so the mark "hugs" the corner that rotates.
    const markers = rotateMarkerPositions(box);
    ctx.lineWidth = ROTATE_MARKER_WIDTH;
    ctx.strokeStyle = ACCENT;
    for (const id of CORNER_IDS) {
      const p = markers[id];
      const d = ROTATE_CORNER_DIRS[id];
      // INWARD: the direction opposite to the outgoing diagonal.
      const inward = Math.atan2(-d.y, -d.x);
      ctx.beginPath();
      ctx.arc(p.x, p.y, ROTATE_MARKER_RADIUS, inward + ROTATE_ARC_GAP / 2, inward - ROTATE_ARC_GAP / 2 + TAU);
      ctx.stroke();
    }
    if (rotated) ctx.restore();
  }

  if (marquee) {
    const m = worldBoundsToScreen(marquee, cam);
    ctx.fillStyle = withAlpha(ACCENT, 0.08);
    ctx.fillRect(m.x, m.y, m.width, m.height);
    ctx.lineWidth = 1;
    ctx.strokeStyle = ACCENT;
    ctx.strokeRect(m.x + 0.5, m.y + 0.5, m.width, m.height);
  }

  if (guides.length > 0) {
    ctx.lineWidth = SNAP_GUIDE_WIDTH;
    ctx.strokeStyle = SNAP_GUIDE_COLOR;
    for (const g of guides) {
      // The endpoints go through the camera like any other coordinate: the line
      // lives in the WORLD, the segment on screen. The +0.5 on the constant
      // coordinate only is the same trick as the box's (a 1px stroke
      // on a crisp pixel boundary instead of smeared over two rows).
      const a = worldToScreen(cam, g.axis === "x" ? g.pos : g.from, g.axis === "x" ? g.from : g.pos);
      const b = worldToScreen(cam, g.axis === "x" ? g.pos : g.to, g.axis === "x" ? g.to : g.pos);
      ctx.beginPath();
      if (g.axis === "x") {
        ctx.moveTo(a.x + 0.5, a.y);
        ctx.lineTo(b.x + 0.5, b.y);
      } else {
        ctx.moveTo(a.x, a.y + 0.5);
        ctx.lineTo(b.x, b.y + 0.5);
      }
      ctx.stroke();
    }
  }

  // Last: the path in progress sits ABOVE the selection (usually they do not
  // coexist -- the pen tool does not select until it has finished -- but when
  // it happens it is the drawing in progress that must stay legible).
  if (pen) drawPenPreview(ctx, cam, pen);
  if (link) {
    const a = worldToScreen(cam, link.from.x + link.from.width / 2, link.from.y + link.from.height / 2);
    const b = worldToScreen(cam, link.x, link.y);
    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = ACCENT;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.restore();
  }
}

const NODE_SIZE = 7;

/**
 * The node tool's view of the selected vector: every anchor as a small square (the selected one
 * filled), the handles of the selected anchor as lines ending in dots. Drawn above everything else
 * while the tool is active; the geometry is read from the node, never stored.
 */
export function drawNodeEdit(
  ctx: CanvasRenderingContext2D, state: SceneState, cam: Camera, selection: readonly string[], sel: { sub: number; index: number } | null,
): void {
  if (selection.length !== 1) return;
  const n = state.nodes.get(selection[0]);
  if (!n || n.kind !== "vector" || !n.vector || n.rotation % 360 !== 0) return;
  const dpr = devicePixelRatio();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const { accent } = themeColors();
  const at = (x: number, y: number) => worldToScreen(cam, n.x + x, n.y + y);
  ctx.lineWidth = 1;
  n.vector.subpaths.forEach((sp, si) => {
    sp.anchors.forEach((a, ai) => {
      const p = at(a.x, a.y);
      const selected = sel !== null && sel.sub === si && sel.index === ai;
      if (selected) {
        ctx.strokeStyle = accent;
        ctx.fillStyle = accent;
        for (const [hx, hy] of [[a.inX, a.inY], [a.outX, a.outY]] as const) {
          if (hx === 0 && hy === 0) continue;
          const h = at(a.x + hx, a.y + hy);
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(h.x, h.y);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(h.x, h.y, 3.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.fillStyle = selected ? accent : "#ffffff";
      ctx.strokeStyle = accent;
      ctx.fillRect(p.x - NODE_SIZE / 2, p.y - NODE_SIZE / 2, NODE_SIZE, NODE_SIZE);
      ctx.strokeRect(p.x - NODE_SIZE / 2 + 0.5, p.y - NODE_SIZE / 2 + 0.5, NODE_SIZE - 1, NODE_SIZE - 1);
    });
  });
}
