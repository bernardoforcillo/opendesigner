import { create } from "zustand";

// The theme: "system" follows the operating system, "light"/"dark" force it
// (<html data-theme>). The choice survives a reload; without localStorage
// (private window, jsdom) it stays on "system".
export type ThemeChoice = "system" | "light" | "dark";
const KEY = "od.theme";

function read(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch { return "system"; }
}

function apply(t: ThemeChoice) {
  const root = document.documentElement;
  if (t === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", t);
}

export const useTheme = create<{ choice: ThemeChoice; set: (t: ThemeChoice) => void }>((set) => ({
  choice: read(),
  set: (t) => {
    try { if (t === "system") localStorage.removeItem(KEY); else localStorage.setItem(KEY, t); } catch { /* no storage */ }
    apply(t);
    set({ choice: t });
  },
}));

// To be called once at startup: applies the saved choice before the first paint.
export function initTheme() {
  apply(read());
}

// The EFFECTIVE theme (light/dark), for whoever draws on canvas and does not read CSS.
export function effectiveTheme(): "light" | "dark" {
  const forced = document.documentElement.getAttribute("data-theme");
  if (forced === "light" || forced === "dark") return forced;
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
