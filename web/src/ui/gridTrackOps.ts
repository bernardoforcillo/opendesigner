import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";
import { makeSetPropsOp } from "@/tools/ops";
import type { AutoLayoutLite, GridCellLite, GridTrackLite, NodeLite, SceneState } from "@/store/types";

// The ops of GRID mode (docs/layout.md): which cell a child of a grid frame sits in, and the edits
// of the track lists in the Auto layout section. Pure, like the other panel ops.

export type GridAxis = "columns" | "rows";
export type CellField = "column" | "columnSpan" | "row" | "rowSpan";

/** The cell number of every node, 0 for auto, or undefined when they differ. */
export function cellOf(nodes: readonly NodeLite[], field: CellField): number | undefined {
  const values = nodes.map((n) => n.gridCell?.[field] ?? 0);
  return values.every((v) => v === values[0]) ? values[0] : undefined;
}

/** Sets one number of the cell (0 = auto / one) on the nodes whose value differs; the rest of the cell is kept. */
export function cellOps(scene: SceneState, ids: readonly string[], field: CellField, value: number): Op[] {
  const v = Number.isFinite(value) ? Math.min(1000, Math.max(0, Math.round(value))) : 0;
  return ids.flatMap((id) => {
    const n = scene.nodes.at(id);
    if (!n || (n.gridCell?.[field] ?? 0) === v) return [];
    const next: GridCellLite = { ...n.gridCell, [field]: v };
    return [makeSetPropsOp(id, { gridCell: { column: next.column ?? 0, columnSpan: next.columnSpan ?? 0, row: next.row ?? 0, rowSpan: next.rowSpan ?? 0 } }, ["grid_cell"])];
  });
}

/** The tracks of one axis after appending a track (fr 1 by default). */
export function withTrackAdded(al: AutoLayoutLite, axis: GridAxis): GridTrackLite[] {
  return [...(al[axis] ?? []), { kind: "fr", size: 1 }];
}

/** The tracks of one axis after changing track `index` (kind and/or size) or removing it (`patch` null). */
export function withTrackChanged(al: AutoLayoutLite, axis: GridAxis, index: number, patch: Partial<GridTrackLite> | null): GridTrackLite[] {
  const tracks = [...(al[axis] ?? [])];
  if (index < 0 || index >= tracks.length) return tracks;
  if (patch === null) tracks.splice(index, 1);
  else {
    const next = { ...tracks[index], ...patch };
    // A hug track has no size of its own; an fr track weighs at least something.
    tracks[index] = next.kind === "hug" ? { kind: "hug", size: 0 } : { kind: next.kind, size: Math.max(0, next.size) };
  }
  return tracks;
}
