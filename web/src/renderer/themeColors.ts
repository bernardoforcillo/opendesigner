// I COLORI DEI TOKEN, PER CHI DISEGNA SU CANVAS.
//
// L'interfaccia DOM prende i colori dalle variabili CSS (ui/ds/tokens.css) e
// cambia tema da sola. Un canvas no: `ctx.strokeStyle = "var(--accent)"` non
// funziona, quindi gli overlay (selezione, frecce dei flussi, cursori dei peer)
// leggevano dei colori scritti a mano -- che in scuro stonavano e, peggio, erano
// una SECONDA fonte di verità da tenere allineata ai token.
//
// Qui si risolvono i token UNA volta (getComputedStyle sull'elemento radice) e si
// tengono in cache: i renderer li chiedono a ogni frame, ma un frame di overlay
// non deve pagare una lettura di stile per ogni linea. La cache si invalida
// quando il tema cambia -- l'attributo `data-theme` di <html> (scelta manuale) o
// `prefers-color-scheme` (tema di sistema) -- e a quel punto si avvisa chi ha
// chiesto di saperlo (`subscribeTheme`) e si fa ridisegnare l'overlay: il
// disegno è a invalidazione, quindi senza questo avviso i colori vecchi
// resterebbero sullo schermo fino al primo movimento del mouse.
//
// Senza DOM o senza variabili CSS (vitest/jsdom, un worker, uno script) si ricade
// sui valori del TEMA CHIARO, gli stessi di tokens.css: i renderer restano
// funzioni pure e provabili, e un colore mancante non è mai una stringa vuota
// (che il canvas ignorerebbe lasciando il colore PRECEDENTE).

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
  /** Le guide di snap: un magenta caldo, leggibile su entrambi i temi. NON è un token CSS. */
  guide: string;
  dark: boolean;
}

// Le chiavi CSS, accanto al campo che riempiono.
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

// I valori di tokens.css per il tema chiaro (e il magenta delle guide per i due temi).
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

// Tema effettivo, con la stessa regola di ui/shell/theme.ts::effectiveTheme (qui
// duplicata: un renderer non importa dalla UI).
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
  // L'overlay si ridisegna a invalidazione e App.tsx invalida già su `resize`:
  // lo stesso evento serve a far ridisegnare i colori nuovi senza che il
  // renderer conosca l'App.
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

/** I colori del tema corrente. Economica da chiamare a ogni frame (cache). */
export function themeColors(): ThemeColors {
  if (cache) return cache;
  watch();
  cache = read();
  return cache;
}

/** Chiede di essere avvisati quando il tema cambia. Restituisce la disiscrizione. */
export function subscribeTheme(fn: () => void): () => void {
  watch();
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Solo per i test: butta la cache (i valori CSS sono cambiati a mano). */
export function resetThemeColors(): void {
  cache = null;
}

/**
 * Lo stesso colore con trasparenza `a` (0..1). I token sono esadecimali (#rgb o
 * #rrggbb); qualunque altro formato (rgb(), nome) si restituisce intatto: il
 * canvas lo accetta, solo perde la trasparenza -- meglio di un colore rotto.
 */
export function withAlpha(color: string, a: number): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return color;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
