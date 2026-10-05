// THE TOKEN COLORS, FOR WHOEVER DRAWS ON CANVAS.
//
// The DOM interface takes colors from CSS variables (ui/ds/tokens.css) and
// changes theme by itself. A canvas does not: `ctx.strokeStyle = "var(--accent)"` does not
// work, so the overlays (selection, flow arrows, peer cursors)
// used hand-written colors -- which clashed in dark and, worse, were
// a SECOND source of truth to keep aligned with the tokens.
//
// Here the tokens are resolved ONCE (getComputedStyle on the root element) and
// kept in cache: the renderers ask for them on every frame, but an overlay frame
// must not pay for a style read for every line. The cache is invalidated
// when the theme changes -- the `data-theme` attribute of <html> (manual choice) or
// `prefers-color-scheme` (system theme) -- and at that point whoever
// asked to know (`subscribeTheme`) is notified and the overlay is redrawn: the
// drawing is invalidation-based, so without this notice the old colors
// would stay on screen until the first mouse movement.
//
// Without a DOM or without CSS variables (vitest/jsdom, a worker, a script) it falls back
// on the LIGHT THEME values, the same as tokens.css: the renderers remain
// pure, testable functions, and a missing color is never an empty string
// (which the canvas would ignore, leaving the PREVIOUS color).

export interface ThemeColors {
  accent: string;
  flow: string;
  ok: string;
  warn: string;
  danger: string;
  surface: string;
  fg: string;
  fgMuted: string;
  fgSubtle: string;
  lineStrong: string;
  canvas: string;
  /** The snap guides: a warm magenta, legible on both themes. It is NOT a CSS token. */
  guide: string;
  dark: boolean;
}

// The CSS keys, next to the field they fill.
const VARS: readonly (readonly [Exclude<keyof ThemeColors, "guide" | "dark">, string])[] = [
  ["accent", "--accent"],
  ["flow", "--flow"],
  ["ok", "--ok"],
  ["warn", "--warn"],
  ["danger", "--danger"],
  ["surface", "--surface"],
  ["fg", "--fg"],
  ["fgMuted", "--fg-muted"],
  ["fgSubtle", "--fg-subtle"],
  ["lineStrong", "--line-strong"],
  ["canvas", "--canvas"],
];

// The tokens.css values for the light theme (and the guides' magenta for both themes).
export const LIGHT_FALLBACK: ThemeColors = {
  accent: "#2563eb",
  flow: "#6d3df5",
  ok: "#0f8a5f",
  warn: "#a35d00",
  danger: "#cc2a36",
  surface: "#ffffff",
  fg: "#14161b",
  fgMuted: "#565d6b",
  fgSubtle: "#7b8291",
  lineStrong: "#cfd4dc",
  canvas: "#eef0f3",
  guide: "#e0268f",
  dark: false,
};
const DARK_GUIDE = "#ff5db1";

let cache: ThemeColors | null = null;
let watching = false;
const listeners = new Set<() => void>();

function hasDom(): boolean {
  return typeof document !== "undefined" && typeof getComputedStyle === "function" && !!document.documentElement;
}

// Effective theme, with the same rule as ui/shell/theme.ts::effectiveTheme (here
// duplicated: a renderer does not import from the UI).
function isDark(): boolean {
  if (!hasDom()) return false;
  const forced = document.documentElement.getAttribute("data-theme");
  if (forced === "dark") return true;
  if (forced === "light") return false;
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
}

function read(): ThemeColors {
  const out: ThemeColors = { ...LIGHT_FALLBACK };
  if (!hasDom()) return out;
  const dark = isDark();
  out.dark = dark;
  out.guide = dark ? DARK_GUIDE : LIGHT_FALLBACK.guide;
  const cs = getComputedStyle(document.documentElement);
  for (const [key, name] of VARS) {
    const v = cs.getPropertyValue(name).trim();
    if (v !== "") out[key] = v;
  }
  return out;
}

function invalidate(): void {
  cache = null;
  for (const fn of listeners) fn();
  // The overlay redraws on invalidation and App.tsx already invalidates on `resize`:
  // the same event serves to redraw the new colors without the
  // renderer knowing about the App.
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new Event("resize"));
  }
}

function watch(): void {
  if (watching || !hasDom()) return;
  watching = true;
  if (typeof MutationObserver === "function") {
    new MutationObserver(invalidate).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  }
  if (typeof matchMedia === "function") {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    if (typeof mq.addEventListener === "function") mq.addEventListener("change", invalidate);
  }
}

/** The current theme's colors. Cheap to call on every frame (cache). */
export function themeColors(): ThemeColors {
  if (cache) return cache;
  watch();
  cache = read();
  return cache;
}

/** Asks to be notified when the theme changes. Returns the unsubscription. */
export function subscribeTheme(fn: () => void): () => void {
  watch();
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Only for tests: throws away the cache (the CSS values were changed by hand). */
export function resetThemeColors(): void {
  cache = null;
}

/**
 * The same color with transparency `a` (0..1). Tokens are hex (#rgb or
 * #rrggbb); any other format (rgb(), name) is returned untouched: the
 * canvas accepts it, it just loses the transparency -- better than a broken color.
 */
export function withAlpha(color: string, a: number): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return color;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
