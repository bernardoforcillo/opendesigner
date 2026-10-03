import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import type { FlowLite, NodeLite, SceneState } from "../store/types";
import { sortedFlows } from "../store/flowUi";
import { sceneIndexOf } from "../renderer/sceneIndex";
import { META_KEYS, kindOf, statusOf, withMeta, type Status } from "../flow/meta";
import { screenName } from "../flow/screens";
import { setStartOp } from "../flow/commands";
import { makeSetPropsOp } from "../tools/ops";

// LA "PRONTEZZA" DELLA CONSEGNA: una lista pass/fail che dice se il documento è
// pronto per diventare codice. È PURA (scena + report -> checklist): niente
// store, niente rete, quindi si prova con una tabella di casi. L'analisi dei
// flussi la fa il SERVER (AnalyzeFlows, la stessa di CLI e MCP): qui si legge e
// basta, per non avere due definizioni di "vicolo cieco".
//
// Ogni riga che fallisce porta, quando si può, una CORREZIONE a un click (`fix`):
// il descrittore dice cosa fare, gli op si costruiscono con `assignRoutesOps` /
// `setStartsOps` (UN gesto = UN Ctrl+Z, vedi flow/commands.ts::submit).

/** Il minimo di un FlowReport che serve qui (il tipo generato lo soddisfa). */
export interface ReportLike {
  flowId: string;
  issues: readonly { kind: string; nodeId: string; transitionId: string; message: string }[];
}

export type ReadinessFix =
  | { kind: "assign-routes"; label: string }
  | { kind: "set-starts"; label: string }
  | { kind: "goto-flows"; label: string }
  | { kind: "select"; label: string; nodeId: string };

/** Una riga di dettaglio di un controllo fallito (una schermata, un flusso, un collegamento). */
export interface ReadinessRow {
  label: string;
  /** Il nodo da raggiungere con "Seleziona la schermata", se c'è. */
  nodeId?: string;
}

export interface ReadinessItem {
  id: string;
  title: string;
  /** pass = a posto; fail = va sistemato; warn = consigliato; pending = non ancora calcolabile. */
  state: "pass" | "fail" | "warn" | "pending";
  /** Un fallimento "bloccante" impedisce di dire "pronto"; un avviso no. */
  blocking: boolean;
  /** Quante entità sbagliate (0 se a posto). */
  count: number;
  detail: string;
  rows: ReadinessRow[];
  fix?: ReadinessFix;
}

export interface Progress extends Record<Status, number> {
  total: number;
}

export interface Readiness {
  items: ReadinessItem[];
  /** Somma delle entità sbagliate dei controlli BLOCCANTI falliti. */
  blockers: number;
  progress: Progress;
  screens: NodeLite[];
}

// --- SCHERMATE ---------------------------------------------------------------

/**
 * Le schermate che il generatore di codice esporterà: i frame di primo livello
 * visibili di ogni pagina (i master dei componenti no) più i nodi di primo livello
 * che un flusso referenzia. La stessa definizione di internal/codegen::collectScreens,
 * meno le note (`flow.kind = note`: annotazioni, non pagine dell'app).
 */
export function exportedScreens(scene: SceneState): NodeLite[] {
  const masters = new Set(Object.values(scene.components).map((c) => c.rootNodeId));
  const referenced = new Set<string>();
  for (const f of Object.values(scene.flows)) if (f.startId) referenced.add(f.startId);
  for (const t of Object.values(scene.transitions)) {
    referenced.add(t.fromId);
    referenced.add(t.toId);
  }
  const children = sceneIndexOf(scene).children;
  const out: NodeLite[] = [];
  for (const p of scene.pages) {
    for (const n of children.get(p.id) ?? []) {
      if (!n.visible) continue;
      const isScreen = (n.kind === "frame" && !masters.has(n.id)) || referenced.has(n.id);
      if (isScreen && kindOf(n) !== "note") out.push(n);
    }
  }
  return out;
}

// --- ROTTE -------------------------------------------------------------------

