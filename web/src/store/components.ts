import type { ComponentProperty as PbProperty, ComponentSet as PbSet, SetComponentDef } from "../gen/opendesigner/v1/opendesigner_pb";
import { ComponentPropertyType } from "../gen/opendesigner/v1/opendesigner_pb";
import type { ComponentLite, ComponentPropertyLite, ComponentSetLite, InstanceLite, InstanceOverrideLite, NodeLite, SceneState } from "./types";

// COMPONENT VARIANTS AND PROPERTIES -- the TypeScript twin of
// internal/core/components.go. Go is the authority; every rule here repeats one
// there, and the golden fixture testdata/golden/component_variants.json runs both
// sides. See the invariants at the top of that file.

const NAME_RE = /^[\p{L}\p{N} _.\-]{1,32}$/u;
const MAX_TEXT_BYTES = 1000;
const utf8Len = (s: string) => new TextEncoder().encode(s).length;

/** Parity with core.validateComponentSet. */
export function isValidComponentSet(s: PbSet | undefined): s is PbSet {
  if (!s || s.id === "" || s.axes.length === 0) return false;
  const names = new Set<string>();
  for (const a of s.axes) {
    if (!NAME_RE.test(a.name) || names.has(a.name) || a.options.length === 0) return false;
    names.add(a.name);
    const opts = new Set<string>();
    for (const o of a.options) {
      if (!NAME_RE.test(o) || opts.has(o)) return false;
      opts.add(o);
    }
  }
  return true;
}

/** `variant` assigns exactly one valid option to every axis of `set`. Parity with core.assignmentValid. */
export function assignmentValid(set: ComponentSetLite, variant: Readonly<Record<string, string>> | undefined): boolean {
  const v = variant ?? {};
  if (Object.keys(v).length !== set.axes.length) return false;
  return set.axes.every((a) => a.name in v && a.options.includes(v[a.name]));
}

function sameAssignment(a: Readonly<Record<string, string>> | undefined, b: Readonly<Record<string, string>> | undefined): boolean {
  const x = a ?? {}, y = b ?? {};
  const keys = Object.keys(x);
  return keys.length === Object.keys(y).length && keys.every((k) => k in y && y[k] === x[k]);
}

/** Node `id` is the master's root or one of its descendants. Parity with core.inMasterSubtree. */
function inMasterSubtree(state: SceneState, id: string, root: string): boolean {
  for (let cur = state.nodes.at(id), g = 0; cur && g < 10000; cur = state.nodes.at(cur.parentId), g++) {
    if (cur.id === root) return true;
  }
  return false;
}

function validProperties(state: SceneState, root: string, props: readonly PbProperty[]): boolean {
  const names = new Set<string>();
  for (const p of props) {
    if (!NAME_RE.test(p.name) || names.has(p.name)) return false;
    names.add(p.name);
    if (p.type === ComponentPropertyType.BOOLEAN) {
      if (p.defaultValue !== "true" && p.defaultValue !== "false") return false;
    } else if (p.type === ComponentPropertyType.TEXT) {
      if (utf8Len(p.defaultValue) > MAX_TEXT_BYTES) return false;
    } else return false;
    if (p.targetNodeIds.length === 0) return false;
    const seen = new Set<string>();
    for (const t of p.targetNodeIds) {
      const n = state.nodes.at(t);
      if (!n || seen.has(t) || !inMasterSubtree(state, t, root)) return false;
      seen.add(t);
      if (p.type === ComponentPropertyType.TEXT && n.kind !== "text") return false;
    }
  }
  return true;
}

/** Parity with core.validateComponentDef. */
export function isValidComponentDef(state: SceneState, d: SetComponentDef): boolean {
  const comp = state.components[d.componentId];
  if (!comp) return false;
  if (!validProperties(state, comp.rootNodeId, d.properties)) return false;
  if (d.setId === "") return Object.keys(d.variant).length === 0;
  const set = state.componentSets[d.setId];
  if (!set || !assignmentValid(set, d.variant)) return false;
  for (const [id, other] of Object.entries(state.components)) {
    if (id !== d.componentId && other.setId === d.setId && sameAssignment(other.variant, d.variant)) return false;
  }
  return true;
}

/** Members whose assignment is no longer valid (the set changed, or is gone) become standalone. Parity with core.detachInvalidMembers. */
export function detachInvalidMembers(state: SceneState, setId: string): Record<string, ComponentLite> {
  const set = state.componentSets[setId];
  let out = state.components;
  for (const [id, c] of Object.entries(state.components)) {
    if (c.setId !== setId || (set && assignmentValid(set, c.variant))) continue;
    if (out === state.components) out = { ...out };
    const { setId: _s, variant: _v, ...rest } = c;
    out[id] = rest;
  }
  return out;
}

