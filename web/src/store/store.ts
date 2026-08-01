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
// "snapshot + op autorevoli arrivati nel frattempo + op finali": le anteprime
// intermedie non fanno parte del modello.
interface GestureSnapshot {
  scene: SceneState;
  selection: string[];
  // Op AUTOREVOLI (remoti, o comunque passati dal filo) arrivati via apply()
  // mentre il gesto era aperto. Vanno riapplicati sopra lo snapshot quando il
  // gesto si chiude o si annulla: SyncClient ha già avanzato il proprio seq
  // oltre quei record (rpc/syncClient.ts) e non li rimanderà MAI, quindi
  // scartarli con il rewind significherebbe desync permanente fino al reload.
  external: Op[];
}

// Il documento "di base" a fine gesto: snapshot + op autorevoli arrivati
// durante il gesto, nello stesso ordine in cui li ha visti il server. Gli op
// finali del gesto vengono submittati DOPO, quindi l'ordine locale coincide con
// quello che il server assegnerà.
function rebase(snap: GestureSnapshot): SceneState {
  return snap.external.reduce((scene, op) => applyOp(scene, op), snap.scene);
}

// La selezione può SOLO restringersi: contiene esclusivamente id di nodi che
// esistono ancora. Se non cambia nulla riusa lo stesso array per non forzare
// re-render inutili.
function pruneSelection(selection: string[], scene: SceneState): string[] {
  return selection.every((id) => id in scene.nodes)
    ? selection
    : selection.filter((id) => id in scene.nodes);
}

// Confronto per contenuto: serve a NON chiamare set() quando la selezione
// riconciliata coincide con quella già nello store (un set inutile sveglia
// tutti i sottoscrittori).
function sameSelection(a: string[], b: string[]): boolean {
  return a === b || (a.length === b.length && a.every((id, i) => id === b[i]));
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
  // deve avere lo stesso effetto).
  return { scene, selection: pruneSelection(st.selection, scene) };
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
  // Op autorevole: viene dal filo (stream remoto o apply ottimistico di un
  // submit). Se un gesto è aperto lo registriamo anche nello snapshot: la
  // ricostruzione di fine gesto riparte dallo snapshot e senza questo elenco
  // perderebbe per sempre le modifiche arrivate durante il drag.
  apply: (op) =>
    set((st) => {
      if (!st.scene) return st;
      const next = reduce(st, op);
      if (!st.gesture) return next;
      return {
        ...next,
        gesture: { ...st.gesture, external: [...st.gesture.external, op] },
      };
    }),

  // Applica SOLO in locale: è il feedback immediato del drag, non passa dal
  // filo. Un pointermove = un applyLocal, e nessuno di questi diventa un op.
  applyLocal: (op) => set((st) => reduce(st, op)),

  // Apre un gesto fotografando lo stato: è il punto di ripristino sia per
  // l'annullamento (Esc) sia per la ricostruzione a fine gesto.
  beginGesture: () =>
    set((st) => {
      if (!st.scene) return st;
      if (st.gesture) {
        // Misuso (gesto già aperto): sovrascrivere lo snapshot perderebbe il
        // vero stato di inizio gesto -- un cancelGesture successivo tornerebbe
        // a metà drag invece che al punto di partenza. Teniamo il PRIMO
        // snapshot (e i suoi op esterni) e segnaliamo il bug al chiamante.
        console.warn("brawt: beginGesture() con un gesto già aperto — snapshot iniziale mantenuto");
        return st;
      }
      return { gesture: { scene: st.scene, selection: st.selection, external: [] } };
    }),

  // Chiude il gesto e manda sul filo UNA sola volta gli op finali: il documento
  // torna alla base (snapshot + op autorevoli arrivati durante il gesto) e
  // viene ricostruito da finalOps, così le anteprime intermedie non lasciano
  // residui (es. un resize di anteprima che l'op finale non ripete).
  // finalOps vuoto = gesto senza effetto.
  // Nota: la SELEZIONE non viene ripristinata (a differenza di cancelGesture).
  // È stato di interfaccia, e un tool può volerla cambiare durante il gesto
  // (es. selezionare il nodo appena creato) senza vedersela annullare; viene
  // solo potata, UNA volta sola e contro la scena FINALE (vedi sotto).
  endGesture: (finalOps) => {
    const snap = get().gesture;
    // La selezione VOLUTA dal chiamante alla chiusura del gesto. Può già
    // riferirsi a nodi che esisteranno solo DOPO finalOps -- è esattamente il
    // caso del tool di disegno che seleziona il nodo mentre lo sta creando.
    // Va quindi riconciliata alla FINE, contro la scena definitiva: potarla
    // contro la base ricostruita (che quei nodi non li ha ancora) la
    // svuoterebbe, e le potature intermedie di apply() possono solo
    // restringere, mai rimettere dentro un id.
    const intended = get().selection;
    // Il ripristino e gli invii sono set() distinti e sequenziali: submit
    // rientra nello store (apply ottimistico), quindi non può stare dentro
    // l'updater di un altro set.
    if (snap) {
      const scene = rebase(snap);
      // Potatura transitoria: mantiene l'invariante selection ⊆ scene.nodes
      // anche a metà flush; la riconciliazione finale la riallarga a quello
      // che il chiamante voleva davvero.
      set((st) => ({ scene, selection: pruneSelection(st.selection, scene), gesture: null }));
    } else if (finalOps.length > 0) {
      // Misuso (endGesture senza beginGesture): non c'è nessuna base pulita da
      // cui ricostruire, quindi gli op finali si sommano a qualunque anteprima
      // sia rimasta appesa. Li mandiamo comunque (perdere il lavoro dell'utente
      // sarebbe peggio) ma il chiamante deve saperlo.
      console.warn("brawt: endGesture() senza un gesto aperto — op inviati senza ricostruzione");
    }
    const sync = get().sync;
    for (const op of finalOps) {
      // Senza trasporto registrato restiamo comunque coerenti in locale
      // invece di perdere il risultato del gesto.
      if (sync) sync.submit(op);
      else get().applyLocal(op);
    }
    // Riconciliazione finale: la selezione voluta, potata contro la scena
    // realmente prodotta dal gesto. Gli id creati da finalOps ci sono ancora;
    // quelli spariti (delete remoto, o anteprima che nessun op finale ha
    // confermato) restano fuori -- niente maniglie su nodi inesistenti.
    const scene = get().scene;
    if (scene) {
      const next = pruneSelection(intended, scene);
      if (!sameSelection(next, get().selection)) set({ selection: next });
    }
  },

  // Esc / gesto abbandonato: torna allo stato di inizio gesto, selezione
  // compresa (un gesto di cancellazione l'aveva potata), e non manda nulla sul
  // filo. Annullare il PROPRIO gesto non annulla però le modifiche ALTRUI:
  // gli op autorevoli arrivati nel frattempo restano applicati.
  // cancelGesture senza gesto aperto è un no-op legittimo (Esc premuto fuori da
  // un drag), non un misuso: nessun warning.
  cancelGesture: () =>
    set((st) => {
      if (!st.gesture) return st;
      const scene = rebase(st.gesture);
      return { scene, selection: pruneSelection(st.gesture.selection, scene), gesture: null };
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
