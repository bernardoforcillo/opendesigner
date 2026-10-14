import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { type FillLite, type NodeLite, type SceneState, type VariableLite, toVariableLite } from "./types";

// DESIGN VARIABLES (tokens), client side. Parity with core/variables.go (Go),
// the authority: same validation, same results.
//
// A fill bound to a variable (FillLite.varId) keeps a FLAT colour in r,g,b,a:
// the colour of the variable at the active mode. Every renderer, panel and
// exporter keeps reading flat colours and knows nothing about variables. What
// keeps those colours true is this file: they are resolved when a node comes in
// (createNode / setProps / snapshot) and re-resolved for ALL the bound nodes
// when a variable, the modes or the active mode change. That re-scan is O(nodes)
// but those ops are rare; a per-variable reverse index is the next step if a
// bench says otherwise.

const BLACK = { r: 0, g: 0, b: 0, a: 1 };
type Rgba = { r: number; g: number; b: number; a: number };
const MAX_ALIAS_DEPTH = 32;

/** The mode the canvas previews: the chosen one if it still exists, else the first. */
export function activeModeId(s: SceneState): string | undefined {
  const modes = s.modes ?? [];
  if (s.activeMode && modes.some((m) => m.id === s.activeMode)) return s.activeMode;
  return modes[0]?.id;
}

/** The variable that actually holds the values: the alias chain followed; undefined if it dangles. */
function effective(s: SceneState, v: VariableLite | undefined): VariableLite | undefined {
  for (let i = 0; v && v.aliasOf && i < MAX_ALIAS_DEPTH; i++) v = s.variables?.[v.aliasOf];
  return v && !v.aliasOf ? v : undefined;
}

/** A value of kind `kind` at the active mode; a mode with no value falls back to the default (first) mode. */
function valueAt<T>(s: SceneState, v: VariableLite | undefined, kind: VariableLite["kind"], pick: (e: VariableLite) => Record<string, T> | undefined): T | undefined {
  const e = effective(s, v);
  if (!e || e.kind !== kind) return undefined;
  const map = pick(e);
  if (!map) return undefined;
  const def = s.modes?.[0]?.id ?? Object.keys(map).sort()[0];
  const mode = activeModeId(s);
  return (mode !== undefined ? map[mode] : undefined) ?? (def !== undefined ? map[def] : undefined);
}

/**
 * The colour of a variable at the active mode, alias followed. A missing variable
 * (deleted, never created), a dangling alias or one with no value reads as opaque
 * black, like a paint without `kind`.
 */
export function variableColor(s: SceneState, varId: string): Rgba {
  return valueAt(s, s.variables?.[varId], "color", (e) => e.values) ?? BLACK;
}

const sameColor = (a: Rgba, b: Rgba) => a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;

function resolveFill(s: SceneState, f: FillLite): FillLite {
  let out = f;
  // Gradient stops bound to a variable take its colour; the flat colour of a
  // gradient is its first stop (see FillLite), so it follows.
  if (f.gradient?.stops.some((st) => st.varId)) {
    const stops = f.gradient.stops.map((st) => {
      if (!st.varId) return st;
      const c = variableColor(s, st.varId);
      return sameColor(c, st.color) ? st : { ...st, color: c };
    });
    if (stops.some((st, i) => st !== f.gradient!.stops[i])) {
      out = { ...out, gradient: { ...f.gradient, stops }, ...stops[0].color };
    }
  }
  if (!out.varId) return out;
  const c = variableColor(s, out.varId);
  return sameColor(c, out) ? out : { ...out, ...c };
}

/** The numeric / text properties a variable can drive, and the kind it must be (mirrors core.BindableProps). */
export const BINDABLE_PROPS: Record<string, "number" | "string"> = {
  opacity: "number", corner_radius: "number", font_size: "number", text: "string",
};

