import type { Comment as PbComment } from "../gen/opendesigner/v1/opendesigner_pb";
import type { SceneState } from "./types";

// COMMENTS: the TypeScript twin of internal/core/comments.go. Go is the authority; every
// rule here repeats one there, and testdata/golden/comments.json runs both sides.

export const MAX_COMMENT_RUNES = 4000;
export const MAX_COMMENT_AUTHOR_RUNES = 80;

const runes = (s: string) => [...s].length;

/** Parity with core.validateComment. */
export function isValidComment(state: SceneState, c: PbComment | undefined): c is PbComment {
  if (!c || c.id === "") return false;
  const n = runes(c.text);
  if (n === 0 || n > MAX_COMMENT_RUNES) return false;
  if (runes(c.author) > MAX_COMMENT_AUTHOR_RUNES) return false;
  if (c.createdAt < 0n) return false;
  const prev = state.comments[c.id];
  if (prev && prev.parentId !== c.parentId) return false;
  if (c.parentId !== "") {
    if (c.parentId === c.id) return false;
    const root = state.comments[c.parentId];
    if (!root || root.parentId !== "") return false;
    return c.nodeId === "" && c.pageId === "" && c.x === 0 && c.y === 0 && !c.resolved;
  }
  if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) return false;
  if (c.nodeId !== "") return state.nodes.has(c.nodeId) && c.pageId === "";
  return state.pages.some((p) => p.id === c.pageId);
}

/** The comments without the thread of `id` (a root takes its replies with it). Parity with core.applyDeleteComment. */
export function withoutComment(state: SceneState, id: string): SceneState["comments"] {
  const c = state.comments[id];
  const out: SceneState["comments"] = {};
  for (const [k, v] of Object.entries(state.comments)) {
    if (k === id) continue;
    if (c && c.parentId === "" && v.parentId === id) continue;
    out[k] = v;
  }
  return out;
}

/** The threads of a page: roots with their replies (oldest first), newest thread first. */
export function threadsOf(
  state: SceneState,
  pageId: string,
): { root: SceneState["comments"][string]; replies: SceneState["comments"][string][]; orphan: boolean }[] {
  const all = Object.values(state.comments);
  const pageOf = (nodeId: string): string => {
    let cur = state.nodes.get(nodeId);
    for (let guard = 0; cur && guard < 10000; guard++) {
      if (state.pages.some((p) => p.id === cur!.parentId)) return cur.parentId;
      cur = state.nodes.get(cur.parentId);
    }
    return "";
  };
  return all
    .filter((c) => c.parentId === "")
    .map((root) => {
      const orphan = root.nodeId !== "" && !state.nodes.has(root.nodeId);
      return { root, orphan, page: orphan ? "" : root.nodeId !== "" ? pageOf(root.nodeId) : root.pageId };
    })
    .filter((t) => t.orphan || t.page === pageId)
    .map(({ root, orphan }) => ({
      root, orphan,
      replies: all.filter((r) => r.parentId === root.id).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
    }))
    .sort((a, b) => b.root.createdAt - a.root.createdAt || a.root.id.localeCompare(b.root.id));
}
