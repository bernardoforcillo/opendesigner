import { create } from "zustand";

// The side panels can be closed to give the whole canvas to the drawing. The
// state survives a reload (localStorage; without it, they stay open). Keys:
// `[` left, `]` right (never inside a text field).
const KEY = "od.panels";

function read(): { left: boolean; right: boolean } {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (v && typeof v.left === "boolean" && typeof v.right === "boolean") return v;
  } catch { /* no storage */ }
  return { left: true, right: true };
}

function save(s: { left: boolean; right: boolean }) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* no storage */ }
}

export const usePanels = create<{
  left: boolean; right: boolean; toggle: (side: "left" | "right") => void;
}>((set, get) => ({
  ...read(),
  toggle: (side) => {
    const next = { left: get().left, right: get().right, [side]: !get()[side] };
    save(next);
    set(next);
    // The canvas changes width: the renderer redraws on invalidation and App
    // already requests it on window resize -- the same path works here.
    if (typeof window !== "undefined") requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  },
}));
