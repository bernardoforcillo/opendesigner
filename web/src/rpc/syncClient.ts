import type { Op } from "../gen/brawt/v1/brawt_pb";
import { docClient } from "./client";
import { useScene } from "../store/store";
import { fromDocument } from "../store/types";

export class SyncClient {
  private seq = 0;

  constructor(private docId: string, private clientId: string) {}

  submit(op: Op) {
    // apply ottimistico + invio
    useScene.getState().apply(op);
    docClient
      .submitOp({ docId: this.docId, clientId: this.clientId, op })
      .catch((err) => console.error("submitOp failed", err));
  }

  async start() {
    const open = await docClient.openDocument({ docId: this.docId });
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
        // ignora i propri op già applicati in ottimistico
        if (rec.op && rec.clientId !== this.clientId) {
          useScene.getState().apply(rec.op);
        }
        this.seq = Number(rec.seq);
      }
    }
  }
}
