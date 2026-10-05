// THE STYLE CASCADE of an SVG: presentation attributes < rules of a
// <style> < `style=""` attribute (< `!important` of a <style>).
//
// No getComputedStyle: the importer must give the same results in jsdom,
// in the browser and without layout, and an SVG document parsed by DOMParser is
// not even attached to a window. It is computed by hand, and it is little: the
// properties the model can express are about twenty.

export type Props = Map<string, string>;

/** The properties inherited from ancestors (the others apply only to the element). */
export const INHERITED = new Set([
  "fill", "fill-opacity", "fill-rule",
  "stroke", "stroke-width", "stroke-opacity", "stroke-linecap", "stroke-linejoin",
  "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset",
  "color", "visibility",
  "font-family", "font-size", "font-weight", "font-style", "text-anchor", "line-height",
  "letter-spacing", "white-space",
]);

/** The presentation attributes we read (also from `style`). */
export const PRESENTATION = new Set([
  ...INHERITED,
  "opacity", "display", "stop-color", "stop-opacity", "transform",
  "clip-path", "mask", "filter", "mix-blend-mode", "marker-start", "marker-mid", "marker-end",
  "vector-effect",
]);

// Splits "a:b;c:d" respecting parentheses and quotes: a `url(data:image/png;
// base64,...)` or a `font-family:"a;b"` contain `;` that do NOT separate.
export function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let cur = "";
  for (const ch of s) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim() !== "") out.push(cur);
  return out;
}

export interface Decl { name: string; value: string; important: boolean }

export function parseDeclarations(text: string): Decl[] {
  const out: Decl[] = [];
  for (const part of splitTopLevel(text.replace(/\/\*[\s\S]*?\*\//g, ""), ";")) {
    const i = part.indexOf(":");
    if (i < 0) continue;
    const name = part.slice(0, i).trim().toLowerCase();
    let value = part.slice(i + 1).trim();
    let important = false;
    const imp = /\s*!\s*important\s*$/i.exec(value);
    if (imp) { important = true; value = value.slice(0, imp.index).trim(); }
    if (name !== "" && value !== "") out.push({ name, value, important });
  }
  return out;
}

export interface CssRule { selector: string; decls: Decl[]; specificity: number; order: number }

/** Approximate specificity (id*10000 + classes/attributes/pseudo*100 + tag). */
export function specificityOf(selector: string): number {
  const s = selector.replace(/\[[^\]]*\]/g, " [] ").replace(/::?[a-z-]+(\([^)]*\))?/gi, " : ");
  const ids = (s.match(/#[\w-]+/g) ?? []).length;
  const classes = (s.match(/\.[\w-]+/g) ?? []).length + (s.match(/\[\]/g) ?? []).length + (s.match(/ : /g) ?? []).length;
  const tags = (s.replace(/[#.][\w-]+/g, " ").match(/(^|[\s>+~])[a-z][\w-]*/gi) ?? []).length;
  return ids * 10000 + classes * 100 + tags;
}

export interface ParsedCss {
  rules: CssRule[];
  /** at-rules encountered and ignored (@keyframes, @media, @import, ...). */
  atRules: string[];
}

/**
 * The text of a <style> into rules. At-rules (@media, @keyframes,
 * @font-face, @import) are skipped and reported: the importer flags them instead
 * of pretending to have applied them.
 */
export function parseCss(text: string, orderStart = 0): ParsedCss {
  const css = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!\[CDATA\[|\]\]>/g, "");
  const rules: CssRule[] = [];
  const atRules: string[] = [];
  let i = 0;
  let order = orderStart;
  while (i < css.length) {
    const open = css.indexOf("{", i);
    if (open < 0) {
      // an at-rule without a block (@import url(...);)
      const tail = css.slice(i).trim();
      if (tail.startsWith("@")) atRules.push(tail.split(/[\s(]/)[0]);
      break;
    }
    let prelude = css.slice(i, open).trim();
    // Statements without a block before the rule (`@import url(x); .a {...}`):
    // they are reported and do NOT take away the rule that follows.
    const semi = prelude.lastIndexOf(";");
    if (semi >= 0) {
      for (const at of prelude.slice(0, semi).match(/@[\w-]+/g) ?? []) atRules.push(at.toLowerCase());
      prelude = prelude.slice(semi + 1).trim();
    }
    // find the closing brace, with nesting
    let depth = 1;
    let j = open + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") depth--;
      j++;
    }
    const body = css.slice(open + 1, depth === 0 ? j - 1 : j);
    i = j;
    if (prelude.startsWith("@")) {
      // `@import ...;` may precede another rule in the same prelude
      const at = /@[\w-]+/.exec(prelude);
      if (at) atRules.push(at[0].toLowerCase());
      continue;
    }
    const decls = parseDeclarations(body);
    for (const sel of splitTopLevel(prelude, ",")) {
      const selector = sel.trim();
      if (selector === "") continue;
      rules.push({ selector, decls, specificity: specificityOf(selector), order: order++ });
    }
  }
  return { rules, atRules };
}

/**
 * The properties DECLARED on an element, with the right precedence.
 * `ruleDecls` are the declarations of the rules that hit it, already
 * sorted by specificity and order of appearance.
 */
export function declaredProps(
  el: Element,
  ruleDecls: readonly Decl[] | undefined,
): Props {
  const props: Props = new Map();
  // The PRESENT attributes (few) are scanned instead of asking for the ~35 possible
  // names: on a document of thousands of elements the difference is
  // an order of magnitude (especially outside a real browser).
  for (const a of Array.from(el.attributes)) {
    if (!PRESENTATION.has(a.name)) continue;
    const v = a.value.trim();
    if (v !== "") props.set(a.name, v);
  }
  const important: Decl[] = [];
  for (const d of ruleDecls ?? []) {
    if (d.important) important.push(d);
    else props.set(d.name, d.value);
  }
  const style = el.getAttribute("style");
  if (style) {
    for (const d of parseDeclarations(style)) props.set(d.name, d.value);
  }
  for (const d of important) props.set(d.name, d.value);
  return props;
}

/** The final value of an element: declared or inherited from the parent. */
export function computeStyle(own: Props, parent: Props | null): Props {
  const out: Props = new Map();
  if (parent) for (const [k, v] of parent) if (INHERITED.has(k)) out.set(k, v);
  for (const [k, v] of own) {
    if (v === "inherit") {
      const pv = parent?.get(k);
      if (pv !== undefined) out.set(k, pv);
      continue;
    }
    out.set(k, v);
  }
  return out;
}
