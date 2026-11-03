// AN InDESIGN-STYLE GREP DIALECT for find/change over text. The dialect is translated into a
// JavaScript regular expression (Unicode mode, `m` flag so ^ and $ are paragraph start and end);
// everything JavaScript already spells the same way (groups, alternation, quantifiers, lookahead,
// lookbehind, lazy `?`) passes through. What is translated is documented in docs/object-tools.md.
//
//   ~m ~> ~< ~s    em space, en space, thin space, no-break space
//   ~_ ~= ~. ~-    em dash, en dash, ellipsis, discretionary hyphen    ~~ a literal tilde
//   \r \n          the paragraph break (the model keeps one kind of break, "\n")
//   \t \h          tab; horizontal white space
//   \u \l \d \w \s uppercase letter, lowercase letter, digit, word character (Unicode), white space
//   \< \>          start / end of a word
//   \x{HHHH}       a character by code point
//   [[:alpha:]] [[:digit:]] [[:alnum:]] [[:upper:]] [[:lower:]] [[:punct:]] [[:space:]] [[:blank:]]
//   (?i) (?-i)     at the very start: ignore / respect case
//
// In the replacement: $0 (the whole match), $1..$9, \$ for a dollar, the same ~ and \ characters.

const TILDE: Record<string, string> = {
  m: " ", ">": " ", "<": " ", s: " ", _: "—", "=": "–", ".": "…", "-": "­", "~": "~",
};

const POSIX: Record<string, string> = {
  alpha: "\\p{L}", digit: "\\p{Nd}", alnum: "\\p{L}\\p{N}", upper: "\\p{Lu}", lower: "\\p{Ll}", punct: "\\p{P}", space: "\\s", blank: " \\t",
};

const H_SPACE = " \\t\\u00a0\\u2000-\\u200a\\u202f\\u3000";
const SYNTAX = "^$\\.*+?()[]{}|/";

export interface GrepResult { source: string; ignoreCase?: boolean }

const lit = (ch: string) => (SYNTAX.includes(ch) ? "\\" + ch : ch);

/** Translates a GREP pattern. Throws an Error with a readable message on what the dialect does not support. */
export function translateGrep(pattern: string): GrepResult {
  let i = 0;
  let ignoreCase: boolean | undefined;
  const lead = /^\(\?(-?)i\)/.exec(pattern);
  if (lead) { ignoreCase = lead[1] === ""; i = lead[0].length; }
  let out = "";
  let inClass = false;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "\\") {
      const d = pattern[i + 1];
      if (d === undefined) throw new Error("A pattern cannot end with a backslash");
      i += 2;
      switch (d) {
        case "r": case "n": out += "\\n"; break;
        case "t": out += "\\t"; break;
        case "d": out += "\\d"; break;
        case "s": out += "\\s"; break;
        case "w": out += inClass ? "\\p{L}\\p{N}_" : "[\\p{L}\\p{N}_]"; break;
        case "u": out += "\\p{Lu}"; break;
        case "l": out += "\\p{Ll}"; break;
        case "h": out += inClass ? H_SPACE : `[${H_SPACE}]`; break;
        case "<": if (inClass) throw new Error("\\< is not allowed in a set"); out += "\\b(?=[\\p{L}\\p{N}_])"; break;
        case ">": if (inClass) throw new Error("\\> is not allowed in a set"); out += "\\b(?<=[\\p{L}\\p{N}_])"; break;
        case "x": {
          const m = /^\{([0-9a-fA-F]{1,6})\}/.exec(pattern.slice(i));
          if (!m) throw new Error("\\x needs a code point: \\x{00A0}");
          if (parseInt(m[1], 16) > 0x10ffff) throw new Error("Code point out of range");
          out += `\\u{${m[1]}}`;
          i += m[0].length;
          break;
        }
        case "b": case "B": case "D": case "S": case "W":
          if (inClass && d !== "D" && d !== "S") throw new Error(`\\${d} is not allowed in a set`);
          out += "\\" + d;
          break;
        case "~": out += "~"; break;
        default:
          if (d === "-") out += inClass ? "\\-" : "-";
          else if (SYNTAX.includes(d)) out += "\\" + d;
          else if (/[1-9]/.test(d)) out += "\\" + d; // a backreference
          else throw new Error(`Unsupported escape \\${d}`);
      }
      continue;
    }
    if (c === "~") {
      const d = pattern[i + 1];
      const rep = d === undefined ? undefined : TILDE[d];
      if (rep === undefined) throw new Error(`Unknown special character ~${d ?? ""}`);
      out += lit(rep);
      i += 2;
      continue;
    }
    if (c === "[") {
      if (inClass && pattern[i + 1] === ":") {
        const m = /^\[:(\^?)([a-z]+):\]/.exec(pattern.slice(i));
        if (!m) throw new Error("Unterminated [: :] class");
        if (m[1]) throw new Error("Negated [:^name:] classes are not supported");
        const set = POSIX[m[2]];
        if (!set) throw new Error(`Unknown class [:${m[2]}:]`);
        out += set;
        i += m[0].length;
        continue;
      }
      if (inClass) { out += "\\["; i++; continue; }
      inClass = true;
      out += c;
      i++;
      continue;
    }
    if (c === "]" && inClass) { inClass = false; out += c; i++; continue; }
    // `a++`, `a*+`, `a?+`: possessive quantifiers exist in InDesign but not in JavaScript's engine.
    if (c === "+" && !inClass && "+*?}".includes(pattern[i - 1] ?? "x") && pattern[i - 2] !== "\\") throw new Error("Possessive quantifiers are not supported");
    if (c === "(" && pattern[i + 1] === "?" && !inClass) {
      const rest = pattern.slice(i + 2);
      if (!/^(:|=|!|<=|<!|<[A-Za-z_])/.test(rest)) throw new Error("Unsupported group syntax (?" + rest.slice(0, 2) + ")");
    }
    out += c;
    i++;
  }
  if (inClass) throw new Error("Unterminated [ set");
  return { source: out, ignoreCase };
}

/** Translates a GREP replacement string into the string `expandReplacement` expands. */
export function translateReplacement(rep: string): string {
  let out = "";
  for (let i = 0; i < rep.length; i++) {
    const c = rep[i];
    if (c === "\\") {
      const d = rep[i + 1];
      i++;
      if (d === "$") out += "$$";
      else if (d === "r" || d === "n") out += "\n";
      else if (d === "t") out += "\t";
      else if (d === "\\") out += "\\";
      else if (d === "~") out += "~";
      else if (d === "x") {
        const m = /^\{([0-9a-fA-F]{1,6})\}/.exec(rep.slice(i + 1));
        if (!m) throw new Error("\\x needs a code point: \\x{00A0}");
        out += String.fromCodePoint(Math.min(0x10ffff, parseInt(m[1], 16)));
        i += m[0].length;
      } else out += (d ?? "\\");
    } else if (c === "~" && rep[i + 1] !== undefined && TILDE[rep[i + 1]] !== undefined) {
      out += TILDE[rep[i + 1]];
      i++;
    } else out += c;
  }
  return out;
}

/** `$0`, `$1`..`$9` and `$$` of a translated replacement, from the match and its groups. */
export function expandReplacement(rep: string, match: string, groups: readonly (string | undefined)[]): string {
  return rep.replace(/\$([0-9$])/g, (_, k: string) => (k === "$" ? "$" : k === "0" ? match : groups[Number(k) - 1] ?? ""));
}
