import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import type { ComponentPropertyLite, NodeLite, SceneState } from "../store/types";
import { childrenOf } from "../store/tree";
import { makeSetComponentPropertiesOp, makeSetInstancePropertyOp } from "../tools/ops";

// Op builders of the component-property editors. Pure: scene in, ops out.

/** The component whose master root is `nodeId`, if any. */
export function componentOfMaster(scene: SceneState, nodeId: string): { id: string; name: string; properties: ComponentPropertyLite[] } | null {
  for (const [id, c] of Object.entries(scene.components)) {
    if (c.rootNodeId === nodeId) return { id, name: c.name, properties: c.properties ?? [] };
  }
  return null;
}

export interface LayerChoice { id: string; label: string; kind: NodeLite["kind"] }

/** The nodes of a master subtree, as "Card / Title" paths in drawing order (the root included). */
export function layersOfMaster(scene: SceneState, rootId: string): LayerChoice[] {
  const out: LayerChoice[] = [];
  const walk = (n: NodeLite, path: string[], depth: number) => {
    if (depth > 50) return;
    const here = [...path, n.name || n.kind];
    out.push({ id: n.id, label: here.join(" / "), kind: n.kind });
    for (const c of childrenOf(scene, n.id)) walk(c, here, depth + 1);
  };
  const root = scene.nodes.get(rootId);
  if (root) walk(root, [], 0);
  return out;
}

function uniqueName(props: readonly ComponentPropertyLite[], base: string): string {
  let name = base;
  for (let i = 2; props.some((p) => p.name === name); i++) name = `${base} ${i}`;
  return name;
}

/** A new property on the first layer that fits (a text layer for text; the first child, else the root, for boolean). */
export function addPropertyOps(scene: SceneState, componentId: string, type: ComponentPropertyLite["type"]): Op[] {
  const c = scene.components[componentId];
  if (!c) return [];
  const layers = layersOfMaster(scene, c.rootNodeId);
  const target = type === "text" ? layers.find((l) => l.kind === "text") : (layers[1] ?? layers[0]);
  if (!target) return [];
  const props = c.properties ?? [];
  const p: ComponentPropertyLite = type === "text"
    ? { name: uniqueName(props, "Text"), type, nodeId: target.id, defaultValue: "" }
    : { name: uniqueName(props, "Show layer"), type, nodeId: target.id, defaultValue: "true" };
  return [makeSetComponentPropertiesOp(componentId, [...props, p])];
}

export function updatePropertyOps(scene: SceneState, componentId: string, name: string, patch: Partial<ComponentPropertyLite>): Op[] {
  const props = scene.components[componentId]?.properties ?? [];
  const t = patch.name !== undefined ? patch.name.trim() : undefined;
  if (t !== undefined && (t === "" || (t !== name && props.some((p) => p.name === t)))) return [];
  return [makeSetComponentPropertiesOp(componentId, props.map((p) => (p.name === name ? { ...p, ...patch, ...(t !== undefined ? { name: t } : {}) } : p)))];
}

export function removePropertyOps(scene: SceneState, componentId: string, name: string): Op[] {
  const props = scene.components[componentId]?.properties ?? [];
  return [makeSetComponentPropertiesOp(componentId, props.filter((p) => p.name !== name))];
}

export function setInstanceValueOps(instanceId: string, name: string, value: string): Op[] {
  return [makeSetInstancePropertyOp(instanceId, name, value)];
}
