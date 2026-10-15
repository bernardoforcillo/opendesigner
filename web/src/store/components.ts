import type { ComponentProperty as PbProperty, ComponentSet as PbSet, OptionRename, SetComponentDef } from "../gen/opendesigner/v1/opendesigner_pb";
import { ComponentPropertyType } from "../gen/opendesigner/v1/opendesigner_pb";
import type { ComponentLite, ComponentPropertyLite, ComponentSetLite, InstanceLite, InstanceOverrideLite, NodeLite, SceneState } from "./types";
import type { NodeMap } from "./nodeMap";

// COMPONENT VARIANTS AND PROPERTIES -- the TypeScript twin of
// internal/core/components.go. Go is the authority; every rule here repeats one
// there, and the golden fixture testdata/golden/component_variants.json runs both
// sides. See the invariants at the top of that file.

const NAME_RE = /^[\p{L}\p{N} _.\-]{1,32}$/u;
const MAX_TEXT_BYTES = 1000;
const utf8Len = (s: string) => new TextEncoder().encode(s).length;

// What a NUMBER value may look like: plain decimal, optional exponent (core.numberRe).
const NUMBER_RE = /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const NUMBER_ATTRS = new Set(["opacity", "corner_radius", "font_size"]);

/** A NUMBER value for `attr`: finite and in the attribute's range, else null. Parity with core.parseNumber. */
export function parseNumber(attr: string | undefined, v: string): number | null {
  if (v.length > 32 || !NUMBER_RE.test(v)) return null;
  const f = Number(v);
  if (!Number.isFinite(f)) return null;
  switch (attr) {
    case "opacity": return f >= 0 && f <= 1 ? f : null;
    case "corner_radius": return f >= 0 ? f : null;
    case "font_size": return f > 0 ? f : null;
  }
  return null;
}

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

function validProperties(state: SceneState, componentId: string, root: string, props: readonly PbProperty[]): boolean {
  const names = new Set<string>();
  for (const p of props) {
    if (!NAME_RE.test(p.name) || names.has(p.name)) return false;
    names.add(p.name);
    if ((p.attribute !== "") !== (p.type === ComponentPropertyType.NUMBER)) return false;
    if (p.options.length > 0 && p.type !== ComponentPropertyType.TEXT) return false;
    if (p.type === ComponentPropertyType.BOOLEAN) {
      if (p.defaultValue !== "true" && p.defaultValue !== "false") return false;
    } else if (p.type === ComponentPropertyType.TEXT) {
      if (utf8Len(p.defaultValue) > MAX_TEXT_BYTES) return false;
      if (p.options.length > 0) {
        const seen = new Set<string>();
        for (const o of p.options) {
          if (o === "" || utf8Len(o) > MAX_TEXT_BYTES || seen.has(o)) return false;
          seen.add(o);
        }
        if (!seen.has(p.defaultValue)) return false;
      }
    } else if (p.type === ComponentPropertyType.NUMBER) {
      if (!NUMBER_ATTRS.has(p.attribute) || parseNumber(p.attribute, p.defaultValue) === null) return false;
    } else if (p.type === ComponentPropertyType.INSTANCE_SWAP) {
      // "" keeps the nested instance's own component.
      if (p.defaultValue !== "" && (p.defaultValue === componentId || !state.components[p.defaultValue])) return false;
    } else return false;
    if (p.targetNodeIds.length === 0) return false;
    const seen = new Set<string>();
    for (const t of p.targetNodeIds) {
      const n = state.nodes.at(t);
      if (!n || seen.has(t) || !inMasterSubtree(state, t, root) || !targetFits(p, n)) return false;
      seen.add(t);
    }
  }
  return true;
}

/** Node `n` can be driven by property `p`. Parity with core.targetFits. */
function targetFits(p: PbProperty, n: NodeLite): boolean {
  if (p.type === ComponentPropertyType.TEXT) return n.kind === "text";
  if (p.type === ComponentPropertyType.INSTANCE_SWAP) return n.kind === "instance";
  if (p.type === ComponentPropertyType.NUMBER) {
    if (p.attribute === "corner_radius") return n.kind === "rect";
    if (p.attribute === "font_size") return n.kind === "text";
  }
  return true;
}

