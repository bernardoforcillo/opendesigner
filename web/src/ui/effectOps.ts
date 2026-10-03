import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { makeSetPropsOp } from "../tools/ops";
import { toPbEffects } from "../store/types";
import type { EffectLite, NodeLite } from "../store/types";
import type { RgbLite } from "./fields/ColorField";
import type { NodeLookup } from "./gradientOps";

// Gli op del pannello Effetti. Come il renderer, il pannello governa la PRIMA
// ombra e la PRIMA sfocatura di un nodo, e lascia stare gli altri effetti della
// lista (un documento può averne di più, scritti da un agente o da un'altra
// versione): modificare l'ombra non li cancella.
export type ShadowLite = Extract<EffectLite, { kind: "dropShadow" }>;
type BlurLite = Extract<EffectLite, { kind: "layerBlur" }>;

// Un'ombra morbida e discreta: è il valore da cui parte chi accende l'ombra, e
// si VEDE subito senza essere invadente.
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
  /** Raggio >= 0: un valore negativo non ha senso e si porta a 0. */
  blur?: number;
  /** Colore senza alfa (vedi ColorField): l'alfa ha il suo campo. */
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
    // Accendere (enabled: true) senza altro scrive il default; a ombra già
    // presente e senza nulla da cambiare non c'è niente da scrivere.
    if (at >= 0 && JSON.stringify(next) === JSON.stringify(base)) return [];
    if (at >= 0) list[at] = next; else list.unshift(next);
    return [write(n, list)];
  });
}

/** Raggio 0 (o meno) toglie la sfocatura. */
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
