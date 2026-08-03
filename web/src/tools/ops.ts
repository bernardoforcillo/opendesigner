import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { NodeSchema, OpSchema } from "../gen/brawt/v1/brawt_pb";
import type { Node, Op } from "../gen/brawt/v1/brawt_pb";
import { useScene } from "../store/store";
import { toPbTextStyle } from "../store/types";
import type { TextStyleLite } from "../store/types";
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

// SetText è un op DEDICATO e non un path della mask: il contenuto vive DENTRO
// il oneof `shape` del Node, mentre la mask indirizza campi di primo livello
// (vedi store/applyOp.ts e core.applySetText).
//
// Lo stile e il suo flag viaggiano INSIEME, e questa è l'unica ragione per cui
// la funzione prende uno stile opzionale invece di lasciar comporre il valore
// ai chiamanti: in proto3 uno stile assente e uno tutto a zero sono
// indistinguibili dopo il round-trip protojson, quindi è `style_present` a
// dire "tocca anche lo stile". Passarlo senza stile azzererebbe il font;
// passare uno stile senza il flag lo farebbe ignorare da entrambe le
// implementazioni. Qui i due casi non sono nemmeno esprimibili.
export function makeSetTextOp(id: string, content: string, style?: TextStyleLite): Op {
  return create(OpSchema, {
    opId: uuid(),
    docId: docId(),
    kind: {
      case: "setText",
      value: style
        ? { id, content, style: toPbTextStyle(style), stylePresent: true }
        : { id, content },
    },
  });
}

// Sposta un nodo sotto un altro container (o direttamente sotto una Page) e ne
// riscrive l'ordine fra i nuovi pari. Op DEDICATO e non un path della mask,
// perché la riparentazione ha una validazione che nessun campo ha -- il nuovo
// parent deve esistere e non può essere il nodo stesso né un suo discendente
// (vedi core.applyReparent e store/applyOp.ts).
//
// `orderKey` viaggia INSIEME e non è opzionale: cambiare parent senza
// riordinare lascerebbe il nodo con la chiave calcolata fra i pari VECCHI,
// cioè in una posizione arbitraria fra i nuovi.
export function makeReparentOp(id: string, newParentId: string, orderKey: string): Op {
  return create(OpSchema, {
    opId: uuid(),
    docId: docId(),
    kind: { case: "reparentNode", value: { id, newParentId, orderKey } },
  });
}

export function makeDeleteOp(id: string): Op {
  return create(OpSchema, { opId: uuid(), docId: docId(), kind: { case: "deleteNode", value: { id } } });
}

// --- pagine ----------------------------------------------------------------
// Le pagine sono i container RADICE. Questi op cambiano DOVE i nodi possono
// vivere (non un nodo), e la loro semantica -- cascata, rifiuto dell'ultima
// pagina, rifiuto degli id già presi -- sta già in core + store/applyOp.ts. Qui
// si costruisce soltanto l'Op, come per i nodi: opId e docId in un posto solo.
// Il selettore di pagina (ui/PageBar.tsx) li manda dallo stesso percorso di
// gesto dei tool (beginGesture/endGesture), quindi UN op = un invio in rete.

// L'id della pagina è FORNITO dal chiamante (uuid()) e non generato qui, così è
// noto PRIMA del submit -- il selettore ci si sposta sopra subito dopo averla
// creata (setCurrentPage), senza aspettare l'eco.
export function makeCreatePageOp(id: string, name: string): Op {
  return create(OpSchema, { opId: uuid(), docId: docId(), kind: { case: "createPage", value: { page: { id, name } } } });
}

export function makeDeletePageOp(id: string): Op {
  return create(OpSchema, { opId: uuid(), docId: docId(), kind: { case: "deletePage", value: { id } } });
}

export function makeRenamePageOp(id: string, name: string): Op {
  return create(OpSchema, { opId: uuid(), docId: docId(), kind: { case: "renamePage", value: { id, name } } });
}
