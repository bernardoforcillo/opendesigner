import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";
import { orderKeyBetween } from "@/store/orderKey";
import { childrenOf } from "@/store/tree";
import { toPbNode, type NodeLite, type SceneState, type TableStyleLite, type TextStyleLite } from "@/store/types";
import { applyObjectStyleOps } from "@/tools/objectStyles";
import { applyStyleOps } from "@/ui/typographyOps";
import { makeCreateNodeOp, makeDeleteOp, makeSetPropsOp, makeSetTextOp, uuid } from "@/tools/ops";

// TABLES. A table is a GROUP of cells -- no new kind of node: each cell is a rectangle (the box, fill and
// borders) with a text over it (the content), both tagged with their row and column. The group's meta
// holds the grid: `table.cols` and `table.rows` are the column widths and row heights, comma-separated,
// and `table.head` how many rows at the top are the header. Everything about a cell is an ordinary node:
// type in the text, set the rectangle's fill and stroke, or restyle a whole row by selecting its nodes.
// Adding and removing rows and columns, and resizing them, re-lay the grid out (one gesture, one undo).
//
// SPANNING: merged cells are one cell that covers several grid positions. The cell at the top-left of the area keeps its
// rectangle and its text, both grown over the area and tagged `table.span` = "rows,cols"; the nodes of the other positions
// are gone, so a position with no cell of its own is covered by the span that includes it. Merging joins the texts of the
// cells it absorbs; splitting gives the covered positions back empty cells. Adding or removing rows and columns keeps spans
// consistent (a row inserted inside a span lengthens it, one removed from it shortens it, and a span whose first row or
// column is removed is dropped, leaving empty cells). See docs/text-frames.md.

export const META_TABLE_COLS = "table.cols";
export const META_TABLE_ROWS = "table.rows";
export const META_TABLE_HEAD = "table.head";
export const META_TABLE_CELL = "table.cell"; // on the cell's rectangle: "row,col"
export const META_TABLE_TEXT = "table.text"; // on the cell's text: "row,col"
export const META_TABLE_SPAN = "table.span"; // on both of a merged cell's nodes: "rows,cols" (absent = 1,1)

const PAD_X = 6, PAD_Y = 4;
export const MAX_TABLE_SIDE = 100;
export const MIN_CELL = 8;

export interface Table {
  group: NodeLite;
  cols: number[]; rows: number[]; head: number;
  /** Where the top-left cell is, in the group's parent space. */
  x: number; y: number;
  cells: Map<string, { rect?: NodeLite; text?: NodeLite }>;
}

const key = (r: number, c: number) => `${r},${c}`;
const nums = (s: string | undefined) => (s ?? "").split(",").map(Number).filter((n) => Number.isFinite(n) && n >= MIN_CELL);

/** The table group that `id` is, or sits inside; null otherwise. */
export function tableIdOf(scene: SceneState, id: string): string | null {
  for (let cur = scene.nodes.get(id), i = 0; cur && i < 1000; cur = scene.nodes.get(cur.parentId), i++) {
    if (cur.kind === "group" && cur.meta?.[META_TABLE_COLS] !== undefined) return cur.id;
  }
  return null;
}

/** The cell `id` is the rectangle or the text of, as [row, col]. */
export function cellOf(scene: SceneState, id: string): [number, number] | null {
  const n = scene.nodes.get(id);
  const v = n?.meta?.[META_TABLE_CELL] ?? n?.meta?.[META_TABLE_TEXT];
  if (!v) return null;
  const [r, c] = v.split(",").map(Number);
  return Number.isInteger(r) && Number.isInteger(c) ? [r, c] : null;
}

