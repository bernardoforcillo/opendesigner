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

// Lo stato del collegamento col server, nel modo in cui la UI deve poterlo
// dire all'utente:
//  - "connecting"   apertura iniziale (snapshot + subscribe) non ancora finita;
//  - "connected"    lo stream è aperto: gli op vengono confermati;
//  - "reconnecting" lo stream è caduto e il client sta ritentando da solo --
//                   le modifiche restano ottimistiche ma non sono perse;
//  - "error"        i tentativi sono finiti (o il bootstrap è fallito): da qui
//                   in poi non si riprende da soli, serve un reload.
// La differenza fra "reconnecting" e "error" è l'unica che l'utente deve
// davvero capire: nel primo caso può aspettare, nel secondo no.
export type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "error";

// Un op SUBMITTATO ma non ancora tornato indietro dal server. La chiave è
// l'opId, l'unico identificatore che sopravvive al giro (Hub clona l'Op
// verbatim dentro l'OpRecord che ribroadcasta), quindi l'unico modo che il
// client ha di riconoscere il PROPRIO eco.
export interface PendingOp {
  opId: string;
  op: Op;
}

// Un op che il CLIENT ha annullato di sua iniziativa (rollback dopo un submit
// fallito) ma il cui esito sul server era in realtà IGNOTO: Hub.Submit fa il
// broadcast PRIMA di rispondere alla unary (internal/server/hub.go), quindi una
// richiesta morta può benissimo aver lasciato l'op nell'op-log.
//
// Finché lo stream non tornava più (M0/M1a prima del ciclo di vita) la
// differenza non era osservabile: l'eco non sarebbe mai arrivato. Con la
// riconnessione ci arriva, e dice che il rollback era una BUGIA -- la modifica è
// durabile, ma l'utente ha letto "annullata" e la sua voce di undo è stata
// riavvolta. Tenere l'opId (e il messaggio che gli abbiamo mostrato) è ciò che
// permette di REVOCARE il rollback quando la prova arriva.
interface DisownedOp {
  opId: string;
  message: string;
}

// Tetto alla memoria dei rollback revocabili. Un op davvero rifiutato dal server
// non produce nessun eco, quindi la sua voce non verrebbe mai consumata: il
// tetto è ciò che le fa invecchiare invece di accumularsi per tutta la sessione.
// Stesso ordine di grandezza dell'outbox (rpc/syncClient.ts): la finestra di
// dubbio è al più lunga quanto la coda che l'ha prodotta.
const MAX_DISOWNED = 64;

// Il testo che accompagna una revoca. Non è un errore -- è il contrario: una
// modifica data per persa era in realtà salvata. Passa da `notice` e non da
// `lastError` proprio per questo (il banner rosso dice "non salvata e
// annullata": ripeterlo qui sarebbe la seconda bugia dopo la prima).
const REVOKED =
  "una modifica data per persa era in realtà stata salvata: è tornata sul canvas, con il suo annulla";

// La FORMA di una transizione degli stack: cosa ha spinto, cosa ha tolto, cosa
// ha svuotato. Tenere la forma e non solo il risultato è ciò che permette di
// RICOSTRUIRE la transizione su un PREFISSO dei suoi op -- il caso, tutt'altro
// che raro, in cui una parte del gruppo è atterrata sul server e il resto no.
//
// Tre forme, una per sorgente:
//  - "gesture": endGesture spinge `entry` (gli inversi degli op finali, in
//    ordine di stack) sull'undo e SVUOTA il redo;
//  - "undo": undo() toglie `ops` dall'undo -- sono esattamente gli op che
//    submette -- e spinge `entry` sul redo;
//  - "redo": simmetrico.
//
// In tutte e tre vale la stessa corrispondenza POSIZIONALE: `entry[i]` inverte
// l'op in posizione `n-1-i` (invertChain ritorna la catena rovesciata), quindi
// al prefisso di op sopravvissuti corrisponde la CODA di `entry`. È questa
// corrispondenza che rende la ricostruzione parziale possibile senza dover
// etichettare gli inversi uno a uno.
// `entry` vuoto = la transizione non ha prodotto nessuna voce (invertChain
// fallito): può comunque aver svuotato il redo.
type HistoryShape =
  | { kind: "gesture"; entry: Op[] }
  | { kind: "undo"; ops: Op[]; entry: Op[] }
  | { kind: "redo"; ops: Op[]; entry: Op[] };

