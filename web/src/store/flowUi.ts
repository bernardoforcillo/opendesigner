import { create } from "zustand";
import type { Bounds } from "../canvas/geometry";
import type { FlowLite, SceneState } from "./types";
import { markPresented } from "../dev/presented";

// VIEW STATE OF THE "FLOWS" MODE. Like currentPageId and selection in the
// scene store, it is INTERFACE state: it is not document, does not go over the
// network and does not enter undo. Everything that is instead document (flows,
// transitions, metadata) is written only with ops.

// Four modes, the product's path: Board (an infinite board of notes, text and arrows, no frames),
// Design (you draw), Flows (you
// connect screens and try the prototype), Development (you hand off:
// readiness, generated code, export). In Development the canvas is not edited.
export type EditorMode = "design" | "flows" | "dev" | "board";

/** The "Connect" drag in progress: where it starts from, where the pointer is, what is underneath. */
export interface ConnectPreview {
  fromScreenId: string;
  /** The starting hotspot (an element inside the screen) or "". */
  elementId: string;
  /** The WORLD bounds of what the arrow originates from (the element, or the screen). */
  fromBounds: Bounds;
  /** The pointer, in world coordinates. */
  x: number;
  y: number;
  /** The destination screen under the pointer, if any. */
  targetId: string | null;
}

export interface FlowUiState {
  mode: EditorMode;
  /** The current flow (id), or null = none chosen (falls back to the first). */
  currentFlowId: string | null;
  /** Also show the arrows of the other flows, dimmed. */
  showAllFlows: boolean;
  selectedTransitionId: string | null;
  hoverTransitionId: string | null;
  connectPreview: ConnectPreview | null;
  /** The playable prototype is open. */
  presenting: boolean;
  /** The ids with a problem (from AnalyzeFlows): the canvas highlights them. */
  issueNodeIds: ReadonlySet<string>;
  issueTransitionIds: ReadonlySet<string>;

  setMode: (m: EditorMode) => void;
  toggleMode: () => void;
  setCurrentFlow: (id: string | null) => void;
  setShowAllFlows: (v: boolean) => void;
  selectTransition: (id: string | null) => void;
  setHoverTransition: (id: string | null) => void;
  setConnectPreview: (p: ConnectPreview | null) => void;
  setPresenting: (v: boolean) => void;
  setIssueIds: (nodes: ReadonlySet<string>, transitions: ReadonlySet<string>) => void;
}

const NONE: ReadonlySet<string> = new Set();

export const useFlowUi = create<FlowUiState>((set) => ({
  mode: "design",
  currentFlowId: null,
  showAllFlows: false,
  selectedTransitionId: null,
  hoverTransitionId: null,
  connectPreview: null,
  presenting: false,
  issueNodeIds: NONE,
  issueTransitionIds: NONE,

  // Leaving the modes resets what only makes sense inside them: the selected
  // arrow, the hover and the rubber band must not stay hanging in "design".
  setMode: (m) =>
    set((st) =>
      st.mode === m
        ? st
        : { mode: m, selectedTransitionId: null, hoverTransitionId: null, connectPreview: null, presenting: false },
    ),
  // F toggles Design <-> Flows; from Development it goes back to Design (the shortest path
  // to drawing). Development is reached with S or from the dock selector.
  toggleMode: () =>
    set((st) => ({
      mode: st.mode === "design" ? "flows" : "design",
      selectedTransitionId: null,
      hoverTransitionId: null,
      connectPreview: null,
      presenting: false,
    })),
  setCurrentFlow: (id) =>
    set((st) => (st.currentFlowId === id ? st : { currentFlowId: id, selectedTransitionId: null, hoverTransitionId: null })),
  setShowAllFlows: (v) => set((st) => (st.showAllFlows === v ? st : { showAllFlows: v })),
  selectTransition: (id) => set((st) => (st.selectedTransitionId === id ? st : { selectedTransitionId: id })),
  // Hover redraws on every pointermove: without the comparison every mouse
  // movement would invalidate the canvas even when nothing changes.
  setHoverTransition: (id) => set((st) => (st.hoverTransitionId === id ? st : { hoverTransitionId: id })),
  setConnectPreview: (p) => set({ connectPreview: p }),
  setPresenting: (v) => {
    // "Have you already tried the prototype?" feeds the Try step of the pipeline.
    if (v) markPresented();
    set((st) => (st.presenting === v ? st : { presenting: v }));
  },
  setIssueIds: (nodes, transitions) => set({ issueNodeIds: nodes, issueTransitionIds: transitions }),
}));

/**
 * The EFFECTIVE flow: the chosen one if it still exists, otherwise the first (by
 * name, then id). null if the document has no flows. A flow deleted by a
 * peer does not leave the view attached to a ghost id.
 */
export function resolveFlow(scene: SceneState | null, currentFlowId: string | null): FlowLite | null {
  if (!scene) return null;
  if (currentFlowId !== null) {
    const f = scene.flows[currentFlowId];
    if (f) return f;
  }
  return sortedFlows(scene)[0] ?? null;
}

export function sortedFlows(scene: SceneState): FlowLite[] {
  return Object.values(scene.flows).sort((a, b) =>
    a.name !== b.name ? (a.name < b.name ? -1 : 1) : a.id < b.id ? -1 : 1,
  );
}
