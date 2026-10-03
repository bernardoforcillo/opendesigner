import { useEffect, useRef, useState } from "react";
import { Button as RacButton } from "react-aria-components";
import { EmptyState, Icon } from "../ds";
import { AnimIconButton, AnyAnimIcon, nodeKindIcon } from "../ds/anim-parts";
import { useScene } from "../../store/store";
import type { ClipLite } from "../../store/types";
import { commitClip, useTimeline } from "../../animation/timelineStore";
import {
  PROP_LABEL, SNAP_MS, addKeyframe, dragDelta, formatTime, moveKeyframes, removeTrack,
  rulerTicks, sameKey, snapTime, valueAt, type KeyRef,
} from "../../animation/timelineLogic";

// L'AREA DELLE TRACCE: il righello, una riga per traccia con i suoi keyframe e il
// playhead. Tutto ciò che si trascina lavora su una BOZZA nello store di vista
// (`draftClip`: la tela la campiona dal vivo) e scrive UN `SetClip` al rilascio.

export const LABEL_W = 208;
const PAD = 16;
/** Margine a destra: l'etichetta dell'ultima tacca (centrata sulla tacca) non deve uscire dalla corsia. */
const END_PAD = 28;
const ROW_H = 30;
const RULER_H = 26;
/** Soglia di trascinamento (px) sotto la quale un press su un keyframe è un click. */
const DRAG_SLOP_PX = 3;
/** Raggio (px) dell'aggancio ai keyframe vicini. */
const SNAP_PX = 6;

interface KfDrag {
  pointerId: number;
  startX: number;
  base: ClipLite;
  sel: KeyRef[];
  primary: KeyRef;
  moved: boolean;
  /** Il press era dentro una selezione multipla: senza trascinare, la riduce al solo keyframe. */
  collapse: boolean;
  result: { clip: ClipLite; sel: KeyRef[] } | null;
}

