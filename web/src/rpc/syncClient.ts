import { ConnectError } from "@connectrpc/connect";
import type { Op } from "../gen/brawt/v1/brawt_pb";
import { docClient } from "./client";
import { useScene } from "../store/store";
import { fromDocument } from "../store/types";

// DEADLINE del singolo SubmitOp. createConnectTransport non ne ha una di
// default (rpc/client.ts) e con l'outbox serializzato una fetch che non si
// risolve MAI non perde più solo se stessa: blocca il drain, e ogni gesto
// successivo viene applicato in ottimistico, accodato e mai spedito. Un handler
// bloccato, una connessione TCP finita nel nulla o un laptop che va in
// sospensione producono esattamente questo, per minuti o per sempre.
//
// La deadline sta sulla CHIAMATA e non su `defaultTimeoutMs` del trasporto:
// quest'ultimo varrebbe anche per Subscribe, che è uno stream long-lived e deve
// poter restare aperto per ore. 10s sono un ordine di grandezza sopra un
// SubmitOp sano (append su op-log locale + broadcast) e ben sotto la soglia in
// cui l'utente ha già disegnato mezza pagina sopra un backlog invisibile.
const SUBMIT_TIMEOUT_MS = 10_000;

// Tetto alla coda: quanto lavoro può essere a rischio contemporaneamente.
// Con la deadline sopra il backlog è già limitato nel TEMPO; questo lo limita
// anche nella QUANTITÀ, perché è la quantità che l'utente perde tutta insieme
// se la richiesta in testa fallisce davvero. 64 è largo rispetto a una raffica
// di gesti reali (il coalescing di M1a riduce un drag intero a un op) e stretto
// rispetto a "cresce finché c'è memoria".
// Esportata perché il test del tetto lo verifichi senza ricopiarne il valore.
export const MAX_OUTBOX = 64;

// Il client tiene lo stato CONFERMATO (quello che il server ha applicato e
// riemesso) più gli op PENDING (submittati, non ancora tornati indietro). La
// vista è confermato + pending. Ogni record che arriva da Subscribe fa avanzare
// il confermato e la vista viene ricalcolata: è questo che rende ordine,
// rollback e rebase definiti invece che ad hoc.
//
// Lo split vive nello store (store/store.ts) perché è lo store a possedere la
// vista e i gesti; SyncClient è solo il cablaggio fra il trasporto e i tre
// ingressi del modello: applyPending (submit), apply (record autorevole),
// rejectPending (rifiuto).
export class SyncClient {
  private seq = 0;
  // OUTBOX: gli op ancora da mandare, in ordine di invio. Il primo elemento è
  // quello in volo (o il prossimo a partire); ne parte UNO ALLA VOLTA.
  //
  // Il seq lo assegna il SERVER in ordine di ARRIVO (internal/server/hub.go:
  // Submit serializza sul mutex e chi entra prima prende il seq più basso).
  // Finché i submit erano fire-and-forget, l'ordine persistito era quello con
  // cui le richieste raggiungevano l'hub -- deciso dallo scheduler, non
  // dall'utente: due unary partite insieme sono due goroutine indipendenti
  // anche sulla stessa connessione multiplexata. Con op19 = x=100 e op20 =
  // x=200 emessi insieme, l'oplog poteva finire [x=200, x=100], il documento
  // ricaricato a x=100 e il canvas a x=200. Non c'è nulla nel protocollo che
  // possa accorgersene: SubmitOpRequest porta solo doc_id/client_id/op.
  //
  // La coda è normalmente corta -- il coalescing di M1a riduce un intero drag a
  // un solo op finale (store.endGesture) -- quindi qui la correttezza ovvia
  // vale più del throughput: nessuna pipeline, nessun batching.
  private outbox: Op[] = [];
  private draining = false;

  constructor(private docId: string, private clientId: string) {
    // Lo store deve poter mandare op da solo (fine gesto, e in seguito undo):
    // il client si registra come trasporto appena esiste, così l'app non deve
    // ricordarsi di collegarli a mano.
    useScene.getState().setSync(this);
  }

