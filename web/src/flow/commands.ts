import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "../store/store";
import type { FlowLite, NodeLite, SceneState, TransitionLite } from "../store/types";
import { makeDeleteFlowOp, makeDeleteTransitionOp, makeSetFlowOp, makeSetPropsOp, makeSetTransitionOp, uuid } from "../tools/ops";
import { resolveFlow } from "../store/flowUi";
import { withMeta } from "./meta";

// I COMANDI DEI FLUSSI: dalle intenzioni dell'utente agli op. Le funzioni
// `...Ops` sono pure (scena -> op, testabili senza store); `submit` è l'unico
// punto che tocca lo store, con la regola di sempre: UN gesto = UN invio = UNA
// voce di undo (store.ts::endGesture).

/** Manda gli op come un solo gesto annullabile. */
export function submit(ops: Op[]): void {
  if (ops.length === 0) return;
  const st = useScene.getState();
  st.beginGesture();
  st.endGesture(ops);
}

/** "Flusso 1", "Flusso 2"...: il primo numero libero, non il conteggio (un flusso cancellato libera il suo). */
export function nextFlowName(scene: SceneState): string {
  const names = new Set(Object.values(scene.flows).map((f) => f.name));
  for (let i = 1; ; i++) {
    const n = `Flusso ${i}`;
    if (!names.has(n)) return n;
  }
}

export interface ConnectResult {
  ops: Op[];
  flowId: string;
  transitionId: string;
  /** Il flusso è stato creato da questo gesto (non c'era nessuno). */
  createdFlow: boolean;
}

/**
 * Gli op di "Collega": la transizione fromId -> toId nel flusso corrente.
 *  - nessun flusso: ne nasce uno, "Flusso N", con la schermata di partenza come
 *    ingresso, NELLO STESSO gesto (un solo Ctrl+Z annulla tutto);
 *  - flusso senza schermata d'ingresso: la prende la schermata di partenza;
 *  - l'op della transizione viene dopo quello del flusso (riferimento valido).
 */
export function connectOps(
  scene: SceneState,
  currentFlowId: string | null,
  fromId: string,
  toId: string,
  elementId: string,
): ConnectResult {
  const ops: Op[] = [];
  let flow = resolveFlow(scene, currentFlowId);
  let createdFlow = false;
  if (!flow) {
    flow = { id: uuid(), name: nextFlowName(scene), description: "", startId: fromId };
    createdFlow = true;
    ops.push(makeSetFlowOp(flow));
  } else if (flow.startId === "" || !scene.nodes.has(flow.startId)) {
    ops.push(makeSetFlowOp({ ...flow, startId: fromId }));
  }
  const transition: TransitionLite = {
    id: uuid(),
    flowId: flow.id,
    fromId,
    toId,
    label: "",
    trigger: "click",
    elementId,
    guard: "",
    effect: "",
  };
  ops.push(makeSetTransitionOp(transition));
  return { ops, flowId: flow.id, transitionId: transition.id, createdFlow };
}

export function createFlowOp(scene: SceneState): { op: Op; flow: FlowLite } {
  const flow: FlowLite = { id: uuid(), name: nextFlowName(scene), description: "", startId: "" };
  return { op: makeSetFlowOp(flow), flow };
}

export function renameFlowOp(flow: FlowLite, name: string): Op | null {
  const n = name.trim();
  return n === "" || n === flow.name ? null : makeSetFlowOp({ ...flow, name: n });
}

export function setStartOp(flow: FlowLite, screenId: string): Op | null {
  return flow.startId === screenId ? null : makeSetFlowOp({ ...flow, startId: screenId });
}

export function deleteFlowOp(id: string): Op {
  return makeDeleteFlowOp(id);
}

/** Modifica un campo di una transizione. null se non cambia nulla (niente op a vuoto). */
export function editTransitionOp(
  t: TransitionLite,
  field: "label" | "trigger" | "guard" | "effect" | "elementId",
  value: string,
): Op | null {
  if (t[field] === value) return null;
  return makeSetTransitionOp({ ...t, [field]: value });
}

export function deleteTransitionOp(id: string): Op {
  return makeDeleteTransitionOp(id);
}

/** Scrive una chiave dei metadati di un nodo (read-modify-write: la mask "meta" sostituisce la mappa). */
export function setMetaOp(node: NodeLite, key: string, value: string): Op | null {
  const next = withMeta(node, key, value);
  const prev = node.meta ?? {};
  const same =
    Object.keys(next).length === Object.keys(prev).length && Object.keys(next).every((k) => prev[k] === next[k]);
  if (same) return null;
  return makeSetPropsOp(node.id, { meta: next }, ["meta"]);
}
