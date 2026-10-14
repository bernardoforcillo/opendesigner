import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import type { ComponentSetLite, InstanceOverrideLite, NodeLite, SceneState } from "./types";
import { toComponentSetLite } from "./types";
import { childrenOf } from "./tree";

// COMPONENT VARIANTS, client side. Parity with core/variants.go (Go), the
// authority: same validation, same results. A set names properties and their
// allowed values; each member component carries one full combination; an
// instance switches variant by being pointed at another member (swapInstance).

/** Valid set shape: non-empty unique property names, each with >= 1 non-empty unique value. */
export function validSetShape(set: ComponentSetLite): boolean {
  if (set.id === "" || set.name === "") return false;
  const names = new Set<string>();
  for (const p of set.properties) {
    if (p.name === "" || names.has(p.name) || p.values.length === 0) return false;
    names.add(p.name);
    const seen = new Set<string>();
    for (const v of p.values) {
      if (v === "" || seen.has(v)) return false;
      seen.add(v);
    }
  }
  return true;
}

/** The variant gives every property of the set exactly once, with an allowed value, and nothing else. */
export function validCombination(set: ComponentSetLite, variant: Record<string, string> | undefined): boolean {
  const v = variant ?? {};
  if (Object.keys(v).length !== set.properties.length) return false;
  return set.properties.every((p) => v[p.name] !== undefined && p.values.includes(v[p.name]));
}

/** A member's combination carried over renames: property keys first, then the values of each (new-named) property. */
export function renameVariant(
  variant: Record<string, string> | undefined,
  props: Record<string, string>,
  vals: readonly { property: string; from: string; to: string }[],
): Record<string, string> | undefined {
  if (!variant || (Object.keys(props).length === 0 && vals.length === 0)) return variant;
  const out: Record<string, string> = {};
  for (const [k0, v0] of Object.entries(variant)) {
    const k = props[k0] ?? k0;
    out[k] = vals.find((vr) => vr.property === k && vr.from === v0)?.to ?? v0;
  }
  return out;
}

/** A member's combination mapped onto a changed set: dropped properties go, a value no longer allowed (or never given) becomes the property's FIRST value. */
export function migrateVariant(set: ComponentSetLite, variant: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(set.properties.map((p) => [p.name, p.values.includes(variant?.[p.name] ?? "") ? variant![p.name] : p.values[0]]));
}

const sameCombination = (a: Record<string, string> = {}, b: Record<string, string> = {}) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => b[k] === v);

/** The names from `root` (excluded) down to `target`; null if `target` is not under `root`. */
function namePath(s: SceneState, root: string, target: string): string[] | null {
  const rev: string[] = [];
  for (let cur = target; cur !== root; ) {
    const n = s.nodes.get(cur);
    if (!n || n.parentId === "") return null;
    rev.push(n.name);
    cur = n.parentId;
  }
  return rev.reverse();
}

function resolveNamePath(s: SceneState, root: string, path: string[]): string | null {
  let cur = root;
  for (const name of path) {
    const next = childrenOf(s, cur).find((c) => c.name === name);
    if (!next) return null;
    cur = next.id;
  }
  return cur;
}

/** Overrides of `instance` carried to the master `next` by name path; those with no counterpart are dropped. */
function remapOverrides(s: SceneState, instance: NodeLite, nextRoot: string): InstanceOverrideLite[] {
  const prev = s.components[instance.instance!.componentId];
  const out = new Map<string, InstanceOverrideLite>();
  if (!prev) return [];
  for (const o of instance.instance!.overrides) {
    const path = namePath(s, prev.rootNodeId, o.masterNodeId);
    if (!path) continue;
    const target = resolveNamePath(s, nextRoot, path);
    if (target) out.set(target, { ...o, masterNodeId: target });   // the LAST one per master wins, as in Go
  }
  return [...out.values()];
}

