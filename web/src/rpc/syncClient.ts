import { Code, ConnectError } from "@connectrpc/connect";
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

// RICONNESSIONE. Lo stream Subscribe non è un extra: è l'unico canale che fa
// avanzare il documento confermato e che svuota la coda degli op in volo. Il
// backend lo CHIUDE di sua iniziativa quando un subscriber resta indietro
// (internal/server/hub.go: canale pieno -> endSubscriberLocked) proprio perché
// il client si riconnetta con since_seq all'ultimo record applicato e si
// recuperi il backlog: senza riconnessione quel disegno non funziona, e la
// prima raffica un po' fitta stacca il client per il resto della sessione.
//
// Backoff esponenziale, senza jitter: qui c'è un solo browser per utente contro
// un server locale, non una flotta che può sincronizzarsi in un thundering
// herd, e un ritardo deterministico è quello che rende i test una specifica
// invece di una scommessa.
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;
// Tetto ai tentativi CONSECUTIVI senza progresso. Ritentare per sempre
// consumerebbe batteria e, soprattutto, nasconderebbe un problema vero dietro
// una pillola che dice "riconnessione" da mezz'ora: a un certo punto la
// risposta onesta è "non ce la faccio da solo, ricarica".
const MAX_RECONNECT_ATTEMPTS = 6;
// Uno stream vissuto almeno così a lungo conta come progresso anche se non ha
// consegnato nemmeno un record: un documento fermo (nessuno sta disegnando) è
// silenzioso per definizione, e senza questa clausola sei cadute di rete
// sparse in una giornata di lavoro basterebbero a dichiarare morto un
// collegamento che invece si riprende ogni volta.
const RECONNECT_STABLE_MS = 60_000;

function backoffMs(attempt: number): number {
  return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (attempt - 1));
}

const CLOSED_BY_SERVER = "il server ha chiuso lo stream degli aggiornamenti";
const SEQUENCE_GAP = "buco nella sequenza degli aggiornamenti";

// Messaggio del rollback quando lo snapshot autorevole rimpiazza il documento a
// metà sessione: la coda in volo non è più collocabile e sparisce dal canvas.
// Senza un messaggio l'utente vedrebbe le proprie modifiche svanire con la
// pillola su "connesso" e nessuna spiegazione da nessuna parte.
const RESYNCED =
  "il server ha risincronizzato il documento e le modifiche non ancora confermate sono andate perse";

