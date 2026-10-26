import { create, fromJson, toJson } from "@bufbuild/protobuf";
import { NodeSchema } from "@/gen/opendesigner/v1/opendesigner_pb";
import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";
import { worldAabbOfNode } from "@/canvas/geometry";
import { applyOp } from "@/store/applyOp";
import { normalizeVector } from "@/store/vectorGeometry";
import { nextOrderKey, orderKeyBetween } from "@/store/orderKey";
import { subtreeOf, childrenOf } from "@/store/tree";
import { toNodeLite, toPbFills, toPbNode, toPbStrokes, toPbSubPaths, type FillLite, type NodeLite, type SceneState } from "@/store/types";
import { pasteOps } from "@/tools/clipboard";
import { groupOps } from "@/tools/grouping";
import { makeCreateNodeOp, makeSetPropsOp, uuid } from "@/tools/ops";
import { qrMatrix, qrRuns, type QrLevel } from "@/tools/qrcode";

// OBJECT TOOLS: Step and Repeat, the Gap tool, frame fitting, clipping paths, QR codes, find/change on OBJECTS, and snippets. Each
// returns ops (never touches the store): the canvas tools, the dialog and the MCP commands all commit them as ONE gesture.

export const MAX_COPIES = 200;

/** The topmost of `ids` (a node whose ancestor is also listed travels with that ancestor). */
function roots(scene: SceneState, ids: readonly string[]): NodeLite[] {
  const set = new Set(ids);
  const out: NodeLite[] = [];
  for (const id of ids) {
    const n = scene.nodes.get(id);
    if (!n) continue;
    let p = scene.nodes.get(n.parentId);
    let covered = false;
    while (p) { if (set.has(p.id)) { covered = true; break; } p = scene.nodes.get(p.parentId); }
    if (!covered) out.push(n);
  }
  return out;
}

/** pasteOps orders by key, so a child can come before the group it belongs to: put every parent first (a child of a missing parent would be rejected). */
function parentFirst(ops: Op[]): Op[] {
  const byId = new Map<string, Op>();
  for (const op of ops) if (op.kind.case === "createNode" && op.kind.value.node) byId.set(op.kind.value.node.id, op);
  const out: Op[] = [];
  const done = new Set<string>();
  const visit = (op: Op) => {
    const node = op.kind.case === "createNode" ? op.kind.value.node! : null;
    if (!node || done.has(node.id)) return;
    done.add(node.id);
    const parent = byId.get(node.parentId);
    if (parent) visit(parent);
    out.push(op);
  };
  ops.forEach(visit);
  return out;
}

/** The ids, among those the ops create, whose parent is not created by them too: the roots of what was pasted. */
function createdRoots(ops: readonly Op[]): string[] {
  const made = ops.flatMap((op) => (op.kind.case === "createNode" && op.kind.value.node ? [op.kind.value.node] : []));
  const ids = new Set(made.map((n) => n.id));
  return made.filter((n) => !ids.has(n.parentId)).map((n) => n.id);
}

/** Paste `nodes` (with their descendants) once per shift, each copy a step further; the scene advances so order keys keep growing. */
function copiesOps(scene: SceneState, rootNodes: readonly NodeLite[], shifts: readonly { dx: number; dy: number }[]): { ops: Op[]; ids: string[] } {
  const ops: Op[] = [];
  const ids: string[] = [];
  let cur = scene;
  for (const s of shifts) {
    const nodes = rootNodes.flatMap((r) => subtreeOf(scene, r.id).map((n) => (n.id === r.id ? { ...n, x: n.x + s.dx, y: n.y + s.dy } : n)));
    const made = pasteOps(cur, nodes, 0);
    made.ops = parentFirst(made.ops);
    ops.push(...made.ops);
    ids.push(...createdRoots(made.ops));
    for (const op of made.ops) cur = applyOp(cur, op);
  }
  return { ops, ids };
}

export interface StepRepeat { count: number; dx: number; dy: number }

/** Step and Repeat: `count` further copies of the nodes, each offset by (dx, dy) from the previous. */
export function stepRepeatOps(scene: SceneState, ids: readonly string[], p: StepRepeat): { ops: Op[]; ids: string[] } | string {
  if (!Number.isInteger(p.count) || p.count < 1 || p.count > MAX_COPIES) return `count must be a whole number from 1 to ${MAX_COPIES}`;
  if (!Number.isFinite(p.dx) || !Number.isFinite(p.dy)) return "dx and dy must be numbers";
  if (p.dx === 0 && p.dy === 0) return "dx and dy cannot both be zero (the copies would sit on top of each other)";
  const rs = roots(scene, ids);
  if (rs.length === 0) return "no such nodes";
  return copiesOps(scene, rs, Array.from({ length: p.count }, (_, k) => ({ dx: p.dx * (k + 1), dy: p.dy * (k + 1) })));
}

