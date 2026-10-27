import { ListKind, TabAlign, TextScript, TextStyleKind } from "@/gen/opendesigner/v1/opendesigner_pb";
import type { FontFace as PbFont, TextStyleDef as PbTextStyleDef } from "@/gen/opendesigner/v1/opendesigner_pb";
import { flattenStyle } from "@/store/richText";
import type { NodeLite, SceneState } from "@/store/types";

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

const FEATURES_RE = /^[A-Za-z0-9 ,"]{0,128}$/;

/** Parity with core.ValidFontFeatures: "" or comma-separated `"tag"` / `"tag" N` items. */
export function isValidFontFeatures(s: string): boolean {
  return isCssFontFeatures(s) || validFontFeatures(s);
}

function isCssFontFeatures(s: string): boolean {
  if (s === "") return true;
  if (!FEATURES_RE.test(s)) return false;
  for (const item of s.split(",")) {
    const parts = item.trim().split(/\s+/).filter((p) => p !== "");
    if (parts.length === 0 || parts.length > 2) return false;
    if (!/^"[A-Za-z0-9]{4}"$/.test(parts[0])) return false;
    if (parts.length === 2 && !/^[0-9]{1,4}$/.test(parts[1])) return false;
  }
  return true;
}

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

const FEATURE_RE = /^[A-Za-z0-9]{4}( (on|off|[0-9]{1,3}))?$/;
/** Parity with core.validFontFeatures: comma-separated OpenType feature settings. */
export function validFontFeatures(s: string): boolean {
  if (s === "") return true;
  return s.length <= 128 && s.split(",").every((item) => FEATURE_RE.test(item.trim()));
}

const VARIATION_RE = /^[A-Za-z0-9]{4} -?[0-9]{1,4}(\.[0-9]{1,3})?$/;
/** Parity with core.validFontVariations: comma-separated variable-font axis settings. */
export function validFontVariations(s: string): boolean {
  if (s === "") return true;
  return s.length <= 128 && s.split(",").every((item) => VARIATION_RE.test(item.trim()));
}

const colorOk = (c: { r: number; g: number; b: number; a: number } | undefined) => !c || [c.r, c.g, c.b, c.a].every((v) => Number.isFinite(v) && v >= 0 && v <= 1);
const ruleOk = (r: PbTextStyleDef["ruleAbove"]) =>
  !r || (inRange(r.weight, 0, 100) && inRange(r.offset, -1000, 1000) && inRange(r.indentLeft, 0, 100000) && inRange(r.indentRight, 0, 100000) && colorOk(r.color));

const NUMBER_STYLES = new Set(["", "i", "I", "a", "A"]);
const inRange = (v: number, lo: number, hi: number) => Number.isFinite(v) && v >= lo && v <= hi;

/** Parity with core.validateParagraphFeatures: lists, tab stops, drop caps and nested styles; a character style has none. */
function validParagraphFeatures(state: SceneState, d: PbTextStyleDef): boolean {
  const any = d.hyphenate || d.listKind !== ListKind.NONE || d.listMarker !== "" || d.listNumberStyle !== "" || d.listIndent !== 0 || d.outlineLevel !== 0 ||
    d.tabStops.length > 0 || d.dropCapLines !== 0 || d.dropCapChars !== 0 || d.nestedStyles.length > 0;
  const look = d.keepWithNext || d.keepLinesTogether || d.keepFirstLines !== 0 || d.keepLastLines !== 0 || !!d.ruleAbove || !!d.ruleBelow ||
    !!d.shading || d.shadingOffset !== 0 || !!d.borderColor || d.borderWeight !== 0 || d.opticalMargin;
  if (d.kind === TextStyleKind.CHARACTER) return !any && !look;
  if (d.keepFirstLines > 6 || d.keepLastLines > 6 || !ruleOk(d.ruleAbove) || !ruleOk(d.ruleBelow) || !colorOk(d.shading) || !colorOk(d.borderColor) ||
    !inRange(d.shadingOffset, 0, 1000) || !inRange(d.borderWeight, 0, 100)) return false;
  if (d.listKind < 0 || d.listKind > ListKind.NUMBER || !NUMBER_STYLES.has(d.listNumberStyle) || d.listMarker.length > 16 ||
    /[\r\n]/.test(d.listMarker) || !(d.listIndent === 0 || inRange(d.listIndent, 0, 1000))) return false;
  if (d.outlineLevel > 9) return false;
  if ((d.dropCapLines !== 0 && (d.dropCapLines < 2 || d.dropCapLines > 10)) || d.dropCapChars > 10) return false;
  if (d.tabStops.length > 32) return false;
  let prev = -1;
  for (const t of d.tabStops) {
    if (!inRange(t.position, 0, 100000) || t.position <= prev || t.align < 0 || t.align > TabAlign.RIGHT || Array.from(t.leader).length > 1 || /[\r\n\t]/.test(t.leader)) return false;
    prev = t.position;
  }
  if (d.nestedStyles.length > 8) return false;
  for (const n of d.nestedStyles) {
    const c = state.textStyles[n.styleId];
    if (!c || c.kind !== "character" || n.delimiter === "" || new TextEncoder().encode(n.delimiter).length > 8 || n.count < 1 || n.count > 50) return false;
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
  // core.validateTextExtras: enums in range, finite non-negative indent/inset, a well-formed feature string.
  if (!(st.textCase >= 0 && st.textCase <= 4 && st.textScript >= 0 && st.textScript <= 2 &&
    st.listKind >= 0 && st.listKind <= 2 && st.verticalAlign >= 0 && st.verticalAlign <= 2 &&
    finiteNonNeg(st.indent) && finiteNonNeg(st.inset) &&
    (st.textScale === 0 || (st.textScale >= 1 && st.textScale <= 1000)))) return false;
  if (!Number.isFinite(st.letterSpacing) || Math.abs(st.letterSpacing) > 1000) return false;
  if (!(st.horizontalScale === 0 || (st.horizontalScale >= 0.1 && st.horizontalScale <= 10))) return false;
  if (!isValidFontFeatures(st.fontFeatures)) return false;
  if (!validFontVariations(st.fontVariations)) return false;
  if (st.script < 0 || st.script > TextScript.SUBSCRIPT) return false;
  if (st.color && ![st.color.r, st.color.g, st.color.b, st.color.a].every((v) => v >= 0 && v <= 1)) return false;
  if (d.kind !== TextStyleKind.PARAGRAPH && d.kind !== TextStyleKind.CHARACTER) return false;
  if (!validParagraphFeatures(state, d)) return false;
  if (![d.spaceBefore, d.spaceAfter, d.indentFirst, d.indentLeft].every(finiteNonNeg)) return false;
  const character = d.kind === TextStyleKind.CHARACTER;
  if (character && d.alignToGrid) return false;
  // Parity with validateStyleRelations: list, indent, vertical alignment and inset are not for ranges.
  if (character && (st.listKind !== 0 || st.indent !== 0 || st.verticalAlign !== 0 || st.inset !== 0)) return false;
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
