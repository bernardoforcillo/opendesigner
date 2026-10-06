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
// image, vector, frame). Groups and instances stay where they are.

const LAYOUT_KINDS: ReadonlySet<NodeLite["kind"]> = new Set(["rect", "ellipse", "text", "image", "vector", "frame"]);

export function participates(n: NodeLite): boolean {
  return n.visible && LAYOUT_KINDS.has(n.kind);
}

export function hasLayout(n: NodeLite | undefined): n is NodeLite & { autoLayout: NonNullable<NodeLite["autoLayout"]> } {
  return n !== undefined && n.kind === "frame" && n.autoLayout !== undefined;
}

// Rearranges the children of ONE frame and, if hug, resizes its axes. Mutates
// `nodes` (a PRIVATE relayout map, already copied) and returns whether it changed
// anything.
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
  const mainOf = (n: NodeLite) => (vertical ? n.height : n.width);
  const crossOf = (n: NodeLite) => (vertical ? n.width : n.height);

  const spacing = al.spacing;
  let sum = 0;
  let maxCross = 0;
  for (const k of kids) {
    sum += mainOf(k);
    const c = crossOf(k);
    if (c > maxCross) maxCross = c;
  }
  const gaps = kids.length > 1 ? spacing * (kids.length - 1) : 0;

  let frameMain = mainOf(frame);
  let frameCross = crossOf(frame);
  if (hugMain) frameMain = padMainStart + sum + gaps + padMainEnd;
  if (hugCross) frameCross = padCrossStart + maxCross + padCrossEnd;
  const width = vertical ? frameCross : frameMain;
  const height = vertical ? frameMain : frameCross;

  const innerMain = frameMain - padMainStart - padMainEnd;
  const innerCross = frameCross - padCrossStart - padCrossEnd;
  const free = innerMain - sum - gaps;

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

  let changed = false;
  if (frame.width !== width || frame.height !== height) {
    nodes.set(id, { ...frame, width, height });
    touched?.push(id);
    changed = true;
  }
  for (const k of kids) {
    let cross = padCrossStart;
    if (al.crossAlign === "center") cross = padCrossStart + (innerCross - crossOf(k)) / 2;
    else if (al.crossAlign === "end") cross = padCrossStart + (innerCross - crossOf(k));
    const x = vertical ? cross : pos;
    const y = vertical ? pos : cross;
    if (k.x !== x || k.y !== y) {
      nodes.set(k.id, { ...k, x, y });
      touched?.push(k.id);
      changed = true;
    }
    pos = pos + mainOf(k) + step;
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