/** Parity with core.validateComponentDef. */
export function isValidComponentDef(state: SceneState, d: SetComponentDef): boolean {
  const comp = state.components[d.componentId];
  if (!comp) return false;
  if (!validProperties(state, d.componentId, comp.rootNodeId, d.properties)) return false;
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

function propertyValueValid(state: SceneState, p: ComponentPropertyLite, v: string): boolean {
  switch (p.type) {
    case "boolean": return v === "true" || v === "false";
    case "text": return p.options?.length ? p.options.includes(v) : utf8Len(v) <= MAX_TEXT_BYTES;
    case "number": return parseNumber(p.attribute, v) !== null;
    case "swap": return !!state.components[v];
  }
}

/**
 * The id of the component an instance renders: the member of its base component's set
 * that matches the instance's variant choice over the base assignment, or the base
 * component itself. Parity with core.EffectiveComponentID.
 */
export function effectiveComponentId(
  state: SceneState, inst: Pick<InstanceLite, "componentId" | "variantProps">, swappedTo?: string,
): string {
  // A swap property of the instance this one sits in may have pointed it at another component.
  const base = swappedTo !== undefined && state.components[swappedTo] ? swappedTo : inst.componentId;
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
export function propertyValue(state: SceneState, inst: Pick<InstanceLite, "propertyValues">, p: ComponentPropertyLite): string {
  const v = inst.propertyValues?.[p.name];
  return v !== undefined && propertyValueValid(state, p, v) ? v : p.defaultValue;
}

/**
 * What an instance changes in its master, by master node id: the overrides derived from
 * the component's properties (a text property sets the content of its text targets, a
 * false boolean property hides its targets, a number property writes the opacity /
 * corner radius / font size of its targets, a swap property points its nested instances
 * at another component) under the instance's explicit overrides, which win. `swappedTo`
 * is the component a swap property of the OUTER instance pointed this one at. Parity with
 * core.EffectiveOverrides for what Go derives (text, hidden).
 */
export function effectiveOverrides(state: SceneState, n: NodeLite, swappedTo?: string): Map<string, InstanceOverrideLite> {
  const map = new Map<string, InstanceOverrideLite>();
  const inst = n.instance;
  if (!inst) return map;
  const comp = state.components[effectiveComponentId(state, inst, swappedTo)];
  for (const p of comp?.properties ?? []) {
    const v = propertyValue(state, inst, p);
    for (const t of p.targetNodeIds) {
      const base = { ...map.get(t), masterNodeId: t };
      if (p.type === "boolean") {
        if (v === "false") map.set(t, { ...base, hidden: true });
      } else if (p.type === "text") {
        map.set(t, { ...base, text: v });
      } else if (p.type === "number") {
        const f = parseNumber(p.attribute, v);
        if (f === null) continue;
        map.set(t, { ...base, ...(p.attribute === "opacity" ? { opacity: f } : p.attribute === "corner_radius" ? { cornerRadius: f } : { fontSize: f }) });
      } else if (v !== "") {
        map.set(t, { ...base, componentId: v });
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
    if (!prop || !propertyValueValid(state, prop, v)) return false;
  }
  return true;
}

// ---------- renames ----------

/**
 * The axis / option renames of a setComponentSet, validated against the NEW set: axis
 * renames old -> new, option renames per NEW axis name old -> new. One-to-one, and they
 * must point at what the new set has. Null when invalid. Parity with core.newRenamer.
 */
export interface Renamer {
  axes: Readonly<Record<string, string>>;
  opts: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** No rename at all (the common case). */
  empty: boolean;
}

export function makeRenamer(set: PbSet, axes: Readonly<Record<string, string>>, options: readonly OptionRename[]): Renamer | null {
  const byName = new Map(set.axes.map((a) => [a.name, a]));
  const targets = new Set<string>();
  for (const to of Object.values(axes)) {
    if (!byName.has(to) || targets.has(to)) return null;
    targets.add(to);
  }
  const opts: Record<string, Record<string, string>> = {};
  const taken: Record<string, Set<string>> = {};
  for (const o of options) {
    const a = byName.get(o.axis);
    if (!a || !a.options.includes(o.to) || (opts[o.axis]?.[o.from] ?? "") !== "") return null;
    if (!opts[o.axis]) { opts[o.axis] = {}; taken[o.axis] = new Set(); }
    if (taken[o.axis].has(o.to)) return null;
    taken[o.axis].add(o.to);
    opts[o.axis][o.from] = o.to;
  }
  return { axes: { ...axes }, opts, empty: Object.keys(axes).length === 0 && Object.keys(opts).length === 0 };
}

/** A choice (axis -> option) carried over the renames. Parity with core.renamer.variant. */
export function renameChoice(r: Renamer, v: Readonly<Record<string, string>> | undefined): Record<string, string> | undefined {
  if (!v || Object.keys(v).length === 0) return v ? { ...v } : undefined;
  const out: Record<string, string> = {};
  for (const [k0, o0] of Object.entries(v)) {
    const k = r.axes[k0] ?? k0;
    out[k] = r.opts[k]?.[o0] ?? o0;
  }
  return out;
}

/**
 * Carries the members of set `set.id` and the instances of those members over the renames,
 * BEFORE the set is replaced. Null when the renames would make two members that stay
 * valid in the new set the same combination. Parity with core.applySetComponentSet.
 */
export function carryRenames(state: SceneState, set: PbSet, r: Renamer): { components: Record<string, ComponentLite>; nodes: NodeMap } | null {
  const members: Record<string, Record<string, string> | undefined> = {};
  for (const [id, c] of Object.entries(state.components)) if (c.setId === set.id) members[id] = renameChoice(r, c.variant);
  const next: ComponentSetLite = { id: set.id, name: set.name, axes: set.axes.map((a) => ({ name: a.name, options: [...a.options] })) };
  const ids = Object.keys(members).sort();
  const valid = ids.filter((id) => assignmentValid(next, members[id]));
  for (let i = 0; i < valid.length; i++) {
    for (let k = 0; k < i; k++) if (sameAssignment(members[valid[k]], members[valid[i]])) return null;
  }
  const components = { ...state.components };
  for (const id of ids) {
    const { variant: _v, ...rest } = components[id];
    const v = members[id];
    components[id] = v ? { ...rest, variant: v } : rest;
  }
  const edit = state.nodes.edit();
  for (const n of state.nodes.values()) {
    const inst = n.instance;
    if (!inst?.variantProps || Object.keys(inst.variantProps).length === 0 || !(inst.componentId in members)) continue;
    edit.set(n.id, { ...n, instance: { ...inst, variantProps: renameChoice(r, inst.variantProps) } });
  }
  return { components, nodes: edit.done() };
}

/** The renames that undo `r` (new -> old), against the set `prev` the op replaced. */
export function reverseRenames(prev: ComponentSetLite, r: Renamer): { axes: Record<string, string>; options: { axis: string; from: string; to: string }[] } {
  const axes: Record<string, string> = {};
  for (const [from, to] of Object.entries(r.axes)) if (prev.axes.some((a) => a.name === from)) axes[to] = from;
  const oldName = (nw: string) => Object.entries(r.axes).find(([, to]) => to === nw)?.[0] ?? nw;
  const options: { axis: string; from: string; to: string }[] = [];
  for (const [axis, m] of Object.entries(r.opts)) {
    // The undo op targets the OLD set: its axis is named as it was.
    const old = oldName(axis);
    if (!prev.axes.some((a) => a.name === old)) continue;
    const had = prev.axes.find((a) => a.name === old)?.options ?? [];
    for (const [from, to] of Object.entries(m)) if (had.includes(from)) options.push({ axis: old, from: to, to: from });
  }
  return { axes, options };
}
