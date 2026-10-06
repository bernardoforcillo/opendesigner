import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { makeSetPropsOp } from "../tools/ops";
import { toPbLayoutGrids } from "../store/types";
import type { LayoutGridLite, NodeLite } from "../store/types";
import type { NodeLookup } from "./gradientOps";

// The ops of the layout grid panel. The mask path replaces the whole list, so every op
// rebuilds it from the frame's current one; only frames take grids.

export const DEFAULT_GRIDS: Record<LayoutGridLite["kind"], LayoutGridLite> = {
  columns: { kind: "columns", size: 0, count: 12, gutter: 20, margin: 0, color: { r: 1, g: 0.2, b: 0.2, a: 0.1 } },
  rows: { kind: "rows", size: 0, count: 8, gutter: 20, margin: 0, color: { r: 1, g: 0.2, b: 0.2, a: 0.1 } },
  grid: { kind: "grid", size: 8, count: 0, gutter: 0, margin: 0, color: { r: 0.2, g: 0.4, b: 1, a: 0.15 } },
};

const write = (n: NodeLite, grids: LayoutGridLite[]): Op =>
  makeSetPropsOp(n.id, { layoutGrids: toPbLayoutGrids(grids) }, ["layout_grids"]);

const frameOf = (lookup: NodeLookup, id: string): NodeLite | undefined => {
  const n = lookup(id);
  return n && n.kind === "frame" ? n : undefined;
};

export function addGridOps(ids: readonly string[], lookup: NodeLookup, kind: LayoutGridLite["kind"]): Op[] {
  return ids.flatMap((id) => {
    const n = frameOf(lookup, id);
    return n ? [write(n, [...(n.layoutGrids ?? []), { ...DEFAULT_GRIDS[kind] }])] : [];
  });
}

export type GridPatch = Partial<Pick<LayoutGridLite, "kind" | "size" | "count" | "gutter" | "margin">> & { alpha?: number };

/** Edits the grid at `index`; the numbers are brought to what the core accepts. */
export function editGridOps(ids: readonly string[], lookup: NodeLookup, index: number, patch: GridPatch): Op[] {
  return ids.flatMap((id) => {
    const n = frameOf(lookup, id);
    const base = n?.layoutGrids?.[index];
    if (!n || !base) return [];
    const kind = patch.kind ?? base.kind;
    const next: LayoutGridLite = {
      ...(kind !== base.kind ? DEFAULT_GRIDS[kind] : base),
      kind,
      color: { ...(kind !== base.kind ? DEFAULT_GRIDS[kind].color : base.color) },
    };
    if (patch.size !== undefined) next.size = Math.max(1, patch.size);
    if (patch.count !== undefined) next.count = Math.min(1000, Math.max(1, Math.round(patch.count)));
    if (patch.gutter !== undefined) next.gutter = Math.max(0, patch.gutter);
    if (patch.margin !== undefined) next.margin = Math.max(0, patch.margin);
    if (patch.alpha !== undefined) next.color = { ...next.color, a: Math.min(1, Math.max(0, patch.alpha)) };
    if (JSON.stringify(next) === JSON.stringify(base)) return [];
    const list = [...n.layoutGrids!];
    list[index] = next;
    return [write(n, list)];
  });
}

export function removeGridOps(ids: readonly string[], lookup: NodeLookup, index: number): Op[] {
  return ids.flatMap((id) => {
    const n = frameOf(lookup, id);
    if (!n?.layoutGrids || index < 0 || index >= n.layoutGrids.length) return [];
    return [write(n, n.layoutGrids.filter((_, i) => i !== index))];
  });
}
