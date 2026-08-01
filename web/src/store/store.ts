import { create as createStore } from "zustand";
import type { Op } from "../gen/brawt/v1/brawt_pb";
import { applyOp } from "./applyOp";
import type { SceneState } from "./types";
import type { Camera } from "../canvas/camera";

interface SceneStore {
  scene: SceneState | null;
  camera: Camera;
  setScene: (s: SceneState) => void;
  setCamera: (c: Camera) => void;
  apply: (op: Op) => void;
}

export const useScene = createStore<SceneStore>((set) => ({
  scene: null,
  camera: { x: 0, y: 0, zoom: 1 },
  setScene: (s) => set({ scene: s }),
  setCamera: (c) => set({ camera: c }),
  apply: (op) => set((st) => (st.scene ? { scene: applyOp(st.scene, op) } : st)),
}));
