import type { FontFace as PbFont, TextStyleDef as PbTextStyleDef } from "../gen/opendesigner/v1/opendesigner_pb";
import type { NodeLite, SceneState } from "./types";

// TYPOGRAPHY -- the TypeScript twin of internal/core/typography.go. Go is the
// authority; every rule here repeats one there, and the golden fixture
// testdata/golden/typography.json runs both sides. See the invariants at the top
// of that file.

// Parity with the Go regexps (the `u` flag makes \p{L}/\p{N} and the {1,64} count
// work in code points, as Go's do in runes).
const FAMILY_RE = /^[\p{L}\p{N} _.\-]{1,64}$/u;
const FAMILY_LIST_RE = /^[\p{L}\p{N} _.,'\-]{0,128}$/u;
const WEIGHT_RE = /^[1-9]00$/;
const HASH_RE = /^[0-9a-f]{64}$/;

const finiteNonNeg = (v: number) => Number.isFinite(v) && v >= 0;

/** Parity with core.validateFont. */
export function isValidFont(state: SceneState, f: PbFont | undefined): f is PbFont {
  if (!f || f.id === "") return false;
  if (!FAMILY_RE.test(f.family) || f.family.trim() === "") return false;
  if (!WEIGHT_RE.test(f.weight)) return false;
  if (f.style !== "normal" && f.style !== "italic") return false;
  if (!HASH_RE.test(f.assetHash)) return false;
  for (const o of Object.values(state.fonts)) {
    if (o.id !== f.id && o.family === f.family && o.weight === f.weight && o.style === f.style) return false;
  }
  return true;
}

/** Parity with core.validateTextStyleDef. */
export function isValidTextStyleDef(d: PbTextStyleDef | undefined): d is PbTextStyleDef {
  if (!d || d.id === "") return false;
  const st = d.style;
  if (!st || !finiteNonNeg(st.fontSize) || !finiteNonNeg(st.lineHeight) || !FAMILY_LIST_RE.test(st.fontFamily)) return false;
  const w = st.fontWeight;
  return w === "" || WEIGHT_RE.test(w) || w === "normal" || w === "bold";
}

/** Parity with core.validateTextStyleID: only a text node, and an existing style (or none). */
export function isValidTextStyleId(state: SceneState, n: NodeLite, id: string): boolean {
  if (n.kind !== "text") return false;
  return id === "" || !!state.textStyles[id];
}

/** `n` with its shared text style applied (the node's own style stays as the fallback). Parity with core.resolveTextStyle. */
export function resolveTextStyleNode(state: SceneState, n: NodeLite): NodeLite {
  if (n.kind !== "text" || !n.text || !n.textStyleId) return n;
  const def = state.textStyles[n.textStyleId];
  if (!def) return n;
  return { ...n, text: { ...n.text, style: def.style } };
}

/** Text nodes that use a shared style, to clear when it is deleted. */
export function unstyleNodes(state: SceneState, styleId: string): SceneState["nodes"] {
  let edit: ReturnType<SceneState["nodes"]["edit"]> | null = null;
  for (const n of state.nodes.values()) {
    if (n.textStyleId !== styleId) continue;
    const next: NodeLite = { ...n };
    delete next.textStyleId;
    (edit ??= state.nodes.edit()).set(n.id, next);
  }
  return edit ? edit.done() : state.nodes;
}
