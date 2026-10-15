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

/** Can a number property writing `attribute` target a node of this kind? */
export function attributeFits(attribute: string, kind: NodeLite["kind"]): boolean {
  if (attribute === "corner_radius") return kind === "rect";
  if (attribute === "font_size") return kind === "text";
  return true; // opacity fits any node
}

/** The layers a property of this type (and, for a number, attribute) can target. */
export function layersFor(layers: readonly LayerChoice[], type: ComponentPropertyLite["type"], attribute?: string): LayerChoice[] {
  switch (type) {
    case "text": return layers.filter((l) => l.kind === "text");
    case "swap": return layers.filter((l) => l.kind === "instance");
    case "number": return layers.filter((l) => attributeFits(attribute ?? "opacity", l.kind));
    default: return [...layers];
  }
}

export const NUMBER_ATTRIBUTES: { value: string; label: string }[] = [
  { value: "opacity", label: "Opacity (0..1)" },
  { value: "corner_radius", label: "Corner radius" },
  { value: "font_size", label: "Font size" },
];

/** A new property on the first layer that fits; nothing if no layer fits (a swap needs a nested instance). */
export function addPropertyOps(scene: SceneState, componentId: string, type: ComponentPropertyLite["type"]): Op[] {
  const c = scene.components[componentId];
  if (!c) return [];
  const layers = layersOfMaster(scene, c.rootNodeId);
  const fitting = layersFor(layers, type, "opacity");
  const target = type === "boolean" ? (layers[1] ?? layers[0]) : fitting[0];
  if (!target) return [];
  const props = c.properties ?? [];
  const base = { nodeId: target.id } as const;
  const p: ComponentPropertyLite =
    type === "text" ? { ...base, name: uniqueName(props, "Text"), type, defaultValue: "" }
    : type === "number" ? { ...base, name: uniqueName(props, "Number"), type, defaultValue: "", attribute: "opacity" }
    : type === "swap" ? { ...base, name: uniqueName(props, "Swap"), type, defaultValue: "" }
    : { ...base, name: uniqueName(props, "Show layer"), type, defaultValue: "true" };
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
