import { create } from "@bufbuild/protobuf";
import { NodeSchema } from "../gen/brawt/v1/brawt_pb";
import type { Node as PbNode, Op } from "../gen/brawt/v1/brawt_pb";
import { type SceneState, type NodeLite, toNodeLite, toTextStyleLite } from "./types";
import { type MaskPath, isMaskPath } from "./maskPaths";

// Un SetProperties SENZA patch NON è un no-op. Go legge il patch con i getter
// nil-safe di protobuf (`p.GetX()` su un *Node nil ritorna lo zero del campo),
// quindi applySetProps AZZERA i campi elencati nella mask. Questo nodo
// tutto-a-zero rende esplicito quel comportamento invece di divergere in
// silenzio dal server. Condiviso fra le chiamate: applyOp è puro e non lo muta.
const NIL_PATCH: PbNode = create(NodeSchema, {});

// applyOp è puro: NON muta state, ritorna un nuovo oggetto. Parità con core.Apply (Go).
export function applyOp(state: SceneState, op: Op): SceneState {
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
      if (cur.kind !== "rect" && paths.includes("corner_radius")) return state;
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
    case "deleteNode": {
      const { id } = op.kind.value;
      const nodes = { ...state.nodes };
      delete nodes[id];
      return { ...state, nodes };
    }
    default:
      return state;
  }
}
