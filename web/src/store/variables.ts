import type { Variable as PbVariable, VariableCollection as PbCollection } from "../gen/opendesigner/v1/opendesigner_pb";
import { VariableType } from "../gen/opendesigner/v1/opendesigner_pb";
import { recordDelta } from "./sceneDelta";
import type { CollectionLite, FillLite, NodeLite, SceneState, VariableLite, VariableTypeLite } from "./types";

// VARIABLES (design tokens) -- the TypeScript twin of internal/core/variables.go.
// Go is the authority; every rule here repeats one there, and the golden
// fixture testdata/golden/variables.json runs both sides. See the invariants at
// the top of that file.

/**
 * The variable type a binding key accepts, or null if the key is not in the
 * grammar. Parity with core.BindingType.
 *
 *   opacity | rotation | corner_radius | strokes.N.weight   number
 *   fills.N | strokes.N                                      color
 */
export function bindingType(key: string): VariableTypeLite | null {
  if (key === "opacity" || key === "rotation" || key === "corner_radius") return "number";
  const parts = key.split(".");
  if (parts.length < 2 || parts.length > 3) return null;
  if (parts[0] !== "fills" && parts[0] !== "strokes") return null;
  if (!isIndex(parts[1])) return null;
  if (parts.length === 2) return "color";
  return parts[0] === "strokes" && parts[2] === "weight" ? "number" : null;
}

// A canonical non-negative decimal: "0", "12" -- not "01", "-1", "+1", "1e2".
function isIndex(s: string): boolean {
  return /^(0|[1-9][0-9]*)$/.test(s);
}

const unit = (v: number) => Number.isFinite(v) && v >= 0 && v <= 1;

/** Parity with core.validateCollection. */
export function isValidCollection(c: PbCollection | undefined): c is PbCollection {
  if (!c || c.id === "" || c.modes.length === 0) return false;
  const seen = new Set<string>();
  for (const m of c.modes) {
    if (m.id === "" || seen.has(m.id)) return false;
    seen.add(m.id);
  }
  return true;
}

/**
 * Parity with core.validateVariable. It reads the wire message, not the Lite
 * form: a value with no `kind` is a type mismatch here (toVariableLite would
 * silently drop it).
 */
export function isValidVariable(state: SceneState, v: PbVariable | undefined): v is PbVariable {
  if (!v || v.id === "") return false;
  const col = state.collections[v.collectionId];
  if (!col) return false;
  if (v.type !== VariableType.COLOR && v.type !== VariableType.NUMBER) return false;
  const type: VariableTypeLite = v.type === VariableType.COLOR ? "color" : "number";
  const prev = state.variables[v.id];
  if (prev && (prev.type !== type || prev.collectionId !== v.collectionId)) return false;
  const modes = new Set(col.modes.map((m) => m.id));
  for (const [mode, val] of Object.entries(v.values)) {
    if (!modes.has(mode)) return false;
    if (type === "color") {
      if (val.kind.case !== "color") return false;
      const { r, g, b, a } = val.kind.value;
      if (![r, g, b, a].every(unit)) return false;
    } else if (val.kind.case !== "number" || !Number.isFinite(val.kind.value)) return false;
  }
  return true;
}

/** Parity with core.validateBindings. */
export function areValidBindings(state: SceneState, bindings: Readonly<Record<string, string>> | undefined): boolean {
  for (const [key, id] of Object.entries(bindings ?? {})) {
    const want = bindingType(key);
    if (want === null || state.variables[id]?.type !== want) return false;
  }
  return true;
}

/** Parity with core.validateModes. */
export function areValidModes(state: SceneState, modes: Readonly<Record<string, string>> | undefined): boolean {
  for (const [col, mode] of Object.entries(modes ?? {})) {
    if (!state.collections[col]?.modes.some((m) => m.id === mode)) return false;
  }
  return true;
}

// ---------- cascades (invariant 6) ----------

/** The nodes with their entries rewritten by `fix` (which returns null to keep a node). */
function rewriteNodes(state: SceneState, fix: (n: NodeLite) => NodeLite | null): SceneState["nodes"] {
  let edit: ReturnType<SceneState["nodes"]["edit"]> | null = null;
  for (const n of state.nodes.values()) {
    const next = fix(n);
    if (next) (edit ??= state.nodes.edit()).set(n.id, next);
  }
  return edit ? edit.done() : state.nodes;
}

function without<T>(rec: Readonly<Record<string, T>>, drop: (k: string, v: T) => boolean): Record<string, T> | undefined {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(rec)) if (!drop(k, v)) out[k] = v;
  return Object.keys(out).length === 0 ? undefined : out;
}

/** Removes from the nodes the bindings to `gone` variables and the mode pins of `col` (if given). */
export function unbindNodes(state: SceneState, gone: ReadonlySet<string>, pinnedCollection?: string): SceneState["nodes"] {
  return rewriteNodes(state, (n) => {
    const hitsBinding = !!n.bindings && Object.values(n.bindings).some((id) => gone.has(id));
    const hitsMode = pinnedCollection !== undefined && !!n.modes && pinnedCollection in n.modes;
    if (!hitsBinding && !hitsMode) return null;
    const next: NodeLite = { ...n };
    if (hitsBinding) {
      const b = without(n.bindings!, (_, id) => gone.has(id));
      if (b) next.bindings = b; else delete next.bindings;
    }
    if (hitsMode) {
      const m = without(n.modes!, (k) => k === pinnedCollection);
      if (m) next.modes = m; else delete next.modes;
    }
    return next;
  });
}