export function readTable(scene: SceneState, groupId: string): Table | null {
  const group = scene.nodes.get(groupId);
  if (!group || group.kind !== "group" || group.meta?.[META_TABLE_COLS] === undefined) return null;
  const cols = nums(group.meta[META_TABLE_COLS]), rows = nums(group.meta[META_TABLE_ROWS]);
  if (cols.length === 0 || rows.length === 0) return null;
  const cells = new Map<string, { rect?: NodeLite; text?: NodeLite }>();
  for (const n of childrenOf(scene, groupId)) {
    const rect = n.meta?.[META_TABLE_CELL], text = n.meta?.[META_TABLE_TEXT];
    if (rect) cells.set(rect, { ...cells.get(rect), rect: n });
    else if (text) cells.set(text, { ...cells.get(text), text: n });
  }
  const origin = cells.get(key(0, 0))?.rect;
  return { group, cols, rows, head: Number(group.meta[META_TABLE_HEAD]) || 0, x: origin?.x ?? 0, y: origin?.y ?? 0, cells };
}

const sum = (a: readonly number[], to: number) => a.slice(0, to).reduce((s, n) => s + n, 0);
/** The extent of positions [from, from + count) in `sizes`. */
const extent = (sizes: readonly number[], from: number, count: number) => sizes.slice(from, from + count).reduce((s, n) => s + n, 0);

/** How many rows and columns the cell covers: [1, 1] for an ordinary one. */
export function spanOf(cell: { rect?: NodeLite; text?: NodeLite } | undefined): [number, number] {
  const v = cell?.rect?.meta?.[META_TABLE_SPAN] ?? cell?.text?.meta?.[META_TABLE_SPAN];
  if (!v) return [1, 1];
  const [rs, cs] = v.split(",").map(Number);
  return Number.isInteger(rs) && Number.isInteger(cs) && rs >= 1 && cs >= 1 ? [rs, cs] : [1, 1];
}

/** Every position some cell covers, mapped to the position of the cell (its top-left). */
export function coverage(t: Table): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, cell] of t.cells) {
    const [r, c] = k.split(",").map(Number);
    const [rs, cs] = spanOf(cell);
    for (let i = r; i < Math.min(r + rs, t.rows.length); i++) for (let j = c; j < Math.min(c + cs, t.cols.length); j++) out.set(key(i, j), k);
  }
  return out;
}
const TEXT_STYLE: TextStyleLite = { fontFamily: "", fontSize: 14, fontWeight: "", lineHeight: 1.3, align: "left" };

function cellNodes(parentId: string, t: { x: number; y: number; cols: number[]; rows: number[]; head: number }, r: number, c: number, keys: [string, string]): [NodeLite, NodeLite] {
  const x = t.x + sum(t.cols, c), y = t.y + sum(t.rows, r), w = t.cols[c], h = t.rows[r];
  const header = r < t.head;
  const rect: NodeLite = {
    id: uuid(), parentId, orderKey: keys[0], name: `Cell ${r + 1},${c + 1}`, visible: true, opacity: 1, x, y, width: w, height: h, rotation: 0,
    fills: [header ? { r: 0.93, g: 0.94, b: 0.96, a: 1 } : { r: 1, g: 1, b: 1, a: 1 }],
    strokes: [{ color: { r: 0.72, g: 0.74, b: 0.78, a: 1 }, weight: 1, align: "inside" }],
    kind: "rect", cornerRadius: 0, clipsContent: false, meta: { [META_TABLE_CELL]: key(r, c) },
  };
  const text: NodeLite = {
    id: uuid(), parentId, orderKey: keys[1], name: `Text ${r + 1},${c + 1}`, visible: true, opacity: 1, x: x + PAD_X, y: y + PAD_Y, width: Math.max(1, w - 2 * PAD_X), height: Math.max(1, h - 2 * PAD_Y), rotation: 0,
    fills: [{ r: 0.07, g: 0.09, b: 0.15, a: 1 }], strokes: [], kind: "text", cornerRadius: 0, clipsContent: false, meta: { [META_TABLE_TEXT]: key(r, c) },
    text: { content: "", style: header ? { ...TEXT_STYLE, fontWeight: "700" } : TEXT_STYLE },
  };
  return [rect, text];
}

export interface NewTable { ops: Op[]; selection: string[] }

