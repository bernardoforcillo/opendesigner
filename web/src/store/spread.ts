import { create } from "zustand";
import { isRightPage, pageNumbers } from "@/store/pageNumbers";
import { effectiveGuides } from "@/store/masters";
import type { SceneState } from "@/store/types";

// THE SPREAD VIEW: with facing pages, the canvas can show the page on screen together with the page it
// faces -- the two sheets of an open book side by side -- instead of one sheet alone.
//
// It is VIEW state, not document (like the camera): the document only says whether its pages face
// (`settings.facingPages`) and which side a page is on (its number, store/pageNumbers.ts). The page on
// screen keeps its own coordinates (its origin stays at 0,0), so everything that edits it -- tools,
// snapping, the Control panel -- works unchanged; the facing page is drawn beside it at `dx` and is not
// edited until it becomes the page on screen (a click on it does that, see ui/App.tsx).
export interface Spread {
  /** The facing page. */
  pageId: string;
  /** Where its origin sits, in the page on screen's coordinates: -its width on the left, +this page's width on the right. */
  dx: number;
  /** Is the facing page the left-hand one? */
  partnerIsLeft: boolean;
}

/** The page that faces `currentPageId`, or null (no facing pages, a master, an unsized page, an unpaired first or last page). */
export function facingPartner(scene: Pick<SceneState, "pages" | "settings">, currentPageId: string | null | undefined): Spread | null {
  if (scene.settings?.facingPages !== true) return null;
  const pages = scene.pages.filter((p) => !p.isMaster);
  const i = pages.findIndex((p) => p.id === (currentPageId ?? pages[0]?.id));
  if (i < 0) return null;
  const numbers = pageNumbers(scene.pages);
  const cur = pages[i];
  const curRight = isRightPage(numbers.get(cur.id));
  const other = curRight ? pages[i - 1] : pages[i + 1];
  if (!other) return null;
  // The neighbour must be on the other side of the spine: a section that starts on a right page does not pair with the page before it.
  if (isRightPage(numbers.get(other.id)) === curRight) return null;
  const cw = cur.width ?? 0;
  const ow = other.width ?? 0;
  if (!(cw > 0) || !(ow > 0) || !(cur.height && other.height)) return null;
  return { pageId: other.id, dx: curRight ? -ow : cw, partnerIsLeft: curRight };
}

const KEY = "od.spreadView";
function load(): boolean {
  try { return localStorage.getItem(KEY) !== "off"; } catch { return true; }
}

interface SpreadViewStore {
  /** Show facing pages as a spread (when the document has them). On by default. */
  on: boolean;
  setOn: (on: boolean) => void;
}

export const useSpreadView = create<SpreadViewStore>((set) => ({
  on: load(),
  setOn: (on) => {
    try { localStorage.setItem(KEY, on ? "on" : "off"); } catch { /* no storage */ }
    set({ on });
  },
}));

/** Is the world point (in the page on screen's coordinates) on the facing page's sheet and not on the page on screen's own? */
export function pointOnFacingPage(
  scene: Pick<SceneState, "pages">,
  currentPageId: string | null | undefined,
  spread: Spread,
  world: { x: number; y: number },
): boolean {
  const cur = scene.pages.find((p) => p.id === (currentPageId ?? scene.pages[0]?.id));
  const other = scene.pages.find((p) => p.id === spread.pageId);
  if (!cur || !other) return false;
  const within = (x0: number, w: number, h: number) => world.x >= x0 && world.x <= x0 + w && world.y >= 0 && world.y <= h;
  return within(spread.dx, other.width ?? 0, other.height ?? 0) && !within(0, cur.width ?? 0, cur.height ?? 0);
}

/** What the overlay draws for the facing page: its sheet and the guides in force on it. */
export function partnerSheet(scene: SceneState, spread: Spread) {
  const page = scene.pages.find((p) => p.id === spread.pageId);
  if (!page) return undefined;
  return { page, dx: spread.dx, left: spread.partnerIsLeft, guides: effectiveGuides(scene, page) };
}

/** The camera that frames the page on screen -- and, with a spread, the facing page too -- in a `viewW` x `viewH` canvas, with a margin around it. */
export function fitSpreadCamera(
  scene: Pick<SceneState, "pages" | "settings">,
  currentPageId: string | null | undefined,
  spread: Spread | null,
  viewW: number,
  viewH: number,
  margin = 32,
): { x: number; y: number; zoom: number } | null {
  const cur = scene.pages.find((p) => p.id === (currentPageId ?? scene.pages[0]?.id));
  const other = spread ? scene.pages.find((p) => p.id === spread.pageId) : undefined;
  const w = cur?.width ?? 0;
  const h = Math.max(cur?.height ?? 0, other?.height ?? 0);
  if (!cur || !(w > 0) || !(h > 0) || !(viewW > 0) || !(viewH > 0)) return null;
  const x0 = spread ? Math.min(0, spread.dx) : 0;
  const x1 = spread ? Math.max(w, spread.dx + (other?.width ?? 0)) : w;
  const zoom = Math.max(0.02, Math.min((viewW - 2 * margin) / (x1 - x0), (viewH - 2 * margin) / h));
  return { zoom, x: (viewW - (x1 - x0) * zoom) / 2 - x0 * zoom, y: (viewH - h * zoom) / 2 };
}
