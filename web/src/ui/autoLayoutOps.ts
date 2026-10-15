import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { makeSetPropsOp } from "../tools/ops";
import { toPbAutoLayout } from "../store/types";
import type { AutoLayoutLite, NodeLite } from "../store/types";
import type { NodeLookup } from "./gradientOps";

// The Auto layout panel's ops. They write ONLY the frame's auto_layout field:
// the children's positions and the size of a hug frame are recomputed by the server (and
// by applyOp here, for the optimistic view), not by the panel.

export const DEFAULT_AUTO_LAYOUT: AutoLayoutLite = {
  direction: "horizontal", spacing: 8,
  paddingLeft: 0, paddingTop: 0, paddingRight: 0, paddingBottom: 0,
  mainAlign: "start", crossAlign: "start",
  hugWidth: false, hugHeight: false,
};

// `wrap` is a plain boolean in a patch (false turns it off); the model only keeps `true`.
export type AutoLayoutPatch = (Partial<Omit<AutoLayoutLite, "wrap">> & { wrap?: boolean }) | { enabled: boolean };

function write(n: NodeLite, layout: AutoLayoutLite | null): Op {
  const frame = { clipsContent: n.clipsContent, ...(layout ? { autoLayout: toPbAutoLayout(layout) } : {}) };
  return makeSetPropsOp(n.id, { shape: { case: "frame", value: frame } }, ["auto_layout"]);
}

function clampNonNegative<T extends Partial<AutoLayoutLite> | { crossSpacing?: number }>(p: T): T {
  const out = { ...p } as Record<string, unknown>;
  for (const k of ["spacing", "paddingLeft", "paddingTop", "paddingRight", "paddingBottom", "crossSpacing"] as const) {
    if (out[k] !== undefined) out[k] = Math.max(0, out[k] as number);
  }
  return out as T;
}

/**
 * Turns on, turns off or edits the auto layout of the selected frames. Turning on
 * writes the default; a patch on a frame without auto layout turns it on with the
 * default plus that patch. A patch that changes nothing produces no op.
 */
export function autoLayoutOps(ids: readonly string[], lookup: NodeLookup, patch: AutoLayoutPatch): Op[] {
  return ids.flatMap((id) => {
    const n = lookup(id);
    if (!n || n.kind !== "frame") return [];
    if ("enabled" in patch) {
      if (!patch.enabled) return n.autoLayout ? [write(n, null)] : [];
      return n.autoLayout ? [] : [write(n, DEFAULT_AUTO_LAYOUT)];
    }
    const base = n.autoLayout ?? DEFAULT_AUTO_LAYOUT;
    const merged = { ...base, ...clampNonNegative(patch) } as AutoLayoutLite & { wrap?: boolean };
    // The model keeps `wrap` only when true and `crossSpacing` only when non-zero, like the proto's defaults.
    const { wrap, crossSpacing, ...rest } = merged;
    const next: AutoLayoutLite = { ...rest, ...(wrap ? { wrap: true as const } : {}), ...(crossSpacing ? { crossSpacing } : {}) };
    if (n.autoLayout && JSON.stringify(next) === JSON.stringify(n.autoLayout)) return [];
    return [write(n, next)];
  });
}
