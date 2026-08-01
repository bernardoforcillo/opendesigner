import { create } from "@bufbuild/protobuf";
import { NodeSchema } from "../gen/brawt/v1/brawt_pb";
import type { Node as PbNode, Op } from "../gen/brawt/v1/brawt_pb";
import { type SceneState, type NodeLite, toNodeLite } from "./types";

// Path supportati da SetProperties.mask, mirror di applySetProps (Go).
const SUPPORTED_MASK_PATHS = new Set([
  "x", "y", "width", "height", "rotation", "opacity", "name", "visible", "fills",
]);

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
      if (!paths.every((path) => SUPPORTED_MASK_PATHS.has(path))) return state;
      const next: NodeLite = { ...cur };
      for (const path of paths) {
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
        }
      }
      return { ...state, nodes: { ...state.nodes, [id]: next } };
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
