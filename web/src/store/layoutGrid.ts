import type { NodeLite, AutoLayoutLite, GridTrackLite, SceneState } from "./types";
import { childrenOf } from "./tree";

// AUTO LAYOUT, GRID MODE -- the TypeScript half of internal/core/layout_grid.go, which is the
// AUTHORITY (read its header for the rules). The arithmetic is written in the same order, and
// the golden fixtures testdata/golden/layout_grid.json and layout_group.json run both.

export const MAX_GRID_TRACKS = 100;
export const MAX_GRID_INDEX = 1000;

const finite = (v: number): boolean => Number.isFinite(v);

// Parity with validateGridLayout in Go: finite non-negative gaps and track sizes, a sane track count.
// (The enums are closed by the protobuf types themselves; an out-of-range number is rejected.)
export function isValidGridLayout(al: { mode?: number; columns: readonly { kind: number; size: number }[]; rows: readonly { kind: number; size: number }[]; columnGap: number; rowGap: number } | undefined): boolean {
  if (!al) return true;
  if (!(al.mode === undefined || (al.mode >= 0 && al.mode <= 1))) return false;
  if (!finite(al.columnGap) || !finite(al.rowGap) || al.columnGap < 0 || al.rowGap < 0) return false;
  for (const tracks of [al.columns, al.rows]) {
    if (tracks.length > MAX_GRID_TRACKS) return false;
    for (const t of tracks) {
      if (!(t.kind >= 0 && t.kind <= 2) || !finite(t.size) || t.size < 0) return false;
    }
  }
  return true;
}

// Parity with validateGridCell in Go: every number in 0..1000.
export function isValidGridCell(c: { column: number; columnSpan: number; row: number; rowSpan: number } | undefined): boolean {
  if (!c) return true;
  return [c.column, c.columnSpan, c.row, c.rowSpan].every((v) => Number.isInteger(v) && v >= 0 && v <= MAX_GRID_INDEX);
}

export interface Box { minX: number; minY: number; maxX: number; maxY: number }

// The union of the visible children of group `id` in the group's own space; null when there is
// nothing to show. Parity with groupBox in Go.
export function groupBox(view: SceneState, id: string): Box | null {
  let b: Box | null = null;
  for (const c of childrenOf(view, id)) {
    if (!c.visible) continue;
    let cb: Box = { minX: c.x, minY: c.y, maxX: c.x + c.width, maxY: c.y + c.height };
    if (c.kind === "group") {
      const inner = groupBox(view, c.id);
      if (!inner) continue;
      cb = { minX: c.x + inner.minX, minY: c.y + inner.minY, maxX: c.x + inner.maxX, maxY: c.y + inner.maxY };
    }
    b = b === null ? cb : { minX: Math.min(b.minX, cb.minX), minY: Math.min(b.minY, cb.minY), maxX: Math.max(b.maxX, cb.maxX), maxY: Math.max(b.maxY, cb.maxY) };
  }
  return b;
}

interface Cells { col: number[]; row: number[]; cs: number[]; rs: number[]; ncols: number; nrows: number }

// Every child's 0-based column and row and its spans; the grid's size. Parity with gridCells in Go.
function gridCells(kids: readonly NodeLite[], al: AutoLayoutLite): Cells {
  const n = kids.length;
  const col = new Array<number>(n).fill(0), row = new Array<number>(n).fill(0);
  const cs = new Array<number>(n).fill(1), rs = new Array<number>(n).fill(1);
  let ncols = Math.max(al.columns?.length ?? 0, 1);
  let nrows = al.rows?.length ?? 0;
  kids.forEach((k, i) => {
    cs[i] = Math.max(k.gridCell?.columnSpan ?? 0, 1);
    rs[i] = Math.max(k.gridCell?.rowSpan ?? 0, 1);
    const c = k.gridCell?.column ?? 0;
    if (c > 0) ncols = Math.max(ncols, c - 1 + cs[i]);
  });
  const occ = new Set<string>();
  const mark = (i: number) => {
    for (let r = row[i]; r < row[i] + rs[i]; r++) for (let c = col[i]; c < col[i] + cs[i]; c++) occ.add(r + "," + c);
  };
  const free = (r0: number, c0: number, rspan: number, cspan: number): boolean => {
    for (let r = r0; r < r0 + rspan; r++) for (let c = c0; c < c0 + cspan; c++) if (occ.has(r + "," + c)) return false;
    return true;
  };
  const placed = new Array<boolean>(n).fill(false);
  kids.forEach((k, i) => {
    if ((k.gridCell?.column ?? 0) > 0 && (k.gridCell?.row ?? 0) > 0) {
      col[i] = k.gridCell!.column! - 1;
      row[i] = k.gridCell!.row! - 1;
      mark(i);
      placed[i] = true;
    }
  });
  let cr = 0, cc = 0;
  kids.forEach((k, i) => {
    if (placed[i]) return;
    const pc = k.gridCell?.column ?? 0, pr = k.gridCell?.row ?? 0;
    if (pc > 0) {
      col[i] = pc - 1;
      while (!free(row[i], col[i], rs[i], cs[i])) row[i]++;
    } else if (pr > 0) {
      row[i] = pr - 1;
      cs[i] = Math.min(cs[i], ncols);
      col[i] = 0;
      while (col[i] + cs[i] <= ncols && !free(row[i], col[i], rs[i], cs[i])) col[i]++;
      if (col[i] + cs[i] > ncols) col[i] = 0;
    } else {
      cs[i] = Math.min(cs[i], ncols);
      for (;;) {
        if (cc + cs[i] > ncols) { cc = 0; cr++; continue; }
        if (free(cr, cc, rs[i], cs[i])) break;
        cc++;
      }
      col[i] = cc;
      row[i] = cr;
      cc += cs[i];
    }
    mark(i);
  });
  for (let i = 0; i < n; i++) nrows = Math.max(nrows, row[i] + rs[i]);
  return { col, row, cs, rs, ncols, nrows };
}

