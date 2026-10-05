import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "../store/store";
import type { FlowLite, NodeLite, SceneState, TransitionLite } from "../store/types";
import { makeDeleteFlowOp, makeDeleteTransitionOp, makeSetFlowOp, makeSetPropsOp, makeSetTransitionOp, uuid } from "../tools/ops";
import { resolveFlow } from "../store/flowUi";
import { withMeta } from "./meta";

// THE FLOW COMMANDS: from the user's intentions to ops. The `...Ops` functions
// are pure (scene -> ops, testable without the store); `submit` is the only
// point that touches the store, with the usual rule: ONE gesture = ONE send = ONE
// undo entry (store.ts::endGesture).

/** Sends the ops as a single undoable gesture. */
export function submit(ops: Op[]): void {
  if (ops.length === 0) return;
  const st = useScene.getState();
  st.beginGesture();
  st.endGesture(ops);
}

/** "Flow 1", "Flow 2"...: the first free number, not the count (a deleted flow frees its own). */
export function nextFlowName(scene: SceneState): string {
  const names = new Set(Object.values(scene.flows).map((f) => f.name));
  for (let i = 1; ; i++) {
    const n = `Flow ${i}`;
    if (!names.has(n)) return n;
  }
}

export interface ConnectResult {
  ops: Op[];
  flowId: string;
  transitionId: string;
  /** The flow was created by this gesture (there was none). */
  createdFlow: boolean;
}

/**
 * The ops of "Connect": the fromId -> toId transition in the current flow.
 *  - no flow: one is born, "Flow N", with the starting screen as the
 *    entry, IN THE SAME gesture (a single Ctrl+Z undoes everything);
 *  - flow without an entry screen: the starting screen takes it;
 *  - the transition's op comes after the flow's (valid reference).
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

/** Edits a field of a transition. null if nothing changes (no empty ops). */
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

/** Writes a key of a node's metadata (read-modify-write: the "meta" mask replaces the map). */
export function setMetaOp(node: NodeLite, key: string, value: string): Op | null {
  const next = withMeta(node, key, value);
  const prev = node.meta ?? {};
  const same =
    Object.keys(next).length === Object.keys(prev).length && Object.keys(next).every((k) => prev[k] === next[k]);
  if (same) return null;
  return makeSetPropsOp(node.id, { meta: next }, ["meta"]);
}
