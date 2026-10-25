import type { FlowLite, SceneState, TransitionLite } from "../store/types";
import { topLevelScreens } from "./screens";
import { evalCondition, evalExpr, truthy } from "./expr";

export { truthy };

// THE LOGIC OF THE PLAYABLE PROTOTYPE. Pure: scene + state in, new
// state out; no DOM. The full-screen overlay (ui/PrototypePlayer.tsx)
// uses it to decide what is clickable and where it leads.
//
// The state is { screenId, vars, history }. The VARIABLES are strings: they are written by the
// transitions' `effect` ("cart=full; count=count+1") and read by the `guard` ("user=guest",
// "count >= 3 && !paid", "else"). Beyond the plain `k=v` forms, guards and effects take
// expressions (flow/expr.ts); the plain forms keep their old meaning.

export type Vars = Readonly<Record<string, string>>;

export interface ProtoStep { screenId: string; vars: Vars; via: string }

export interface ProtoState {
  screenId: string;
  vars: Vars;
  /** The PREVIOUS states (the oldest first): "back" returns to them. */
  history: readonly ProtoStep[];
}

// --- EFFETTO ---------------------------------------------------------------

/** A variable name: letters, digits, `_`, `.`, `-` and not starting with a digit. No spaces: "cart not empty" is free text. */
const IDENT = /^[A-Za-z_][\w.-]*$/;

/** Splits on any of `seps` outside quotes and parentheses. */
function splitTop(src: string, seps: readonly string[]): string[] {
  const out: string[] = [];
  let depth = 0, quote = "", start = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === quote) quote = ""; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      const sep = seps.find((x) => src.startsWith(x, i));
      if (sep) { out.push(src.slice(start, i)); i += sep.length - 1; start = i + 1; }
    }
  }
  out.push(src.slice(start));
  return out;
}

/** The right side of an assignment or comparison when it is plain text: a bare word, a number or a quoted string. */
function isLiteral(rhs: string): boolean {
  return /^[\w.-]*$/.test(rhs) || (rhs.length >= 2 && (rhs[0] === '"' || rhs[0] === "'") && rhs.indexOf(rhs[0], 1) === rhs.length - 1);
}

export interface Assignment {
  key: string;
  /** The right side as written. */
  rhs: string;
  /** Plain text (`full`, `3`, `'x y'`) rather than an expression (`count + 1`). */
  literal: boolean;
}

/** "cart=full; count = count + 1" -> two assignments. Separators `;` or `,` (outside quotes and parentheses). */
export function parseAssignments(effect: string): Assignment[] {
  const out: Assignment[] = [];
  for (const part of splitTop(effect, [";", ","])) {
    const p = part.trim();
    if (p === "") continue;
    const eq = p.indexOf("=");
    // Without `=` it is not a readable assignment: it is ignored (it is free text).
    if (eq <= 0) continue;
    const key = p.slice(0, eq).trim();
    if (!IDENT.test(key)) continue;
    const rhs = p.slice(eq + 1).trim();
    out.push({ key, rhs, literal: isLiteral(rhs) });
  }
  return out;
}

/** "cart=full; user=guest" -> [["cart","full"],["user","guest"]]. An expression is returned as written (applyEffect computes it). */
export function parseEffect(effect: string): [string, string][] {
  return parseAssignments(effect).map((a) => [a.key, a.literal ? unquote(a.rhs) : a.rhs]);
}

/**
 * Runs the assignments in order, so `a=1; b=a+1` sees the new `a`. A right side that cannot be
 * computed (a word where a number is needed, a division by zero) leaves that variable alone.
 */
export function applyEffect(vars: Vars, effect: string): Vars {
  const assigns = parseAssignments(effect);
  if (assigns.length === 0) return vars;
  let next: Record<string, string> | null = null;
  for (const a of assigns) {
    let value: string;
    if (a.literal) value = unquote(a.rhs);
    else {
      try { value = evalExpr(a.rhs, next ?? vars); } catch { continue; }
    }
    next = next ?? { ...vars };
    next[a.key] = value;
  }
  return next ?? vars;
}

// --- GUARDIA ---------------------------------------------------------------

