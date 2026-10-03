import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { NodeSchema, OpSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import type { Node, Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "../store/store";
import { toPbClip, toPbFlow, toPbInstanceOverride, toPbSubPaths, toPbTextStyle, toPbTransition } from "../store/types";
import type { ClipLite, FlowLite, InstanceOverrideLite, SubPathLite, TextStyleLite, TransitionLite } from "../store/types";
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

// SetVectorPath è un op DEDICATO per la stessa ragione di SetText: la geometria
// vive DENTRO il oneof `shape` del Node, mentre la mask di SetProperties
// indirizza campi di primo livello (vedi store/applyOp.ts e
// core.applySetVectorPath).
//
// Sostituisce i subpath IN BLOCCO, quindi non ha bisogno del flag `present` di
// setText: l'op È i subpath, e una lista vuota è il path svuotato -- uno stato
// legittimo, non un "non specificato".
export function makeSetVectorPathOp(id: string, subpaths: readonly SubPathLite[]): Op {
  return create(OpSchema, {
    opId: uuid(),
    docId: docId(),
    kind: { case: "setVectorPath", value: { id, subpaths: toPbSubPaths(subpaths) } },
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

// --- flussi ----------------------------------------------------------------
// Upsert assoluti: l'id è FORNITO dal chiamante (uuid()), noto prima del submit.
export function makeSetFlowOp(flow: FlowLite): Op {
  return create(OpSchema, { opId: uuid(), docId: docId(), kind: { case: "setFlow", value: { flow: toPbFlow(flow) } } });
}
export function makeDeleteFlowOp(id: string): Op {
  return create(OpSchema, { opId: uuid(), docId: docId(), kind: { case: "deleteFlow", value: { id } } });
}
export function makeSetTransitionOp(t: TransitionLite): Op {
  return create(OpSchema, { opId: uuid(), docId: docId(), kind: { case: "setTransition", value: { transition: toPbTransition(t) } } });
}
export function makeDeleteTransitionOp(id: string): Op {
  return create(OpSchema, { opId: uuid(), docId: docId(), kind: { case: "deleteTransition", value: { id } } });
}

// --- componenti / istanze (M4) ---------------------------------------------
// I componenti sono sottoalberi MASTER già vivi in `nodes`; le istanze li
// referenziano. Questi op esistono già in proto + core + store/applyOp.ts: qui
// si costruisce soltanto l'Op, come per tutto il resto (opId e docId in un posto
// solo). Il core rifiuta un componentId già preso, una radice assente, un
// override su un non-nodo/non-istanza: il chiamante non manda un op che si sa
// già invalido (id fresco, nodo che esiste), il resto è del server.

// Registra il sottoalbero radicato in `rootNodeId` come master del componente
// `componentId`. Non copia nulla -- il master resta dov'è, e le istanze lo
// leggono vivo (propagazione gratis). componentId è FORNITO dal chiamante
// (uuid()) così è noto prima del submit, come l'id di una pagina.
export function makeCreateComponentOp(componentId: string, rootNodeId: string, name: string): Op {
  return create(OpSchema, {
    opId: uuid(),
    docId: docId(),
    kind: { case: "createComponent", value: { componentId, rootNodeId, name } },
  });
}

// Imposta (o AZZERA) l'override di un'istanza su un nodo del master. L'override
// arriva come Lite e la sua PRESENZA di campi diventa fills_present/text_present
// via toPbInstanceOverride: un override senza né fills né text è la RIMOZIONE --
// il nodo del master torna a ereditare (vedi store/applyOp.ts::
// setInstanceOverride e core.applySetInstanceOverride). L'upsert per
// masterNodeId è del reducer, non di qui.
export function makeSetInstanceOverrideOp(instanceId: string, override: InstanceOverrideLite): Op {
  return create(OpSchema, {
    opId: uuid(),
    docId: docId(),
    kind: { case: "setInstanceOverride", value: { instanceId, override: toPbInstanceOverride(override) } },
  });
}

export interface InstanceNodeParams {
  id: string;
  parentId: string;
  orderKey: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  componentId: string;
}

// Costruisce il Node di un'ISTANZA (kind "instance") pronto per makeCreateNodeOp:
// la forma `instance` col componentId reso e NESSUN override. x/y sono dove cade
// l'ORIGINE del master quando l'istanza lo disegna (store/instances.ts::
// instanceDescentLocal); width/height sono metadati mostrati dal pannello -- i
// bounds veri sono derivati dal master a ogni lettura. visible/opacity ai
// default di una forma appena creata, come le fa shapeTool.
export function makeInstanceNode(p: InstanceNodeParams): Node {
  return create(NodeSchema, {
    id: p.id,
    parentId: p.parentId,
    orderKey: p.orderKey,
    name: p.name,
    visible: true,
    opacity: 1,
    x: p.x,
    y: p.y,
    width: p.width,
    height: p.height,
    shape: { case: "instance", value: { componentId: p.componentId, overrides: [] } },
  });
}

// --- animazione ------------------------------------------------------------
// Upsert assoluto dell'intera clip (id fornito dal chiamante) e cancellazione.
export function makeSetClipOp(clip: ClipLite): Op {
  return create(OpSchema, { opId: uuid(), docId: docId(), kind: { case: "setClip", value: { clip: toPbClip(clip) } } });
}
export function makeDeleteClipOp(id: string): Op {
  return create(OpSchema, { opId: uuid(), docId: docId(), kind: { case: "deleteClip", value: { id } } });
}
