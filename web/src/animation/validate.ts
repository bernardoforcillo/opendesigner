import type { ClipLite, SceneState } from "../store/types";
import { CLIP_TRIGGERS, TRACK_PROPS, isValidEasing } from "./engine";

// Validation of a clip: EXACT parity with core.validateClip (Go, the authority).
// Whoever uses it -- applyOp (to reject the op as the server would) and history
// (a rejected op has no inverse) -- only needs the yes/no.
//
// An invariant only makes sense if the two implementations apply it the same
// way: if TS accepted a clip that Go rejects, the client would for an
// instant show a scene that the server does not have. The fixture testdata/golden/animation*.json
// runs in both and verifies it.

const finite = Number.isFinite;

// The node types with an outline on which to "draw" the stroke (core.canDraw).
const DRAWABLE = new Set(["vector", "rect", "ellipse", "frame"]);

export function isValidClip(scene: Pick<SceneState, "nodes">, c: ClipLite): boolean {
  if (c.id === "") return false;
  if (!finite(c.duration) || c.duration <= 0) return false;
  if (!finite(c.delay) || c.delay < 0 || c.repeat < -1) return false;
  if (c.trigger !== "" && !(CLIP_TRIGGERS as readonly string[]).includes(c.trigger)) return false;
  if (!scene.nodes.has(c.targetId)) return false;
  const seen = new Set<string>();
  for (const t of c.tracks) {
    const n = scene.nodes.at(t.nodeId);
    if (!n) return false;
    if (!(TRACK_PROPS as readonly string[]).includes(t.prop)) return false;
    // "\u0000" cannot appear in an id: a safe separator for the pair.
    const key = `${t.nodeId}\u0000${t.prop}`;
    if (seen.has(key)) return false;
    seen.add(key);
    if (t.prop === "draw" && !DRAWABLE.has(n.kind)) return false;
    if (t.keyframes.length === 0) return false;
    const bounded = t.prop === "opacity" || t.prop === "draw";
    let prev = 0;
    for (let i = 0; i < t.keyframes.length; i++) {
      const k = t.keyframes[i];
      if (!finite(k.time) || k.time < 0 || k.time > c.duration || (i > 0 && k.time < prev)) return false;
      prev = k.time;
      if (!finite(k.value) || (bounded && (k.value < 0 || k.value > 1))) return false;
      if (!isValidEasing(k.easing)) return false;
    }
  }
  return true;
}
