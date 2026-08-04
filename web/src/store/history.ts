import { create } from "@bufbuild/protobuf";
import { OpSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import type { Node as PbNode, Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { toPbNode, toPbTextStyle, toPbSubPaths, type SceneState } from "./types";
import { childrenOf, isAncestorOf, parentExists, subtreeOf } from "./tree";

// Primitive di undo: dato lo stato PRIMA di un op, l'op che lo annulla.
//
// L'undo in opendesigner non è un rewind dell'op-log: è altro lavoro in avanti
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
// Ritorna null quando un inverso non esiste: op che applyOp -- e prima ancora
// core.Apply (Go), che è l'autorità -- scarterebbero comunque (id inesistente,
// createNode senza nodo o su un id già preso, kind sconosciuto). In quei casi
// l'op diretto non cambia la scena, quindi "nessun inverso" è corretto, non una
// perdita.
//
// Ritorna una LISTA da applicare IN ORDINE, mai vuota (è null in quel caso).
// Quasi sempre è di uno, ma non può esserlo per costruzione: un `deleteNode`
// cancella tutto il sottoalbero (core.applyDelete) e l'op inverso di una
// creazione è UNA createNode per nodo -- il proto non ha un op che ne crei
// molti, e non deve averlo: sono ops indipendenti, ognuna con i suoi
// invarianti. L'ordine è quello che RI-SODDISFA l'invariante del parent
// (parent prima dei figli): al contrario, ogni figlio verrebbe rifiutato con
// ErrParentNotFound.
export function invertOp(scene: SceneState, op: Op): Op[] | null {
  switch (op.kind.case) {
    case "createNode": {
      const node = op.kind.value.node;
      if (!node || node.id === "") return null;
      // Parent inesistente: core.applyCreate risponde ErrParentNotFound e
      // applyOp lo mirrora. L'op diretto non cambia niente, quindi non c'è
      // niente da annullare -- e una deleteNode inventata qui andrebbe sul
      // filo a cancellare un nodo che il server non ha mai creato.
      if (!parentExists(scene, node.parentId)) return null;
      // Id già presente: core.applyCreate (Go) risponde ErrNodeExists e applyOp
      // fa lo stesso: l'op diretto viene RIFIUTATO, la scena non cambia, quindi
      // non c'è niente da annullare. Inventare qui un inverso (una delete, o la
      // ri-creazione del nodo precedente) manderebbe al server l'undo di un op
      // che il server non ha mai accettato -- cioè una vera divergenza.
      if (scene.nodes[node.id]) return null;
      return [create(OpSchema, {
        opId: newOpId(), docId: op.docId,
        kind: { case: "deleteNode", value: { id: node.id } },
      })];
    }
    // L'inverso di una delete è la ricreazione di TUTTO il sottoalbero che la
    // delete porta via (core.applyDelete cascata): il nodo e ogni discendente,
    // una createNode ciascuno.
    //
    // L'ORDINE è la parte che conta: subtreeOf visita in pre-ordine, quindi
    // ogni nodo arriva DOPO il proprio parent e ogni createNode trova il suo
    // container già ricreato. Nell'ordine opposto la prima ricreazione di un
    // figlio verrebbe respinta con ErrParentNotFound, e l'undo lascerebbe la
    // scena a metà -- peggio di un undo che non si può fare.
    case "deleteNode": {
      const sub = subtreeOf(scene, op.kind.value.id);
      if (sub.length === 0) return null;
      return sub.map((n) => createNodeOp(op.docId, toPbNode(n)));
    }
    // Simmetrico a se stesso: rimette il nodo dov'era, con la order key che
    // aveva fra i vecchi pari. Null quando l'op diretto sarebbe rifiutato --
    // nodo o parent inesistente, ciclo -- perché in quel caso la scena non
    // cambia e non c'è niente da annullare (vedi applyOp: reparentNode).
    case "reparentNode": {
      const { id, newParentId } = op.kind.value;
      const prev = scene.nodes[id];
      if (!prev) return null;
      if (!parentExists(scene, newParentId)) return null;
      if (newParentId === id || isAncestorOf(scene, id, newParentId)) return null;
      return [create(OpSchema, {
        opId: newOpId(), docId: op.docId,
        kind: { case: "reparentNode", value: { id, newParentId: prev.parentId, orderKey: prev.orderKey } },
      })];
    }
    case "setProps": {
      // Il patch dell'op diretto non serve: l'inverso è fatto dei valori
      // PRECEDENTI. E attenzione, un op SENZA patch non è un no-op — Go lo
      // legge con i getter nil-safe e azzera i campi in mask (applyOp fa
      // altrettanto, vedi NIL_PATCH), quindi ha un inverso come tutti gli
      // altri: rimettere a posto quei campi.
      const { id, mask } = op.kind.value;
      const prev = scene.nodes[id];
      if (!prev) return null;
      // Patch = il nodo com'era, mask = la STESSA dell'op diretto. La mask è il
      // contratto -- TS e Go leggono solo i path elencati e ignorano il resto
      // del patch -- quindi ricopiare qui la tabella dei path duplicherebbe (e
      // prima o poi farebbe divergere) applyOp. Bonus: se la mask contiene un
      // path non supportato, l'op diretto viene rifiutato in blocco e l'inverso
      // pure, quindi il round-trip resta l'identità anche in quel caso.
      return [create(OpSchema, {
        opId: newOpId(), docId: op.docId,
        kind: {
          case: "setProps",
          value: { id, patch: toPbNode(prev), mask: { paths: [...(mask?.paths ?? [])] } },
        },
      })];
    }
    case "setText": {
      // Stessa forma dell'inverso di setProps: i valori PRECEDENTI, non il
      // payload dell'op diretto. Null quando l'op diretto sarebbe rifiutato --
      // id inesistente o nodo non di testo (ErrNotTextNode in Go): la scena non
      // cambierebbe, quindi non c'è niente da annullare.
      const { id } = op.kind.value;
      const prev = scene.nodes[id];
      if (!prev || prev.kind !== "text" || !prev.text) return null;
      // stylePresent SEMPRE true, anche quando l'op diretto non toccava lo
      // stile: rimettere lo stile precedente è un no-op in quel caso, mentre
      // ometterlo lascerebbe in piedi lo stile NUOVO dopo l'undo di un op che
      // l'aveva cambiato. Un solo ramo, sempre esatto.
      return [create(OpSchema, {
        opId: newOpId(), docId: op.docId,
        kind: {
          case: "setText",
          value: {
            id,
            content: prev.text.content,
            style: toPbTextStyle(prev.text.style),
            stylePresent: true,
          },
        },
      })];
    }
    // --- pagine -------------------------------------------------------------
    // Le pagine sono i container RADICE (un parentId può essere l'id di un nodo
    // o quello di una Page). Il loro inverso è speculare a quello dei nodi: una
    // createPage si annulla con una deletePage, una renamePage rimettendo il
    // nome precedente, una deletePage -- che come deleteNode porta via a CASCATA
    // un intero sottoalbero (vedi applyOp) -- ricreando prima la pagina e poi
    // ogni nodo che le pendeva sotto, parent prima dei figli.
    //
    // La regola del null resta quella dei nodi: si ritorna null ESATTAMENTE
    // quando l'op diretto sarebbe rifiutato (parità con applyOp e core), perché
    // in quel caso la scena non cambia e non c'è niente da annullare -- e un
    // inverso inventato manderebbe al server l'undo di un op mai accettato.
    case "createPage": {
      const page = op.kind.value.page;
      // Pagina assente o senza id (ErrNilPage), o id GIÀ PRESO -- da un'altra
      // pagina o da un NODO: parentExists risponde "sì" per entrambi, e la
      // collisione con un nodo conta quanto quella con una pagina (ErrPageExists).
      if (!page || page.id === "" || parentExists(scene, page.id)) return null;
      return [create(OpSchema, {
        opId: newOpId(), docId: op.docId,
        kind: { case: "deletePage", value: { id: page.id } },
      })];
    }
    case "deletePage": {
      const { id } = op.kind.value;
      const page = scene.pages.find((p) => p.id === id);
      // Pagina inesistente (ErrPageNotFound) o ULTIMA pagina (ErrLastPage): in
      // entrambi i casi applyOp lascia la scena invariata.
      if (!page || scene.pages.length === 1) return null;
      // Prima la pagina, poi ogni nodo che la cascata sta per portare via. Uso
      // lo `scene` PRE-apply che invertOp riceve per enumerare quei nodi con la
      // STESSA visita di applyDeletePage (childrenOf per i root della pagina,
      // subtreeOf in pre-ordine per ciascuno): ogni createNode trova così il
      // proprio container -- la pagina appena ricreata o un nodo ricreato prima
      // -- già esistente. Nell'ordine opposto la prima ricreazione di un root
      // verrebbe respinta con ErrParentNotFound e l'undo lascerebbe la scena a
      // metà, peggio di un undo che non si può fare.
      const ops: Op[] = [create(OpSchema, {
        opId: newOpId(), docId: op.docId,
        kind: { case: "createPage", value: { page: { id: page.id, name: page.name } } },
      })];
      for (const root of childrenOf(scene, id)) {
        for (const n of subtreeOf(scene, root.id)) ops.push(createNodeOp(op.docId, toPbNode(n)));
      }
      return ops;
    }
    case "renamePage": {
      const { id } = op.kind.value;
      const page = scene.pages.find((p) => p.id === id);
      // Pagina inesistente: ErrPageNotFound, applyOp no-op.
      if (!page) return null;
      // Il nome PRECEDENTE (letto dallo scene pre-apply), non quello dell'op
      // diretto: simmetrico a se stesso. Scritto SEMPRE, anche vuoto, come
      // applyOp -- il ripiego per un nome vuoto è della UI, non del modello.
      return [create(OpSchema, {
        opId: newOpId(), docId: op.docId,
        kind: { case: "renamePage", value: { id, name: page.name } },
      })];
    }
    case "setVectorPath": {
      // Stessa forma dell'inverso di setText: i subpath PRECEDENTI per intero,
      // non il payload dell'op diretto. È tutto ciò che serve proprio perché
      // SetVectorPath sostituisce in blocco -- se l'op fosse incrementale
      // ("sposta l'ancoraggio i-esimo") l'inverso dovrebbe ricostruire quale
      // pezzo è stato toccato, e ogni caso in più sarebbe un caso in più da
      // tenere identico fra Go e TS.
      //
      // Senza questo ramo l'editing di un path non produrrebbe NESSUNA voce di
      // undo (invertOp null => il gesto non entra nello stack), che per una
      // traccia il cui punto è la geometria modificabile sarebbe il difetto
      // peggiore possibile.
      const { id } = op.kind.value;
      const prev = scene.nodes[id];
      // Null quando l'op diretto sarebbe rifiutato -- id inesistente o nodo non
      // vettoriale (ErrNotVectorNode in Go): la scena non cambierebbe, quindi
      // non c'è niente da annullare.
      if (!prev || prev.kind !== "vector" || !prev.vector) return null;
      // Una lista vuota è un inverso legittimo come un'altra: annullare il
      // riempimento di un path prima vuoto lo rimette vuoto. Lista di UN
      // elemento e non un Op nudo: invertOp ritorna Op[] da quando l'inverso di
      // una delete è una cascata (T1) -- appiattire qui a un bare Op romperebbe
      // il tipo e chi lo consuma (invertChain).
      return [create(OpSchema, {
        opId: newOpId(), docId: op.docId,
        kind: { case: "setVectorPath", value: { id, subpaths: toPbSubPaths(prev.vector.subpaths) } },
      })];
    }
    default:
      return null;
  }
}
