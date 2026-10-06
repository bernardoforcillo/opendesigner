import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { bindingType } from "../store/variables";
import type { CollectionLite, FillLite, SceneState, VariableLite, VariableTypeLite } from "../store/types";
import { makeSetCollectionOp, makeSetPropsOp, makeSetVariableOp, uuid } from "../tools/ops";

// The pure half of the variables UI: it reads a scene and BUILDS ops, it never
// submits. The components (VariablesSection, VariablesDialog) call these and hand
// the result to beginGesture/endGesture, so a click is one gesture = one undo
// step, like every other panel.

export const MIXED = Symbol("mixed");

/** The variable bound to `key` on every node of `ids`: its id, null if none is, MIXED if they differ. */
export function boundVariable(scene: SceneState, ids: readonly string[], key: string): string | null | typeof MIXED {
  let seen: string | null | undefined;
  for (const id of ids) {
    const v = scene.nodes.at(id)?.bindings?.[key] ?? null;
    if (seen === undefined) seen = v;
    else if (seen !== v) return MIXED;
  }
  return seen ?? null;
}

/** setProps ops binding `key` to `variableId` (null = detach) on every node of `ids` that changes. */
export function bindingOps(scene: SceneState, ids: readonly string[], key: string, variableId: string | null): Op[] {
  // The same check the server runs: an op it would reject is never built.
  if (variableId !== null && scene.variables[variableId]?.type !== bindingType(key)) return [];
  const ops: Op[] = [];
  for (const id of ids) {
    const cur = scene.nodes.at(id)?.bindings ?? {};
    if ((cur[key] ?? null) === variableId) continue;
    const next = { ...cur };
    if (variableId === null) delete next[key]; else next[key] = variableId;
    ops.push(makeSetPropsOp(id, { bindings: next }, ["bindings"]));
  }
  return ops;
}

/** The mode `collectionId` is pinned to on every node of `ids`: a mode id, null if none, MIXED if they differ. */
export function pinnedMode(scene: SceneState, ids: readonly string[], collectionId: string): string | null | typeof MIXED {
  let seen: string | null | undefined;
  for (const id of ids) {
    const m = scene.nodes.at(id)?.modes?.[collectionId] ?? null;
    if (seen === undefined) seen = m;
    else if (seen !== m) return MIXED;
  }
  return seen ?? null;
}

/** setProps ops pinning `collectionId` to `modeId` (null = follow the parent) on every node of `ids` that changes. */
export function modeOps(scene: SceneState, ids: readonly string[], collectionId: string, modeId: string | null): Op[] {
  if (modeId !== null && !scene.collections[collectionId]?.modes.some((m) => m.id === modeId)) return [];
  const ops: Op[] = [];
  for (const id of ids) {
    const cur = scene.nodes.at(id)?.modes ?? {};
    if ((cur[collectionId] ?? null) === modeId) continue;
    const next = { ...cur };
    if (modeId === null) delete next[collectionId]; else next[collectionId] = modeId;
    ops.push(makeSetPropsOp(id, { modes: next }, ["modes"]));
  }
  return ops;
}

/** The variables of `type`, ordered by collection then name, for a picker. */
export function variablesOfType(scene: SceneState, type: VariableTypeLite): VariableLite[] {
  return Object.values(scene.variables)
    .filter((v) => v.type === type)
    .sort((a, b) =>
      (scene.collections[a.collectionId]?.name ?? "").localeCompare(scene.collections[b.collectionId]?.name ?? "") ||
      a.name.localeCompare(b.name));
}

// ---------- editing the collections and variables ----------

const DEFAULT_COLOR: FillLite = { r: 0.5, g: 0.5, b: 0.5, a: 1 };

/** A new collection with a single mode, named after how many there already are. */
export function newCollection(scene: SceneState): CollectionLite {
  return { id: uuid(), name: `Collection ${Object.keys(scene.collections).length + 1}`, modes: [{ id: uuid(), name: "Mode 1" }] };
}

/** `c` with one more mode. Existing variables fall back to the default mode's value for it. */
export function withMode(c: CollectionLite): CollectionLite {
  return { ...c, modes: [...c.modes, { id: uuid(), name: `Mode ${c.modes.length + 1}` }] };
}

/** A new variable in `collection`, with the same default value in every mode. */
export function newVariable(collection: CollectionLite, type: VariableTypeLite, name: string): VariableLite {
  const value = type === "color" ? DEFAULT_COLOR : 0;
  return {
    id: uuid(), collectionId: collection.id, name, type,
    values: Object.fromEntries(collection.modes.map((m) => [m.id, value])),
  };
}

/** `v` with `mode` set to `value`. */
export function withValue(v: VariableLite, mode: string, value: FillLite | number): VariableLite {
  return { ...v, values: { ...v.values, [mode]: value } };
}

/**
 * The ops that remove `modeId` from its collection. The server drops the values
 * and the pins of the removed mode on its own (see core.applySetCollection), so
 * it is a single setCollection. Empty if it is the last mode: a collection always
 * has one.
 */
export function removeModeOps(c: CollectionLite, modeId: string): Op[] {
  if (c.modes.length <= 1 || !c.modes.some((m) => m.id === modeId)) return [];
  return [makeSetCollectionOp({ ...c, modes: c.modes.filter((m) => m.id !== modeId) })];
}

/** Upsert ops for a variable whose values changed. */
export function setVariableOps(v: VariableLite): Op[] {
  return [makeSetVariableOp(v)];
}