/** Validation of a node's bindings, as core.validateBindings does; returns false for a bad one. */
export function validBindings(s: SceneState, n: Pick<NodeLite, "kind">, bindings: Record<string, string> | undefined): boolean {
  for (const [prop, id] of Object.entries(bindings ?? {})) {
    const want = BINDABLE_PROPS[prop];
    if (!want) return false;
    if (prop === "corner_radius" && n.kind !== "rect") return false;
    if ((prop === "font_size" || prop === "text") && n.kind !== "text") return false;
    const v = s.variables?.[id];
    if (!v || v.kind !== want) return false;
  }
  return true;
}

function resolveBindings(s: SceneState, n: NodeLite): NodeLite {
  const b = n.bindings;
  if (!b) return n;
  let out = n;
  for (const [prop, id] of Object.entries(b)) {
    const v = s.variables?.[id];
    switch (prop) {
      case "opacity": {
        const x = valueAt(s, v, "number", (e) => e.numbers);
        if (x !== undefined) { const o = Math.max(0, Math.min(1, x)); if (o !== out.opacity) out = { ...out, opacity: o }; }
        break;
      }
      case "corner_radius": {
        const x = valueAt(s, v, "number", (e) => e.numbers);
        if (x !== undefined && out.kind === "rect") { const r = Math.max(0, x); if (r !== out.cornerRadius) out = { ...out, cornerRadius: r }; }
        break;
      }
      case "font_size": {
        const x = valueAt(s, v, "number", (e) => e.numbers);
        if (x !== undefined && x > 0 && out.text && out.text.style.fontSize !== x) out = { ...out, text: { ...out.text, style: { ...out.text.style, fontSize: x } } };
        break;
      }
      case "text": {
        const x = valueAt(s, v, "string", (e) => e.strings);
        if (x !== undefined && out.text && out.text.content !== x) out = { ...out, text: { ...out.text, content: x } };
        break;
      }
    }
  }
  return out;
}

/** The node with its bound paints and properties resolved; the SAME object if nothing changed. */
export function resolveNode(s: SceneState, n: NodeLite): NodeLite {
  const fills = n.fills.map((f) => resolveFill(s, f));
  const strokes = n.strokes.map((st) => {
    const color = resolveFill(s, st.color);
    return color === st.color ? st : { ...st, color };
  });
  // An instance's fill overrides are paints too: a bound override must follow
  // the variable (they live outside node.fills, so they are resolved here).
  let instance = n.instance;
  if (instance) {
    const overrides = instance.overrides.map((o) => {
      if (!o.fills) return o;
      const f = o.fills.map((x) => resolveFill(s, x));
      return f.every((x, i) => x === o.fills![i]) ? o : { ...o, fills: f };
    });
    if (overrides.some((o, i) => o !== instance!.overrides[i])) instance = { ...instance, overrides };
  }
  const fillsSame = fills.every((f, i) => f === n.fills[i]);
  const strokesSame = strokes.every((st, i) => st === n.strokes[i]);
  const painted = fillsSame && strokesSame && instance === n.instance ? n : { ...n, fills, strokes, ...(instance ? { instance } : {}) };
  return resolveBindings(s, painted);
}

/** Re-resolves every node; the SAME state object if no node changed. */
export function resolveScene(s: SceneState): SceneState {
  if (s.nodes === undefined) return s;
  let nodes = s.nodes;
  s.nodes.forEach((n, id) => {
    const r = resolveNode(s, n);
    if (r !== n) nodes = nodes.set(id, r);
  });
  return nodes === s.nodes ? s : { ...s, nodes };
}

/** Switches the previewed mode (view state: never sent to the server). */
export function withActiveMode(s: SceneState, modeId: string): SceneState {
  if (s.activeMode === modeId) return s;
  return resolveScene({ ...s, activeMode: modeId });
}

