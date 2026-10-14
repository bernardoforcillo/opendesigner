import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import type { ComponentPropertyLite, NodeLite, SceneState } from "./types";
import { toComponentPropertyLite } from "./types";

// COMPONENT PROPERTIES, client side. Parity with core/properties.go (Go), the
// authority: a component declares boolean (show/hide a master node) and text
// (set a master text node) controls; an instance sets them.

/** `id` is `root` or lies in its subtree. */
function under(s: SceneState, root: string, id: string): boolean {
  for (let cur = id, i = 0; cur !== "" && i < 10000; i++) {
    if (cur === root) return true;
    const n = s.nodes.get(cur);
    if (!n) return false;
    cur = n.parentId;
  }
  return false;
}

/** What an instance's property values do to its master: per master node, a visibility to force and a text to write. */
export interface PropertyEffects { visible: Map<string, boolean>; text: Map<string, string> }

export function effectsWith(props: readonly ComponentPropertyLite[] | undefined, values: Record<string, string> | undefined): PropertyEffects {
  const fx: PropertyEffects = { visible: new Map(), text: new Map() };
  for (const p of props ?? []) {
    const v = values?.[p.name] ?? p.defaultValue;
    if (p.type === "boolean") fx.visible.set(p.nodeId, v !== "false");
    else if (v !== "") fx.text.set(p.nodeId, v);      // empty = keep the master's own text
  }
  return fx;
}

/** The effects of an instance node (none for anything else). */
export function propertyEffects(s: SceneState, n: NodeLite): PropertyEffects {
  if (n.kind !== "instance" || !n.instance) return { visible: new Map(), text: new Map() };
  return effectsWith(s.components[n.instance.componentId]?.properties, n.instance.propertyValues);
}

const validValue = (type: ComponentPropertyLite["type"], v: string) => type !== "boolean" || v === "true" || v === "false";

/** The two property ops; undefined if `op` is not one of them. Invalid ops leave the state unchanged, as Go rejects them. */
export function applyPropertyOp(s: SceneState, op: Op): SceneState | undefined {
  switch (op.kind.case) {
    case "setComponentProperties": {
      const { componentId, properties } = op.kind.value;
      const c = s.components[componentId];
      if (!c) return s;
      const seen = new Set<string>();
      const out: ComponentPropertyLite[] = [];
      for (const pb of properties) {
        const p = toComponentPropertyLite(pb);
        // type 0 (unspecified) is refused by Go; toComponentPropertyLite maps it to boolean, so check it here.
        if (pb.type === 0) return s;
        if (p.name === "" || seen.has(p.name)) return s;
        seen.add(p.name);
        const node = s.nodes.get(p.nodeId);
        if (!node || !under(s, c.rootNodeId, p.nodeId)) return s;
        if (p.type === "text" && node.kind !== "text") return s;
        const def = p.type === "boolean" && p.defaultValue === "" ? "true" : p.defaultValue;
        if (!validValue(p.type, def)) return s;
        out.push({ ...p, defaultValue: def });
      }
      const next = { ...c };
      if (out.length > 0) next.properties = out; else delete next.properties;
      return { ...s, components: { ...s.components, [componentId]: next } };
    }
    case "setInstanceProperty": {
      const { instanceId, name, value } = op.kind.value;
      const n = s.nodes.get(instanceId);
      if (!n || n.kind !== "instance" || !n.instance) return s;
      const def = s.components[n.instance.componentId]?.properties?.find((p) => p.name === name);
      if (!def) return s;
      const values = { ...(n.instance.propertyValues ?? {}) };
      if (value === "") delete values[name];
      else {
        if (!validValue(def.type, value)) return s;
        values[name] = value;
      }
      const instance = { ...n.instance };
      if (Object.keys(values).length > 0) instance.propertyValues = values; else delete instance.propertyValues;
      return { ...s, nodes: s.nodes.set(instanceId, { ...n, instance }) };
    }
    default:
      return undefined;
  }
}
