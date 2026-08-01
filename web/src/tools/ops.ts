import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { NodeSchema, OpSchema } from "../gen/brawt/v1/brawt_pb";
import type { Node, Op } from "../gen/brawt/v1/brawt_pb";
import { useScene } from "../store/store";

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
export function makeSetPropsOp(
  id: string,
  patch: MessageInitShape<typeof NodeSchema>,
  paths: string[],
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
