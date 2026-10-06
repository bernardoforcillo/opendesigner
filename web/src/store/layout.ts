import type { NodeEditor } from "./nodeMap";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { childrenOf } from "./tree";
import type { NodeLite, SceneState } from "./types";

// AUTO LAYOUT -- the TypeScript half of internal/core/layout.go, which is
// the AUTHORITY. This copy exists only because the client applies ops
// locally (optimistic view and confirmed state) with applyOp: if it did not redo
// the same computation, the document the server has already laid out and the one the
// browser rebuilds from the same ops would diverge.
//
// It must give the SAME numbers as Go, bit for bit. For this reason the
// arithmetic expressions are written IN THE SAME ORDER (a + b + c is (a + b) + c on
// both sides) and the order of children is that of childrenOf (order_key, then
// id). The fixture testdata/golden/auto_layout.json, run by both sides,
// pins it down.
//
// The VISIBLE children with a measure of their own take part (rect, ellipse, text,
// image, vector, frame, instance). Groups stay where they are. A frame can also WRAP its
// children onto lines, a child can FILL the free space of its axis, and a frame WITHOUT auto
// layout resizes its children by their CONSTRAINTS when it is resized (resizeChildren).

const LAYOUT_KINDS: ReadonlySet<NodeLite["kind"]> = new Set(["rect", "ellipse", "text", "image", "vector", "frame", "instance"]);

export function participates(n: NodeLite): boolean {
  return n.visible && LAYOUT_KINDS.has(n.kind);
}

export function hasLayout(n: NodeLite | undefined): n is NodeLite & { autoLayout: NonNullable<NodeLite["autoLayout"]> } {
  return n !== undefined && n.kind === "frame" && n.autoLayout !== undefined;
}

const isFrame = (n: NodeLite | undefined): n is NodeLite => n !== undefined && n.kind === "frame";

// Rearranges the children of ONE frame and, if hug, resizes its axes. Mutates
// `nodes` (a PRIVATE relayout map, already copied) and returns whether it changed
// anything. Three modes, one set of rules (see layoutFrame in Go): a row/column, the
// same with FILL children, and WRAP. A child frame whose size the layout changed is laid
// out again (auto layout) or resizes its own children by their constraints.
function layoutFrame(scene: SceneState, nodes: NodeEditor, id: string, touched?: string[]): boolean {
  const frame = nodes.get(id);
  if (!hasLayout(frame)) return false;
  const al = frame.autoLayout;
  const vertical = al.direction === "vertical";

  // The state computed on is `scene` + the corrections already written in `nodes`:
  // childrenOf reads from the scene, so it is given a view with the nodes
  // updated so far.
  const view: SceneState = { ...scene, nodes: nodes.view() };
  const kids = childrenOf(view, id).filter(participates);

  const padL = al.paddingLeft, padT = al.paddingTop, padR = al.paddingRight, padB = al.paddingBottom;
  const [padMainStart, padMainEnd, padCrossStart, padCrossEnd] = vertical ? [padT, padB, padL, padR] : [padL, padR, padT, padB];
  const [hugMain, hugCross] = vertical ? [al.hugHeight, al.hugWidth] : [al.hugWidth, al.hugHeight];
  const m: Axes = {
    vertical,
    mainOf: (n) => (vertical ? n.height : n.width),
    crossOf: (n) => (vertical ? n.width : n.height),
    withMain: (n, v) => (vertical ? { ...n, height: v } : { ...n, width: v }),
    withCross: (n, v) => (vertical ? { ...n, width: v } : { ...n, height: v }),
    fillMain: (n) => (vertical ? n.layoutSizingY : n.layoutSizingX) === "fill",
    fillCross: (n) => (vertical ? n.layoutSizingX : n.layoutSizingY) === "fill",
  };

  const spacing = al.spacing;
  const wrap = al.wrap === true && !hugMain;
  const innerMainFrame = m.mainOf(frame) - padMainStart - padMainEnd;

  // The children and the frame, as laid out: id -> node with the new geometry.
  const placed = new Map<string, NodeLite>();
  let frameNow: NodeLite = frame;
  if (wrap) {
    frameNow = layoutWrapped(kids, frame, al, m, innerMainFrame, padMainStart, padCrossStart, padCrossEnd, hugCross, placed);
  } else {
    frameNow = layoutLine(kids, frame, al, m, hugMain, hugCross, padMainStart, padMainEnd, padCrossStart, padCrossEnd, spacing, placed);
  }

  let changed = false;
  if (frameNow.width !== frame.width || frameNow.height !== frame.height) {
    nodes.set(id, { ...frame, width: frameNow.width, height: frameNow.height });
    touched?.push(id);
    changed = true;
  }
  const resized: { id: string; oldW: number; oldH: number }[] = [];
  for (const k of kids) {
    const next = placed.get(k.id)!;
    if (k.x !== next.x || k.y !== next.y || k.width !== next.width || k.height !== next.height) {
      nodes.set(k.id, next);
      touched?.push(k.id);
      changed = true;
      if ((k.width !== next.width || k.height !== next.height) && isFrame(k)) resized.push({ id: k.id, oldW: k.width, oldH: k.height });
    }
  }
  // Follow up the child frames whose size the layout changed.
  for (const r of resized) {
    if (hasLayout(nodes.get(r.id))) layoutFrame(scene, nodes, r.id, touched);
    else resizeChildren(scene, nodes, r.id, r.oldW, r.oldH, touched);
  }
  return changed;
}

