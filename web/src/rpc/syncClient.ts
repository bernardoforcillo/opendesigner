import { ConnectError } from "@connectrpc/connect";
import type { Op } from "../gen/brawt/v1/brawt_pb";
import { docClient } from "./client";
import { useScene } from "../store/store";
import { fromDocument } from "../store/types";

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

  constructor(private docId: string, private clientId: string) {
    // Lo store deve poter mandare op da solo (fine gesto, e in seguito undo):
    // il client si registra come trasporto appena esiste, così l'app non deve
    // ricordarsi di collegarli a mano.
    useScene.getState().setSync(this);
  }

  submit(op: Op) {
    // Apply OTTIMISTICO: entra nella coda degli op in volo e si vede subito.
    // Non è ancora confermato: lo diventerà quando il suo eco tornerà da
    // Subscribe.
    useScene.getState().applyPending(op);
    docClient
      .submitOp({ docId: this.docId, clientId: this.clientId, op })
      // L'Ack della unary NON conferma nulla: porta solo il seq assegnato. La
      // conferma vera è l'eco su Subscribe, l'unico punto in cui il client
      // conosce l'ORDINE che il server ha deciso rispetto agli op altrui.
      .catch((err) => {
        // Rifiuto (o rete caduta prima che l'op arrivasse): l'op esce dalla
        // coda e la vista si ricalcola senza di lui -- la modifica ottimistica
        // sparisce. In M0 finiva in un console.error e restava sullo schermo
        // per sempre, persa solo al reload successivo.
        const message = ConnectError.from(err).message;
        console.error("submitOp failed", err);
        useScene.getState().rejectPending(op.opId, message);
      });
  }

  async start() {
    const open = await docClient.openDocument({ docId: this.docId });
    // Lo snapshot di OpenDocument è per definizione confermato: setScene
    // allinea vista e confermato e svuota la coda.
    if (open.snapshot) useScene.getState().setScene(fromDocument(open.snapshot));
    this.seq = Number(open.seq);

    // consuma lo stream in background: start() deve risolversi subito dopo
    // aver caricato lo snapshot, senza attendere la subscription per sempre.
    void this.consume();
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
