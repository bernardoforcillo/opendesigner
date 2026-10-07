import { parseColor } from "../svg/color";
import { uuid } from "../tools/ops";
import type { CollectionLite, FillLite, SceneState, VariableLite } from "../store/types";

// DESIGN TOKENS in and out. The variables of the document leave as
//  - a W3C Design Tokens (DTCG) JSON file -- one top-level group per collection, a nested
//    group for every "/" in a variable's name, `$type` and `$value` for the first mode and the
//    other modes under `$extensions."com.opendesigner".modes` (the format has no modes of its
//    own) -- that Style Dictionary, Tokens Studio and Figma's token plugins read;
//  - CSS custom properties: `:root` carries the first mode of every collection and a
//    `[data-theme="<mode>"]` block overrides what the other modes change.
// A DTCG file comes back in as new collections of variables. Pure: scene in, text out and the
// reverse, never touching the store.

export const EXT = "com.opendesigner";

const channel = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0");

/** #rrggbb, or #rrggbbaa when not opaque. */
export function colorToHex(c: { r: number; g: number; b: number; a: number }): string {
  return `#${channel(c.r)}${channel(c.g)}${channel(c.b)}${c.a >= 1 ? "" : channel(c.a)}`;
}

function valueOf(v: VariableLite, mode: string, fallbackMode: string): FillLite | number | undefined {
  return v.values[mode] ?? v.values[fallbackMode];
}

type Json = { [k: string]: unknown };

function put(root: Json, path: string[], leaf: Json): void {
  let cur = root;
  for (const seg of path.slice(0, -1)) {
    const next = cur[seg];
    cur = (typeof next === "object" && next !== null && !("$value" in next) ? next : (cur[seg] = {})) as Json;
  }
  cur[path[path.length - 1]] = leaf;
}

/** The document's variables as a DTCG token tree. */
export function toDtcg(scene: SceneState): string {
  const root: Json = {};
  const cols = Object.values(scene.collections).sort((a, b) => a.name.localeCompare(b.name));
  for (const col of cols) {
    const group: Json = {};
    const vars = Object.values(scene.variables).filter((v) => v.collectionId === col.id).sort((a, b) => a.name.localeCompare(b.name));
    const first = col.modes[0]?.id ?? "";
    for (const v of vars) {
      const fmt = (x: FillLite | number | undefined) => (typeof x === "number" ? x : x ? colorToHex(x) : undefined);
      const leaf: Json = { $type: v.type === "color" ? "color" : "number", $value: fmt(valueOf(v, first, first)) };
      const extra: Json = {};
      for (const m of col.modes.slice(1)) {
        const x = fmt(v.values[m.id]);
        if (x !== undefined) extra[m.name] = x;
      }
      if (Object.keys(extra).length > 0) leaf.$extensions = { [EXT]: { modes: extra } };
      put(group, v.name.split("/").filter((s) => s !== ""), leaf);
    }
    if (col.modes.length > 0) group.$extensions = { [EXT]: { modes: col.modes.map((m) => m.name) } };
    root[col.name] = group;
  }
  return JSON.stringify(root, null, 2) + "\n";
}

const cssIdent = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";

/** The document's variables as CSS custom properties. */
export function toCssVariables(scene: SceneState): string {
  const rootLines: string[] = [];
  const blocks: string[] = [];
  const cols = Object.values(scene.collections).sort((a, b) => a.name.localeCompare(b.name));
  for (const col of cols) {
    const vars = Object.values(scene.variables).filter((v) => v.collectionId === col.id).sort((a, b) => a.name.localeCompare(b.name));
    const first = col.modes[0]?.id ?? "";
    const name = (v: VariableLite) => `--${v.name.split("/").map(cssIdent).join("-")}`;
    const css = (x: FillLite | number | undefined) => (typeof x === "number" ? String(x) : x ? colorToHex(x) : undefined);
    for (const v of vars) {
      const x = css(valueOf(v, first, first));
      if (x !== undefined) rootLines.push(`  ${name(v)}: ${x};`);
    }
    for (const m of col.modes.slice(1)) {
      const lines = vars.flatMap((v) => {
        const x = css(v.values[m.id]);
        const base = css(valueOf(v, first, first));
        return x !== undefined && x !== base ? [`  ${name(v)}: ${x};`] : [];
      });
      if (lines.length > 0) blocks.push(`[data-theme="${cssIdent(m.name)}"] {\n${lines.join("\n")}\n}`);
    }
  }
  const head = rootLines.length > 0 ? `:root {\n${rootLines.join("\n")}\n}` : "";
  return [head, ...blocks].filter((s) => s !== "").join("\n\n") + (head || blocks.length ? "\n" : "");
}