/** The Gap tool: sets the space BETWEEN neighbouring objects along `axis` to `gap`, keeping the first (left/top) one where it is. */
export function gapOps(scene: SceneState, ids: readonly string[], axis: "x" | "y", gap: number): Op[] | string {
  if (!Number.isFinite(gap)) return "gap must be a number";
  const items = ids.map((id) => scene.nodes.get(id)).filter((n): n is NodeLite => n !== undefined);
  if (items.length < 2) return "the gap needs at least two nodes";
  const sorted = items.map((n) => ({ n, box: worldAabbOfNode(n) })).sort((a, b) => (axis === "x" ? a.box.x - b.box.x : a.box.y - b.box.y));
  const ops: Op[] = [];
  let edge = axis === "x" ? sorted[0]!.box.x + sorted[0]!.box.width : sorted[0]!.box.y + sorted[0]!.box.height;
  for (const { n, box } of sorted.slice(1)) {
    const start = axis === "x" ? box.x : box.y;
    const delta = edge + gap - start;
    if (delta !== 0) ops.push(makeSetPropsOp(n.id, { x: n.x + (axis === "x" ? delta : 0), y: n.y + (axis === "y" ? delta : 0) }, ["x", "y"]));
    edge = start + delta + (axis === "x" ? box.width : box.height);
  }
  return ops;
}

export type FitMode = "fill" | "fit" | "tile" | "frame-to-content";

/**
 * Frame fitting. "fill" (cover), "fit" (contain) and "tile" set how the image PAINTS of a shape fill its frame; "frame-to-content"
 * resizes an image NODE to its natural proportions, keeping its width (an image node is stretched onto its box, never cropped).
 */
export function fitOps(scene: SceneState, id: string, mode: FitMode): Op[] | string {
  const n = scene.nodes.get(id);
  if (!n) return `no node ${id}`;
  if (mode === "frame-to-content") {
    const w = n.image?.pixelWidth ?? 0, h = n.image?.pixelHeight ?? 0;
    if (n.kind !== "image" || w <= 0 || h <= 0) return "frame-to-content needs an image node whose size is known";
    const height = (n.width * h) / w;
    return height === n.height ? [] : [makeSetPropsOp(id, { height }, ["height"])];
  }
  if (!["fill", "fit", "tile"].includes(mode)) return "mode must be fill, fit, tile or frame-to-content";
  if (!n.fills.some((f) => f.image)) return "that node has no image fill (use frame-to-content for an image node)";
  const fills = n.fills.map((f) => (f.image ? { ...f, image: { ...f.image, mode } } : f));
  return [makeSetPropsOp(id, { fills: toPbFills(fills) }, ["fills"])];
}

/** Clipping path: the shape becomes the mask of a new group that holds it and the content (the content shows only inside the outline). */
export function clipWithShapeOps(scene: SceneState, shapeId: string, contentIds: readonly string[]): { ops: Op[]; groupId: string } | string {
  const shape = scene.nodes.get(shapeId);
  if (!shape || !["rect", "ellipse", "frame", "vector"].includes(shape.kind)) return "the clipping shape must be a rectangle, ellipse, frame or vector";
  const content = contentIds.filter((c) => c !== shapeId && scene.nodes.has(c));
  if (content.length === 0) return "there is nothing to clip";
  const made = groupOps(scene, [shapeId, ...content]);
  if (!made) return "nothing to group";
  let cur = scene;
  for (const op of made.ops) cur = applyOp(cur, op);
  const groupId = made.selection[0]!;
  const first = childrenOf(cur, groupId)[0]!;
  // A mask clips the siblings ABOVE it, so it goes to the bottom of the group.
  const key = first.id === shapeId ? first.orderKey : orderKeyBetween(null, first.orderKey);
  return { ops: [...made.ops, makeSetPropsOp(shapeId, { orderKey: key, isMask: true }, ["order_key", "is_mask"])], groupId };
}

/** Releases the clipping: the shape stops being a mask. */
export function releaseClipOps(scene: SceneState, shapeId: string): Op[] | string {
  const n = scene.nodes.get(shapeId);
  if (!n?.isMask) return "that node is not a clipping shape";
  return [makeSetPropsOp(shapeId, { isMask: false }, ["is_mask"])];
}

