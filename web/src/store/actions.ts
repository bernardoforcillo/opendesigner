import { create } from "zustand";

// THE ACTIONS PALETTE (Ctrl/Cmd+K): a search box over the things the editor can do -- tools, zoom,
// modes, panels, history -- so any of them is a few keystrokes away. This is its state and its ranking;
// the list of actions is built where the editor's pieces are (ui/shell/paletteActions.ts).
export interface PaletteAction {
  id: string;
  label: string;
  /** What it belongs to ("Tools", "View", ...): shown beside the label and searched too. */
  group: string;
  /** Its shortcut, for display. */
  keys?: string;
  run: () => void;
}

export const useActionsPalette = create<{ open: boolean; setOpen: (open: boolean) => void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

const MAX_RESULTS = 60;

/**
 * The actions that match `query`, best first: a label that starts with it, then one with a word that does,
 * then one that contains it, then one whose group does; shorter labels first within a tier. An empty query
 * lists everything in the order given. At most 60.
 */
export function rankActions(actions: readonly PaletteAction[], query: string, limit = MAX_RESULTS): PaletteAction[] {
  const q = query.trim().toLowerCase();
  if (q === "") return actions.slice(0, limit);
  const scored: { a: PaletteAction; tier: number; i: number }[] = [];
  actions.forEach((a, i) => {
    const label = a.label.toLowerCase();
    const tier = label.startsWith(q) ? 0 : label.includes(` ${q}`) ? 1 : label.includes(q) ? 2 : a.group.toLowerCase().includes(q) ? 3 : -1;
    if (tier >= 0) scored.push({ a, tier, i });
  });
  scored.sort((x, y) => x.tier - y.tier || x.a.label.length - y.a.label.length || x.i - y.i);
  return scored.slice(0, limit).map((s) => s.a);
}
