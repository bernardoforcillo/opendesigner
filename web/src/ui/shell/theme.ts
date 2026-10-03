import { create } from "zustand";

// Il tema: "system" segue il sistema operativo, "light"/"dark" lo forzano
// (<html data-theme>). La scelta sopravvive al ricarico; senza localStorage
// (finestra privata, jsdom) si resta su "system".
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
    try { if (t === "system") localStorage.removeItem(KEY); else localStorage.setItem(KEY, t); } catch { /* niente storage */ }
    apply(t);
    set({ choice: t });
  },
}));

// Da chiamare una volta all'avvio: applica la scelta salvata prima del primo disegno.
export function initTheme() {
  apply(read());
}

// Il tema EFFETTIVO (chiaro/scuro), per chi disegna su canvas e non legge CSS.
export function effectiveTheme(): "light" | "dark" {
  const forced = document.documentElement.getAttribute("data-theme");
  if (forced === "light" || forced === "dark") return forced;
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
