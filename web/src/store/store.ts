import { create as createStore } from "zustand";
import type { Op } from "../gen/brawt/v1/brawt_pb";
import { applyOp } from "./applyOp";
import { invertOp } from "./history";
import type { SceneState } from "./types";
import type { Camera } from "../canvas/camera";
import type { Bounds } from "../canvas/geometry";

// Il minimo che lo store chiede al trasporto: "manda questo op" (e applicalo in
// ottimistico). SyncClient lo soddisfa strutturalmente; i test possono passare
// un doppio senza toccare la rete, e lo store non dipende da rpc/.
export interface OpSink {
  submit(op: Op): void;
}

// Un op SUBMITTATO ma non ancora tornato indietro dal server. La chiave è
// l'opId, l'unico identificatore che sopravvive al giro (Hub clona l'Op
// verbatim dentro l'OpRecord che ribroadcasta), quindi l'unico modo che il
// client ha di riconoscere il PROPRIO eco.
export interface PendingOp {
  opId: string;
  op: Op;
}

// Stato di un gesto aperto. Non contiene più uno snapshot della scena: la base
// di un gesto è "confermato + op in volo", che si ricalcola quando serve (vedi
// viewOf) ed è sempre aggiornata, anche se nel frattempo sono arrivati record
// dal server o un op in volo è stato rifiutato.
interface GestureSnapshot {
  selection: string[];
  // Op di sola ANTEPRIMA del gesto. Non sono mai stati sul filo e non ci
  // andranno: a fine gesto il tool manda gli op FINALI e questi vengono
  // buttati. Servono a poter RICALCOLARE la vista quando un record autorevole
  // arriva a metà drag, senza far sparire l'anteprima sotto le dita
  // dell'utente.
  //
  // COALESCED per bersaglio (vedi previewKey), non accumulati uno per
  // pointermove: un drag di 5s a 60Hz su 50 nodi produce 15.000 applyLocal, e
  // una lista li terrebbe tutti e 15.000 -- copiata a ogni chiamata (quadratico
  // sull'hot path del drag) e RIGIOCATA per intero da viewOf a ogni record che
  // atterra a metà drag, con un clone completo della mappa dei nodi per op.
  // Coalescendo, l'anteprima resta grande quanto la selezione (una voce per
  // nodo e forma di mask), indipendentemente da quanto dura il drag.
  preview: ReadonlyMap<string, Op>;
}

// Chiave di COALESCING di un op di anteprima: due op con la stessa chiave
// scrivono ESATTAMENTE gli stessi campi dello stesso nodo, quindi il più
// recente rende il precedente irrilevante e può sostituirlo.
//
// Vale solo per setProps, e solo perché gli op di anteprima sono ASSOLUTI
// (selectTool ricalcola x/y/width/height dai bounds di inizio gesto, mai dal
// delta dell'ultimo move): un setProps assoluto con la stessa mask riscrive per
// intero l'effetto del precedente. Op di mask DIVERSA restano voci separate --
// un'anteprima di resize {width,height} non deve sparire perché ne arriva una
// di spostamento {x,y}. createNode/deleteNode non si coalescono affatto (chiave
// unica): non sono idempotenti fra loro e nessun tool li emette per
// pointermove, quindi non sono sull'hot path.
let previewCounter = 0;
function previewKey(op: Op): string {
  if (op.kind.case === "setProps") {
    const { id, mask } = op.kind.value;
    // Ordinata: ["x","y"] e ["y","x"] scrivono gli stessi campi.
    return `s|${id}|${[...(mask?.paths ?? [])].sort().join(",")}`;
  }
  return `#${previewCounter++}`;
}

// LA VISTA. Unica definizione della scena renderizzata:
//   confermato dal server  ->  op ancora in volo (in ordine di invio)  ->  anteprima del gesto
// Ogni riconciliazione (record dal filo, rifiuto, fine gesto) ricalcola da qui
// invece di rattoppare lo stato precedente: è ciò che rende ordine, rollback e
// rebase definiti invece che ad hoc.
function viewOf(confirmed: SceneState, pending: readonly PendingOp[], preview: Iterable<Op>): SceneState {
  let scene = confirmed;
  for (const p of pending) scene = applyOp(scene, p.op);
  for (const op of preview) scene = applyOp(scene, op);
  return scene;
}

