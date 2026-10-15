import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { makeSetPropsOp } from "../tools/ops";
import { toPbBlend, toPbEffects } from "../store/types";
import type { BlendModeLite, EffectLite, NodeLite } from "../store/types";
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

// ---------- the whole list: several shadows, inner shadow, background blur, blend mode ----------

export type ShadowKind = "dropShadow" | "innerShadow";
export type ShadowLikeLite = Extract<EffectLite, { kind: ShadowKind }>;
type BackdropLite = Extract<EffectLite, { kind: "backgroundBlur" }>;

export const isShadowLike = (e: EffectLite): e is ShadowLikeLite => e.kind === "dropShadow" || e.kind === "innerShadow";

/** The shadows of a node (drop and inner), each with its index in the effect list. */
export function shadowsOf(n: NodeLite | undefined): { index: number; shadow: ShadowLikeLite }[] {
  const out: { index: number; shadow: ShadowLikeLite }[] = [];
  (n?.effects ?? []).forEach((e, index) => { if (isShadowLike(e)) out.push({ index, shadow: e }); });
  return out;
}

export function backgroundBlurOf(n: NodeLite | undefined): BackdropLite | undefined {
  return n?.effects?.find((e): e is BackdropLite => e.kind === "backgroundBlur");
}

/** Appends a default shadow of `kind` to the end of the list. */
export function addShadowOps(ids: readonly string[], lookup: NodeLookup, kind: ShadowKind): Op[] {
  return ids.flatMap((id) => {
    const n = lookup(id);
    if (!n) return [];
    return [write(n, [...(n.effects ?? []), { ...DEFAULT_SHADOW, kind }])];
  });
}

/** Edits the shadow at `index` (a node without a shadow there is left alone). */
export function editShadowOps(ids: readonly string[], lookup: NodeLookup, index: number, patch: Omit<ShadowPatch, "enabled">): Op[] {
  return ids.flatMap((id) => {
    const n = lookup(id);
    const base = n?.effects?.[index];
    if (!n || !base || !isShadowLike(base)) return [];
    const next: ShadowLikeLite = {
      kind: base.kind,
      color: { ...(patch.rgb ?? base.color), a: patch.alpha !== undefined ? clamp01(patch.alpha) : base.color.a },
      offsetX: patch.offsetX ?? base.offsetX,
      offsetY: patch.offsetY ?? base.offsetY,
      blur: Math.max(0, patch.blur ?? base.blur),
    };
    if (JSON.stringify(next) === JSON.stringify(base)) return [];
    const list = [...n.effects!];
    list[index] = next;
    return [write(n, list)];
  });
}

/** Removes the effect at `index`. */
export function removeEffectOps(ids: readonly string[], lookup: NodeLookup, index: number): Op[] {
  return ids.flatMap((id) => {
    const n = lookup(id);
    if (!n?.effects || index < 0 || index >= n.effects.length) return [];
    return [write(n, n.effects.filter((_, i) => i !== index))];
  });
}

/** Radius 0 (or less) removes the background blur. */
export function backgroundBlurOps(ids: readonly string[], lookup: NodeLookup, radius: number): Op[] {
  return ids.flatMap((id) => {
    const n = lookup(id);
    if (!n) return [];
    const list = [...(n.effects ?? [])];
    const at = list.findIndex((e) => e.kind === "backgroundBlur");
    if (!(radius > 0)) {
      if (at < 0) return [];
      list.splice(at, 1);
      return [write(n, list)];
    }
    if (at >= 0 && (list[at] as BackdropLite).radius === radius) return [];
    const next: BackdropLite = { kind: "backgroundBlur", radius };
    if (at >= 0) list[at] = next; else list.push(next);
    return [write(n, list)];
  });
}

/** The blend mode of the nodes; undefined (normal) clears it. */
export function blendModeOps(ids: readonly string[], lookup: NodeLookup, mode: BlendModeLite | undefined): Op[] {
  return ids.flatMap((id) => {
    const n = lookup(id);
    if (!n || n.blendMode === mode) return [];
    return [makeSetPropsOp(n.id, { blendMode: toPbBlend(mode) }, ["blend_mode"])];
  });
}
