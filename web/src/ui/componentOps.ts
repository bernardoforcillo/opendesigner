import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";
import { effectiveComponentId, parseNumber } from "@/store/components";
import { nextOrderKey } from "@/store/orderKey";
import { subtreeOf } from "@/store/tree";
import { toPbNode } from "@/store/types";
import type { ComponentLite, ComponentPropertyLite, ComponentSetLite, NodeLite, SceneState } from "@/store/types";
import {
  makeCreateComponentOp, makeCreateNodeOp, makeSetComponentDefOp, makeSetComponentSetOp, makeSetInstancePropsOp, uuid,
} from "@/tools/ops";

// The pure half of the component variants / properties UI (InstanceControls,
// ComponentDialog): it reads a scene and BUILDS ops, it never submits. The
// components hand the result to beginGesture/endGesture: a click = one gesture =
// one undo step, even when it takes several ops (a new axis also reassigns the members).

const def = (id: string, c: ComponentLite, over: Partial<Pick<ComponentLite, "setId" | "variant" | "properties">> = {}): Op =>
  makeSetComponentDefOp(id, over.setId ?? c.setId ?? "", over.variant ?? c.variant ?? {}, over.properties ?? c.properties ?? []);

// ---------- instances ----------

/** The variant choice of an instance for `axis`: its own choice, else the base component's option. */
export function chosenOption(scene: SceneState, instance: NodeLite, axis: string): string | undefined {
  return instance.instance?.variantProps?.[axis] ?? scene.components[instance.instance?.componentId ?? ""]?.variant?.[axis];
}

/**
 * Switches the variant of `instanceId` on one axis (a `setInstanceProps`). The property values
 * are kept by NAME for the properties the new variant also has; the others are dropped,
 * because the document refuses a value for a property the component it resolves to lacks.
 */
export function chooseVariantOps(scene: SceneState, instanceId: string, axis: string, option: string): Op[] {
  const n = scene.nodes.at(instanceId);
  if (!n || n.kind !== "instance" || !n.instance) return [];
  const variantProps = { ...(n.instance.variantProps ?? {}), [axis]: option };
  const next = scene.components[effectiveComponentId(scene, { componentId: n.instance.componentId, variantProps })];
  const kept = Object.fromEntries(Object.entries(n.instance.propertyValues ?? {})
    .filter(([name]) => next?.properties?.some((p) => p.name === name)));
  return [makeSetInstancePropsOp(instanceId, kept, variantProps)];
}

/**
 * Sets one property value of an instance (a `setInstanceProps` keeping the variant choice).
 * An empty value for a swap property goes back to the default. Empty when the value is not
 * valid for the property's type (a number outside its attribute's range, a text outside the
 * option list, an unknown component).
 */
export function setPropertyValueOps(scene: SceneState, instanceId: string, name: string, value: string): Op[] {
  const n = scene.nodes.at(instanceId);
  if (!n || n.kind !== "instance" || !n.instance) return [];
  const prop = scene.components[effectiveComponentId(scene, n.instance)]?.properties?.find((p) => p.name === name);
  if (!prop) return [];
  const values = { ...(n.instance.propertyValues ?? {}) };
  if (value === "" && prop.type === "swap") delete values[name];
  else if (!valueFits(scene, prop, value)) return [];
  else values[name] = value;
  return [makeSetInstancePropsOp(instanceId, values, n.instance.variantProps ?? {})];
}

/** The value is one the document accepts for this property (components.ts::propertyValueValid). */
function valueFits(scene: SceneState, p: ComponentPropertyLite, v: string): boolean {
  switch (p.type) {
    case "boolean": return v === "true" || v === "false";
    case "number": return parseNumber(p.attribute, v) !== null;
    case "swap": return !!scene.components[v];
    case "text": return p.options?.length ? p.options.includes(v) : true;
  }
}

/**
 * The components a swap property can point at: every component but the one that holds the
 * property, by name.
 */