// Una TRANSIZIONE degli stack di undo/redo prodotta da op SUBMITTATI e non
// ancora confermati.
//
// endGesture spinge la voce di undo e svuota il redo PRIMA che gli op siano
// stati accettati (deve: Ctrl+Z subito dopo un drag non può aspettare il giro
// di rete). Se poi il server li rifiuta, quella voce resta lì con inversi
// calcolati su uno stato che il server non ha MAI raggiunto: un rettangolo il
// cui createNode è stato rifiutato lascia un [deleteNode n5] in cima allo
// stack, Ctrl+Z lo consuma, il server risponde ErrNodeNotFound
// (internal/core/apply.go) -> altro rollback, altro banner, la voce è bruciata
// e il gesto PRECEDENTE -- quello vero -- non viene annullato. E il redo stack
// era già stato svuotato per una modifica mai avvenuta.
//
// Il mark tiene gli stack com'erano PRIMA della transizione più la sua forma.
// Un rifiuto abbassa `kept` e la storia viene RIGIOCATA (revertHistory), l'eco
// dell'ultimo op del gruppo la rende durabile e il mark sparisce
// (confirmHistory). È lo stesso principio di `pending` applicato alla storia:
// finché gli op sono in dubbio, lo è anche la voce di undo che hanno prodotto.
//
// Il mark NON è atomico, ed è il punto che la prima versione sbagliava: la
// politica di scarto del trasporto lavora per OP (l'outbox ne manda uno alla
// volta e un fallimento butta via solo la coda dietro), mentre i gesti
// multi-op sono la norma -- selectTool emette un setProps per nodo selezionato
// sul drag e sul resize, e un deleteNode per nodo su Canc. Riavvolgere l'intera
// voce perché l'ULTIMO op del gruppo è caduto cancella l'annullabilità della
// metà che si è invece persistita: nel caso di Canc, un nodo cancellato per
// sempre senza Ctrl+Z possibile.
interface HistoryMark {
  // TUTTI gli op submittati dalla transizione, in ORDINE DI INVIO. Immutabile:
  // è la POSIZIONE dentro questa lista a dire quanta parte della transizione
  // un rifiuto porta via.
  opIds: string[];
  // Quelli ancora in volo. L'eco li toglie uno a uno, un rifiuto toglie tutti
  // quelli dalla posizione rifiutata in poi (non arriveranno mai). A lista
  // vuota la transizione è DECISA e il mark può sparire.
  awaiting: string[];
  // Quanti op INIZIALI della transizione sono ancora validi. Parte dal totale;
  // un rifiuto lo abbassa all'indice dell'op rifiutato. I sopravvissuti sono
  // sempre un PREFISSO: l'outbox manda un op alla volta e in ordine, gli echi
  // tornano nell'ordine di seq deciso dal server, e un fallimento scarta tutta
  // la coda dietro (rpc/syncClient.ts).
  kept: number;
  // Gli stack com'erano PRIMA di questa transizione. Fanno da base al replay
  // solo per la PRIMA voce di `history`; le successive se li portano dietro
  // per poter diventare la prima quando quelle davanti si confermano.
  undoStack: Op[][];
  redoStack: Op[][];
  shape: HistoryShape;
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

// Dove sta, nello stack, la voce CONSUMATA da un mark di undo/redo.
//
// NON è "la cima": la cima è dov'era la voce quando l'undo è partito, e il
// replay rigioca i mark su stack che i mark PRECEDENTI hanno già rimaneggiato.
// Se il gesto davanti è stato riavvolto, la voce di questo undo è scesa di
// posizione (o non c'è mai stata); prendere la cima toglierebbe la voce
// SBAGLIATA -- o, su stack vuoto, ne inventerebbe una.
//
// La voce si riconosce dagli OP che contiene, per identità di riferimento: gli
// Op non vengono mai clonati dopo la costruzione, quindi `===` su un op è un
// nome stabile. Il confronto è "coda di `ops`" e non uguaglianza perché il
// replay di un mark precedente può aver RISTRETTO la voce a una sua coda (un
// gesto atterrato a metà lascia gli inversi degli op sopravvissuti, che sono la
// coda della voce) o averla semplicemente ricostruita (array nuovo, stessi op).
// Cerca dalla cima: fra due voci compatibili la più recente è quella giusta.
function findConsumed(stack: Op[][], ops: Op[]): number {
  for (let i = stack.length - 1; i >= 0; i--) {
    const slot = stack[i];
    const off = ops.length - slot.length;
    if (slot.length > 0 && off >= 0 && slot.every((op, k) => op === ops[off + k])) return i;
  }
  return -1;
}

// Rigioca UNA transizione sugli stack, RISTRETTA ai suoi primi `kept` op.
// kept === opIds.length è la transizione intera (quella che endGesture/undo/
// redo hanno già applicato); kept === 0 è l'identità, cioè "non è mai
// avvenuta"; i valori in mezzo sono il gesto atterrato a metà.
//
// Ogni forma deve essere l'IDENTITÀ a kept === 0 e componibile con le altre:
// il replay le incatena, e a un mark non è dato sapere se quelli davanti a lui
// sono stati riavvolti per intero, a metà o per niente.
function applyMark(
  m: HistoryMark,
  undoStack: Op[][],
  redoStack: Op[][],
): { undoStack: Op[][]; redoStack: Op[][] } {
  const shape = m.shape;
  const n = m.opIds.length;
  // Gli inversi degli op sopravvissuti sono la CODA della voce (entry[i]
  // inverte l'op n-1-i). Senza voce non c'è nulla da spingere; a kept === 0 la
  // coda è vuota, quindi push è già l'identità.
  const kept = shape.entry.length === n ? shape.entry.slice(n - m.kept) : [];
  const push = (stack: Op[][]) => (kept.length > 0 ? [...stack, kept] : stack);
  if (shape.kind === "gesture") {
    // Il redo resta svuotato appena UN op del gesto è passato: il documento è
    // cambiato per davvero e le voci di redo invertono uno stato che non
    // esiste più (vedi il commento in endGesture). Solo un gesto interamente
    // rifiutato se lo riprende.
    return { undoStack: push(undoStack), redoStack: m.kept > 0 ? [] : redoStack };
  }
  // Toglie dallo stack la parte di voce che questo undo/redo ha DAVVERO
  // disfatto -- i suoi primi `kept` op. Quello che resta della voce ci resta:
  // un undo atterrato a metà lascia da annullare solo quello che manca.
  //
  // A kept === 0 non è stato disfatto niente: la transizione non è avvenuta e
  // lo stack non si tocca. È il caso più frequente (il drain scarta la coda dal
  // fondo, quindi un undo che non parte viene rifiutato per intero) ed è quello
  // che, trattato come "togli la cima", cancellava la voce di un ALTRO gesto --
  // o ne spingeva una fantasma su uno stack vuoto.
  const done = new Set(shape.ops.slice(0, m.kept));
  const consume = (stack: Op[][]) => {
    if (done.size === 0) return stack;
    const i = findConsumed(stack, shape.ops);
    // La voce non c'è più (un mark davanti l'ha riavvolta insieme al gesto che
    // l'aveva prodotta): non c'è niente da consumare, e di sicuro non la cima.
    if (i < 0) return stack;
    const rest = stack[i].filter((op) => !done.has(op));
    return rest.length > 0
      ? [...stack.slice(0, i), rest, ...stack.slice(i + 1)]
      : [...stack.slice(0, i), ...stack.slice(i + 1)];
  };
  return shape.kind === "undo"
    ? { undoStack: consume(undoStack), redoStack: push(redoStack) }
    : { undoStack: push(undoStack), redoStack: consume(redoStack) };
}

// Ricalcola gli stack rigiocando OGNI transizione ancora in dubbio a partire da
// com'erano prima della più vecchia. Stessa scelta che viewOf fa per il
// documento: si RICOSTRUISCE invece di rattoppare, così una riparazione
// parziale non deve sapere niente delle transizioni che le stanno intorno e
// l'ordine in cui arrivano i rifiuti smette di contare.
// null = niente in dubbio, non c'è nessuna base da cui ripartire.
function replayHistory(history: HistoryMark[]): { undoStack: Op[][]; redoStack: Op[][] } | null {
  const head = history[0];
  if (!head) return null;
  let stacks = { undoStack: head.undoStack, redoStack: head.redoStack };
  for (const m of history) stacks = applyMark(m, stacks.undoStack, stacks.redoStack);
  return stacks;
}

// Toglie dalla TESTA le transizioni ormai decise (nessun op più in volo): il
// loro effetto viene fuso nella base della successiva, che diventa la nuova
// testa del replay. Da lì in poi nessun rifiuto può più toccarle -- è ciò che
// rende una voce di undo definitivamente durabile.
function settleHistory(history: HistoryMark[]): HistoryMark[] {
  let out = history;
  while (out.length > 0 && out[0].awaiting.length === 0) {
    const [head, ...rest] = out;
    if (rest.length === 0) return [];
    out = [{ ...rest[0], ...applyMark(head, head.undoStack, head.redoStack) }, ...rest.slice(1)];
  }
  return out;
}

// Un eco autorevole toglie l'op dall'attesa delle transizioni ancora in dubbio.
// Quando una transizione non ha più op in volo è DURABILE (vedi settleHistory).
function confirmHistory(history: HistoryMark[], opId: string): HistoryMark[] {
  if (opId === "" || !history.some((m) => m.awaiting.includes(opId))) return history;
  return settleHistory(
    history.map((m) =>
      m.awaiting.includes(opId) ? { ...m, awaiting: m.awaiting.filter((id) => id !== opId) } : m,
    ),
  );
}

// Rifiuto di un op: la parte di transizione che parte da quell'op non è mai
// avvenuta sul server. `kept` scende alla posizione dell'op rifiutato e gli
// stack si ricalcolano rigiocando la storia -- non si torna a uno snapshot.
// Tornare allo stato PRE-transizione (com'era prima) è corretto solo quando
// l'op rifiutato è il PRIMO del gruppo; per un op successivo cancellerebbe
// l'annullabilità degli op del gruppo che invece sono passati, e riarmerebbe
// un redo stack che il gesto aveva svuotato a ragione.
// null = quest'op non ha prodotto nessuna transizione (submit fuori da
// gesto/undo/redo, o transizione già confermata), oppure era già stato
// scartato: niente da annullare.
type HistoryPatch = Pick<SceneStore, "history" | "undoStack" | "redoStack" | "canUndo" | "canRedo">;
function revertHistory(history: HistoryMark[], opId: string): HistoryPatch | null {
  const i = history.findIndex((m) => m.opIds.includes(opId));
  if (i < 0) return null;
  const m = history[i];
  const kept = Math.min(m.kept, m.opIds.indexOf(opId));
  // Già fuori dal prefisso sopravvissuto: un rifiuto precedente dello stesso
  // gruppo l'ha già contato. Succede a ogni raffica -- il drain annulla la coda
  // DAL FONDO -- e ricalcolare darebbe lo stesso risultato: meglio nessun set().
  if (kept === m.kept) return null;
  const patched: HistoryMark = {
    ...m,
    kept,
    // Gli op oltre il prefisso non arriveranno mai: toglierli dall'attesa è ciò
    // che permette al mark di diventare DECISO quando la parte atterrata si
    // conferma, invece di restare appeso per sempre.
    awaiting: m.awaiting.filter((id) => m.opIds.indexOf(id) < kept),
  };
  const next = [...history.slice(0, i), patched, ...history.slice(i + 1)];
  const stacks = replayHistory(next);
  if (!stacks) return null;
  return {
    history: settleHistory(next),
    undoStack: stacks.undoStack,
    redoStack: stacks.redoStack,
    canUndo: stacks.undoStack.length > 0,
    canRedo: stacks.redoStack.length > 0,
  };
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
  // Notizia NON di errore da mostrare all'utente. Oggi ne esiste una sola: la
  // revoca di un rollback (vedi DisownedOp). Serve un canale separato da
  // `lastError` perché il messaggio dice l'OPPOSTO di quello -- "era salvata" --
  // e riusare il banner rosso vorrebbe dire annunciare una buona notizia con la
  // parola "annullata" davanti.
  notice: string | null;
  // Op annullati in locale il cui esito sul server era ignoto, in ordine di
  // rollback e con il messaggio che abbiamo mostrato. Un eco tardivo li revoca
  // (vedi apply). Bounded a MAX_DISOWNED.
  disowned: DisownedOp[];
  // Stato del collegamento col server, scritto da SyncClient. È lo stream
  // Subscribe a definirlo: è l'UNICA cosa che conferma gli op e svuota
  // `pending` (vedi apply), quindi quando non c'è ogni modifica resta
  // ottimistica e la coda non si drena più. Il server chiude lo stream di sua
  // iniziativa in due casi raggiungibili -- subscriber troppo lento
  // (internal/server/hub.go) e since_seq più vecchio della history compattata
  // (CodeOutOfRange) -- quindi non è un caso ipotetico, ed è anzi il modo in
  // cui il backend CHIEDE al client di riallinearsi.
  connection: ConnectionStatus;
  // Il perché dell'ultimo stato non-"connected": messaggio da mostrare,
  // null quando il collegamento è sano. Separato da `lastError` perché la
  // conseguenza è diversa: `lastError` è una singola modifica annullata, questo
  // è tutto il documento che smette di avanzare.
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
  // Transizioni degli stack ancora "in dubbio", in ordine di invio: una per
  // gesto/undo/redo i cui op sono stati submittati e non ancora confermati.
  // Vedi HistoryMark: è ciò che rende un rollback capace di riparare anche la
  // storia, non solo la vista.
  history: HistoryMark[];
  setScene: (s: SceneState | null, discardedReason?: string) => void;
  setCamera: (c: Camera) => void;
  setSync: (s: OpSink | null) => void;
  apply: (op: Op) => void;
  applyPending: (op: Op) => void;
  rejectPending: (opId: string, message: string, revocable?: boolean) => void;
  clearError: () => void;
  clearNotice: () => void;
  setConnection: (status: ConnectionStatus, message?: string | null) => void;
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
  notice: null,
  disowned: [],
  connection: "connecting",
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
  history: [],
  // Installa un documento: è lo snapshot autorevole di OpenDocument, quindi
  // vista e confermato COINCIDONO e non c'è nulla in volo. Unico modo sano di
  // mettere una scena nello store (e l'unico che mantiene l'invariante
  // confirmed != null <=> scene != null).
  //
  // È una SOSTITUZIONE IN BLOCCO, e da quando esiste la risincronizzazione di
  // metà sessione (CodeOutOfRange -> rpc/syncClient.ts::open) non è più solo il
  // bootstrap: tutto ciò che descriveva il documento PRECEDENTE va via insieme
  // a lui, non solo la coda.
  //  - `pending` e `history`: i mark riferiscono opId di quella coda, e senza la
  //    coda nessun eco potrebbe più confermarli;
  //  - `undoStack`/`redoStack`: le loro voci sono INVERSI calcolati su uno stato
  //    che lo snapshot ha appena buttato via. Lasciarle in piedi vuol dire un
  //    Ctrl+Z che manda il deleteNode di un nodo che qui non esiste (o che
  //    rimette a (40,40) un nodo che lo snapshot dà altrove), per di più senza
  //    più il mark che permetteva a un rifiuto di riavvolgerle;
  //  - `disowned`: gli echi che potevano revocare quei rollback appartengono a
  //    una history che il server ha compattato e non rimanderà.
  // La selezione invece si POTA (non si svuota): gli id che lo snapshot ancora
  // contiene restano legittimamente selezionati.
  //
  // `discardedReason`, se passato, è il messaggio da mostrare quando la
  // sostituzione butta via lavoro non confermato: senza, le modifiche
  // ottimistiche sparirebbero dal canvas con `lastError` nullo -- nessun banner,
  // nessuna spiegazione.
  setScene: (s, discardedReason) =>
    set((st) => ({
      scene: s,
      confirmed: s,
      pending: [],
      history: [],
      undoStack: [],
      redoStack: [],
      canUndo: false,
      canRedo: false,
      disowned: [],
      notice: null,
      selection: s ? pruneSelection(st.selection, s) : [],
      lastError: discardedReason !== undefined && st.pending.length > 0 ? discardedReason : null,
    })),
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
      const next = {
        ...rebuild(st, applyOp(st.confirmed, op), dropPending(st.pending, op.opId)),
        // L'op è durabile: la voce di undo che l'aveva prodotto smette di
        // essere annullabile da un rollback (vedi HistoryMark).
        history: confirmHistory(st.history, op.opId),
      };
      const i = st.disowned.findIndex((d) => d.opId === op.opId);
      if (i < 0) return next;
      // REVOCA DEL ROLLBACK. Questo op l'avevamo dato per perso e annullato in
      // locale, ma eccolo tornare dall'op-log: era durabile fin dall'inizio (la
      // richiesta HTTP è morta DOPO il broadcast). La vista si ripara da sola --
      // l'op entra in `confirmed` qui sopra -- ma le altre due conseguenze del
      // rollback no:
      //  - il banner ha detto "modifica non salvata e annullata": va ritirato,
      //    e solo se è ancora QUELLO (nel frattempo può essere arrivato un
      //    rifiuto vero, che non va nascosto);
      //  - la voce di undo è stata riavvolta, quindi una modifica che è sullo
      //    schermo e sul server non è più annullabile, e il prossimo Ctrl+Z
      //    disferebbe in silenzio il gesto PRECEDENTE. La ricostruiamo
      //    dall'inverso calcolato sul confermato PRIMA di applicare l'op:
      //    è esattamente quello che endGesture avrebbe messo sullo stack.
      // Il redo torna vuoto: l'op è passato per davvero, quindi le voci di redo
      // invertono uno stato che non esiste più (stessa regola di applyMark per i
      // gesti). Sulla forma: la voce ricostruita è per-op, non per-gesto -- un
      // gruppo revocato op per op lascia una voce per op invece di una sola.
      // Annullabile in più passi, ma annullabile.
      const inv = invertOp(st.confirmed, op);
      const undoStack = inv ? [...st.undoStack, [inv]] : st.undoStack;
      return {
        ...next,
        disowned: [...st.disowned.slice(0, i), ...st.disowned.slice(i + 1)],
        undoStack,
        canUndo: undoStack.length > 0,
        redoStack: [],
        canRedo: false,
        lastError: st.lastError === st.disowned[i].message ? null : st.lastError,
        notice: REVOKED,
      };
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
  //
  // `revocable` = "il server potrebbe averlo applicato lo stesso": è vero solo
  // per l'op che era DAVVERO in volo quando la richiesta è morta (vedi
  // DisownedOp). Per tutto il resto -- la coda dietro, che non è mai partita, e
  // il rifiuto per outbox piena -- non esiste nessun eco possibile, quindi
  // niente da revocare.
  rejectPending: (opId, message, revocable = false) =>
    set((st) => {
      const i = st.pending.findIndex((p) => p.opId === opId);
      // Non è (più) in coda = è GIÀ CONFERMATO: l'eco è arrivato prima che la
      // risposta HTTP fallisse (connessione caduta dopo l'append, per dire).
      // L'op è durabile: non c'è niente da annullare, e mostrare un errore
      // sarebbe una bugia.
      if (i < 0 || !st.confirmed) return st;
      const pending = [...st.pending.slice(0, i), ...st.pending.slice(i + 1)];
      // Non basta togliere l'op dalla vista: la voce di undo che questo gesto
      // aveva già spinto sullo stack (e il redo che aveva svuotato) descrivono
      // una modifica che il server non ha mai visto. Vanno riavvolti insieme
      // alla vista, altrimenti il prossimo Ctrl+Z manda l'inverso di qualcosa
      // che non esiste e brucia la voce sbagliata. Vedi HistoryMark.
      return {
        ...rebuild(st, st.confirmed, pending),
        ...(revertHistory(st.history, opId) ?? {}),
        // In coda (la più vecchia esce per prima): un op rifiutato davvero dal
        // server non riceverà mai un eco, quindi la sua voce resterebbe qui per
        // sempre se non ci fosse il tetto.
        disowned: revocable
          ? [...st.disowned, { opId, message }].slice(-MAX_DISOWNED)
          : st.disowned,
        lastError: message,
      };
    }),

  clearError: () => set({ lastError: null }),
  clearNotice: () => set({ notice: null }),

  // Stato dello stream, scritto da SyncClient. Stato e motivo si muovono
  // INSIEME (una sola set): "connected" con un messaggio di errore appeso, o
  // "reconnecting" senza motivo, sarebbero due modi di mentire alla UI.
  //
  // Non azzera `pending`: quegli op possono essere arrivati al server (Hub.Submit
  // fa broadcast PRIMA di rispondere) -- buttarli via inventerebbe un rollback
  // che nessuno ha chiesto. Restano in coda, in attesa che la riconnessione
  // rigiochi il backlog e li confermi (o che l'utente ricarichi).
  setConnection: (status, message = null) => set({ connection: status, syncError: message }),

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
    const sync = get().sync;
    // Gli stack PRIMA di questa transizione: se uno degli op finali viene poi
    // rifiutato, è qui che si torna (vedi HistoryMark).
    const prevUndo = get().undoStack;
    const prevRedo = get().redoStack;
    let entry: Op[] = [];
    let changedHistory = false;
    if (finalOps.length > 0) {
      entry = (base ? invertChain(base, finalOps) : null) ?? [];
      // Niente voce da aggiungere e redo già vuoto: nessun cambiamento di
      // stato, quindi niente set() (sveglierebbe i sottoscrittori a vuoto).
      if (entry.length > 0 || prevRedo.length > 0) {
        changedHistory = true;
        set((st) => {
          const undoStack = entry.length > 0 ? [...st.undoStack, entry] : st.undoStack;
          return { undoStack, redoStack: [], canUndo: undoStack.length > 0, canRedo: false };
        });
      }
    }
    // Il mark va registrato PRIMA di sottomettere: un submit può fallire in
    // modo SINCRONO (outbox pieno, vedi rpc/syncClient.ts) e il rollback deve
    // già trovare la transizione da riavvolgere. Senza trasporto non serve --
    // gli op diventano confermati all'istante e non c'è nulla da rifiutare.
    //
    // `opIds` tiene TUTTI gli op finali, anche quelli senza opId: è una lista
    // POSIZIONALE, e il suo indice è ciò che allinea un rifiuto alla voce di
    // undo. In attesa vanno invece solo quelli riconoscibili (un opId vuoto non
    // entra mai in `pending`, quindi nessun eco potrebbe mai toglierlo).
    if (changedHistory && sync) {
      const opIds = finalOps.map((o) => o.opId);
      const awaiting = opIds.filter((id) => id !== "");
      if (awaiting.length > 0) {
        set((st) => ({
          history: [
            ...st.history,
            {
              opIds,
              awaiting,
              kept: opIds.length,
              undoStack: prevUndo,
              redoStack: prevRedo,
              shape: { kind: "gesture", entry },
            },
          ],
        }));
      }
    }
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
    const prevUndo = get().undoStack;
    const prevRedo = get().redoStack;
    const entry = prevUndo[prevUndo.length - 1];
    if (!entry) return;
    const scene = get().scene;
    const redoEntry = scene ? invertChain(scene, entry) : null;
    // Pop dell'undo e push del redo in UN SOLO set, prima di qualunque invio:
    // il submit può rientrare nello store (apply ottimistico, e in caso di
    // rifiuto sincrono anche rejectPending, che riavvolge gli stack). Spingere
    // il redo dopo l'invio, com'era prima, significherebbe rimetterlo sopra
    // stack già riavvolti.
    set((st) => {
      const undoStack = st.undoStack.slice(0, -1);
      const redoStack = redoEntry && redoEntry.length > 0 ? [...st.redoStack, redoEntry] : st.redoStack;
      return { undoStack, redoStack, canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 };
    });
    const sync = get().sync;
    // Anche l'undo è una transizione in dubbio finché i suoi inversi non sono
    // confermati: se il server li rifiuta, la voce tornata nel redo va tolta e
    // quella consumata dall'undo va rimessa dov'era -- e se ne è passata solo
    // una parte, va rimessa la sola parte NON disfatta (vedi HistoryMark).
    if (sync) {
      const opIds = entry.map((o) => o.opId);
      const awaiting = opIds.filter((id) => id !== "");
      if (awaiting.length > 0) {
        set((st) => ({
          history: [
            ...st.history,
            {
              opIds,
              awaiting,
              kept: opIds.length,
              undoStack: prevUndo,
              redoStack: prevRedo,
              shape: { kind: "undo", ops: entry, entry: redoEntry ?? [] },
            },
          ],
        }));
      }
    }
    for (const op of entry) {
      if (sync) sync.submit(op);
      else get().apply(op); // nessun filo: l'op è direttamente il confermato (vedi endGesture)
    }
  },

