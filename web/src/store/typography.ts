import { TextStyleKind } from "../gen/opendesigner/v1/opendesigner_pb";
import type { FontFace as PbFont, TextStyleDef as PbTextStyleDef } from "../gen/opendesigner/v1/opendesigner_pb";
import { flattenStyle } from "./richText";
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

/** Parity with core.validateTextStyleDef (including validateStyleRelations). */
export function isValidTextStyleDef(state: SceneState, d: PbTextStyleDef | undefined): d is PbTextStyleDef {
  if (!d || d.id === "") return false;
  const st = d.style;
  if (!st || !finiteNonNeg(st.fontSize) || !finiteNonNeg(st.lineHeight) || !FAMILY_LIST_RE.test(st.fontFamily)) return false;
  const w = st.fontWeight;
  if (!(w === "" || WEIGHT_RE.test(w) || w === "normal" || w === "bold")) return false;
  if (d.kind !== TextStyleKind.PARAGRAPH && d.kind !== TextStyleKind.CHARACTER) return false;
  if (![d.spaceBefore, d.spaceAfter, d.indentFirst, d.indentLeft].every(finiteNonNeg)) return false;
  const character = d.kind === TextStyleKind.CHARACTER;
  if (character && (d.nextStyleId !== "" || d.spaceBefore !== 0 || d.spaceAfter !== 0 || d.indentFirst !== 0 || d.indentLeft !== 0)) return false;
  if (d.nextStyleId !== "" && d.nextStyleId !== d.id) {
    const n = state.textStyles[d.nextStyleId];
    if (!n || n.kind === "character") return false;
  }
  const wantCharacter = character;
  const total = Object.keys(state.textStyles).length;
  for (let cur = d.basedOn, hops = 0; cur !== ""; hops++) {
    const b = state.textStyles[cur];
    if (cur === d.id || !b || (b.kind === "character") !== wantCharacter || hops > total + 1) return false;
    cur = b.basedOn ?? "";
  }
  return true;
}

/** Parity with core.validateTextStyleID: only a text node, and an existing PARAGRAPH style (or none). */
export function isValidTextStyleId(state: SceneState, n: NodeLite, id: string): boolean {
  if (n.kind !== "text") return false;
  return id === "" || (!!state.textStyles[id] && state.textStyles[id].kind !== "character");
}

/** `n` with its shared text style applied (the node's own style stays as the fallback). Parity with core.resolveTextStyle. */
export function resolveTextStyleNode(state: SceneState, n: NodeLite): NodeLite {
  if (n.kind !== "text" || !n.text || !n.textStyleId) return n;
  const def = state.textStyles[n.textStyleId];
  if (!def || def.kind === "character") return n;
  // With a `basedOn` chain the style is the chain folded in; without one, exactly the style's own values.
  const flat = flattenStyle(state.textStyles, def.id);
  return flat ? { ...n, text: { ...n.text, style: flat.style } } : n;
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
