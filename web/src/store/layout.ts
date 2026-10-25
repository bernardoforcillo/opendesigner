import type { NodeEditor } from "./nodeMap";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { childrenOf, subtreeOf } from "./tree";
import type { NodeLite, SceneState } from "./types";
import { isLayoutKey, resolveNode } from "./variables";

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

const LAYOUT_KINDS: ReadonlySet<NodeLite["kind"]> = new Set(["rect", "ellipse", "text", "image", "vector", "frame", "instance", "polygon", "star"]);

export function participates(n: NodeLite): boolean {
  return n.visible && LAYOUT_KINDS.has(n.kind) && n.layoutPositioning !== "absolute";
}

// participates with the node's variable-bound visibility applied (a boolean variable bound to
// "visible" hides it in the frame's active mode). Parity with participatesIn in Go.
function participatesIn(view: SceneState, n: NodeLite): boolean {
  return participates(n.bindings?.visible ? resolveNode(view, n) : n);
}

export function hasLayout(n: NodeLite | undefined): n is NodeLite & { autoLayout: NonNullable<NodeLite["autoLayout"]> } {
  return n !== undefined && n.kind === "frame" && n.autoLayout !== undefined;
}

const isFrame = (n: NodeLite | undefined): n is NodeLite => n !== undefined && n.kind === "frame";

// The distance from the top of a node to its first baseline, for aligning children on a shared
// baseline (cross_align "baseline" of a horizontal layout). A text's comes from its font size
// and line height (half the leading plus an ascent of 0.8 em), any other node's is its bottom
// edge. Parity with baselineOf in Go.
function baselineOf(n: NodeLite): number {
  if (!n.text) return n.height;
  const fs = n.text.style.fontSize > 0 ? n.text.style.fontSize : 16;
  const lh = n.text.style.lineHeight > 0 ? n.text.style.lineHeight : 1.2;
  const half = (fs * (lh - 1)) / 2;
  return half + fs * 0.8;
}

// A line's baseline (the largest baseline offset of the kids that follow it) and the cross extent
// they take once aligned on it. `skip` excludes the kids that fill the cross axis.
function baselineSpan(kids: readonly NodeLite[], skip: (k: NodeLite) => boolean, crossOf: (k: NodeLite) => number): { base: number; extent: number } {
  let base = 0;
  for (const k of kids) if (!skip(k)) base = Math.max(base, baselineOf(k));
  let extent = 0;
  for (const k of kids) if (!skip(k)) extent = Math.max(extent, base - baselineOf(k) + crossOf(k));
  return { base, extent };
}

// A node in an auto layout frame that left its flow (see Node.layout_positioning).
const isAbsolute = (n: NodeLite): boolean => n.layoutPositioning === "absolute";

// Applies a node's size limits to a computed size: 0 / absent means no limit, and when
// min > max the min wins. Parity with clampSize in Go.
function clampSize(v: number, min: number, max: number): number {
  if (max > 0 && v > max) v = max;
  if (v < min) v = min;
  return v;
}
const clampW = (n: NodeLite, v: number): number => clampSize(v, n.minWidth ?? 0, n.maxWidth ?? 0);
const clampH = (n: NodeLite, v: number): number => clampSize(v, n.minHeight ?? 0, n.maxHeight ?? 0);

// Rearranges the children of ONE frame and, if hug, resizes its axes. Mutates
// `nodes` (a PRIVATE relayout map, already copied) and returns whether it changed
// anything. Three modes, one set of rules (see layoutFrame in Go): a row/column, the
// same with FILL children, and WRAP. A child frame whose size the layout changed is laid
// out again (auto layout) or resizes its own children by their constraints.
function layoutFrame(scene: SceneState, nodes: NodeEditor, id: string, touched?: string[]): boolean {
  const orig = nodes.get(id);
  if (!hasLayout(orig)) return false;
  // The size the frame had when the layout started: the absolute children follow the
  // difference (see the end of this function). Its own size limits apply first.
  const startW = orig.width, startH = orig.height;
  const limitedW = clampW(orig, orig.width), limitedH = clampH(orig, orig.height);
  const frame = limitedW !== orig.width || limitedH !== orig.height ? { ...orig, width: limitedW, height: limitedH } : orig;
  // The state computed on is `scene` + the corrections already written in `nodes`:
  // childrenOf reads from the scene, so it is given a view with the nodes
  // updated so far.
  const view: SceneState = { ...scene, nodes: nodes.view() };
  // Spacing and padding bound to variables are read in the frame's active mode.
  const al = (frame.bindings ? resolveNode(view, frame).autoLayout : undefined) ?? frame.autoLayout;
  const vertical = al.direction === "vertical";
  const kids = childrenOf(view, id).filter((c) => participatesIn(view, c) && !isAbsolute(c));

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
    clampMain: (n, v) => (vertical ? clampH(n, v) : clampW(n, v)),
    clampCross: (n, v) => (vertical ? clampW(n, v) : clampH(n, v)),
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
  if (frameNow.width !== orig.width || frameNow.height !== orig.height) {
    nodes.set(id, { ...orig, width: frameNow.width, height: frameNow.height });
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
    resizeChildren(scene, nodes, r.id, r.oldW, r.oldH, touched);
    if (hasLayout(nodes.get(r.id))) layoutFrame(scene, nodes, r.id, touched);
  }
  // The frame itself may have changed size (hug, size limits): its absolute children follow
  // by their constraints.
  if (resizeChildren(scene, nodes, id, startW, startH, touched)) changed = true;
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
  clampMain(n: NodeLite, v: number): number;
  clampCross(n: NodeLite, v: number): number;
}

