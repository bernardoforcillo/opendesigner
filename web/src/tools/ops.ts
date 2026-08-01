import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { NodeSchema, OpSchema } from "../gen/brawt/v1/brawt_pb";
import type { Node, Op } from "../gen/brawt/v1/brawt_pb";
import { useScene } from "../store/store";
import type { MaskPath } from "../store/maskPaths";

// Costruzione centralizzata degli Op: ogni tool passa da qui, così opId e docId
// sono stampati in un solo posto (in M0 la logica era duplicata dentro
// rectTool). docId viene dal documento aperto nello store.

export function uuid(): string {
  return crypto.randomUUID();
}

function docId(): string {
  return useScene.getState().scene?.id ?? "";
}

export function makeCreateNodeOp(node: Node): Op {
  return create(OpSchema, { opId: uuid(), docId: docId(), kind: { case: "createNode", value: { node } } });
}

// patch contiene SOLO i campi elencati in paths: la mask è ciò che il reducer
// (TS e Go) usa per decidere cosa applicare, il resto del patch viene ignorato.
//
// paths è tipizzato MaskPath[] (non string[]) apposta: un path che Go non
// supporta (store/maskPaths.ts è l'unica fonte di verità, rispecchia lo
// switch di core.applySetProps) diventa così un errore di compilazione QUI,
// al punto di costruzione, invece di un rifiuto scoperto solo submittando
// davvero l'op -- o peggio, un throw a runtime in fase di serializzazione se
// il path è scritto nella convenzione camelCase sbagliata (FieldMask sul filo
// JSON riscrive il path e non è indulgente sul casing, vedi maskPaths.ts).
export function makeSetPropsOp(
  id: string,
  patch: MessageInitShape<typeof NodeSchema>,
  paths: MaskPath[],
): Op {
  return create(OpSchema, {
    opId: uuid(),
    docId: docId(),
    kind: { case: "setProps", value: { id, patch: create(NodeSchema, patch), mask: { paths } } },
  });
}

export function makeDeleteOp(id: string): Op {
  return create(OpSchema, { opId: uuid(), docId: docId(), kind: { case: "deleteNode", value: { id } } });
}