/** Come internal/codegen/names.go::slug: "Città nuova" -> "citta-nuova"; vuoto -> "screen". */
export function slugOf(name: string): string {
  const folded = name.replace(/ß/g, "ss").normalize("NFD").replace(/[̀-ͯ]/g, "");
  const words = folded.split(/[^A-Za-z0-9]+/).filter((w) => w !== "");
  return words.length === 0 ? "screen" : words.map((w) => w.toLowerCase()).join("-");
}

/** La rotta come la legge il generatore: spazi tolti e una "/" iniziale. */
export function normalizeRoute(route: string): string {
  const r = route.trim();
  if (r === "") return "";
  return r.startsWith("/") ? r : `/${r}`;
}

/**
 * Le schermate che hanno bisogno di una rotta nuova, con quella scelta: le prive di
 * `code.route` e i DOPPIONI (la seconda e le successive con la stessa rotta; la
 * prima la tiene). Le rotte già buone e uniche non si toccano. La nuova è
 * `/slug-del-nome`, col suffisso numerico minimo che la rende libera.
 */
export function plannedRoutes(screens: readonly NodeLite[]): Map<string, string> {
  const used = new Set<string>();
  const needs: NodeLite[] = [];
  for (const n of screens) {
    const r = normalizeRoute(n.meta?.[META_KEYS.route] ?? "");
    if (r === "" || used.has(r)) needs.push(n);
    else used.add(r);
  }
  const out = new Map<string, string>();
  for (const n of needs) {
    const base = `/${slugOf(n.name)}`;
    let route = base;
    for (let i = 2; used.has(route); i++) route = `${base}-${i}`;
    used.add(route);
    out.set(n.id, route);
  }
  return out;
}

/** Gli op che assegnano le rotte mancanti/duplicate: uno per schermata, da inviare in UN gesto. */
export function assignRoutesOps(scene: SceneState): Op[] {
  const ops: Op[] = [];
  for (const [id, route] of plannedRoutes(exportedScreens(scene))) {
    const n = scene.nodes.at(id);
    if (n) ops.push(makeSetPropsOp(id, { meta: withMeta(n, META_KEYS.route, route) }, ["meta"]));
  }
  return ops;
}

// --- INIZIO DEI FLUSSI -------------------------------------------------------

function hasStart(scene: SceneState, f: FlowLite): boolean {
  return f.startId !== "" && scene.nodes.has(f.startId);
}

/**
 * La schermata d'ingresso più sensata per un flusso senza: fra quelle da cui
 * parte una transizione, la prima (ordine del documento) che nessuna transizione
 * del flusso raggiunge; se tutte sono raggiunte (un ciclo), la prima che esce.
 * Senza transizioni: la prima schermata del documento. "" se non ce ne sono.
 */
export function suggestStart(scene: SceneState, flow: FlowLite, screens: readonly NodeLite[]): string {
  const trs = Object.values(scene.transitions).filter((t) => t.flowId === flow.id);
  const order = new Map(screens.map((n, i) => [n.id, i]));
  const rank = (id: string) => order.get(id) ?? Number.MAX_SAFE_INTEGER;
  const sources = [...new Set(trs.map((t) => t.fromId))].filter((id) => scene.nodes.has(id)).sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1));
  const targets = new Set(trs.map((t) => t.toId));
  const root = sources.find((id) => !targets.has(id));
  return root ?? sources[0] ?? screens[0]?.id ?? "";
}

export function setStartsOps(scene: SceneState): Op[] {
  const screens = exportedScreens(scene);
  const ops: Op[] = [];
  for (const f of sortedFlows(scene)) {
    if (hasStart(scene, f)) continue;
    const id = suggestStart(scene, f, screens);
    const op = id ? setStartOp(f, id) : null;
    if (op) ops.push(op);
  }
  return ops;
}

// --- LA CHECKLIST ------------------------------------------------------------

