import { isValidPageSetup } from "@/store/docSettings";
import { isRightPage, pageNumbers } from "@/store/pageNumbers";
import { runningHeads, substituteVariables } from "@/store/textTokens";
import { recordDelta } from "@/store/sceneDelta";
import { childrenOf, subtreeOf } from "@/store/tree";
import { toPageLite, type GuideLite, type NodeLite, type PageLite, type SceneState } from "@/store/types";

// MASTER PAGES. A master is a page flagged `isMaster`: a template. Every page that applies it
// (`masterId`) draws the master's nodes BEHIND its own, and the page number token "<#>" in a master's
// text shows that page's number. Nothing is copied into the document: like live booleans and
// variables the result is DERIVED (resolveScene) -- the canvas, the exports and the prototype see
// a scene where each such page also has the master's nodes, flagged `fromMaster` so they cannot be
// picked or selected there. Editing the master page itself updates every page at once.
//
// Rules (parity with core.checkPageMaster / applyUpdatePage / applyDeletePage in Go): `masterId` (and
// `leftMasterId`, the master of the left-hand pages of a spread, regular pages only) must name an existing
// master other than the page itself; a master may be based on another master (a chain of at most
// MAX_MASTER_CHAIN, no cycles) and draws it behind its own items; a master that pages or masters apply
// cannot be deleted or demoted; the document keeps at least one page that is not a master. A page can hide
// individual master items (`hiddenMasterItems`): that is how an item is "overridden" on a page.

export const MAX_MASTER_CHAIN = 4;

export const PAGE_NUMBER_TOKEN = "<#>";

export const isMasterPage = (p: PageLite | undefined) => p?.isMaster === true;

/** Pages that are not masters, in document order: what "page 1, 2, 3…" counts. */
export const regularPages = (pages: readonly PageLite[], skip = "") => pages.filter((p) => !p.isMaster && p.id !== skip);

export const masterInUse = (pages: readonly PageLite[], id: string) => pages.some((p) => p.masterId === id || p.leftMasterId === id);

/** Are the master fields (`masterId`, `leftMasterId`) of page `p` valid against `pages` (p itself may not be in the list yet)? */
export function masterFieldsValid(pages: readonly PageLite[], p: PageLite): boolean {
  const byId = new Map(pages.map((x) => [x.id, x] as const));
  if (p.leftMasterId) {
    const l = byId.get(p.leftMasterId);
    if (p.isMaster || !l || !l.isMaster || l.id === p.id) return false;
  }
  let cur = p.masterId;
  for (let depth = 0; cur; depth++) {
    if (cur === p.id || depth >= MAX_MASTER_CHAIN) return false;
    const m = byId.get(cur);
    if (!m || !m.isMaster) return false;
    cur = m.masterId;
  }
  return true;
}

/** Would `updatePage` with `next` be accepted? (null/false = rejected, the scene does not change.) */
export function updatePageAllowed(pages: readonly PageLite[], next: PageLite): boolean {
  const cur = pages.find((p) => p.id === next.id);
  if (!cur || !masterFieldsValid(pages, next) || !isValidPageSetup(next)) return false;
  if (cur.isMaster && !next.isMaster && masterInUse(pages, next.id)) return false;
  if (!cur.isMaster && next.isMaster) {
    if (regularPages(pages, next.id).length === 0) return false;
    if (next.leftMasterId) return false;
  }
  return true;
}

/** Would `deletePage` of `id` be accepted? */
export function deletePageAllowed(pages: readonly PageLite[], id: string): boolean {
  return pages.some((p) => p.id === id) && regularPages(pages, id).length > 0 && !masterInUse(pages, id);
}

/** Canonical page object: default flags are absent, not `false` / "". */
export function pageOf(p: { id: string; name: string; numberStyle?: string } & Partial<Omit<PageLite, "id" | "name" | "numberStyle">>): PageLite {
  return toPageLite({
    id: p.id, name: p.name, isMaster: p.isMaster === true, masterId: p.masterId ?? "",
    width: p.width ?? 0, height: p.height ?? 0, marginTop: p.marginTop ?? 0, marginRight: p.marginRight ?? 0,
    marginBottom: p.marginBottom ?? 0, marginLeft: p.marginLeft ?? 0, columns: p.columns ?? 0, gutter: p.gutter ?? 0, bleed: p.bleed ?? 0,
    sectionStart: p.sectionStart, numberStart: p.numberStart, numberStyle: p.numberStyle, leftMasterId: p.leftMasterId,
    hiddenMasterItems: p.hiddenMasterItems, slug: p.slug, guides: p.guides,
  });
}

// The id of the copy of master node `nodeId` on page `pageId`. The `~` cannot appear in a uuid.
export const masterCopyId = (pageId: string, nodeId: string) => `${pageId}~${nodeId}`;

// Lower than any real order key, so the master's top-level nodes sit behind the page's own.
const BEHIND = "\u0000";

