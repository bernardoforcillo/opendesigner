import { create } from "@bufbuild/protobuf";
import { OpSchema } from "../gen/brawt/v1/brawt_pb";
import type { Node as PbNode, Op } from "../gen/brawt/v1/brawt_pb";
import { toPbNode, type SceneState } from "./types";

// Primitive di undo: dato lo stato PRIMA di un op, l'op che lo annulla.
//
// L'undo in brawt non è un rewind dell'op-log: è altro lavoro in avanti
// (l'inverso viene submittato come un op qualsiasi). Quindi l'inverso è un Op
// vero, con:
//  - un opId NUOVO (il server deduplica per opId: riusare quello dell'op
//    diretto lo farebbe scartare come replay);
//  - il docId dell'op diretto, non quello del documento "corrente" -- l'op che
//    sto invertendo può essere arrivato dal filo.
function newOpId(): string {
  // Stesso generatore di tools/ops.ts::uuid, ma chiamato direttamente: history
  // sta sotto store/ e store.ts importerà invertOp (Task 12), mentre ops.ts
  // importa store.ts. Passare da ops.ts chiuderebbe un ciclo di moduli.
  return crypto.randomUUID();
}

function createNodeOp(docId: string, node: PbNode): Op {
  return create(OpSchema, { opId: newOpId(), docId, kind: { case: "createNode", value: { node } } });
}

// invertOp va chiamato PRIMA che op venga applicato: l'inverso è fatto dei
// valori che l'op sta per sovrascrivere (o del nodo che sta per sparire), e
// dopo l'apply quello stato non esiste più.
// Ritorna null quando un inverso non esiste: op che applyOp scarterebbe
// comunque (id inesistente, createNode senza nodo, kind sconosciuto). In quei
// casi l'op diretto non cambia la scena, quindi "nessun inverso" è corretto,
// non una perdita.
export function invertOp(scene: SceneState, op: Op): Op | null {
  switch (op.kind.case) {
    case "createNode": {
      const node = op.kind.value.node;
      if (!node) return null;
      const prev = scene.nodes[node.id];
      // applyOp tratta createNode su un id già presente come SOVRASCRITTURA:
      // lì l'inverso non è cancellare (perderebbe il nodo preesistente) ma
      // ricreare il nodo com'era.
      if (prev) return createNodeOp(op.docId, toPbNode(prev));
      return create(OpSchema, {
        opId: newOpId(), docId: op.docId,
        kind: { case: "deleteNode", value: { id: node.id } },
      });
    }
    case "deleteNode": {
      const prev = scene.nodes[op.kind.value.id];
      if (!prev) return null;
      return createNodeOp(op.docId, toPbNode(prev));
    }
    case "setProps": {
      const { id, patch, mask } = op.kind.value;
      // Senza patch l'op è un no-op per applyOp (parità con Go): niente da
      // annullare.
      const prev = scene.nodes[id];
      if (!prev || !patch) return null;
      // Patch = il nodo com'era, mask = la STESSA dell'op diretto. La mask è il
      // contratto -- TS e Go leggono solo i path elencati e ignorano il resto
      // del patch -- quindi ricopiare qui la tabella dei path duplicherebbe (e
      // prima o poi farebbe divergere) applyOp. Bonus: se la mask contiene un
      // path non supportato, l'op diretto viene rifiutato in blocco e l'inverso
      // pure, quindi il round-trip resta l'identità anche in quel caso.
      return create(OpSchema, {
        opId: newOpId(), docId: op.docId,
        kind: {
          case: "setProps",
          value: { id, patch: toPbNode(prev), mask: { paths: [...(mask?.paths ?? [])] } },
        },
      });
    }
    default:
      return null;
  }
}
