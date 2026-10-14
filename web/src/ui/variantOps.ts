import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import type { ComponentSetLite, SceneState } from "../store/types";
import { membersOf, variantWith } from "../store/variants";
import { makeDeleteComponentSetOp, makeSetComponentSetOp, makeSetComponentVariantOp, makeSwapInstanceOp, uuid } from "../tools/ops";

// Op builders of the variant-set editor (Components panel) and of the instance
// "Variant" picker (properties panel). Pure: scene in, ops out; the caller wraps
// them in ONE gesture. The server migrates members when a set's properties
// change (core.migrateVariant), so adding a property or a value is one op.

const keyOf = (v: Record<string, string>) => JSON.stringify(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)));

/** Every combination of the set's property values, first value of the first property varying slowest. */
export function allCombinations(set: ComponentSetLite): Record<string, string>[] {
  let combos: Record<string, string>[] = [{}];
  for (const p of set.properties) combos = combos.flatMap((c) => p.values.map((v) => ({ ...c, [p.name]: v })));
  return combos;
}

/** The first combination no member of the set has yet; undefined when all are taken. */
export function firstFreeCombination(scene: SceneState, set: ComponentSetLite): Record<string, string> | undefined {
  const taken = new Set(membersOf(scene, set.id).map((m) => keyOf(m.component.variant ?? {})));
  return allCombinations(set).find((c) => !taken.has(keyOf(c)));
}

/** A new set with one property, "Variant", of one value: a starting point to rename and extend. */
export function newSetOps(scene: SceneState): Op[] {
  const n = Object.keys(scene.componentSets ?? {}).length + 1;
  return [makeSetComponentSetOp({ id: uuid(), name: `Variants ${n}`, properties: [{ name: "Variant", values: ["Default"] }] })];
}

export function renameSetOps(set: ComponentSetLite, name: string): Op[] {
  const t = name.trim();
  return t === "" || t === set.name ? [] : [makeSetComponentSetOp({ ...set, name: t })];
}

export function deleteSetOps(id: string): Op[] {
  return [makeDeleteComponentSetOp(id)];
}

/** A property named `name` with one value ("Default"); members get that value. Names must be unique. */
export function addPropertyOps(set: ComponentSetLite, name: string): Op[] {
  const t = name.trim();
  if (t === "" || set.properties.some((p) => p.name === t)) return [];
  return [makeSetComponentSetOp({ ...set, properties: [...set.properties, { name: t, values: ["Default"] }] })];
}

/** Renames a property; members keep their choice (the server carries it over). */
export function renamePropertyOps(set: ComponentSetLite, from: string, to: string): Op[] {
  const t = to.trim();
  if (t === "" || t === from || set.properties.some((p) => p.name === t)) return [];
  return [makeSetComponentSetOp(
    { ...set, properties: set.properties.map((p) => (p.name === from ? { ...p, name: t } : p)) },
    { properties: { [from]: t } },
  )];
}

/** Renames one value of a property; members that had it keep it under the new name. */
export function renameValueOps(set: ComponentSetLite, property: string, from: string, to: string): Op[] {
  const t = to.trim();
  const p = set.properties.find((x) => x.name === property);
  if (!p || t === "" || t === from || p.values.includes(t)) return [];
  return [makeSetComponentSetOp(
    { ...set, properties: set.properties.map((x) => (x.name === property ? { ...x, values: x.values.map((v) => (v === from ? t : v)) } : x)) },
    { values: [{ property, from, to: t }] },
  )];
}

/** Removes a value (members that had it move to the property's first value; refused by the server if that merges two variants). */
export function removeValueOps(set: ComponentSetLite, property: string, value: string): Op[] {
  const p = set.properties.find((x) => x.name === property);
  if (!p || p.values.length <= 1) return [];
  return [makeSetComponentSetOp({ ...set, properties: set.properties.map((x) => (x.name === property ? { ...x, values: x.values.filter((v) => v !== value) } : x)) })];
}

export function removePropertyOps(set: ComponentSetLite, property: string): Op[] {
  return [makeSetComponentSetOp({ ...set, properties: set.properties.filter((p) => p.name !== property) })];
}

export function addValueOps(set: ComponentSetLite, property: string, value: string): Op[] {
  const t = value.trim();
  const p = set.properties.find((x) => x.name === property);
  if (!p || t === "" || p.values.includes(t)) return [];
  return [makeSetComponentSetOp({ ...set, properties: set.properties.map((x) => (x.name === property ? { ...x, values: [...x.values, t] } : x)) })];
}

/**
 * Puts a component in the set on the first free combination. If every
 * combination is taken, the first property gets a new value first (same gesture).
 */
export function addMemberOps(scene: SceneState, set: ComponentSetLite, componentId: string): Op[] {
  const free = firstFreeCombination(scene, set);
  if (free) return [makeSetComponentVariantOp(componentId, set.id, free)];
  if (set.properties.length === 0) return [];
  const first = set.properties[0];
  const value = `${first.name} ${first.values.length + 1}`;
  const grown: ComponentSetLite = { ...set, properties: set.properties.map((p, i) => (i === 0 ? { ...p, values: [...p.values, value] } : p)) };
  const combo = Object.fromEntries(grown.properties.map((p, i) => [p.name, i === 0 ? value : p.values[0]]));
  return [makeSetComponentSetOp(grown), makeSetComponentVariantOp(componentId, set.id, combo)];
}

export function removeMemberOps(componentId: string): Op[] {
  return [makeSetComponentVariantOp(componentId, "", {})];
}

/** The values of `property` a member can take: those whose combination no OTHER member has. */
export function freeValues(scene: SceneState, set: ComponentSetLite, componentId: string, property: string): Set<string> {
  const me = scene.components[componentId]?.variant ?? {};
  const taken = new Set(membersOf(scene, set.id).filter((m) => m.id !== componentId).map((m) => keyOf(m.component.variant ?? {})));
  const p = set.properties.find((x) => x.name === property);
  return new Set((p?.values ?? []).filter((v) => !taken.has(keyOf({ ...me, [property]: v }))));
}

export function setMemberValueOps(scene: SceneState, set: ComponentSetLite, componentId: string, property: string, value: string): Op[] {
  const me = scene.components[componentId]?.variant ?? {};
  if (me[property] === value || !freeValues(scene, set, componentId, property).has(value)) return [];
  return [makeSetComponentVariantOp(componentId, set.id, { ...me, [property]: value })];
}

/** Switches an instance to the variant with `property = value` (other properties as they are); no op if that combination does not exist. */
export function switchInstanceOps(scene: SceneState, instanceId: string, property: string, value: string): Op[] {
  const n = scene.nodes.get(instanceId);
  if (!n?.instance) return [];
  const target = variantWith(scene, n.instance.componentId, property, value);
  return target && target !== n.instance.componentId ? [makeSwapInstanceOp(instanceId, target)] : [];
}