// Messaggio del rifiuto quando il client si è arreso: da qui in poi nessun op
// può più essere confermato, quindi accettarlo vorrebbe dire tenerlo sullo
// schermo (e in coda) fino al reload che lo cancellerà.
const GAVE_UP = "connessione al server persa: ricarica la pagina per riprendere a lavorare";

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

  // --- ciclo di vita ---------------------------------------------------------
  // `started` rende start() idempotente: React in StrictMode invoca l'effetto di
  // bootstrap due volte, e una seconda subscription vorrebbe dire due goroutine
  // sul server e OGNI record applicato due volte nello stesso store globale.
  // `stopped` è definitivo: un client fermato non riparte (se ne costruisce uno
  // nuovo), così una cleanup di React non può mai lasciare in giro un loop che
  // continua a scrivere nello store di una app smontata.
  private started = false;
  private stopped = false;
  // GENERAZIONE del documento. Cambia a ogni risincronizzazione (open() dal ramo
  // CodeOutOfRange): lo snapshot sostituisce il documento in blocco e svuota
  // `pending`, quindi tutto ciò che era in volo appartiene a un mondo che non
  // esiste più. Una richiesta partita nella generazione precedente non deve poter
  // decidere niente quando torna -- né togliere la testa dalla coda (che nel
  // frattempo è un ALTRO op) né, peggio, leggere `pending` per dedurre se è
  // atterrata: dopo un resync `pending` è vuoto e `landed()` direbbe "sì" per
  // qualunque op, riaprendo la strada agli op costruiti su una premessa che il
  // server non ha mai raggiunto.
  private epoch = 0;
  // Il client si è arreso (tentativi di riconnessione esauriti). Non è `stopped`:
  // il posto di trasporto nello store resta NOSTRO -- toglierlo farebbe prendere
  // a endGesture il ramo senza filo (`get().apply(op)`), che applica le modifiche
  // in locale come se fossero confermate e non le manda a nessuno. Qui invece
  // ogni submit viene RIFIUTATO visibilmente: stesso rollback e stesso banner di
  // un rifiuto del server.
  private givenUp = false;
  // Il controller della subscription CORRENTE: è il solo modo di chiudere
  // davvero la richiesta HTTP: senza abort la fetch resta aperta, il server
  // continua a tenere il subscriber registrato e il for-await non finisce mai.
  private controller: AbortController | null = null;
  // Sveglia anticipata dell'attesa di backoff, così stop() è immediato e non
  // deve aspettare fino a 10s prima di avere effetto.
  private wake: (() => void) | null = null;
  // Tentativi consecutivi SENZA progresso (vedi RECONNECT_STABLE_MS).
  private attempts = 0;

  // Costruire un client non ha effetti: la registrazione come trasporto avviene
  // in start() (vedi lì il perché).
  constructor(private docId: string, private clientId: string) {}

  submit(op: Op) {
    if (this.stopped) {
      // Client staccato: la coda non parte più e lo store, in StrictMode, è
      // già di un ALTRO client. Applicare in ottimistico lascerebbe un op in
      // `pending` per sempre -- visibile sulla scena, non inviato a nessuno e
      // impossibile da confermare, perché l'unico stream vivo è quello del
      // client nuovo, che di questo op non sa niente.
      console.warn("brawt: submit su un SyncClient fermato — op ignorato", op.opId);
      return;
    }
    // Apply OTTIMISTICO: entra nella coda degli op in volo e si vede subito.
    // Non è ancora confermato: lo diventerà quando il suo eco tornerà da
    // Subscribe. Resta SINCRONO -- è solo l'invio che viene serializzato, il
    // feedback sullo schermo no.
    useScene.getState().applyPending(op);
    if (this.givenUp) {
      // Arreso: lo stream non tornerà più, quindi NIENTE potrà più confermare
      // questo op. Mandarlo comunque lo farebbe applicare in modo durabile sul
      // server mentre qui resta per sempre in `pending` -- rigiocato da viewOf a
      // ogni aggiornamento dello store (quadratico sulla lunghezza della
      // sessione) e con un mark di storia che non si deciderà mai. Rifiutarlo
      // costa una modifica; accettarlo costa la sessione.
      useScene.getState().rejectPending(op.opId, GAVE_UP);
      return;
    }
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
      // `stopped` chiude anche questa metà: dopo stop() nessun altro op parte e
      // nessun rollback tocca più lo store (vedi il catch).
      while (this.outbox.length > 0 && !this.stopped) {
        const op = this.outbox[0];
        // La generazione in cui questa richiesta parte. Se cambia mentre è in
        // volo, il documento è stato sostituito da uno snapshot: questa
        // richiesta non ha più niente da dire su una coda che non è più la sua.
        const epoch = this.epoch;
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
          //
          // ...a meno che nel frattempo non sia arrivato un resync: la coda è
          // stata svuotata e in testa c'è, semmai, un op costruito sul NUOVO
          // documento. Uno shift() qui butterebbe via quello sbagliato.
          if (this.epoch !== epoch) continue;
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
          // Client fermato mentre la richiesta era in volo (abort della fetch a
          // pagina chiusa, tipicamente): non c'è più nessuno a cui mostrare un
          // rollback, e scriverlo mentre un client nuovo ha già preso il posto
          // farebbe sparire dalla scena un op che nemmeno è suo.
          if (this.stopped) return;
          // Resync mentre la richiesta era in volo: la coda è già stata buttata
          // via e l'utente ha già visto il rollback (setScene con il suo
          // messaggio). Soprattutto: `landed()` qui NON è utilizzabile, perché
          // legge `pending` -- che il resync ha svuotato -- e risponderebbe
          // "atterrato" a qualunque op, facendo partire la coda dietro come se
          // la sua premessa fosse vera.
          if (this.epoch !== epoch) continue;
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
          //
          // Solo la TESTA è revocabile (store.ts::DisownedOp): è l'unica che era
          // davvero in volo, quindi l'unica che il server può aver applicato
          // nonostante la richiesta sia morta. La coda dietro non è mai partita:
          // nessun eco potrà mai arrivare, e segnarla revocabile occuperebbe
          // solo posti nella memoria dei rollback.
          for (let i = dropped.length - 1; i >= 0; i--) {
            useScene.getState().rejectPending(dropped[i].opId, message, i === 0);
          }
        }
      }
    } finally {
      this.draining = false;
    }
  }

  // Apre il documento e avvia il loop dello stream. Idempotente: due chiamate
  // di fila (StrictMode) lasciano UNA sola subscription viva.
  async start() {
    if (this.started || this.stopped) return;
    this.started = true;
    // REGISTRAZIONE come trasporto dello store. Qui e non nel costruttore: il
    // posto è uno solo e chi si registra per ULTIMO lo prende, quindi
    // registrarsi alla costruzione vuol dire che un client mai avviato può
    // rubare il posto a uno vivo -- e il suo stop(), che azzera il posto solo se
    // è ancora suo, lo trova suo e lascia l'editor senza trasporto.
    //
    // Non è teorico: è la forma del bootstrap di ui/App.tsx al primo caricamento
    // (nessun `brawt.docId` in localStorage) sotto StrictMode. I due giri
    // dell'effetto aspettano ciascuno la propria createDocument; se la seconda
    // risposta arriva per prima, il client del PRIMO giro viene costruito dopo
    // che quello del secondo si è già registrato, e subito fermato dalla
    // guardia `if (cancelled)`. Da lì in poi `sync` è null, ogni endGesture
    // prende il ramo senza filo (store.ts: `get().apply(op)`) e ogni modifica
    // viene applicata in locale come confermata, mai inviata e persa al reload,
    // con la pillola che continua a dire "connesso".
    useScene.getState().setSync(this);
    await this.open();
    // stop() può essere arrivato durante l'await (unmount rapido): non avviare
    // un loop che nessuno fermerà più.
    if (this.stopped) return;
    // Il loop gira in background: start() deve risolversi appena lo snapshot è
    // caricato, non quando la subscription finisce (cioè: mai).
    void this.loop();
  }

  // Stacca tutto: la subscription in corso (abort del segnale, che è ciò che
  // chiude davvero la richiesta HTTP e libera il subscriber sul server),
  // l'attesa di backoff, e il posto di trasporto nello store. Da chiamare dalla
  // cleanup dell'effetto di bootstrap: senza, uno smontaggio lascia un loop che
  // continua a riconnettersi e a scrivere in uno store che nessuno guarda più.
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.controller?.abort();
    this.controller = null;
    this.wake?.();
    // Solo se il posto è ancora NOSTRO: in StrictMode il client successivo si è
    // già registrato prima che questa cleanup giri, e azzerarlo lascerebbe
    // l'editor senza trasporto (ogni gesto applicato in locale e mai inviato).
    if (useScene.getState().sync === this) useScene.getState().setSync(null);
  }

  // Snapshot autorevole: allinea vista, confermato e seq di partenza. È anche
  // la sola risposta possibile a CodeOutOfRange (la history da cui volevamo
  // ripartire è stata compattata), e in quel caso setScene svuota `pending`:
  // gli op ancora in volo restano legittimi sul server -- se sono atterrati il
  // loro eco arriverà e li rimetterà nella scena -- ma il client non ha più
  // modo di collocarli rispetto a uno snapshot che non sa in quale punto della
  // storia si trovi.
  //
  // `resync` distingue il bootstrap dalla sostituzione a metà sessione, che è
  // un'altra cosa: c'è un documento vivo sotto, con una coda, una storia e --
  // fuori dallo store -- un OUTBOX. Svuotare la coda senza svuotare anche
  // l'outbox li disallinea, e da lì in poi `landed()` ("non è in pending, quindi
  // il server ce l'ha") risponde "atterrato" a op che non hanno mai lasciato il
  // browser. La generazione (`epoch`) è ciò che rende quel disallineamento
  // impossibile anche per la richiesta già in volo.
  //
  // CodeOutOfRange non è ipotetico: l'hub compatta ogni 256 op
  // (internal/server/hub.go: snapshotEveryOps) e un hub riavviato riparte con
  // historyBase al seq caricato (internal/server/bundle.go), quindi basta
  // riprendere una sessione da un punto più vecchio.
  private async open(resync = false) {
    const open = await docClient.openDocument({ docId: this.docId });
    if (this.stopped) return;
    if (resync) {
      this.epoch += 1;
      // Questi op non sono mai partiti e non partiranno: sono stati costruiti
      // su un documento che lo snapshot ha appena sostituito. setScene li toglie
      // dalla vista (e mostra il perché); qui si toglie il loro invio.
      this.outbox.length = 0;
    }
    if (open.snapshot) {
      useScene.getState().setScene(fromDocument(open.snapshot), resync ? RESYNCED : undefined);
    }
    this.seq = Number(open.seq);
    useScene.getState().setConnection("connected");
  }

  // Il loop di vita dello stream: consuma, e quando lo stream finisce (in
  // qualunque modo) aspetta e si riabbona da `this.seq`, cioè da DOPO l'ultimo
  // record applicato -- since_seq è esclusivo (hub.go: `rec.Seq > sinceSeq`),
  // quindi il backlog riparte esattamente dal primo record che ci manca.
  //
  // Prima di questo fix `void this.consume()` non aveva né catch né retry: la
  // fine dello stream era una unhandled rejection e nient'altro, il documento
  // confermato restava fermo per sempre e ogni gesto successivo si accodava a
  // `pending` senza che niente potesse più toglierlo da lì.
  private async loop() {
    while (!this.stopped) {
      const controller = new AbortController();
      this.controller = controller;
      const openedAt = Date.now();
      let reason: string;
      let reopen = false;
      try {
        const end = await this.consume(controller.signal);
        if (this.stopped) return;
        // for-await finito senza errore: il server ha chiuso lo stream. Non è
        // meno grave di un errore -- da qui in poi non arriva più nessun record.
        reason = end === "gap" ? SEQUENCE_GAP : CLOSED_BY_SERVER;
        console.error("subscribe stream ended:", reason);
      } catch (err) {
        if (this.stopped) return;
        const ce = ConnectError.from(err);
        reason = ce.message;
        // OutOfRange = "i record da cui vuoi ripartire sono stati compattati in
        // uno snapshot" (documentservice.go). Riabbonarsi allo stesso since_seq
        // darebbe lo stesso errore all'infinito: l'unica via d'uscita è
        // riaprire il documento e ripartire dal seq che OpenDocument riporta.
        reopen = ce.code === Code.OutOfRange;
        console.error("subscribe stream failed", err);
      } finally {
        // Anche quando siamo NOI a uscire dal for-await (gap): lo stream non è
        // finito, e senza abort la richiesta resterebbe aperta con il server
        // che continua a spingerci record dentro un canale che nessuno legge.
        controller.abort();
        this.controller = null;
      }

      // Uno stream vissuto a lungo ha fatto il suo lavoro anche se il documento
      // era fermo: il budget dei tentativi vale per le cadute CONSECUTIVE.
      if (Date.now() - openedAt >= RECONNECT_STABLE_MS) this.attempts = 0;
      this.attempts += 1;
      if (this.attempts > MAX_RECONNECT_ATTEMPTS) {
        // ARRESA. Il loop finisce qui, e con lui l'unica cosa che può confermare
        // un op: da adesso `submit()` rifiuta invece di accodare (vedi
        // `givenUp`). Senza questo il client resta "vivo a metà" -- accetta op,
        // li manda, il server li applica in modo durabile -- e la coda in
        // attesa, la storia in dubbio e il replay di viewOf crescono per tutto
        // il resto della sessione, senza che MAX_OUTBOX possa intervenire
        // (l'outbox si svuota a ogni successo, `pending` no).
        //
        // Quello che è GIÀ in coda parte lo stesso: è al più MAX_OUTBOX op, ha
        // già superato il punto di non ritorno del rollback, e il server è
        // l'unico posto in cui possa ancora sopravvivere al reload.
        this.givenUp = true;
        useScene.getState().setConnection("error", reason);
        return;
      }
      useScene.getState().setConnection("reconnecting", reason);

      await this.wait(backoffMs(this.attempts));
      if (this.stopped) return;
      if (reopen) {
        try {
          // RISINCRONIZZAZIONE, non bootstrap: c'è un documento vivo che lo
          // snapshot sta per sostituire (vedi open()).
          await this.open(true);
        } catch (err) {
          // Se nemmeno OpenDocument risponde, il server è giù: il giro
          // successivo di subscribe fallirà a sua volta e consumerà un
          // tentativo come tutti gli altri, quindi il tetto vale anche qui.
          console.error("resync (openDocument) failed", err);
        }
        if (this.stopped) return;
      }
    }
  }

  // Attesa interrompibile: stop() la sveglia subito invece di lasciare in piedi
  // un timer che si risolverebbe dentro una app già smontata.
  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }

  // Un giro di subscription. Ritorna "closed" se lo stream è finito (il server
  // l'ha chiuso), "gap" se è stato il client a staccare per un buco nella
  // sequenza; un errore del trasporto esce come eccezione.
  private async consume(signal: AbortSignal): Promise<"closed" | "gap"> {
    const stream = docClient.subscribe(
      { docId: this.docId, clientId: this.clientId, sinceSeq: BigInt(this.seq) },
      { signal },
    );
    // "Connesso" appena la subscription è aperta, non al primo record: un
    // documento su cui nessuno sta disegnando è silenzioso per definizione, e
    // aspettare un record vorrebbe dire lasciare la pillola su "riconnessione"
    // a tempo indeterminato con il collegamento perfettamente sano. Il prezzo è
    // un lampeggio di "connesso" a ogni tentativo mentre il server è giù --
    // ma il tentativo dura millisecondi e l'attesa di backoff, che è quella che
    // l'utente vede, resta "riconnessione".
    useScene.getState().setConnection("connected");
    for await (const msg of stream) {
      // Un record può essere già nel buffer quando arriva lo stop: la guardia
      // qui è ciò che garantisce che dopo stop() NIENTE entri più nello store.
      if (this.stopped || signal.aborted) return "closed";
      if (msg.kind.case !== "applied") continue;
      const rec = msg.kind.value;
      const seq = Number(rec.seq);

      if (seq <= this.seq) {
        // Già visto. Non dovrebbe succedere (since_seq è esclusivo e l'hub
        // consegna esattamente una volta), ma riapplicare un op perché il
        // backlog si è sovrapposto sarebbe una mutazione silenziosa del
        // documento: si scarta e si va avanti.
        console.warn(`brawt: record duplicato seq=${seq} (già a ${this.seq}), ignorato`);
        continue;
      }
      if (seq !== this.seq + 1) {
        // BUCO. Proseguire vorrebbe dire tenersi un documento a cui manca un
        // op, in modo permanente e invisibile: se il buco conteneva un
        // CreateNode, ogni SetProps successivo su quel nodo viene inghiottito
        // da applyOp (`if (!cur) return state`) e la forma non compare mai.
        // Si stacca e ci si riabbona dall'ultimo seq BUONO, che è quello che
        // fa rimandare al server i record mancanti.
        console.error(`brawt: gap nello stream (atteso ${this.seq + 1}, ricevuto ${seq})`);
        return "gap";
      }

      // ANCHE i propri echi. Scartarli per clientId (com'era in M0) vuol dire
      // non adottare mai la versione autorevole dei propri op: il client non
      // sa mai come il server li ha ordinati rispetto a quelli altrui, e i
      // suoi op restano ottimistici per sempre. È l'eco che li conferma --
      // store.apply li toglie dalla coda proprio in base all'opId, quindi
      // l'op non viene applicato due volte, nemmeno quando è il backlog di una
      // riconnessione a riportarlo indietro.
      //
      // Il clientId però serve, per un'altra decisione: un record ALTRUI può
      // aver reso non più valide delle voci di undo/redo (store.ts::markStale),
      // uno nostro no. È l'unico posto in cui la provenienza conta, e il
      // confronto è volutamente stretto -- un clientId vuoto non è una prova di
      // niente, quindi il record va trattato come altrui.
      const own = rec.clientId !== "" && rec.clientId === this.clientId;
      if (rec.op) useScene.getState().apply(rec.op, own);
      this.seq = seq;
      // Progresso: il budget dei tentativi riparte da zero.
      this.attempts = 0;
    }
    return "closed";
  }
}