// The length of `span` tracks from `start` and the gaps between them. Parity with spanExtent in Go.
function spanExtent(sizes: readonly number[], start: number, span: number, gap: number): number {
  let s = 0;
  for (let t = start; t < start + span; t++) s += sizes[t];
  if (span > 1) s += gap * (span - 1);
  return s;
}

// Resolves the n tracks of one axis. Parity with gridTrackSizes in Go.
function gridTrackSizes(defs: readonly GridTrackLite[], n: number, starts: readonly number[], spans: readonly number[], extents: readonly number[], gap: number, inner: number, hug: boolean): number[] {
  const size = new Array<number>(n).fill(0);
  const content = new Array<boolean>(n).fill(false);
  const fr = new Array<number>(n).fill(0);
  for (let t = 0; t < n; t++) {
    const d = t < defs.length ? defs[t] : { kind: "hug" as const, size: 0 };
    if (d.kind === "fixed") size[t] = d.size;
    else if (d.kind === "fr" && !hug) fr[t] = d.size > 0 ? d.size : 1;
    else content[t] = true;
  }
  let maxSpan = 1;
  for (const s of spans) maxSpan = Math.max(maxSpan, s);
  for (let sp = 1; sp <= maxSpan; sp++) {
    for (let j = 0; j < starts.length; j++) {
      if (spans[j] !== sp) continue;
      const grow: number[] = [];
      for (let t = starts[j]; t < starts[j] + sp; t++) if (content[t]) grow.push(t);
      const need = extents[j] - spanExtent(size, starts[j], sp, gap);
      if (need > 0 && grow.length > 0) {
        const each = need / grow.length;
        for (const t of grow) size[t] += each;
      }
    }
  }
  let sumW = 0;
  for (const w of fr) sumW += w;
  if (sumW > 0) {
    const free = inner - spanExtent(size, 0, n, gap);
    for (let t = 0; t < n; t++) if (fr[t] > 0) size[t] = free > 0 ? (free * fr[t]) / sumW : 0;
  }
  return size;
}

export interface GridLimits { w(n: NodeLite, v: number): number; h(n: NodeLite, v: number): number }

// Places `kids` in the cells of the grid (recorded in `placed`) and returns the frame, resized if
// it hugs. Parity with layoutGrid in Go.
export function layoutGrid(kids: readonly NodeLite[], frame: NodeLite, al: AutoLayoutLite, lim: GridLimits, placed: Map<string, NodeLite>): NodeLite {
  const { col, row, cs, rs, ncols, nrows } = gridCells(kids, al);
  const padL = al.paddingLeft, padT = al.paddingTop, padR = al.paddingRight, padB = al.paddingBottom;
  const colGap = al.columnGap ?? 0, rowGap = al.rowGap ?? 0;
  const limW = (n: NodeLite, v: number) => (n.kind === "group" ? v : lim.w(n, v));
  const limH = (n: NodeLite, v: number) => (n.kind === "group" ? v : lim.h(n, v));

  const ws = kids.map((k) => limW(k, k.width)), hs = kids.map((k) => limH(k, k.height));
  const colSizes = gridTrackSizes(al.columns ?? [], ncols, col, cs, ws, colGap, frame.width - padL - padR, al.hugWidth);
  let out = frame;
  if (al.hugWidth) out = { ...out, width: lim.w(frame, padL + spanExtent(colSizes, 0, ncols, colGap) + padR) };
  const rowSizes = gridTrackSizes(al.rows ?? [], nrows, row, rs, hs, rowGap, out.height - padT - padB, al.hugHeight);
  if (al.hugHeight) out = { ...out, height: lim.h(frame, padT + spanExtent(rowSizes, 0, nrows, rowGap) + padB) };

  const colPos: number[] = [], rowPos: number[] = [];
  let pos = padL;
  for (let t = 0; t < ncols; t++) { colPos.push(pos); pos = pos + colSizes[t] + colGap; }
  pos = padT;
  for (let t = 0; t < nrows; t++) { rowPos.push(pos); pos = pos + rowSizes[t] + rowGap; }

  kids.forEach((k, i) => {
    const aw = spanExtent(colSizes, col[i], cs[i], colGap), ah = spanExtent(rowSizes, row[i], rs[i], rowGap);
    let w = ws[i], h = hs[i];
    if (k.kind !== "group" && k.layoutSizingX === "fill") w = limW(k, aw);
    if (k.kind !== "group" && k.layoutSizingY === "fill") h = limH(k, ah);
    let x = colPos[col[i]], y = rowPos[row[i]];
    if (al.mainAlign === "center") x = x + (aw - w) / 2;
    else if (al.mainAlign === "end") x = x + (aw - w);
    if (al.crossAlign === "center") y = y + (ah - h) / 2;
    else if (al.crossAlign === "end") y = y + (ah - h);
    placed.set(k.id, { ...k, x, y, width: w, height: h });
  });
  return out;
}