// Quali problemi del server bloccano la consegna e quali sono solo un consiglio.
// no_start lo copre il controllo "inizio" (stessa condizione, con la correzione);
// `empty` (flusso senza schermate) è un consiglio: il codice si genera lo stesso.
const BLOCKING_ISSUES = ["unreachable", "dead_end", "ambiguous"] as const;
const ISSUE_TITLES: Record<string, string> = {
  unreachable: "Schermate irraggiungibili",
  dead_end: "Vicoli ciechi",
  ambiguous: "Transizioni ambigue",
  no_exit: "Flussi senza uscita",
  empty: "Flussi vuoti",
};

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Il nodo da raggiungere per un problema: il nodo indicato, o la schermata di partenza dell'arco. */
function issueNode(scene: SceneState, i: { nodeId: string; transitionId: string }): string | undefined {
  if (i.nodeId && scene.nodes.has(i.nodeId)) return i.nodeId;
  const t = i.transitionId ? scene.transitions[i.transitionId] : undefined;
  return t && scene.nodes.has(t.fromId) ? t.fromId : undefined;
}

export function progressOf(screens: readonly NodeLite[]): Progress {
  const p: Progress = { planned: 0, implemented: 0, tested: 0, total: screens.length };
  for (const n of screens) p[statusOf(n)]++;
  return p;
}

/**
 * La checklist. `reports` = null/undefined: l'analisi del server non è ancora
 * arrivata (o è fallita) -- i controlli che ne dipendono restano "pending" e NON
 * contano come bloccanti: non si dà del bloccato a chi sta solo aspettando.
 */