/** A rows x cols table of equal cells with its top-left corner at (x, y) under `parentId`; the first `head` rows are the header. */
export function createTableOps(scene: SceneState, parentId: string, x: number, y: number, rows: number, cols: number, cellW = 120, cellH = 36, head = 1): NewTable | null {
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1 || rows > MAX_TABLE_SIDE || cols > MAX_TABLE_SIDE || !(cellW >= MIN_CELL) || !(cellH >= MIN_CELL)) return null;
  const top = childrenOf(scene, parentId).at(-1)?.orderKey ?? null;
  const groupId = uuid();
  const group: NodeLite = {
    id: groupId, parentId, orderKey: orderKeyBetween(top, null), name: "Table", visible: true, opacity: 1, x: 0, y: 0, width: 0, height: 0, rotation: 0,
    fills: [], strokes: [], kind: "group", cornerRadius: 0, clipsContent: false,
    meta: { [META_TABLE_COLS]: Array(cols).fill(cellW).join(","), [META_TABLE_ROWS]: Array(rows).fill(cellH).join(","), ...(head > 0 ? { [META_TABLE_HEAD]: String(Math.min(head, rows)) } : {}) },
  };
  const ops: Op[] = [makeCreateNodeOp(toPbNode(group))];
  const grid = { x, y, cols: Array<number>(cols).fill(cellW), rows: Array<number>(rows).fill(cellH), head: Math.min(head, rows) };
  let prev: string | null = null;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const k1 = orderKeyBetween(prev, null), k2 = orderKeyBetween(k1, null);
      prev = k2;
      for (const n of cellNodes(groupId, grid, r, c, [k1, k2])) ops.push(makeCreateNodeOp(toPbNode(n)));
    }
  }
  return { ops, selection: [groupId] };
}

// Re-lays the grid out: cell (r, c) moves to (rowMap(r), colMap(c)) -- or goes, when the map says null --
// the grid gets its new sizes, and cells that no surviving one covers are created.
function restructure(
  scene: SceneState, t: Table, rowMap: (r: number) => number | null, colMap: (c: number) => number | null, rows: number[], cols: number[], head = t.head,
): Op[] {
  const ops: Op[] = [];
  const covered = new Set<string>();
  const grid = { x: t.x, y: t.y, cols, rows, head };
  for (const [k, cell] of t.cells) {
    const [r, c] = k.split(",").map(Number);
    const nr = rowMap(r), nc = colMap(c);
    // A merged cell: the rows and columns of its area that survive, and where they end up. It stays a cell as long as
    // its own first row and column survive; the area is the stretch from there to the last surviving one.
    const [rs, cs] = spanOf(cell);
    let nrs = 1, ncs = 1;
    if (nr !== null && nc !== null) {
      let lastR = nr, lastC = nc;
      for (let i = r; i < r + rs; i++) { const m = rowMap(i); if (m !== null) lastR = Math.max(lastR, m); }
      for (let j = c; j < c + cs; j++) { const m = colMap(j); if (m !== null) lastC = Math.max(lastC, m); }
      nrs = lastR - nr + 1;
      ncs = lastC - nc + 1;
    }
    for (const n of [cell.rect, cell.text]) {
      if (!n) continue;
      if (nr === null || nc === null) { ops.push(makeDeleteOp(n.id)); continue; }
      const isText = n === cell.text;
      const x = t.x + sum(cols, nc) + (isText ? PAD_X : 0), y = t.y + sum(rows, nr) + (isText ? PAD_Y : 0);
      const w = Math.max(1, extent(cols, nc, ncs) - (isText ? 2 * PAD_X : 0)), h = Math.max(1, extent(rows, nr, nrs) - (isText ? 2 * PAD_Y : 0));
      const moved = x !== n.x || y !== n.y || w !== n.width || h !== n.height;
      const relabel = nr !== r || nc !== c;
      const respan = nrs !== rs || ncs !== cs;
      if (moved) ops.push(makeSetPropsOp(n.id, { x, y, width: w, height: h }, ["x", "y", "width", "height"]));
      if (relabel || respan) {
        const meta = { ...n.meta, [isText ? META_TABLE_TEXT : META_TABLE_CELL]: key(nr, nc) };
        if (nrs > 1 || ncs > 1) meta[META_TABLE_SPAN] = `${nrs},${ncs}`;
        else delete meta[META_TABLE_SPAN];
        ops.push(makeSetPropsOp(n.id, { meta }, ["meta"]));
      }
    }
    if (nr !== null && nc !== null) for (let i = nr; i < nr + nrs; i++) for (let j = nc; j < nc + ncs; j++) covered.add(key(i, j));
  }
  let prev = childrenOf(scene, t.group.id).at(-1)?.orderKey ?? null;
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < cols.length; c++) {
      if (covered.has(key(r, c))) continue;
      const k1 = orderKeyBetween(prev, null), k2 = orderKeyBetween(k1, null);
      prev = k2;
      for (const n of cellNodes(t.group.id, grid, r, c, [k1, k2])) ops.push(makeCreateNodeOp(toPbNode(n)));
    }
  }
  const meta = { ...t.group.meta, [META_TABLE_COLS]: cols.join(","), [META_TABLE_ROWS]: rows.join(","), ...(head > 0 ? { [META_TABLE_HEAD]: String(head) } : {}) };
  if (head === 0) delete meta[META_TABLE_HEAD];
  ops.push(makeSetPropsOp(t.group.id, { meta }, ["meta"]));
  return ops;
}

