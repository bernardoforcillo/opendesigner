import { nodesOf } from "../store/nodeMap";
import { emptyScene } from "../store/types";
import type { FlowLite, NodeLite, SceneState, TransitionLite } from "../store/types";

// Fixtures for the flow tests: a small but realistic scene. Three screens
// (top-level frames) side by side, a button inside the first and a
// loose rectangle at page level (which is NOT a screen).

export function frame(id: string, x: number, y = 0, extra: Partial<NodeLite> = {}): NodeLite {
  return {
    id, parentId: "page1", orderKey: `a${id}`, name: id, visible: true, opacity: 1,
    x, y, width: 200, height: 300, rotation: 0, fills: [], strokes: [], kind: "frame", cornerRadius: 0,
    clipsContent: true, ...extra,
  };
}

export function child(id: string, parentId: string, x: number, y: number, extra: Partial<NodeLite> = {}): NodeLite {
  return {
    id, parentId, orderKey: `a${id}`, name: id, visible: true, opacity: 1,
    x, y, width: 80, height: 30, rotation: 0, fills: [], strokes: [], kind: "rect", cornerRadius: 0,
    clipsContent: false, ...extra,
  };
}

export function transition(id: string, flowId: string, fromId: string, toId: string, extra: Partial<TransitionLite> = {}): TransitionLite {
  return { id, flowId, fromId, toId, label: "", trigger: "click", elementId: "", guard: "", effect: "", ...extra };
}

export function flowOf(id: string, startId = "", name = id): FlowLite {
  return { id, name, description: "", startId };
}

/**
 * A (x=0) -> B (x=400) -> C (x=800); the button `btn` sits inside A; `loose` is a
 * page rectangle. No flows: the tests add them.
 */
export function baseScene(): SceneState {
  const nodes = nodesOf({
    A: frame("A", 0),
    B: frame("B", 400),
    C: frame("C", 800),
    btn: child("btn", "A", 60, 200),
    loose: child("loose", "page1", 0, 600, { parentId: "page1" }),
  });
  return { ...emptyScene("doc", "t"), nodes };
}

export function withFlows(scene: SceneState, flows: FlowLite[], transitions: TransitionLite[]): SceneState {
  return {
    ...scene,
    flows: Object.fromEntries(flows.map((f) => [f.id, f])),
    transitions: Object.fromEntries(transitions.map((t) => [t.id, t])),
  };
}