export function computeReadiness(scene: SceneState, reports: Readonly<Record<string, ReportLike>> | null | undefined): Readiness {
  const screens = exportedScreens(scene);
  const flows = sortedFlows(scene);
  const items: ReadinessItem[] = [];

  // 1. Ci sono schermate? Senza, il resto non ha senso.
  items.push(
    screens.length > 0
      ? { id: "screens", title: "Schermate da esportare", state: "pass", blocking: true, count: 0, detail: plural(screens.length, "schermata", "schermate"), rows: [] }
      : {
          id: "screens", title: "Schermate da esportare", state: "fail", blocking: true, count: 1,
          detail: "Nessun frame di primo livello: disegna almeno una schermata.", rows: [],
        },
  );

  // 2. Rotte: tutte presenti...
  const missing = screens.filter((n) => normalizeRoute(n.meta?.[META_KEYS.route] ?? "") === "");
  items.push(
    missing.length === 0
      ? { id: "routes", title: "Ogni schermata ha una rotta", state: "pass", blocking: true, count: 0, detail: "code.route impostato ovunque", rows: [] }
      : {
          id: "routes", title: "Ogni schermata ha una rotta", state: "fail", blocking: true, count: missing.length,
          detail: `${plural(missing.length, "schermata senza", "schermate senza")} code.route`,
          rows: missing.map((n) => ({ label: screenName(scene, n.id), nodeId: n.id })),
          fix: { kind: "assign-routes", label: "Assegna le rotte" },
        },
  );
  // ... e uniche.
  const byRoute = new Map<string, NodeLite[]>();
  for (const n of screens) {
    const r = normalizeRoute(n.meta?.[META_KEYS.route] ?? "");
    if (r !== "") byRoute.set(r, [...(byRoute.get(r) ?? []), n]);
  }
  const dupes = [...byRoute.entries()].filter(([, ns]) => ns.length > 1);
  const dupeNodes = dupes.reduce((a, [, ns]) => a + ns.length - 1, 0);
  items.push(
    dupes.length === 0
      ? { id: "routes-unique", title: "Rotte uniche", state: "pass", blocking: true, count: 0, detail: "nessun doppione", rows: [] }
      : {
          id: "routes-unique", title: "Rotte uniche", state: "fail", blocking: true, count: dupeNodes,
          detail: `${plural(dupes.length, "rotta usata", "rotte usate")} da più schermate`,
          rows: dupes.flatMap(([r, ns]) => ns.map((n) => ({ label: `${screenName(scene, n.id)} · ${r}`, nodeId: n.id }))),
          fix: { kind: "assign-routes", label: "Assegna le rotte" },
        },
  );

  // 3. Flussi e schermata d'ingresso.
  if (flows.length === 0) {
    items.push({
      id: "flows", title: "Almeno un flusso", state: "fail", blocking: true, count: 1,
      detail: "Senza flussi il codice non ha navigazione né test: collega le schermate.", rows: [],
      fix: { kind: "goto-flows", label: "Vai ai Flussi" },
    });
  } else {
    const noStart = flows.filter((f) => !hasStart(scene, f));
    items.push(
      noStart.length === 0
        ? { id: "start", title: "Inizio impostato in ogni flusso", state: "pass", blocking: true, count: 0, detail: plural(flows.length, "flusso", "flussi"), rows: [] }
        : {
            id: "start", title: "Inizio impostato in ogni flusso", state: "fail", blocking: true, count: noStart.length,
            detail: `${plural(noStart.length, "flusso senza", "flussi senza")} schermata iniziale`,
            rows: noStart.map((f) => ({ label: f.name })),
            fix: { kind: "set-starts", label: "Imposta l'inizio" },
          },
    );
  }

  // 4. I problemi che trova il server.
  if (flows.length > 0) {
    if (!reports) {
      items.push({ id: "analysis", title: "Percorsi dei flussi", state: "pending", blocking: false, count: 0, detail: "analisi in corso…", rows: [] });
    } else {
      for (const kind of [...BLOCKING_ISSUES, "no_exit", "empty"]) {
        const found = flows.flatMap((f) => (reports[f.id]?.issues ?? []).filter((i) => i.kind === kind));
        const blocking = (BLOCKING_ISSUES as readonly string[]).includes(kind);
        const title = ISSUE_TITLES[kind] ?? kind;
        if (found.length === 0) {
          // Solo i bloccanti compaiono anche da passati: sono il cuore della lista.
          if (blocking) items.push({ id: `issue:${kind}`, title, state: "pass", blocking, count: 0, detail: "nessuno", rows: [] });
          continue;
        }
        const rows = found.map((i) => {
          const nodeId = issueNode(scene, i);
          return { label: nodeId ? `${screenName(scene, nodeId)} — ${i.message}` : i.message, nodeId };
        });
        items.push({
          id: `issue:${kind}`, title, state: blocking ? "fail" : "warn", blocking, count: found.length,
          detail: plural(found.length, "caso", "casi"), rows,
          fix: rows[0].nodeId ? { kind: "select", label: "Seleziona la schermata", nodeId: rows[0].nodeId } : undefined,
        });
      }
    }
  }

  // 5. Gli hotspot si possono ritrovare nei test: una transizione senza etichetta
  // il cui elemento non ha test.id / test.text non ha un locator affidabile.
  const hot: ReadinessRow[] = [];
  for (const t of Object.values(scene.transitions)) {
    if (t.label.trim() !== "") continue;
    const el = t.elementId ? scene.nodes.at(t.elementId) : undefined;
    const named = el && ((el.meta?.[META_KEYS.testId] ?? "").trim() !== "" || (el.meta?.[META_KEYS.testText] ?? "").trim() !== "");
    if (named) continue;
    const from = scene.nodes.has(t.fromId) ? t.fromId : undefined;
    hot.push({
      label: `${screenName(scene, t.fromId)} → ${screenName(scene, t.toId)}`,
      nodeId: el ? el.id : from,
    });
  }
  items.push(
    hot.length === 0
      ? { id: "hotspots", title: "Collegamenti riconoscibili nei test", state: "pass", blocking: false, count: 0, detail: "etichetta, test.id o test.text ovunque", rows: [] }
      : {
          id: "hotspots", title: "Collegamenti riconoscibili nei test", state: "warn", blocking: false, count: hot.length,
          detail: `${plural(hot.length, "collegamento senza", "collegamenti senza")} etichetta né test.id / test.text`,
          rows: hot,
          fix: hot[0].nodeId ? { kind: "select", label: "Seleziona la schermata", nodeId: hot[0].nodeId } : undefined,
        },
  );

  const blockers = items.reduce((a, i) => (i.blocking && i.state === "fail" ? a + i.count : a), 0);
  return { items, blockers, progress: progressOf(screens), screens };
}