const splice = <T,>(a: readonly T[], at: number, del: number, ...ins: T[]) => [...a.slice(0, at), ...ins, ...a.slice(at + del)];

/** A new row after row `r` (-1 = before the first), as tall as row `r` (the first row when -1). */
export function addRowOps(scene: SceneState, tableId: string, r: number): Op[] {
  const t = readTable(scene, tableId);
  if (!t || t.rows.length >= MAX_TABLE_SIDE || r < -1 || r >= t.rows.length) return [];
  return restructure(scene, t, (o) => (o <= r ? o : o + 1), (c) => c, splice(t.rows, r + 1, 0, t.rows[Math.max(r, 0)]), t.cols, r < t.head ? t.head + 1 : t.head);
}

/** A new column after column `c` (-1 = before the first), as wide as column `c`. */
export function addColumnOps(scene: SceneState, tableId: string, c: number): Op[] {
  const t = readTable(scene, tableId);
  if (!t || t.cols.length >= MAX_TABLE_SIDE || c < -1 || c >= t.cols.length) return [];
  return restructure(scene, t, (r) => r, (o) => (o <= c ? o : o + 1), t.rows, splice(t.cols, c + 1, 0, t.cols[Math.max(c, 0)]));
}

/** Removes row `r`; the last row cannot be removed. */
export function deleteRowOps(scene: SceneState, tableId: string, r: number): Op[] {
  const t = readTable(scene, tableId);
  if (!t || t.rows.length <= 1 || r < 0 || r >= t.rows.length) return [];
  return restructure(scene, t, (o) => (o === r ? null : o < r ? o : o - 1), (c) => c, splice(t.rows, r, 1), t.cols, r < t.head ? t.head - 1 : t.head);
}

/** Removes column `c`; the last column cannot be removed. */
export function deleteColumnOps(scene: SceneState, tableId: string, c: number): Op[] {
  const t = readTable(scene, tableId);
  if (!t || t.cols.length <= 1 || c < 0 || c >= t.cols.length) return [];
  return restructure(scene, t, (r) => r, (o) => (o === c ? null : o < c ? o : o - 1), t.rows, splice(t.cols, c, 1));
}

/** Sets the width of column `c` or the height of row `r`. */
export function resizeTableOps(scene: SceneState, tableId: string, axis: "col" | "row", index: number, size: number): Op[] {
  const t = readTable(scene, tableId);
  if (!t || !(size >= MIN_CELL)) return [];
  const list = axis === "col" ? t.cols : t.rows;
  if (index < 0 || index >= list.length || list[index] === size) return [];
  const next = splice(list, index, 1, size);
  return restructure(scene, t, (r) => r, (c) => c, axis === "row" ? next : t.rows, axis === "col" ? next : t.cols);
}

