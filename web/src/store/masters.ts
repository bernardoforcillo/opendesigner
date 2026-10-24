import { recordDelta } from "./sceneDelta";
import { childrenOf, subtreeOf } from "./tree";
import type { NodeLite, PageLite, SceneState } from "./types";

// MASTER PAGES. A master is a page flagged `isMaster`: a template. Every page that applies it
// (`masterId`) draws the master's nodes BEHIND its own, and the page number token "<#>" in a master's
// text shows that page's number. Nothing is copied into the document: like live booleans and
// variables the result is DERIVED (resolveScene) -- the canvas, the exports and the prototype see
// a scene where each such page also has the master's nodes, flagged `fromMaster` so they cannot be
// picked or selected there. Editing the master page itself updates every page at once.
//
// Rules (parity with core.checkPageMaster / applyUpdatePage / applyDeletePage in Go): a master applies
// no master; `masterId` must name an existing master other than the page itself; a master that pages
// apply cannot be deleted or demoted; the document keeps at least one page that is not a master.

export const PAGE_NUMBER_TOKEN = "<#>";

export const isMasterPage = (p: PageLite | undefined) => p?.isMaster === true;

/** Pages that are not masters, in document order: what "page 1, 2, 3…" counts. */
export const regularPages = (pages: readonly PageLite[], skip = "") => pages.filter((p) => !p.isMaster && p.id !== skip);

export const masterInUse = (pages: readonly PageLite[], id: string) => pages.some((p) => p.masterId === id);

/** Is `masterId` of page `p` valid against `pages` (p itself may not be in the list yet)? */
export function masterFieldsValid(pages: readonly PageLite[], p: PageLite): boolean {
  if (!p.masterId) return true;
  if (p.isMaster) return false;
  const m = pages.find((x) => x.id === p.masterId);
  return !!m && !!m.isMaster && m.id !== p.id;
}

/** Would `updatePage` with `next` be accepted? (null/false = rejected, the scene does not change.) */
export function updatePageAllowed(pages: readonly PageLite[], next: PageLite): boolean {
  const cur = pages.find((p) => p.id === next.id);
  if (!cur || !masterFieldsValid(pages, next)) return false;
  if (cur.isMaster && !next.isMaster && masterInUse(pages, next.id)) return false;
  if (!cur.isMaster && next.isMaster) {
    if (regularPages(pages, next.id).length === 0) return false;
    if (cur.masterId && next.masterId) return false;
  }
  return true;
}

/** Would `deletePage` of `id` be accepted? */
export function deletePageAllowed(pages: readonly PageLite[], id: string): boolean {
  return pages.some((p) => p.id === id) && regularPages(pages, id).length > 0 && !masterInUse(pages, id);
}

/** Canonical page object: default flags are absent, not `false` / "". */
export function pageOf(p: { id: string; name: string; isMaster?: boolean; masterId?: string }): PageLite {
  return { id: p.id, name: p.name, ...(p.isMaster ? { isMaster: true } : {}), ...(p.masterId ? { masterId: p.masterId } : {}) };
}

// The id of the copy of master node `nodeId` on page `pageId`. The `~` cannot appear in a uuid.
export const masterCopyId = (pageId: string, nodeId: string) => `${pageId}~${nodeId}`;

// Lower than any real order key, so the master's top-level nodes sit behind the page's own.
const BEHIND = "\u0000";

const derived = new WeakMap<SceneState, SceneState>();

/** `scene` plus, on each page that applies a master, a flagged copy of the master's nodes; `scene` itself when none does. */
export function deriveMasters(scene: SceneState): SceneState {
  const hit = derived.get(scene);
  if (hit) return hit;
  const users = scene.pages.filter((p) => p.masterId && !p.isMaster);
  if (users.length === 0) { derived.set(scene, scene); return scene; }

  const regular = regularPages(scene.pages);
  let edit: ReturnType<SceneState["nodes"]["edit"]> | null = null;
  const changed: string[] = [];
  for (const page of users) {
    const master = scene.pages.find((p) => p.id === page.masterId && p.isMaster);
    if (!master) continue;
    const number = String(regular.findIndex((p) => p.id === page.id) + 1);
    for (const root of childrenOf(scene, master.id)) {
      for (const n of subtreeOf(scene, root.id)) {
        const top = n.parentId === master.id;
        const copy: NodeLite = {
          ...n,
          id: masterCopyId(page.id, n.id),
          parentId: top ? page.id : masterCopyId(page.id, n.parentId),
          orderKey: top ? BEHIND + n.orderKey : n.orderKey,
          fromMaster: true,
          ...(n.text && n.text.content.includes(PAGE_NUMBER_TOKEN)
            ? { text: { ...n.text, content: n.text.content.split(PAGE_NUMBER_TOKEN).join(number) } }
            : {}),
        };
        (edit ??= scene.nodes.edit()).set(copy.id, copy);
        changed.push(copy.id);
      }
    }
  }
  if (!edit) { derived.set(scene, scene); return scene; }
  const out: SceneState = { ...scene, nodes: edit.done() };
  recordDelta(out, scene, changed);
  derived.set(scene, out);
  return out;
}
