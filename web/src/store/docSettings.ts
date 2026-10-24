import type { DocSettingsLite, PageLite, SceneState, Vertical } from "./types";

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
export function isValidDocSettings(s: { vertical: string; baselineIncrement: number; baselineStart: number } | undefined): boolean {
  if (!s) return false;
  if (s.vertical !== "" && !isVertical(s.vertical)) return false;
  return finiteIn(s.baselineIncrement, 0, 1000) && Number.isFinite(s.baselineStart) && s.baselineStart >= 0;
}

/** A DocSettingsLite from the message form, or null when invalid. */
export function toDocSettings(s: { vertical: string; baselineIncrement: number; baselineStart: number }): DocSettingsLite {
  return {
    ...(s.vertical === "publishing" || s.vertical === "design" ? { vertical: s.vertical } : {}),
    ...(s.baselineIncrement ? { baselineIncrement: s.baselineIncrement } : {}),
    ...(s.baselineStart ? { baselineStart: s.baselineStart } : {}),
  };
}

type PageSetupFields = Pick<PageLite, "width" | "height" | "marginTop" | "marginRight" | "marginBottom" | "marginLeft" | "columns" | "gutter" | "bleed">;

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
  return true;
}

/** The text area of a page, inside its margins (the whole sheet when it has none). */
export function pageTextArea(p: PageLite): { x: number; y: number; width: number; height: number } {
  const w = p.width ?? 0, h = p.height ?? 0;
  return { x: p.marginLeft ?? 0, y: p.marginTop ?? 0, width: w > 0 ? w - (p.marginLeft ?? 0) - (p.marginRight ?? 0) : 0, height: h > 0 ? h - (p.marginTop ?? 0) - (p.marginBottom ?? 0) : 0 };
}

/** The x ranges of the text columns of a page, left to right ([] when it has one column or no size). */
export function pageColumns(p: PageLite): { x: number; width: number }[] {
  const n = p.columns ?? 0;
  const area = pageTextArea(p);
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
  for (const k of ["width", "height", "marginTop", "marginRight", "marginBottom", "marginLeft", "columns", "gutter", "bleed"] as const) {
    if (p[k]) out[k] = p[k];
  }
  return out;
}