/** The table style a table was last given (`meta["table.style"]`), if it still exists. */
export const META_TABLE_STYLE = "table.style";

/**
 * Gives the table `tableId` the table style `style`: its header rows, body rows and every second body row take the
 * style's object styles (on the cell rectangles) and text styles (on the cell texts). A part the style leaves
 * empty is not touched. The table remembers the style (`table.style`), so it can be re-applied after rows are added.
 */
export function applyTableStyleOps(scene: SceneState, tableId: string, style: TableStyleLite): Op[] {
  const t = readTable(scene, tableId);
  if (!t) return [];
  const rects: Map<string, string[]> = new Map(), texts: Map<string, string[]> = new Map();
  const push = (m: Map<string, string[]>, styleId: string | undefined, id: string) => { if (styleId) m.set(styleId, [...(m.get(styleId) ?? []), id]); };
  for (let r = 0; r < t.rows.length; r++) {
    const header = r < t.head, alt = !header && (r - t.head) % 2 === 1;
    const objId = header ? style.headerObjectStyleId : alt ? style.altObjectStyleId || style.bodyObjectStyleId : style.bodyObjectStyleId;
    const txtId = header ? style.headerTextStyleId : style.bodyTextStyleId;
    for (let c = 0; c < t.cols.length; c++) {
      const cell = t.cells.get(key(r, c));
      if (cell?.rect) push(rects, objId, cell.rect.id);
      if (cell?.text) push(texts, txtId, cell.text.id);
    }
  }
  const ops: Op[] = [];
  for (const [styleId, ids] of rects) ops.push(...applyObjectStyleOps(scene, ids, styleId));
  for (const [styleId, ids] of texts) ops.push(...applyStyleOps(scene, ids, styleId));
  if (t.group.meta?.[META_TABLE_STYLE] !== style.id) ops.push(makeSetPropsOp(t.group.id, { meta: { ...(t.group.meta ?? {}), [META_TABLE_STYLE]: style.id } }, ["meta"]));
  return ops;
}

// ---------- merging and splitting cells ----------

export interface CellRange { tableId: string; r0: number; c0: number; r1: number; c1: number }

/** The cells the selected nodes are in, as the smallest block of the one table that holds them all; null if they are in different tables or not cells. */
export function selectionCellRange(scene: SceneState, selection: readonly string[]): CellRange | null {
  let tableId: string | null = null;
  let r0 = Infinity, c0 = Infinity, r1 = -Infinity, c1 = -Infinity;
  for (const id of selection) {
    const tid = tableIdOf(scene, id), cell = cellOf(scene, id);
    if (!tid || !cell || (tableId !== null && tid !== tableId)) return null;
    tableId = tid;
    const t = readTable(scene, tid);
    const [rs, cs] = spanOf(t?.cells.get(key(cell[0], cell[1])));
    r0 = Math.min(r0, cell[0]); c0 = Math.min(c0, cell[1]);
    r1 = Math.max(r1, cell[0] + rs - 1); c1 = Math.max(c1, cell[1] + cs - 1);
  }
  return tableId === null ? null : { tableId, r0, c0, r1, c1 };
}

/**
 * Merges the block of cells into one. The top-left cell grows over the block and takes the texts of the others (the
 * non-empty ones, one per line); the others go. Refused ([]) when the block is a single position, falls outside the
 * table, or would cut through a merged cell that sticks out of it.
 */
