import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { makeSetPropsOp } from "../tools/ops";
import { META_CAP, META_DASH, META_DASH_OFFSET, META_JOIN, META_MITER } from "../renderer/vectorStyle";
import type { NodeLookup } from "./gradientOps";

// The stroke STYLE -- cap, join, miter limit, dash -- lives in the node's meta (the
// keys the SVG import already writes, see renderer/vectorStyle.ts) and applies to
// every stroke of the node. These ops write only those keys and leave the rest of
// the node's meta alone: `meta` is replaced whole by its mask path, so the map is
// rebuilt from the node's current one.

export interface StrokeStylePatch {
  cap?: "butt" | "round" | "square";
  join?: "miter" | "round" | "bevel";
  miter?: number;
  /** "4,2" in world units; "" clears the dash. */
  dash?: string;
  dashOffset?: number;
}

const DEFAULTS = { cap: "butt", join: "miter" } as const;

function put(meta: Record<string, string>, key: string, value: string | undefined): void {
  if (value === undefined) delete meta[key]; else meta[key] = value;
}

/** A dash text ("4, 2" / "4 2") as the canonical "4,2", or undefined when it is not a usable dash. */
export function normalizeDash(text: string): string | undefined {
  const parts = text.split(/[\s,]+/).filter((s) => s !== "").map(Number);
  if (parts.length === 0 || parts.some((v) => !Number.isFinite(v) || v < 0) || !parts.some((v) => v > 0)) return undefined;
  return parts.join(",");
}

export function strokeStyleOps(ids: readonly string[], lookup: NodeLookup, patch: StrokeStylePatch): Op[] {
  return ids.flatMap((id) => {
    const n = lookup(id);
    if (!n) return [];
    const meta: Record<string, string> = { ...(n.meta ?? {}) };
    if (patch.cap !== undefined) put(meta, META_CAP, patch.cap === DEFAULTS.cap ? undefined : patch.cap);
    if (patch.join !== undefined) put(meta, META_JOIN, patch.join === DEFAULTS.join ? undefined : patch.join);
    if (patch.miter !== undefined) put(meta, META_MITER, patch.miter > 0 ? String(patch.miter) : undefined);
    if (patch.dash !== undefined) put(meta, META_DASH, normalizeDash(patch.dash));
    if (patch.dashOffset !== undefined) put(meta, META_DASH_OFFSET, patch.dashOffset === 0 ? undefined : String(patch.dashOffset));
    if (JSON.stringify(meta) === JSON.stringify(n.meta ?? {})) return [];
    return [makeSetPropsOp(id, { meta }, ["meta"])];
  });
}
