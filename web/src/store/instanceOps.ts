import type { InstanceNode as PbInstanceNode } from "../gen/opendesigner/v1/opendesigner_pb";
import { effectiveComponentId, effectiveOverrides, isValidInstanceProps, propertyValueValid } from "./components";
import { childrenOf, subtreeOf } from "./tree";
import { toInstanceLite, type InstanceLite, type InstanceOverrideLite, type NodeLite, type SceneState } from "./types";

// INSTANCE OPERATIONS -- swap, reset, detach and "go to main component". The TypeScript twin of
// internal/core/instances.go, which is the authority (same rules, same order).
//
// One op carries them all: setInstance replaces an instance's payload WHOLESALE (component,
// overrides, property values, variant choice), so a swap is the same op with another
// component and a reset the same op with the lists emptied; its inverse is the previous
// payload. A detach has no op of its own: it is a deleteNode of the instance and createNodes of
// the plain nodes that take its place (detachInstance), so undo and replication come for free.

const inSubtree = (state: SceneState, id: string, root: string): boolean => {
  for (let cur: NodeLite | undefined = state.nodes.at(id), g = 0; cur && g < 10000; cur = state.nodes.at(cur.parentId), g++) {
    if (cur.id === root) return true;
  }
  return false;
};

/** The components whose master subtree holds node `id`. */
function containingComponents(state: SceneState, id: string): string[] {
  return Object.entries(state.components)
    .filter(([, c]) => c.rootNodeId !== "" && inSubtree(state, id, c.rootNodeId))
    .map(([cid]) => cid)
    .sort();
}

/** Showing component `from` ends up showing an instance of `target` (through nested instances and set variants). */
function componentReaches(state: SceneState, from: string, target: string, seen: Set<string>): boolean {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  const cands = [from];
  const set = state.components[from]?.setId;
  if (set) for (const [cid, c] of Object.entries(state.components)) if (c.setId === set && cid !== from) cands.push(cid);
  for (const cid of cands) {
    const c = state.components[cid];
    if (!c) continue;
    for (const n of subtreeOf(state, c.rootNodeId)) {
      if (n.instance && componentReaches(state, n.instance.componentId, target, seen)) return true;
    }
  }
  return false;
}

/** Instance node `id`, pointing at `componentId`, would show itself. */
export function instanceCycle(state: SceneState, id: string, componentId: string): boolean {
  return containingComponents(state, id).some((host) => componentReaches(state, componentId, host, new Set()));
}

function overrideTargetOk(state: SceneState, componentId: string, masterNodeId: string): boolean {
  if (!state.nodes.at(masterNodeId)) return false;
  const base = state.components[componentId];
  if (!base) return false;
  if (inSubtree(state, masterNodeId, base.rootNodeId)) return true;
  if (!base.setId) return false;
  return Object.values(state.components).some((c) => c.setId === base.setId && inSubtree(state, masterNodeId, c.rootNodeId));
}

/** Parity with core.validateInstanceBody. */
export function isValidInstanceBody(state: SceneState, id: string, body: PbInstanceNode | undefined): body is PbInstanceNode {
  if (!body) return false;
  const base = state.components[body.componentId];
  if (!base || !state.nodes.at(base.rootNodeId)) return false;
  if (instanceCycle(state, id, body.componentId)) return false;
  const seen = new Set<string>();
  for (const o of body.overrides) {
    if (o.masterNodeId === "" || seen.has(o.masterNodeId) || !(o.fillsPresent || o.textPresent) || !overrideTargetOk(state, body.componentId, o.masterNodeId)) return false;
    seen.add(o.masterNodeId);
  }
  return isValidInstanceProps(state, toInstanceLite(body), body.propertyValues, body.variantProps);
}

const kindKey = (n: NodeLite) => `${n.kind}|${n.name}`;

/** Pairs the nodes of two masters that are "the same layer" (same kind, name and place among
 *  siblings of that kind and name, from the roots down): old node id -> new node id. */
function matchMasters(state: SceneState, oldRoot: string, newRoot: string): Map<string, string> {
  const out = new Map<string, string>();
  const o = state.nodes.at(oldRoot), n = state.nodes.at(newRoot);
  if (!o || !n || o.kind !== n.kind) return out;
  const index = (parent: string) => {
    const m = new Map<string, NodeLite>();
    const seen = new Map<string, number>();
    for (const c of childrenOf(state, parent)) {
      const k = kindKey(c);
      const i = seen.get(k) ?? 0;
      m.set(`${k}|${i}`, c);
      seen.set(k, i + 1);
    }
    return m;
  };
  const walk = (a: string, b: string) => {
    out.set(a, b);
    const ia = index(a), ib = index(b);
    for (const k of [...ia.keys()].sort()) {
      const cb = ib.get(k);
      if (cb) walk(ia.get(k)!.id, cb.id);
    }
  };
  walk(oldRoot, newRoot);
  return out;
}

/**
 * The payload of instance `id` after pointing it at `componentId`, keeping what still fits:
 * the overrides on layers the new master also has (a text override only on a text layer), the
 * property values the new component also defines with a valid value and the variant choices
 * its set also has. Null when the swap is not allowed. Parity with core.SwapInstance.
 */