export interface QrParams { text: string; level?: QrLevel; size?: number; x: number; y: number; parentId: string; dark?: FillLite; light?: FillLite; quiet?: number }

/** A QR code as vectors: a group with a light square and one dark vector for all modules. */
export function qrOps(scene: SceneState, p: QrParams): { ops: Op[]; groupId: string } | string {
  let matrix: boolean[][];
  try { matrix = qrMatrix(p.text, p.level ?? "M"); } catch (e) { return (e as Error).message; }
  const quiet = p.quiet ?? 4;
  const size = p.size ?? 128;
  if (!(size > 0) || !Number.isFinite(size) || quiet < 0 || quiet > 20) return "size must be positive and quiet between 0 and 20 modules";
  const modules = matrix.length;
  const unit = size / (modules + 2 * quiet);
  const groupId = uuid();
  const base = { visible: true, opacity: 1, rotation: 0 };
  const key = nextOrderKey(scene);
  const ops: Op[] = [
    makeCreateNodeOp(create(NodeSchema, { id: groupId, parentId: p.parentId, orderKey: key, name: "QR code", ...base, x: p.x, y: p.y, width: 0, height: 0, fills: [], shape: { case: "group", value: {} } })),
    makeCreateNodeOp(create(NodeSchema, {
      id: uuid(), parentId: groupId, orderKey: orderKeyBetween(null, null), name: "QR background", ...base, x: p.x, y: p.y, width: size, height: size,
      fills: toPbFills([p.light ?? { r: 1, g: 1, b: 1, a: 1 }]), shape: { case: "rect", value: {} },
    })),
  ];
  const origin = { x: p.x + quiet * unit, y: p.y + quiet * unit };
  const subpaths = qrRuns(matrix).map((r) => {
    const x0 = origin.x + r.x * unit, y0 = origin.y + r.y * unit, x1 = x0 + r.width * unit, y1 = y0 + unit;
    const a = (x: number, y: number) => ({ x, y, inX: 0, inY: 0, outX: 0, outY: 0 });
    return { anchors: [a(x0, y0), a(x1, y0), a(x1, y1), a(x0, y1)], closed: true };
  });
  const norm = normalizeVector({ x: 0, y: 0 }, subpaths);
  ops.push(makeCreateNodeOp(create(NodeSchema, {
    id: uuid(), parentId: groupId, orderKey: orderKeyBetween(orderKeyBetween(null, null), null), name: "QR modules", ...base,
    x: norm.box.x, y: norm.box.y, width: norm.box.width, height: norm.box.height,
    fills: toPbFills([p.dark ?? { r: 0, g: 0, b: 0, a: 1 }]), strokes: toPbStrokes([]),
    shape: { case: "vector", value: { subpaths: toPbSubPaths(norm.subpaths) } },
  })));
  return { ops, groupId };
}

// --- find/change on objects --------------------------------------------------

export interface ObjectQuery {
  kind?: NodeLite["kind"];
  name?: string;          // regular expression, case-insensitive
  fill?: { r: number; g: number; b: number }; // a fill of this colour (tolerance 1/255 per channel)
  stroke?: { r: number; g: number; b: number };
  pageId?: string;
}
export interface ObjectChange {
  fill?: FillLite; stroke?: FillLite; strokeWeight?: number; opacity?: number; visible?: boolean; rename?: string;
}

const near = (a: number, b: number) => Math.abs(a - b) <= 1 / 255 + 1e-9;
const sameColor = (c: { r: number; g: number; b: number }, q: { r: number; g: number; b: number }) => near(c.r, q.r) && near(c.g, q.g) && near(c.b, q.b);

/** The nodes matching ALL the given criteria (at least one is required). */
export function findObjects(scene: SceneState, q: ObjectQuery): NodeLite[] | string {
  let re: RegExp | null = null;
  if (q.name !== undefined) {
    if (q.name.length > 200) return "name pattern is too long";
    try { re = new RegExp(q.name, "i"); } catch { return "name is not a valid regular expression"; }
  }
  if (q.kind === undefined && re === null && !q.fill && !q.stroke) return "give at least one of kind, name, fill, stroke";
  const out: NodeLite[] = [];
  for (const n of scene.nodes.values()) {
    if (n.fromMaster) continue;
    if (q.kind !== undefined && n.kind !== q.kind) continue;
    if (re && !re.test(n.name)) continue;
    if (q.fill && !n.fills.some((f) => !f.image && !f.gradient && sameColor(f, q.fill!))) continue;
    if (q.stroke && !n.strokes.some((s) => sameColor(s.color, q.stroke!))) continue;
    if (q.pageId && !isOnPage(scene, n, q.pageId)) continue;
    out.push(n);
  }
  return out;
}

