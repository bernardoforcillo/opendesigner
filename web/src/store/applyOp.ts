import { create } from "@bufbuild/protobuf";
import { NodeSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import type { Node as PbNode, Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { type SceneState, type NodeLite, toNodeLite, toTextStyleLite, toSubPathsLite, toInstanceOverrideLite } from "./types";
import { type MaskPath, isMaskPath } from "./maskPaths";
import { layoutTargets, relayout } from "./layout";
import { recordDelta } from "./sceneDelta";
import { childrenOf, isAncestorOf, parentExists, subtreeOf } from "./tree";

// Un SetProperties SENZA patch NON è un no-op. Go legge il patch con i getter
// nil-safe di protobuf (`p.GetX()` su un *Node nil ritorna lo zero del campo),
// quindi applySetProps AZZERA i campi elencati nella mask. Questo nodo
// tutto-a-zero rende esplicito quel comportamento invece di divergere in
// silenzio dal server. Condiviso fra le chiamate: applyOp è puro e non lo muta.
const NIL_PATCH: PbNode = create(NodeSchema, {});

// applyOp è puro: NON muta state, ritorna un nuovo oggetto. Parità con core.Apply (Go).
//
// Dopo l'op ridispone i frame con auto layout che può aver toccato, come fa
// core.Apply: i frame interessati si leggono sia PRIMA dell'op (il vecchio
// parent di un nodo cancellato o spostato) sia DOPO (il nuovo). Vedi
// store/layout.ts.
export function applyOp(state: SceneState, op: Op): SceneState {
  const before = layoutTargets(state, op);
  const next = applyOpRaw(state, op);
  if (next === state) return state;
  const touchedByLayout: string[] = [];
  const laidOut = relayout(next, [...before, ...layoutTargets(next, op)], touchedByLayout);
  // Gli op che toccano un solo nodo noto dichiarano quale: chi mantiene
  // strutture derivate (renderer/sceneIndex.ts) non deve confrontare tutta la
  // scena per scoprirlo. Gli altri (cancellare, riparentare, pagine,
  // componenti) non la registrano e ricadono sul confronto completo.
  const id = singleTouchedNode(op);
  if (id !== null) recordDelta(laidOut, state, [id, ...touchedByLayout]);
  return laidOut;
}

// L'unico nodo che l'op scrive, se ne scrive esattamente uno.
function singleTouchedNode(op: Op): string | null {
  const k = op.kind;
  switch (k.case) {
    case "createNode": return k.value.node?.id ?? null;
    case "setProps": return k.value.id;
    case "setText": return k.value.id;
    case "setVectorPath": return k.value.id;
    default: return null;
  }
}

function applyOpRaw(state: SceneState, op: Op): SceneState {
  switch (op.kind.case) {
    case "createNode": {
      const pb = op.kind.value.node;
      // Parità con core.applyCreate (Go): nodo assente o con id vuoto =
      // ErrNilNode, id GIÀ PRESENTE = ErrNodeExists. Il server rifiuta l'op in
      // blocco in entrambi i casi, quindi qui non si crea e soprattutto non si
      // SOVRASCRIVE: un client che sovrascrive in locale diverge in silenzio
      // dal documento autorevole (e l'undo di quell'op sarebbe l'undo di
      // qualcosa che il server non ha mai accettato).
      if (!pb || pb.id === "" || state.nodes[pb.id]) return state;
      // Il parent deve ESISTERE (un altro nodo, o una Page per i root):
      // ErrParentNotFound in core.applyCreate (Go). Un nodo con un parent
      // inesistente non è raggiungibile da nessuna pagina -- invisibile sul
      // canvas e nel pannello livelli, ma presente nella mappa -- e il server
      // l'ha comunque rifiutato: crearlo qui è la solita divergenza silenziosa.
      if (!parentExists(state, pb.parentId)) return state;
      // Un'ISTANZA deve referenziare un componente ESISTENTE: parità con
      // core.applyCreate (Go), che risponde ErrComponentNotFound. Senza, l'istanza
      // renderebbe il vuoto -- il suo sottoalbero è derivato dal master -- e il
      // server l'ha comunque rifiutata: crearla qui è la stessa divergenza
      // silenziosa dei rami parent/id-già-preso. Ordine come in Go: prima il
      // parent, poi il componente.
      if (pb.shape.case === "instance" && !state.components[pb.shape.value.componentId]) return state;
      return { ...state, nodes: { ...state.nodes, [pb.id]: toNodeLite(pb) } };
    }
    case "setProps": {
      const { id, patch, mask } = op.kind.value;
      const cur = state.nodes[id];
      // Nodo inesistente = ErrNodeNotFound in Go: op rifiutato, scena
      // invariata. Il patch mancante invece NON ferma l'op (vedi NIL_PATCH).
      if (!cur) return state;
      const p = patch ?? NIL_PATCH;
      const paths = mask?.paths ?? [];
      // Parità con core.applySetProps (Go): valida l'INTERA mask prima di
      // mutare qualsiasi campo. Se anche un solo path non è supportato,
      // l'intero op viene rifiutato (stato invariato) -- non applicato
      // parzialmente. Una mask mista (es. ["x","someFutureField"]) non deve
      // mai mutare "x" mentre scarta silenziosamente il path sconosciuto.
      // isMaskPath viene da ./maskPaths -- l'UNICA fonte di verità, condivisa
      // con tools/ops.ts::makeSetPropsOp, che rispecchia lo switch di
      // core.applySetProps (Go). paths qui è quello che arriva DA UN Op già
      // decodificato (locale o dal filo via Subscribe): un controllo runtime
      // resta necessario anche col tipo MaskPath a compile-time ai punti di
      // costruzione, perché nulla garantisce a runtime che un Op ricevuto dal
      // filo rispetti quel tipo.
      if (!paths.every(isMaskPath)) return state;
      // Seconda validazione PREVENTIVA, per lo stesso motivo della prima:
      // "corner_radius" è l'unico path che indirizza un campo DENTRO il oneof
      // `shape` (RectNode.corner_radius), quindi è l'unico che può trovare il
      // nodo della forma sbagliata. Go risponde ErrNotRectNode e rifiuta l'op
      // INTERO (internal/core/apply.go), quindi una mask mista
      // (es. ["x","corner_radius"]) su un'ellisse non deve muovere nemmeno la
      // x. Nota che kind "rect" comprende anche il nodo SENZA shape (vedi
      // toNodeLite): Go lo accetta allo stesso modo, materializzando il
      // rettangolo implicito.
      //
      // Ed è una WHITELIST esattamente come quella di Go, non "tutto tranne
      // ellisse e testo": kindOf (store/types.ts) mappa su "unknown" ogni forma
      // che questo modello non conosce, quindi una forma aggiunta da un'altra
      // traccia è rifiutata di default QUI come lo è di là. Con il vecchio
      // ripiego "sconosciuto => rect" questa riga la lasciava passare e Go
      // rispondeva ErrNotRectNode: la divergenza client/documento autorevole che
      // la whitelist esiste per impedire, solo dall'altro lato del filo.
      if (cur.kind !== "rect" && paths.includes("corner_radius")) return state;
      // Stessa validazione preventiva per auto_layout, che vale solo su un
      // frame (ErrNotFrameNode in Go): op rifiutato in blocco.
      if (cur.kind !== "frame" && paths.includes("auto_layout")) return state;
      const next: NodeLite = { ...cur };
      for (const path of paths as readonly MaskPath[]) {
        switch (path) {
          case "x": next.x = p.x; break;
          case "y": next.y = p.y; break;
          case "width": next.width = p.width; break;
          case "height": next.height = p.height; break;
          case "rotation": next.rotation = p.rotation; break;
          case "opacity": next.opacity = p.opacity; break;
          case "name": next.name = p.name; break;
          case "visible": next.visible = p.visible; break;
          case "fills": next.fills = toNodeLite(p).fills; break;
          // SOSTITUZIONE dell'intera lista, come "fills" e come `n.Strokes =
          // p.GetStrokes()` in core.applySetProps (Go): mai una fusione
          // elemento per elemento. Un patch SENZA strokes azzera la lista --
          // è il getter nil-safe di Go, ed è anche il modo in cui il pannello
          // proprietà toglie il tratto da un nodo (vedi NIL_PATCH qui sopra).
          case "strokes": next.strokes = toNodeLite(p).strokes; break;
          // Sostituzione dell'intera lista come `n.Effects = p.GetEffects()` in
          // Go. Una lista vuota TOGLIE il campo (NodeLite.effects è assente, non
          // vuoto, quando non ci sono effetti).
          case "effects": {
            const fx = toNodeLite(p).effects;
            if (fx) next.effects = fx; else delete next.effects;
            break;
          }
          // Il path è snake_case (la convenzione del .proto e di Go), il campo
          // del modello è camelCase: le due forme coincidevano per tutti i path
          // monoparola di M0/M1a, questo è il primo in cui divergono.
          case "order_key": next.orderKey = p.orderKey; break;
          // Come per "fills", il valore si estrae dal patch passando da
          // toNodeLite invece di leggerlo a mano: è la STESSA funzione che
          // traduce un Node del filo, quindi il patch senza rect ricade sullo
          // zero esattamente come fa il getter nil-safe `p.GetRect()
          // .GetCornerRadius()` in Go, senza una seconda regola da tenere
          // allineata.
          case "corner_radius": next.cornerRadius = toNodeLite(p).cornerRadius; break;
          // Il valore viene dal patch NIDIFICATO nella forma frame, passando da
          // toNodeLite come per corner_radius. Un patch senza frame (o senza
          // auto_layout) lo spegne -- come il getter nil-safe di Go -- e il campo
          // sparisce dal nodo invece di restare "spento".
          case "auto_layout": {
            const al = toNodeLite(p).autoLayout;
            if (al) next.autoLayout = al; else delete next.autoLayout;
            break;
          }
          default: {
            // Guardia a compile-time: se MASK_PATHS guadagna un membro senza
            // un case qui sopra, questa riga smette di compilare invece di
            // scartare in silenzio il nuovo path a runtime. "Impossibile
            // dimenticare un caso" è il complemento di "impossibile costruire
            // un path non valido" (quello è ops.ts::makeSetPropsOp).
            const exhaustive: never = path;
            return exhaustive;
          }
        }
      }
      return { ...state, nodes: { ...state.nodes, [id]: next } };
    }
    // Op dedicato e non un path della mask di setProps: il contenuto vive
    // DENTRO il oneof `shape` del Node, mentre la mask indirizza campi di primo
    // livello. Parità con core.applySetText (Go).
    case "setText": {
      const { id, content, style, stylePresent } = op.kind.value;
      const cur = state.nodes[id];
      // Nodo inesistente = ErrNodeNotFound in Go.
      if (!cur) return state;
      // Nodo non di testo = ErrNotTextNode in Go: l'op è rifiutato in blocco.
      // Scriverci dentro un `text` trasformerebbe la forma del nodo in locale
      // (un rettangolo diventato testo) mentre il server l'ha respinto.
      if (cur.kind !== "text" || !cur.text) return state;
      // Il contenuto si scrive SEMPRE (anche vuoto: è il testo cancellato).
      // Lo stile solo se stylePresent: il flag distingue "non specificato" da
      // "azzera" (in proto3 uno stile assente e uno tutto a zero non si
      // distinguono dopo il round-trip protojson, quindi senza il flag ogni
      // battuta di tasto porterebbe il font a 0). Il flag ha la precedenza
      // sulla presenza del sotto-messaggio: uno `style` con stylePresent=false
      // va ignorato, esattamente come fa Go che legge solo GetStylePresent().
      const text = {
        content,
        style: stylePresent ? toTextStyleLite(style) : cur.text.style,
      };
      return { ...state, nodes: { ...state.nodes, [id]: { ...cur, text } } };
    }
    // Op dedicato e non un path della mask, per la stessa ragione di setText: la
    // geometria vive DENTRO il oneof `shape`. Parità con core.applySetVectorPath (Go).
    case "setVectorPath": {
      const { id, subpaths } = op.kind.value;
      const cur = state.nodes[id];
      // Nodo inesistente = ErrNodeNotFound in Go.
      if (!cur) return state;
      // Nodo non vettoriale = ErrNotVectorNode in Go: l'op è rifiutato in
      // blocco. Nota che qui NON vale il ripiego "kind rect comprende anche il
      // nodo senza shape" di corner_radius: quel nodo è un RETTANGOLO per
      // entrambi i lati, quindi è esattamente il caso da rifiutare.
      if (cur.kind !== "vector" || !cur.vector) return state;
      // La lista si scrive SEMPRE, anche vuota: è il path che l'utente ha
      // svuotato, non un "non specificato" da ignorare. Nessun flag `present`
      // come stylePresent -- là serviva perché un setText porta due cose e una
      // doveva poter restare intatta; qui l'op È i subpath.
      return {
        ...state,
        nodes: { ...state.nodes, [id]: { ...cur, vector: { subpaths: toSubPathsLite(subpaths) } } },
      };
    }
    // Cancella il nodo E TUTTO il suo sottoalbero. Parità con core.applyDelete
    // (Go): senza la cascata i figli resterebbero nella mappa con un parentId
    // che non esiste più -- gli stessi orfani che il ramo createNode qui sopra
    // rifiuta di creare.
    case "deleteNode": {
      const { id } = op.kind.value;
      // Id inesistente = ErrNodeNotFound in Go: op rifiutato, scena invariata
      // (e nessun oggetto nuovo, così i selettori non si svegliano a vuoto).
      if (!state.nodes[id]) return state;
      const nodes = { ...state.nodes };
      for (const n of subtreeOf(state, id)) delete nodes[n.id];
      return { ...state, nodes };
    }
    // Op dedicato e non un path della mask di setProps (a differenza di
    // `order_key`) perché ha una validazione che nessun campo ha: il nuovo
    // parent deve esistere e non può essere il nodo stesso né un suo
    // discendente. Parità con core.applyReparent (Go).
    case "reparentNode": {
      const { id, newParentId, orderKey } = op.kind.value;
      const cur = state.nodes[id];
      if (!cur) return state;                                   // ErrNodeNotFound
      if (!parentExists(state, newParentId)) return state;      // ErrParentNotFound
      // Un ciclo staccherebbe il sottoalbero dal documento (nessuna pagina ci
      // arriverebbe più) lasciandolo però nella mappa: invisibile e non
      // cancellabile. Il nodo stesso è il caso degenere -- isAncestorOf è
      // stretta -- quindi va escluso a parte. ErrCycle in Go.
      if (newParentId === id || isAncestorOf(state, id, newParentId)) return state;
      return {
        ...state,
        // Il sottoalbero segue il nodo senza essere riscritto: i figli puntano
        // al nodo, non al nonno.
        nodes: { ...state.nodes, [id]: { ...cur, parentId: newParentId, orderKey } },
      };
    }
    // --- pagine -------------------------------------------------------------
    // Le pagine sono i container RADICE (un parentId può essere l'id di un nodo
    // o quello di una Page): un op che le tocca cambia dove i nodi possono
    // vivere, non un nodo. Parità con core.applyCreatePage / applyDeletePage /
    // applyRenamePage (Go).
    case "createPage": {
      const page = op.kind.value.page;
      // Pagina assente o senza id = ErrNilPage; id GIÀ PRESO -- da un'altra
      // pagina o da un NODO -- = ErrPageExists. La collisione con un nodo conta
      // quanto quella con una pagina: parentExists risponde "sì" per entrambi,
      // quindi due container omonimi renderebbero ambiguo il parent di chiunque
      // li nomini.
      if (!page || page.id === "" || parentExists(state, page.id)) return state;
      // In CODA, come Go: la posizione nell'elenco è l'ordine del selettore di
      // pagina, non una proprietà del documento.
      return { ...state, pages: [...state.pages, { id: page.id, name: page.name }] };
    }
    // Cancella la pagina E TUTTI i nodi che le pendono sotto. Stessa cascata di
    // deleteNode portata alla radice: ciò che non è raggiungibile da nessuna
    // pagina non fa parte del documento, quindi lasciarne i nodi nella mappa
    // sarebbero gli orfani che createNode rifiuta di creare.
    case "deletePage": {
      const { id } = op.kind.value;
      const i = state.pages.findIndex((p) => p.id === id);
      if (i < 0) return state;                    // ErrPageNotFound
      // L'ULTIMA pagina non si cancella: senza pagine non esiste nessun parent
      // valido, quindi nessun nodo potrebbe più essere creato. ErrLastPage.
      if (state.pages.length === 1) return state;
      const nodes = { ...state.nodes };
      for (const root of childrenOf(state, id)) {
        for (const n of subtreeOf(state, root.id)) delete nodes[n.id];
      }
      return { ...state, pages: [...state.pages.slice(0, i), ...state.pages.slice(i + 1)], nodes };
    }
    case "renamePage": {
      const { id, name } = op.kind.value;
      const i = state.pages.findIndex((p) => p.id === id);
      if (i < 0) return state;                    // ErrPageNotFound
      const pages = [...state.pages];
      // Scritto SEMPRE, anche vuoto: il valore che arriva è il valore finale, e
      // il ripiego per un nome vuoto è della UI (come per Node.name).
      pages[i] = { ...pages[i], name };
      return { ...state, pages };
    }
    // --- componenti / istanze (M4) ------------------------------------------
    // Parità con core.applyCreateComponent / applySetInstanceOverride (Go).
    case "createComponent": {
      const { componentId, rootNodeId, name } = op.kind.value;
      // id vuoto (Go risponde ErrComponentNotFound "(empty id)"), id GIÀ PRESO
      // (ErrComponentExists) o radice non in `nodes` (ErrNodeNotFound): in tutti
      // e tre i casi il server rifiuta l'op e non registra nulla, quindi qui la
      // scena resta invariata (stesso oggetto, così i selettori non si svegliano
      // a vuoto).
      if (componentId === "" || state.components[componentId] || !state.nodes[rootNodeId]) return state;
      // Non copia il sottoalbero: lo referenzia. Il master resta vivo in `nodes`,
      // e la propagazione master->istanze è quindi gratis.
      return { ...state, components: { ...state.components, [componentId]: { rootNodeId, name } } };
    }
    case "setInstanceOverride": {
      const { instanceId, override } = op.kind.value;
      const cur = state.nodes[instanceId];
      // Nodo inesistente = ErrNodeNotFound; nodo NON-istanza = ErrNotInstanceNode
      // (un override su un rettangolo è un op sul nodo sbagliato, non un campo da
      // riempire); master_node_id vuoto = rifiutato in Go. In tutti i casi scena
      // invariata.
      if (!cur) return state;
      if (cur.kind !== "instance" || !cur.instance) return state;
      if (!override || override.masterNodeId === "") return state;
      // Upsert per master_node_id, ESATTAMENTE come core.applySetInstanceOverride:
      // togli l'override con lo stesso master, poi rimetti quello nuovo SOLO se
      // sovrascrive davvero qualcosa (fills_present || text_present). Altrimenti
      // l'op È una rimozione -- il nodo del master torna a ereditare dal master.
      const kept = cur.instance.overrides.filter((o) => o.masterNodeId !== override.masterNodeId);
      if (override.fillsPresent || override.textPresent) kept.push(toInstanceOverrideLite(override));
      return {
        ...state,
        nodes: { ...state.nodes, [instanceId]: { ...cur, instance: { ...cur.instance, overrides: kept } } },
      };
    }
    default:
      return state;
  }
}
