import { useMemo } from "react";
import { Button as RacButton } from "react-aria-components";
import type { FlowIssue, FlowPath, FlowReport } from "../gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "../store/store";
import { resolveFlow, sortedFlows, useFlowUi } from "../store/flowUi";
import { descendantsOf } from "../store/tree";
import type { FlowLite, SceneState, TransitionLite } from "../store/types";
import { useAnalysis, useFlowAnalysis, countByKind } from "../flow/analysis";
import { cameraToFit, isFullyVisible } from "../flow/camera";
import {
  createFlowOp, deleteFlowOp, deleteTransitionOp, editTransitionOp, renameFlowOp, setStartOp, submit,
} from "../flow/commands";
import { flowLayout } from "../flow/layout";
import { isScreenNode, screenName, screenOf } from "../flow/screens";
import { worldBoundsOfNode } from "../canvas/transform";
import { CommitField } from "./fields/CommitField";
import { Badge, Button, EmptyState, Icon, IconButton, Section, cls } from "./ds";
import { Field, FlowIcon, SwitchRow } from "./ds/flow-parts";

// THE FLOWS PANEL (replaces the layers on the left in Flows mode).
// From the top: the document's flows, the current flow's transitions with
// inline editing, the problems and the paths computed by the SERVER (AnalyzeFlows:
// the same analysis as CLI and MCP -- nothing is recomputed here).
//
// Every change is ONE op in ONE gesture (flow/commands.ts::submit), so it can be undone
// with Ctrl+Z and is visible to peers like any other.
//
// Violet (`flow`) is this mode's color: it tells you WHERE you are. It appears on the
// chosen flow and on the entry; the selection of a transition stays in the
// accent blue, like the arrow on the canvas.

const TRIGGERS = ["click", "submit", "auto", "key", "back"] as const;
const TRIGGER_LABELS: Record<string, string> = {
  click: "Click",
  submit: "Form submit",
  auto: "Automatic",
  key: "Key",
  back: "Back",
};

const ISSUE_LABELS: Record<string, string> = {
  no_start: "no entry",
  unreachable: "unreachable",
  dead_end: "dead ends",
  no_exit: "no exit",
  ambiguous: "ambiguous",
  empty: "empty",
};

// Severity of a problem, for the color: ambiguity and empty are warnings (the
// flow works, but needs review); the rest breaks the path (error).
const WARN_KINDS = new Set(["ambiguous", "empty"]);
const toneOf = (kind: string): "warn" | "danger" => (WARN_KINDS.has(kind) ? "warn" : "danger");

// A clickable row: same base for flows, transitions, problems, paths.
const ROW_FOCUS = "outline-none data-[focus-visible]:shadow-[var(--ring)]";

// Brings `b` (world) into view: the view's size is read from the scene's canvas,
// the only element that really knows it. If `b` is already fully visible the
// camera is not touched: the click just highlights.
function zoomTo(b: { x: number; y: number; width: number; height: number }): void {
  const el = typeof document !== "undefined" ? document.getElementById("scene") : null;
  const w = el?.clientWidth || 800;
  const h = el?.clientHeight || 600;
  const st = useScene.getState();
  if (!isFullyVisible(b, st.camera, w, h)) st.setCamera(cameraToFit(b, w, h));
}

// Selects a node (changing page if it is elsewhere) and frames it.
function focusNode(scene: SceneState, id: string): void {
  const n = scene.nodes.at(id);
  if (!n) return;
  const screen = screenOf(scene, id);
  if (screen) {
    const st = useScene.getState();
    if (st.currentPageId !== screen.parentId) st.setCurrentPage(screen.parentId);
  }
  useFlowUi.getState().selectTransition(null);
  useScene.getState().setSelection([id]);
  zoomTo(worldBoundsOfNode(scene, n));
}

