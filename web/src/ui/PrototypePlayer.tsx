import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "react-aria-components";
import { useScene } from "../store/store";
import { resolveFlow, useFlowUi } from "../store/flowUi";
import { worldBoundsOfNode } from "../canvas/transform";
import type { Bounds } from "../canvas/geometry";
import { drawScene, resizeCanvasToDisplaySize } from "../renderer/canvasRenderer";
import { imageCache } from "../renderer/imageCache";
import { sceneForScreen, PROTO_PAGE_ID } from "../flow/protoScene";
import { screenName } from "../flow/screens";
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

  return (
    <div role="dialog" aria-modal="true" aria-label="Prototipo" className="fixed inset-0 z-50 flex flex-col bg-neutral-900 text-sm text-neutral-100">
      <div className="flex items-center gap-2 border-b border-neutral-700 px-3 py-2">
        <Button aria-label="Chiudi il prototipo" onPress={onClose} className="rounded bg-neutral-700 px-3 py-1 outline-none hover:bg-neutral-600 data-[focus-visible]:ring-2 data-[focus-visible]:ring-sky-400">
          Esci (Esc)
        </Button>
        <Button
          aria-label="Indietro"
          isDisabled={!state || !canGoBack(state)}
          onPress={() => state && setState(back(state))}
          className="rounded px-3 py-1 outline-none hover:bg-neutral-700 data-[disabled]:opacity-40 data-[focus-visible]:ring-2 data-[focus-visible]:ring-sky-400"
        >
          ← Indietro
        </Button>
        <Button
          aria-label="Ricomincia"
          onPress={() => setState(startState(scene, flow, pageId))}
          className="rounded px-3 py-1 outline-none hover:bg-neutral-700 data-[focus-visible]:ring-2 data-[focus-visible]:ring-sky-400"
        >
          ↺ Ricomincia
        </Button>
        {state && (
          <nav aria-label="Percorso" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-2 text-neutral-400">
            {trail(state).map((id, i, all) => {
              const last = i === all.length - 1;
              return (
                <span key={i} className="flex shrink-0 items-center gap-1">
                  {i > 0 && <span aria-hidden="true">›</span>}
                  {last ? (
                    <span aria-current="step" className="font-medium text-white">{screenName(scene, id)}</span>
                  ) : (
                    <Button onPress={() => setState(backTo(state, i))} className="rounded px-1 outline-none hover:text-white data-[focus-visible]:ring-1 data-[focus-visible]:ring-sky-400">
                      {screenName(scene, id)}
                    </Button>
                  )}
                </span>
              );
            })}
          </nav>
        )}
        <Button
          aria-label="Variabili"
          aria-pressed={showVars}
          onPress={() => setShowVars((v) => !v)}
          className={"rounded px-3 py-1 outline-none hover:bg-neutral-700 data-[focus-visible]:ring-2 data-[focus-visible]:ring-sky-400 " + (showVars ? "bg-neutral-700" : "")}
        >
          Variabili{state && Object.keys(state.vars).length > 0 ? ` (${Object.keys(state.vars).length})` : ""}
        </Button>
      </div>

      <div className="relative min-h-0 flex-1">
        <div ref={stage} className="absolute inset-0">
          {state && derived ? (
            <>
              <canvas ref={canvas} aria-label={`Schermata ${screenName(scene, state.screenId)}`} className="absolute inset-0 block h-full w-full" />
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
                        "absolute rounded-sm outline-none " +
                        (o.enabled
                          ? "cursor-pointer border border-dashed border-violet-400/70 bg-violet-400/10 hover:bg-violet-400/30 focus-visible:ring-2 focus-visible:ring-sky-400"
                          : "cursor-not-allowed border border-dashed border-red-400/60 bg-red-400/10")
                      }
                    />
                  );
                })}
            </>
          ) : (
            <div className="flex h-full items-center justify-center text-neutral-400">
              Nessuna schermata da presentare: aggiungi un frame di primo livello o imposta l'inizio del flusso.
            </div>
          )}
        </div>
        {showVars && state && (
          <aside aria-label="Variabili del prototipo" className="absolute right-3 top-3 w-56 rounded border border-neutral-700 bg-neutral-800/95 p-2 text-xs shadow-lg">
            {varEntries(state.vars).length === 0 ? (
              <div className="text-neutral-400">Nessuna variabile impostata.</div>
            ) : (
              <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
                {varEntries(state.vars).map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-neutral-400">{k}</dt>
                    <dd className="truncate font-mono">{v}</dd>
                  </div>
                ))}
              </dl>
            )}
          </aside>
        )}
      </div>

      <div className="flex min-h-12 flex-wrap items-start gap-2 border-t border-neutral-700 px-3 py-2" role="group" aria-label="Azioni della schermata">
        {state && bar.length === 0 && hotspots.length === 0 && (
          <span className="py-1 text-neutral-400">Fine del percorso: nessuna uscita da questa schermata.</span>
        )}
        {bar.map((o) => (
          <div key={o.transition.id} className="flex flex-col">
            <Button
              isDisabled={!o.enabled}
              onPress={() => go(o)}
              className="rounded bg-violet-600 px-3 py-1 outline-none hover:bg-violet-500 data-[disabled]:cursor-not-allowed data-[disabled]:bg-neutral-700 data-[disabled]:text-neutral-400 data-[focus-visible]:ring-2 data-[focus-visible]:ring-sky-400"
            >
              {optionLabel(scene, o)}
            </Button>
            {!o.enabled && o.reason && <span className="mt-0.5 max-w-64 text-xs text-red-300">{o.reason}</span>}
          </div>
        ))}
        {hotspots.some((h) => !h.o.enabled) && (
          <span className="py-1 text-xs text-red-300">
            {hotspots.filter((h) => !h.o.enabled).map((h) => `${optionLabel(scene, h.o)}: ${h.o.reason}`).join(" · ")}
          </span>
        )}
      </div>
    </div>
  );
}
