import { useRef } from "react";
import { Button, EmptyState } from "../ds";
import { AnimIcon, AnimIconButton } from "../ds/anim-parts";
import { useScene } from "../../store/store";
import type { ClipLite } from "../../store/types";
import {
  MAX_HEIGHT, MIN_HEIGHT, commitClip, createClip, useTimeline,
} from "../../animation/timelineStore";
import { deleteKeyframes, duplicateKeyframes, moveKeyframes, SNAP_MS } from "../../animation/timelineLogic";
import { isTextField } from "../../tools/toolManager";
import { ClipList } from "./ClipList";
import { KeyframeInspector } from "./KeyframeInspector";
import { TrackArea } from "./TrackArea";
import { Transport } from "./Transport";

// IL PANNELLO TIMELINE, sotto la tela (Design). Il guscio non costa niente da
// chiuso: non monta il corpo, quindi non campiona, non ascolta e non ridisegna.
export function TimelinePanel() {
  const open = useTimeline((s) => s.open);
  return open ? <TimelineBody /> : null;
}

function TimelineBody() {
  const scene = useScene((s) => s.scene);
  const height = useTimeline((s) => s.height);
  const collapsed = useTimeline((s) => s.collapsed);
  const clipId = useTimeline((s) => s.clipId);
  const draftClip = useTimeline((s) => s.draftClip);
  const selection = useTimeline((s) => s.selection);
  const record = useTimeline((s) => s.record);
  const root = useRef<HTMLElement>(null);

  // La clip che si sta guardando: la bozza di un trascinamento, se c'è, altrimenti quella del documento.
  const docClip: ClipLite | null = scene && clipId ? scene.clips[clipId] ?? null : null;
  const clip = draftClip && docClip && draftClip.id === docClip.id ? draftClip : docClip;

  // TASTIERA, solo col fuoco dentro la timeline (il pannello non è la tela: lo
  // spazio qui è play/pausa, fuori resta il pan). Canc/Backspace non devono MAI
  // arrivare ai listener globali del canvas, che cancellerebbero i livelli
  // selezionati: dentro la timeline cancellano i keyframe selezionati e basta.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (isTextField(e.target)) return;
    const st = useTimeline.getState();
    const mod = e.ctrlKey || e.metaKey;
    const swallow = () => { e.preventDefault(); e.stopPropagation(); };
    if (e.code === "Space" && !mod) {
      swallow();
      st.togglePlay();
    } else if (e.key === "Delete" || e.key === "Backspace") {
      swallow();
      if (docClip && st.selection.length > 0) {
        commitClip(deleteKeyframes(docClip, st.selection));
        st.select([]);
      }
    } else if (mod && e.key.toLowerCase() === "d" && docClip && st.selection.length > 0) {
      swallow();
      const r = duplicateKeyframes(docClip, st.selection, st.playhead);
      commitClip(r.clip);
      st.select(r.sel);
    } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && docClip && st.selection.length > 0 && (e.target as HTMLElement).getAttribute?.("aria-label")?.startsWith("Keyframe")) {
      // Frecce su un keyframe: lo spostano di un passo di griglia (Maiusc: dieci).
      swallow();
      const d = (e.key === "ArrowRight" ? 1 : -1) * SNAP_MS * (e.shiftKey ? 10 : 1);
      const r = moveKeyframes(docClip, st.selection, d);
      commitClip(r.clip);
      st.select(r.sel);
    } else if (e.key === "Home") {
      swallow();
      st.setPlayhead(0);
    } else if (e.key === "End" && docClip) {
      swallow();
      st.setPlayhead(docClip.duration);
    } else if (e.key === "Escape" && st.selection.length > 0) {
      swallow();
      st.select([]);
    }
  };

  // Il bordo superiore ridimensiona l'altezza (trascinando o con le frecce).
  const resize = useRef<{ y: number; h: number } | null>(null);

  return (
    <section
      ref={root}
      aria-label="Timeline"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      // Un click in un punto neutro del pannello gli dà il fuoco: così lo spazio
      // vale come play/pausa senza dover prima toccare un pulsante.
      onPointerDownCapture={(e) => {
        const t = e.target as HTMLElement;
        if (!isTextField(t) && t.closest("button,select,input,[role=slider],[role=menu]") === null) root.current?.focus({ preventScroll: true });
      }}
      className={`relative flex shrink-0 flex-col border-t ${record ? "border-danger" : "border-line"} bg-surface text-fg outline-none`}
      style={{ height: collapsed ? undefined : height }}
    >
      {!collapsed && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Altezza della timeline"
          aria-valuemin={MIN_HEIGHT}
          aria-valuemax={MAX_HEIGHT}
          aria-valuenow={height}
          tabIndex={0}
          className="absolute -top-1 left-0 right-0 z-30 h-2 cursor-row-resize touch-none outline-none hover:bg-accent/30 focus-visible:bg-accent/40"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            resize.current = { y: e.clientY, h: height };
            try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* niente capture (jsdom) */ }
          }}
          onPointerMove={(e) => {
            const r = resize.current;
            if (r) useTimeline.getState().setHeight(r.h + (r.y - e.clientY));
          }}
          onPointerUp={() => { resize.current = null; }}
          onPointerCancel={() => { resize.current = null; }}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              e.stopPropagation();
              useTimeline.getState().setHeight(height + (e.key === "ArrowUp" ? 24 : -24));
            }
          }}
        />
      )}

      {/* Ridotta: resta la sola testata, per riaprirla o chiuderla. Aperta, la barra del
          trasporto (Transport) porta già i due pulsanti: nessuna riga di titolo in più. */}
      {collapsed && (
        <header className="flex h-8 shrink-0 items-center gap-2 pl-3 pr-1.5">
          <AnimIcon name="timeline" size={14} className="text-fg-subtle" />
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-fg-subtle">Animazione</h2>
          {clip && <span className="truncate text-[12px] text-fg-muted">{clip.name}</span>}
          {record && <span className="rounded-full bg-danger-soft px-2 text-[11px] font-medium text-danger">Registrazione</span>}
          <div className="ml-auto flex items-center gap-0.5">
            <AnimIconButton icon="chevronUp" label="Espandi la timeline" size={24} onPress={() => useTimeline.getState().setCollapsed(false)} />
            <AnimIconButton icon="x" label="Chiudi la timeline" shortcut="M" size={24} onPress={() => useTimeline.getState().setOpen(false)} />
          </div>
        </header>
      )}

      {!collapsed && (
        <div className="flex min-h-0 flex-1">
          <ClipList />
          <div className="flex min-w-0 flex-1 flex-col">
            <Transport clip={clip} />
            {clip ? (
              <>
                <div className="flex min-h-0 flex-1">
                  <TrackArea clip={clip} />
                  {selection.length > 0 && <KeyframeInspector clip={clip} selection={selection} />}
                </div>
              </>
            ) : (
              <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto">
                <EmptyState
                  icon="sparkle"
                  title="Anima qualcosa: seleziona un livello e premi + Proprietà"
                  hint="Oppure crea una clip vuota, o parti da un preset (Fade in, Slide up, Pop...)."
                  action={
                    <Button variant="primary" icon="plus" onPress={() => scene && createClip(scene, useScene.getState().selection)}>
                      Crea una clip
                    </Button>
                  }
                />
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