export function swapChoices(scene: SceneState, componentId: string): { id: string; name: string }[] {
  return Object.entries(scene.components)
    .filter(([id]) => id !== componentId)
    .map(([id, c]) => ({ id, name: c.name || "Unnamed" }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

// ---------- sets and variants ----------

/** The members of a set, sorted by name. */
export function membersOf(scene: SceneState, setId: string): { id: string; c: ComponentLite }[] {
  return Object.entries(scene.components)
    .filter(([, c]) => c.setId === setId)
    .map(([id, c]) => ({ id, c }))
    .sort((a, b) => a.c.name.localeCompare(b.c.name) || a.id.localeCompare(b.id));
}

/** Makes `componentId` the first member of a new set with one axis, "Variant", and one option, "Default". */
export function createSetOps(scene: SceneState, componentId: string, name: string): { setId: string; ops: Op[] } | null {
  const c = scene.components[componentId];
  if (!c || c.setId) return null;
  const set: ComponentSetLite = { id: uuid(), name, axes: [{ name: "Variant", options: ["Default"] }] };
  return { setId: set.id, ops: [makeSetComponentSetOp(set), def(componentId, c, { setId: set.id, variant: { Variant: "Default" } })] };
}

/** Takes the component out of its set (it keeps its properties). */
export function leaveSetOps(scene: SceneState, componentId: string): Op[] {
  const c = scene.components[componentId];
  return c?.setId ? [def(componentId, c, { setId: "", variant: {} })] : [];
}

/**
 * Renames an axis. Members and instances follow (the op carries the rename), so nothing is
 * detached or reset. Empty when the new name is empty, taken, or unchanged.
 */
export function renameAxisOps(scene: SceneState, setId: string, axis: string, to: string): Op[] {
  const set = scene.componentSets[setId];
  const name = to.trim();
  if (!set || name === "" || name === axis || set.axes.some((a) => a.name === name)) return [];
  return [makeSetComponentSetOp(
    { ...set, axes: set.axes.map((a) => (a.name === axis ? { ...a, name } : a)) },
    { axes: { [axis]: name } },
  )];
}

/** Renames an option of an axis; members and instances on it follow. Empty when the new name is empty, taken, or unchanged. */
export function renameOptionOps(scene: SceneState, setId: string, axis: string, from: string, to: string): Op[] {
  const set = scene.componentSets[setId];
  const name = to.trim();
  const a = set?.axes.find((x) => x.name === axis);
  if (!set || !a || name === "" || name === from || a.options.includes(name) || !a.options.includes(from)) return [];
  return [makeSetComponentSetOp(
    { ...set, axes: set.axes.map((x) => (x === a ? { ...x, options: x.options.map((o) => (o === from ? name : o)) } : x)) },
    { options: [{ axis, from, to: name }] },
  )];
}

/** A new option on an axis; no member changes. */
export function addOptionOps(scene: SceneState, setId: string, axis: string, option: string): Op[] {
  const set = scene.componentSets[setId];
  const name = option.trim();
  if (!set || name === "") return [];
  return [makeSetComponentSetOp({ ...set, axes: set.axes.map((a) => (a.name === axis ? { ...a, options: [...a.options, name] } : a)) })];
}

/**
 * A new axis. Every member is reassigned to `firstOption` on it right after: changing the
 * axes detaches the members whose assignment is no longer complete, and this puts them
 * back in the same gesture.
 */
export function addAxisOps(scene: SceneState, setId: string, axis: string, firstOption: string): Op[] {
  const set = scene.componentSets[setId];
  const name = axis.trim();
  const opt = firstOption.trim();
  if (!set || name === "" || opt === "") return [];
  return [
    makeSetComponentSetOp({ ...set, axes: [...set.axes, { name, options: [opt] }] }),
    ...membersOf(scene, setId).map(({ id, c }) => def(id, c, { setId, variant: { ...(c.variant ?? {}), [name]: opt } })),
  ];
}

/** Moves a member to another option of one axis. Empty when another member already has that combination. */
export function setVariantOps(scene: SceneState, componentId: string, axis: string, option: string): Op[] {
  const c = scene.components[componentId];
  if (!c?.setId) return [];
  const variant = { ...(c.variant ?? {}), [axis]: option };
  const taken = membersOf(scene, c.setId).some(({ id, c: o }) =>
    id !== componentId && Object.keys(variant).every((k) => o.variant?.[k] === variant[k]));
  return taken ? [] : [def(componentId, c, { variant })];
}

/** The first combination of options not used by a member of the set (varying the last axis first), or null. */
export function freeCombination(scene: SceneState, setId: string, base: Record<string, string> = {}): Record<string, string> | null {
  const set = scene.componentSets[setId];
  if (!set) return null;
  const used = membersOf(scene, setId).map(({ c }) => c.variant ?? {});
  const combos = set.axes.reduce<Record<string, string>[]>(
    (acc, a) => acc.flatMap((c) => a.options.map((o) => ({ ...c, [a.name]: o }))), [{}]);
  const same = (a: Record<string, string>, b: Record<string, string>) => Object.keys(a).every((k) => b[k] === a[k]);
  // Prefer the combinations that share the base's options on the earlier axes (a sibling of the base).
  const free = combos.filter((c) => !used.some((u) => same(c, u)));
  free.sort((x, y) => Object.keys(base).filter((k) => y[k] === base[k]).length - Object.keys(base).filter((k) => x[k] === base[k]).length);
  return free[0] ?? null;
}

/**
 * A new variant: a copy of the master of `fromId` (placed to its right) registered as another
 * member of the same set, on the first free combination of options. Its properties are
 * copied with their targets pointing at the copies. Null when the component is not in a
 * set or the set has no free combination left (add an option first).
 */
export function duplicateVariantOps(scene: SceneState, fromId: string, name: string): { componentId: string; ops: Op[] } | null {
  const from = scene.components[fromId];
  if (!from?.setId) return null;
  const combo = freeCombination(scene, from.setId, from.variant);
  const root = scene.nodes.at(from.rootNodeId);
  if (!combo || !root) return null;
  const sub = subtreeOf(scene, root.id);
  const ids = new Map(sub.map((n) => [n.id, uuid()]));
  const orderKey = nextOrderKey(scene);
  const ops: Op[] = sub.map((n) => {
    const copy: NodeLite = {
      ...n, id: ids.get(n.id)!,
      parentId: n.id === root.id ? n.parentId : ids.get(n.parentId)!,
      ...(n.id === root.id ? { name, x: n.x + n.width + 40, orderKey } : {}),
    };
    return makeCreateNodeOp(toPbNode(copy));
  });
  const componentId = uuid();
  const properties: ComponentPropertyLite[] = (from.properties ?? []).map((p) => ({
    ...p, targetNodeIds: p.targetNodeIds.map((t) => ids.get(t)).filter((t): t is string => t !== undefined),
  })).filter((p) => p.targetNodeIds.length > 0);
  ops.push(makeCreateComponentOp(componentId, ids.get(root.id)!, name));
  ops.push(makeSetComponentDefOp(componentId, from.setId, combo, properties));
  return { componentId, ops };
}

// ---------- properties ----------

/** The nodes of `selection` that are inside the master of `componentId` (its root included). */
export function selectionInMaster(scene: SceneState, componentId: string, selection: readonly string[]): NodeLite[] {
  const c = scene.components[componentId];
  if (!c) return [];
  const inside = new Set(subtreeOf(scene, c.rootNodeId).map((n) => n.id));
  return selection.filter((id) => inside.has(id)).map((id) => scene.nodes.at(id)).filter((n): n is NodeLite => !!n);
}

/** The attributes a number property can drive, and what each one needs of its targets. */
export const NUMBER_ATTRIBUTES = [
  { value: "opacity", label: "Opacity (0-1)" },
  { value: "corner_radius", label: "Corner radius" },
  { value: "font_size", label: "Font size" },
] as const;

const attributeOf = (attribute: string, n: NodeLite): number | undefined =>
  attribute === "opacity" ? n.opacity
    : attribute === "corner_radius" ? (n.kind === "rect" ? n.cornerRadius : undefined)
      : n.kind === "text" ? (n.text?.style.fontSize || 16) : undefined;

/**
 * A property named `name` over `targets`: BOOLEAN shows/hides them, TEXT sets the content of
 * text nodes, NUMBER writes `attribute` of them (opacity of any node, corner radius of
 * rectangles, font size of text nodes), SWAP points nested instances at another component.
 * The default is what the first usable target has now. Empty when invalid.
 */
export function addPropertyOps(
  scene: SceneState, componentId: string, type: ComponentPropertyLite["type"], name: string, targets: readonly NodeLite[],
  attribute = "opacity",
): Op[] {
  const c = scene.components[componentId];
  const n = name.trim();
  if (!c || n === "" || (c.properties ?? []).some((p) => p.name === n)) return [];
  const usable = type === "text" ? targets.filter((t) => t.kind === "text" && t.text)
    : type === "swap" ? targets.filter((t) => t.kind === "instance")
      : type === "number" ? targets.filter((t) => attributeOf(attribute, t) !== undefined)
        : [...targets];
  if (usable.length === 0) return [];
  const prop: ComponentPropertyLite = {
    name: n, type,
    defaultValue: type === "boolean" ? "true"
      : type === "number" ? String(Math.round((attributeOf(attribute, usable[0]) ?? 0) * 1000) / 1000)
        : type === "swap" ? "" : (usable[0].text?.content ?? "").slice(0, 200),
    targetNodeIds: usable.map((t) => t.id),
    ...(type === "number" ? { attribute } : {}),
  };
  return [def(componentId, c, { properties: [...(c.properties ?? []), prop] })];
}

/**
 * The option list of a text property (empty list = free text). The default stays when it is
 * still allowed, else becomes the first option.
 */
export function setPropertyOptionsOps(scene: SceneState, componentId: string, name: string, options: readonly string[]): Op[] {
  const c = scene.components[componentId];
  const p = c?.properties?.find((x) => x.name === name);
  if (!c || !p || p.type !== "text") return [];
  const list = [...new Set(options.map((o) => o.trim()).filter((o) => o !== ""))];
  const next: ComponentPropertyLite = { ...p, defaultValue: list.length > 0 && !list.includes(p.defaultValue) ? list[0] : p.defaultValue };
  if (list.length > 0) next.options = list; else delete next.options;
  return [def(componentId, c, { properties: c.properties!.map((x) => (x.name === name ? next : x)) })];
}

export function removePropertyOps(scene: SceneState, componentId: string, name: string): Op[] {
  const c = scene.components[componentId];
  if (!c?.properties?.some((p) => p.name === name)) return [];
  return [def(componentId, c, { properties: c.properties.filter((p) => p.name !== name) })];
}

/** Changes the default value of a property. Empty when the value is not valid for its type (a swap may also be empty: keep the nested component). */
export function setPropertyDefaultOps(scene: SceneState, componentId: string, name: string, value: string): Op[] {
  const c = scene.components[componentId];
  const p = c?.properties?.find((x) => x.name === name);
  if (!c || !p) return [];
  if (p.type === "swap" ? value !== "" && (value === componentId || !scene.components[value]) : !valueFits(scene, p, value)) return [];
  return [def(componentId, c, { properties: (c.properties ?? []).map((x) => (x.name === name ? { ...x, defaultValue: value } : x)) })];
}