/** After ops that bring a node in: resolve just that node. */
export function resolveAfterNodeOp(s: SceneState, op: Op): SceneState {
  const k = op.kind;
  const id =
    k.case === "createNode" ? k.value.node?.id
    : k.case === "setProps" ? k.value.id
    : k.case === "setInstanceOverride" ? k.value.instanceId
    : k.case === "swapInstance" ? k.value.instanceId
    : k.case === "setText" ? k.value.id
    : undefined;
  if (!id) return s;
  const n = s.nodes.get(id);
  if (!n) return s;
  const r = resolveNode(s, n);
  return r === n ? s : { ...s, nodes: s.nodes.set(id, r) };
}

/**
 * Same checks as core.validateVariable, on the lite variable. Pure; false = the
 * server would reject the op.
 */
export function validVariable(s: SceneState, v: VariableLite): boolean {
  if (v.id === "" || v.name === "") return false;                              // ErrNilVariable
  const hasValues = Object.keys(v.values).length > 0;
  const hasNumbers = Object.keys(v.numbers ?? {}).length > 0;
  const hasStrings = Object.keys(v.strings ?? {}).length > 0;
  if ((v.kind !== "color" && hasValues) || (v.kind !== "number" && hasNumbers) || (v.kind !== "string" && hasStrings)) return false;
  if (v.aliasOf) {
    if (hasValues || hasNumbers || hasStrings) return false;                   // ErrBadAlias: alias carries no values
    const target = s.variables?.[v.aliasOf];
    if (!target || target.kind !== v.kind) return false;                       // unknown target / other kind
    let cur: VariableLite | undefined = target;
    for (let i = 0; cur && i < MAX_ALIAS_DEPTH; i++) {
      if (cur.id === v.id) return false;                                       // cycle
      if (!cur.aliasOf) break;
      cur = s.variables?.[cur.aliasOf];
    }
    return true;
  }
  const modeIds = new Set((s.modes ?? []).map((m) => m.id));
  const keys = [...Object.keys(v.values), ...Object.keys(v.numbers ?? {}), ...Object.keys(v.strings ?? {})];
  return modeIds.size === 0 || keys.every((k) => modeIds.has(k));              // ErrBadMode
}

const keepModes = <T,>(m: Record<string, T> | undefined, keep: Set<string>): Record<string, T> | undefined =>
  m ? Object.fromEntries(Object.entries(m).filter(([k]) => keep.has(k))) : undefined;

/** The three variable ops; undefined if `op` is not one of them. Invalid ops leave the state unchanged, like Go rejects them. */
export function applyVariableOp(s: SceneState, op: Op): SceneState | undefined {
  switch (op.kind.case) {
    case "setVariable": {
      const pb = op.kind.value.variable;
      if (!pb) return s;                                                         // ErrNilVariable
      if (Object.values(pb.values).some((c) => !c)) return s;                    // nil colour value
      const v = toVariableLite(pb);
      if (!validVariable(s, v)) return s;
      return resolveScene({ ...s, variables: { ...s.variables, [v.id]: v } });
    }
    case "deleteVariable": {
      const { id } = op.kind.value;
      if (!s.variables?.[id]) return s;                                          // ErrVariableNotFound
      const variables = { ...s.variables };
      delete variables[id];
      return resolveScene({ ...s, variables });
    }
    case "setModes": {
      const modes = op.kind.value.modes;
      const seen = new Set<string>();
      for (const m of modes) {
        if (m.id === "" || seen.has(m.id)) return s;                             // ErrBadMode
        seen.add(m.id);
      }
      let variables = s.variables;
      if (seen.size > 0 && variables) {
        // Values of a mode that disappears are dropped (copies, never in place).
        variables = Object.fromEntries(Object.entries(variables).map(([id, v]) => {
          const numbers = keepModes(v.numbers, seen);
          const strings = keepModes(v.strings, seen);
          return [id, { ...v, values: keepModes(v.values, seen) ?? {}, ...(numbers ? { numbers } : {}), ...(strings ? { strings } : {}) }];
        }));
      }
      return resolveScene({ ...s, variables, modes: modes.map((m) => ({ id: m.id, name: m.name })) });
    }
    default:
      return undefined;
  }
}
