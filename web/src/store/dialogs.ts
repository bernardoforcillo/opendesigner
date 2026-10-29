import { create } from "zustand";

// Dialogs that more than one part of the editor can open. The Variables dialog is opened from the
// document menu and from the Figma-style workspace's left rail.
export const useVariablesDialog = create<{ open: boolean; setOpen: (open: boolean) => void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));