function isOnPage(scene: SceneState, n: NodeLite, pageId: string): boolean {
  let cur: NodeLite | undefined = n;
  for (let i = 0; cur && i < 10000; i++) { if (cur.parentId === pageId) return true; cur = scene.nodes.get(cur.parentId); }
  return false;
}

/** Applies `change` to the nodes; a fill/stroke replaces the matching one when the query named a colour, else all solid ones. */
export function changeObjectsOps(scene: SceneState, nodes: readonly NodeLite[], change: ObjectChange, q: ObjectQuery = {}): Op[] {
  const ops: Op[] = [];
  for (const n of nodes) {
    if (change.fill) {
      const fills = n.fills.length === 0 ? [change.fill] : n.fills.map((f) => (!f.image && !f.gradient && (!q.fill || sameColor(f, q.fill)) ? { ...change.fill!, ...(f.a !== 1 && change.fill!.a === 1 ? {} : {}) } : f));
      ops.push(makeSetPropsOp(n.id, { fills: toPbFills(fills) }, ["fills"]));
    }
    if (change.stroke || change.strokeWeight !== undefined) {
      const strokes = n.strokes.map((s) => (!q.stroke || sameColor(s.color, q.stroke) ? { ...s, ...(change.stroke ? { color: change.stroke } : {}), ...(change.strokeWeight !== undefined ? { weight: change.strokeWeight } : {}) } : s));
      if (n.strokes.length === 0 && change.stroke) strokes.push({ color: change.stroke, weight: change.strokeWeight ?? 1, align: "center" });
      ops.push(makeSetPropsOp(n.id, { strokes: toPbStrokes(strokes) }, ["strokes"]));
    }
    if (change.opacity !== undefined) ops.push(makeSetPropsOp(n.id, { opacity: change.opacity }, ["opacity"]));
    if (change.visible !== undefined) ops.push(makeSetPropsOp(n.id, { visible: change.visible }, ["visible"]));
    if (change.rename !== undefined) ops.push(makeSetPropsOp(n.id, { name: change.rename }, ["name"]));
  }
  return ops;
}

// --- snippets ------------------------------------------------------------------

export const SNIPPET_FORMAT = "opendesigner/snippet";

/** A snippet: the nodes and their descendants as text (protobuf JSON, so every kind survives), to keep in a file or a library and place anywhere. Images keep their asset hash: they show only in documents that hold that asset. */
export function exportSnippet(scene: SceneState, ids: readonly string[]): string | null {
  const rs = roots(scene, ids);
  if (rs.length === 0) return null;
  const nodes = rs.flatMap((r) => subtreeOf(scene, r.id)).map((n) => toJson(NodeSchema, toPbNode(n)));
  return JSON.stringify({ format: SNIPPET_FORMAT, version: 1, nodes });
}

/** Places a snippet with its top-left corner at (x, y) on `parentId` (a page or a group). */
export function placeSnippetOps(scene: SceneState, text: string, x: number, y: number, parentId: string): { ops: Op[]; ids: string[] } | string {
  let payload: { format?: unknown; version?: unknown; nodes?: unknown };
  try { payload = JSON.parse(text); } catch { return "that is not an opendesigner snippet"; }
  if (typeof payload !== "object" || payload === null || payload.format !== SNIPPET_FORMAT) return "that is not an opendesigner snippet";
  if (payload.version !== 1) return "that snippet comes from a version this editor cannot read";
  if (!Array.isArray(payload.nodes) || payload.nodes.length === 0 || payload.nodes.length > 5000) return "a snippet needs 1..5000 nodes";
  let parsed: NodeLite[];
  try { parsed = payload.nodes.map((j) => toNodeLite(fromJson(NodeSchema, j as never))); } catch { return "that snippet is damaged"; }
  const ids = new Set(parsed.map((n) => n.id));
  const top = parsed.filter((n) => !ids.has(n.parentId));
  if (top.length === 0) return "that snippet is damaged";
  const left = Math.min(...top.map((n) => n.x)), up = Math.min(...top.map((n) => n.y));
  const nodes = parsed.map((n) => (!ids.has(n.parentId) ? { ...n, parentId, x: n.x - left + x, y: n.y - up + y } : n));
  const made = pasteOps(scene, nodes, 0);
  made.ops = parentFirst(made.ops);
  return { ops: made.ops, ids: createdRoots(made.ops) };
}
