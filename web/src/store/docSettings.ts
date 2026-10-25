import type { DocSettingsLite, DocSettingsMsg, GuideLite, PageLite, SceneState, Vertical } from "./types";
import type { Bounds } from "../canvas/geometry";
import { settingsOf } from "./types";

// DOCUMENT SETTINGS and PAGE SETUP -- the twin of internal/core/docsettings.go (Go is the authority).
//
//   1. the vertical is "", "publishing", "design" or "product" ("" is "product"); it only shapes the editor;
//   2. the baseline grid has a finite increment in 0..1000 (0 = no grid) and a finite start >= 0;
//   3. a page's size is 0 (unbounded) or 1..100000 in each direction; margins, gutter and bleed are
//      finite and non-negative (bleed up to 1000); columns are 0..24;
//   4. the margins of a sized page leave room: left + right < width and top + bottom < height;
//   5. with more than one column the gutters leave room: (columns - 1) * gutter < the text width.

export const VERTICALS: readonly Vertical[] = ["publishing", "design", "product"];

export function isVertical(v: string): v is Vertical {
  return (VERTICALS as readonly string[]).includes(v);
}

/** The vertical of a document: "product" unless it says otherwise. */
export function verticalOf(scene: Pick<SceneState, "settings"> | null | undefined): Vertical {
  return scene?.settings?.vertical ?? "product";
}

const finiteIn = (v: number, lo: number, hi: number) => Number.isFinite(v) && v >= lo && v <= hi;

/** Parity with core.validateDocSettings (the message form: vertical "" for the default). */
export function isValidDocSettings(s: DocSettingsMsg | undefined): boolean {
  if (!s) return false;
  if (s.vertical !== "" && !isVertical(s.vertical)) return false;
  if (s.colorMode !== undefined && s.colorMode !== "" && s.colorMode !== "cmyk") return false;
  const icc = s.iccProfile ?? "";
  // eslint-disable-next-line no-control-regex
  if (icc.length > 64 || icc.trim() !== icc || /[\u0000-\u001f\u007f]/.test(icc)) return false;
  return finiteIn(s.baselineIncrement, 0, 1000) && Number.isFinite(s.baselineStart) && s.baselineStart >= 0;
}

/** A DocSettingsLite from the message form. */
export function toDocSettings(s: DocSettingsMsg): DocSettingsLite {
  return settingsOf(s);
}

type PageSetupFields = Pick<PageLite, "width" | "height" | "marginTop" | "marginRight" | "marginBottom" | "marginLeft" | "columns" | "gutter" | "bleed" | "slug" | "numberStyle" | "numberStart" | "slug" | "guides" | "hiddenMasterItems">;

/** Parity with core.validatePageSetup. Absent fields are 0. */
export function isValidPageSetup(p: PageSetupFields): boolean {
  const w = p.width ?? 0, h = p.height ?? 0;
  if (!(w === 0 || finiteIn(w, 1, 100000)) || !(h === 0 || finiteIn(h, 1, 100000))) return false;
  const ml = p.marginLeft ?? 0, mr = p.marginRight ?? 0, mt = p.marginTop ?? 0, mb = p.marginBottom ?? 0, gutter = p.gutter ?? 0, columns = p.columns ?? 0;
  for (const v of [mt, mr, mb, ml, gutter]) if (!finiteIn(v, 0, 100000)) return false;
  if (!finiteIn(p.bleed ?? 0, 0, 1000) || !Number.isInteger(columns) || columns < 0 || columns > 24) return false;
  if (w > 0 && ml + mr >= w) return false;
  if (h > 0 && mt + mb >= h) return false;
  if (w > 0 && columns > 1 && (columns - 1) * gutter >= w - ml - mr) return false;
  return isValidPageStructure(p);
}

/** Parity with core.validatePageStructure: numbering, slug, guides and hidden master items. */
export function isValidPageStructure(p: Pick<PageLite, "numberStyle" | "numberStart" | "slug" | "guides" | "hiddenMasterItems">): boolean {
  const style = p.numberStyle as string | undefined;
  if (style !== undefined && style !== "" && style !== "i" && style !== "I" && style !== "a" && style !== "A") return false;
  const start = p.numberStart ?? 0;
  if (!Number.isInteger(start) || start < 0 || start > 100000 || !finiteIn(p.slug ?? 0, 0, 1000)) return false;
  if ((p.guides?.length ?? 0) > 200 || (p.hiddenMasterItems?.length ?? 0) > 1000) return false;
  if (p.guides?.some((g) => !finiteIn(g.position, -100000, 100000))) return false;
  return !p.hiddenMasterItems?.some((id) => id === "");
}

/**
 * The margins of a page as left/right of the sheet. With facing pages `marginLeft` is the INSIDE margin
 * (next to the spine) and `marginRight` the OUTSIDE one, so on a left-hand page they swap sides.
 */
