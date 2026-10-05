// A HAND-WRITTEN HIGHLIGHTER for the generated code. It is not a parser: it is a
// one-pass scanner that knows how to recognize what is needed to READ the code that
// opendesigner produces (TSX, HTML with <style>, CSS, JSON, Markdown) -- keywords,
// strings, comments, tags and attributes, numbers. A few KB in place of
// Prism/Shiki (tens of KB plus the grammars) and no dependency.
//
// The invariant, proven by the tests: concatenating the tokens gives back EXACTLY the
// source. A wrong recognition colors badly, never loses or alters text.

export type TokenKind = "plain" | "kw" | "str" | "com" | "tag" | "attr" | "num" | "fn" | "type";
export interface Token {
  k: TokenKind;
  s: string;
}
export type Lang = "tsx" | "html" | "css" | "json" | "md" | "text";

const EXT: Record<string, Lang> = {
  ts: "tsx", tsx: "tsx", js: "tsx", jsx: "tsx", mjs: "tsx", cjs: "tsx",
  html: "html", htm: "html", css: "css", json: "json", md: "md",
};

export function langOf(path: string): Lang {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  return (m && EXT[m[1].toLowerCase()]) || "text";
}

const JS_KEYWORDS = new Set((
  "import export from default const let var function return if else for while do switch case break continue new " +
  "class extends interface type as of in typeof instanceof void async await try catch finally throw " +
  "true false null undefined this satisfies readonly enum declare"
).split(" "));

const isIdStart = (c: string) => /[A-Za-z_$]/.test(c);
const isIdPart = (c: string) => /[A-Za-z0-9_$-]/.test(c);

// Accumulates the tokens merging contiguous ones of the same type.
class Out {
  toks: Token[] = [];
  push(k: TokenKind, s: string) {
    if (s === "") return;
    const last = this.toks[this.toks.length - 1];
    if (last && last.k === k) last.s += s;
    else this.toks.push({ k, s });
  }
}

/** The first index >= i that is not space/newline (or s.length). */
function skipWs(s: string, i: number): number {
  while (i < s.length && /\s/.test(s[i])) i++;
  return i;
}

/** End of a string starting at `i` (the quote), with escapes; not beyond the newline for ' and ". */
function stringEnd(s: string, i: number): number {
  const q = s[i];
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === "\\") j += 2;
    else if (c === q) return j + 1;
    else if (c === "\n" && q !== "`") return j; // unclosed string: stop at end of line
    else j++;
  }
  return s.length;
}

// --- TSX / JS ----------------------------------------------------------------

function scanTsx(s: string, out: Out): void {
  let i = 0;
  let prev = ""; // last significant character (non-space), to tell `<Tag` from `a < b`
  let tagDepth = -1; // >= 0 inside a JSX tag: the brace level at which it was opened
  let braces = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "/" && s[i + 1] === "/") {
      const e = s.indexOf("\n", i);
      const j = e < 0 ? s.length : e;
      out.push("com", s.slice(i, j));
      i = j;
    } else if (c === "/" && s[i + 1] === "*") {
      const e = s.indexOf("*/", i + 2);
      const j = e < 0 ? s.length : e + 2;
      out.push("com", s.slice(i, j));
      i = j;
    } else if (c === '"' || c === "'" || c === "`") {
      const j = stringEnd(s, i);
      out.push("str", s.slice(i, j));
      i = j;
      prev = c;
    } else if (c === "<" && /[A-Za-z/>]/.test(s[i + 1] ?? "") && !/[A-Za-z0-9_$)\]]/.test(prev)) {
      // Opening or closing of a JSX tag (or fragment `<>`).
      let j = i + 1;
      if (s[j] === "/") j++;
      out.push("plain", s.slice(i, j));
      let k = j;
      while (k < s.length && /[A-Za-z0-9_.:-]/.test(s[k])) k++;
      out.push("tag", s.slice(j, k));
      i = k;
      tagDepth = braces;
      prev = "<";
    } else if (tagDepth >= 0 && braces === tagDepth && (c === ">" || (c === "/" && s[i + 1] === ">"))) {
      const n = c === ">" ? 1 : 2;
      out.push("plain", s.slice(i, i + n));
      i += n;
      tagDepth = -1;
      prev = ">";
    } else if (isIdStart(c)) {
      let j = i + 1;
      while (j < s.length && (isIdPart(s[j]) && (tagDepth >= 0 && braces === tagDepth ? true : s[j] !== "-"))) j++;
      const word = s.slice(i, j);
      const after = skipWs(s, j);
      if (tagDepth >= 0 && braces === tagDepth) out.push("attr", word);
      else if (JS_KEYWORDS.has(word)) out.push("kw", word);
      else if (s[after] === "(") out.push("fn", word);
      else if (/^[A-Z]/.test(word)) out.push("type", word);
      else out.push("plain", word);
      i = j;
      prev = word[word.length - 1];
    } else if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < s.length && /[0-9._a-zA-Z]/.test(s[j])) j++;
      out.push("num", s.slice(i, j));
      i = j;
      prev = "0";
    } else {
      if (c === "{") braces++;
      else if (c === "}") braces = Math.max(0, braces - 1);
      out.push("plain", c);
      if (!/\s/.test(c)) prev = c;
      i++;
    }
  }
}

