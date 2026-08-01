import type { Op } from "../gen/brawt/v1/brawt_pb";
import { type SceneState, type NodeLite, toNodeLite } from "./types";

// Path supportati da SetProperties.mask, mirror di applySetProps (Go).
const SUPPORTED_MASK_PATHS = new Set([
  "x", "y", "width", "height", "rotation", "opacity", "name", "visible", "fills",
]);

// applyOp è puro: NON muta state, ritorna un nuovo oggetto. Parità con core.Apply (Go).
export function applyOp(state: SceneState, op: Op): SceneState {
  switch (op.kind.case) {
    case "createNode": {
      const pb = op.kind.value.node;
      if (!pb) return state;
      return { ...state, nodes: { ...state.nodes, [pb.id]: toNodeLite(pb) } };
    }
    case "setProps": {
      const { id, patch, mask } = op.kind.value;
      const cur = state.nodes[id];
      if (!cur || !patch) return state;
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
          case "x": next.x = patch.x; break;
          case "y": next.y = patch.y; break;
          case "width": next.width = patch.width; break;
          case "height": next.height = patch.height; break;
          case "rotation": next.rotation = patch.rotation; break;
          case "opacity": next.opacity = patch.opacity; break;
          case "name": next.name = patch.name; break;
          case "visible": next.visible = patch.visible; break;
          case "fills": next.fills = toNodeLite(patch).fills; break;
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
