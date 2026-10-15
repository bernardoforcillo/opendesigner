import { create } from "@bufbuild/protobuf";
import { NodeSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { invertTransform, mapBounds, worldBoundsOfNode, worldTransformOf } from "../canvas/transform";
import { orderKeyBetween } from "../store/orderKey";
import { childrenOf } from "../store/tree";
import { normalizeVector } from "../store/vectorGeometry";
import type { NodeLite, SceneState } from "../store/types";
import { toPbStrokes, toPbSubPaths } from "../store/types";
import { makeCreateNodeOp, makeSetPropsOp, uuid } from "../tools/ops";
import {
  META_CONNECTOR_FROM, META_CONNECTOR_HEAD, META_CONNECTOR_ROUTE, META_CONNECTOR_TO,
  connectorOf, connectorSubpaths, type ConnectorHead, type ConnectorRoute,
} from "./connector";

// Making and editing connectors. The node stores the path it had when it was made, so the document
// is meaningful to anything that does not derive (the server, an unpack in git); the editor then
// redraws it from its ends (store/connectors.ts).

const INK = { r: 0.25, g: 0.27, b: 0.32, a: 1 };

function ancestors(scene: SceneState, n: NodeLite): string[] {
  const out: string[] = [];
  for (let id = n.parentId, guard = 0; id && guard < 10000; guard++) {
    out.push(id);
    const p = scene.nodes.get(id);
    if (!p) break;
    id = p.parentId;
  }
  return out;
}

/** The container shared by two nodes: the closest ancestor (or the page) they both live in. */
export function commonParent(scene: SceneState, a: NodeLite, b: NodeLite): string {
  const chain = new Set(ancestors(scene, a));
  return ancestors(scene, b).find((id) => chain.has(id)) ?? a.parentId;
}

export interface ConnectorOptions { route?: ConnectorRoute; head?: ConnectorHead }

/** A connector from `fromId` to `toId` (ONE gesture's ops), or null when either is missing or they are the same node. */
export function connectOps(scene: SceneState, fromId: string, toId: string, opts: ConnectorOptions = {}): { ops: Op[]; selection: string[] } | null {
  const a = scene.nodes.get(fromId);
  const b = scene.nodes.get(toId);
  if (!a || !b || a.id === b.id) return null;
  const parentId = commonParent(scene, a, b);
  const into = invertTransform(worldTransformOf(scene, parentId));
  const route = opts.route ?? "straight";
  const head = opts.head ?? "end";
  const subpaths = connectorSubpaths(mapBounds(into, worldBoundsOfNode(scene, a)), mapBounds(into, worldBoundsOfNode(scene, b)), { route, head }, 2);
  if (subpaths.length === 0) return null;
  const norm = normalizeVector({ x: 0, y: 0 }, subpaths);
  const top = childrenOf(scene, parentId).at(-1);
  const id = uuid();
  const node = create(NodeSchema, {
    id, parentId, orderKey: orderKeyBetween(top?.orderKey ?? null, null),
    name: `${a.name || "Shape"} → ${b.name || "Shape"}`, visible: true, opacity: 1,
    x: norm.box.x, y: norm.box.y, width: norm.box.width, height: norm.box.height, rotation: 0,
    strokes: toPbStrokes([{ color: INK, weight: 2, align: "center" }]),
    shape: { case: "vector", value: { subpaths: toPbSubPaths(norm.subpaths) } },
    meta: { [META_CONNECTOR_FROM]: a.id, [META_CONNECTOR_TO]: b.id, [META_CONNECTOR_ROUTE]: route, [META_CONNECTOR_HEAD]: head },
  });
  return { ops: [makeCreateNodeOp(node)], selection: [id] };
}

/** Changes a connector's route or arrowheads. */
export function setConnectorOps(node: NodeLite, opts: ConnectorOptions): Op[] {
  const spec = connectorOf(node);
  if (!spec) return [];
  const route = opts.route ?? spec.route;
  const head = opts.head ?? spec.head;
  if (route === spec.route && head === spec.head) return [];
  return [makeSetPropsOp(node.id, { meta: { ...(node.meta ?? {}), [META_CONNECTOR_ROUTE]: route, [META_CONNECTOR_HEAD]: head } }, ["meta"])];
}