// --- CSS ---------------------------------------------------------------------

function scanCss(s: string, out: Out): void {
  let i = 0;
  let depth = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "/" && s[i + 1] === "*") {
      const e = s.indexOf("*/", i + 2);
      const j = e < 0 ? s.length : e + 2;
      out.push("com", s.slice(i, j));
      i = j;
    } else if (c === '"' || c === "'") {
      const j = stringEnd(s, i);
      out.push("str", s.slice(i, j));
      i = j;
    } else if (c === "{") {
      depth++;
      out.push("plain", c);
      i++;
    } else if (c === "}") {
      depth = Math.max(0, depth - 1);
      out.push("plain", c);
      i++;
    } else if (c === "@") {
      let j = i + 1;
      while (j < s.length && /[A-Za-z-]/.test(s[j])) j++;
      out.push("kw", s.slice(i, j));
      i = j;
    } else if (c === "#" && /[0-9a-fA-F]/.test(s[i + 1] ?? "") && depth > 0) {
      let j = i + 1;
      while (j < s.length && /[0-9a-fA-F]/.test(s[j])) j++;
      out.push("num", s.slice(i, j));
      i = j;
    } else if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(s[i + 1] ?? "") && depth > 0)) {
      let j = i + 1;
      while (j < s.length && /[0-9.%a-zA-Z]/.test(s[j])) j++;
      out.push("num", s.slice(i, j));
      i = j;
    } else if (isIdStart(c) || c === "-" || c === "." || c === "#" || c === ":" || c === "*") {
      // Outside braces it is a selector; inside, `name:` is a property and the rest a value.
      let j = i + 1;
      while (j < s.length && /[A-Za-z0-9_-]/.test(s[j])) j++;
      const word = s.slice(i, j);
      if (depth === 0) out.push("tag", word);
      else if (s[skipWs(s, j)] === ":" && /^[A-Za-z-]/.test(word)) out.push("attr", word);
      else if (s[j] === "(") out.push("fn", word);
      else out.push("plain", word);
      i = j;
    } else {
      out.push("plain", c);
      i++;
    }
  }
}

// --- HTML --------------------------------------------------------------------

