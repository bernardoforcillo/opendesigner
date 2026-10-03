import { create } from "zustand";

// I pannelli laterali si possono chiudere per dare tutta la tela al disegno. Lo
// stato sopravvive al ricarico (localStorage; senza, restano aperti). Tasti:
// `[` sinistro, `]` destro (mai dentro un campo di testo).
const KEY = "od.panels";

function read(): { left: boolean; right: boolean } {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (v && typeof v.left === "boolean" && typeof v.right === "boolean") return v;
  } catch { /* niente storage */ }
  return { left: true, right: true };
}

function save(s: { left: boolean; right: boolean }) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* niente storage */ }
}

export const usePanels = create<{
  left: boolean; right: boolean; toggle: (side: "left" | "right") => void;
}>((set, get) => ({
  ...read(),
  toggle: (side) => {
    const next = { left: get().left, right: get().right, [side]: !get()[side] };
    save(next);
    set(next);
    // La tela cambia larghezza: il renderer ridisegna su invalidazione e App la
    // chiede già al resize della finestra -- la stessa strada vale qui.
    if (typeof window !== "undefined") requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  },
}));
