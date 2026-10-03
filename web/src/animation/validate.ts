import type { ClipLite, SceneState } from "../store/types";
import { CLIP_TRIGGERS, TRACK_PROPS, isValidEasing } from "./engine";

// Validazione di una clip: parità ESATTA con core.validateClip (Go, l'autorità).
// Chi la usa -- applyOp (per rifiutare l'op come farebbe il server) e history
// (un op rifiutato non ha inverso) -- ha bisogno solo del sì/no.
//
// Un'invariante ha senso solo se le due implementazioni la applicano allo stesso
// modo: se TS accettasse una clip che Go rifiuta, il client mostrerebbe per un
// istante una scena che il server non ha. La fixture testdata/golden/animation*.json
// gira in entrambe e lo verifica.

const finite = Number.isFinite;

// I tipi di nodo con un contorno su cui "disegnare" il tratto (core.canDraw).
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
    // "\u0000" non può comparire in un id: separatore sicuro per la coppia.
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
