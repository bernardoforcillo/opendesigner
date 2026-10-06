import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { resolveNode } from "../store/variables";
import type { FontLite, NodeLite, SceneState, TextStyleDefLite, TextStyleLite } from "../store/types";
import { DEFAULT_FONT_FAMILY } from "../renderer/text";
import { makeSetFontOp, makeSetPropsOp, makeSetTextOp, makeSetTextStyleDefOp, uuid } from "../tools/ops";

// The pure half of the typography UI (TypographyControls, FontsDialog): it reads a
// scene and BUILDS ops, it never submits. The components hand the result to
// beginGesture/endGesture, so a click is one gesture = one undo step.

/** The generic stacks offered next to the document's own fonts. */
export const BUILTIN_FAMILIES: readonly { label: string; value: string }[] = [
  { label: "Inter", value: DEFAULT_FONT_FAMILY },
  { label: "System UI", value: "system-ui, sans-serif" },
  { label: "Serif", value: "Georgia, serif" },
  { label: "Monospace", value: "ui-monospace, monospace" },
];

/** The family choices for a picker: the built-in stacks, then each uploaded family once. */
export function familyChoices(scene: SceneState): { label: string; value: string }[] {
  const uploaded = [...new Set(Object.values(scene.fonts).map((f) => f.family))].sort((a, b) => a.localeCompare(b));
  return [...BUILTIN_FAMILIES, ...uploaded.map((family) => ({ label: family, value: family }))];
}

/** The text style a text node is drawn with: its shared style when it has one, else its own. */
export function effectiveStyle(scene: SceneState, n: NodeLite): TextStyleLite | undefined {
  return resolveNode(scene, n).text?.style;
}

/**
 * setText ops applying `patch` to the style of every text node in `ids`. A node
 * that has a shared style is DETACHED first and keeps what it was drawn with
 * (plus the patch): editing a value that the shared style overrides would
 * otherwise change nothing visible.
 */
export function styleOps(scene: SceneState, ids: readonly string[], patch: Partial<TextStyleLite>): Op[] {
  return ids.flatMap((id) => {
    const n = scene.nodes.at(id);
    if (!n || n.kind !== "text" || !n.text) return [];
    const base = effectiveStyle(scene, n) ?? n.text.style;
    const ops: Op[] = [];
    if (n.textStyleId) ops.push(makeSetPropsOp(id, { textStyleId: "" }, ["text_style_id"]));
    ops.push(makeSetTextOp(id, n.text.content, { ...base, ...patch }));
    return ops;
  });
}

/** The shared style on every text node of `ids`: its id, null if none has one, `undefined` if they differ. */
export function sharedStyleOf(scene: SceneState, ids: readonly string[]): string | null | undefined {
  let seen: string | null | undefined;
  for (const id of ids) {
    const v = scene.nodes.at(id)?.textStyleId ?? null;
    if (seen === undefined) seen = v;
    else if (seen !== v) return undefined;
  }
  return seen ?? null;
}

/** Applies the shared style `styleId` (null = detach, keeping the style the node is drawn with) to `ids`. */
export function applyStyleOps(scene: SceneState, ids: readonly string[], styleId: string | null): Op[] {
  if (styleId !== null && !scene.textStyles[styleId]) return [];
  return ids.flatMap((id) => {
    const n = scene.nodes.at(id);
    if (!n || n.kind !== "text" || !n.text) return [];
    if ((n.textStyleId ?? null) === styleId) return [];
    if (styleId !== null) return [makeSetPropsOp(id, { textStyleId: styleId }, ["text_style_id"])];
    // Detach: copy what is drawn into the node, so the text does not jump.
    const base = effectiveStyle(scene, n) ?? n.text.style;
    return [makeSetPropsOp(id, { textStyleId: "" }, ["text_style_id"]), makeSetTextOp(id, n.text.content, base)];
  });
}

/** A new shared style from the style `node` is drawn with, applied to that node. */
export function createStyleOps(scene: SceneState, node: NodeLite, name: string): { id: string; ops: Op[] } | null {
  if (node.kind !== "text" || !node.text) return null;
  const def: TextStyleDefLite = { id: uuid(), name, style: effectiveStyle(scene, node) ?? node.text.style };
  return { id: def.id, ops: [makeSetTextStyleDefOp(def), makeSetPropsOp(node.id, { textStyleId: def.id }, ["text_style_id"])] };
}

/** Overwrites the shared style `styleId` with the style `node` is drawn with (so every node using it follows). */
export function updateStyleOps(scene: SceneState, styleId: string, node: NodeLite): Op[] {
  const def = scene.textStyles[styleId];
  if (!def || node.kind !== "text" || !node.text) return [];
  return [makeSetTextStyleDefOp({ ...def, style: effectiveStyle(scene, node) ?? node.text.style })];
}

// ---------- uploaded fonts ----------

/** "Brand Sans-BoldItalic.ttf" -> { family: "Brand Sans", weight: "700", italic: true }: only a first guess for the form. */
export function guessFontFromFilename(filename: string): { family: string; weight: string; italic: boolean } {
  const stem = filename.replace(/\.[^.]+$/, "");
  const [rawFamily, ...rest] = stem.split(/[-_](?=[A-Za-z]+$)/);
  const suffix = rest.join("").toLowerCase();
  // Only a suffix made of style words counts as a style ("Open_Sans" is a family, not "Open" + "Sans").
  const isStyle = suffix !== "" && /^(?:thin|hairline|extralight|ultralight|light|regular|normal|medium|semibold|demibold|extrabold|ultrabold|bold|black|heavy|italic|oblique)+$/.test(suffix);
  const style = isStyle ? suffix : "";
  const weights: [RegExp, string][] = [
    [/thin|hairline/, "100"], [/extralight|ultralight/, "200"], [/light/, "300"], [/medium/, "500"],
    [/semibold|demibold/, "600"], [/extrabold|ultrabold/, "800"], [/black|heavy/, "900"], [/bold/, "700"],
  ];
  const weight = weights.find(([re]) => re.test(style))?.[1] ?? "400";
  const family = (isStyle ? rawFamily : stem).replace(/[^\p{L}\p{N} _.\-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 64);
  return { family: family || "Font", weight, italic: /italic|oblique/.test(style) };
}

/** The setFont op for an uploaded file, or null if the id/hash would be refused. */
export function addFontOp(family: string, weight: string, italic: boolean, assetHash: string): { font: FontLite; op: Op } {
  const font: FontLite = { id: uuid(), family: family.trim(), weight, style: italic ? "italic" : "normal", assetHash };
  return { font, op: makeSetFontOp(font) };
}
