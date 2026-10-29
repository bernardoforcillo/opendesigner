import { withMeta } from "@/flow/meta";
import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";
import { makeSetPropsOp } from "@/tools/ops";
import { META_NEXT } from "@/store/threads";
import { recordDelta } from "@/store/sceneDelta";
import type { NodeLite, SceneState } from "@/store/types";

// COLUMNS IN ONE TEXT FRAME. `meta["text.columns"] = "3"` sets a frame's text in three columns of equal width
// with `meta["text.gutter"]` between them (default 12). Nothing else is stored: like threads and master pages
// the columns are DERIVED (resolveScene). The frame becomes a chain of N frames of one column's width, side by
// side inside the frame's box -- the first one is the frame itself, narrowed, the others are synthetic nodes
// (`<id>#c2` ...) that exist only in the derived scene -- and store/threads.ts flows the story through them, so
// plain and formatted text, keep rules and the overset flag all work as in a threaded chain. A frame that is
// itself the follower of another (a link points at it) ignores its columns; if it links on to a further frame,
// the story continues from its last column.

export const META_COLUMNS = "text.columns";
export const META_GUTTER = "text.gutter";
export const MAX_COLUMNS = 8;
const DEFAULT_GUTTER = 12;

/** The number of columns of a frame (1 when not set or invalid). */
export function columnsOf(n: NodeLite): number {
  const v = Math.floor(Number(n.meta?.[META_COLUMNS]));
  return Number.isFinite(v) && v >= 2 ? Math.min(v, MAX_COLUMNS) : 1;
}

export function gutterOf(n: NodeLite): number {
  const v = Number(n.meta?.[META_GUTTER]);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_GUTTER;
}

/** The width of one column, or 0 when the gutters leave no room. */
export function columnWidth(n: NodeLite): number {
  const c = columnsOf(n);
  return Math.max(0, (n.width - (c - 1) * gutterOf(n)) / c);
}

export const columnId = (id: string, i: number): string => `${id}#c${i + 1}`;

const derived = new WeakMap<SceneState, SceneState>();

/** `scene` with each multi-column frame turned into a chain of column frames; `scene` itself when there are none. */
export function deriveColumns(scene: SceneState): SceneState {
  const hit = derived.get(scene);
  if (hit) return hit;
  let edit: ReturnType<SceneState["nodes"]["edit"]> | null = null;
  const changed: string[] = [];
  let targets: Set<string> | null = null;
  for (const n of scene.nodes.values()) {
    if (n.kind !== "text" || !n.text || n.meta?.[META_COLUMNS] === undefined) continue;
    const cols = columnsOf(n);
    if (cols < 2) continue;
    targets ??= new Set([...scene.nodes.values()].map((m) => m.meta?.[META_NEXT]).filter((x): x is string => !!x));
    if (targets.has(n.id)) continue;
    const w = columnWidth(n), step = w + gutterOf(n);
    if (!(w > 0)) continue;
    const after = n.meta?.[META_NEXT];
    (edit ??= scene.nodes.edit()).set(n.id, { ...n, width: w, meta: withMeta(n, META_NEXT, columnId(n.id, 1)) });
    changed.push(n.id);
    for (let i = 1; i < cols; i++) {
      const id = columnId(n.id, i);
      const meta: Record<string, string> = {};
      if (i < cols - 1) meta[META_NEXT] = columnId(n.id, i + 1);
      else if (after) meta[META_NEXT] = after;
      edit.set(id, {
        ...n, id, name: `${n.name} (column ${i + 1})`, x: n.x + i * step, width: w,
        orderKey: n.orderKey + "~" + i, text: { content: "", style: n.text.style },
        meta: Object.keys(meta).length > 0 ? meta : undefined,
      });
      changed.push(id);
    }
  }
  if (!edit) { derived.set(scene, scene); return scene; }
  const out: SceneState = { ...scene, nodes: edit.done() };
  recordDelta(out, scene, changed);
  derived.set(scene, out);
  return out;
}

/** Ops that set a frame's columns (1 removes them) and gutter. */
export function setColumnsOps(n: NodeLite, columns: number, gutter?: number): Op[] {
  let meta = withMeta(n, META_COLUMNS, columns >= 2 ? String(Math.min(MAX_COLUMNS, Math.floor(columns))) : "");
  if (gutter !== undefined) meta = withMeta({ ...n, meta }, META_GUTTER, String(Math.max(0, gutter)));
  return [makeSetPropsOp(n.id, { meta }, ["meta"])];
}