const derived = new WeakMap<SceneState, SceneState>();

/** The masters a page draws, back to front: the base of the chain first, the page's own master last. */
export function masterChain(pages: readonly PageLite[], masterId: string): PageLite[] {
  const out: PageLite[] = [];
  for (let cur = masterId, depth = 0; cur && depth < MAX_MASTER_CHAIN; depth++) {
    const m = pages.find((p) => p.id === cur && p.isMaster);
    if (!m) break;
    out.unshift(m);
    cur = m.masterId ?? "";
  }
  return out;
}

/** The master applied to `page`: its left-hand master on a left-hand page of a spread, else its master. */
export function masterOfPage(scene: Pick<SceneState, "pages" | "settings">, page: PageLite, numbers = pageNumbers(scene.pages)): string {
  if (scene.settings?.facingPages && page.leftMasterId && !isRightPage(numbers.get(page.id))) return page.leftMasterId;
  return page.masterId ?? "";
}

/** Is the page a left-hand page of a spread? (False without facing pages, and for masters.) */
export function isLeftPage(scene: Pick<SceneState, "pages" | "settings">, page: PageLite, numbers = pageNumbers(scene.pages)): boolean {
  return scene.settings?.facingPages === true && !page.isMaster && numbers.has(page.id) && !isRightPage(numbers.get(page.id));
}

/** The ruler guides in force on a page: those of its master chain (the base first), then its own. */
export function effectiveGuides(scene: Pick<SceneState, "pages" | "settings">, page: PageLite, numbers = pageNumbers(scene.pages)): GuideLite[] {
  const out: GuideLite[] = [];
  if (!page.isMaster) for (const m of masterChain(scene.pages, masterOfPage(scene, page, numbers))) out.push(...(m.guides ?? []));
  out.push(...(page.guides ?? []));
  return out;
}

/** `scene` plus, on each page that applies a master, a flagged copy of the master's nodes; `scene` itself when none does. */
export function deriveMasters(scene: SceneState): SceneState {
  const hit = derived.get(scene);
  if (hit) return hit;
  const users = scene.pages.filter((p) => (p.masterId || p.leftMasterId) && !p.isMaster);
  if (users.length === 0) { derived.set(scene, scene); return scene; }

  const numbers = pageNumbers(scene.pages);
  const total = numbers.size;
  let edit: ReturnType<SceneState["nodes"]["edit"]> | null = null;
  const changed: string[] = [];
  for (const page of users) {
    const number = numbers.get(page.id)?.label ?? "";
    const heads = runningHeads(scene).get(page.id);
    const hidden = new Set(page.hiddenMasterItems);
    const chain = masterChain(scene.pages, masterOfPage(scene, page, numbers));
    for (const [depth, master] of chain.entries()) {
      for (const root of childrenOf(scene, master.id)) {
        for (const n of subtreeOf(scene, root.id)) {
          if (hidden.has(n.id)) continue;
          const top = n.parentId === master.id;
          // Children of a hidden item go with it: the copy's parent would not exist.
          if (!top && hidden.has(n.parentId)) { hidden.add(n.id); continue; }
          const copy: NodeLite = {
            ...n,
            id: masterCopyId(page.id, n.id),
            parentId: top ? page.id : masterCopyId(page.id, n.parentId),
            orderKey: top ? BEHIND.repeat(chain.length - depth) + n.orderKey : n.orderKey,
            fromMaster: true,
            ...(n.text && n.text.content.includes("<")
              ? { text: { ...n.text, content: substituteVariables(n.text.content, scene, number, total, heads) } }
              : {}),
          };
          (edit ??= scene.nodes.edit()).set(copy.id, copy);
          changed.push(copy.id);
        }
      }
    }
  }
  if (!edit) { derived.set(scene, scene); return scene; }
  const out: SceneState = { ...scene, nodes: edit.done() };
  recordDelta(out, scene, changed);
  derived.set(scene, out);
  return out;
}

/** The init shape of a Page message for `p` (every setup field written, 0 when absent). */
export function pageToPb(p: PageLite) {
  return {
    id: p.id, name: p.name, isMaster: p.isMaster === true, masterId: p.masterId ?? "",
    width: p.width ?? 0, height: p.height ?? 0,
    marginTop: p.marginTop ?? 0, marginRight: p.marginRight ?? 0, marginBottom: p.marginBottom ?? 0, marginLeft: p.marginLeft ?? 0,
    columns: p.columns ?? 0, gutter: p.gutter ?? 0, bleed: p.bleed ?? 0,
    sectionStart: p.sectionStart === true, numberStart: p.numberStart ?? 0, numberStyle: p.numberStyle ?? "",
    leftMasterId: p.leftMasterId ?? "", hiddenMasterItems: p.hiddenMasterItems ? [...p.hiddenMasterItems] : [],
    slug: p.slug ?? 0, guides: (p.guides ?? []).map((g) => ({ vertical: g.vertical, position: g.position })),
  };
}
