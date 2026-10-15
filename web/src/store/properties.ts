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
export interface PropertyEffects {
  visible: Map<string, boolean>;
  text: Map<string, string>;
  opacity: Map<string, number>;
  cornerRadius: Map<string, number>;
  fontSize: Map<string, number>;
  /** nested instance node -> the component it should show */
  swap: Map<string, string>;
}

const emptyEffects = (): PropertyEffects => ({
  visible: new Map(), text: new Map(), opacity: new Map(), cornerRadius: new Map(), fontSize: new Map(), swap: new Map(),
});

export function effectsWith(props: readonly ComponentPropertyLite[] | undefined, values: Record<string, string> | undefined): PropertyEffects {
  const fx = emptyEffects();
  for (const p of props ?? []) {
    const v = values?.[p.name] ?? p.defaultValue;
    switch (p.type) {
      case "boolean": fx.visible.set(p.nodeId, v !== "false"); break;
      case "text": if (v !== "") fx.text.set(p.nodeId, v); break;       // empty = keep the master's own text
      case "number": {
        const f = Number(v);
        if (v !== "" && Number.isFinite(f)) {
          if (p.attribute === "opacity") fx.opacity.set(p.nodeId, Math.max(0, Math.min(1, f)));
          else if (p.attribute === "corner_radius") fx.cornerRadius.set(p.nodeId, Math.max(0, f));
          else if (p.attribute === "font_size" && f > 0) fx.fontSize.set(p.nodeId, f);
        }
        break;
      }
      case "swap": if (v !== "") fx.swap.set(p.nodeId, v); break;       // empty = the nested instance keeps its own component
    }
  }
  return fx;
}

/** The effects of an instance node (none for anything else), for the component it shows (its own unless `componentId`). */
export function propertyEffects(s: SceneState, n: NodeLite, componentId?: string): PropertyEffects {
  if (n.kind !== "instance" || !n.instance) return emptyEffects();
  return effectsWith(s.components[componentId ?? n.instance.componentId]?.properties, n.instance.propertyValues);
}

const NUMBER_ATTRS = new Set(["opacity", "corner_radius", "font_size"]);
const isNumber = (v: string) => v.trim() !== "" && Number.isFinite(Number(v));

/** A value is valid for a property definition (an empty value is "use the default": checked by the callers). */
function validValue(s: SceneState, p: ComponentPropertyLite, v: string): boolean {
  switch (p.type) {
    case "boolean": return v === "true" || v === "false";
    case "number": return isNumber(v);
    case "swap": return !!s.components[v];
    default: return !p.options?.length || p.options.includes(v);
  }
}

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
        let def = p.defaultValue;
        switch (p.type) {
          case "boolean": if (def === "") def = "true"; break;
          case "text":
            if (node.kind !== "text") return s;
            if (new Set(p.options ?? []).size !== (p.options ?? []).length || (p.options ?? []).includes("")) return s;
            break;
          case "number":
            if (!NUMBER_ATTRS.has(p.attribute ?? "")) return s;
            if ((p.attribute === "corner_radius" && node.kind !== "rect") || (p.attribute === "font_size" && node.kind !== "text")) return s;
            break;
          case "swap":
            if (node.kind !== "instance" || def === componentId) return s;
            break;
        }
        if (def !== "" && !validValue(s, p, def)) return s;
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
        if (!validValue(s, def, value)) return s;
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

/** Drops the properties whose target node was just deleted (parity with core.cascadeProperties). */
export function cascadeProperties(state: SceneState, gone: ReadonlySet<string>): Partial<Pick<SceneState, "components">> {
  let changed = false;
  const components = { ...state.components };
  for (const [id, c] of Object.entries(state.components)) {
    if (!c.properties?.some((p) => gone.has(p.nodeId))) continue;
    changed = true;
    const kept = c.properties.filter((p) => !gone.has(p.nodeId));
    const next = { ...c };
    if (kept.length > 0) next.properties = kept; else delete next.properties;
    components[id] = next;
  }
  return changed ? { components } : {};
}