  // Simmetrico a undo: rimanda avanti gli op che l'undo aveva disfatto, e
  // ricostruisce una nuova voce di undo per poterli ridisfare.
  // Stessa guardia di undo() sopra, stesso motivo: redo() durante un drag
  // infilerebbe i suoi op nella coda in volo, cioè nella base del gesto.
  redo: () => {
    if (get().gesture) return;
    const prevUndo = get().undoStack;
    const prevRedo = get().redoStack;
    const entry = prevRedo[prevRedo.length - 1];
    if (!entry) return;
    const scene = get().scene;
    const undoEntry = scene ? invertChain(scene, entry) : null;
    // Un solo set prima degli invii, stesso motivo di undo().
    set((st) => {
      const redoStack = st.redoStack.slice(0, -1);
      const undoStack = undoEntry && undoEntry.length > 0 ? [...st.undoStack, undoEntry] : st.undoStack;
      return { undoStack, redoStack, canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 };
    });
    const sync = get().sync;
    if (sync) {
      const opIds = entry.map((o) => o.opId);
      const awaiting = opIds.filter((id) => id !== "");
      if (awaiting.length > 0) {
        set((st) => ({
          history: [
            ...st.history,
            {
              opIds,
              awaiting,
              kept: opIds.length,
              undoStack: prevUndo,
              redoStack: prevRedo,
              shape: { kind: "redo", ops: entry, entry: undoEntry ?? [] },
            },
          ],
        }));
      }
    }
    for (const op of entry) {
      if (sync) sync.submit(op);
      else get().apply(op); // nessun filo: l'op è direttamente il confermato (vedi endGesture)
    }
  },
}));