function scanHtml(s: string, out: Out): void {
  let i = 0;
  while (i < s.length) {
    if (s.startsWith("<!--", i)) {
      const e = s.indexOf("-->", i + 4);
      const j = e < 0 ? s.length : e + 3;
      out.push("com", s.slice(i, j));
      i = j;
    } else if (s[i] === "<" && (s[i + 1] === "!" || s[i + 1] === "?")) {
      const e = s.indexOf(">", i);
      const j = e < 0 ? s.length : e + 1;
      out.push("kw", s.slice(i, j));
      i = j;
    } else if (s[i] === "<" && /[A-Za-z/]/.test(s[i + 1] ?? "")) {
      let j = i + 1;
      if (s[j] === "/") j++;
      out.push("plain", s.slice(i, j));
      let k = j;
      while (k < s.length && /[A-Za-z0-9:-]/.test(s[k])) k++;
      const name = s.slice(j, k);
      out.push("tag", name);
      // attributi fino a ">"
      while (k < s.length && s[k] !== ">") {
        const c = s[k];
        if (c === '"' || c === "'") {
          const e = stringEnd(s, k);
          out.push("str", s.slice(k, e));
          k = e;
        } else if (/[A-Za-z_:@]/.test(c)) {
          let e = k + 1;
          while (e < s.length && /[A-Za-z0-9_:.@-]/.test(s[e])) e++;
          out.push("attr", s.slice(k, e));
          k = e;
        } else {
          out.push("plain", c);
          k++;
        }
      }
      if (k < s.length) out.push("plain", ">");
      i = Math.min(s.length, k + 1);
      // The content of <style> is CSS (and of <script> is JS): until the closing.
      const lower = name.toLowerCase();
      if (s[j - 1] !== "/" && (lower === "style" || lower === "script")) {
        const close = s.toLowerCase().indexOf(`</${lower}`, i);
        const e = close < 0 ? s.length : close;
        (lower === "style" ? scanCss : scanTsx)(s.slice(i, e), out);
        i = e;
      }
    } else {
      const e = s.indexOf("<", i + 1);
      const j = e < 0 ? s.length : e;
      out.push("plain", s.slice(i, j));
      i = j;
    }
  }
}

// --- JSON / Markdown ---------------------------------------------------------

function scanJson(s: string, out: Out): void {
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"') {
      const j = stringEnd(s, i);
      out.push(s[skipWs(s, j)] === ":" ? "attr" : "str", s.slice(i, j));
      i = j;
    } else if (/[-0-9]/.test(c)) {
      let j = i + 1;
      while (j < s.length && /[0-9.eE+-]/.test(s[j])) j++;
      out.push("num", s.slice(i, j));
      i = j;
    } else if (/[a-z]/.test(c)) {
      let j = i + 1;
      while (j < s.length && /[a-z]/.test(s[j])) j++;
      out.push("kw", s.slice(i, j));
      i = j;
    } else {
      out.push("plain", c);
      i++;
    }
  }
}

function scanMd(s: string, out: Out): void {
  for (const line of s.split(/(?<=\n)/)) {
    if (/^#{1,6}\s/.test(line)) out.push("kw", line);
    else if (/^\s*```/.test(line)) out.push("com", line);
    else {
      // `codice` in linea
      let i = 0;
      while (i < line.length) {
        const a = line.indexOf("`", i);
        const b = a < 0 ? -1 : line.indexOf("`", a + 1);
        if (a < 0 || b < 0) {
          out.push("plain", line.slice(i));
          break;
        }
        out.push("plain", line.slice(i, a));
        out.push("str", line.slice(a, b + 1));
        i = b + 1;
      }
    }
  }
}

/** Tokenizes `code`: a list of lines, each a list of tokens. */
export function highlight(code: string, lang: Lang): Token[][] {
  const out = new Out();
  switch (lang) {
    case "tsx": scanTsx(code, out); break;
    case "html": scanHtml(code, out); break;
    case "css": scanCss(code, out); break;
    case "json": scanJson(code, out); break;
    case "md": scanMd(code, out); break;
    default: out.push("plain", code);
  }
  // Split on newlines (multi-line comments/strings span several lines).
  const lines: Token[][] = [[]];
  for (const t of out.toks) {
    const parts = t.s.split("\n");
    parts.forEach((p, idx) => {
      if (idx > 0) lines.push([]);
      if (p !== "") lines[lines.length - 1].push({ k: t.k, s: p });
    });
  }
  return lines;
}
