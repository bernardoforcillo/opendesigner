import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import type { FlowLite, NodeLite, SceneState } from "../store/types";
import { sortedFlows } from "../store/flowUi";
import { sceneIndexOf } from "../renderer/sceneIndex";
import { META_KEYS, kindOf, statusOf, withMeta, type Status } from "../flow/meta";
import { screenName } from "../flow/screens";
import { setStartOp } from "../flow/commands";
import { makeSetPropsOp } from "../tools/ops";

// DELIVERY "READINESS": a pass/fail list that says whether the document is
// ready to become code. It is PURE (scene + report -> checklist): no
// store, no network, so it is tested with a table of cases. The flow
// analysis is done by the SERVER (AnalyzeFlows, the same as CLI and MCP): here it is only read,
// so as not to have two definitions of "dead end".
//
// Every failing row carries, when possible, a one-click FIX (`fix`):
// the descriptor says what to do, the ops are built with `assignRoutesOps` /
// `setStartsOps` (ONE gesture = ONE Ctrl+Z, see flow/commands.ts::submit).

/** The minimum of a FlowReport needed here (the generated type satisfies it). */
export interface ReportLike {
  flowId: string;
  issues: readonly { kind: string; nodeId: string; transitionId: string; message: string }[];
}

export type ReadinessFix =
  | { kind: "assign-routes"; label: string }
  | { kind: "set-starts"; label: string }
  | { kind: "goto-flows"; label: string }
  | { kind: "select"; label: string; nodeId: string };

/** A detail row of a failed check (a screen, a flow, a link). */
export interface ReadinessRow {
  label: string;
  /** The node to reach with "Select the screen", if any. */
  nodeId?: string;
}

export interface ReadinessItem {
  id: string;
  title: string;
  /** pass = fine; fail = must be fixed; warn = recommended; pending = not yet computable. */
  state: "pass" | "fail" | "warn" | "pending";
  /** A "blocking" failure prevents saying "ready"; a warning does not. */
  blocking: boolean;
  /** How many wrong entities (0 if fine). */
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
  /** Sum of the wrong entities of the failed BLOCKING checks. */
  blockers: number;
  progress: Progress;
  screens: NodeLite[];
}

// --- SCREENS -----------------------------------------------------------------

/**
 * The screens the code generator will export: the visible top-level frames
 * of every page (component masters excluded) plus the top-level nodes
 * that a flow references. The same definition as internal/codegen::collectScreens,
 * minus notes (`flow.kind = note`: annotations, not app pages).
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

/** As internal/codegen/names.go::slug: "Café menu" -> "cafe-menu"; empty -> "screen". */
export function slugOf(name: string): string {
  const folded = name.replace(/ß/g, "ss").normalize("NFD").replace(/[̀-ͯ]/g, "");
  const words = folded.split(/[^A-Za-z0-9]+/).filter((w) => w !== "");
  return words.length === 0 ? "screen" : words.map((w) => w.toLowerCase()).join("-");
}

/** The route as the generator reads it: spaces removed and a leading "/". */
export function normalizeRoute(route: string): string {
  const r = route.trim();
  if (r === "") return "";
  return r.startsWith("/") ? r : `/${r}`;
}

/**
 * The screens that need a new route, with the chosen one: those without
 * `code.route` and the DUPLICATES (the second and following with the same route; the
 * first keeps it). Routes that are already good and unique are not touched. The new one is
 * `/name-slug`, with the minimal numeric suffix that makes it free.
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

/** The ops that assign the missing/duplicate routes: one per screen, to be sent in ONE gesture. */
export function assignRoutesOps(scene: SceneState): Op[] {
  const ops: Op[] = [];
  for (const [id, route] of plannedRoutes(exportedScreens(scene))) {
    const n = scene.nodes.at(id);
    if (n) ops.push(makeSetPropsOp(id, { meta: withMeta(n, META_KEYS.route, route) }, ["meta"]));
  }
  return ops;
}

// --- START OF FLOWS ----------------------------------------------------------

function hasStart(scene: SceneState, f: FlowLite): boolean {
  return f.startId !== "" && scene.nodes.has(f.startId);
}

/**
 * The most sensible entry screen for a flow that has none: among those from which a
 * transition starts, the first (document order) that no transition
 * of the flow reaches; if all are reached (a cycle), the first that exits.
 * Without transitions: the document's first screen. "" if there are none.
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

// Which server issues block delivery and which are only advice.
// no_start is covered by the "start" check (same condition, with the fix);
// `empty` (a flow without screens) is advice: the code is generated anyway.
const BLOCKING_ISSUES = ["unreachable", "dead_end", "ambiguous"] as const;
const ISSUE_TITLES: Record<string, string> = {
  unreachable: "Unreachable screens",
  dead_end: "Dead ends",
  ambiguous: "Ambiguous transitions",
  no_exit: "Flows with no exit",
  empty: "Empty flows",
};

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The node to reach for an issue: the indicated node, or the edge's starting screen. */
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
 * The checklist. `reports` = null/undefined: the server's analysis has not yet
 * arrived (or has failed) -- the checks that depend on it stay "pending" and do NOT
 * count as blocking: nobody is called blocked while merely waiting.
 */