function unquote(v: string): string {
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

export interface GuardResult {
  /** The transition can be followed right now. */
  ok: boolean;
  /** Why it cannot (absent if ok). */
  reason?: string;
  /** The guard was understood. false = free text: never evaluated, never "true". */
  parsed: boolean;
  /** The guard is `else`: it holds when no other transition of the same hotspot does (see guardFor). */
  otherwise?: boolean;
}

/** The guard that means "none of the other conditions on this trigger holds". */
const ELSE = /^(else|otherwise)$/i;

/**
 * Evaluates a guard: alternatives separated by `||`, each a list of terms separated by `&&`.
 * A term is `k=v`, `k!=v`, `k` (truthy), `!k`, or any expression that gives a condition
 * (`count >= 3`, `count + 1 > limit`, `(a + b) * 2 == 10`). An empty guard is always true. A term
 * that is not understood makes the WHOLE guard unevaluable -> disabled with the reason: silently
 * letting through a condition that nobody verified would be a lie of the prototype.
 * `else` is returned as `otherwise`: only the transition list can say whether it holds.
 */
export function evalGuard(guard: string, vars: Vars): GuardResult {
  const g = guard.trim();
  if (g === "") return { ok: true, parsed: true };
  if (ELSE.test(g)) return { ok: false, parsed: true, otherwise: true, reason: "Only when no other condition holds" };
  // Every term is read, even after an alternative already holds: a guard with a term nobody can
  // evaluate is unevaluable as a whole, whatever the variables say today.
  const failedAlts: string[] = [];
  let holds = false;
  for (const alt of splitTop(g, ["||"])) {
    const failed: string[] = [];
    for (const term of splitTop(alt, ["&&"]).map((t) => t.trim())) {
      const r = evalTerm(term, vars);
      if (r === null) return { ok: false, parsed: false, reason: `Condition cannot be evaluated: "${g}"` };
      if (!r) failed.push(term);
    }
    if (failed.length === 0) holds = true;
    else failedAlts.push(failed.join(" and "));
  }
  if (holds) return { ok: true, parsed: true };
  return { ok: false, parsed: true, reason: `Requires ${failedAlts.join(" or ")}` };
}

/** Both numbers -> compared as numbers ("3" and "3.0" are the same count); otherwise as text. */
function sameValue(a: string, b: string): boolean {
  const x = /^-?\d+(?:\.\d+)?$/.test(a.trim()) ? Number(a) : NaN;
  const y = /^-?\d+(?:\.\d+)?$/.test(b.trim()) ? Number(b) : NaN;
  return Number.isNaN(x) || Number.isNaN(y) ? a === b : x === y;
}

// true/false, or null if the term is not in the grammar.
function evalTerm(term: string, vars: Vars): boolean | null {
  if (term === "") return null;
  // The plain forms first, with their old meaning: a variable on the left, text on the right.
  const ne = /^([^=!]+?)\s*!=\s*(.*)$/.exec(term);
  if (ne && IDENT.test(ne[1].trim()) && isLiteral(ne[2].trim())) {
    const v = vars[ne[1].trim()];
    return v === undefined || !sameValue(v, unquote(ne[2].trim()));
  }
  const eq = /^([^=!<>]+?)\s*==?\s*(.*)$/.exec(term);
  if (eq && IDENT.test(eq[1].trim()) && isLiteral(eq[2].trim())) {
    const v = vars[eq[1].trim()];
    return v !== undefined && sameValue(v, unquote(eq[2].trim()));
  }
  if (term.startsWith("!") && !term.startsWith("!=") && IDENT.test(term.slice(1).trim())) return !truthy(vars[term.slice(1).trim()]);
  if (IDENT.test(term)) return truthy(vars[term]);
  // Anything else is an expression: comparisons, arithmetic, parentheses.
  try { return evalCondition(term, vars); } catch { return null; }
}

// --- NAVIGAZIONE -----------------------------------------------------------

/** The entry screen: the flow's start, otherwise the first top-level frame. */
export function entryScreen(scene: SceneState, flow: FlowLite | null, pageId: string | null): string | null {
  if (flow && flow.startId !== "" && scene.nodes.has(flow.startId)) return flow.startId;
  // Fallback: the first screen in the current page's document order.
  const first = topLevelScreens(scene, pageId)[0];
  return first ? first.id : null;
}

export function startState(scene: SceneState, flow: FlowLite | null, pageId: string | null): ProtoState | null {
  const screenId = entryScreen(scene, flow, pageId);
  return screenId === null ? null : { screenId, vars: {}, history: [] };
}

export interface Option {
  transition: TransitionLite;
  /** Clickable now? */
  enabled: boolean;
  /** If it is not: why. */
  reason?: string;
  /** Not enabled, but another transition on the same hotspot and trigger is: a branch that does not apply. */
  superseded?: boolean;
}

/** True when two transitions share a hotspot: the same flow, screen, trigger and element. */
export function sameHotspot(a: TransitionLite, b: TransitionLite): boolean {
  return a.flowId === b.flowId && a.fromId === b.fromId && a.trigger === b.trigger && a.elementId === b.elementId;
}

/**
 * The ordered if / else if / else chain `t` belongs to: the transitions of its hotspot with
 * `order > 0`, in evaluation order (order, then id so the result never depends on map order).
 * Empty when `t` is not in a chain.
 */
export function chainOf(scene: SceneState, t: TransitionLite): TransitionLite[] {
  if (!(t.order && t.order > 0)) return [];
  return Object.values(scene.transitions)
    .filter((o) => !!o.order && o.order > 0 && sameHotspot(o, t))
    .sort((a, b) => (a.order! - b.order!) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The guard of `t` in the current state. Like evalGuard, except for `else`, which is the
 * "otherwise" of an if / else on one trigger: it holds when none of the OTHER transitions that
 * leave the same screen on the same trigger and the same element (the same hotspot) does. There
 * order between transitions is `order`: the members of an ordered CHAIN (order 1, 2, 3...) are
 * evaluated in sequence, the first whose guard holds applies and the later ones give way to it
 * (if / else if / else). Transitions without an order are independent branches: write the
 * conditions so they do not overlap, or when several hold the options are all enabled.
 */
export function guardFor(scene: SceneState, state: ProtoState, t: TransitionLite): GuardResult {
  const g = evalGuard(t.guard, state.vars);
  if (!g.otherwise) {
    if (!g.ok || !(t.order && t.order > 0)) return g;
    // A member of an ordered chain: an earlier member that holds takes the click.
    for (const o of chainOf(scene, t)) {
      if (o.id === t.id) break;
      if (ELSE.test(o.guard.trim()) || !scene.nodes.has(o.toId)) continue;
      if (evalGuard(o.guard, state.vars).ok) {
        return { ok: false, parsed: true, reason: `Not when ${o.guard.trim() === "" ? "an earlier branch" : o.guard.trim()}` };
      }
    }
    return g;
  }
  for (const o of Object.values(scene.transitions)) {
    if (o.id === t.id || o.flowId !== t.flowId || o.fromId !== t.fromId || o.trigger !== t.trigger || o.elementId !== t.elementId) continue;
    if (ELSE.test(o.guard.trim()) || !scene.nodes.has(o.toId)) continue;
    if (evalGuard(o.guard, state.vars).ok) {
      return { ok: false, parsed: true, otherwise: true, reason: `Not when ${o.guard.trim() === "" ? "another action" : o.guard.trim()}` };
    }
  }
  return { ok: true, parsed: true, otherwise: true };
}

/**
 * The transitions of the flow that start from the current screen, in stable
 * order (by label then by id), each with its enablement. Those
 * with `elementId` are hotspots on the element; the others go in the bar.
 */
export function optionsFrom(scene: SceneState, flowId: string, state: ProtoState): Option[] {
  const out: Option[] = [];
  for (const t of Object.values(scene.transitions)) {
    if (t.flowId !== flowId || t.fromId !== state.screenId) continue;
    // A vanished target is not reachable: it is not offered as clickable.
    if (!scene.nodes.has(t.toId)) {
      out.push({ transition: t, enabled: false, reason: "The destination screen no longer exists" });
      continue;
    }
    const g = guardFor(scene, state, t);
    out.push({ transition: t, enabled: g.ok, reason: g.reason });
  }
  // On one hotspot, a branch that does not apply while another does is not "locked": it is simply
  // the other side of an if / else. The player does not draw it.
  for (const o of out) {
    if (o.enabled || o.transition.elementId === "") continue;
    if (out.some((x) => x !== o && x.enabled && x.transition.elementId === o.transition.elementId && x.transition.trigger === o.transition.trigger)) {
      o.superseded = true;
    }
  }
  out.sort((a, b) => {
    const la = a.transition.label || a.transition.trigger;
    const lb = b.transition.label || b.transition.trigger;
    if (la !== lb) return la < lb ? -1 : 1;
    const oa = a.transition.order ?? 0, ob = b.transition.order ?? 0;
    if (oa !== ob) return oa - ob;
    return a.transition.id < b.transition.id ? -1 : 1;
  });
  return out;
}

/** Follows a transition (if enabled): effect on the variables, history updated. */
export function follow(scene: SceneState, state: ProtoState, t: TransitionLite): ProtoState {
  if (!scene.nodes.has(t.toId)) return state;
  if (!guardFor(scene, state, t).ok) return state;
  return {
    screenId: t.toId,
    vars: applyEffect(state.vars, t.effect),
    history: [...state.history, { screenId: state.screenId, vars: state.vars, via: t.id }],
  };
}

export function canGoBack(state: ProtoState): boolean {
  return state.history.length > 0;
}

/** Goes back to the previous screen (and variables). */
export function back(state: ProtoState): ProtoState {
  const prev = state.history[state.history.length - 1];
  if (!prev) return state;
  return { screenId: prev.screenId, vars: prev.vars, history: state.history.slice(0, -1) };
}

/** Goes back to screen number `index` of the path (0 = the first): the click on a breadcrumb. */
export function backTo(state: ProtoState, index: number): ProtoState {
  if (index < 0 || index >= state.history.length) return state;
  const at = state.history[index];
  return { screenId: at.screenId, vars: at.vars, history: state.history.slice(0, index) };
}

/** The path taken: the screens visited in order, up to the current one. */
export function trail(state: ProtoState): string[] {
  return [...state.history.map((h) => h.screenId), state.screenId];
}

/** Variables as "k = v" rows in alphabetical order ("variables" panel). */
export function varEntries(vars: Vars): [string, string][] {
  return Object.entries(vars).sort(([a], [b]) => (a < b ? -1 : 1));
}