  submit(op: Op) {
    // Apply OTTIMISTICO: entra nella coda degli op in volo e si vede subito.
    // Non è ancora confermato: lo diventerà quando il suo eco tornerà da
    // Subscribe. Resta SINCRONO -- è solo l'invio che viene serializzato, il
    // feedback sullo schermo no.
    useScene.getState().applyPending(op);
    if (this.outbox.length >= MAX_OUTBOX) {
      // Coda satura: la testa non si muove da un pezzo. Rifiutiamo il NUOVO op
      // invece di buttare via quelli già accodati -- sono l'intento più
      // vecchio, e potrebbero partire da un momento all'altro. Il rifiuto passa
      // dalla stessa porta di un rifiuto del server (applyPending seguito da
      // rejectPending): stesso rollback della vista, stesso riavvolgimento
      // della voce di undo, stesso banner. Un op che non parte deve costare
      // esattamente come un op che parte e viene respinto.
      useScene.getState().rejectPending(
        op.opId,
        `troppe modifiche in attesa (${MAX_OUTBOX}): il server non sta rispondendo`,
      );
      return;
    }
    this.outbox.push(op);
    void this.drain();
  }

  // L'op è ancora nella coda degli op in volo dello store? Se NON c'è più, il
  // suo eco è già arrivato da Subscribe: il server l'ha applicato e messo
  // nell'op-log, quindi è DURABILE anche se la risposta HTTP non è mai tornata.
  // Hub.Submit fa broadcast ai subscriber PRIMA di scrivere la risposta
  // (internal/server/hub.go), quindi questa finestra non è teorica.
  //
  // Un opId vuoto non entra mai in `pending` (applyPending lo tratta come già
  // confermato): non distinguerebbe i due casi, quindi si sceglie la lettura
  // prudente -- "non atterrato". `confirmed` nullo vuol dire store non ancora
  // inizializzato: idem.
  private landed(op: Op): boolean {
    const st = useScene.getState();
    if (op.opId === "" || !st.confirmed) return false;
    return !st.pending.some((p) => p.opId === op.opId);
  }

