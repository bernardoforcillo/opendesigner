import type { FlowLite, SceneState, TransitionLite } from "../store/types";
import { topLevelScreens } from "./screens";

// LA LOGICA DEL PROTOTIPO GIOCABILE. Pura: scena + stato in ingresso, nuovo
// stato in uscita; nessun DOM. L'overlay a tutto schermo (ui/PrototypePlayer.tsx)
// la usa per decidere cosa è cliccabile e dove porta.
//
// Lo stato è { screenId, vars, history }. Le VARIABILI sono stringhe: le scrive
// l'`effect` delle transizioni ("cart=full; user=guest") e le legge il `guard`.

export type Vars = Readonly<Record<string, string>>;

export interface ProtoStep { screenId: string; vars: Vars; via: string }

export interface ProtoState {
  screenId: string;
  vars: Vars;
  /** Gli stati PRECEDENTI (il più vecchio per primo): "indietro" ci torna. */
  history: readonly ProtoStep[];
}

// --- EFFETTO ---------------------------------------------------------------

/** "cart=full; user=guest" -> [["cart","full"],["user","guest"]]. Separatori `;` o `,`. */
export function parseEffect(effect: string): [string, string][] {
  const out: [string, string][] = [];
  for (const part of effect.split(/[;,]/)) {
    const p = part.trim();
    if (p === "") continue;
    const eq = p.indexOf("=");
    // Senza `=` non è un'assegnazione leggibile: si ignora (è testo libero).
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

// Un nome di variabile: lettere, cifre, `_`, `.`, `-` e non inizia con una cifra.
// Niente spazi: "cart non vuoto" NON è una variabile, è testo libero.
const IDENT = /^[A-Za-z_][\w.-]*$/;

function unquote(v: string): string {
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

/** "truthy": impostata e diversa da "", "false", "0". */
export function truthy(v: string | undefined): boolean {
  if (v === undefined) return false;
  const t = v.trim().toLowerCase();
  return t !== "" && t !== "false" && t !== "0";
}

export interface GuardResult {
  /** La transizione è percorribile adesso. */
  ok: boolean;
  /** Il perché non lo è (assente se ok). */
  reason?: string;
  /** La guardia è stata capita. false = testo libero: mai valutata, mai "vera". */
  parsed: boolean;
}

/**
 * Valuta una guardia: termini separati da `&&`, ciascuno `k=v`, `k!=v`, `k`
 * (truthy) o `!k`. Una guardia vuota è sempre vera. Un termine che non si
 * capisce rende TUTTA la guardia non valutabile -> disabilitata col motivo:
 * far passare in silenzio una condizione che nessuno ha verificato sarebbe una
 * bugia del prototipo.
 */
export function evalGuard(guard: string, vars: Vars): GuardResult {
  const g = guard.trim();
  if (g === "") return { ok: true, parsed: true };
  const terms = g.split("&&").map((t) => t.trim());
  const failed: string[] = [];
  for (const term of terms) {
    const r = evalTerm(term, vars);
    if (r === null) {
      return { ok: false, parsed: false, reason: `Condizione non valutabile: «${g}»` };
    }
    if (!r) failed.push(term);
  }
  if (failed.length > 0) return { ok: false, parsed: true, reason: `Richiede ${failed.join(" e ")}` };
  return { ok: true, parsed: true };
}

// true/false, oppure null se il termine non è nella grammatica.
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

/** La schermata d'ingresso: lo start del flusso, altrimenti il primo frame di primo livello. */
export function entryScreen(scene: SceneState, flow: FlowLite | null, pageId: string | null): string | null {
  if (flow && flow.startId !== "" && scene.nodes.has(flow.startId)) return flow.startId;
  // Fallback: la prima schermata dell'ordine di documento della pagina corrente.
  const first = topLevelScreens(scene, pageId)[0];
  return first ? first.id : null;
}

export function startState(scene: SceneState, flow: FlowLite | null, pageId: string | null): ProtoState | null {
  const screenId = entryScreen(scene, flow, pageId);
  return screenId === null ? null : { screenId, vars: {}, history: [] };
}

export interface Option {
  transition: TransitionLite;
  /** Cliccabile ora? */
  enabled: boolean;
  /** Se non lo è: perché. */
  reason?: string;
}

/**
 * Le transizioni del flusso che partono dalla schermata corrente, in ordine
 * stabile (per etichetta poi per id), ciascuna con la sua abilitazione. Quelle
 * con `elementId` sono hotspot sull'elemento; le altre vanno nella barra.
 */
export function optionsFrom(scene: SceneState, flowId: string, state: ProtoState): Option[] {
  const out: Option[] = [];
  for (const t of Object.values(scene.transitions)) {
    if (t.flowId !== flowId || t.fromId !== state.screenId) continue;
    // Un target sparito non è raggiungibile: non lo si offre come cliccabile.
    if (!scene.nodes.has(t.toId)) {
      out.push({ transition: t, enabled: false, reason: "La schermata di arrivo non esiste più" });
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

/** Percorre una transizione (se abilitata): effetto sulle variabili, cronologia aggiornata. */
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

/** Torna alla schermata (e alle variabili) di prima. */
export function back(state: ProtoState): ProtoState {
  const prev = state.history[state.history.length - 1];
  if (!prev) return state;
  return { screenId: prev.screenId, vars: prev.vars, history: state.history.slice(0, -1) };
}

/** Torna alla schermata numero `index` del percorso (0 = la prima): il click su una briciola. */
export function backTo(state: ProtoState, index: number): ProtoState {
  if (index < 0 || index >= state.history.length) return state;
  const at = state.history[index];
  return { screenId: at.screenId, vars: at.vars, history: state.history.slice(0, index) };
}

/** Il percorso fatto: le schermate visitate in ordine, fino a quella corrente. */
export function trail(state: ProtoState): string[] {
  return [...state.history.map((h) => h.screenId), state.screenId];
}

/** Variabili come righe "k = v" in ordine alfabetico (pannello "variabili"). */
export function varEntries(vars: Vars): [string, string][] {
  return Object.entries(vars).sort(([a], [b]) => (a < b ? -1 : 1));
}
