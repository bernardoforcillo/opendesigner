import { create as createStore } from "zustand";
import type { Op } from "../gen/brawt/v1/brawt_pb";
import { applyOp } from "./applyOp";
import type { SceneState } from "./types";
import type { Camera } from "../canvas/camera";
import type { Bounds } from "../canvas/geometry";

// Il minimo che lo store chiede al trasporto: "manda questo op" (e applicalo in
// ottimistico). SyncClient lo soddisfa strutturalmente; i test possono passare
// un doppio senza toccare la rete, e lo store non dipende da rpc/.
export interface OpSink {
  submit(op: Op): void;
}

// Snapshot catturato a inizio gesto. Il documento durante un drag è sempre
// "snapshot + op finali": le anteprime intermedie non fanno parte del modello.
interface GestureSnapshot {
  scene: SceneState;
  selection: string[];
}

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
  // Trasporto verso il server: null finché SyncClient non si registra (test
  // isolati, bootstrap non ancora completato).
  sync: OpSink | null;
  // Gesto in corso (null = nessun gesto aperto).
  gesture: GestureSnapshot | null;
  setScene: (s: SceneState) => void;
  setCamera: (c: Camera) => void;
  setSync: (s: OpSink | null) => void;
  apply: (op: Op) => void;
  applyLocal: (op: Op) => void;
  beginGesture: () => void;
  endGesture: (finalOps: Op[]) => void;
  cancelGesture: () => void;
  setSelection: (ids: string[]) => void;
  toggleSelection: (id: string) => void;
  clearSelection: () => void;
  setMarquee: (b: Bounds | null) => void;
}

// Riduttore condiviso da apply (op che arrivano dal filo) e applyLocal
// (anteprima durante un gesto): stessa semantica, due punti d'ingresso con
// intenzioni diverse.
function reduce(st: SceneStore, op: Op): Partial<SceneStore> {
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
}

export const useScene = createStore<SceneStore>((set, get) => ({
  scene: null,
  camera: { x: 0, y: 0, zoom: 1 },
  selection: [],
  marquee: null,
  sync: null,
  gesture: null,
  setScene: (s) => set({ scene: s }),
  setCamera: (c) => set({ camera: c }),
  setSync: (s) => set({ sync: s }),
  apply: (op) => set((st) => reduce(st, op)),

  // Applica SOLO in locale: è il feedback immediato del drag, non passa dal
  // filo. Un pointermove = un applyLocal, e nessuno di questi diventa un op.
  applyLocal: (op) => set((st) => reduce(st, op)),

  // Apre un gesto fotografando lo stato: è il punto di ripristino sia per
  // l'annullamento (Esc) sia per la ricostruzione a fine gesto.
  beginGesture: () =>
    set((st) => {
      if (!st.scene) return st;
      return { gesture: { scene: st.scene, selection: st.selection } };
    }),

  // Chiude il gesto e manda sul filo UNA sola volta gli op finali: il documento
  // torna allo snapshot e viene ricostruito da finalOps, così le anteprime
  // intermedie non lasciano residui (es. un resize di anteprima che l'op finale
  // non ripete). finalOps vuoto = gesto senza effetto.
  // Nota: la SELEZIONE non viene ripristinata (a differenza di cancelGesture).
  // È stato di interfaccia, e un tool può volerla cambiare durante il gesto
  // (es. selezionare il nodo appena creato) senza vedersela annullare.
  endGesture: (finalOps) => {
    const snap = get().gesture;
    // Il ripristino e gli invii sono set() distinti e sequenziali: submit
    // rientra nello store (apply ottimistico), quindi non può stare dentro
    // l'updater di un altro set.
    if (snap) set({ scene: snap.scene, gesture: null });
    const sync = get().sync;
    for (const op of finalOps) {
      // Senza trasporto registrato restiamo comunque coerenti in locale
      // invece di perdere il risultato del gesto.
      if (sync) sync.submit(op);
      else get().applyLocal(op);
    }
  },

  // Esc / gesto abbandonato: torna esattamente allo stato di inizio gesto,
  // selezione compresa (un gesto di cancellazione l'aveva potata), e non manda
  // nulla sul filo.
  cancelGesture: () =>
    set((st) => {
      if (!st.gesture) return st;
      return { scene: st.gesture.scene, selection: st.gesture.selection, gesture: null };
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
