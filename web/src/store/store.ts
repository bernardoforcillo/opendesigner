import { create as createStore } from "zustand";
import type { Op } from "../gen/brawt/v1/brawt_pb";
import { applyOp } from "./applyOp";
import type { SceneState } from "./types";
import type { Camera } from "../canvas/camera";
import type { Bounds } from "../canvas/geometry";

interface SceneStore {
  scene: SceneState | null;
  camera: Camera;
  // Invariante: selection contiene SOLO id di nodi che esistono ancora in
  // scene.nodes. Quando un op (anche remoto, via apply) fa sparire un nodo
  // selezionato, va tolto anche dalla selezione -- altrimenti le maniglie di
  // resize restano "appese" a un nodo inesistente.
  selection: string[];
  // Rettangolo del marquee in corso, in coordinate MONDO (come tutto il resto
  // del modello). null quando non si sta trascinando un marquee.
  marquee: Bounds | null;
  setScene: (s: SceneState) => void;
  setCamera: (c: Camera) => void;
  apply: (op: Op) => void;
  setSelection: (ids: string[]) => void;
  toggleSelection: (id: string) => void;
  clearSelection: () => void;
  setMarquee: (b: Bounds | null) => void;
}

export const useScene = createStore<SceneStore>((set) => ({
  scene: null,
  camera: { x: 0, y: 0, zoom: 1 },
  selection: [],
  marquee: null,
  setScene: (s) => set({ scene: s }),
  setCamera: (c) => set({ camera: c }),
  apply: (op) =>
    set((st) => {
      if (!st.scene) return st;
      const scene = applyOp(st.scene, op);
      // Riconvalida la selezione contro i nodi rimasti dopo l'op (non solo
      // per deleteNode: qualunque op che fa sparire un id -- anche futuro --
      // deve avere lo stesso effetto). Se non cambia nulla riusa lo stesso
      // array per non forzare re-render inutili.
      const selection = st.selection.every((id) => id in scene.nodes)
        ? st.selection
        : st.selection.filter((id) => id in scene.nodes);
      return { scene, selection };
    }),
  setSelection: (ids) => set({ selection: ids }),
  toggleSelection: (id) =>
    set((st) => ({
      selection: st.selection.includes(id)
        ? st.selection.filter((s) => s !== id)
        : [...st.selection, id],
    })),
  clearSelection: () => set({ selection: [] }),
  setMarquee: (b) => set({ marquee: b }),
}));
