import type { FlowLite, SceneState, TransitionLite } from "../store/types";
import { topLevelScreens } from "./screens";

// THE LOGIC OF THE PLAYABLE PROTOTYPE. Pure: scene + state in, new
// state out; no DOM. The full-screen overlay (ui/PrototypePlayer.tsx)
// uses it to decide what is clickable and where it leads.
//
// The state is { screenId, vars, history }. The VARIABLES are strings: they are written by the
// transitions' `effect` ("cart=full; user=guest") and read by the `guard`.

export type Vars = Readonly<Record<string, string>>;

export interface ProtoStep { screenId: string; vars: Vars; via: string }

export interface ProtoState {
  screenId: string;
  vars: Vars;
  /** The PREVIOUS states (the oldest first): "back" returns to them. */
  history: readonly ProtoStep[];
}

// --- EFFETTO ---------------------------------------------------------------

/** "cart=full; user=guest" -> [["cart","full"],["user","guest"]]. Separators `;` or `,`. */
export function parseEffect(effect: string): [string, string][] {
  const out: [string, string][] = [];
  for (const part of effect.split(/[;,]/)) {
    const p = part.trim();
    if (p === "") continue;
    const eq = p.indexOf("=");
    // Without `=` it is not a readable assignment: it is ignored (it is free text).
    if (eq <= 0) continue;
    const key = p.slice(0, eq).trim();
    if (!IDENT.test(key)) continue;
    out.push([key, unquote(p.slice(eq + 1).trim())]);
  }
  return out;
}

export function applyEffect(vars: Vars, effect: string): Vars {
  const assigns = parseEffect(effect);
  if (assigns.length === 0) return vars;
  const next: Record<string, string> = { ...vars };
  for (const [k, v] of assigns) next[k] = v;
  return next;
}

// --- GUARDIA ---------------------------------------------------------------

// A variable name: letters, digits, `_`, `.`, `-` and not starting with a digit.
// No spaces: "cart not empty" is NOT a variable, it is free text.
const IDENT = /^[A-Za-z_][\w.-]*$/;

function unquote(v: string): string {
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

/** "truthy": set and different from "", "false", "0". */
export function truthy(v: string | undefined): boolean {
  if (v === undefined) return false;
  const t = v.trim().toLowerCase();
  return t !== "" && t !== "false" && t !== "0";
}

export interface GuardResult {
  /** The transition can be followed right now. */
  ok: boolean;
  /** Why it cannot (absent if ok). */
  reason?: string;
  /** The guard was understood. false = free text: never evaluated, never "true". */
  parsed: boolean;
}

/**
 * Evaluates a guard: terms separated by `&&`, each `k=v`, `k!=v`, `k`
 * (truthy) or `!k`. An empty guard is always true. A term that is not
 * understood makes the WHOLE guard unevaluable -> disabled with the reason:
 * silently letting through a condition that nobody verified would be a
 * lie of the prototype.
 */
export function evalGuard(guard: string, vars: Vars): GuardResult {
  const g = guard.trim();
  if (g === "") return { ok: true, parsed: true };
  const terms = g.split("&&").map((t) => t.trim());
  const failed: string[] = [];
  for (const term of terms) {
    const r = evalTerm(term, vars);
    if (r === null) {
      return { ok: false, parsed: false, reason: `Condition cannot be evaluated: "${g}"` };
    }
    if (!r) failed.push(term);
  }
  if (failed.length > 0) return { ok: false, parsed: true, reason: `Requires ${failed.join(" and ")}` };
  return { ok: true, parsed: true };
}

// true/false, or null if the term is not in the grammar.
function evalTerm(term: string, vars: Vars): boolean | null {
  if (term === "") return null;
  const ne = /^([^=!]+?)\s*!=\s*(.*)$/.exec(term);
  if (ne) {
    const k = ne[1].trim();
    if (!IDENT.test(k)) return null;
    return vars[k] !== unquote(ne[2].trim());
  }
  const eq = /^([^=!]+?)\s*==?\s*(.*)$/.exec(term);
  if (eq) {
    const k = eq[1].trim();
    if (!IDENT.test(k)) return null;
    return vars[k] === unquote(eq[2].trim());
  }
  if (term.startsWith("!")) {
    const k = term.slice(1).trim();
    return IDENT.test(k) ? !truthy(vars[k]) : null;
  }
  return IDENT.test(term) ? truthy(vars[term]) : null;
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
    const g = evalGuard(t.guard, state.vars);
    out.push({ transition: t, enabled: g.ok, reason: g.reason });
  }
  out.sort((a, b) => {
    const la = a.transition.label || a.transition.trigger;
    const lb = b.transition.label || b.transition.trigger;
    if (la !== lb) return la < lb ? -1 : 1;
    return a.transition.id < b.transition.id ? -1 : 1;
  });
  return out;
}

/** Follows a transition (if enabled): effect on the variables, history updated. */
export function follow(scene: SceneState, state: ProtoState, t: TransitionLite): ProtoState {
  if (!scene.nodes.has(t.toId)) return state;
  if (!evalGuard(t.guard, state.vars).ok) return state;
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
