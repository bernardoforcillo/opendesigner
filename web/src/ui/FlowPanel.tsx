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

// IL PANNELLO FLUSSI (sostituisce i livelli a sinistra in modalità Flussi).
// Dall'alto: i flussi del documento, le transizioni del flusso corrente con la
// modifica in linea, i problemi e i percorsi che calcola il SERVER (AnalyzeFlows:
// la stessa analisi di CLI e MCP -- qui non si ricalcola niente).
//
// Ogni modifica è UN op in UN gesto (flow/commands.ts::submit), quindi annullabile
// con Ctrl+Z e visibile ai peer come qualunque altra.
//
// Il viola (`flow`) è il colore di questa modalità: dice DOVE sei. Compare sul
// flusso scelto e sull'ingresso; la selezione di una transizione resta nel blu
// d'accento, come la freccia sul canvas.

const TRIGGERS = ["click", "submit", "auto", "key", "back"] as const;
const TRIGGER_LABELS: Record<string, string> = {
  click: "Click",
  submit: "Invio modulo",
  auto: "Automatico",
  key: "Tasto",
  back: "Indietro",
};

const ISSUE_LABELS: Record<string, string> = {
  no_start: "senza ingresso",
  unreachable: "irraggiungibili",
  dead_end: "vicoli ciechi",
  no_exit: "senza uscita",
  ambiguous: "ambigue",
  empty: "vuoto",
};

// Gravità di un problema, per il colore: ambiguità e vuoto sono avvisi (il
// flusso funziona, ma è da rivedere); il resto spezza il percorso (errore).
const WARN_KINDS = new Set(["ambiguous", "empty"]);
const toneOf = (kind: string): "warn" | "danger" => (WARN_KINDS.has(kind) ? "warn" : "danger");

// Una riga cliccabile: stessa base per flussi, transizioni, problemi, percorsi.
const ROW_FOCUS = "outline-none data-[focus-visible]:shadow-[var(--ring)]";

// Porta in vista `b` (mondo): la dimensione della vista si legge dal canvas della
// scena, l'unico elemento che la conosce davvero. Se `b` si vede già tutto non
// si tocca la camera: il click evidenzia e basta.
function zoomTo(b: { x: number; y: number; width: number; height: number }): void {
  const el = typeof document !== "undefined" ? document.getElementById("scene") : null;
  const w = el?.clientWidth || 800;
  const h = el?.clientHeight || 600;
  const st = useScene.getState();
  if (!isFullyVisible(b, st.camera, w, h)) st.setCamera(cameraToFit(b, w, h));
}

