import { LayoutGridKind } from "../gen/opendesigner/v1/opendesigner_pb";
import type { LayoutGrid as PbLayoutGrid } from "../gen/opendesigner/v1/opendesigner_pb";
import type { LayoutGridLite, NodeLite } from "./types";

// LAYOUT GRIDS of a frame -- editor guides and snap targets, never exported. The TS
// twin of core.validateLayoutGrids (internal/core/layout_grids.go), plus the geometry
// the overlay and the snap share.

/** Parity with core.validateLayoutGrids. Reads the wire message: an unknown kind is rejected. */
export function areValidLayoutGrids(grids: readonly PbLayoutGrid[] | undefined): boolean {
  for (const g of grids ?? []) {
    if (![g.size, g.gutter, g.margin].every(Number.isFinite)) return false;
    if (g.kind === LayoutGridKind.GRID) {
      if (!(g.size > 0)) return false;
    } else if (g.kind === LayoutGridKind.COLUMNS || g.kind === LayoutGridKind.ROWS) {
      if (g.count < 1 || g.count > 1000 || g.gutter < 0 || g.margin < 0) return false;
    } else return false;
  }
  return true;
}

/** A band of a columns/rows grid: [start, end] along its axis, in the frame's own coordinates. */
export interface GridBand { start: number; end: number }

/** The bands of a columns (along x) or rows (along y) grid for a frame of `extent` on that axis. */
export function gridBands(g: LayoutGridLite, extent: number): GridBand[] {
  if (g.kind === "grid") return [];
  const count = Math.max(1, Math.floor(g.count));
  const size = (extent - 2 * g.margin - (count - 1) * g.gutter) / count;
  if (!(size > 0)) return [];
  const out: GridBand[] = [];
  for (let i = 0; i < count; i++) {
    const start = g.margin + i * (size + g.gutter);
    out.push({ start, end: start + size });
  }
  return out;
}

/** The lines of a square grid along one axis, from 0 to `extent`. */
export function gridLines(g: LayoutGridLite, extent: number): number[] {
  if (g.kind !== "grid" || !(g.size > 0)) return [];
  const out: number[] = [];
  // Capped: a 1px grid over a huge frame must not produce millions of snap targets.
  for (let v = 0, i = 0; v <= extent && i < 5000; v += g.size, i++) out.push(v);
  return out;
}

/**
 * The positions snapping uses for a frame, per axis, in the frame's own coordinates:
 * both edges of every column / row and every grid line.
 */
export function snapPositions(frame: NodeLite): { x: number[]; y: number[] } {
  const x: number[] = [];
  const y: number[] = [];
  for (const g of frame.layoutGrids ?? []) {
    if (g.kind === "grid") {
      x.push(...gridLines(g, frame.width));
      y.push(...gridLines(g, frame.height));
    } else if (g.kind === "columns") {
      for (const b of gridBands(g, frame.width)) x.push(b.start, b.end);
    } else {
      for (const b of gridBands(g, frame.height)) y.push(b.start, b.end);
    }
  }
  return { x, y };
}
