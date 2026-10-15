import { create } from "zustand";

// VIEW STATE of comments: not document, never sent. The comments themselves are document
// (setComment / deleteComment ops).

export interface CommentDraft {
  nodeId: string;
  pageId: string;
  x: number;
  y: number;
}

export interface CommentsUiState {
  /** A pin just placed with the comment tool, waiting for its text. */
  draft: CommentDraft | null;
  /** The thread highlighted on the canvas and expanded in the panel. */
  activeId: string | null;
  showResolved: boolean;
  /** The side panel asks to come to the front (the comment tool was used). */
  revealRequested: number;
  setDraft: (d: CommentDraft | null) => void;
  setActive: (id: string | null) => void;
  setShowResolved: (v: boolean) => void;
  requestReveal: () => void;
}

export const useCommentsUi = create<CommentsUiState>((set) => ({
  draft: null,
  activeId: null,
  showResolved: false,
  revealRequested: 0,
  setDraft: (draft) => set(draft ? { draft, activeId: null } : { draft: null }),
  setActive: (activeId) => set({ activeId, draft: null }),
  setShowResolved: (showResolved) => set({ showResolved }),
  requestReveal: () => set((s) => ({ revealRequested: s.revealRequested + 1 })),
}));
