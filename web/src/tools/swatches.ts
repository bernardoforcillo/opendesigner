import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";
import { cmykToRgb, type Cmyk, type Rgb } from "@/color/cmyk";
import { cmykField, swatchCmyk, swatchColor, swatchesOf, tintCmyk, tintRgb } from "@/store/graphics";
import type { SceneState, VariableLite } from "@/store/types";
import { bindingOps } from "@/ui/variableOps";
import { makeDeleteVariableOp, makeSetCollectionOp, makeSetVariableOp, uuid } from "@/tools/ops";

// SWATCHES as ops. A swatch is a color variable with print data (store/graphics.ts), so applying one to a fill
// or a stroke is a variable binding: change the swatch and everything that uses it follows. All the swatches live
// in one collection named "Swatches" (made on first use) with a single mode.

export const SWATCH_COLLECTION = "Swatches";

export interface SwatchSpec {
  name: string;
  /** Screen color, 0..1 (derived from `cmyk` when that is given). */
  rgb?: Rgb;
  /** Process color in percent (0..100). */
  cmyk?: Cmyk;
  /** Spot color: the name of the ink. */
  spotName?: string;
  /** A tint of another swatch. */
  tintOf?: string; tint?: number;
}

function collectionOps(scene: SceneState): { id: string; mode: string; ops: Op[] } {
  const col = Object.values(scene.collections).find((c) => c.name === SWATCH_COLLECTION && c.modes.length > 0);
  if (col) return { id: col.id, mode: col.modes[0].id, ops: [] };
  const id = uuid(), mode = uuid();
  return { id, mode, ops: [makeSetCollectionOp({ id, name: SWATCH_COLLECTION, modes: [{ id: mode, name: "Default" }] })] };
}

// The variable for a spec: the color it shows (from CMYK when that defines it, from the base swatch for a tint).
function build(scene: SceneState, id: string, collectionId: string, mode: string, spec: SwatchSpec): VariableLite | null {
  let rgb = spec.rgb ?? { r: 0, g: 0, b: 0 };
  let cmyk: Cmyk | null = spec.cmyk ?? null;
  let tint: Pick<VariableLite, "tintOf" | "tint"> = {};
  if (spec.tintOf) {
    const base = scene.variables[spec.tintOf];
    const baseColor = base && swatchColor(scene, base.id);
    if (!base || !base.swatch || !baseColor || !(spec.tint! >= 1 && spec.tint! <= 100)) return null;
    rgb = tintRgb(baseColor, spec.tint!);
    const baseCmyk = swatchCmyk(base);
    cmyk = baseCmyk ? tintCmyk(baseCmyk, spec.tint!) : null;
    tint = { tintOf: base.id, tint: spec.tint };
  } else if (cmyk) rgb = cmykToRgb(cmyk);
  return {
    id, collectionId, name: spec.name, type: "color", values: { [mode]: { ...rgb, a: 1 } }, swatch: true,
    ...(cmyk ? { cmyk: cmykField(cmyk) } : {}),
    ...(spec.spotName ? { spotName: spec.spotName } : {}),
    ...tint,
  };
}

/** The ops that add a swatch (and the Swatches collection if the document has none). */
export function createSwatchOps(scene: SceneState, spec: SwatchSpec): { ops: Op[]; id: string } | null {
  const c = collectionOps(scene);
  const id = uuid();
  const v = build(scene, id, c.id, c.mode, spec);
  return v ? { ops: [...c.ops, makeSetVariableOp(v)], id } : null;
}

/** The tints of swatch `id`, and theirs, in the order they must be re-derived. */
function tintsOf(scene: SceneState, id: string): VariableLite[] {
  const out: VariableLite[] = [];
  const seen = new Set([id]);
  for (let frontier = [id]; frontier.length > 0; ) {
    const next: string[] = [];
    for (const v of swatchesOf(scene)) {
      if (v.tintOf && frontier.includes(v.tintOf) && !seen.has(v.id)) { seen.add(v.id); out.push(v); next.push(v.id); }
    }
    frontier = next;
  }
  return out;
}

/**
 * The ops that change a swatch -- name, color, CMYK, spot name, tint -- and re-derive its tints (and theirs) in the
 * same gesture, so they keep following it.
 */
export function updateSwatchOps(scene: SceneState, id: string, patch: Partial<SwatchSpec>): Op[] {
  const cur = scene.variables[id];
  if (!cur || !cur.swatch) return [];
  const col = scene.collections[cur.collectionId];
  const mode = col?.modes[0]?.id;
  if (!mode) return [];
  const colorNow = swatchColor(scene, id) ?? { r: 0, g: 0, b: 0 };
  const currentCmyk = swatchCmyk(cur);
  const spec: SwatchSpec = {
    name: patch.name ?? cur.name,
    rgb: patch.rgb ?? (patch.cmyk ? undefined : colorNow),
    cmyk: patch.cmyk ?? (patch.rgb ? undefined : currentCmyk ?? undefined),
    spotName: patch.spotName !== undefined ? patch.spotName : cur.spotName,
    ...(cur.tintOf ? { tintOf: cur.tintOf, tint: patch.tint ?? cur.tint } : {}),
  };
  const next = build(scene, id, cur.collectionId, mode, spec);
  if (!next) return [];
  // The other modes' values (a swatch should have one mode, but a collection may have more) are kept.
  next.values = { ...cur.values, ...next.values };
  const ops: Op[] = [makeSetVariableOp(next)];
  // Tints follow, level by level: each is rebuilt from its (just changed) base.
  let working: SceneState = { ...scene, variables: { ...scene.variables, [id]: next } };
  for (const t of tintsOf(scene, id)) {
    const tcol = scene.collections[t.collectionId];
    const tmode = tcol?.modes[0]?.id;
    if (!tmode) continue;
    const rebuilt = build(working, t.id, t.collectionId, tmode, { name: t.name, tintOf: t.tintOf, tint: t.tint, spotName: t.spotName });
    if (!rebuilt) continue;
    rebuilt.values = { ...t.values, ...rebuilt.values };
    ops.push(makeSetVariableOp(rebuilt));
    working = { ...working, variables: { ...working.variables, [t.id]: rebuilt } };
  }
  return ops;
}

/** Deletes a swatch: its tints become plain swatches of the colors they show, and what used it is detached. */
export function deleteSwatchOps(scene: SceneState, id: string): Op[] {
  if (!scene.variables[id]?.swatch) return [];
  const detached = swatchesOf(scene).filter((v) => v.tintOf === id).map((v) => {
    const { tintOf: _a, tint: _b, ...rest } = v;
    void _a; void _b;
    return makeSetVariableOp(rest);
  });
  return [...detached, makeDeleteVariableOp(id)];
}

/** Ops that give `ids` the swatch for their fill or their stroke (the first paint of each). */
export function applySwatchOps(scene: SceneState, ids: readonly string[], target: "fill" | "stroke", swatchId: string | null): Op[] {
  return bindingOps(scene, ids, target === "fill" ? "fills.0" : "strokes.0", swatchId);
}

/** A swatch for the color of a node's first fill, named after it ("#RRGGBB"). */
export function swatchFromColor(rgb: Rgb): SwatchSpec {
  const hex = "#" + [rgb.r, rgb.g, rgb.b].map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("").toUpperCase();
  return { name: hex, rgb };
}
