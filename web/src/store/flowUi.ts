import { create } from "zustand";
import type { Bounds } from "../canvas/geometry";
import type { FlowLite, SceneState } from "./types";
import { markPresented } from "../dev/presented";

// STATO DI VISTA DELLA MODALITÀ "FLUSSI". Come currentPageId e selection nello
// store della scena, è stato dell'INTERFACCIA: non è documento, non passa dalla
// rete e non entra nell'undo. Tutto ciò che invece è documento (i flussi, le
// transizioni, i metadati) si scrive solo con gli op.

// Tre modalità, il percorso del prodotto: Design (si disegna), Flussi (si
// collegano le schermate e si prova il prototipo), Sviluppo (si consegna:
// prontezza, codice generato, export). Su Sviluppo la tela non si modifica.
export type EditorMode = "design" | "flows" | "dev";

/** Il drag di "Collega" in corso: da dove parte, dov'è il puntatore, cosa c'è sotto. */
export interface ConnectPreview {
  fromScreenId: string;
  /** L'hotspot di partenza (un elemento dentro la schermata) o "". */
  elementId: string;
  /** I bounds MONDO di ciò da cui nasce la freccia (l'elemento, o la schermata). */
  fromBounds: Bounds;
  /** Il puntatore, in coordinate mondo. */
  x: number;
  y: number;
  /** La schermata di arrivo sotto il puntatore, se c'è. */
  targetId: string | null;
}

export interface FlowUiState {
  mode: EditorMode;
  /** Il flusso corrente (id), o null = nessuno scelto (si ripiega sul primo). */
  currentFlowId: string | null;
  /** Mostra anche le frecce degli altri flussi, attenuate. */
  showAllFlows: boolean;
  selectedTransitionId: string | null;
  hoverTransitionId: string | null;
  connectPreview: ConnectPreview | null;
  /** Il prototipo giocabile è aperto. */
  presenting: boolean;
  /** Gli id con un problema (da AnalyzeFlows): il canvas li evidenzia. */
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

  // Uscire dalle modalità azzera ciò che ha senso solo dentro: la freccia
  // selezionata, l'hover e il rubber band non devono restare appesi in "design".
  setMode: (m) =>
    set((st) =>
      st.mode === m
        ? st
        : { mode: m, selectedTransitionId: null, hoverTransitionId: null, connectPreview: null, presenting: false },
    ),
  // F alterna Design <-> Flussi; da Sviluppo riporta a Design (la via più corta
  // verso il disegno). Sviluppo si raggiunge con S o dal selettore del dock.
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
  // L'hover si ridisegna a ogni pointermove: senza il confronto ogni movimento
  // del mouse invaliderebbe il canvas anche quando non cambia nulla.
  setHoverTransition: (id) => set((st) => (st.hoverTransitionId === id ? st : { hoverTransitionId: id })),
  setConnectPreview: (p) => set({ connectPreview: p }),
  setPresenting: (v) => {
    // "Hai già provato il prototipo?" alimenta il passo Prova della pipeline.
    if (v) markPresented();
    set((st) => (st.presenting === v ? st : { presenting: v }));
  },
  setIssueIds: (nodes, transitions) => set({ issueNodeIds: nodes, issueTransitionIds: transitions }),
}));

/**
 * Il flusso EFFETTIVO: quello scelto se esiste ancora, altrimenti il primo (per
 * nome, poi id). null se il documento non ha flussi. Un flusso cancellato da un
 * peer non lascia la vista agganciata a un id fantasma.
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
