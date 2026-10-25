import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { makeSetPropsOp } from "../tools/ops";
import { toPbEffects } from "../store/types";
import type { EffectLite, NodeLite } from "../store/types";
import type { NodeLookup } from "./gradientOps";
import type { GlassLite, NoiseLite, ProgressiveBlurLite, TextureLite } from "../renderer/effectsFx";

// The panel's ops for progressive blur, noise, texture and glass. Like the other effect
// controls they govern the FIRST effect of their kind (progressive blur: the first of the
// same target) and leave the rest of the list alone.

export const DEFAULT_PROGRESSIVE: ProgressiveBlurLite = {
  kind: "progressiveBlur", startRadius: 0, endRadius: 16, x1: 0.5, y1: 0, x2: 0.5, y2: 1, background: false,
};
export const DEFAULT_NOISE: NoiseLite = {
  kind: "noise", mode: "mono", size: 1, density: 0.5, opacity: 0.25,
  color: { r: 0, g: 0, b: 0, a: 1 }, color2: { r: 1, g: 1, b: 1, a: 1 }, seed: 1,
};
export const DEFAULT_TEXTURE: TextureLite = { kind: "texture", scale: 8, intensity: 0.4, seed: 1 };
export const DEFAULT_GLASS: GlassLite = { kind: "glass", frost: 12, light: 0.5, lightAngle: 45, noise: 0.25 };

/** The gradient directions the panel offers for a progressive blur, as start/end points in the unit box. */
export const RAMP_DIRECTIONS = {
  down: { x1: 0.5, y1: 0, x2: 0.5, y2: 1 },
  up: { x1: 0.5, y1: 1, x2: 0.5, y2: 0 },
  right: { x1: 0, y1: 0.5, x2: 1, y2: 0.5 },
  left: { x1: 1, y1: 0.5, x2: 0, y2: 0.5 },
} as const;
export type RampDirection = keyof typeof RAMP_DIRECTIONS;

/** The direction name of a ramp, or "custom" when its points are not one of the four. */
export function rampDirectionOf(e: ProgressiveBlurLite): RampDirection | "custom" {
  for (const [name, d] of Object.entries(RAMP_DIRECTIONS)) {
    if (e.x1 === d.x1 && e.y1 === d.y1 && e.x2 === d.x2 && e.y2 === d.y2) return name as RampDirection;
  }
  return "custom";
}

export function progressiveOf(n: NodeLite | undefined, background: boolean): ProgressiveBlurLite | undefined {
  return n?.effects?.find((e): e is ProgressiveBlurLite => e.kind === "progressiveBlur" && e.background === background);
}
export function fxOf<K extends "noise" | "texture" | "glass">(n: NodeLite | undefined, kind: K): Extract<EffectLite, { kind: K }> | undefined {
  return n?.effects?.find((e): e is Extract<EffectLite, { kind: K }> => e.kind === kind);
}

type Matcher = (e: EffectLite) => boolean;
const progressiveMatcher = (background: boolean): Matcher => (e) => e.kind === "progressiveBlur" && e.background === background;
const kindMatcher = (kind: EffectLite["kind"]): Matcher => (e) => e.kind === kind;

function write(n: NodeLite, effects: EffectLite[]): Op {
  return makeSetPropsOp(n.id, { effects: toPbEffects(effects) }, ["effects"]);
}

// Replaces the first effect `match` finds with `next` (appending when there is none); null removes it.
function replaceOps(ids: readonly string[], lookup: NodeLookup, match: Matcher, next: (cur: EffectLite | undefined) => EffectLite | null): Op[] {
  return ids.flatMap((id) => {
    const n = lookup(id);
    if (!n) return [];
    const list = [...(n.effects ?? [])];
    const at = list.findIndex(match);
    const made = next(at >= 0 ? list[at] : undefined);
    if (made === null) {
      if (at < 0) return [];
      list.splice(at, 1);
      return [write(n, list)];
    }
    if (at >= 0 && JSON.stringify(list[at]) === JSON.stringify(made)) return [];
    if (at >= 0) list[at] = made; else list.push(made);
    return [write(n, list)];
  });
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Turns the progressive blur of one target on (default ramp), off, or edits it. */
export function progressiveOps(
  ids: readonly string[], lookup: NodeLookup, background: boolean,
  patch: Partial<Omit<ProgressiveBlurLite, "kind" | "background">> | { enabled: boolean },
): Op[] {
  return replaceOps(ids, lookup, progressiveMatcher(background), (cur) => {
    if ("enabled" in patch) return patch.enabled ? (cur ?? { ...DEFAULT_PROGRESSIVE, background }) : null;
    const base = (cur as ProgressiveBlurLite | undefined) ?? { ...DEFAULT_PROGRESSIVE, background };
    return {
      ...base, ...patch, background,
      startRadius: Math.max(0, patch.startRadius ?? base.startRadius), endRadius: Math.max(0, patch.endRadius ?? base.endRadius),
    };
  });
}

export function noiseOps(ids: readonly string[], lookup: NodeLookup, patch: Partial<Omit<NoiseLite, "kind">> | { enabled: false }): Op[] {
  return replaceOps(ids, lookup, kindMatcher("noise"), (cur) => {
    if ("enabled" in patch) return null;
    const base = (cur as NoiseLite | undefined) ?? DEFAULT_NOISE;
    return {
      ...base, ...patch,
      size: Math.max(0, patch.size ?? base.size), density: clamp01(patch.density ?? base.density), opacity: clamp01(patch.opacity ?? base.opacity),
    };
  });
}

export function textureOps(ids: readonly string[], lookup: NodeLookup, patch: Partial<Omit<TextureLite, "kind">> | { enabled: boolean }): Op[] {
  return replaceOps(ids, lookup, kindMatcher("texture"), (cur) => {
    if ("enabled" in patch) return patch.enabled ? (cur ?? DEFAULT_TEXTURE) : null;
    const base = (cur as TextureLite | undefined) ?? DEFAULT_TEXTURE;
    return { ...base, ...patch, scale: Math.max(0, patch.scale ?? base.scale), intensity: clamp01(patch.intensity ?? base.intensity) };
  });
}

/** Moves the node's progressive blur to `target` (keeping its ramp), creates one with the default ramp, or removes it ("none"). One op per node. */
export function progressiveTargetOps(ids: readonly string[], lookup: NodeLookup, target: "none" | "layer" | "background"): Op[] {
  return ids.flatMap((id) => {
    const n = lookup(id);
    if (!n) return [];
    const list = n.effects ?? [];
    const cur = list.find((e): e is ProgressiveBlurLite => e.kind === "progressiveBlur");
    const rest = list.filter((e) => e.kind !== "progressiveBlur");
    if (target === "none") return cur ? [write(n, rest)] : [];
    const background = target === "background";
    if (cur && cur.background === background) return [];
    return [write(n, [...rest, { ...(cur ?? DEFAULT_PROGRESSIVE), background }])];
  });
}

export function glassOps(ids: readonly string[], lookup: NodeLookup, patch: Partial<Omit<GlassLite, "kind">> | { enabled: boolean }): Op[] {
  return replaceOps(ids, lookup, kindMatcher("glass"), (cur) => {
    if ("enabled" in patch) return patch.enabled ? (cur ?? DEFAULT_GLASS) : null;
    const base = (cur as GlassLite | undefined) ?? DEFAULT_GLASS;
    return {
      ...base, ...patch,
      frost: Math.max(0, patch.frost ?? base.frost), light: clamp01(patch.light ?? base.light), noise: clamp01(patch.noise ?? base.noise),
    };
  });
}