function focusTransition(scene: SceneState, id: string): void {
  useFlowUi.getState().selectTransition(id);
  useScene.getState().clearSelection();
  const a = flowLayout(scene).byId.get(id);
  if (a) zoomTo(a.bounds);
}

// --- TRANSIZIONI -------------------------------------------------------------

function TransitionEditor({ scene, t }: { scene: SceneState; t: TransitionLite }) {
  const commit = (field: "label" | "trigger" | "guard" | "effect" | "elementId", v: string) => {
    const op = editTransitionOp(t, field, v);
    if (op) submit([op]);
  };
  // The start screen's elements that can act as hotspots: all its
  // descendants (with a cap, a huge frame must not produce a list
  // of thousands of rows).
  const elements = useMemo(() => descendantsOf(scene, t.fromId).slice(0, 300), [scene.nodes, t.fromId]);
  const triggers: string[] = (TRIGGERS as readonly string[]).includes(t.trigger) ? [...TRIGGERS] : [...TRIGGERS, t.trigger];
  return (
    <div className="flex flex-col gap-1.5 border-t border-line px-2.5 py-2.5">
      <Field label="Label" wide>
        <CommitField label="Label" value={t.label} onCommit={(v) => commit("label", v)} placeholder="e.g. Log in" />
      </Field>
      <Field label="Trigger" wide>
        <select
          aria-label="Trigger"
          value={t.trigger}
          onChange={(e) => commit("trigger", e.target.value)}
          className={cls.select}
        >
          {triggers.map((v) => (
            <option key={v} value={v}>{TRIGGER_LABELS[v] ?? v}</option>
          ))}
        </select>
      </Field>
      <Field label="Guard" wide>
        <CommitField label="Guard" value={t.guard} onCommit={(v) => commit("guard", v)} placeholder="e.g. user=guest" className="font-mono text-[12px]" />
      </Field>
      <Field label="Effect" wide>
        <CommitField label="Effect" value={t.effect} onCommit={(v) => commit("effect", v)} placeholder="e.g. cart=full" className="font-mono text-[12px]" />
      </Field>
      <Field label="Element" wide>
        <select
          aria-label="Element"
          value={t.elementId}
          onChange={(e) => commit("elementId", e.target.value)}
          className={cls.select}
        >
          <option value="">None (the whole screen)</option>
          {elements.map((n) => (
            <option key={n.id} value={n.id}>{n.name.trim() !== "" ? n.name : n.kind}</option>
          ))}
        </select>
      </Field>
      <div className="flex justify-end pt-0.5">
        <Button
          variant="danger"
          icon="trash"
          aria-label="Delete transition"
          onPress={() => {
            useFlowUi.getState().selectTransition(null);
            submit([deleteTransitionOp(t.id)]);
          }}
        >
          Delete
        </Button>
      </div>
    </div>
  );
}