// ---------- import ----------

export interface ImportedTokens {
  collections: CollectionLite[];
  variables: VariableLite[];
  /** Tokens that could not be read: their path and why. */
  skipped: string[];
}

function parseValue(type: string | undefined, raw: unknown): FillLite | number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return type === "color" ? null : raw;
  if (typeof raw !== "string") return null;
  if (type === "color" || (type === undefined && /^(#|rgb|hsl)/i.test(raw.trim()))) {
    const c = parseColor(raw.trim());
    return c ? { r: c.r, g: c.g, b: c.b, a: c.a } : null;
  }
  // "12px" / "0.5rem" / "8": a number token keeps its number.
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*(px|rem|em|%)?\s*$/.exec(raw);
  return m ? Number(m[1]) : null;
}

/**
 * Reads a DTCG JSON text into collections and variables. Every top-level group becomes a
 * collection; a group's `$type` is inherited by its tokens; modes come from the
 * `com.opendesigner` extension this file format was exported with (a file from elsewhere has a
 * single mode "Default"). Throws on text that is not a JSON object.
 */
export function fromDtcg(text: string, scene: SceneState): ImportedTokens {
  const json: unknown = JSON.parse(text);
  if (typeof json !== "object" || json === null || Array.isArray(json)) throw new Error("not a design tokens file");
  const out: ImportedTokens = { collections: [], variables: [], skipped: [] };
  const taken = new Set(Object.values(scene.collections).map((c) => c.name));
  for (const [groupName, group] of Object.entries(json as Json)) {
    if (groupName.startsWith("$") || typeof group !== "object" || group === null) continue;
    const ext = ((group as Json).$extensions as Json | undefined)?.[EXT] as Json | undefined;
    const modeNames = Array.isArray(ext?.modes) ? (ext!.modes as unknown[]).filter((m): m is string => typeof m === "string" && m !== "") : [];
    const modes = (modeNames.length > 0 ? modeNames : ["Default"]).map((name) => ({ id: uuid(), name }));
    let name = groupName;
    for (let n = 2; taken.has(name); n++) name = `${groupName} ${n}`;
    taken.add(name);
    const col: CollectionLite = { id: uuid(), name, modes };
    const before = out.variables.length;
    const walk = (node: Json, path: string[], inherited: string | undefined) => {
      const type = typeof node.$type === "string" ? node.$type : inherited;
      if ("$value" in node) {
        const label = path.join("/");
        if (type !== "color" && type !== "number" && type !== "dimension" && type !== undefined) { out.skipped.push(`${groupName}/${label}: type ${type}`); return; }
        const first = parseValue(type === "dimension" ? "number" : type, node.$value);
        if (first === null) { out.skipped.push(`${groupName}/${label}: unreadable value`); return; }
        const isColor = typeof first !== "number";
        const values: VariableLite["values"] = { [modes[0].id]: first };
        const extra = ((node.$extensions as Json | undefined)?.[EXT] as Json | undefined)?.modes as Json | undefined;
        for (const m of modes.slice(1)) {
          const v = parseValue(isColor ? "color" : "number", extra?.[m.name]);
          values[m.id] = v !== null && (typeof v !== "number") === isColor ? v : first;
        }
        out.variables.push({ id: uuid(), collectionId: col.id, name: label, type: isColor ? "color" : "number", values });
        return;
      }
      for (const [k, child] of Object.entries(node)) {
        if (k.startsWith("$") || typeof child !== "object" || child === null || Array.isArray(child)) continue;
        walk(child as Json, [...path, k], type);
      }
    };
    walk(group as Json, [], undefined);
    if (out.variables.length > before) out.collections.push(col);
  }
  return out;
}