interface Axes {
  vertical: boolean;
  mainOf(n: NodeLite): number;
  crossOf(n: NodeLite): number;
  withMain(n: NodeLite, v: number): NodeLite;
  withCross(n: NodeLite, v: number): NodeLite;
  fillMain(n: NodeLite): boolean;
  fillCross(n: NodeLite): boolean;
}

// A single row/column, with fill children. Parity with layoutLine in Go.
function layoutLine(
  kids: readonly NodeLite[], frame: NodeLite, al: NonNullable<NodeLite["autoLayout"]>, m: Axes,
  hugMain: boolean, hugCross: boolean, padMainStart: number, padMainEnd: number, padCrossStart: number, padCrossEnd: number,
  spacing: number, placed: Map<string, NodeLite>,
): NodeLite {
  // A hugging axis cannot also be filled: its length is the content's.
  const isFillMain = (k: NodeLite) => !hugMain && m.fillMain(k);
  const isFillCross = (k: NodeLite) => !hugCross && m.fillCross(k);

  let sum = 0;
  let maxCross = 0;
  let nFill = 0;
  for (const k of kids) {
    if (isFillMain(k)) nFill++;
    else sum += m.mainOf(k);
    if (!isFillCross(k)) {
      const c = m.crossOf(k);
      if (c > maxCross) maxCross = c;
    }
  }
  const gaps = kids.length > 1 ? spacing * (kids.length - 1) : 0;

  let frameMain = m.mainOf(frame);
  let frameCross = m.crossOf(frame);
  if (hugMain) frameMain = padMainStart + sum + gaps + padMainEnd;
  if (hugCross) frameCross = padCrossStart + maxCross + padCrossEnd;
  const width = m.vertical ? frameCross : frameMain;
  const height = m.vertical ? frameMain : frameCross;

  const innerMain = frameMain - padMainStart - padMainEnd;
  const innerCross = frameCross - padCrossStart - padCrossEnd;
  let free = innerMain - sum - gaps;

  // The fill children share what is left; afterwards nothing is free.
  let share = 0;
  if (nFill > 0) {
    if (free > 0) share = free / nFill;
    free = 0;
  }
  const sized = kids.map((k) => {
    let n = k;
    if (isFillMain(k)) n = m.withMain(n, share);
    if (isFillCross(k)) n = m.withCross(n, innerCross < 0 ? 0 : innerCross);
    return n;
  });

  let pos = padMainStart;
  let step = spacing;
  switch (al.mainAlign) {
    case "center": pos = padMainStart + free / 2; break;
    case "end": pos = padMainStart + free; break;
    case "space-between":
      // Fewer than two children: nothing to distribute among. Not enough space
      // (free <= 0): do not compress below `spacing`.
      if (kids.length > 1 && free > 0) step = spacing + free / (kids.length - 1);
      break;
    default: break;
  }

  for (const k of sized) {
    let cross = padCrossStart;
    if (al.crossAlign === "center") cross = padCrossStart + (innerCross - m.crossOf(k)) / 2;
    else if (al.crossAlign === "end") cross = padCrossStart + (innerCross - m.crossOf(k));
    const x = m.vertical ? cross : pos;
    const y = m.vertical ? pos : cross;
    placed.set(k.id, { ...k, x, y });
    pos = pos + m.mainOf(k) + step;
  }
  return { ...frame, width, height };
}

