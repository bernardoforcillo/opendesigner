// LA CASCATA DEGLI STILI di un SVG: attributi di presentazione < regole di un
// <style> < attributo `style=""` (< `!important` di un <style>).
//
// Niente getComputedStyle: l'importer deve dare gli stessi risultati in jsdom,
// nel browser e senza layout, e un documento SVG parsato da DOMParser non è
// nemmeno agganciato a una finestra. Si calcola a mano, ed è poco: le
// proprietà che il modello sa esprimere sono una ventina.

export type Props = Map<string, string>;

/** Le proprietà che si ereditano dagli antenati (le altre valgono solo sull'elemento). */
export const INHERITED = new Set([
  "fill", "fill-opacity", "fill-rule",
  "stroke", "stroke-width", "stroke-opacity", "stroke-linecap", "stroke-linejoin",
  "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset",
  "color", "visibility",
  "font-family", "font-size", "font-weight", "font-style", "text-anchor", "line-height",
  "letter-spacing", "white-space",
]);

/** Gli attributi di presentazione che leggiamo (anche da `style`). */
export const PRESENTATION = new Set([
  ...INHERITED,
  "opacity", "display", "stop-color", "stop-opacity", "transform",
  "clip-path", "mask", "filter", "mix-blend-mode", "marker-start", "marker-mid", "marker-end",
  "vector-effect",
]);

// Divide "a:b;c:d" rispettando parentesi e virgolette: un `url(data:image/png;
// base64,...)` o un `font-family:"a;b"` contengono `;` che NON separano.
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

/** Specificità approssimata (id*10000 + classi/attributi/pseudo*100 + tag). */
export function specificityOf(selector: string): number {
  const s = selector.replace(/\[[^\]]*\]/g, " [] ").replace(/::?[a-z-]+(\([^)]*\))?/gi, " : ");
  const ids = (s.match(/#[\w-]+/g) ?? []).length;
  const classes = (s.match(/\.[\w-]+/g) ?? []).length + (s.match(/\[\]/g) ?? []).length + (s.match(/ : /g) ?? []).length;
  const tags = (s.replace(/[#.][\w-]+/g, " ").match(/(^|[\s>+~])[a-z][\w-]*/gi) ?? []).length;
  return ids * 10000 + classes * 100 + tags;
}

export interface ParsedCss {
  rules: CssRule[];
  /** at-rule incontrate e ignorate (@keyframes, @media, @import, ...). */
  atRules: string[];
}

/**
 * Il testo di un <style> in regole. Gli at-rule (@media, @keyframes,
 * @font-face, @import) si saltano e si riportano: l'importer li segnala invece
 * di far finta di averli applicati.
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
      // un at-rule senza blocco (@import url(...);)
      const tail = css.slice(i).trim();
      if (tail.startsWith("@")) atRules.push(tail.split(/[\s(]/)[0]);
      break;
    }
    let prelude = css.slice(i, open).trim();
    // Istruzioni senza blocco davanti alla regola (`@import url(x); .a {...}`):
    // si riportano e NON si portano via la regola che segue.
    const semi = prelude.lastIndexOf(";");
    if (semi >= 0) {
      for (const at of prelude.slice(0, semi).match(/@[\w-]+/g) ?? []) atRules.push(at.toLowerCase());
      prelude = prelude.slice(semi + 1).trim();
    }
    // trova la graffa che chiude, con annidamento
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
      // `@import ...;` può precedere un'altra regola nello stesso prelude
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
 * Le proprietà DICHIARATE su un elemento, con la precedenza giusta.
 * `ruleDecls` sono le dichiarazioni delle regole che lo colpiscono, già
 * ordinate per specificità e ordine di apparizione.
 */
export function declaredProps(
  el: Element,
  ruleDecls: readonly Decl[] | undefined,
): Props {
  const props: Props = new Map();
  // Si scorrono gli attributi PRESENTI (pochi) invece di chiedere i ~35 nomi
  // possibili: su un documento da migliaia di elementi la differenza è di
  // un ordine di grandezza (soprattutto fuori da un browser vero).
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

/** Il valore finale di un elemento: dichiarato oppure ereditato dal genitore. */
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
