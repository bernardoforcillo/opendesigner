import { useEffect, useMemo, useRef, useState } from "react";
import { Button as RacButton } from "react-aria-components";
import { useScene } from "../store/store";
import { resolveFlow, useFlowUi } from "../store/flowUi";
import { worldBoundsOfNode } from "../canvas/transform";
import type { Bounds } from "../canvas/geometry";
import { drawScene, resizeCanvasToDisplaySize } from "../renderer/canvasRenderer";
import { imageCache } from "../renderer/imageCache";
import { sceneForScreen, PROTO_PAGE_ID } from "../flow/protoScene";
import { screenName } from "../flow/screens";
import { Badge, Icon, IconButton } from "./ds";
import { AnyIcon, FlowIconButton } from "./ds/flow-parts";
import "./ds/flow-stage.css";
import {
  back, backTo, canGoBack, follow, optionsFrom, startState, trail, varEntries,
  type Option, type ProtoState,
} from "../flow/prototype";

// IL PROTOTIPO GIOCABILE ("Presenta"). Un overlay a tutto schermo che mostra la
// schermata corrente del flusso -- il frame vero del documento, disegnato dal
// renderer di sempre, senza chrome dell'editor -- e la rende navigabile:
//  - una transizione con `elementId` è una REGIONE CLICCABILE sopra quell'elemento;
//  - le altre stanno nella barra in basso, come pulsanti;
//  - una transizione la cui guardia non è soddisfatta (o non è valutabile) resta
//    visibile ma disabilitata, col PERCHÉ.
// La logica (stato, guardie, effetti) è in flow/prototype.ts; qui c'è solo la vista.

const PAD = 48; // margine attorno alla schermata, px
// Lo spazio in basso riservato al gruppo flottante (azioni + barra di controllo):
// la schermata si centra nell'area SOPRA, così i comandi non la coprono. Costante
// (non dipende dalle uscite della schermata) per non far "saltare" lo zoom a ogni passo.
const DOCK_RESERVE = 124;
// Quanto resta visibile l'impulso degli hotspot dopo l'ingresso in una schermata.
const HINT_MS = 4200;
// Il bordo (px) della cornice che fa da "telaio" del dispositivo, e il raggio.
const BEZEL = 8;
const BEZEL_RADIUS = 22;
const MAX_ZOOM = 2;

function fitCamera(b: Bounds, w: number, h: number) {
  const zoom = Math.min(MAX_ZOOM, Math.max(0.05, Math.min((w - PAD * 2) / Math.max(1, b.width), (h - PAD * 2) / Math.max(1, b.height))));
  return { zoom, x: w / 2 - (b.x + b.width / 2) * zoom, y: h / 2 - (b.y + b.height / 2) * zoom };
}

function optionLabel(scene: Parameters<typeof screenName>[0], o: Option): string {
  const t = o.transition;
  return t.label.trim() !== "" ? t.label : `Vai a ${screenName(scene, t.toId)}`;
}

