import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import type { NodeLite, SceneState, VariableLite } from "../store/types";
import { makeSetPropsOp, makeSetVariableOp } from "./ops";

// INK MANAGER and OVERPRINT. The inks of a document are the four process inks (swatches and objects defined in CMYK) and its spot
// inks (swatches with a spot name). The manager reports them, turns spots into process colours, and merges one spot into another
// (an alias: both print on the same plate). Overprint is a per-object setting (`meta.overprint`: fill | stroke | both) that the PDF
// export writes as overprint graphics state; the screen does not simulate it.

export const META_OVERPRINT = "overprint";
export type OverprintMode = "fill" | "stroke" | "both" | "off";

export interface SpotInk { name: string; swatches: string[]; objects: number; alt: { c: number; m: number; y: number; k: number } | null }
export interface InkReport {
  process: { swatches: number; objects: number };
  spots: SpotInk[];
  overprint: number;
  /** Swatches whose C+M+Y+K exceeds `limit` percent. */
  overLimit: { swatch: string; total: number }[];
}

const swatches = (scene: SceneState): VariableLite[] => Object.values(scene.variables).filter((v) => v.swatch);

/** The base swatch of `v` (itself, or what a tint is a tint of). */
const baseOf = (scene: SceneState, v: VariableLite): VariableLite => (v.tintOf ? scene.variables[v.tintOf] ?? v : v);

/** Counts the nodes bound to each swatch id (fills and strokes). */
function usage(scene: SceneState): Map<string, number> {
  const out = new Map<string, number>();
  for (const n of scene.nodes.values()) {
    const seen = new Set<string>();
    for (const id of Object.values(n.bindings ?? {})) if (!seen.has(id)) { seen.add(id); out.set(id, (out.get(id) ?? 0) + 1); }
  }
  return out;
}

export function inkReport(scene: SceneState, limit = 300): InkReport {
  const used = usage(scene);
  const all = swatches(scene);
  const spots = new Map<string, SpotInk>();
  let processSwatches = 0, processObjects = 0;
  const overLimit: InkReport["overLimit"] = [];
  for (const v of all) {
    const base = baseOf(scene, v);
    const count = used.get(v.id) ?? 0;
    if (base.spotName) {
      const s = spots.get(base.spotName) ?? { name: base.spotName, swatches: [], objects: 0, alt: base.cmyk ? { ...base.cmyk } : null };
      s.swatches.push(v.name); s.objects += count;
      spots.set(base.spotName, s);
    } else if (base.cmyk) {
      processSwatches++; processObjects += count;
      const cm = v.cmyk ?? base.cmyk;
      const total = Math.round((cm.c + cm.m + cm.y + cm.k) * 100);
      if (total > limit) overLimit.push({ swatch: v.name, total });
    }
  }
  const overprint = [...scene.nodes.values()].filter((n) => !n.fromMaster && n.meta?.[META_OVERPRINT]).length;
  return { process: { swatches: processSwatches, objects: processObjects }, spots: [...spots.values()], overprint, overLimit };
}

/** Turns spot inks into process colours (their CMYK alternate): all of them, or the named ones. Tints follow their base. */
export function convertSpotsOps(scene: SceneState, names?: readonly string[]): Op[] | string {
  const want = names && names.length > 0 ? new Set(names) : null;
  const known = new Set(swatches(scene).flatMap((v) => (v.spotName ? [v.spotName] : [])));
  for (const n of want ?? []) if (!known.has(n)) return `no spot ink named ${n}`;
  const ops: Op[] = [];
  for (const v of swatches(scene)) {
    if (!v.spotName || (want && !want.has(v.spotName))) continue;
    if (!v.cmyk) return `the spot swatch ${v.name} has no CMYK alternate to convert to`;
    const { spotName, ...rest } = v;
    void spotName;
    ops.push(makeSetVariableOp(rest));
  }
  return ops;
}

/** An ink alias: every swatch of spot `from` prints as spot `to` (same plate). */
export function mergeSpotsOps(scene: SceneState, from: string, to: string): Op[] | string {
  if (from === to) return "from and to are the same ink";
  if (!/^[^\s\u0000-\u001f][^\u0000-\u001f]{0,63}$/.test(to)) return "to must be 1..64 characters";
  const hits = swatches(scene).filter((v) => v.spotName === from);
  if (hits.length === 0) return `no spot ink named ${from}`;
  return hits.map((v) => makeSetVariableOp({ ...v, spotName: to }));
}

/** Sets or clears overprint on nodes. */
export function overprintOps(scene: SceneState, ids: readonly string[], mode: OverprintMode): Op[] | string {
  if (!["fill", "stroke", "both", "off"].includes(mode)) return "mode must be fill, stroke, both or off";
  const ops: Op[] = [];
  for (const id of ids) {
    const n: NodeLite | undefined = scene.nodes.get(id);
    if (!n) return `no node ${id}`;
    const meta = { ...(n.meta ?? {}) };
    if (mode === "off") { if (meta[META_OVERPRINT] === undefined) continue; delete meta[META_OVERPRINT]; }
    else { if (meta[META_OVERPRINT] === mode) continue; meta[META_OVERPRINT] = mode; }
    ops.push(makeSetPropsOp(id, { meta }, ["meta"]));
  }
  return ops;
}