function Transitions({ scene, flow }: { scene: SceneState; flow: FlowLite }) {
  const selected = useFlowUi((s) => s.selectedTransitionId);
  const list = useMemo(
    () => Object.values(scene.transitions).filter((t) => t.flowId === flow.id).sort((a, b) => (a.id < b.id ? -1 : 1)),
    [scene.transitions, flow.id],
  );
  return (
    <Section title="Transitions" count={list.length} bare>
      {list.length === 0 ? (
        <EmptyState
          icon="connect"
          title="No transitions"
          hint="Connect two screens with the Connect tool (K)."
        />
      ) : (
        <ul aria-label="Transitions" className="flex flex-col gap-1.5 px-3 pb-3">
          {list.map((t) => {
            const open = t.id === selected;
            const label = t.label.trim();
            return (
              <li
                key={t.id}
                className={
                  "overflow-hidden rounded-lg border bg-surface transition-colors " +
                  (open ? "border-accent shadow-[0_0_0_1px_var(--accent)]" : "border-line hover:border-line-strong")
                }
              >
                <RacButton
                  aria-label={`Transition ${screenName(scene, t.fromId)} to ${screenName(scene, t.toId)}`}
                  aria-expanded={open}
                  onPress={() => (open ? useFlowUi.getState().selectTransition(null) : focusTransition(scene, t.id))}
                  className={`flex w-full flex-col items-stretch gap-1 px-2.5 py-2 text-left ${ROW_FOCUS} ` + (open ? "bg-accent-soft" : "hover:bg-surface-2")}
                >
                  <span className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium text-fg">
                    <span className="truncate">{screenName(scene, t.fromId)}</span>
                    <FlowIcon name="arrowRight" size={12} className="shrink-0 text-fg-subtle" />
                    <span className="truncate">{screenName(scene, t.toId)}</span>
                  </span>
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className={"min-w-0 flex-1 truncate text-[12px] " + (label !== "" ? "text-fg-muted" : "italic text-fg-subtle")}>
                      {label !== "" ? t.label : "No label"}
                    </span>
                    {t.trigger !== "" && <Badge tone={open ? "accent" : "neutral"} className="shrink-0">{TRIGGER_LABELS[t.trigger] ?? t.trigger}</Badge>}
                  </span>
                  {(t.guard !== "" || t.effect !== "") && (
                    <span className="flex min-w-0 flex-wrap gap-1">
                      {t.guard !== "" && (
                        <span className="max-w-full truncate rounded bg-warn-soft px-1.5 font-mono text-[11px] text-warn">{`if ${t.guard}`}</span>
                      )}
                      {t.effect !== "" && (
                        <span className="max-w-full truncate rounded bg-surface-3 px-1.5 font-mono text-[11px] text-fg-muted">{t.effect}</span>
                      )}
                    </span>
                  )}
                </RacButton>
                {open && <TransitionEditor scene={scene} t={t} />}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

// --- PROBLEMI E PERCORSI -----------------------------------------------------

function Issues({ scene, report }: { scene: SceneState; report: FlowReport | undefined }) {
  const status = useAnalysis((s) => s.status);
  const error = useAnalysis((s) => s.error);
  const issues = report?.issues ?? [];
  const counts = countByKind(report);
  function open(i: FlowIssue) {
    if (i.transitionId !== "" && scene.transitions[i.transitionId]) focusTransition(scene, i.transitionId);
    else if (i.nodeId !== "") focusNode(scene, i.nodeId);
  }
  const loading = status === "loading" && !report;
  return (
    <Section
      title="Problems"
      count={loading ? undefined : issues.length}
      actions={loading ? <span className="pr-1 text-[11px] text-fg-subtle">analyzing…</span> : undefined}
      bare
    >
      {error && (
        <div role="alert" className="mx-3 mb-2 flex items-start gap-1.5 rounded-md bg-danger-soft px-2 py-1.5 text-[12px] text-danger">
          <Icon name="warning" size={14} className="mt-px shrink-0" />
          <span>Analisi non disponibile: {error}</span>
        </div>
      )}
      {issues.length > 0 && (
        <div className="flex flex-wrap gap-1 px-3 pb-2" aria-label="Problem summary">
          {Object.entries(counts).map(([k, n]) => (
            <Badge key={k} tone={toneOf(k)}>{`${ISSUE_LABELS[k] ?? k}: ${n}`}</Badge>
          ))}
        </div>
      )}
      {!report ? (
        <p className="px-3 pb-3 text-[12px] text-fg-subtle">{status === "loading" ? "Analysis in progress…" : "No analysis available."}</p>
      ) : issues.length === 0 ? (
        <p className="mx-3 mb-3 flex items-center gap-1.5 rounded-md bg-ok-soft px-2 py-1.5 text-[12px] font-medium text-ok">
          <Icon name="check" size={14} className="shrink-0" />
          <span>No problems found.</span>
        </p>
      ) : (
        <ul aria-label="Flow problems" className="flex flex-col gap-1 px-3 pb-3">
          {issues.map((i, idx) => {
            const tone = toneOf(i.kind);
            return (
              <li key={`${i.kind}-${i.nodeId}-${i.transitionId}-${idx}`}>
                <RacButton
                  onPress={() => open(i)}
                  className={`flex w-full items-start gap-2 rounded-lg border border-line bg-surface px-2 py-1.5 text-left text-[12px] leading-snug text-fg hover:border-line-strong hover:bg-surface-2 ${ROW_FOCUS}`}
                >
                  <span
                    aria-hidden="true"
                    className={`mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${tone === "warn" ? "bg-warn-soft text-warn" : "bg-danger-soft text-danger"}`}
                  >
                    <Icon name="warning" size={12} />
                  </span>
                  <span className="min-w-0 pt-0.5">{i.message}</span>
                </RacButton>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function pathLabel(scene: SceneState, p: FlowPath): string {
  const names = p.nodeIds.map((id) => screenName(scene, id)).join(" → ");
  return p.loops ? `${names} ↻` : names;
}

function Paths({ scene, report }: { scene: SceneState; report: FlowReport | undefined }) {
  if (!report) return null;
  return (
    <Section title="Paths" count={report.paths.length} actions={report.pathsTruncated ? <span className="pr-1 text-[11px] text-fg-subtle">+</span> : undefined} bare>
      {report.paths.length === 0 ? (
        <p className="px-3 pb-3 text-[12px] text-fg-subtle">No paths (an entry screen with exits is needed).</p>
      ) : (
        <ul aria-label="Flow paths" className="flex flex-col gap-1 px-3 pb-3">
          {report.paths.map((p, idx) => (
            <li key={idx}>
              <RacButton
                // The accessible name is the usual text line («A → B → C ↻»);
                // the drawn pills are its visual version, hidden from
                // screen readers so as not to read the same screens twice.
                aria-label={pathLabel(scene, p)}
                // A path is highlighted by selecting its screens.
                onPress={() => {
                  const ids = p.nodeIds.filter((id) => scene.nodes.has(id));
                  if (ids.length > 0) useScene.getState().setSelection(ids);
                }}
                className={`flex w-full flex-wrap items-center gap-1 rounded-lg border border-line bg-surface px-2 py-1.5 text-left hover:border-line-strong hover:bg-surface-2 ${ROW_FOCUS}`}
              >
                <span className="sr-only">{pathLabel(scene, p)}</span>
                {p.nodeIds.map((id, k) => (
                  <span key={k} aria-hidden="true" className="inline-flex items-center gap-1">
                    {k > 0 && <FlowIcon name="arrowRight" size={10} className="text-fg-subtle" />}
                    <span className="max-w-[110px] truncate rounded bg-surface-3 px-1.5 text-[11px] font-medium text-fg-muted">{screenName(scene, id)}</span>
                  </span>
                ))}
                {p.loops && (
                  <span aria-hidden="true" title="The path returns to an already visited screen" className="inline-flex items-center gap-0.5 rounded bg-flow-soft px-1 text-flow">
                    <FlowIcon name="loop" size={11} />
                  </span>
                )}
              </RacButton>
            </li>
          ))}
          {report.pathsTruncated && <li className="px-1 text-[11px] text-fg-subtle">List truncated: there are more paths.</li>}
        </ul>
      )}
    </Section>
  );
}

// --- THE PANEL ---------------------------------------------------------------

export function FlowPanel() {
  const scene = useScene((s) => s.scene);
  const selection = useScene((s) => s.selection);
  const currentFlowId = useFlowUi((s) => s.currentFlowId);
  const showAll = useFlowUi((s) => s.showAllFlows);
  const reports = useAnalysis((s) => s.reports);
  useFlowAnalysis(true);

  if (!scene) return null;
  const flows = sortedFlows(scene);
  const flow = resolveFlow(scene, currentFlowId);
  const report = flow ? reports[flow.id] : undefined;
  // The screen chosen for "Set as start": the selected node's.
  const picked = selection.length === 1 ? screenOf(scene, selection[0]) : null;
  const selectedScreen = isScreenNode(picked) ? picked : null;

  function newFlow() {
    const { op, flow: f } = createFlowOp(scene!);
    submit([op]);
    useFlowUi.getState().setCurrentFlow(f.id);
  }

  return (
    <div className="flex h-full flex-col bg-surface text-[13px] text-fg">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Section
          title="Flows"
          count={flows.length}
          actions={<IconButton icon="plus" label="New flow" tone="flow" onPress={newFlow} />}
          bare
        >
          {flows.length === 0 ? (
            <EmptyState
              icon="flow"
              title="No flows"
              hint="Connect two screens with the Connect tool (K): the first flow is created on its own."
            />
          ) : (
            <ul aria-label="Flows" className="flex flex-col gap-0.5 px-2 pb-2">
              {flows.map((f) => {
                const current = flow?.id === f.id;
                const n = Object.values(scene.transitions).filter((t) => t.flowId === f.id).length;
                return (
                  <li key={f.id}>
                    <RacButton
                      aria-current={current ? "true" : undefined}
                      onPress={() => useFlowUi.getState().setCurrentFlow(f.id)}
                      className={
                        `flex h-8 w-full items-center gap-2 rounded-md px-2 text-left ${ROW_FOCUS} ` +
                        (current ? "bg-flow-soft text-flow" : "text-fg hover:bg-surface-3")
                      }
                    >
                      <Icon name="flow" size={14} className={current ? "text-flow" : "text-fg-subtle"} />
                      <span className="min-w-0 flex-1 truncate font-medium">{f.name}</span>
                      <Badge tone={current ? "flow" : "neutral"} className={current ? "bg-surface" : ""}>{n}</Badge>
                    </RacButton>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        {flow && (
          <>
            <Section title="Current flow">
              <div className="flex flex-col gap-2">
                <CommitField
                  label="Flow name"
                  value={flow.name}
                  onCommit={(v) => {
                    const op = renameFlowOp(flow, v);
                    if (op) submit([op]);
                  }}
                />
                {/* Start, set and delete in ONE row: the chip says where the
                    flow starts, the two icons change or remove it. */}
                <div className="flex min-h-7 items-center gap-1.5">
                  <span
                    data-testid="flow-start"
                    title="The flow's entry screen"
                    className={
                      "flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-full px-2 text-[12px] font-medium " +
                      (flow.startId !== "" ? "bg-ok-soft text-ok" : "bg-surface-3 text-fg-subtle")
                    }
                  >
                    <Icon name="flag" size={12} className="shrink-0" />
                    <span className="truncate">{flow.startId !== "" ? screenName(scene, flow.startId) : "start not set"}</span>
                  </span>
                  <IconButton
                    icon="flag"
                    label="Set as start"
                    isDisabled={!selectedScreen || selectedScreen.id === flow.startId}
                    onPress={() => {
                      const op = selectedScreen ? setStartOp(flow, selectedScreen.id) : null;
                      if (op) submit([op]);
                    }}
                  />
                  <IconButton
                    icon="trash"
                    label="Delete flow"
                    onPress={() => {
                      submit([deleteFlowOp(flow.id)]);
                      useFlowUi.getState().setCurrentFlow(null);
                    }}
                  />
                </div>
                <SwitchRow
                  tone="flow"
                  label="Also show the other flows"
                  checked={showAll}
                  onChange={(v) => useFlowUi.getState().setShowAllFlows(v)}
                />
              </div>
            </Section>
            <Transitions scene={scene} flow={flow} />
            <Issues scene={scene} report={report} />
            <Paths scene={scene} report={report} />
          </>
        )}
      </div>
    </div>
  );
}