/** The four variant ops; undefined if `op` is not one of them. Invalid ops leave the state unchanged, as Go rejects them. */
export function applyVariantOp(s: SceneState, op: Op): SceneState | undefined {
  switch (op.kind.case) {
    case "setComponentSet": {
      const pb = op.kind.value.set;
      if (!pb) return s;
      const set = toComponentSetLite(pb);
      if (!validSetShape(set)) return s;
      // Members are migrated onto the new properties (core.migrateVariant); the op is
      // refused if that would make two of them the same variant.
      const propRenames = op.kind.value.propertyRenames;
      const valueRenames = op.kind.value.valueRenames;
      // Renames must point at something the new set has (core.applySetComponentSet).
      const newProp = (name: string) => set.properties.find((p) => p.name === name);
      for (const nw of Object.values(propRenames)) if (!newProp(nw)) return s;
      for (const vr of valueRenames) if (!newProp(vr.property)?.values.includes(vr.to)) return s;
      const ids = Object.keys(s.components).filter((id) => s.components[id].setId === set.id).sort();
      const migrated: Record<string, Record<string, string>> = {};
      for (const id of ids) {
        const m = migrateVariant(set, renameVariant(s.components[id].variant, propRenames, valueRenames));
        if (Object.values(migrated).some((o) => sameCombination(o, m))) return s;
        migrated[id] = m;
      }
      const components = { ...s.components };
      for (const [id, variant] of Object.entries(migrated)) components[id] = { ...components[id], variant };
      return { ...s, components, componentSets: { ...s.componentSets, [set.id]: set } };
    }
    case "deleteComponentSet": {
      const { id } = op.kind.value;
      if (!s.componentSets?.[id]) return s;
      const componentSets = { ...s.componentSets };
      delete componentSets[id];
      const components = Object.fromEntries(Object.entries(s.components).map(([cid, c]) => {
        if (c.setId !== id) return [cid, c];
        const { setId: _s, variant: _v, ...rest } = c;
        return [cid, rest];
      }));
      return { ...s, componentSets, components };
    }
    case "setComponentVariant": {
      const { componentId, setId, variant } = op.kind.value;
      const c = s.components[componentId];
      if (!c) return s;
      if (setId === "") {
        if (Object.keys(variant).length > 0) return s;
        const { setId: _s, variant: _v, ...rest } = c;
        return { ...s, components: { ...s.components, [componentId]: rest } };
      }
      const set = s.componentSets?.[setId];
      if (!set || !validCombination(set, variant)) return s;
      for (const [id, o] of Object.entries(s.components)) {
        if (id !== componentId && o.setId === setId && sameCombination(o.variant, variant)) return s;
      }
      return { ...s, components: { ...s.components, [componentId]: { ...c, setId, variant: { ...variant } } } };
    }
    case "swapInstance": {
      const { instanceId, componentId } = op.kind.value;
      const n = s.nodes.get(instanceId);
      if (!n || n.kind !== "instance" || !n.instance) return s;
      const next = s.components[componentId];
      if (!next) return s;
      // A component cannot contain an instance of itself.
      for (let cur = n.parentId; cur !== ""; ) {
        if (cur === next.rootNodeId) return s;
        const p = s.nodes.get(cur);
        if (!p) break;
        cur = p.parentId;
      }
      const overrides = remapOverrides(s, n, next.rootNodeId);
      return { ...s, nodes: s.nodes.set(instanceId, { ...n, instance: { ...n.instance, componentId, overrides } }) };
    }
    default:
      return undefined;
  }
}

/** The members of a set, with the combination each one is. */
export function membersOf(s: SceneState, setId: string): { id: string; component: SceneState["components"][string] }[] {
  return Object.entries(s.components).filter(([, c]) => c.setId === setId).map(([id, component]) => ({ id, component }));
}

/**
 * The component of the same set as `current` that has `prop = value` and every
 * other property as `current` has it; undefined if that combination does not exist.
 */
export function variantWith(s: SceneState, currentComponentId: string, prop: string, value: string): string | undefined {
  const cur = s.components[currentComponentId];
  if (!cur?.setId) return undefined;
  const want = { ...cur.variant, [prop]: value };
  return membersOf(s, cur.setId).find((m) => sameCombination(m.component.variant, want))?.id;
}
