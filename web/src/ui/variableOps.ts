import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import type { FillLite, SceneState, StrokeLite, VariableKind, VariableLite } from "../store/types";
import { toPbFills, toPbStrokes } from "../store/types";
import { validVariable } from "../store/variables";
import { makeDeleteVariableOp, makeSetModesOp, makeSetPropsOp, makeSetVariableOp, uuid } from "../tools/ops";

// Op builders of the variables panel and of the properties panel's variable pickers.
// Pure: they read the scene they are given and return ops; whoever calls them wraps
// the ops in ONE gesture (one edit = one undo step), like every other panel.

const DEFAULT_MODE = { id: "default", name: "Default" };
const NEW_COLOR = { r: 0.15, g: 0.39, b: 0.92, a: 1 };

/** Modes with the implicit default one when the document has none yet. */
export function effectiveModes(scene: SceneState) {
  return scene.modes && scene.modes.length > 0 ? scene.modes : [DEFAULT_MODE];
}

export const KIND_LABEL: Record<VariableKind, string> = { color: "Colour", number: "Number", string: "Text" };
const KIND_PREFIX: Record<VariableKind, string> = { color: "color", number: "number", string: "text" };

/** The value a new variable of each kind starts with, in `mode`. */
function seed(kind: VariableKind, mode: string): Pick<VariableLite, "values" | "numbers" | "strings"> {
  if (kind === "number") return { values: {}, numbers: { [mode]: 0 } };
  if (kind === "string") return { values: {}, strings: { [mode]: "Text" } };
  return { values: { [mode]: { ...NEW_COLOR } } };
}

/**
 * A new variable of `kind`. If the document has no modes yet, the same gesture
 * first creates the default one, so the variable's value has a mode to live in.
 */
export function newVariableOps(scene: SceneState, kind: VariableKind = "color"): Op[] {
  const ops: Op[] = [];
  if (!scene.modes || scene.modes.length === 0) ops.push(makeSetModesOp([DEFAULT_MODE]));
  const n = Object.values(scene.variables ?? {}).filter((v) => v.kind === kind).length + 1;
  const first = effectiveModes(scene)[0].id;
  ops.push(makeSetVariableOp({ id: uuid(), name: `${KIND_PREFIX[kind]}/token-${n}`, kind, ...seed(kind, first) }));
  return ops;
}

export function renameVariableOps(v: VariableLite, name: string): Op[] {
  const trimmed = name.trim();
  return trimmed === "" || trimmed === v.name ? [] : [makeSetVariableOp({ ...v, name: trimmed })];
}

/** Sets a variable's colour in one mode; the alpha of the mode's previous value is kept. */
export function setVariableColorOps(v: VariableLite, modeId: string, rgb: { r: number; g: number; b: number }): Op[] {
  const a = v.values[modeId]?.a ?? 1;
  return [makeSetVariableOp({ ...v, values: { ...v.values, [modeId]: { ...rgb, a } } })];
}

export function setVariableNumberOps(v: VariableLite, modeId: string, n: number): Op[] {
  return [makeSetVariableOp({ ...v, numbers: { ...v.numbers, [modeId]: n } })];
}

export function setVariableStringOps(v: VariableLite, modeId: string, text: string): Op[] {
  return [makeSetVariableOp({ ...v, strings: { ...v.strings, [modeId]: text } })];
}