export function TrackArea({ clip }: { clip: ClipLite }) {
  const scene = useScene((s) => s.scene);
  const nodeSelection = useScene((s) => s.selection);
  const playhead = useTimeline((s) => s.playhead);
  const zoom = useTimeline((s) => s.zoom);
  const selection = useTimeline((s) => s.selection);
  const scroller = useRef<HTMLDivElement>(null);
  const [viewW, setViewW] = useState(0);
  const kfDrag = useRef<KfDrag | null>(null);
  const scrubbing = useRef<number | null>(null);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const read = () => setViewW(el.clientWidth);
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const laneViewW = Math.max(240, (viewW || 720) - LABEL_W);
  const ppm = ((laneViewW - PAD - END_PAD) / clip.duration) * zoom;
  const innerW = PAD + END_PAD + clip.duration * ppm;
  const xOf = (t: number) => PAD + t * ppm;
  const tAt = (clientX: number, laneLeft: number) => (clientX - laneLeft - PAD) / ppm;

  // Ctrl + rotella: zoom orizzontale della timeline. Listener nativo non passivo:
  // quello di React non può annullare lo zoom della pagina.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const st = useTimeline.getState();
      st.setZoom(st.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const tl = () => useTimeline.getState();

  // --- scorrimento (righello e spazio vuoto delle righe) -------------------------
  const scrubTo = (e: React.PointerEvent, laneLeft: number) => {
    const t = snapTime(tAt(e.clientX, laneLeft), clip.duration, [], { free: e.shiftKey });
    tl().setPlayhead(t);
  };
  const scrubDown = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    scrubbing.current = e.pointerId;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* niente capture (jsdom) */ }
    scrubTo(e, e.currentTarget.getBoundingClientRect().left);
  };
  const scrubMove = (e: React.PointerEvent<HTMLElement>) => {
    if (scrubbing.current !== e.pointerId) return;
    scrubTo(e, e.currentTarget.getBoundingClientRect().left);
  };
  const scrubUp = (e: React.PointerEvent<HTMLElement>) => {
    if (scrubbing.current !== e.pointerId) return;
    scrubbing.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* già rilasciato */ }
  };

  // --- keyframe ---------------------------------------------------------------------
  const kfDown = (e: React.PointerEvent<HTMLElement>, ref: KeyRef) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const st = tl();
    const inSel = st.selection.some((r) => sameKey(r, ref));
    const mod = e.ctrlKey || e.metaKey;
    const sel = mod
      ? inSel ? st.selection.filter((r) => !sameKey(r, ref)) : [...st.selection, ref]
      : inSel ? st.selection : [ref];
    st.select(sel);
    if (mod && inSel) return; // tolto dalla selezione: niente trascinamento
    kfDrag.current = { pointerId: e.pointerId, startX: e.clientX, base: clip, sel, primary: ref, moved: false, collapse: !mod && inSel && sel.length > 1, result: null };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* niente capture (jsdom) */ }
  };
  const kfMove = (e: React.PointerEvent<HTMLElement>) => {
    const d = kfDrag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dx = e.clientX - d.startX;
    if (!d.moved && Math.abs(dx) < DRAG_SLOP_PX) return;
    d.moved = true;
    // L'aggancio: griglia da 10 ms, altri keyframe e playhead entro SNAP_PX; Maiusc = libero.
    const delta = dragDelta(d.base, d.sel, d.primary, dx / ppm, { free: e.shiftKey, thresholdMs: SNAP_PX / ppm, extra: [tl().playhead] });
    d.result = moveKeyframes(d.base, d.sel, delta);
    tl().setDraftClip(d.result.clip);
  };
  const kfUp = (e: React.PointerEvent<HTMLElement>) => {
    const d = kfDrag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    kfDrag.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* già rilasciato */ }
    const st = tl();
    if (d.moved && d.result) {
      // UN op per tutto il trascinamento.
      commitClip(d.result.clip);
      st.select(d.result.sel);
      st.setDraftClip(null);
      return;
    }
    if (d.collapse) st.select([d.primary]);
    const k = d.base.tracks[d.primary.track]?.keyframes[d.primary.key];
    if (k) st.setPlayhead(k.time);
  };
  const kfCancel = () => {
    kfDrag.current = null;
    tl().setDraftClip(null);
  };

  const addAt = (ti: number, t: number) => {
    const v = valueAt(clip, ti, t);
    if (v === undefined) return;
    const r = addKeyframe(clip, ti, t, v);
    commitClip(r.clip);
    tl().select([r.ref]);
  };

  const ticks = rulerTicks(ppm, 0, clip.duration);

  return (
    <div
      ref={scroller}
      className="relative min-h-0 min-w-0 flex-1 overflow-auto outline-none"
      onPointerDown={(e) => {
        // Cliccare nel vuoto toglie la selezione dei keyframe.
        if (e.target === e.currentTarget) tl().select([]);
      }}
    >
      <div className="relative" style={{ width: LABEL_W + innerW, minHeight: "100%" }}>
        {/* IL RIGHELLO: tacche auto-scalate con lo zoom; trascinarlo scorre il playhead. */}
        <div className="sticky top-0 z-20 flex border-b border-line bg-surface" style={{ height: RULER_H }}>
          <div className="sticky left-0 z-30 flex shrink-0 items-center border-r border-line bg-surface px-3 text-[11px] text-fg-subtle" style={{ width: LABEL_W }}>
            <span className="tabular-nums">{formatTime(clip.duration)}</span>
            <span className="ml-auto flex items-center gap-0.5">
              <AnimIconButton icon="zoomOut" label="Riduci lo zoom" size={22} onPress={() => tl().setZoom(zoom / 1.5)} />
              <AnimIconButton icon="fit" label="Adatta alla clip" size={22} onPress={() => tl().setZoom(1)} />
              <AnimIconButton icon="zoomIn" label="Aumenta lo zoom" size={22} onPress={() => tl().setZoom(zoom * 1.5)} />
            </span>
          </div>
          <div
            role="slider"
            aria-label="Playhead"
            aria-valuemin={0}
            aria-valuemax={clip.duration}
            aria-valuenow={Math.round(playhead)}
            aria-valuetext={formatTime(playhead)}
            tabIndex={0}
            className="relative cursor-col-resize touch-none select-none outline-none focus-visible:shadow-[var(--ring)]"
            style={{ width: innerW }}
            onPointerDown={scrubDown}
            onPointerMove={scrubMove}
            onPointerUp={scrubUp}
            onPointerCancel={scrubUp}
            onKeyDown={(e) => {
              const step = e.shiftKey ? 100 : SNAP_MS;
              if (e.key === "ArrowRight") { e.preventDefault(); tl().setPlayhead(snapTime(playhead + step, clip.duration, [], { free: true })); }
              else if (e.key === "ArrowLeft") { e.preventDefault(); tl().setPlayhead(snapTime(playhead - step, clip.duration, [], { free: true })); }
            }}
          >
            {ticks.map((t) => (
              <span key={t.t} className="pointer-events-none absolute bottom-0" style={{ left: xOf(t.t) }}>
                <span className={`absolute bottom-0 w-px ${t.major ? "h-2.5 bg-fg-subtle" : "h-1.5 bg-line-strong"}`} />
                {t.major && (
                  <span className="absolute bottom-2.5 -translate-x-1/2 whitespace-nowrap text-[10px] tabular-nums text-fg-subtle">
                    {formatTime(t.t)}
                  </span>
                )}
              </span>
            ))}
          </div>
        </div>

        {/* LE TRACCE */}
        {clip.tracks.length === 0 ? (
          <div className="sticky left-0" style={{ width: viewW || undefined }}>
            <EmptyState
              icon="sparkle"
              title="Anima qualcosa: seleziona un livello e premi + Proprietà"
              hint="Oppure parti da un preset: Fade in, Slide up, Pop, Spin, Pulse, Draw."
            />
          </div>
        ) : (
          clip.tracks.map((tr, ti) => {
            const node = scene?.nodes.get(tr.nodeId);
            const nodeSelected = nodeSelection.includes(tr.nodeId);
            const kf = tr.keyframes;
            return (
              <div key={`${tr.nodeId}|${tr.prop}`} className="flex border-b border-line/70" style={{ height: ROW_H }}>
                <div
                  className={`sticky left-0 z-10 flex shrink-0 items-center gap-1.5 border-r border-line bg-surface pl-3 pr-1 ${nodeSelected ? "bg-accent-soft" : ""}`}
                  style={{ width: LABEL_W }}
                >
                  <RacButton
                    aria-label={`Seleziona ${node?.name ?? tr.nodeId}`}
                    onPress={() => node && useScene.getState().setSelection([tr.nodeId])}
                    className="flex min-w-0 flex-1 items-center gap-1.5 rounded text-left text-[12px] outline-none data-[focus-visible]:shadow-[var(--ring)]"
                  >
                    <span className="shrink-0 text-fg-subtle"><AnyAnimIcon name={nodeKindIcon(node)} size={13} /></span>
                    <span className={`truncate font-medium ${nodeSelected ? "text-accent" : "text-fg"}`}>
                      {node ? (node.name.trim() !== "" ? node.name : node.kind) : "(eliminato)"}
                    </span>
                    <span className="shrink-0 text-fg-subtle">{PROP_LABEL[tr.prop] ?? tr.prop}</span>
                  </RacButton>
                  <AnimIconButton
                    icon="diamondPlus"
                    label={`Aggiungi un keyframe al playhead su ${PROP_LABEL[tr.prop] ?? tr.prop}`}
                    size={22}
                    onPress={() => addAt(ti, Math.round(playhead))}
                  />
                  <AnimIconButton
                    icon="x"
                    label={`Rimuovi la traccia ${PROP_LABEL[tr.prop] ?? tr.prop}`}
                    size={22}
                    onPress={() => {
                      commitClip(removeTrack(clip, ti));
                      tl().select([]);
                    }}
                  />
                </div>
                <div
                  role="group"
                  aria-label={`Traccia ${PROP_LABEL[tr.prop] ?? tr.prop} di ${node?.name ?? tr.nodeId}`}
                  className="relative shrink-0 cursor-col-resize touch-none"
                  style={{ width: innerW }}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    if (!e.shiftKey) tl().select([]);
                    scrubDown(e);
                  }}
                  onPointerMove={scrubMove}
                  onPointerUp={scrubUp}
                  onPointerCancel={scrubUp}
                  onDoubleClick={(e) => addAt(ti, snapTime(tAt(e.clientX, e.currentTarget.getBoundingClientRect().left), clip.duration, kf.map((k) => k.time), { free: e.shiftKey }))}
                >
                  {/* i segmenti fra un keyframe e il successivo */}
                  {kf.slice(0, -1).map((k, i) => (
                    <span
                      key={`seg${i}`}
                      aria-hidden="true"
                      className="pointer-events-none absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-accent/25"
                      style={{ left: xOf(k.time), width: Math.max(0, (kf[i + 1].time - k.time) * ppm) }}
                    />
                  ))}
                  {kf.map((k, ki) => {
                    const ref: KeyRef = { track: ti, key: ki };
                    const sel = selection.some((r) => sameKey(r, ref));
                    return (
                      <button
                        key={ki}
                        type="button"
                        aria-label={`Keyframe a ${formatTime(k.time)}, valore ${Math.round(k.value * 1000) / 1000}`}
                        aria-pressed={sel}
                        className="group absolute top-1/2 flex h-4 w-4 -translate-x-1/2 -translate-y-1/2 cursor-grab items-center justify-center outline-none active:cursor-grabbing"
                        style={{ left: xOf(k.time) }}
                        onPointerDown={(e) => kfDown(e, ref)}
                        onPointerMove={kfMove}
                        onPointerUp={kfUp}
                        onPointerCancel={kfCancel}
                        onDoubleClick={(e) => e.stopPropagation()}
                      >
                        <span
                          className={
                            "block h-2.5 w-2.5 rotate-45 rounded-[2px] border-2 transition-colors group-focus-visible:shadow-[var(--ring)] " +
                            (sel
                              ? "border-accent bg-accent"
                              : "border-fg-muted bg-raised group-hover:border-accent")
                          }
                        />
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })
        )}

        {/* IL PLAYHEAD: una linea su tutte le righe e la testina sul righello. */}
        <div className="pointer-events-none absolute bottom-0 top-0 z-10" style={{ left: LABEL_W + xOf(playhead), width: 0 }}>
          <span className="absolute top-0 h-full w-px -translate-x-1/2 bg-accent" />
          <span className="absolute -translate-x-1/2 text-accent" style={{ top: RULER_H - 11 }}>
            <Icon name="chevronDown" size={12} />
          </span>
        </div>
      </div>
    </div>
  );
}