// The children flow onto lines; the main axis never hugs. Parity with layoutWrapped in Go.
function layoutWrapped(
  kids: readonly NodeLite[], frame: NodeLite, al: NonNullable<NodeLite["autoLayout"]>, m: Axes,
  innerMain: number, padMainStart: number, padCrossStart: number, padCrossEnd: number, hugCross: boolean,
  placed: Map<string, NodeLite>,
): NodeLite {
  const spacing = al.spacing;
  const crossSpacing = al.crossSpacing ?? 0;

  // Split into lines: a child that does not fit goes to the next one (a line always has at
  // least one child, even if it is longer than the frame).
  interface Line { from: number; to: number; sum: number; maxCross: number }
  const lines: Line[] = [];
  let cur: Line = { from: 0, to: 0, sum: 0, maxCross: 0 };
  kids.forEach((k, i) => {
    let need = m.mainOf(k);
    if (i > cur.from) need = (cur.sum + spacing) + m.mainOf(k);
    if (i > cur.from && need > innerMain) {
      cur.to = i;
      lines.push(cur);
      cur = { from: i, to: 0, sum: 0, maxCross: 0 };
      need = m.mainOf(k);
    }
    cur.sum = need;
    const c = m.crossOf(k);
    if (c > cur.maxCross) cur.maxCross = c;
  });
  if (kids.length > 0) {
    cur.to = kids.length;
    lines.push(cur);
  }

  let out = frame;
  if (hugCross) {
    let total = 0;
    for (const l of lines) total += l.maxCross;
    if (lines.length > 1) total += crossSpacing * (lines.length - 1);
    const frameCross = padCrossStart + total + padCrossEnd;
    out = m.vertical ? { ...frame, width: frameCross } : { ...frame, height: frameCross };
  }

  let crossPos = padCrossStart;
  for (const l of lines) {
    const n = l.to - l.from;
    const free = innerMain - l.sum;
    let pos = padMainStart;
    let step = spacing;
    switch (al.mainAlign) {
      case "center": pos = padMainStart + free / 2; break;
      case "end": pos = padMainStart + free; break;
      case "space-between":
        if (n > 1 && free > 0) step = spacing + free / (n - 1);
        break;
      default: break;
    }
    for (const k of kids.slice(l.from, l.to)) {
      let cross = crossPos;
      if (al.crossAlign === "center") cross = crossPos + (l.maxCross - m.crossOf(k)) / 2;
      else if (al.crossAlign === "end") cross = crossPos + (l.maxCross - m.crossOf(k));
      const x = m.vertical ? cross : pos;
      const y = m.vertical ? pos : cross;
      placed.set(k.id, { ...k, x, y });
      pos = pos + m.mainOf(k) + step;
    }
    crossPos = crossPos + l.maxCross + crossSpacing;
  }
  return out;
}

// Moves and resizes ONE child along ONE axis after its parent frame went from `oldFrame`
// to `newFrame` on that axis. `resizable` is false for nodes whose size is not a free field
// (vector, group, instance): they only move. Parity with constrainAxis in Go.
function constrainAxis(mode: NodeLite["constraintX"], pos: number, size: number, oldFrame: number, newFrame: number, resizable: boolean): [number, number] {
  const d = newFrame - oldFrame;
  switch (mode) {
    case "max": return [pos + d, size];
    case "stretch": {
      if (!resizable) return [pos, size];
      const s = size + d;
      return [pos, s < 0 ? 0 : s];
    }
    case "center": return [pos + d / 2, size];
    case "scale": {
      if (!(oldFrame > 0)) return [pos, size];
      const r = newFrame / oldFrame;
      return [pos * r, resizable ? size * r : size];
    }
    default: return [pos, size];
  }
}

const hasFreeSize = (n: NodeLite) => n.kind !== "vector" && n.kind !== "group" && n.kind !== "instance";

