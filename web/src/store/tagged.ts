import { booleanOpOf } from "../vector/regions";
import { connectorOf } from "../vector/connector";
import { deltaOf } from "./sceneDelta";
import type { NodeLite, SceneState } from "./types";

// WHICH NODES THE DERIVED PASSES CARE ABOUT. Live booleans, connectors and variable bindings are
// rare, but finding them used to mean scanning every node on every change: 10 ms at 20,000
// nodes, 16 ms at 50,000, for a document that uses none of them. This keeps the short lists, and
// updates them from one scene to the next by looking only at the nodes the op touched (the same
// provenance the scene index uses); with no provenance (a removal, a replaced scene) it scans once.

export interface Tagged {
  booleans: ReadonlySet<string>;
  connectors: ReadonlySet<string>;
  /** Nodes with variable bindings or a text style: what the variable pass resolves. */
  bound: ReadonlySet<string>;
}

const cache = new WeakMap<SceneState, Tagged>();

const isBoolean = (n: NodeLite) => booleanOpOf(n) !== null;
const isConnector = (n: NodeLite) => connectorOf(n) !== null;
const isBound = (n: NodeLite) => !!n.bindings || !!n.textStyleId;

function scan(scene: SceneState): Tagged {
  const t = { booleans: new Set<string>(), connectors: new Set<string>(), bound: new Set<string>() };
  for (const n of scene.nodes.values()) {
    if (isBoolean(n)) t.booleans.add(n.id);
    if (isConnector(n)) t.connectors.add(n.id);
    if (isBound(n)) t.bound.add(n.id);
  }
  return t;
}

export function taggedOf(scene: SceneState): Tagged {
  const hit = cache.get(scene);
  if (hit) return hit;
  const delta = deltaOf(scene);
  const prev = delta ? cache.get(delta.prev) : undefined;
  let out: Tagged;
  if (!delta || !prev) {
    out = scan(scene);
  } else if (delta.changed.length === 0) {
    out = prev;
  } else {
    // Only the touched nodes can have changed their tags. Copy a set only when it actually changes.
    let { booleans, connectors, bound } = prev;
    const upd = (set: ReadonlySet<string>, id: string, on: boolean): ReadonlySet<string> => {
      if (set.has(id) === on) return set;
      const next = new Set(set);
      if (on) next.add(id); else next.delete(id);
      return next;
    };
    for (const id of delta.changed) {
      const n = scene.nodes.get(id);
      booleans = upd(booleans, id, !!n && isBoolean(n));
      connectors = upd(connectors, id, !!n && isConnector(n));
      bound = upd(bound, id, !!n && isBound(n));
    }
    out = { booleans, connectors, bound };
  }
  cache.set(scene, out);
  return out;
}