/** The deleted nodes leave the property targets; a property left without targets goes away. Parity with core.cascadeComponentTargets. */
export function cascadeComponentTargets(state: SceneState, gone: ReadonlySet<string>): Partial<Pick<SceneState, "components">> {
  let out = state.components;
  for (const [id, c] of Object.entries(state.components)) {
    if (!c.properties) continue;
    let changed = false;
    const kept: ComponentPropertyLite[] = [];
    for (const p of c.properties) {
      const targets = p.targetNodeIds.filter((t) => !gone.has(t));
      if (targets.length === p.targetNodeIds.length) { kept.push(p); continue; }
      changed = true;
      if (targets.length > 0) kept.push({ ...p, targetNodeIds: targets });
    }
    if (!changed) continue;
    if (out === state.components) out = { ...out };
    const { properties: _p, ...rest } = c;
    out[id] = kept.length > 0 ? { ...rest, properties: kept } : rest;
  }
  return out === state.components ? {} : { components: out };
}

function propertyValueValid(p: ComponentPropertyLite, v: string): boolean {
  return p.type === "boolean" ? v === "true" || v === "false" : utf8Len(v) <= MAX_TEXT_BYTES;
}

/**
 * The id of the component an instance renders: the member of its base component's set
 * that matches the instance's variant choice over the base assignment, or the base
 * component itself. Parity with core.EffectiveComponentID.
 */
export function effectiveComponentId(state: SceneState, inst: Pick<InstanceLite, "componentId" | "variantProps">): string {
  const base = inst.componentId;
  const comp = state.components[base];
  if (!comp || !comp.setId || !inst.variantProps || Object.keys(inst.variantProps).length === 0) return base;
  const want: Record<string, string> = { ...(comp.variant ?? {}) };
  for (const [k, v] of Object.entries(inst.variantProps)) if (k in want) want[k] = v;
  const ids = Object.entries(state.components)
    .filter(([, c]) => c.setId === comp.setId && sameAssignment(c.variant, want))
    .map(([id]) => id)
    .sort();
  return ids[0] ?? base;
}

/** Parity with core.PropertyValue: the instance's value when valid for the type, else the default. */
export function propertyValue(inst: Pick<InstanceLite, "propertyValues">, p: ComponentPropertyLite): string {
  const v = inst.propertyValues?.[p.name];
  return v !== undefined && propertyValueValid(p, v) ? v : p.defaultValue;
}

/**
 * What an instance changes in its master, by master node id: the overrides derived from
 * the component's properties (a text property sets the content of its text targets,
 * a false boolean property hides its targets) under the instance's explicit overrides,
 * which win. Parity with core.EffectiveOverrides.
 */
export function effectiveOverrides(state: SceneState, n: NodeLite): Map<string, InstanceOverrideLite> {
  const map = new Map<string, InstanceOverrideLite>();
  const inst = n.instance;
  if (!inst) return map;
  const comp = state.components[effectiveComponentId(state, inst)];
  for (const p of comp?.properties ?? []) {
    const v = propertyValue(inst, p);
    for (const t of p.targetNodeIds) {
      if (p.type === "boolean") {
        if (v === "false") map.set(t, { ...map.get(t), masterNodeId: t, hidden: true });
      } else {
        map.set(t, { ...map.get(t), masterNodeId: t, text: v });
      }
    }
  }
  for (const o of inst.overrides) {
    const base = map.get(o.masterNodeId);
    map.set(o.masterNodeId, base
      ? { ...base, ...(o.fills !== undefined ? { fills: o.fills } : {}), ...(o.text !== undefined ? { text: o.text } : {}) }
      : o);
  }
  return map;
}

/** Parity with core.validateInstanceProps. */
export function isValidInstanceProps(
  state: SceneState, inst: InstanceLite,
  values: Readonly<Record<string, string>>, variants: Readonly<Record<string, string>>,
): boolean {
  const base = state.components[inst.componentId];
  if (!base) return false;
  if (Object.keys(variants).length > 0) {
    const set = base.setId ? state.componentSets[base.setId] : undefined;
    if (!set) return false;
    for (const [axis, opt] of Object.entries(variants)) {
      if (!set.axes.some((a) => a.name === axis && a.options.includes(opt))) return false;
    }
  }
  const comp = state.components[effectiveComponentId(state, { componentId: inst.componentId, variantProps: { ...variants } })];
  for (const [name, v] of Object.entries(values)) {
    const prop = comp?.properties?.find((p) => p.name === name);
    if (!prop || !propertyValueValid(prop, v)) return false;
  }
  return true;
}