export function swapInstance(state: SceneState, id: string, componentId: string): InstanceLite | null {
  const n = state.nodes.at(id);
  const old = n?.instance;
  if (!n || !old) return null;
  const base = state.components[componentId];
  if (!base) return null;
  let next: InstanceLite;
  if (componentId === old.componentId) {
    next = { ...old, overrides: [...old.overrides] };
  } else {
    next = { componentId, overrides: [] };
    const set = base.setId ? state.componentSets[base.setId] : undefined;
    for (const [axis, opt] of Object.entries(old.variantProps ?? {})) {
      if (set?.axes.some((a) => a.name === axis && a.options.includes(opt))) next.variantProps = { ...next.variantProps, [axis]: opt };
    }
    const newComp = state.components[effectiveComponentId(state, next)];
    const oldComp = state.components[effectiveComponentId(state, old)];
    for (const [name, v] of Object.entries(old.propertyValues ?? {})) {
      const p = newComp?.properties?.find((q) => q.name === name);
      const q = oldComp?.properties?.find((r) => r.name === name);
      if (p && q && q.type === p.type && propertyValueValid(state, p, v)) {
        next.propertyValues = { ...next.propertyValues, [name]: v };
      }
    }
    const pairs = matchMasters(state, oldComp?.rootNodeId ?? "", newComp?.rootNodeId ?? "");
    for (const o of old.overrides) {
      const to = pairs.get(o.masterNodeId);
      if (to === undefined) continue;
      const c: InstanceOverrideLite = { masterNodeId: to, ...(o.fills !== undefined ? { fills: o.fills } : {}), ...(o.text !== undefined && state.nodes.at(to)?.kind === "text" ? { text: o.text } : {}) };
      if (c.fills !== undefined || c.text !== undefined) next.overrides.push(c);
    }
  }
  return next;
}

/** The size a swapped instance takes: the one of the master it now renders. */
export function swapSize(state: SceneState, inst: InstanceLite): { width: number; height: number } | null {
  const root = state.nodes.at(state.components[effectiveComponentId(state, inst)]?.rootNodeId ?? "");
  return root ? { width: root.width, height: root.height } : null;
}

/** The payload with every override, property value and variant choice cleared (same component). */
export function resetInstance(state: SceneState, id: string): InstanceLite | null {
  const inst = state.nodes.at(id)?.instance;
  return inst ? { componentId: inst.componentId, overrides: [] } : null;
}

/** The id of the page that holds node `id`, or "" . */
export function pageOf(state: SceneState, id: string): string {
  let cur = state.nodes.at(id);
  for (let g = 0; cur && g <= state.nodes.size; g++) {
    const parent = state.nodes.at(cur.parentId);
    if (!parent) return cur.parentId;
    cur = parent;
  }
  return "";
}

/**
 * The nodes that replace instance `id` when it is detached: the master it renders copied in
 * its place, with the overrides, property values and variant choice baked in. The new root
 * keeps the instance's id, name, place, size and layout settings; nested instances stay
 * instances. `newId` makes the ids of the copied descendants. The caller deletes the instance
 * first and creates these in order (parents before children). Parity with core.DetachInstance.
 */
export function detachInstance(state: SceneState, id: string, newId: () => string): NodeLite[] | null {
  const n = state.nodes.at(id);
  if (!n?.instance) return null;
  const comp = state.components[effectiveComponentId(state, n.instance)];
  const root = comp ? state.nodes.at(comp.rootNodeId) : undefined;
  if (!root) return null;
  const fx = effectiveOverrides(state, n);
  const ids = new Map<string, string>();
  const out: NodeLite[] = [];
  for (const m of subtreeOf(state, root.id)) {
    let c: NodeLite = { ...m };
    if (m.id === root.id) {
      c = {
        ...c, id, parentId: n.parentId, orderKey: n.orderKey, name: n.name,
        x: n.x, y: n.y, width: n.width, height: n.height, rotation: n.rotation, visible: n.visible, opacity: n.opacity,
      };
      for (const k of ["constraintX", "constraintY", "layoutSizingX", "layoutSizingY", "minWidth", "maxWidth", "minHeight", "maxHeight", "layoutPositioning", "blendMode", "isMask", "meta"] as const) {
        const bag = c as unknown as Record<string, unknown>;
        if (n[k] !== undefined) bag[k] = n[k]; else delete bag[k];
      }
      if (n.modes && Object.keys(n.modes).length > 0) c.modes = n.modes;
    } else {
      c = { ...c, id: newId(), parentId: ids.get(m.parentId) ?? "" };
    }
    ids.set(m.id, c.id);
    const o = fx.get(m.id);
    if (o?.hidden) c.visible = false;
    if (o?.fills !== undefined) c.fills = o.fills;
    if (o?.text !== undefined && c.text) c.text = { ...c.text, content: o.text };
    if (o?.opacity !== undefined) c.opacity = o.opacity;
    if (o?.cornerRadius !== undefined && c.kind === "rect") c.cornerRadius = o.cornerRadius;
    if (o?.fontSize !== undefined && c.text) c.text = { ...c.text, style: { ...c.text.style, fontSize: o.fontSize } };
    if (o?.componentId !== undefined && c.instance) c.instance = { ...c.instance, componentId: o.componentId };
    out.push(c);
  }
  return out;
}