export function PrototypePlayer({ onClose }: { onClose: () => void }) {
  const scene = useScene((s) => s.scene);
  const pageId = useScene((s) => s.currentPageId);
  const currentFlowId = useFlowUi((s) => s.currentFlowId);
  const flow = resolveFlow(scene, currentFlowId);
  const [state, setState] = useState<ProtoState | null>(() => (scene ? startState(scene, flow, pageId) : null));
  const [showVars, setShowVars] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  // Si ridisegna anche quando arriva un'immagine.
  const [imgTick, setImgTick] = useState(0);
  // L'impulso degli hotspot: si accende a ogni nuova schermata e svanisce da solo.
  const [hint, setHint] = useState(true);
  useEffect(() => {
    setHint(true);
    const t = setTimeout(() => setHint(false), HINT_MS);
    return () => clearTimeout(t);
  }, [state?.screenId]);

  // Esc chiude. In cattura e fermando la propagazione: nessun altro ascoltatore
  // globale (toolManager, selectTool) deve reagire a un Esc che è del prototipo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // La misura dell'area: ResizeObserver dove c'è (non in jsdom).
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const read = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => imageCache.subscribe(() => setImgTick((n) => n + 1)), []);

  const derived = useMemo(() => (scene && state ? sceneForScreen(scene, state.screenId) : null), [scene, state?.screenId]);
  const screenBox = useMemo(() => {
    const n = scene && state ? scene.nodes.at(state.screenId) : undefined;
    return scene && n ? worldBoundsOfNode(scene, n) : null;
  }, [scene, state?.screenId]);
  const cam = useMemo(() => (screenBox && size.w > 0 ? fitCamera(screenBox, size.w, size.h) : null), [screenBox, size]);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !derived || !cam) return;
    resizeCanvasToDisplaySize(c);
    const ctx = c.getContext("2d");
    if (ctx) drawScene(ctx, derived, cam, PROTO_PAGE_ID);
  }, [derived, cam, size, imgTick]);

  if (!scene) return null;
  const options = flow && state ? optionsFrom(scene, flow.id, state) : [];
  // Un hotspot esiste solo se l'elemento ha davvero un box nella schermata.
  const hotspots: { o: Option; box: Bounds }[] = [];
  const bar: Option[] = [];
  for (const o of options) {
    const el = o.transition.elementId !== "" ? scene.nodes.at(o.transition.elementId) : undefined;
    if (el && cam) hotspots.push({ o, box: worldBoundsOfNode(scene, el) });
    else bar.push(o);
  }
  const go = (o: Option) => {
    if (!state || !o.enabled) return;
    setState(follow(scene, state, o.transition));
  };


  const flowName = flow?.name ?? "";
  const disabledAll = hotspots.filter((h) => !h.o.enabled);
  // Il telaio e il ritaglio del canvas, in px dell'area: il canvas copre tutta
  // l'area ma si MOSTRA solo dentro la schermata, con gli angoli del dispositivo.
  const frame = cam && screenBox
    ? {
        x: screenBox.x * cam.zoom + cam.x,
        y: screenBox.y * cam.zoom + cam.y,
        w: screenBox.width * cam.zoom,
        h: screenBox.height * cam.zoom,
      }
    : null;
  const radius = BEZEL_RADIUS - BEZEL;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Prototipo"
      className="od-island-dark fixed inset-0 z-50 overflow-hidden bg-[radial-gradient(ellipse_at_50%_38%,var(--surface-2),var(--canvas)_72%)] text-[13px] text-fg"
    >
      {/* Il palcoscenico: la schermata al centro dell'area sopra al dock. */}
      <div ref={stage} className="absolute inset-x-0 top-0" style={{ bottom: DOCK_RESERVE }}>
        {state && derived ? (
          <>
            {frame && (
              <div
                aria-hidden="true"
                className="absolute bg-surface shadow-[0_40px_90px_-30px_rgba(0,0,0,0.85),0_0_0_1px_var(--line-strong)]"
                style={{
                  left: frame.x - BEZEL, top: frame.y - BEZEL, width: frame.w + BEZEL * 2, height: frame.h + BEZEL * 2,
                  borderRadius: BEZEL_RADIUS,
                }}
              />
            )}
            <canvas
              ref={canvas}
              aria-label={`Schermata ${screenName(scene, state.screenId)}`}
              className="absolute inset-0 block h-full w-full"
              style={
                frame
                  ? {
                      clipPath: `inset(${frame.y}px ${size.w - frame.x - frame.w}px ${size.h - frame.y - frame.h}px ${frame.x}px round ${radius}px)`,
                    }
                  : undefined
              }
            />
            {cam &&
              hotspots.map(({ o, box }) => {
                const x = box.x * cam.zoom + cam.x;
                const y = box.y * cam.zoom + cam.y;
                return (
                  <button
                    key={o.transition.id}
                    type="button"
                    aria-label={optionLabel(scene, o)}
                    aria-disabled={!o.enabled}
                    title={o.enabled ? optionLabel(scene, o) : o.reason}
                    onClick={() => go(o)}
                    style={{ left: x, top: y, width: box.width * cam.zoom, height: box.height * cam.zoom }}
                    className={
                      "absolute rounded-md border-2 outline-none transition-[background-color,border-color] duration-500 " +
                      "focus-visible:shadow-[var(--ring)] " +
                      (o.enabled
                        ? "cursor-pointer hover:border-flow hover:bg-flow/25 hover:duration-150 " +
                          (hint ? "border-flow/80 bg-flow/10" : "border-transparent bg-transparent")
                        : "cursor-not-allowed border-dashed border-danger/60 bg-danger/10")
                    }
                  >
                    {/* L'anello d'impulso: solo finché dura il suggerimento. */}
                    {o.enabled && hint && (
                      <span aria-hidden="true" className="od-pulse pointer-events-none absolute -inset-1 rounded-lg border-2 border-flow" />
                    )}
                  </button>
                );
              })}
          </>
        ) : (
          <div className="flex h-full items-center justify-center px-8 text-center text-fg-muted">
            Nessuna schermata da presentare: aggiungi un frame di primo livello o imposta l'inizio del flusso.
          </div>
        )}
      </div>

      {/* In alto: dove sei (a sinistra) e l'uscita (a destra). */}
      <div className="pointer-events-none absolute inset-x-4 top-4 flex items-start justify-between">
        <div className="pointer-events-auto flex h-8 items-center gap-2 rounded-full bg-raised pl-2.5 pr-3 shadow-bar">
          <Icon name="play" size={12} className="text-flow" />
          <span className="text-[12px] font-semibold text-fg">Presenta</span>
          {flowName !== "" && <span className="max-w-[200px] truncate text-[12px] text-fg-muted">{flowName}</span>}
        </div>
        <div className="pointer-events-auto rounded-full bg-raised p-1 shadow-bar">
          <IconButton icon="x" label="Chiudi il prototipo" shortcut="Esc" onPress={onClose} className="rounded-full" />
        </div>
      </div>

      {/* In basso: le uscite della schermata e la barra di controllo. */}
      <div className="pointer-events-none absolute inset-x-4 bottom-4 flex flex-col items-center gap-3">
        <div
          role="group"
          aria-label="Azioni della schermata"
          className="pointer-events-auto flex max-w-[min(720px,100%)] flex-wrap items-start justify-center gap-2"
        >
          {state && bar.length === 0 && hotspots.length === 0 && (
            <span className="od-rise rounded-full bg-raised px-3 py-1.5 text-[12px] text-fg-muted shadow-bar">
              Fine del percorso: nessuna uscita da questa schermata.
            </span>
          )}
          {bar.map((o) => (
            <div key={`${state?.screenId}-${o.transition.id}`} className="od-rise flex flex-col items-center gap-1">
              <RacButton
                isDisabled={!o.enabled}
                onPress={() => go(o)}
                className={
                  "inline-flex h-9 items-center gap-1.5 rounded-full px-4 text-[13px] font-medium outline-none transition-colors " +
                  "data-[focus-visible]:shadow-[var(--ring)] " +
                  "bg-flow text-canvas shadow-bar hover:brightness-110 " +
                  "data-[disabled]:cursor-not-allowed data-[disabled]:bg-surface-3 data-[disabled]:text-fg-subtle data-[disabled]:shadow-none data-[disabled]:hover:brightness-100"
                }
              >
                {optionLabel(scene, o)}
                <AnyIcon name={o.enabled ? "arrowRight" : "lock"} size={14} />
              </RacButton>
              {!o.enabled && o.reason && (
                <span className="max-w-64 rounded-md bg-warn-soft px-2 py-0.5 text-center text-[11px] font-medium text-warn">{o.reason}</span>
              )}
            </div>
          ))}
          {disabledAll.length > 0 && (
            <span className="od-rise inline-flex items-center gap-1.5 rounded-md bg-warn-soft px-2 py-1 text-[11px] font-medium text-warn">
              <Icon name="lock" size={12} className="shrink-0" />
              <span>{disabledAll.map((h) => `${optionLabel(scene, h.o)}: ${h.o.reason}`).join(" · ")}</span>
            </span>
          )}
        </div>

        <div className="pointer-events-auto relative flex h-11 max-w-full items-center gap-1 rounded-2xl bg-raised px-1.5 shadow-bar">
          <FlowIconButton
            icon="arrowLeft"
            label="Indietro"
            isDisabled={!state || !canGoBack(state)}
            onPress={() => state && setState(back(state))}
          />
          <FlowIconButton icon="restart" label="Ricomincia" onPress={() => setState(startState(scene, flow, pageId))} />
          {state && (
            <nav
              aria-label="Percorso"
              className="mx-1 flex min-w-0 max-w-[46vw] items-center gap-0.5 overflow-x-auto border-x border-line px-2 text-[12px] text-fg-subtle"
            >
              {trail(state).map((id, i, all) => {
                const last = i === all.length - 1;
                return (
                  <span key={i} className="flex shrink-0 items-center gap-0.5">
                    {i > 0 && <span aria-hidden="true">›</span>}
                    {last ? (
                      <span aria-current="step" className="rounded-full bg-flow-soft px-2 py-0.5 font-semibold text-flow">{screenName(scene, id)}</span>
                    ) : (
                      <RacButton
                        onPress={() => setState(backTo(state, i))}
                        className="rounded-full px-2 py-0.5 text-fg-muted outline-none hover:bg-surface-3 hover:text-fg data-[focus-visible]:shadow-[var(--ring)]"
                      >
                        {screenName(scene, id)}
                      </RacButton>
                    )}
                  </span>
                );
              })}
            </nav>
          )}
          <FlowIconButton icon="braces" label="Variabili" selected={showVars} onPress={() => setShowVars((v) => !v)}>
            {state && Object.keys(state.vars).length > 0 && (
              <Badge tone="flow" className="pointer-events-none absolute -right-1 -top-1 h-4 min-w-4 justify-center px-1 text-[10px]">
                {Object.keys(state.vars).length}
              </Badge>
            )}
          </FlowIconButton>

          {showVars && state && (
            <aside
              aria-label="Variabili del prototipo"
              className="od-rise absolute bottom-0 left-full ml-2 w-60 rounded-xl bg-raised p-3 text-[12px] shadow-pop"
            >
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-fg-subtle">Variabili</h3>
              {varEntries(state.vars).length === 0 ? (
                <div className="text-fg-subtle">Nessuna variabile impostata.</div>
              ) : (
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                  {varEntries(state.vars).map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="text-fg-muted">{k}</dt>
                      <dd className="truncate rounded bg-surface-2 px-1.5 font-mono text-fg">{v}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}