  // Svuota l'outbox una richiesta alla volta. Rientrante-sicura: `draining` fa
  // sì che esista un solo drain vivo, quindi un submit fatto mentre una
  // richiesta è in volo si limita ad accodarsi e verrà preso dal giro corrente.
  private async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.outbox.length > 0) {
        const op = this.outbox[0];
        try {
          await docClient.submitOp(
            { docId: this.docId, clientId: this.clientId, op },
            { timeoutMs: SUBMIT_TIMEOUT_MS },
          );
          // L'Ack della unary NON conferma nulla: porta solo il seq assegnato.
          // La conferma vera è l'eco su Subscribe, l'unico punto in cui il
          // client conosce l'ORDINE che il server ha deciso rispetto agli op
          // altrui. Qui serve solo a sapere che è arrivato, cioè che il
          // prossimo può partire senza scavalcarlo.
          this.outbox.shift();
        } catch (err) {
          // POLITICA IN CASO DI FALLIMENTO: la coda si FERMA e si svuota.
          // L'op fallito esce dalla vista (rollback, come già faceva il .catch
          // di prima), e con lui TUTTI quelli ancora in coda dietro: sono stati
          // costruiti su uno stato che includeva il suo effetto, cioè su una
          // premessa che il server non ha mai raggiunto. Mandarli comunque
          // persisterebbe una modifica basata su un documento che non esiste
          // (es. un setProps su un nodo la cui createNode è appena stata
          // rifiutata). Meglio perdere le modifiche, visibilmente, che
          // scriverne di incoerenti in silenzio.
          //
          // Lo stop è della CODA, non del client: dopo il rollback la vista
          // torna a "confermato + op davvero accettati", quindi un submit
          // successivo è di nuovo costruito su una premessa vera e parte
          // normalmente. Latchare per sempre al primo InvalidArgument (un id
          // duplicato, per dire) congelerebbe l'editor senza motivo.
          //
          // E vale solo se la premessa è DAVVERO falsa: `landed()` qui sotto è
          // il caso in cui non lo è.
          const message = ConnectError.from(err).message;
          console.error("submitOp failed", err);
          if (this.landed(op)) {
            // La richiesta è morta DOPO che il server aveva applicato e
            // ribroadcastato l'op: l'eco è già arrivato, l'op è durabile. La
            // premessa della coda dietro ("il predecessore è sul server") è
            // quindi VERA e fermarla butterebbe via lavoro valido mostrando un
            // errore per un op riuscito. Si prosegue: niente rollback, nessun
            // banner, solo la riga di log.
            this.outbox.shift();
            continue;
          }
          const dropped = this.outbox.splice(0, this.outbox.length);
          // Dal fondo: così nessuno stato intermedio mostra un op applicato
          // sopra una base a cui manca il suo predecessore.
          for (let i = dropped.length - 1; i >= 0; i--) {
            useScene.getState().rejectPending(dropped[i].opId, message);
          }
        }
      }
    } finally {
      this.draining = false;
    }
  }

  async start() {
    const open = await docClient.openDocument({ docId: this.docId });
    // Lo snapshot di OpenDocument è per definizione confermato: setScene
    // allinea vista e confermato e svuota la coda.
    if (open.snapshot) useScene.getState().setScene(fromDocument(open.snapshot));
    this.seq = Number(open.seq);

    useScene.getState().setSyncError(null);
    // consuma lo stream in background: start() deve risolversi subito dopo
    // aver caricato lo snapshot, senza attendere la subscription per sempre.
    void this.run();
  }

  // Lo stream è l'UNICA cosa che fa avanzare il confermato e che svuota la coda
  // degli op in volo: se muore, ogni gesto successivo si accoda a `pending` e
  // NIENTE lo toglie più da lì. Il server lo chiude di sua iniziativa in due
  // casi raggiungibili -- subscriber troppo lento (l'hub chiude il canale) e
  // since_seq più vecchio della history compattata (CodeOutOfRange) -- quindi
  // `void this.consume()` senza catch non era "difensivo": era la fine dello
  // stream che diventava una unhandled rejection, con la pillola di stato che
  // continuava a dire "connesso".
  //
  // Qui non c'è ancora riconnessione (finding a parte: niente abort, niente
  // resync, niente gap detection): c'è la garanzia MINIMA che il fallimento sia
  // osservabile, in console e nella UI.
  private async run() {
    let message: string;
    try {
      await this.consume();
      // for-await finito senza errore: il server ha chiuso lo stream. Non è
      // meno grave di un errore -- da qui in poi non arriva più nessun record.
      message = "il server ha chiuso lo stream degli aggiornamenti";
      console.error("subscribe stream closed by the server");
    } catch (err) {
      message = ConnectError.from(err).message;
      console.error("subscribe stream failed", err);
    }
    useScene.getState().setSyncError(message);
  }

  private async consume() {
    for await (const msg of docClient.subscribe({
      docId: this.docId,
      clientId: this.clientId,
      sinceSeq: BigInt(this.seq),
    })) {
      if (msg.kind.case === "applied") {
        const rec = msg.kind.value;
        // ANCHE i propri echi. Scartarli per clientId (com'era in M0) vuol dire
        // non adottare mai la versione autorevole dei propri op: il client non
        // sa mai come il server li ha ordinati rispetto a quelli altrui, e i
        // suoi op restano ottimistici per sempre. È l'eco che li conferma --
        // store.apply li toglie dalla coda proprio in base all'opId, quindi
        // l'op non viene applicato due volte.
        if (rec.op) useScene.getState().apply(rec.op);
        this.seq = Number(rec.seq);
      }
    }
  }
}