// Seleziona un nodo (cambiando pagina se sta altrove) e lo inquadra.
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
  // Gli elementi della schermata di partenza che possono fare da hotspot: tutti i
  // suoi discendenti (con un tetto, un frame enorme non deve produrre una lista
  // di migliaia di righe).
  const elements = useMemo(() => descendantsOf(scene, t.fromId).slice(0, 300), [scene.nodes, t.fromId]);
  const triggers: string[] = (TRIGGERS as readonly string[]).includes(t.trigger) ? [...TRIGGERS] : [...TRIGGERS, t.trigger];
  return (
    <div className="flex flex-col gap-1.5 border-t border-line px-2.5 py-2.5">
      <Field label="Etichetta" wide>
        <CommitField label="Etichetta" value={t.label} onCommit={(v) => commit("label", v)} placeholder="es. Accedi" />
      </Field>
      <Field label="Innesco" wide>
        <select
          aria-label="Innesco"
          value={t.trigger}
          onChange={(e) => commit("trigger", e.target.value)}
          className={cls.select}
        >
          {triggers.map((v) => (
            <option key={v} value={v}>{TRIGGER_LABELS[v] ?? v}</option>
          ))}
        </select>
      </Field>
      <Field label="Guardia" wide>
        <CommitField label="Guardia" value={t.guard} onCommit={(v) => commit("guard", v)} placeholder="es. user=guest" className="font-mono text-[12px]" />
      </Field>
      <Field label="Effetto" wide>
        <CommitField label="Effetto" value={t.effect} onCommit={(v) => commit("effect", v)} placeholder="es. cart=full" className="font-mono text-[12px]" />
      </Field>
      <Field label="Elemento" wide>
        <select
          aria-label="Elemento"
          value={t.elementId}
          onChange={(e) => commit("elementId", e.target.value)}
          className={cls.select}
        >
          <option value="">Nessuno (tutta la schermata)</option>
          {elements.map((n) => (
            <option key={n.id} value={n.id}>{n.name.trim() !== "" ? n.name : n.kind}</option>
          ))}
        </select>
      </Field>
      <div className="flex justify-end pt-0.5">
        <Button
          variant="danger"
          icon="trash"
          aria-label="Elimina transizione"
          onPress={() => {
            useFlowUi.getState().selectTransition(null);
            submit([deleteTransitionOp(t.id)]);
          }}
        >
          Elimina
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
    <Section title="Transizioni" count={list.length} bare>
      {list.length === 0 ? (
        <EmptyState
          icon="connect"
          title="Nessuna transizione"
          hint="Collega due schermate con lo strumento Collega (K)."
        />
      ) : (
        <ul aria-label="Transizioni" className="flex flex-col gap-1.5 px-3 pb-3">
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
                  aria-label={`Transizione ${screenName(scene, t.fromId)} verso ${screenName(scene, t.toId)}`}
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
                      {label !== "" ? t.label : "Senza etichetta"}
                    </span>
                    {t.trigger !== "" && <Badge tone={open ? "accent" : "neutral"} className="shrink-0">{TRIGGER_LABELS[t.trigger] ?? t.trigger}</Badge>}
                  </span>
                  {(t.guard !== "" || t.effect !== "") && (
                    <span className="flex min-w-0 flex-wrap gap-1">
                      {t.guard !== "" && (
                        <span className="max-w-full truncate rounded bg-warn-soft px-1.5 font-mono text-[11px] text-warn">{`se ${t.guard}`}</span>
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
      title="Problemi"
      count={loading ? undefined : issues.length}
      actions={loading ? <span className="pr-1 text-[11px] text-fg-subtle">analisi…</span> : undefined}
      bare
    >
      {error && (
        <div role="alert" className="mx-3 mb-2 flex items-start gap-1.5 rounded-md bg-danger-soft px-2 py-1.5 text-[12px] text-danger">
          <Icon name="warning" size={14} className="mt-px shrink-0" />
          <span>Analisi non disponibile: {error}</span>
        </div>
      )}
      {issues.length > 0 && (
        <div className="flex flex-wrap gap-1 px-3 pb-2" aria-label="Riepilogo dei problemi">
          {Object.entries(counts).map(([k, n]) => (
            <Badge key={k} tone={toneOf(k)}>{`${ISSUE_LABELS[k] ?? k}: ${n}`}</Badge>
          ))}
        </div>
      )}
      {!report ? (
        <p className="px-3 pb-3 text-[12px] text-fg-subtle">{status === "loading" ? "Analisi in corso…" : "Nessuna analisi disponibile."}</p>
      ) : issues.length === 0 ? (
        <p className="mx-3 mb-3 flex items-center gap-1.5 rounded-md bg-ok-soft px-2 py-1.5 text-[12px] font-medium text-ok">
          <Icon name="check" size={14} className="shrink-0" />
          <span>Nessun problema rilevato.</span>
        </p>
      ) : (
        <ul aria-label="Problemi del flusso" className="flex flex-col gap-1 px-3 pb-3">
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
    <Section title="Percorsi" count={report.paths.length} actions={report.pathsTruncated ? <span className="pr-1 text-[11px] text-fg-subtle">+</span> : undefined} bare>
      {report.paths.length === 0 ? (
        <p className="px-3 pb-3 text-[12px] text-fg-subtle">Nessun percorso (serve una schermata d'ingresso con delle uscite).</p>
      ) : (
        <ul aria-label="Percorsi del flusso" className="flex flex-col gap-1 px-3 pb-3">
          {report.paths.map((p, idx) => (
            <li key={idx}>
              <RacButton
                // Il nome accessibile è la riga di testo di sempre («A → B → C ↻»);
                // le pillole disegnate sono la sua versione visiva, nascosta ai
                // lettori di schermo per non leggere le stesse schermate due volte.
                aria-label={pathLabel(scene, p)}
                // Un percorso si evidenzia selezionando le sue schermate.
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
                  <span aria-hidden="true" title="Il percorso torna su una schermata già visitata" className="inline-flex items-center gap-0.5 rounded bg-flow-soft px-1 text-flow">
                    <FlowIcon name="loop" size={11} />
                  </span>
                )}
              </RacButton>
            </li>
          ))}
          {report.pathsTruncated && <li className="px-1 text-[11px] text-fg-subtle">Elenco troncato: ci sono altri percorsi.</li>}
        </ul>
      )}
    </Section>
  );
}

// --- IL PANNELLO -------------------------------------------------------------

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
  // La schermata scelta per "Imposta come inizio": quella del nodo selezionato.
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
          title="Flussi"
          count={flows.length}
          actions={<IconButton icon="plus" label="Nuovo flusso" tone="flow" onPress={newFlow} />}
          bare
        >
          {flows.length === 0 ? (
            <EmptyState
              icon="flow"
              title="Nessun flusso"
              hint="Collega due schermate con lo strumento Collega (K): il primo flusso nasce da solo."
            />
          ) : (
            <ul aria-label="Flussi" className="flex flex-col gap-0.5 px-2 pb-2">
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
            <Section title="Flusso corrente">
              <div className="flex flex-col gap-2">
                <Field label="Nome">
                  <CommitField
                    label="Nome del flusso"
                    value={flow.name}
                    onCommit={(v) => {
                      const op = renameFlowOp(flow, v);
                      if (op) submit([op]);
                    }}
                  />
                </Field>
                <div className="flex min-h-7 items-center gap-2">
                  <span className="w-14 shrink-0 text-[11px] font-medium text-fg-subtle">Inizio</span>
                  <span
                    data-testid="flow-start"
                    className={
                      "inline-flex h-6 min-w-0 max-w-full items-center gap-1 rounded-full px-2 text-[12px] font-medium " +
                      (flow.startId !== "" ? "bg-ok-soft text-ok" : "bg-surface-3 text-fg-subtle")
                    }
                  >
                    <Icon name="flag" size={12} className="shrink-0" />
                    <span className="truncate">{flow.startId !== "" ? screenName(scene, flow.startId) : "non impostato"}</span>
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Button
                    variant="secondary"
                    icon="flag"
                    aria-label="Imposta come inizio"
                    isDisabled={!selectedScreen || selectedScreen.id === flow.startId}
                    onPress={() => {
                      const op = selectedScreen ? setStartOp(flow, selectedScreen.id) : null;
                      if (op) submit([op]);
                    }}
                  >
                    Imposta come inizio
                  </Button>
                  <Button
                    variant="danger"
                    icon="trash"
                    aria-label="Elimina flusso"
                    className="ml-auto"
                    onPress={() => {
                      submit([deleteFlowOp(flow.id)]);
                      useFlowUi.getState().setCurrentFlow(null);
                    }}
                  >
                    Elimina
                  </Button>
                </div>
                <SwitchRow
                  tone="flow"
                  label="Mostra anche gli altri flussi"
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
