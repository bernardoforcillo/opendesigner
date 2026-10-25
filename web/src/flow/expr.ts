import type { Vars } from "./prototype";

// EXPRESSIONS of the playable prototype: what a transition's guard and effect can say beyond
// `k=v`. Variables are strings at rest (Vars); an expression computes with numbers, text and
// booleans and gives a string back.
//
//   count + 1          arithmetic: + - * / %  (+ joins text when an operand is not a number)
//   count >= 3         comparison: == != = < <= > >=
//   a > 1 && !b || c   logic: && || !  (|| binds loosest, then &&, then comparison)
//   "Hi " + name       text in single or double quotes
//   (a + b) * 2        parentheses
//
// A variable that was never set reads as "" -- which is 0 in arithmetic and false in a condition.
// An expression that cannot be computed (a word where a number is needed, division by zero, a
// stray token) throws ExprError: the guard is then "cannot be evaluated" and the assignment is
// skipped, never guessed. Pure: no DOM, no state.

export class ExprError extends Error {}

/** "truthy": set and different from "", "false", "0". */
export function truthy(v: string | undefined): boolean {
  if (v === undefined) return false;
  const t = v.trim().toLowerCase();
  return t !== "" && t !== "false" && t !== "0";
}

type V = string | number | boolean;

type Tok =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "id"; v: string }
  | { t: "op"; v: string };

const OPS = ["==", "!=", "<=", ">=", "&&", "||", "=", "<", ">", "+", "-", "*", "/", "%", "(", ")", "!"];

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    const num = /^\d+(?:\.\d+)?/.exec(src.slice(i));
    if (num) { out.push({ t: "num", v: Number(num[0]) }); i += num[0].length; continue; }
    if (c === '"' || c === "'") {
      const end = src.indexOf(c, i + 1);
      if (end < 0) throw new ExprError("unterminated text");
      out.push({ t: "str", v: src.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    const id = /^[A-Za-z_][\w.]*/.exec(src.slice(i));
    if (id) { out.push({ t: "id", v: id[0] }); i += id[0].length; continue; }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new ExprError(`unexpected "${c}"`);
    out.push({ t: "op", v: op });
    i += op.length;
  }
  return out;
}

/** A string that reads as a number ("12", "-3.5"); "" and words do not. */
function numeric(s: string): number | null {
  const t = s.trim();
  return /^-?\d+(?:\.\d+)?$/.test(t) ? Number(t) : null;
}

function asNum(v: V): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v.trim() === "") return 0; // an unset variable counts as 0 in arithmetic
  const n = numeric(v);
  if (n === null) throw new ExprError(`"${v}" is not a number`);
  return n;
}

/** The number a value is for == and the comparisons, or null when it is text. */
function asComparable(v: V): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return null;
  return numeric(v);
}

export function show(v: V): string {
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (!Number.isFinite(v)) throw new ExprError("not a finite number");
  // 0.1 + 0.2 must read 0.3: 12 significant digits, no trailing zeros.
  return String(Number(v.toPrecision(12)));
}

function isTrue(v: V): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  return truthy(v);
}

class Parser {
  private pos = 0;
  constructor(private readonly toks: Tok[], private readonly vars: Vars) {}

  private peek(): Tok | undefined { return this.toks[this.pos]; }
  private isOp(...ops: string[]): string | null {
    const t = this.peek();
    return t && t.t === "op" && ops.includes(t.v) ? t.v : null;
  }
  private take(): Tok { return this.toks[this.pos++]; }

  parse(): V {
    if (this.toks.length === 0) throw new ExprError("empty expression");
    const v = this.or();
    if (this.pos < this.toks.length) throw new ExprError("unexpected token");
    return v;
  }

  private or(): V {
    let l = this.and();
    while (this.isOp("||")) { this.take(); const r = this.and(); l = isTrue(l) || isTrue(r); }
    return l;
  }
  private and(): V {
    let l = this.not();
    while (this.isOp("&&")) { this.take(); const r = this.not(); l = isTrue(l) && isTrue(r); }
    return l;
  }
  private not(): V {
    if (this.isOp("!")) { this.take(); return !isTrue(this.not()); }
    return this.cmp();
  }
  private cmp(): V {
    const l = this.add();
    const op = this.isOp("==", "=", "!=", "<=", ">=", "<", ">");
    if (!op) return l;
    this.take();
    const r = this.add();
    const a = asComparable(l), b = asComparable(r);
    if (op === "==" || op === "=" || op === "!=") {
      const eq = a !== null && b !== null ? a === b : show(l) === show(r);
      return op === "!=" ? !eq : eq;
    }
    if (a !== null && b !== null) {
      return op === "<" ? a < b : op === "<=" ? a <= b : op === ">" ? a > b : a >= b;
    }
    // Two words compare as text; anything else must be a number ("" is an unset variable: 0).
    if (typeof l === "string" && typeof r === "string" && l !== "" && r !== "" && numeric(l) === null && numeric(r) === null) {
      return op === "<" ? l < r : op === "<=" ? l <= r : op === ">" ? l > r : l >= r;
    }
    const x = asNum(l), y = asNum(r);
    return op === "<" ? x < y : op === "<=" ? x <= y : op === ">" ? x > y : x >= y;
  }
  private add(): V {
    let l = this.mul();
    for (let op = this.isOp("+", "-"); op; op = this.isOp("+", "-")) {
      this.take();
      const r = this.mul();
      if (op === "+") {
        // Text when either side is a word, a sum otherwise.
        const textual = (v: V) => typeof v === "string" && v.trim() !== "" && numeric(v) === null;
        l = textual(l) || textual(r) ? show(l) + show(r) : asNum(l) + asNum(r);
      } else {
        l = asNum(l) - asNum(r);
      }
    }
    return l;
  }
  private mul(): V {
    let l = this.unary();
    for (let op = this.isOp("*", "/", "%"); op; op = this.isOp("*", "/", "%")) {
      this.take();
      const r = asNum(this.unary());
      const x = asNum(l);
      if ((op === "/" || op === "%") && r === 0) throw new ExprError("division by zero");
      l = op === "*" ? x * r : op === "/" ? x / r : x % r;
    }
    return l;
  }
  private unary(): V {
    if (this.isOp("-")) { this.take(); return -asNum(this.unary()); }
    return this.primary();
  }
  private primary(): V {
    const t = this.take();
    if (!t) throw new ExprError("unexpected end");
    if (t.t === "num") return t.v;
    if (t.t === "str") return t.v;
    if (t.t === "id") {
      // true / false are words of the language unless the prototype set a variable of that name.
      if ((t.v === "true" || t.v === "false") && this.vars[t.v] === undefined) return t.v === "true";
      return this.vars[t.v] ?? "";
    }
    if (t.v === "(") {
      const v = this.or();
      if (!this.isOp(")")) throw new ExprError('missing ")"');
      this.take();
      return v;
    }
    throw new ExprError(`unexpected "${t.v}"`);
  }
}

/** Computes `src` against the variables and gives the result as the string a variable would hold. */
export function evalExpr(src: string, vars: Vars): string {
  return show(new Parser(tokenize(src), vars).parse());
}

/** Computes `src` as a condition. */
export function evalCondition(src: string, vars: Vars): boolean {
  const toks = tokenize(src);
  return isTrue(new Parser(toks, vars).parse());
}
