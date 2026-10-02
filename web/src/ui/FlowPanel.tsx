import { useMemo } from "react";
import { Button } from "react-aria-components";
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

// IL PANNELLO FLUSSI (sostituisce i livelli a sinistra in modalità Flussi).
// Dall'alto: i flussi del documento, le transizioni del flusso corrente con la
// modifica in linea, i problemi e i percorsi che calcola il SERVER (AnalyzeFlows:
// la stessa analisi di CLI e MCP -- qui non si ricalcola niente).
//
// Ogni modifica è UN op in UN gesto (flow/commands.ts::submit), quindi annullabile
// con Ctrl+Z e visibile ai peer come qualunque altra.

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

const FIELD_CLASS =
  "w-full min-w-0 rounded border border-neutral-200 bg-white px-1.5 py-0.5 text-sm outline-none focus:border-sky-500";
const BTN =
  "rounded px-2 py-0.5 text-sm text-neutral-600 outline-none hover:bg-neutral-100 " +
  "data-[focus-visible]:ring-1 data-[focus-visible]:ring-sky-500 data-[disabled]:opacity-40 data-[disabled]:hover:bg-transparent";

function SectionTitle({ children, aside }: { children: string; aside?: string }) {
  return (
    <div className="flex items-center justify-between border-b border-t border-neutral-200 bg-neutral-50 px-2 py-1 text-xs font-medium uppercase tracking-wide text-neutral-400">
      <span>{children}</span>
      {aside && <span className="normal-case tracking-normal">{aside}</span>}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="w-14 shrink-0 select-none text-xs text-neutral-400">{label}</span>
      {children}
    </label>
  );
}

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
    <div className="flex flex-col gap-1 border-t border-neutral-100 bg-neutral-50 px-2 py-2">
      <Row label="Etichetta">
        <CommitField label="Etichetta" value={t.label} onCommit={(v) => commit("label", v)} placeholder="es. Accedi" />
      </Row>
      <Row label="Innesco">
        <select
          aria-label="Innesco"
          value={t.trigger}
          onChange={(e) => commit("trigger", e.target.value)}
          className={FIELD_CLASS}
        >
          {triggers.map((v) => (
            <option key={v} value={v}>{TRIGGER_LABELS[v] ?? v}</option>
          ))}
        </select>
      </Row>
      <Row label="Guardia">
        <CommitField label="Guardia" value={t.guard} onCommit={(v) => commit("guard", v)} placeholder="es. user=guest" />
      </Row>
      <Row label="Effetto">
        <CommitField label="Effetto" value={t.effect} onCommit={(v) => commit("effect", v)} placeholder="es. cart=full" />
      </Row>
      <Row label="Elemento">
        <select
          aria-label="Elemento"
          value={t.elementId}
          onChange={(e) => commit("elementId", e.target.value)}
          className={FIELD_CLASS}
        >
          <option value="">Nessuno (tutta la schermata)</option>
          {elements.map((n) => (
            <option key={n.id} value={n.id}>{n.name.trim() !== "" ? n.name : n.kind}</option>
          ))}
        </select>
      </Row>
      <div className="flex justify-end">
        <Button
          aria-label="Elimina transizione"
          className={BTN + " text-red-600"}
          onPress={() => {
            useFlowUi.getState().selectTransition(null);
            submit([deleteTransitionOp(t.id)]);
          }}
        >
          Elimina transizione
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
    <>
      <SectionTitle aside={String(list.length)}>Transizioni</SectionTitle>
      {list.length === 0 ? (
        <div className="px-2 py-3 text-neutral-400">
          Nessuna transizione. Con «Collega» (K) trascina da una schermata a un'altra.
        </div>
      ) : (
        <ul aria-label="Transizioni">
          {list.map((t) => {
            const open = t.id === selected;
            return (
              <li key={t.id} className="border-b border-neutral-100">
                <Button
                  aria-label={`Transizione ${screenName(scene, t.fromId)} verso ${screenName(scene, t.toId)}`}
                  aria-expanded={open}
                  onPress={() => (open ? useFlowUi.getState().selectTransition(null) : focusTransition(scene, t.id))}
                  className={
                    "flex w-full flex-col items-start gap-0 px-2 py-1 text-left outline-none hover:bg-neutral-50 " +
                    "data-[focus-visible]:ring-1 data-[focus-visible]:ring-inset data-[focus-visible]:ring-sky-500 " +
                    (open ? "bg-sky-50" : "")
                  }
                >
                  <span className="max-w-full truncate text-sm">
                    {screenName(scene, t.fromId)} <span className="text-neutral-400">→</span> {screenName(scene, t.toId)}
                  </span>
                  <span className="max-w-full truncate text-xs text-neutral-400">
                    {t.label.trim() !== "" ? t.label : TRIGGER_LABELS[t.trigger] ?? t.trigger}
                    {t.guard !== "" && ` · se ${t.guard}`}
                    {t.effect !== "" && ` · ${t.effect}`}
                  </span>
                </Button>
                {open && <TransitionEditor scene={scene} t={t} />}
              </li>
            );
          })}
        </ul>
      )}
    </>
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
  return (
    <>
      <SectionTitle aside={status === "loading" && !report ? "analisi…" : String(issues.length)}>Problemi</SectionTitle>
      {error && (
        <div role="alert" className="px-2 py-1 text-xs text-red-700">
          Analisi non disponibile: {error}
        </div>
      )}
      {issues.length > 0 && (
        <div className="flex flex-wrap gap-1 px-2 pt-1.5" aria-label="Riepilogo dei problemi">
          {Object.entries(counts).map(([k, n]) => (
            <span key={k} className="rounded-full bg-red-50 px-2 py-0.5 text-xs text-red-700">
              {ISSUE_LABELS[k] ?? k}: {n}
            </span>
          ))}
        </div>
      )}
      {!report ? (
        <div className="px-2 py-2 text-neutral-400">{status === "loading" ? "Analisi in corso…" : "Nessuna analisi disponibile."}</div>
      ) : issues.length === 0 ? (
        <div className="px-2 py-2 text-emerald-700">Nessun problema rilevato.</div>
      ) : (
        <ul aria-label="Problemi del flusso" className="py-1">
          {issues.map((i, idx) => (
            <li key={`${i.kind}-${i.nodeId}-${i.transitionId}-${idx}`}>
              <Button
                onPress={() => open(i)}
                className="flex w-full items-start gap-1.5 px-2 py-1 text-left text-sm outline-none hover:bg-neutral-50 data-[focus-visible]:ring-1 data-[focus-visible]:ring-inset data-[focus-visible]:ring-sky-500"
              >
                <span aria-hidden="true" className="mt-1 size-2 shrink-0 rounded-full bg-red-500" />
                <span className="min-w-0">{i.message}</span>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function pathLabel(scene: SceneState, p: FlowPath): string {
  const names = p.nodeIds.map((id) => screenName(scene, id)).join(" → ");
  return p.loops ? `${names} ↻` : names;
}

function Paths({ scene, report }: { scene: SceneState; report: FlowReport | undefined }) {
  if (!report) return null;
  return (
    <>
      <SectionTitle aside={`${report.paths.length}${report.pathsTruncated ? "+" : ""}`}>Percorsi</SectionTitle>
      {report.paths.length === 0 ? (
        <div className="px-2 py-2 text-neutral-400">Nessun percorso (serve una schermata d'ingresso con delle uscite).</div>
      ) : (
        <ul aria-label="Percorsi del flusso" className="py-1">
          {report.paths.map((p, idx) => (
            <li key={idx}>
              <Button
                // Un percorso si evidenzia selezionando le sue schermate.
                onPress={() => {
                  const ids = p.nodeIds.filter((id) => scene.nodes.has(id));
                  if (ids.length > 0) useScene.getState().setSelection(ids);
                }}
                className="w-full px-2 py-1 text-left text-sm text-neutral-700 outline-none hover:bg-neutral-50 data-[focus-visible]:ring-1 data-[focus-visible]:ring-inset data-[focus-visible]:ring-sky-500"
              >
                {pathLabel(scene, p)}
              </Button>
            </li>
          ))}
          {report.pathsTruncated && <li className="px-2 py-1 text-xs text-neutral-400">Elenco troncato: ci sono altri percorsi.</li>}
        </ul>
      )}
    </>
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
    <div className="flex h-full flex-col text-sm text-neutral-700">
      <div className="flex items-center justify-between border-b border-neutral-200 px-2 py-1">
        <span className="font-medium text-neutral-500">Flussi</span>
        <Button aria-label="Nuovo flusso" onPress={newFlow} className={BTN}>
          + Nuovo
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {flows.length === 0 ? (
          <div className="px-2 py-3 text-neutral-400">
            Nessun flusso. Crea un flusso, oppure usa «Collega» (K) per unire due schermate: il primo flusso nasce da solo.
          </div>
        ) : (
          <ul aria-label="Flussi" className="py-1">
            {flows.map((f) => (
              <li key={f.id}>
                <Button
                  aria-current={flow?.id === f.id ? "true" : undefined}
                  onPress={() => useFlowUi.getState().setCurrentFlow(f.id)}
                  className={
                    "flex w-full items-center justify-between px-2 py-1 text-left outline-none " +
                    "data-[focus-visible]:ring-1 data-[focus-visible]:ring-inset data-[focus-visible]:ring-sky-500 " +
                    (flow?.id === f.id ? "bg-neutral-800 text-white" : "hover:bg-neutral-50")
                  }
                >
                  <span className="truncate">{f.name}</span>
                  <span className={"ml-2 shrink-0 text-xs " + (flow?.id === f.id ? "text-neutral-300" : "text-neutral-400")}>
                    {Object.values(scene.transitions).filter((t) => t.flowId === f.id).length}
                  </span>
                </Button>
              </li>
            ))}
          </ul>
        )}

        {flow && (
          <>
            <SectionTitle>Flusso corrente</SectionTitle>
            <div className="flex flex-col gap-1 px-2 py-2">
              <Row label="Nome">
                <CommitField
                  label="Nome del flusso"
                  value={flow.name}
                  onCommit={(v) => {
                    const op = renameFlowOp(flow, v);
                    if (op) submit([op]);
                  }}
                />
              </Row>
              <div className="flex items-center gap-1 text-xs text-neutral-500">
                <span className="w-14 shrink-0 text-neutral-400">Inizio</span>
                <span className="min-w-0 flex-1 truncate" data-testid="flow-start">
                  {flow.startId !== "" ? screenName(scene, flow.startId) : "non impostato"}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-1">
                <Button
                  aria-label="Imposta come inizio"
                  isDisabled={!selectedScreen || selectedScreen.id === flow.startId}
                  onPress={() => {
                    const op = selectedScreen ? setStartOp(flow, selectedScreen.id) : null;
                    if (op) submit([op]);
                  }}
                  className={BTN + " border border-neutral-200"}
                >
                  Imposta come inizio
                </Button>
                <Button
                  aria-label="Elimina flusso"
                  onPress={() => {
                    submit([deleteFlowOp(flow.id)]);
                    useFlowUi.getState().setCurrentFlow(null);
                  }}
                  className={BTN + " text-red-600"}
                >
                  Elimina flusso
                </Button>
              </div>
              <label className="flex items-center gap-1.5 text-xs text-neutral-500">
                <input
                  type="checkbox"
                  checked={showAll}
                  onChange={(e) => useFlowUi.getState().setShowAllFlows(e.target.checked)}
                />
                Mostra anche gli altri flussi
              </label>
            </div>
            <Transitions scene={scene} flow={flow} />
            <Issues scene={scene} report={report} />
            <Paths scene={scene} report={report} />
          </>
        )}
      </div>
    </div>
  );
}
