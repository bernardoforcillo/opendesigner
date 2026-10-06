import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { makeSetPropsOp } from "../tools/ops";
import { toPbEffects } from "../store/types";
import type { EffectLite, NodeLite } from "../store/types";
import type { RgbLite } from "./fields/ColorField";
import type { NodeLookup } from "./gradientOps";

// The Effects panel's ops. Like the renderer, the panel governs a node's FIRST
// shadow and FIRST blur, and leaves the other effects of the
// list alone (a document may have more, written by an agent or by another
// version): editing the shadow does not erase them.
export type ShadowLite = Extract<EffectLite, { kind: "dropShadow" }>;
type BlurLite = Extract<EffectLite, { kind: "layerBlur" }>;

// A soft, discreet shadow: it is the value from which whoever turns the shadow on starts, and
// it is SEEN right away without being intrusive.
export const DEFAULT_SHADOW: ShadowLite = {
  kind: "dropShadow", color: { r: 0, g: 0, b: 0, a: 0.25 }, offsetX: 0, offsetY: 4, blur: 8,
};

export function shadowOf(n: NodeLite | undefined): ShadowLite | undefined {
  return n?.effects?.find((e): e is ShadowLite => e.kind === "dropShadow");
}
export function blurOf(n: NodeLite | undefined): BlurLite | undefined {
  return n?.effects?.find((e): e is BlurLite => e.kind === "layerBlur");
}

export interface ShadowPatch {
  enabled?: boolean;
  offsetX?: number; offsetY?: number;
  /** Radius >= 0: a negative value makes no sense and is brought to 0. */
  blur?: number;
  /** Color without alpha (see ColorField): alpha has its own field. */
  rgb?: RgbLite;
  /** 0..1 */
  alpha?: number;
}

function clamp01(v: number): number { return Math.min(1, Math.max(0, v)); }

function write(n: NodeLite, effects: EffectLite[]): Op {
  return makeSetPropsOp(n.id, { effects: toPbEffects(effects) }, ["effects"]);
}

export function shadowOps(ids: readonly string[], lookup: NodeLookup, patch: ShadowPatch): Op[] {
  return ids.flatMap((id) => {
    const n = lookup(id);
    if (!n) return [];
    const list = [...(n.effects ?? [])];
    const at = list.findIndex((e) => e.kind === "dropShadow");
    if (patch.enabled === false) {
      if (at < 0) return [];
      list.splice(at, 1);
      return [write(n, list)];
    }
    const base = at >= 0 ? (list[at] as ShadowLite) : DEFAULT_SHADOW;
    const next: ShadowLite = {
      kind: "dropShadow",
      color: {
        ...(patch.rgb ?? base.color),
        a: patch.alpha !== undefined ? clamp01(patch.alpha) : base.color.a,
      },
      offsetX: patch.offsetX ?? base.offsetX,
      offsetY: patch.offsetY ?? base.offsetY,
      blur: Math.max(0, patch.blur ?? base.blur),
    };
    // Turning on (enabled: true) with nothing else writes the default; with the shadow already
    // present and nothing to change there is nothing to write.
    if (at >= 0 && JSON.stringify(next) === JSON.stringify(base)) return [];
    if (at >= 0) list[at] = next; else list.unshift(next);
    return [write(n, list)];
  });
}

/** Radius 0 (or less) removes the blur. */
export function blurOps(ids: readonly string[], lookup: NodeLookup, radius: number): Op[] {
  return ids.flatMap((id) => {
    const n = lookup(id);
    if (!n) return [];
    const list = [...(n.effects ?? [])];
    const at = list.findIndex((e) => e.kind === "layerBlur");
    if (!(radius > 0)) {
      if (at < 0) return [];
      list.splice(at, 1);
      return [write(n, list)];
    }
    if (at >= 0 && (list[at] as BlurLite).radius === radius) return [];
    const next: BlurLite = { kind: "layerBlur", radius };
    if (at >= 0) list[at] = next; else list.push(next);
    return [write(n, list)];
  });
}