export function sideMargins(p: PageLite, left = false): { left: number; right: number } {
  const l = p.marginLeft ?? 0, r = p.marginRight ?? 0;
  return left ? { left: r, right: l } : { left: l, right: r };
}

/** The text area of a page, inside its margins (the whole sheet when it has none). `left`: a left-hand page of facing pages. */
export function pageTextArea(p: PageLite, left = false): { x: number; y: number; width: number; height: number } {
  const w = p.width ?? 0, h = p.height ?? 0;
  const m = sideMargins(p, left);
  return { x: m.left, y: p.marginTop ?? 0, width: w > 0 ? w - m.left - m.right : 0, height: h > 0 ? h - (p.marginTop ?? 0) - (p.marginBottom ?? 0) : 0 };
}

/** The x ranges of the text columns of a page, left to right ([] when it has one column or no size). */
export function pageColumns(p: PageLite, left = false): { x: number; width: number }[] {
  const n = p.columns ?? 0;
  const area = pageTextArea(p, left);
  if (n <= 1 || area.width <= 0) return [];
  const gutter = p.gutter ?? 0;
  const width = (area.width - (n - 1) * gutter) / n;
  return Array.from({ length: n }, (_, i) => ({ x: area.x + i * (width + gutter), width }));
}

/** Common sheet sizes in points (1/72 in), portrait. */
export const PAGE_PRESETS: readonly { id: string; name: string; width: number; height: number }[] = [
  { id: "a3", name: "A3", width: 842, height: 1191 },
  { id: "a4", name: "A4", width: 595, height: 842 },
  { id: "a5", name: "A5", width: 420, height: 595 },
  { id: "a6", name: "A6", width: 298, height: 420 },
  { id: "letter", name: "US Letter", width: 612, height: 792 },
  { id: "legal", name: "US Legal", width: 612, height: 1008 },
  { id: "tabloid", name: "Tabloid", width: 792, height: 1224 },
  { id: "book", name: "Book 6 × 9 in", width: 432, height: 648 },
  { id: "square", name: "Square 8 × 8 in", width: 576, height: 576 },
];

/** The sheet setup of `p` alone (what a new page copies from the page it is made from). */
export function setupOf(p: PageLite | undefined): PageSetupFields {
  if (!p) return {};
  const out: PageSetupFields = {};
  for (const k of ["width", "height", "marginTop", "marginRight", "marginBottom", "marginLeft", "columns", "gutter", "bleed", "slug"] as const) {
    if (p[k]) out[k] = p[k];
  }
  return out;
}

/** Most baseline lines ever produced (a 1 px grid on a long page would otherwise make thousands of snap targets). */
export const MAX_BASELINE_LINES = 800;

/** The y of each baseline grid line over a sheet of `height` (the page's, or `fallback` for an unbounded page). */
export function baselineLines(settings: DocSettingsLite | undefined, height: number): number[] {
  const inc = settings?.baselineIncrement ?? 0;
  if (!(inc > 0) || !(height > 0)) return [];
  const out: number[] = [];
  for (let y = settings?.baselineStart ?? 0, i = 0; y <= height && i < MAX_BASELINE_LINES; y += inc, i++) out.push(y);
  return out;
}

/**
 * The guides of a sized page as degenerate boxes (a line is a box of zero width or height), the form the
 * snap targets take: the sheet's edges, the margins, the edges of every column and the baseline grid.
 */
export function pageGuideBoxes(page: PageLite | undefined, settings: DocSettingsLite | undefined, side: { left?: boolean; guides?: readonly GuideLite[] } = {}): Bounds[] {
  const w = page?.width ?? 0, h = page?.height ?? 0;
  if (!page || !(w > 0) || !(h > 0)) return [];
  const area = pageTextArea(page, side.left);
  const v = (x: number, y: number, height: number): Bounds => ({ x, y, width: 0, height });
  const hz = (x: number, y: number, width: number): Bounds => ({ x, y, width, height: 0 });
  const out: Bounds[] = [v(0, 0, h), v(w, 0, h), hz(0, 0, w), hz(0, h, w)];
  if (area.x > 0 || area.y > 0 || area.width < w || area.height < h) {
    out.push(v(area.x, area.y, area.height), v(area.x + area.width, area.y, area.height), hz(area.x, area.y, area.width), hz(area.x, area.y + area.height, area.width));
  }
  for (const c of pageColumns(page, side.left)) out.push(v(c.x, area.y, area.height), v(c.x + c.width, area.y, area.height));
  for (const y of baselineLines(settings, h)) out.push(hz(0, y, w));
  for (const g of side.guides ?? []) out.push(g.vertical ? v(g.position, 0, h) : hz(0, g.position, w));
  return out;
}