// Splits `avail` equally among the fill children, honouring their size limits the way flexbox
// does: a child whose share falls outside its limits is frozen at the limit and the others
// share the rest, until nobody violates. Parity with shareFill in Go. `limited` is false when
// no limit applied (the sizes are then exactly avail / n and nothing is left over).
function shareFill(fills: readonly NodeLite[], avail: number, m: Axes): { sizes: number[]; limited: boolean } {
  const frozen: boolean[] = fills.map(() => false);
  const size: number[] = fills.map(() => 0);
  let limited = false;
  for (;;) {
    let frozenSum = 0;
    let open = 0;
    fills.forEach((_, i) => {
      if (frozen[i]) frozenSum += size[i];
      else open++;
    });
    if (open === 0) break;
    let rem = avail - frozenSum;
    if (rem < 0) rem = 0;
    const share = rem / open;
    let viol = 0;
    fills.forEach((k, i) => {
      if (!frozen[i]) viol += m.clampMain(k, share) - share;
    });
    if (viol === 0) {
      fills.forEach((_, i) => {
        if (!frozen[i]) size[i] = share;
      });
      break;
    }
    limited = true;
    fills.forEach((k, i) => {
      if (frozen[i]) return;
      const c = m.clampMain(k, share);
      if ((viol > 0 && c > share) || (viol < 0 && c < share)) {
        frozen[i] = true;
        size[i] = c;
      }
    });
  }
  return { sizes: size, limited };
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

  // Size limits first: what does not fill keeps its own size, clamped.
  const limitedKids = kids.map((k) => {
    let n = k;
    if (!isFillMain(k)) n = m.withMain(n, m.clampMain(n, m.mainOf(n)));
    if (!isFillCross(k)) n = m.withCross(n, m.clampCross(n, m.crossOf(n)));
    return n;
  });

  let sum = 0;
  let maxCross = 0;
  let nFill = 0;
  for (const k of limitedKids) {
    if (isFillMain(k)) nFill++;
    else sum += m.mainOf(k);
    if (!isFillCross(k)) {
      const c = m.crossOf(k);
      if (c > maxCross) maxCross = c;
    }
  }
  // Baseline alignment (horizontal layouts only): the cross extent is what the kids take once
  // their baselines coincide.
  const baseline = !m.vertical && al.crossAlign === "baseline";
  let lineBase = 0;
  if (baseline) {
    const span = baselineSpan(limitedKids, isFillCross, m.crossOf);
    lineBase = span.base;
    maxCross = span.extent;
  }
  const gaps = kids.length > 1 ? spacing * (kids.length - 1) : 0;

  let frameMain = m.mainOf(frame);
  let frameCross = m.crossOf(frame);
  // The frame's own limits apply to what it hugs.
  if (hugMain) frameMain = m.clampMain(frame, padMainStart + sum + gaps + padMainEnd);
  if (hugCross) frameCross = m.clampCross(frame, padCrossStart + maxCross + padCrossEnd);
  const width = m.vertical ? frameCross : frameMain;
  const height = m.vertical ? frameMain : frameCross;

  const innerMain = frameMain - padMainStart - padMainEnd;
  const innerCross = frameCross - padCrossStart - padCrossEnd;
  let free = innerMain - sum - gaps;

  // The fill children share what is left; afterwards nothing is free -- unless a size limit
  // capped some of them, which leaves room for the alignment.
  const fillSizes = new Map<string, number>();
  if (nFill > 0) {
    const fills = limitedKids.filter(isFillMain);
    const shared = shareFill(fills, free > 0 ? free : 0, m);
    fills.forEach((k, i) => fillSizes.set(k.id, shared.sizes[i]));
    if (shared.limited) {
      let used = 0;
      for (const sz of shared.sizes) used += sz;
      free = free - used;
    } else {
      free = 0;
    }
  }
  const sized = limitedKids.map((k) => {
    let n = k;
    if (isFillMain(k)) n = m.withMain(n, fillSizes.get(k.id)!);
    if (isFillCross(k)) n = m.withCross(n, m.clampCross(n, innerCross < 0 ? 0 : innerCross));
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
    else if (baseline && !isFillCross(k)) cross = padCrossStart + (lineBase - baselineOf(k));
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
  // Size limits first: the lines are cut from the clamped sizes.
  kids = kids.map((k) => m.withCross(m.withMain(k, m.clampMain(k, m.mainOf(k))), m.clampCross(k, m.crossOf(k))));

  // Split into lines: a child that does not fit goes to the next one (a line always has at
  // least one child, even if it is longer than the frame).
  interface Line { from: number; to: number; sum: number; maxCross: number; base: number }
  const lines: Line[] = [];
  let cur: Line = { from: 0, to: 0, sum: 0, maxCross: 0, base: 0 };
  kids.forEach((k, i) => {
    let need = m.mainOf(k);
    if (i > cur.from) need = (cur.sum + spacing) + m.mainOf(k);
    if (i > cur.from && need > innerMain) {
      cur.to = i;
      lines.push(cur);
      cur = { from: i, to: 0, sum: 0, maxCross: 0, base: 0 };
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
  const baseline = !m.vertical && al.crossAlign === "baseline";
  if (baseline) {
    for (const l of lines) {
      const span = baselineSpan(kids.slice(l.from, l.to), () => false, m.crossOf);
      l.base = span.base;
      l.maxCross = span.extent;
    }
  }

  let out = frame;
  if (hugCross) {
    let total = 0;
    for (const l of lines) total += l.maxCross;
    if (lines.length > 1) total += crossSpacing * (lines.length - 1);
    const frameCross = m.clampCross(frame, padCrossStart + total + padCrossEnd);
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
      else if (baseline) cross = crossPos + (l.base - baselineOf(k));
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
// oldW x oldH to the size it has in `nodes`. A frame with auto layout only moves its absolute
// children (its layout decides for the rest) and a frame that did not change is skipped. A child frame that this resizes follows up
// on its own children, recursively. Parity with resizeChildren in Go.
export function resizeChildren(scene: SceneState, nodes: NodeEditor, id: string, oldW: number, oldH: number, touched?: string[]): boolean {
  const frame = nodes.get(id);
  if (!isFrame(frame)) return false;
  // A frame with auto layout only moves its ABSOLUTE children; the flow is the layout's.
  const auto = hasLayout(frame);
  const newW = frame.width, newH = frame.height;
  if (newW === oldW && newH === oldH) return false;
  const view: SceneState = { ...scene, nodes: nodes.view() };
  let changed = false;
  for (const c of childrenOf(view, id)) {
    if (auto && !isAbsolute(c)) continue;
    const free = hasFreeSize(c);
    const [x, width] = constrainAxis(c.constraintX, c.x, c.width, oldW, newW, free);
    const [y, height] = constrainAxis(c.constraintY, c.y, c.height, oldH, newH, free);
    if (x === c.x && y === c.y && width === c.width && height === c.height) continue;
    const next = { ...c, x, y, width, height };
    nodes.set(c.id, next);
    touched?.push(c.id);
    changed = true;
    if ((width !== c.width || height !== c.height) && isFrame(c)) {
      resizeChildren(scene, nodes, c.id, c.width, c.height, touched);
      if (hasLayout(next)) layoutFrame(scene, nodes, c.id, touched);
    }
  }
  return changed;
}

const variablesOf = (scene: SceneState, collectionId: string): Set<string> =>
  new Set(Object.values(scene.variables).filter((v) => v.collectionId === collectionId).map((v) => v.id));

// The nodes (and their parents) whose layout-relevant bindings point at one of `vars` or at an
// alias of them, transitively. Parity with layoutDependents in Go.
function layoutDependents(scene: SceneState, vars: Set<string>): string[] {
  for (let grew = true; grew;) {
    grew = false;
    for (const v of Object.values(scene.variables)) {
      if (!vars.has(v.id) && v.aliasOf !== undefined && vars.has(v.aliasOf)) { vars.add(v.id); grew = true; }
    }
  }
  const out: string[] = [];
  for (const n of scene.nodes.values()) {
    if (n.bindings && Object.entries(n.bindings).some(([key, v]) => isLayoutKey(key) && vars.has(v))) out.push(n.id, n.parentId);
  }
  return out;
}

// The nodes of `subtree` (and their parents) with layout-relevant bindings. Parity with layoutBoundIn in Go.
function layoutBoundIn(subtree: readonly NodeLite[]): string[] {
  return subtree.flatMap((n) => (n.bindings && Object.keys(n.bindings).some(isLayoutKey) ? [n.id, n.parentId] : []));
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
    case "setProps": {
      const out = [...parentOf(k.value.id), k.value.id];
      // A mode pinned on a node changes what the variables bound below it resolve to.
      if (k.value.mask?.paths.includes("modes")) out.push(...layoutBoundIn(subtreeOf(scene, k.value.id)));
      return out;
    }
    case "setVectorPath": return parentOf(k.value.id);
    // The layout reads spacing, padding and visibility through variables: a change to a
    // variable (or to the modes of its collection) moves what is bound to it.
    case "setVariable": return layoutDependents(scene, new Set([k.value.variable?.id ?? ""]));
    case "deleteVariable": return layoutDependents(scene, new Set([k.value.id]));
    case "setCollection": return layoutDependents(scene, variablesOf(scene, k.value.collection?.id ?? ""));
    case "deleteCollection": return layoutDependents(scene, variablesOf(scene, k.value.id));
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
