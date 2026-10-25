import { create } from "zustand";

// The context menu (right click) is ONE menu for the whole editor: whoever asks for it (the canvas,
// a layer row) calls `show` with the pointer position and the entries; the host (ContextMenu.tsx)
// draws it. View state, not document state: nothing here travels on the wire.

export type MenuEntry =
  | { type: "separator" }
  | {
      type?: "item";
      id: string;
      label: string;
      /** Shown right-aligned, e.g. "Ctrl+D". Informational: the shortcut itself lives elsewhere. */
      shortcut?: string;
      disabled?: boolean;
      danger?: boolean;
      onSelect?: () => void;
      /** A submenu instead of an action. */
      children?: readonly MenuEntry[];
    };

interface ContextMenuState {
  open: { x: number; y: number; entries: readonly MenuEntry[] } | null;
  show(x: number, y: number, entries: readonly MenuEntry[]): void;
  hide(): void;
}

export const useContextMenu = create<ContextMenuState>((set) => ({
  open: null,
  // A menu with nothing in it is not shown.
  show: (x, y, entries) => set({ open: entries.some((e) => e.type !== "separator") ? { x, y, entries } : null }),
  hide: () => set({ open: null }),
}));