export function mergeCellsOps(scene: SceneState, range: CellRange): Op[] {
  const t = readTable(scene, range.tableId);
  if (!t) return [];
  const { r0, c0, r1, c1 } = range;
  if (r0 < 0 || c0 < 0 || r1 >= t.rows.length || c1 >= t.cols.length || r1 < r0 || c1 < c0 || (r0 === r1 && c0 === c1)) return [];
  const cover = coverage(t);
  const inside = (k: string) => { const [r, c] = k.split(",").map(Number); return r >= r0 && r <= r1 && c >= c0 && c <= c1; };
  const absorbed: string[] = [];
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const owner = cover.get(key(r, c));
      if (owner === undefined || !inside(owner)) return []; // a merged cell from outside reaches in
      if (owner !== key(r0, c0) && !absorbed.includes(owner)) absorbed.push(owner);
    }
  }
  // ... and none of the cells in the block may reach out of it.
  for (const k of [key(r0, c0), ...absorbed]) {
    const [r, c] = k.split(",").map(Number);
    const [rs, cs] = spanOf(t.cells.get(k));
    if (r + rs - 1 > r1 || c + cs - 1 > c1) return [];
  }
  const anchor = t.cells.get(key(r0, c0));
  if (!anchor?.rect) return [];
  const ops: Op[] = [];
  const texts: string[] = [];
  if (anchor.text?.text?.content) texts.push(anchor.text.text.content);
  for (const k of absorbed) {
    const cell = t.cells.get(k);
    if (cell?.text?.text?.content) texts.push(cell.text.text.content);
    for (const n of [cell?.rect, cell?.text]) if (n) ops.push(makeDeleteOp(n.id));
  }
  const rs = r1 - r0 + 1, cs = c1 - c0 + 1;
  const span = { [META_TABLE_SPAN]: `${rs},${cs}` };
  const x = t.x + sum(t.cols, c0), y = t.y + sum(t.rows, r0), w = extent(t.cols, c0, cs), h = extent(t.rows, r0, rs);
  ops.push(makeSetPropsOp(anchor.rect.id, { width: w, height: h, meta: { ...anchor.rect.meta, ...span } }, ["width", "height", "meta"]));
  if (anchor.text) {
    ops.push(makeSetPropsOp(anchor.text.id, { x: x + PAD_X, y: y + PAD_Y, width: Math.max(1, w - 2 * PAD_X), height: Math.max(1, h - 2 * PAD_Y), meta: { ...anchor.text.meta, ...span } }, ["x", "y", "width", "height", "meta"]));
    if (texts.length > 1 && anchor.text.text) ops.push(makeSetTextOp(anchor.text.id, texts.join("\n"), anchor.text.text.style));
  }
  return ops;
}

/** Splits the merged cell at [r, c] back into single cells; the covered positions get empty cells. [] for a cell that is not merged. */
export function splitCellOps(scene: SceneState, tableId: string, r: number, c: number): Op[] {
  const t = readTable(scene, tableId);
  const cell = t?.cells.get(key(r, c));
  if (!t || !cell?.rect) return [];
  const [rs, cs] = spanOf(cell);
  if (rs === 1 && cs === 1) return [];
  const ops: Op[] = [];
  const x = t.x + sum(t.cols, c), y = t.y + sum(t.rows, r), w = t.cols[c], h = t.rows[r];
  const plain = (m: Record<string, string> | undefined) => { const meta = { ...m }; delete meta[META_TABLE_SPAN]; return meta; };
  ops.push(makeSetPropsOp(cell.rect.id, { width: w, height: h, meta: plain(cell.rect.meta) }, ["width", "height", "meta"]));
  if (cell.text) ops.push(makeSetPropsOp(cell.text.id, { x: x + PAD_X, y: y + PAD_Y, width: Math.max(1, w - 2 * PAD_X), height: Math.max(1, h - 2 * PAD_Y), meta: plain(cell.text.meta) }, ["x", "y", "width", "height", "meta"]));
  let prev = childrenOf(scene, t.group.id).at(-1)?.orderKey ?? null;
  const grid = { x: t.x, y: t.y, cols: t.cols, rows: t.rows, head: t.head };
  for (let i = r; i < r + rs; i++) {
    for (let j = c; j < c + cs; j++) {
      if (i === r && j === c) continue;
      const k1 = orderKeyBetween(prev, null), k2 = orderKeyBetween(k1, null);
      prev = k2;
      for (const n of cellNodes(t.group.id, grid, i, j, [k1, k2])) ops.push(makeCreateNodeOp(toPbNode(n)));
    }
  }
  return ops;
}