export function computeReadiness(scene: SceneState, reports: Readonly<Record<string, ReportLike>> | null | undefined): Readiness {
  const screens = exportedScreens(scene);
  const flows = sortedFlows(scene);
  const items: ReadinessItem[] = [];

  // 1. Are there screens? Without them, the rest makes no sense.
  items.push(
    screens.length > 0
      ? { id: "screens", title: "Screens to export", state: "pass", blocking: true, count: 0, detail: plural(screens.length, "screen", "screens"), rows: [] }
      : {
          id: "screens", title: "Screens to export", state: "fail", blocking: true, count: 1,
          detail: "No top-level frame: draw at least one screen.", rows: [],
        },
  );

  // 2. Routes: all present...
  const missing = screens.filter((n) => normalizeRoute(n.meta?.[META_KEYS.route] ?? "") === "");
  items.push(
    missing.length === 0
      ? { id: "routes", title: "Every screen has a route", state: "pass", blocking: true, count: 0, detail: "code.route set everywhere", rows: [] }
      : {
          id: "routes", title: "Every screen has a route", state: "fail", blocking: true, count: missing.length,
          detail: `${plural(missing.length, "screen without", "screens without")} code.route`,
          rows: missing.map((n) => ({ label: screenName(scene, n.id), nodeId: n.id })),
          fix: { kind: "assign-routes", label: "Assign routes" },
        },
  );
  // ... and unique.
  const byRoute = new Map<string, NodeLite[]>();
  for (const n of screens) {
    const r = normalizeRoute(n.meta?.[META_KEYS.route] ?? "");
    if (r !== "") byRoute.set(r, [...(byRoute.get(r) ?? []), n]);
  }
  const dupes = [...byRoute.entries()].filter(([, ns]) => ns.length > 1);
  const dupeNodes = dupes.reduce((a, [, ns]) => a + ns.length - 1, 0);
  items.push(
    dupes.length === 0
      ? { id: "routes-unique", title: "Unique routes", state: "pass", blocking: true, count: 0, detail: "no duplicates", rows: [] }
      : {
          id: "routes-unique", title: "Unique routes", state: "fail", blocking: true, count: dupeNodes,
          detail: `${plural(dupes.length, "route used", "routes used")} by several screens`,
          rows: dupes.flatMap(([r, ns]) => ns.map((n) => ({ label: `${screenName(scene, n.id)} · ${r}`, nodeId: n.id }))),
          fix: { kind: "assign-routes", label: "Assign routes" },
        },
  );

  // 3. Flows and entry screen.
  if (flows.length === 0) {
    items.push({
      id: "flows", title: "At least one flow", state: "fail", blocking: true, count: 1,
      detail: "Without flows the code has no navigation or tests: connect the screens.", rows: [],
      fix: { kind: "goto-flows", label: "Go to Flows" },
    });
  } else {
    const noStart = flows.filter((f) => !hasStart(scene, f));
    items.push(
      noStart.length === 0
        ? { id: "start", title: "Start set in every flow", state: "pass", blocking: true, count: 0, detail: plural(flows.length, "flow", "flows"), rows: [] }
        : {
            id: "start", title: "Start set in every flow", state: "fail", blocking: true, count: noStart.length,
            detail: `${plural(noStart.length, "flow without", "flows without")} a start screen`,
            rows: noStart.map((f) => ({ label: f.name })),
            fix: { kind: "set-starts", label: "Set the start" },
          },
    );
  }

  // 4. The issues the server finds.
  if (flows.length > 0) {
    if (!reports) {
      items.push({ id: "analysis", title: "Flow paths", state: "pending", blocking: false, count: 0, detail: "analysis in progress…", rows: [] });
    } else {
      for (const kind of [...BLOCKING_ISSUES, "no_exit", "empty"]) {
        const found = flows.flatMap((f) => (reports[f.id]?.issues ?? []).filter((i) => i.kind === kind));
        const blocking = (BLOCKING_ISSUES as readonly string[]).includes(kind);
        const title = ISSUE_TITLES[kind] ?? kind;
        if (found.length === 0) {
          // Only the blocking ones also appear when passed: they are the heart of the list.
          if (blocking) items.push({ id: `issue:${kind}`, title, state: "pass", blocking, count: 0, detail: "none", rows: [] });
          continue;
        }
        const rows = found.map((i) => {
          const nodeId = issueNode(scene, i);
          return { label: nodeId ? `${screenName(scene, nodeId)} — ${i.message}` : i.message, nodeId };
        });
        items.push({
          id: `issue:${kind}`, title, state: blocking ? "fail" : "warn", blocking, count: found.length,
          detail: plural(found.length, "case", "cases"), rows,
          fix: rows[0].nodeId ? { kind: "select", label: "Select the screen", nodeId: rows[0].nodeId } : undefined,
        });
      }
    }
  }

  // 5. Hotspots can be found again in tests: a transition without a label
  // whose element has no test.id / test.text has no reliable locator.
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
      ? { id: "hotspots", title: "Links recognizable in tests", state: "pass", blocking: false, count: 0, detail: "label, test.id or test.text everywhere", rows: [] }
      : {
          id: "hotspots", title: "Links recognizable in tests", state: "warn", blocking: false, count: hot.length,
          detail: `${plural(hot.length, "link without", "links without")} a label or test.id / test.text`,
          rows: hot,
          fix: hot[0].nodeId ? { kind: "select", label: "Select the screen", nodeId: hot[0].nodeId } : undefined,
        },
  );

  const blockers = items.reduce((a, i) => (i.blocking && i.state === "fail" ? a + i.count : a), 0);
  return { items, blockers, progress: progressOf(screens), screens };
}
