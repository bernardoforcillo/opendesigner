import { create } from "@bufbuild/protobuf";
import type { Op } from "../gen/brawt/v1/brawt_pb";
import { ClientMsgSchema } from "../gen/brawt/v1/brawt_pb";
import { docClient } from "./client";
import { useScene } from "../store/store";
import { fromDocument } from "../store/types";

export class SyncClient {
  private queue: Op[] = [];
  private notify: (() => void) | null = null;
  private seq = 0;

  constructor(private docId: string, private clientId: string) {}

  submit(op: Op) {
    // apply ottimistico + invio
    useScene.getState().apply(op);
    this.queue.push(op);
    this.notify?.();
  }

  async start() {
    const open = await docClient.openDocument({ docId: this.docId });
    if (open.snapshot) useScene.getState().setScene(fromDocument(open.snapshot));
    this.seq = Number(open.seq);

    const self = this;
    async function* outbound() {
      // primo messaggio: Hello
      yield create(ClientMsgSchema, { kind: { case: "hello", value: {
        docId: self.docId, clientId: self.clientId, sinceSeq: BigInt(self.seq) } } });
      // poi: droppa la coda di op man mano
      while (true) {
        if (self.queue.length === 0) {
          await new Promise<void>((r) => (self.notify = r));
          self.notify = null;
        }
        const op = self.queue.shift();
        if (op) yield create(ClientMsgSchema, { kind: { case: "submit", value: { op } } });
      }
    }

    for await (const msg of docClient.sync(outbound())) {
      if (msg.kind.case === "applied") {
        const rec = msg.kind.value;
        // ignora i propri op già applicati in ottimistico (dedup per op_id)
        if (rec.op && rec.clientId !== this.clientId) {
          useScene.getState().apply(rec.op);
        }
        this.seq = Number(rec.seq);
      }
    }
  }
}
