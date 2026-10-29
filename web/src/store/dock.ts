import { create } from "zustand";
import { usePanels } from "@/ui/shell/panels";

// THE DOCK of the Publishing workspace (the tabbed column on the right): which tab is in front. It is
// view state, shared so that something outside the dock can bring a tab forward -- the status bar's
// preflight verdict opens Preflight, the comment tool opens Comments -- and opens the dock if it was closed.
export type DockTab = "properties" | "pages" | "layers" | "styles" | "preflight" | "comments";

export const useDock = create<{ tab: DockTab; setTab: (tab: DockTab) => void }>((set) => ({
  tab: "properties",
  setTab: (tab) => set({ tab }),
}));

/** Brings `tab` to the front, opening the right-hand column if it is closed. */
export function showDockTab(tab: DockTab): void {
  useDock.getState().setTab(tab);
  if (!usePanels.getState().right) usePanels.getState().toggle("right");
}
