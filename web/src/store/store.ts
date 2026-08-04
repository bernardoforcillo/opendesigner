import { create as createStore } from "zustand";
import { create } from "@bufbuild/protobuf";
import { OpSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { applyOp } from "./applyOp";
import { invertOp } from "./history";
import { isReachableFrom, subtreeOf } from "./tree";
import type { PageLite, SceneState } from "./types";
import type { PenPreview } from "./vectorGeometry";
import type { Camera } from "../canvas/camera";
import type { Bounds } from "../canvas/geometry";
import type { SnapGuide } from "../selection/snap";

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

// Il testo che accompagna l'invalidazione di voci di undo/redo rese STALE da un
// op remoto (vedi markStale). Va detto per la stessa ragione per cui va detto un
// rollback: se gli stack si accorciano in silenzio, il Ctrl+Z successivo disfa
// un gesto PIÙ VECCHIO di quello che l'utente si aspetta -- che è di nuovo una
// modifica non richiesta e non spiegata. Passa da `notice` e non da `lastError`:
// nessuna modifica dell'utente è stata annullata, è la sua storia ad aver perso
// dei passi.
const STALE =
  "un'altra persona ha modificato questi elementi: i passi di annulla/ripeti che li riguardavano non sono più validi e sono stati tolti";

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
//
// `entry` è quindi una lista di GRUPPI e non di op: l'inverso di UN op può
// essere fatto di più op (un deleteNode cancella a cascata, e disfarlo vuol
// dire ricreare tutto il sottoalbero, vedi history.ts). Appiattirlo qui
// spezzerebbe proprio la corrispondenza posizionale -- `entry[i]` non
// corrisponderebbe più a un op -- e la riparazione di un gesto atterrato a
// metà rimetterebbe sullo stack la porzione sbagliata di voce. Le voci degli
// stack restano invece PIATTE (un gesto = una voce = gli op che lo disfano):
// l'appiattimento avviene al confine, quando la voce viene spinta.
// `entry` vuoto = la transizione non ha prodotto nessuna voce (invertChain
// fallito): può comunque aver svuotato il redo.
type HistoryShape =
  | { kind: "gesture"; entry: Op[][] }
  | { kind: "undo"; ops: Op[]; entry: Op[][] }
  | { kind: "redo"; ops: Op[]; entry: Op[][] };

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
// Vale per setProps e setText, e solo perché gli op di anteprima sono ASSOLUTI
// (selectTool ricalcola x/y/width/height dai bounds di inizio gesto, mai dal
// delta dell'ultimo move; il textarea di editing manda il contenuto INTERO a
// ogni tasto, mai il carattere aggiunto): un op assoluto sugli stessi campi
// riscrive per intero l'effetto del precedente. Op di mask DIVERSA restano voci
// separate -- un'anteprima di resize {width,height} non deve sparire perché ne
// arriva una di spostamento {x,y} -- e per lo stesso motivo un setText che
// porta anche lo STILE non si schiaccia con uno di solo contenuto.
// createNode/deleteNode non si coalescono affatto (chiave unica): non sono
// idempotenti fra loro e nessun tool li emette per pointermove, quindi non sono
// sull'hot path.
let previewCounter = 0;
function previewKey(op: Op): string {
  if (op.kind.case === "setProps") {
    const { id, mask } = op.kind.value;
    // Ordinata: ["x","y"] e ["y","x"] scrivono gli stessi campi.
    return `s|${id}|${[...(mask?.paths ?? [])].sort().join(",")}`;
  }
  if (op.kind.case === "setText") {
    // Una sessione di editing (ui/TextEditorOverlay.tsx) fa un applyLocal per
    // TASTO e dura quanto dura la scrittura: senza coalescing, mille caratteri
    // sono mille op di anteprima, tutti rigiocati da viewOf a ogni record
    // autorevole che atterra mentre si scrive.
    const { id, stylePresent } = op.kind.value;
    return `t|${id}|${stylePresent ? "style" : ""}`;
  }
  if (op.kind.case === "setVectorPath") {
    // Stessa sorgente del drag, e la PEGGIORE: il pen tool (e il trascinamento
    // di un ancoraggio) fa un applyLocal per POINTERMOVE, e ogni op porta i
    // subpath INTERI -- non un delta. Senza coalescing un solo trascinamento di
    // 5s a 60Hz lascia 300 op di anteprima, ognuno con tutta la geometria
    // dentro, copiati a ogni applyLocal e RIGIOCATI da viewOf a ogni record
    // autorevole che atterra a metà gesto: esattamente il quadratico che
    // previewKey esiste per evitare.
    //
    // La chiave è il solo id: setVectorPath è wholesale e ASSOLUTO (sostituisce
    // i subpath in blocco), quindi due op sullo stesso nodo scrivono per
    // definizione gli stessi campi e l'ultimo rende il precedente irrilevante.
    // Nessuna variante come lo `style` di setText: l'op È i subpath, non ne
    // porta un secondo pezzo che possa restare intatto.
    const { id } = op.kind.value;
    return `v|${id}`;
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

// --- voci rese STALE da un op remoto ---------------------------------------
// Una voce di undo/redo è fatta di inversi ASSOLUTI (un setProps porta i valori
// per intero, non un delta) calcolati su uno stato preciso: quello in cui la
// voce è stata creata. Resta valida finché i nodi che tocca non li cambia
// QUALCUN ALTRO -- gli op locali, invece, la mantengono valida per costruzione
// (un gesto spinge la propria voce sopra, un undo la consuma).
//
// Dopo una modifica remota non esiste nessun rebase sensato: due scritture
// ASSOLUTE sullo stesso campo non si fondono, una delle due vince, e far vincere
// la nostra è esattamente la sovrascrittura silenziosa da evitare (l'utente non
// ha chiesto di annullare il lavoro di un altro, ha chiesto di annullare il
// PROPRIO). L'op stale viene quindi tolto dalla voce, e l'utente lo legge dal
// banner (STALE).
//
// Granularità: per OP, non per voce intera. Un gesto multi-nodo è una voce sola
// (selectTool manda un setProps per nodo selezionato) e buttarla via tutta
// perché un altro client ha toccato UNO dei nodi renderebbe non annullabile
// anche la parte che è ancora interamente nostra. È la stessa scelta che la
// riparazione dei rollback fa già sui gesti atterrati a metà.

// Il BERSAGLIO di un op: il nodo che tocca e, per un setProps, i CAMPI che gli
// scrive. `paths: null` = tutto il nodo -- createNode e deleteNode non toccano
// un campo, toccano l'ESISTENZA del nodo, che è sotto ogni campo.
interface OpTarget {
  id: string;
  paths: readonly string[] | null;
}

function targetOf(op: Op): OpTarget | null {
  switch (op.kind.case) {
    case "createNode": {
      const node = op.kind.value.node;
      return node && node.id !== "" ? { id: node.id, paths: null } : null;
    }
    case "deleteNode": {
      const { id } = op.kind.value;
      return id === "" ? null : { id, paths: null };
    }
    case "setProps": {
      const { id, mask } = op.kind.value;
      return id === "" ? null : { id, paths: mask?.paths ?? [] };
    }
    // "text" NON è un path di FieldMask (non è in MASK_PATHS, e Go lo
    // rifiuterebbe dentro un setProps): è l'ETICHETTA del campo che un setText
    // scrive, e serve solo qui, a decidere i conflitti. Sta nello stesso spazio
    // dei nomi dei path di setProps proprio perché deve essere disgiunto da
    // TUTTI: riscrivere il contenuto e spostare il nodo sono modifiche
    // indipendenti, e un rename altrui non deve bruciare l'annullamento di una
    // sessione di editing (né viceversa).
    // Senza questo ramo un setText remoto non renderebbe stale niente e una
    // voce di undo contenente un setText non sarebbe MAI invalidata: il Ctrl+Z
    // successivo riscriverebbe in silenzio il testo di qualcun altro.
    case "setText": {
      const { id } = op.kind.value;
      return id === "" ? null : { id, paths: ["text"] };
    }
    // "subpaths" è l'ETICHETTA del campo che un setVectorPath scrive (non un
    // path di FieldMask -- Go lo rifiuterebbe dentro un setProps), esattamente
    // come "text" per setText. Senza, un setVectorPath remoto non renderebbe
    // stale niente e una voce di undo che ne contiene uno non sarebbe MAI
    // invalidata: il Ctrl+Z successivo cancellerebbe in silenzio la geometria
    // appena disegnata da un altro.
    //
    // A differenza di "text", però, l'etichetta da sola NON basta -- ed è
    // l'unico op con più di un campo nel bersaglio. Per un nodo vettoriale il
    // box È la bbox del path (invariante del proto su VectorNode), quindi
    // x/y/width/height e subpaths non sono campi indipendenti: sono due METÀ
    // dello stesso valore. Si scrivono con DUE op -- un resize è un gesto solo
    // che emette setProps{x,y,width,height} + setVectorPath (vedi
    // tools/selectTool.ts::resizeOps) -- mentre la potatura degli op stale
    // lavora per OP. Con un bersaglio ristretto a "subpaths" un record remoto
    // ne potava UNO SOLO e teneva l'altro:
    //  - un DRAG remoto (setProps{x,y}) potava l'inverso del box e teneva
    //    quello della geometria -> Ctrl+Z rimetteva l'inchiostro VECCHIO nel
    //    box nuovo;
    //  - un setVectorPath remoto potava l'inverso della geometria e teneva
    //    quello del box -> Ctrl+Z rimetteva il box VECCHIO intorno
    //    all'inchiostro dell'altro.
    // In entrambi i casi resta un nodo il cui box non è più la bbox del suo
    // path: le 8 maniglie di resize non toccano l'inchiostro (overlayRenderer
    // le disegna dal box) e il marquee afferra il vuoto.
    //
    // Il bersaglio comprende quindi il box INTERO. Su width/height è ovvio: li
    // determina. Su x/y meno, perché uno spostamento da solo non scollerebbe
    // niente -- gli ancoraggi sono LOCALI, quindi l'inchiostro viaggia col
    // nodo. Ci sono lo stesso, per due ragioni:
    //  1. sono l'unico modo di chiudere la prima traccia: là il record remoto è
    //     un setProps{x,y}, e senza x/y qui il bersaglio resta disgiunto
    //     dall'inverso della geometria, che sopravvive da solo -- cioè
    //     esattamente il mezzo undo da evitare;
    //  2. non costano un passo di annulla che non stesse già per cadere: chi
    //     riscrive i subpath manda NELLO STESSO GESTO il setProps{x,y,width,
    //     height} che rinormalizza il box (l'invariante è dello scrittore, vedi
    //     vectorGeometry.ts::normalizeVector), quindi quel secondo record
    //     avrebbe potato le stesse voci un istante dopo. Anticipare la potatura
    //     non toglie di più: toglie la FINESTRA in cui metà voce sopravvive.
    // Non è "un op remoto su questo nodo brucia tutta la sua storia": il taglio
    // per campo resta, e con un rename, l'opacità o il riempimento non c'è
    // nessun conflitto.
    //
    // Una modifica sola basta per entrambi i versi perché `conflicts` interseca
    // i due elenchi: allargato qui, il bersaglio morde sia quando il
    // setVectorPath è il record REMOTO sia quando è l'op dentro la voce (dove a
    // fargli da controparte è il setProps sul box di un altro client).
    case "setVectorPath": {
      const { id } = op.kind.value;
      return id === "" ? null : { id, paths: ["subpaths", "x", "y", "width", "height"] };
    }
    // Un reparent scrive DUE campi: il container e la posizione fra i pari.
    // Sono nello stesso spazio dei nomi dei path di setProps proprio perché
    // "order_key" è anche un path della mask (il riordino del pannello
    // livelli): un reparent remoto deve invalidare l'annullamento di un
    // riordino locale dello stesso nodo, mentre non deve toccare quello di uno
    // spostamento (x/y), che resta esatto.
    case "reparentNode": {
      const { id } = op.kind.value;
      return id === "" ? null : { id, paths: ["parent_id", "order_key"] };
    }
    // Un kind sconosciuto non ha bersaglio noto: non può invalidare niente, ma
    // non è nemmeno invalidabile (applyOp lo ignora, quindi non è mai finito in
    // una voce).
    default:
      return null;
  }
}

// I bersagli di un op, ESPANSI contro la scena su cui l'op atterra.
//
// Serve solo a deleteNode, ed è la conseguenza della cascata: l'op nomina un
// nodo ma ne porta via un SOTTOALBERO (vedi applyOp). Un op che tocca un
// discendente è quindi in conflitto con questa delete tanto quanto uno che
// tocca la radice -- senza l'espansione, un gruppo cancellato da un altro
// client lascerebbe in piedi le voci di undo che riguardano i suoi figli, e il
// Ctrl+Z successivo manderebbe al server un setProps su un nodo che non esiste
// più (rifiuto, banner rosso, voce bruciata).
//
// Per tutti gli altri kind è il bersaglio singolo di targetOf.
function targetsOf(op: Op, scene: SceneState): OpTarget[] {
  if (op.kind.case !== "deleteNode") {
    const t = targetOf(op);
    return t ? [t] : [];
  }
  const { id } = op.kind.value;
  if (id === "") return [];
  const sub = subtreeOf(scene, id);
  // Nodo già assente dalla scena data: resta il bersaglio nominato, così un op
  // di una voce (calcolata su uno stato più vecchio) continua a confliggere.
  if (sub.length === 0) return [{ id, paths: null }];
  return sub.map((n) => ({ id: n.id, paths: null }));
}

// Due op sono in CONFLITTO quando toccano lo STESSO nodo e almeno un campo in
// comune.
//
// Il taglio sui campi non è un dettaglio: senza, qualunque modifica remota a
// qualunque proprietà di un nodo cancellerebbe la storia che lo riguarda -- un
// rename altrui brucerebbe l'annullamento del tuo spostamento. Due setProps su
// mask DISGIUNTE invece non si toccano davvero: applyOp legge e scrive solo i
// path della mask, quindi l'inverso resta esatto e non c'è niente da
// sovrascrivere.
//
// L'esistenza (`paths: null`) invece confligge con tutto, in entrambi i versi:
// cancellare un nodo che un altro ha appena modificato ne butta via la modifica
// per INTERO (peggio che sovrascriverne un campo), e un nodo cancellato o
// ricreato da un altro non è più lo stato su cui l'inverso è stato calcolato.
function conflicts(a: OpTarget, b: OpTarget): boolean {
  if (a.id !== b.id) return false;
  const pa = a.paths;
  const pb = b.paths;
  if (pa === null || pb === null) return true;
  return pa.some((p) => pb.includes(p));
}

// Tutte le voci che un record remoto può rendere stale: gli stack VIVI e quelle
// custodite dai mark ancora in dubbio. I mark vanno guardati anche se non si
// vedono: le loro basi sono ciò da cui replayHistory ricostruisce gli stack al
// prossimo rifiuto, quindi un op stale lasciato lì dentro RITORNEREBBE.
function allEntries(undoStack: Op[][], redoStack: Op[][], history: HistoryMark[]): Op[][] {
  const out: Op[][] = [...undoStack, ...redoStack];
  for (const m of history) out.push(...m.undoStack, ...m.redoStack, m.shape.entry.flat());
  return out;
}

// Marca gli op resi stale da `remote`. Ritorna true se ne ha marcato almeno uno
// di nuovo.
//
// L'insieme è un WeakSet e non un Set per una ragione precisa: un op stale esce
// subito da ogni stack, quindi tenerlo in una struttura FORTE vorrebbe dire
// tenerlo vivo per tutta la sessione solo per poterlo riconoscere. Con il
// WeakSet l'appartenenza sopravvive esattamente quanto l'op che la usa (i mark
// ne tengono una copia finché sono in dubbio), e non un istante di più.
// Le due scene NON sono la stessa, e non possono esserlo: i due lati del
// confronto rispondono a due domande diverse (vedi targetsOf, che espande le
// cascate).
//  - `before` -- il confermato PRIMA di `remote` -- è il documento su cui
//    l'op remoto atterra, cioè l'unico che sa che cosa una sua deleteNode si
//    è portata via: dopo, quel sottoalbero non esiste più e l'espansione
//    ricadrebbe sul solo id nominato (le voci che toccano i FIGLI di un gruppo
//    cancellato da un altro resterebbero in piedi).
//  - `after` -- il confermato DOPO -- è invece il documento su cui atterrerà
//    il prossimo Ctrl+Z, cioè l'unico che sa che cosa una deleteNode DI UNA
//    VOCE si porterebbe via ADESSO. Un op remoto che INFILA un nodo in un
//    sottoalbero (createNode con quel parent, o un reparent verso l'interno)
//    non tocca nessun nodo che la scena precedente contenesse: guardato sul
//    documento vecchio non confligge con niente, la voce sopravvive, e il
//    Ctrl+Z successivo cancella a cascata il nodo di un ALTRO client -- in
//    silenzio, perché senza conflitto non c'è nemmeno il banner STALE.
// Il verso opposto (un remoto che PORTA VIA un nodo da un sottoalbero) è
// simmetrico e vale sul documento nuovo: la voce non lo distruggerebbe più,
// quindi non c'è niente da invalidare e il passo di annulla resta.
//
// Le voci restano comunque calcolate su stati più vecchi, quindi `after` è per
// loro un'approssimazione -- ma è quella del momento in cui verrebbero
// mandate, che è il solo momento che conta.
//
// Il confronto per BERSAGLIO non basta da solo: guarda il nodo che un op
// NOMINA, e da quando la scena è un albero un op può dipendere da un nodo che
// non nomina affatto -- il proprio CONTAINER (requiredParent). Quella
// dipendenza va confrontata con i nodi che il remoto fa SPARIRE, vedi sotto.
function markStale(
  remote: Op,
  stale: WeakSet<Op>,
  entries: Op[][],
  before: SceneState,
  after: SceneState,
): boolean {
  const targets = targetsOf(remote, before);
  if (targets.length === 0) return false;
  // I nodi che il remoto PORTA VIA dal documento: la radice nominata e tutta la
  // sua cascata (targetsOf la espande su `before`, l'unico documento che sa che
  // cosa la delete si è portata via).
  //
  // Solo una deleteNode ne fa sparire. Un reparent li lascia tutti in piedi,
  // solo altrove: ogni container che una voce pretende esiste ancora, e
  // invalidare lì sarebbe potare SENZA CAUSA -- una voce tolta per niente è un
  // passo di annulla che l'utente perde in silenzio, cioè il difetto simmetrico
  // di quello che questo controllo ripara.
  const removed = remote.kind.case === "deleteNode" ? new Set(targets.map((t) => t.id)) : null;
  let hit = false;
  for (const entry of entries) {
    for (const op of entry) {
      if (stale.has(op)) continue;
      // Il container di cui l'op ha BISOGNO è finito dentro la cascata remota:
      // l'op non potrà più atterrare (ErrParentNotFound in core.applyCreate /
      // applyReparent) per quanto il suo bersaglio sia intatto.
      //
      // È il caso che sfugge interamente al confronto per bersaglio: la voce
      // che ricrea c1 dentro g1 (l'inverso della nostra delete di c1) non nomina
      // g1 da nessuna parte, e c1 -- già fuori dal documento -- non compare
      // nella cascata che l'op remoto si porta via. Nessun conflitto, la voce
      // resta, Ctrl+Z la manda, il server la rifiuta; e siccome invertOp su di
      // lei ritorna null (il parent non esiste) non si registra nessuna voce di
      // redo, mentre revertHistory la rimette sull'undo stack: banner rosso a
      // ogni Ctrl+Z successivo, e la voce non drena mai.
      const parent = requiredParent(op);
      if (parent !== null && removed !== null && removed.has(parent)) {
        stale.add(op);
        hit = true;
        continue;
      }
      const us = targetsOf(op, after);
      if (us.some((u) => targets.some((t) => conflicts(t, u)))) {
        stale.add(op);
        hit = true;
      }
    }
  }
  return hit;
}

// L'id che un op fa ESISTERE. È l'unico modo in cui un op di una voce può
// essere il PRESUPPOSTO di un altro op della stessa voce (vedi pruneEntry).
function createdId(op: Op): string | null {
  if (op.kind.case !== "createNode") return null;
  const node = op.kind.value.node;
  return node && node.id !== "" ? node.id : null;
}

// Il container che un op PRETENDE già esistente. Sono i due op che
// core.Apply valida contro l'albero: una createNode con un parent ignoto e un
// reparent verso un parent ignoto vengono entrambi rifiutati
// (ErrParentNotFound). null = l'op non dipende da nessun container.
//
// È l'unica dipendenza di un op che il suo BERSAGLIO non dice, quindi la
// leggono i due posti che devono conoscerla: markStale (il container portato
// via da una cascata REMOTA) e pruneEntry (il container che la voce stessa non
// ricrea più).
function requiredParent(op: Op): string | null {
  if (op.kind.case === "createNode") {
    const node = op.kind.value.node;
    return node ? node.parentId : null;
  }
  if (op.kind.case === "reparentNode") return op.kind.value.newParentId;
  return null;
}

// Toglie da UNA voce gli op marcati stale -- e con loro gli op della stessa
// voce che non potrebbero più atterrare.
//
// Il filtro op-per-op da solo non basta da quando l'inverso di una delete è una
// CASCATA di createNode (history.ts): la voce che ripristina g1>c1>d1 è
// [createNode g1, createNode c1, createNode d1] e vale solo INTERA, perché ogni
// createNode pretende che il proprio parent esista già. Un op remoto che tocca
// il solo c1 marca stale la sua createNode e non quella di d1 (bersagli
// diversi, vedi targetsOf): togliere solo c1 lascerebbe una voce che viola
// esattamente l'invariante che era stata costruita per soddisfare -- Ctrl+Z
// manderebbe createNode d1 sotto un parent inesistente, il server risponde
// ErrParentNotFound e per di più invertChain, che su quella voce ritorna null,
// non registra nessuna voce di redo: banner rosso e documento a metà.
//
// La staleness si PROPAGA quindi verso il basso: tolta una createNode, cade
// tutto ciò che aveva bisogno del nodo che creava. Una sola passata in avanti
// basta perché una voce valida è già in ordine di dipendenza (subtreeOf visita
// in pre-ordine, invertChain rovescia i GRUPPI e non gli op dentro un gruppo);
// una voce che non lo fosse sarebbe già irricevibile per il server, e l'ordine
// della potatura non la peggiora.
function pruneEntry(entry: Op[], stale: WeakSet<Op>): Op[] {
  const out: Op[] = [];
  // Gli id che questa voce non farà più esistere: quelli delle createNode
  // tolte, più -- transitivamente -- quelli delle createNode cadute con loro.
  const missing = new Set<string>();
  for (const op of entry) {
    const parent = requiredParent(op);
    if (stale.has(op) || (parent !== null && missing.has(parent))) {
      const id = createdId(op);
      if (id !== null) missing.add(id);
      continue;
    }
    out.push(op);
  }
  return out;
}

// Toglie da ogni voce gli op marcati stale; una voce che resta vuota sparisce.
//
// Si applica al CONFINE -- dove uno stack diventa quello vivo -- e mai dentro i
// mark: `applyMark` allinea la voce agli op per POSIZIONE (entry[i] inverte
// l'op n-1-i) e `findConsumed` riconosce una voce per identità di riferimento,
// quindi filtrare le strutture della storia romperebbe entrambe. Filtrare in
// uscita dà lo stesso risultato senza toccare nessuna delle due.
//
// Ritorna lo STESSO array quando non c'è niente da togliere: gli stack sono
// letti da selettori zustand, e un array nuovo a ogni record remoto sveglierebbe
// la UI per niente.
function pruneStale(stack: Op[][], stale: WeakSet<Op>): Op[][] {
  if (!stack.some((entry) => entry.some((op) => stale.has(op)))) return stack;
  const out: Op[][] = [];
  for (const entry of stack) {
    const kept = pruneEntry(entry, stale);
    if (kept.length === entry.length) out.push(entry);
    else if (kept.length > 0) out.push(kept);
  }
  return out;
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
  //
  // La coda si prende sui GRUPPI e si appiattisce dopo: un gruppo è l'inverso
  // (anche multiplo) di UN op diretto, quindi tagliare sulla lista piatta
  // porterebbe via mezza cascata di ricreazione.
  const kept = shape.entry.length === n ? shape.entry.slice(n - m.kept).flat() : [];
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
function revertHistory(history: HistoryMark[], opId: string, stale: WeakSet<Op>): HistoryPatch | null {
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
  // Il replay riparte da basi fotografate PRIMA di qualunque op remoto arrivato
  // nel frattempo: senza la potatura, un rifiuto rimetterebbe sugli stack gli op
  // che quell'op remoto ha reso stale (vedi pruneStale).
  const undoStack = pruneStale(stacks.undoStack, stale);
  const redoStack = pruneStale(stacks.redoStack, stale);
  return {
    history: settleHistory(next),
    undoStack,
    redoStack,
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
  };
}

// Rimette dentro la macchina della storia la voce di undo di un rollback
// REVOCATO -- l'eco tardivo ha dimostrato che l'op era durabile (vedi apply).
//
// Scriverla direttamente su `undoStack` è corretto solo quando non c'è più
// niente in dubbio. Se una transizione è ancora in volo, gli stack VIVI non
// sono uno stato autonomo: sono il replay di `history` sulla base della sua
// TESTA (replayHistory), e il prossimo rifiuto li ricalcola da lì -- da una base
// fotografata PRIMA della revoca, che quindi la cancella di nuovo. La finestra
// è quella normale, non un'acrobazia: l'utente continua a disegnare mentre la
// pillola dice "riconnessione…", quindi quando il backlog rigioca l'op
// rinnegato c'è quasi sempre un suo gesto ancora in volo. Il risultato sarebbe
// una modifica durabile, sullo schermo e di nuovo non annullabile: lo stato
// esatto che la revoca esiste per togliere.
//
// La voce va quindi nella BASE del replay -- la testa è l'unica che
// replayHistory legge, e settleHistory la propaga in avanti quando decanta --
// e gli stack vivi si RICALCOLANO da lì. L'op revocato è atterrato sul server
// prima delle transizioni ancora in volo, quindi la sua voce finisce SOTTO le
// loro: Ctrl+Z disfa prima le più recenti, che è l'ordine giusto.
//
// `inv` null = l'inverso non esiste (il nodo non c'è più): nessuna voce da
// rimettere, ma il redo si svuota lo stesso -- l'op è avvenuto per davvero,
// quindi le voci di redo invertono uno stato che non esiste più (stessa regola
// che applyMark applica ai gesti). `inv` è una LISTA (l'inverso di un solo op
// può essere multiplo, vedi history.ts) e forma UNA voce di undo.
function restoreRevoked(
  history: HistoryMark[],
  undoStack: Op[][],
  redoStack: Op[][],
  inv: Op[] | null,
  stale: WeakSet<Op>,
): HistoryPatch {
  const entry = inv && inv.length > 0 ? inv : null;
  const head = history[0];
  if (!head) {
    const next = entry ? [...undoStack, entry] : undoStack;
    return { history, undoStack: next, redoStack: [], canUndo: next.length > 0, canRedo: false };
  }
  const patched: HistoryMark[] = [
    { ...head, undoStack: entry ? [...head.undoStack, entry] : head.undoStack, redoStack: [] },
    ...history.slice(1),
  ];
  // patched non è vuoto, quindi replayHistory non può dare null; il fallback
  // tiene comunque gli stack correnti invece di inventarne di vuoti. Potato per
  // lo stesso motivo di revertHistory: le basi sono più vecchie degli op remoti.
  const replayed = replayHistory(patched) ?? { undoStack, redoStack };
  const stacks = {
    undoStack: pruneStale(replayed.undoStack, stale),
    redoStack: pruneStale(replayed.redoStack, stale),
  };
  return {
    history: patched,
    ...stacks,
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

// La selezione potata per PAGINA: tiene solo gli id RAGGIUNGIBILI dalla pagina
// corrente, lo stesso scoping-per-pagina che il renderer applica a disegno,
// hit-test e marquee (canvasRenderer.ts::rootsOf). È l'invariante vedi-vs-
// seleziona portata sulla selezione: un nodo che un op remoto sposta su
// un'altra pagina esiste ANCORA -- quindi la sola potatura per esistenza lo
// terrebbe -- ma il canvas non lo disegna più, e lasciarlo selezionato
// disegnerebbe cornice e 8 maniglie sul vuoto (overlayRenderer.ts) e farebbe
// leggere/editare le sue proprietà al pannello alla cieca. setCurrentPage
// azzera la selezione al cambio pagina LOCALE; questo la corregge quando il
// cambio arriva da un op REMOTO (via rebuild).
//
// isReachableFrom sussume l'esistenza (un id assente non è raggiungibile da
// nulla), quindi questa rimpiazza pruneSelection dentro rebuild senza doppio
// filtro. pageId è quello RISOLTO da validCurrentPage: null solo per un
// documento senza pagine (che il core non produce), dove nulla è raggiungibile
// e la selezione si svuota -- coerente con rootsOf, che senza pagina non ha
// radici da disegnare. Riusa lo stesso array quando non cambia niente, per non
// svegliare i sottoscrittori zustand.
function pruneSelectionToPage(selection: string[], scene: SceneState, pageId: string | null): string[] {
  if (pageId === null) return selection.length === 0 ? selection : [];
  return selection.every((id) => isReachableFrom(scene, id, pageId))
    ? selection
    : selection.filter((id) => isReachableFrom(scene, id, pageId));
}

// Confronto per contenuto: serve a NON chiamare set() quando la selezione
// riconciliata coincide con quella già nello store (un set inutile sveglia
// tutti i sottoscrittori).
function sameSelection(a: string[], b: string[]): boolean {
  return a === b || (a.length === b.length && a.every((id, i) => id === b[i]));
}

// currentPageId è STATO DI VISTA (come camera e selezione), NON del documento:
// non viaggia sul filo. Ma deve restare SEMPRE valido -- il renderer disegna la
// SOLA pagina corrente (canvasRenderer.ts::rootsOf), quindi un id che non punta
// più a nessuna pagina lascerebbe il canvas vuoto e i tool a creare sotto un
// parent inesistente. Va quindi corretto a OGNI cambio di scene.pages, anche
// quando arriva da un op remoto: se la pagina corrente sparisce (DeletePage) si
// ripiega sulla PRIMA rimasta; se è ancora lì (CreatePage/RenamePage altrui,
// risync) non si tocca. null solo per un documento senza pagine -- che il core
// non produce (l'ultima pagina non si cancella, ErrLastPage).
function validCurrentPage(pages: readonly PageLite[], currentPageId: string | null): string | null {
  if (currentPageId !== null && pages.some((p) => p.id === currentPageId)) return currentPageId;
  return pages[0]?.id ?? null;
}

// Primitiva condivisa da endGesture/undo/redo: dato lo stato PRIMA che `ops`
// venga applicato, calcola l'inverso di OGNI op in sequenza (l'inverso del
// secondo op va calcolato sullo stato dopo il primo, ecc.) e ritorna la
// catena in ordine INVERSO -- così disfare gli op nell'ordine dello stack
// ripristina esattamente lo stato di partenza, un op alla volta.
// null se anche un solo op della catena non ha inverso (id sparito nel
// frattempo, kind sconosciuto...): un undo/redo PARZIALE lascerebbe la scena
// a metà strada, peggio di un gesto che semplicemente non si può annullare.
//
// Ritorna un GRUPPO per op diretto, non una lista piatta: l'inverso di un
// singolo op può essere fatto di più op (un deleteNode cancella a cascata, e
// disfarlo vuol dire ricreare l'intero sottoalbero -- vedi history.ts). I
// gruppi sono in ordine inverso rispetto a `ops`, mentre DENTRO ogni gruppo
// l'ordine è quello in cui gli op vanno applicati. È la corrispondenza
// posizionale su cui si regge la riparazione di un gesto atterrato a metà
// (vedi HistoryMark e applyMark): il gruppo i-esimo inverte l'op n-1-i.
function invertChain(scene: SceneState, ops: Op[]): Op[][] | null {
  let state = scene;
  const inverses: Op[][] = [];
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
  // Notizia NON di errore da mostrare all'utente: la revoca di un rollback
  // (vedi DisownedOp) e un incolla rifiutato perché gli appunti parlano di un
  // tipo di nodo che questa build non conosce (tools/clipboard.ts, che lo
  // scrive con setState -- non serve un'azione dedicata per un canale che la
  // UI legge e basta). Serve un canale separato da
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
  // La pagina VISUALIZZATA sul canvas, stato di vista come camera e selezione
  // (NON del documento: non è un op, non viaggia sul filo). Il renderer disegna
  // le sole radici di questa pagina; i tool creano sotto di essa. Invariante:
  // punta SEMPRE a una pagina esistente (validCurrentPage la corregge a ogni
  // cambio di scene.pages, anche remoto). null solo prima del bootstrap
  // (scene === null).
  currentPageId: string | null;
  // Invariante: selection contiene SOLO id di nodi RAGGIUNGIBILI dalla pagina
  // corrente (che è più forte di "esistono ancora in scene.nodes"). Quando un op
  // (anche remoto, via apply) fa sparire un nodo selezionato O lo sposta su
  // un'altra pagina, va tolto dalla selezione -- altrimenti cornice e maniglie
  // di resize restano "appese" a un nodo che il canvas non disegna (rebuild via
  // pruneSelectionToPage lo garantisce, come setCurrentPage per il cambio pagina
  // locale). È lo stesso scoping-per-pagina di disegno, hit-test e marquee
  // (canvasRenderer.ts::rootsOf): vedi-vs-seleziona anche per la cornice.
  selection: string[];
  // Rettangolo del marquee in corso, in coordinate MONDO (come tutto il resto
  // del modello). null quando non si sta trascinando un marquee.
  marquee: Bounds | null;
  // Le guide di allineamento ATTIVE in questo istante, in coordinate MONDO
  // (vedi selection/snap.ts). Vuoto fuori da un gesto, e vuoto durante un gesto
  // che non sta scattando su niente. È stato puramente VISIVO -- lo scatto vero
  // è già dentro gli op che il tool applica -- ma vive nello store come il
  // marquee, e per la stessa ragione: il ciclo di disegno legge da lì.
  snapGuides: SnapGuide[];
  // Il path che il pen tool sta disegnando, in coordinate MONDO (vedi
  // store/vectorGeometry.ts::PenPreview). null quando non si sta disegnando.
  //
  // Sta qui per la stessa ragione del marquee: è ANTEPRIMA, non documento. Il
  // nodo vettoriale non esiste finché il path non è finito -- l'intera
  // creazione è un gesto e produce un solo op -- quindi il path in corso non
  // può passare da `scene`, e l'overlay è l'unico posto in cui può vedersi.
  penPreview: PenPreview | null;
  // Trasporto verso il server: null finché SyncClient non si registra (test
  // isolati, bootstrap non ancora completato).
  sync: OpSink | null;
  // Gesto in corso (null = nessun gesto aperto).
  gesture: GestureSnapshot | null;
  // Id del nodo testo attualmente in editing (overlay <textarea>, Task 5), o
  // null fuori editing. Non è di per sé un gesto: la sessione di editing apre
  // il PROPRIO gesto (beginGesture) quando l'overlay monta, non quando
  // editingNodeId cambia -- textTool lo imposta subito dopo aver creato il
  // nodo (il SUO gesto di creazione è già chiuso a quel punto).
  editingNodeId: string | null;
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
  // Gli op di undo/redo che un record REMOTO ha reso non più validi (vedi
  // markStale). Non è uno stato che la UI legge: è il filtro che tiene quegli op
  // fuori dagli stack anche quando un rifiuto li rigioca da una base più vecchia
  // del record remoto. WeakSet: l'appartenenza vive quanto l'op, non quanto la
  // sessione.
  stale: WeakSet<Op>;
  setScene: (s: SceneState | null, discardedReason?: string) => void;
  setCamera: (c: Camera) => void;
  setSync: (s: OpSink | null) => void;
  // `own` = "questo record è NOSTRO", e serve solo a decidere se può invalidare
  // la storia: un op locale non la invalida mai (per costruzione la mantiene
  // valida), un op di un altro client sì. Lo passano SyncClient (che riconosce
  // i propri record dal clientId) e il ramo senza trasporto di
  // endGesture/undo/redo, dove l'op è locale e diventa confermato all'istante.
  // Il default è false: un record che arriva senza nessuna prova di essere
  // nostro va trattato come altrui -- l'errore in quella direzione toglie un
  // passo di annulla, nell'altra riscrive il lavoro di qualcun altro.
  apply: (op: Op, own?: boolean) => void;
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
  setSnapGuides: (g: SnapGuide[]) => void;
  setPenPreview: (p: PenPreview | null) => void;
  // Cambia la pagina visualizzata. AZZERA la selezione (i nodi di un'altra
  // pagina non restano selezionati) e NON è una voce di undo -- è stato di
  // vista, come spostare la camera. No-op se la pagina è già quella corrente
  // (un ri-click non deve buttare via la selezione) o se l'id non esiste (che
  // romperebbe l'invariante "sempre valido").
  setCurrentPage: (id: string) => void;
  // Accende il flag di editing: textTool lo chiama subito dopo aver creato il
  // nodo, il doppio click di selectTool lo chiama su un nodo testo esistente.
  // Se una sessione era già aperta su un ALTRO nodo, la chiude/pulisce prima
  // (stessa logica di endTextEditing, nodo vuoto compreso) -- mai due
  // sessioni aperte in silenzio, mai un nodo fantasma abbandonato a metà.
  beginTextEditing: (id: string) => void;
  // Spegne il flag e, se il nodo che si stava editando è un testo rimasto
  // VUOTO, lo elimina -- comportamento standard (non lasciare nodi fantasma
  // cliccando a vuoto, vedi Task 4 brief). La cancellazione passa da un gesto
  // come ogni altra modifica, quindi resta annullabile.
  endTextEditing: () => void;
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
  // currentPageId si corregge QUI perché ogni ricostruzione della vista (record
  // dal filo via apply, rifiuto via rejectPending) può aver cambiato scene.pages
  // -- una DeletePage remota della pagina corrente, per dire. Va risolto PRIMA
  // della selezione: quest'ultima si pota contro la pagina EFFETTIVA (quella su
  // cui si ripiega), non contro quella vecchia ormai sparita.
  const currentPageId = validCurrentPage(scene.pages, st.currentPageId);
  // Riconvalida la selezione ai soli nodi RAGGIUNGIBILI dalla pagina corrente
  // (isReachableFrom sussume l'esistenza, quindi copre anche il vecchio caso:
  // qualunque op che fa sparire un id, o un rollback che toglie un nodo appena
  // creato). Lo scoping-per-pagina è ciò che tiene la selezione in accordo con
  // ciò che il canvas disegna: un nodo che un op remoto ha spostato su un'altra
  // pagina, o che stava sulla pagina appena cancellata, esce di qui e non lascia
  // cornice/maniglie/pannello appesi al vuoto (vedi pruneSelectionToPage).
  return {
    confirmed,
    pending,
    scene,
    selection: pruneSelectionToPage(st.selection, scene, currentPageId),
    currentPageId,
  };
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
  currentPageId: null,
  selection: [],
  marquee: null,
  snapGuides: [],
  penPreview: null,
  sync: null,
  gesture: null,
  editingNodeId: null,
  undoStack: [],
  redoStack: [],
  canUndo: false,
  canRedo: false,
  history: [],
  stale: new WeakSet<Op>(),
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
  // La selezione invece si POTA (non si svuota): gli id ancora RAGGIUNGIBILI
  // dalla pagina corrente restano legittimamente selezionati -- lo stesso
  // scoping-per-pagina di rebuild (pruneSelectionToPage), non la sola esistenza,
  // altrimenti un nodo che lo snapshot mostra su un'ALTRA pagina resterebbe
  // selezionato con cornice e maniglie disegnate sul vuoto.
  //
  // `discardedReason`, se passato, è il messaggio da mostrare quando la
  // sostituzione butta via lavoro non confermato: senza, le modifiche
  // ottimistiche sparirebbero dal canvas con `lastError` nullo -- nessun banner,
  // nessuna spiegazione.
  setScene: (s, discardedReason) =>
    set((st) => {
      // Un nuovo documento può avere altre pagine: si tiene la corrente se
      // esiste ancora, altrimenti la prima. Al bootstrap (currentPageId null)
      // diventa la prima pagina del documento. Risolta PRIMA della selezione,
      // esattamente come in rebuild: quest'ultima si pota contro la pagina
      // EFFETTIVA (quella su cui il documento ripiega), non contro quella
      // vecchia ormai sparita.
      const pageId = s ? validCurrentPage(s.pages, st.currentPageId) : null;
      return {
        scene: s,
        confirmed: s,
        pending: [],
        history: [],
        undoStack: [],
        redoStack: [],
        canUndo: false,
        canRedo: false,
        // Gli op che il filtro conosceva appartenevano a voci che questa
        // sostituzione ha appena buttato via: niente da filtrare, e nessuna
        // ragione di tenerli in vita.
        stale: new WeakSet<Op>(),
        disowned: [],
        notice: null,
        // Scoping-per-pagina come rebuild (non la sola esistenza): uno snapshot
        // di resync in cui un nodo selezionato è passato a un'altra pagina lo
        // lascia esistente ma non più raggiungibile da pageId, e va tolto --
        // altrimenti cornice/maniglie/pannello restano appesi al vuoto.
        selection: s ? pruneSelectionToPage(st.selection, s, pageId) : [],
        currentPageId: pageId,
        lastError: discardedReason !== undefined && st.pending.length > 0 ? discardedReason : null,
      };
    }),
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
  apply: (op, own = false) =>
    set((st) => {
      if (!st.confirmed) return st;
      // Il confermato DOPO l'op, tenuto a portata: è la scena su cui
      // atterrerebbe il prossimo Ctrl+Z, e markStale ne ha bisogno insieme a
      // quella di prima.
      const confirmed = applyOp(st.confirmed, op);
      const next = {
        ...rebuild(st, confirmed, dropPending(st.pending, op.opId)),
        // L'op è durabile: la voce di undo che l'aveva prodotto smette di
        // essere annullabile da un rollback (vedi HistoryMark).
        history: confirmHistory(st.history, op.opId),
      };
      const i = st.disowned.findIndex((d) => d.opId === op.opId);
      if (i < 0) {
        // NOSTRO in tre modi: ce lo dice il chiamante (`own`), è ancora nella
        // nostra coda (il suo eco), oppure -- più sotto -- è un op che avevamo
        // rinnegato e che torna. Tutto il resto viene da un ALTRO client e può
        // aver reso stale delle voci di undo/redo (vedi markStale).
        // (Il controllo sulla coda prima di costruire l'elenco delle voci: un
        // eco è il caso NORMALE, e non deve pagare la scansione della storia.)
        if (own || st.pending.some((p) => p.opId === op.opId)) return next;
        const entries = allEntries(st.undoStack, st.redoStack, next.history);
        if (!markStale(op, st.stale, entries, st.confirmed, confirmed)) {
          return next;
        }
        const undoStack = pruneStale(st.undoStack, st.stale);
        const redoStack = pruneStale(st.redoStack, st.stale);
        // Marcato solo roba che vive dentro un mark: la voce è già stata
        // consumata da una transizione in volo, quindi gli stack VIVI non
        // cambiano ora e non c'è niente da annunciare -- se un rifiuto la
        // rimetterà in gioco, la rimetterà già potata.
        if (undoStack === st.undoStack && redoStack === st.redoStack) return next;
        return {
          ...next,
          undoStack,
          redoStack,
          canUndo: undoStack.length > 0,
          canRedo: redoStack.length > 0,
          notice: STALE,
        };
      }
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
      //    è esattamente quello che endGesture avrebbe messo sullo stack. La
      //    voce NON va scritta sugli stack a mano: finché una transizione è in
      //    dubbio gli stack sono il replay di `history`, e il prossimo rifiuto
      //    la ricancellerebbe (vedi restoreRevoked).
      // Il redo torna vuoto: l'op è passato per davvero, quindi le voci di redo
      // invertono uno stato che non esiste più (stessa regola di applyMark per i
      // gesti). Sulla forma: la voce ricostruita è per-op, non per-gesto -- un
      // gruppo revocato op per op lascia una voce per op invece di una sola.
      // Annullabile in più passi, ma annullabile.
      const inv = invertOp(st.confirmed, op);
      return {
        ...next,
        ...restoreRevoked(next.history, st.undoStack, st.redoStack, inv, st.stale),
        disowned: [...st.disowned.slice(0, i), ...st.disowned.slice(i + 1)],
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
        console.warn("opendesigner: submit di un op senza opId — non riconciliabile, applicato come confermato");
        return rebuild(st, applyOp(st.confirmed, op), st.pending);
      }
      // Incrementale, non ricalcolo: la vista è già confermato + coda e l'op si
      // accoda in fondo. (Un submit non può arrivare a gesto aperto --
      // endGesture chiude il gesto PRIMA di inviare e undo/redo sono no-op
      // durante un drag -- quindi non c'è anteprima da scavalcare.)
      const scene = applyOp(st.scene, op);
      // Un op OTTIMISTICO può cambiare le pagine (una CreatePage/DeletePage
      // locale prima ancora dell'eco): la pagina corrente si corregge subito,
      // come fa rebuild per i record autorevoli. Risolta PRIMA della selezione,
      // che si pota contro di essa.
      const currentPageId = validCurrentPage(scene.pages, st.currentPageId);
      return {
        scene,
        pending: [...st.pending, { opId: op.opId, op }],
        // Scoping-per-pagina come rebuild/setScene, non la sola esistenza: un op
        // locale che sposta il nodo selezionato fuori dalla pagina corrente lo
        // toglie dalla selezione. Rende l'invariante "selection ⊆ raggiungibili
        // da currentPage" airtight anche sul percorso del submit.
        selection: pruneSelectionToPage(st.selection, scene, currentPageId),
        currentPageId,
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
        ...(revertHistory(st.history, opId, st.stale) ?? {}),
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
        console.warn("opendesigner: beginGesture() con un gesto già aperto — snapshot iniziale mantenuto");
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
      console.warn("opendesigner: endGesture() senza un gesto aperto — op inviati senza ricostruzione");
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
    // `groups` tiene la corrispondenza op -> suoi inversi (vedi invertChain e
    // HistoryShape); `entry` è la stessa cosa appiattita, cioè la voce di undo
    // come la vedono gli stack.
    let groups: Op[][] = [];
    let entry: Op[] = [];
    let changedHistory = false;
    if (finalOps.length > 0) {
      groups = (base ? invertChain(base, finalOps) : null) ?? [];
      entry = groups.flat();
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
              shape: { kind: "gesture", entry: groups },
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
      // `true` = l'op è NOSTRO: senza questo verrebbe scambiato per un record
      // remoto e invaliderebbe la voce di undo che questo stesso gesto ha
      // appena spinto (vedi apply).
      if (sync) sync.submit(op);
      else get().apply(op, true);
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
  // Le guide di snap del gesto in corso. Riusa lo STESSO array quando non c'è
  // niente da mostrare e niente c'era: un gesto lungo chiama questa ad ogni
  // pointermove, e un array nuovo ogni volta sveglierebbe i sottoscrittori a
  // ogni pixel anche quando nessuno scatto è attivo.
  setSnapGuides: (g) =>
    set((st) => (g.length === 0 && st.snapGuides.length === 0 ? st : { snapGuides: g })),
  setPenPreview: (p) => set({ penPreview: p }),

  // Cambia la pagina visualizzata. NON è un op e NON è una voce di undo: è
  // stato di vista, come setCamera. Azzera la selezione (i nodi dell'altra
  // pagina non restano selezionati -- il pannello proprietà e l'overlay
  // rimarrebbero altrimenti appesi a nodi che il canvas non disegna più).
  setCurrentPage: (id) =>
    set((st) => {
      // Ri-selezionare la pagina corrente non deve buttare via la selezione.
      if (id === st.currentPageId) return st;
      // Solo una pagina che ESISTE: mantiene l'invariante "sempre valido" anche
      // se un chiamante passa un id sbagliato. A scene nulla (bootstrap non
      // ancora arrivato) si accetta comunque -- validCurrentPage la correggerà.
      if (st.scene && !st.scene.pages.some((p) => p.id === id)) return st;
      return { currentPageId: id, selection: [] };
    }),

  // Chiude/pulisce QUALUNQUE sessione già aperta PRIMA di aprirne una nuova
  // (bug trovato in review): senza questo, una seconda beginTextEditing --
  // doppio click su un ALTRO nodo testo mentre uno resta in editing, o due
  // creazioni consecutive di textTool.ts -- sovrascriveva editingNodeId in
  // silenzio, e il nodo precedente non passava MAI da endTextEditing: se era
  // rimasto vuoto restava sulla scena per sempre, un nodo fantasma permanente
  // (esattamente ciò che endTextEditing esiste per evitare quando l'utente
  // esce con Escape/click-sul-vuoto). Riusa endTextEditing così ogni FUTURO
  // chiamante (l'overlay del Task 5 incluso) lo eredita gratis, invece di
  // doversene ricordare da solo.
  // Stesso id già in editing = no-op: NON richiamare endTextEditing (che
  // cancellerebbe un nodo ancora vuoto per poi riaprirlo su un id ormai
  // sparito dalla scena).
  beginTextEditing: (id) => {
    const current = get().editingNodeId;
    if (current === id) return;
    if (current !== null) get().endTextEditing();
    set({ editingNodeId: id });
  },

  // Esce dall'editing e, se il nodo era un testo rimasto vuoto, lo cancella.
  // La cancellazione passa da beginGesture/endGesture come QUALUNQUE altra
  // modifica (stesso principio del disegno in shapeTool.ts): submittarla
  // direttamente qui la renderebbe l'unica azione dell'editor non annullabile.
  //
  // L'op non passa da tools/ops.ts::makeDeleteOp per non invertire la
  // dipendenza fra i due moduli (tools/ importa da store/, mai il contrario);
  // è comunque la stessa identica costruzione, tre campi.
  endTextEditing: () => {
    const id = get().editingNodeId;
    if (id === null) return;
    set({ editingNodeId: null });
    const scene = get().scene;
    const node = scene?.nodes[id];
    if (!node || node.kind !== "text" || (node.text?.content ?? "") !== "") return;
    const op: Op = create(OpSchema, {
      opId: crypto.randomUUID(),
      docId: scene?.id ?? "",
      kind: { case: "deleteNode", value: { id } },
    });
    get().beginGesture();
    get().endGesture([op]);
  },

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
  // Seconda guardia, stesso principio: un PATH in corso col pen tool
  // (penPreview != null) è un gesto lungo che non tiene occupato lo slot
  // `gesture` -- non tocca il documento finché non finisce, quindi tenerlo
  // aperto per minuti impedirebbe a chiunque altro di aprire il proprio (vedi
  // tools/penTool.ts::finish). Undo/redo restano comunque rimandati: a metà
  // path Ctrl+Z toglierebbe un gesto PRECEDENTE mentre l'utente sta guardando
  // il disegno in corso, cioè disferebbe qualcosa di diverso da quello che si
  // ha davanti. Basta finire o abbandonare il path (Invio/Esc) e riprovare.
  undo: () => {
    if (get().gesture || get().penPreview) return;
    const prevUndo = get().undoStack;
    const prevRedo = get().redoStack;
    const entry = prevUndo[prevUndo.length - 1];
    if (!entry) return;
    const scene = get().scene;
    // Gruppi (uno per op disfatto) per il mark, appiattiti per lo stack: vedi
    // invertChain e HistoryShape.
    const redoGroups = scene ? invertChain(scene, entry) : null;
    const redoEntry = redoGroups?.flat() ?? null;
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
              shape: { kind: "undo", ops: entry, entry: redoGroups ?? [] },
            },
          ],
        }));
      }
    }
    for (const op of entry) {
      if (sync) sync.submit(op);
      else get().apply(op, true); // nessun filo: l'op è direttamente il confermato (vedi endGesture)
    }
  },

  // Simmetrico a undo: rimanda avanti gli op che l'undo aveva disfatto, e
  // ricostruisce una nuova voce di undo per poterli ridisfare.
  // Stessa guardia di undo() sopra, stesso motivo: redo() durante un drag
  // infilerebbe i suoi op nella coda in volo, cioè nella base del gesto.
  redo: () => {
    if (get().gesture || get().penPreview) return;
    const prevUndo = get().undoStack;
    const prevRedo = get().redoStack;
    const entry = prevRedo[prevRedo.length - 1];
    if (!entry) return;
    const scene = get().scene;
    const undoGroups = scene ? invertChain(scene, entry) : null;
    const undoEntry = undoGroups?.flat() ?? null;
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
              shape: { kind: "redo", ops: entry, entry: undoGroups ?? [] },
            },
          ],
        }));
      }
    }
    for (const op of entry) {
      if (sync) sync.submit(op);
      else get().apply(op, true); // nessun filo: l'op è direttamente il confermato (vedi endGesture)
    }
  },
}));