// Toglie dalla coda la PRIMA voce con questo opId (la coda è in ordine di
// invio). Un opId vuoto non identifica niente e non deve poter far uscire dalla
// coda l'op sbagliato: in quel caso non tocca nulla.
function dropPending(pending: PendingOp[], opId: string): PendingOp[] {
  if (opId === "") return pending;
  const i = pending.findIndex((p) => p.opId === opId);
  return i < 0 ? pending : [...pending.slice(0, i), ...pending.slice(i + 1)];
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

// Primitiva condivisa da endGesture/undo/redo: dato lo stato PRIMA che `ops`
// venga applicato, calcola l'inverso di OGNI op in sequenza (l'inverso del
// secondo op va calcolato sullo stato dopo il primo, ecc.) e ritorna la
// catena in ordine INVERSO -- così disfare gli op nell'ordine dello stack
// ripristina esattamente lo stato di partenza, un op alla volta.
// null se anche un solo op della catena non ha inverso (id sparito nel
// frattempo, kind sconosciuto...): un undo/redo PARZIALE lascerebbe la scena
// a metà strada, peggio di un gesto che semplicemente non si può annullare.
function invertChain(scene: SceneState, ops: Op[]): Op[] | null {
  let state = scene;
  const inverses: Op[] = [];
  for (const op of ops) {
    const inv = invertOp(state, op);
    if (!inv) return null;
    inverses.push(inv);
    state = applyOp(state, op);
  }
  return inverses.reverse();
}

interface SceneStore {
  // La VISTA renderizzata: confermato + op in volo + anteprima del gesto (vedi
  // viewOf). Nessuno la modifica "a mano" se non passando da una delle azioni
  // qui sotto -- è sempre una funzione degli altri tre.
  scene: SceneState | null;
  // Il documento CONFERMATO: quello che il server ha applicato e riemesso su
  // Subscribe. Avanza SOLO da apply(), mai da un op ottimistico.
  confirmed: SceneState | null;
  // Op submittati e non ancora tornati indietro, in ordine di invio. Escono da
  // qui quando il loro eco arriva (confermati) o quando il server li rifiuta
  // (annullati). Finché sono qui vengono riapplicati sopra ogni nuovo
  // confermato: è il rebase.
  pending: PendingOp[];
  // Ultimo rifiuto da mostrare all'utente. Un rollback SILENZIOSO è quasi
  // peggio di nessun rollback: la modifica sparirebbe dallo schermo senza che
  // nessuno sappia perché.
  lastError: string | null;
  // Lo stream Subscribe è MORTO (errore, o chiuso dal server): messaggio da
  // mostrare, null finché è vivo. È uno stato a sé e non un `lastError` perché
  // la conseguenza è diversa e permanente: lo stream è l'UNICA cosa che
  // conferma gli op e svuota `pending` (vedi apply), quindi da qui in poi ogni
  // modifica resta ottimistica per sempre e la coda non si drena più. Il
  // server lo chiude di sua iniziativa in due casi raggiungibili -- subscriber
  // troppo lento (internal/server/hub.go) e since_seq più vecchio della
  // history compattata (CodeOutOfRange) -- quindi non è un caso ipotetico.
  // Riconnessione e resync restano fuori scope (finding "SyncClient lifecycle"):
  // qui il fallimento smette almeno di essere INVISIBILE.
  syncError: string | null;
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
  // Uno stack di UNDO/REDO, non di scene: ogni voce è un gesto intero (gli op
  // che lo disfano, uno o molti), così un drag che ha spostato dieci nodi si
  // annulla in un colpo solo. Riempiti SOLO da endGesture -- gli op remoti
  // (Subscribe di un altro client) arrivano via apply() e non toccano mai
  // questi stack, per costruzione: è così che "solo i propri op" è garantito
  // senza bisogno di etichettare gli op per provenienza.
  undoStack: Op[][];
  redoStack: Op[][];
  canUndo: boolean;
  canRedo: boolean;
  setScene: (s: SceneState | null) => void;
  setCamera: (c: Camera) => void;
  setSync: (s: OpSink | null) => void;
  apply: (op: Op) => void;
  applyPending: (op: Op) => void;
  rejectPending: (opId: string, message: string) => void;
  clearError: () => void;
  setSyncError: (message: string | null) => void;
  applyLocal: (op: Op) => void;
  beginGesture: () => void;
  endGesture: (finalOps: Op[]) => void;
  cancelGesture: () => void;
  setSelection: (ids: string[]) => void;
  toggleSelection: (id: string) => void;
  clearSelection: () => void;
  setMarquee: (b: Bounds | null) => void;
  undo: () => void;
  redo: () => void;
}

// Ricalcolo completo della vista a partire da una nuova base confermata e da
// una nuova coda. È l'unico modo in cui `scene` cambia quando la riconciliazione
// entra in gioco (record dal filo, rifiuto): niente aggiustamenti differenziali.
// L'anteprima del gesto eventualmente aperto viene rimessa in cima, così un
// record che arriva a metà drag non fa sparire il feedback locale.
function rebuild(st: SceneStore, confirmed: SceneState, pending: PendingOp[]): Partial<SceneStore> {
  const scene = viewOf(confirmed, pending, st.gesture?.preview.values() ?? []);
  // Riconvalida la selezione contro i nodi rimasti (non solo per deleteNode:
  // qualunque op che fa sparire un id -- anche futuro -- deve avere lo stesso
  // effetto), e anche contro un rollback che ha tolto un nodo appena creato.
  return { confirmed, pending, scene, selection: pruneSelection(st.selection, scene) };
}

export const useScene = createStore<SceneStore>((set, get) => ({
  scene: null,
  confirmed: null,
  pending: [],
  lastError: null,
  syncError: null,
  camera: { x: 0, y: 0, zoom: 1 },
  selection: [],
  marquee: null,
  sync: null,
  gesture: null,
  undoStack: [],
  redoStack: [],
  canUndo: false,
  canRedo: false,
  // Installa un documento: è lo snapshot autorevole di OpenDocument, quindi
  // vista e confermato COINCIDONO e non c'è nulla in volo. Unico modo sano di
  // mettere una scena nello store (e l'unico che mantiene l'invariante
  // confirmed != null <=> scene != null).
  setScene: (s) => set({ scene: s, confirmed: s, pending: [], lastError: null }),
  setCamera: (c) => set({ camera: c }),
  setSync: (s) => set({ sync: s }),

  // RECORD AUTOREVOLE, arrivato da Subscribe. Vale per gli op remoti E per il
  // proprio eco: in entrambi i casi il documento confermato avanza. Filtrare
  // gli echi per clientId (com'era in M0) significa non adottare mai la
  // versione autorevole dei propri op, quindi non conoscere mai l'ORDINE
  // deciso dal server.
  //
  // Se l'op è nostro esce dalla coda: adesso è dentro `confirmed`, lasciarlo
  // anche in `pending` vorrebbe dire riapplicarlo sopra ogni record successivo
  // (doppia applicazione, e i record altrui su quel nodo non avrebbero più
  // effetto). Il resto della coda viene riapplicato sopra la nuova base: è il
  // rebase, ed è ciò che impedisce a un record remoto di cancellare in
  // silenzio una modifica ottimistica ancora in volo.
  apply: (op) =>
    set((st) => {
      if (!st.confirmed) return st;
      return rebuild(st, applyOp(st.confirmed, op), dropPending(st.pending, op.opId));
    }),

  // SUBMIT OTTIMISTICO: l'op parte verso il server ed entra nella coda, la
  // vista lo mostra subito. Non tocca `confirmed` -- ci arriverà solo quando il
  // suo eco tornerà indietro (apply), oppure ne uscirà per sempre se il server
  // lo rifiuta (rejectPending).
  applyPending: (op) =>
    set((st) => {
      if (!st.scene || !st.confirmed) return st;
      if (op.opId === "") {
        // Senza opId l'eco è irriconoscibile: l'op resterebbe in coda per
        // sempre e ogni rebase lo riapplicherebbe sopra il documento
        // autorevole. Lo trattiamo come già confermato -- si perde il rollback
        // su rifiuto, non la modifica. Irraggiungibile dai costruttori in
        // repo: tools/ops.ts e store/history.ts stampano sempre un UUID.
        console.warn("brawt: submit di un op senza opId — non riconciliabile, applicato come confermato");
        return rebuild(st, applyOp(st.confirmed, op), st.pending);
      }
      // Incrementale, non ricalcolo: la vista è già confermato + coda e l'op si
      // accoda in fondo. (Un submit non può arrivare a gesto aperto --
      // endGesture chiude il gesto PRIMA di inviare e undo/redo sono no-op
      // durante un drag -- quindi non c'è anteprima da scavalcare.)
      const scene = applyOp(st.scene, op);
      return {
        scene,
        pending: [...st.pending, { opId: op.opId, op }],
        selection: pruneSelection(st.selection, scene),
      };
    }),

  // RIFIUTO dal server: l'op esce dalla coda e la vista si ricalcola senza di
  // lui, cioè la modifica ottimistica sparisce dallo schermo. In M0 restava lì
  // per sempre, con una sola riga di console.error, e spariva davvero solo al
  // reload successivo.
  rejectPending: (opId, message) =>
    set((st) => {
      const i = st.pending.findIndex((p) => p.opId === opId);
      // Non è (più) in coda = è GIÀ CONFERMATO: l'eco è arrivato prima che la
      // risposta HTTP fallisse (connessione caduta dopo l'append, per dire).
      // L'op è durabile: non c'è niente da annullare, e mostrare un errore
      // sarebbe una bugia.
      if (i < 0 || !st.confirmed) return st;
      const pending = [...st.pending.slice(0, i), ...st.pending.slice(i + 1)];
      return { ...rebuild(st, st.confirmed, pending), lastError: message };
    }),

  clearError: () => set({ lastError: null }),

  // Stato dello stream, scritto da SyncClient: un messaggio quando muore, null
  // quando (in futuro) una riconnessione riesce. Non azzera `pending`: quegli
  // op possono essere arrivati al server -- buttarli via inventerebbe un
  // rollback che nessuno ha chiesto. Restano in coda, visibili, in attesa di un
  // resync o di un reload.
  setSyncError: (message) => set({ syncError: message }),

  // Applica SOLO in locale: è il feedback immediato del drag, non passa dal
  // filo. Un pointermove = un applyLocal, e nessuno di questi diventa un op.
  // Dentro un gesto viene anche REGISTRATO fra le anteprime, così un ricalcolo
  // della vista (record dal filo, rifiuto) può rimetterlo in cima invece di
  // spegnere l'anteprima a metà drag.
  applyLocal: (op) =>
    set((st) => {
      if (!st.scene) return st;
      const scene = applyOp(st.scene, op);
      const next = { scene, selection: pruneSelection(st.selection, scene) };
      if (!st.gesture) return next;
      // Anteprima COALESCED: la voce con la stessa chiave viene sostituita e
      // rimessa IN FONDO (delete + set), così l'ordine di rigioco resta quello
      // dell'ultima scrittura di ogni bersaglio -- l'unica cosa che conta
      // quando due mask si sovrappongono parzialmente. Vedi previewKey per
      // perché sostituire non cambia il risultato.
      const preview = new Map(st.gesture.preview);
      const key = previewKey(op);
      preview.delete(key);
      preview.set(key, op);
      return { ...next, gesture: { ...st.gesture, preview } };
    }),

  // Apre un gesto fotografando la SELEZIONE (il punto di ripristino di Esc) e
  // azzerando l'elenco delle anteprime. La scena non va fotografata: la base
  // del gesto è "confermato + op in volo", che si ricalcola quando serve.
  beginGesture: () =>
    set((st) => {
      if (!st.scene) return st;
      if (st.gesture) {
        // Misuso (gesto già aperto): azzerare le anteprime accumulate e la
        // selezione di partenza perderebbe il vero stato di inizio gesto -- un
        // cancelGesture successivo tornerebbe a metà drag invece che al punto
        // di partenza. Teniamo il PRIMO gesto e segnaliamo il bug al chiamante.
        console.warn("brawt: beginGesture() con un gesto già aperto — snapshot iniziale mantenuto");
        return st;
      }
      return { gesture: { selection: st.selection, preview: new Map() } };
    }),

  // Chiude il gesto e manda sul filo UNA sola volta gli op finali: il documento
  // torna alla base (confermato + op ancora in volo, senza anteprime) e viene
  // ricostruito da finalOps, così le anteprime intermedie non lasciano
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
      // La base del gesto NON è una fotografia di inizio drag: è il documento
      // confermato più gli op ancora in volo, ricalcolato ADESSO. I record
      // autorevoli arrivati durante il drag ci sono già dentro (sono entrati in
      // `confirmed` via apply), le anteprime no -- è così che spariscono senza
      // lasciare residui. Un op in volo rifiutato a metà gesto è già uscito
      // dalla coda, quindi non riappare qui.
      const confirmed = get().confirmed;
      const scene = confirmed ? viewOf(confirmed, get().pending, []) : get().scene;
      // Potatura transitoria: mantiene l'invariante selection ⊆ scene.nodes
      // anche a metà flush; la riconciliazione finale la riallarga a quello
      // che il chiamante voleva davvero.
      if (scene) set((st) => ({ scene, selection: pruneSelection(st.selection, scene), gesture: null }));
      else set({ gesture: null });
    } else if (finalOps.length > 0) {
      // Misuso (endGesture senza beginGesture): non c'è nessuna base pulita da
      // cui ricostruire, quindi gli op finali si sommano a qualunque anteprima
      // sia rimasta appesa. Li mandiamo comunque (perdere il lavoro dell'utente
      // sarebbe peggio) ma il chiamante deve saperlo.
      console.warn("brawt: endGesture() senza un gesto aperto — op inviati senza ricostruzione");
    }
    // Voce di undo: gli INVERSI di finalOps, calcolati sulla base -- lo stesso
    // stato su cui finalOps stanno per atterrare (get().scene qui è già la
    // scena ribasata dal set() qui sopra, o quella corrente nel caso di
    // misuso) -- PRIMA di sottomettere qualunque op. Dopo, quello stato non
    // esiste più. Un gesto i cui inversi non esistono tutti (es. un id sparito
    // nel frattempo perché un client remoto l'ha cancellato a metà drag) non
    // produce voce: annullare a metà lascerebbe la scena in uno stato che
    // nessun redo può recuperare.
    //
    // Lo svuotamento del REDO stack invece NON è condizionato all'esistenza
    // della voce di undo (bug trovato in review): gli op finali vengono
    // submittati qui sotto in ogni caso, quindi qualunque gesto con op finali
    // ha già cambiato il documento per davvero e ha invalidato il "futuro"
    // registrato nel redo stack -- quelle voci sono inversi calcolati su uno
    // stato che non esiste più. Lasciarle lì significa che un redo successivo
    // riscrive in silenzio proprietà appena modificate dall'utente (es.
    // rimette a (40,40) un nodo appena trascinato a (999,999)) senza alcun
    // segnale. Il redo stack si svuota quindi appena il gesto ha effetto
    // reale, indipendentemente da invertChain.
    const base = get().scene;
    if (finalOps.length > 0) {
      const inverses = base ? invertChain(base, finalOps) : null;
      const entry = inverses && inverses.length > 0 ? inverses : null;
      // Niente voce da aggiungere e redo già vuoto: nessun cambiamento di
      // stato, quindi niente set() (sveglierebbe i sottoscrittori a vuoto).
      if (entry || get().redoStack.length > 0) {
        set((st) => {
          const undoStack = entry ? [...st.undoStack, entry] : st.undoStack;
          return { undoStack, redoStack: [], canUndo: undoStack.length > 0, canRedo: false };
        });
      }
    }
    const sync = get().sync;
    for (const op of finalOps) {
      // Senza trasporto registrato restiamo comunque coerenti in locale
      // invece di perdere il risultato del gesto. apply() e non applyLocal():
      // senza filo non esiste un "confermato dal server", quindi l'op È il
      // documento confermato -- un'anteprima verrebbe cancellata dal primo
      // ricalcolo della vista.
      if (sync) sync.submit(op);
      else get().apply(op);
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
      // Stessa base di endGesture: confermato + op in volo, senza anteprime.
      const scene = st.confirmed ? viewOf(st.confirmed, st.pending, []) : st.scene;
      if (!scene) return { gesture: null };
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

  // L'undo NON è un rewind dell'op-log: è altro lavoro in avanti, come da
  // design (vedi history.ts). Manda gli op invertiti tramite sync.submit
  // esattamente come farebbe un gesto normale (apply ottimistico + invio), e
  // sposta la voce nello stack opposto -- ricalcolando i SUOI inversi PRIMA di
  // sottomettere nulla, sullo stesso principio di endGesture: dopo, lo stato
  // pre-undo non esiste più.
  //
  // Guardia (bug trovato in review): se un gesto è aperto (drag in corso),
  // sync.submit farebbe entrare l'inverso nella coda degli op in volo, cioè
  // NELLA BASE del gesto. Al pointerup endGesture ricalcola quella base (ora
  // con l'inverso in mezzo) e manda op finali che possono riferirsi a un nodo
  // appena cancellato dall'undo: il drag evapora senza lasciare voce di undo e
  // il nodo sbagliato scompare. E gli inversi sono comunque calcolati sulla
  // VISTA, che a metà drag contiene le anteprime -- uno stato che non
  // esisterà più appena il gesto chiude. Rimandato: l'utente rifà Ctrl/Cmd+Z
  // dopo che il gesto chiude (pointerup/Esc).
  undo: () => {
    if (get().gesture) return;
    const entry = get().undoStack[get().undoStack.length - 1];
    if (!entry) return;
    const scene = get().scene;
    const redoEntry = scene ? invertChain(scene, entry) : null;
    set((st) => ({
      undoStack: st.undoStack.slice(0, -1),
      canUndo: st.undoStack.length - 1 > 0,
    }));
    const sync = get().sync;
    for (const op of entry) {
      if (sync) sync.submit(op);
      else get().apply(op); // nessun filo: l'op è direttamente il confermato (vedi endGesture)
    }
    if (redoEntry && redoEntry.length > 0) {
      set((st) => ({ redoStack: [...st.redoStack, redoEntry], canRedo: true }));
    }
  },

  // Simmetrico a undo: rimanda avanti gli op che l'undo aveva disfatto, e
  // ricostruisce una nuova voce di undo per poterli ridisfare.
  // Stessa guardia di undo() sopra, stesso motivo: redo() durante un drag
  // infilerebbe i suoi op nella coda in volo, cioè nella base del gesto.
  redo: () => {
    if (get().gesture) return;
    const entry = get().redoStack[get().redoStack.length - 1];
    if (!entry) return;
    const scene = get().scene;
    const undoEntry = scene ? invertChain(scene, entry) : null;
    set((st) => ({
      redoStack: st.redoStack.slice(0, -1),
      canRedo: st.redoStack.length - 1 > 0,
    }));
    const sync = get().sync;
    for (const op of entry) {
      if (sync) sync.submit(op);
      else get().apply(op); // nessun filo: l'op è direttamente il confermato (vedi endGesture)
    }
    if (undoEntry && undoEntry.length > 0) {
      set((st) => ({ undoStack: [...st.undoStack, undoEntry], canUndo: true }));
    }
  },
}));
