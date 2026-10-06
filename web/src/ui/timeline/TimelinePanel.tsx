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

// THE TIMELINE PANEL, below the canvas (Design). The shell costs nothing when
// closed: it does not mount the body, so it does not sample, listen or redraw.
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

  // The clip being viewed: a drag's draft, if any, otherwise the document's.
  const docClip: ClipLite | null = scene && clipId ? scene.clips[clipId] ?? null : null;
  const clip = draftClip && docClip && draftClip.id === docClip.id ? draftClip : docClip;

  // KEYBOARD, only with focus inside the timeline (the panel is not the canvas:
  // space here is play/pause, outside it stays the pan). Delete/Backspace must NEVER
  // reach the canvas's global listeners, which would delete the selected
  // layers: inside the timeline they delete the selected keyframes and nothing else.
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
      // Arrows on a keyframe: move it by one grid step (Shift: ten).
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

  // The top edge resizes the height (by dragging or with the arrows).
  const resize = useRef<{ y: number; h: number } | null>(null);

  return (
    <section
      ref={root}
      aria-label="Timeline"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      // A click on a neutral spot of the panel gives it focus: this way space
      // works as play/pause without having to touch a button first.
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
          aria-label="Timeline height"
          aria-valuemin={MIN_HEIGHT}
          aria-valuemax={MAX_HEIGHT}
          aria-valuenow={height}
          tabIndex={0}
          className="absolute -top-1 left-0 right-0 z-30 h-2 cursor-row-resize touch-none outline-none hover:bg-accent/30 focus-visible:bg-accent/40"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            resize.current = { y: e.clientY, h: height };
            try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* no capture (jsdom) */ }
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

      {/* Collapsed: only the header remains, to reopen or close it. When open, the transport
          bar (Transport) already carries the two buttons: no extra title row. */}
      {collapsed && (
        <header className="flex h-8 shrink-0 items-center gap-2 pl-3 pr-1.5">
          <AnimIcon name="timeline" size={14} className="text-fg-subtle" />
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-fg-subtle">Animation</h2>
          {clip && <span className="truncate text-[12px] text-fg-muted">{clip.name}</span>}
          {record && <span className="rounded-full bg-danger-soft px-2 text-[11px] font-medium text-danger">Recording</span>}
          <div className="ml-auto flex items-center gap-0.5">
            <AnimIconButton icon="chevronUp" label="Expand the timeline" size={24} onPress={() => useTimeline.getState().setCollapsed(false)} />
            <AnimIconButton icon="x" label="Close the timeline" shortcut="M" size={24} onPress={() => useTimeline.getState().setOpen(false)} />
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
                  title="Animate something: select a layer and press + Property"
                  hint="Or create an empty clip, or start from a preset (Fade in, Slide up, Pop...)."
                  action={
                    <Button variant="primary" icon="plus" onPress={() => scene && createClip(scene, useScene.getState().selection)}>
                      Create a clip
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