// Applies the CONSTRAINTS of the children of frame `id`, which has just gone from
// oldW x oldH to the size it has in `nodes`. A frame with auto layout is skipped (its layout
// decides) and so is a frame that did not change. A child frame that this resizes follows up
// on its own children, recursively. Parity with resizeChildren in Go.
export function resizeChildren(scene: SceneState, nodes: NodeEditor, id: string, oldW: number, oldH: number, touched?: string[]): boolean {
  const frame = nodes.get(id);
  if (!isFrame(frame) || hasLayout(frame)) return false;
  const newW = frame.width, newH = frame.height;
  if (newW === oldW && newH === oldH) return false;
  const view: SceneState = { ...scene, nodes: nodes.view() };
  let changed = false;
  for (const c of childrenOf(view, id)) {
    const free = hasFreeSize(c);
    const [x, width] = constrainAxis(c.constraintX, c.x, c.width, oldW, newW, free);
    const [y, height] = constrainAxis(c.constraintY, c.y, c.height, oldH, newH, free);
    if (x === c.x && y === c.y && width === c.width && height === c.height) continue;
    const next = { ...c, x, y, width, height };
    nodes.set(c.id, next);
    touched?.push(c.id);
    changed = true;
    if ((width !== c.width || height !== c.height) && isFrame(c)) {
      if (hasLayout(next)) layoutFrame(scene, nodes, c.id, touched);
      else resizeChildren(scene, nodes, c.id, c.width, c.height, touched);
    }
  }
  return changed;
}

// The frames whose layout may change because of `op`, read from `scene` --
// which is queried BEFORE and AFTER the op (a deleted or moved node leaves the
// old parent only in the earlier state). Like layoutTargets in Go.
export function layoutTargets(scene: SceneState, op: Op): string[] {
  const parentOf = (id: string): string[] => {
    const n = scene.nodes.get(id);
    return n ? [n.parentId] : [];
  };
  const k = op.kind;
  switch (k.case) {
    case "createNode": return k.value.node ? [k.value.node.parentId, k.value.node.id] : [];
    case "deleteNode": return parentOf(k.value.id);
    case "reparentNode": return [...parentOf(k.value.id), k.value.newParentId];
    case "setProps": return [...parentOf(k.value.id), k.value.id];
    case "setVectorPath": return parentOf(k.value.id);
    default: return [];
  }
}

// Rearranges the touched frames and climbs up (a hug that changes size moves
// siblings, so the parent's layout is needed, and so on), from the deepest:
// a nested hug frame must have the right size BEFORE the container
// reads it. Returns the SAME scene if nothing changes, so whoever compares it by
// identity does not redraw for nothing.
export function relayout(scene: SceneState, ids: readonly string[], touchedOut?: string[]): SceneState {
  const seen = new Set<string>();
  const frames: string[] = [];
  for (const id of ids) {
    if (id !== "" && !seen.has(id) && hasLayout(scene.nodes.get(id))) {
      seen.add(id);
      frames.push(id);
    }
  }
  // Before COPYING the nodes map (20,000 entries at 12 ms for a large
  // document): the vast majority of ops touch no frame with auto
  // layout. A node outside an auto layout with an ancestor that has one counts
  // anyway, but that is only discovered by climbing -- and without touched frames there is
  // nothing to climb.
  if (frames.length === 0) return scene;
  const nodes = scene.nodes.edit();
  const limit = scene.nodes.size;
  for (const id of [...frames]) {
    let cur: NodeLite | undefined = nodes.get(id);
    for (let guard = 0; cur !== undefined && guard <= limit; guard++) {
      const p: NodeLite | undefined = nodes.get(cur.parentId);
      if (p === undefined) break;
      if (hasLayout(p) && !seen.has(p.id)) {
        seen.add(p.id);
        frames.push(p.id);
      }
      cur = p;
    }
  }
  const depth = (id: string): number => {
    let d = 0;
    for (let cur: NodeLite | undefined = nodes.get(id); cur !== undefined && d <= limit; cur = nodes.get(cur.parentId)) d++;
    return d;
  };
  frames.sort((a, b) => depth(b) - depth(a) || (a < b ? -1 : a > b ? 1 : 0));

  let changed = false;
  for (const id of frames) if (layoutFrame(scene, nodes, id, touchedOut)) changed = true;
  return changed ? { ...scene, nodes: nodes.done() } : scene;
}