/** The variables `v` could point at: same kind, not itself, and no cycle (the same check the server runs). */
export function aliasCandidates(scene: SceneState, v: VariableLite): VariableLite[] {
  return Object.values(scene.variables ?? {})
    .filter((t) => t.id !== v.id && t.kind === v.kind && validVariable(scene, { ...v, values: {}, numbers: undefined, strings: undefined, aliasOf: t.id }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

/**
 * Makes `v` an alias of `targetId`, or (null) a variable with its own values
 * again: those it currently resolves to, in every mode, so nothing visibly changes.
 */
export function setAliasOps(scene: SceneState, v: VariableLite, targetId: string | null): Op[] {
  if (targetId !== null) return [makeSetVariableOp({ id: v.id, name: v.name, kind: v.kind, values: {}, aliasOf: targetId })];
  let t: VariableLite | undefined = v;
  for (let i = 0; t?.aliasOf && i < 32; i++) t = scene.variables?.[t.aliasOf];
  const own = t && !t.aliasOf ? t : undefined;
  return [makeSetVariableOp({
    id: v.id, name: v.name, kind: v.kind,
    values: { ...(own?.values ?? {}) },
    ...(own?.numbers ? { numbers: { ...own.numbers } } : {}),
    ...(own?.strings ? { strings: { ...own.strings } } : {}),
  })];
}

export function deleteVariableOps(id: string): Op[] {
  return [makeDeleteVariableOp(id)];
}

export function addModeOps(scene: SceneState): Op[] {
  const modes = effectiveModes(scene);
  return [makeSetModesOp([...modes, { id: uuid(), name: `Mode ${modes.length + 1}` }])];
}

export function renameModeOps(scene: SceneState, id: string, name: string): Op[] {
  const trimmed = name.trim();
  const modes = effectiveModes(scene);
  if (trimmed === "" || modes.find((m) => m.id === id)?.name === trimmed) return [];
  return [makeSetModesOp(modes.map((m) => (m.id === id ? { ...m, name: trimmed } : m)))];
}

/** Removing a mode drops its values (the server does it; undo restores them). The last mode cannot be removed. */
export function removeModeOps(scene: SceneState, id: string): Op[] {
  const modes = effectiveModes(scene);
  if (modes.length <= 1) return [];
  return [makeSetModesOp(modes.filter((m) => m.id !== id))];
}

/** Which variable the first fill / stroke of the nodes is bound to: an id, null (none), or "mixed". */
export function boundVariable(scene: SceneState, ids: readonly string[], slot: "fill" | "stroke"): string | null | "mixed" {
  let seen: string | null | undefined;
  for (const id of ids) {
    const n = scene.nodes.get(id);
    if (!n) continue;
    const v = (slot === "fill" ? n.fills[0]?.varId : n.strokes[0]?.color.varId) ?? null;
    if (seen === undefined) seen = v;
    else if (seen !== v) return "mixed";
  }
  return seen ?? null;
}

/**
 * Binds the first fill (or stroke) of each node to a variable, or, with null,
 * unbinds it, keeping the colour it currently shows as a fixed one. The other
 * fills and strokes are untouched, as in fillOps/strokeOps. A node without a
 * stroke gets none created: there is nothing to bind.
 */
export function bindVariableOps(scene: SceneState, ids: readonly string[], slot: "fill" | "stroke", varId: string | null): Op[] {
  return ids.flatMap((id) => {
    const n = scene.nodes.get(id);
    if (!n) return [];
    const rebind = (f: FillLite): FillLite => {
      const { varId: _drop, ...flat } = f;
      return varId === null ? flat : { ...flat, varId };
    };
    if (slot === "fill") {
      const first = rebind(n.fills[0] ?? { r: 0.8, g: 0.8, b: 0.8, a: 1 });
      return [makeSetPropsOp(id, { fills: toPbFills([first, ...n.fills.slice(1)]) }, ["fills"])];
    }
    if (n.strokes.length === 0) return [];
    const first: StrokeLite = { ...n.strokes[0], color: rebind(n.strokes[0].color) };
    return [makeSetPropsOp(id, { strokes: toPbStrokes([first, ...n.strokes.slice(1)]) }, ["strokes"])];
  });
}

/** The number/text properties a node offers for binding (mirrors core.validateBindings). */
export function bindablePropsOf(kind: string): { prop: string; label: string; kind: VariableKind }[] {
  const out: { prop: string; label: string; kind: VariableKind }[] = [{ prop: "opacity", label: "Opacity", kind: "number" }];
  if (kind === "rect") out.push({ prop: "corner_radius", label: "Corner radius", kind: "number" });
  if (kind === "text") out.push({ prop: "font_size", label: "Font size", kind: "number" }, { prop: "text", label: "Text", kind: "string" });
  return out;
}

/** Which variable `prop` of the nodes follows: an id, null (none), or "mixed". */
export function boundProp(scene: SceneState, ids: readonly string[], prop: string): string | null | "mixed" {
  let seen: string | null | undefined;
  for (const id of ids) {
    const n = scene.nodes.get(id);
    if (!n) continue;
    const v = n.bindings?.[prop] ?? null;
    if (seen === undefined) seen = v;
    else if (seen !== v) return "mixed";
  }
  return seen ?? null;
}

/**
 * Binds `prop` of each node to a number/text variable, or (null) unbinds it,
 * leaving the value the property had. Nodes that do not have that property
 * (a corner radius on an ellipse) are skipped.
 */
export function bindPropOps(scene: SceneState, ids: readonly string[], prop: string, varId: string | null): Op[] {
  return ids.flatMap((id) => {
    const n = scene.nodes.get(id);
    if (!n || !bindablePropsOf(n.kind).some((p) => p.prop === prop)) return [];
    const next = { ...(n.bindings ?? {}) };
    if (varId === null) delete next[prop]; else next[prop] = varId;
    return [makeSetPropsOp(id, { bindings: next }, ["bindings"])];
  });
}