/** setCollection over an existing collection: the removed modes take their values and pins with them. */
export function dropRemovedModes(state: SceneState, col: CollectionLite): Pick<SceneState, "variables" | "nodes"> {
  const keep = new Set(col.modes.map((m) => m.id));
  let variables = state.variables;
  for (const v of Object.values(state.variables)) {
    if (v.collectionId !== col.id || Object.keys(v.values).every((m) => keep.has(m))) continue;
    if (variables === state.variables) variables = { ...variables };
    const values: VariableLite["values"] = {};
    for (const [m, val] of Object.entries(v.values)) if (keep.has(m)) values[m] = val;
    variables[v.id] = { ...v, values };
  }
  const nodes = rewriteNodes(state, (n) => {
    const pin = n.modes?.[col.id];
    if (pin === undefined || keep.has(pin)) return null;
    const next: NodeLite = { ...n };
    const m = without(n.modes!, (k) => k === col.id);
    if (m) next.modes = m; else delete next.modes;
    return next;
  });
  return { variables, nodes };
}

// ---------- resolution ----------

/**
 * The mode of `collectionId` in force for node `nodeId`: the nearest ancestor
 * (the node itself included) that pins the collection to a mode it still has,
 * else the collection's first mode. "" if the collection does not exist.
 * Parity with core.ActiveMode.
 */
export function activeMode(state: SceneState, nodeId: string, collectionId: string): string {
  const col = state.collections[collectionId];
  if (!col || col.modes.length === 0) return "";
  let cur = state.nodes.get(nodeId);
  for (let guard = 0; cur && guard < 10000; guard++) {
    const m = cur.modes?.[collectionId];
    if (m !== undefined && col.modes.some((x) => x.id === m)) return m;
    cur = state.nodes.get(cur.parentId);
  }
  return col.modes[0].id;
}

/** The value of `v` in `mode`, falling back to the collection's default mode. Parity with core.VariableValueIn. */
export function variableValueIn(state: SceneState, v: VariableLite, mode: string): FillLite | number | undefined {
  if (mode in v.values) return v.values[mode];
  const first = state.collections[v.collectionId]?.modes[0];
  return first ? v.values[first.id] : undefined;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * `n` with its bindings replaced by the values of the active modes. A node
 * without bindings is returned as is; the document is never touched. A binding
 * whose variable, value or target is missing is ignored: the literal stays.
 * Parity with core.ResolveNode.
 */
export function resolveNode(state: SceneState, n: NodeLite): NodeLite {
  if (!n.bindings) return n;
  let out: NodeLite | null = null;
  const edit = () => (out ??= { ...n, fills: [...n.fills], strokes: [...n.strokes] });
  for (const key of Object.keys(n.bindings).sort()) {
    const v = state.variables[n.bindings[key]];
    if (!v) continue;
    const val = variableValueIn(state, v, activeMode(state, n.id, v.collectionId));
    if (val === undefined) continue;
    const parts = key.split(".");
    if (typeof val === "number") {
      if (key === "opacity") edit().opacity = clamp01(val);
      else if (key === "rotation") edit().rotation = val;
      else if (key === "corner_radius") { if (n.kind === "rect") edit().cornerRadius = Math.max(0, val); }
      else {
        const i = Number(parts[1]);
        if (i < n.strokes.length) edit().strokes[i] = { ...n.strokes[i], weight: Math.max(0, val) };
      }
      continue;
    }
    const i = Number(parts[1]);
    if (parts[0] === "fills") {
      // Only a solid fill takes a color: a gradient has no single color to replace.
      if (i < n.fills.length && !n.fills[i].gradient) edit().fills[i] = { r: val.r, g: val.g, b: val.b, a: val.a };
    } else if (i < n.strokes.length && !n.strokes[i].color.gradient) {
      edit().strokes[i] = { ...n.strokes[i], color: { r: val.r, g: val.g, b: val.b, a: val.a } };
    }
  }
  return out ?? n;
}

const resolved = new WeakMap<SceneState, SceneState>();

/**
 * The scene the canvas shows: `scene` with every bound property replaced by
 * its variable's value for the node's active mode. It is derived, never
 * written -- like the posed scene of an animation (animation/pose.ts): no op
 * goes out and the document does not change.
 *
 * Returns `scene` itself (same identity, no work) when the document has no
 * variables, which is every document that does not use the feature.
 */
export function resolveScene(scene: SceneState): SceneState {
  if (Object.keys(scene.variables).length === 0) return scene;
  const hit = resolved.get(scene);
  if (hit) return hit;
  let edit: ReturnType<SceneState["nodes"]["edit"]> | null = null;
  const changed: string[] = [];
  for (const n of scene.nodes.values()) {
    if (!n.bindings) continue;
    const r = resolveNode(scene, n);
    if (r === n) continue;
    (edit ??= scene.nodes.edit()).set(n.id, r);
    changed.push(n.id);
  }
  let out = scene;
  if (edit) {
    out = { ...scene, nodes: edit.done() };
    recordDelta(out, scene, changed);
  }
  resolved.set(scene, out);
  return out;
}
