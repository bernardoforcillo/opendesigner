import { create } from "zustand";
import { useScene } from "../store/store";
import type { ClipLite, SceneState } from "../store/types";
import { makeDeleteClipOp, makeSetClipOp, uuid } from "../tools/ops";
import { clipTimeline, type NodeAnim } from "./engine";
import { asPlayed } from "./runtime";
import { setRecordHook,propChangesOfOps, type RecordHook } from "./recordHook";
import {
  addPropertyTrack, baseValueOf, defaultTargetId, duplicateClip, findTrack, isInside, newClip, propsFor, recordChanges,
  uniqueClipName, unwrapDegrees, valueAt, type KeyRef,
} from "./timelineLogic";
import { buildPreset, type PresetId } from "./presets";

// THE TIMELINE STATE: VIEW state, like the camera and the selection -- it is not
// document, it does not go over the network and does not enter undo. What is instead document
// (the clips, their keyframes) is written only with `SetClip` / `DeleteClip`, ONE op per
// gesture, via `commitClip` / `removeClip` below.
//
// It also holds the TRANSPORT (play, pause, stop, scrubbing) and its
// requestAnimationFrame loop, which runs ONLY while playing: with the timeline stopped or
// closed the editor does not schedule a single frame.

const HEIGHT_KEY = "od.timeline.height";
export const MIN_HEIGHT = 168;
export const MAX_HEIGHT = 560;
export const DEFAULT_HEIGHT = 328;
export const SPEEDS = [0.25, 0.5, 1, 1.5, 2] as const;
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 32;

function readHeight(): number {
  try {
    const v = Number(localStorage.getItem(HEIGHT_KEY));
    if (Number.isFinite(v) && v >= MIN_HEIGHT && v <= MAX_HEIGHT) return v;
  } catch { /* no storage */ }
  return DEFAULT_HEIGHT;
}

export interface TimelineState {
  /** The panel is open. Closed, no cost: it is not mounted, not sampled. */
  open: boolean;
  height: number;
  /** Reduced to the transport bar only (the canvas takes the space back). */
  collapsed: boolean;
  /** The clip open in the editor (id), or null. */
  clipId: string | null;
  /** The current time INSIDE the clip, ms. */
  playhead: number;
  playing: boolean;
  loop: boolean;
  speed: number;
  /** "Record": changes to x, y, rotation, opacity become keyframes at the playhead. */
  record: boolean;
  /** The canvas shows the POSE (sampled values) instead of the document: from when you scrub/play/record until Stop. */
  posed: boolean;
  /** Horizontal magnification relative to "the whole clip in the space" (1). */
  zoom: number;
  /** Only the clips of the selection (screen/group) or all those of the document. */
  filterToSelection: boolean;
  /** The selected keyframes (indices in the clip, draft included). */
  selection: KeyRef[];
  /** The clip with the draft of a keyframe drag: it is sampled in place of the document's. */
  draftClip: ClipLite | null;
  /** The values that recording is collecting mid-gesture (node -> property). */
  recordDraft: ReadonlyMap<string, NodeAnim> | null;

  setOpen: (v: boolean) => void;
  toggleOpen: () => void;
  setHeight: (h: number) => void;
  setCollapsed: (v: boolean) => void;
  openClip: (id: string | null) => void;
  setPlayhead: (t: number) => void;
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  stop: () => void;
  setLoop: (v: boolean) => void;
  setSpeed: (v: number) => void;
  setRecord: (v: boolean) => void;
  setZoom: (z: number) => void;
  setFilterToSelection: (v: boolean) => void;
  select: (sel: KeyRef[]) => void;
  setDraftClip: (c: ClipLite | null) => void;
  setRecordDraft: (d: ReadonlyMap<string, NodeAnim> | null) => void;
}

// The playback loop. `elapsed` is the real time elapsed since the start
// (delay included) and `clipTimeline` translates it into the time inside the clip: so
// the preview respects repeats, yoyo and delay EXACTLY like the prototype.
let raf = 0;
let lastNow = 0;
let elapsed = 0;

function sceneClip(id: string | null): ClipLite | null {
  if (!id) return null;
  return useScene.getState().scene?.clips[id] ?? null;
}

function cancelLoop() {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
}

function tick(now: number) {
  raf = 0;
  const st = useTimeline.getState();
  if (!st.playing) return;
  const clip = sceneClip(st.clipId);
  if (!clip) { st.pause(); return; }
  // A long jump (background tab) must not make the animation jump.
  const dt = Math.min(100, Math.max(0, now - lastNow)) * st.speed;
  lastNow = now;
  elapsed += dt;
  const r = clipTimeline(asPlayed(clip), elapsed);
  if (r.done) {
    if (st.loop) {
      elapsed = 0;
      useTimeline.setState({ playhead: 0 });
    } else {
      useTimeline.setState({ playhead: r.t, playing: false });
      return;
    }
  } else if (r.t !== st.playhead) {
    useTimeline.setState({ playhead: r.t });
  }
  raf = requestAnimationFrame(tick);
}

export const useTimeline = create<TimelineState>((set, get) => ({
  open: false,
  height: readHeight(),
  collapsed: false,
  clipId: null,
  playhead: 0,
  playing: false,
  loop: false,
  speed: 1,
  record: false,
  posed: false,
  zoom: 1,
  filterToSelection: false,
  selection: [],
  draftClip: null,
  recordDraft: null,

  setOpen: (v) => {
    if (!v) {
      cancelLoop();
      set({ open: false, playing: false, posed: false, record: false, selection: [], draftClip: null, recordDraft: null });
    } else if (!get().open) set({ open: true });
    resizeSoon();
  },
  toggleOpen: () => get().setOpen(!get().open),
  setHeight: (h) => {
    const height = Math.round(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, h)));
    if (height === get().height) return;
    set({ height });
    try { localStorage.setItem(HEIGHT_KEY, String(height)); } catch { /* no storage */ }
    resizeSoon();
  },
  setCollapsed: (v) => {
    if (v === get().collapsed) return;
    set({ collapsed: v });
    resizeSoon();
  },
  // Opening a clip (from the list, after creating it or with a preset) also opens the panel.
  openClip: (id) => {
    cancelLoop();
    set({ open: id !== null ? true : get().open, collapsed: id !== null ? false : get().collapsed, clipId: id, playhead: 0, playing: false, posed: false, record: false, selection: [], draftClip: null, recordDraft: null });
    if (id !== null) resizeSoon();
  },
  setPlayhead: (t) => {
    const clip = sceneClip(get().clipId);
    const p = Math.min(clip?.duration ?? 0, Math.max(0, Number.isFinite(t) ? t : 0));
    cancelLoop();
    // scrubbing pauses and shows the pose; the real time restarts from here
    set({ playhead: p, playing: false, posed: true });
  },
  play: () => {
    const st = get();
    const clip = sceneClip(st.clipId);
    if (!clip || st.playing) return;
    // From stopped at the end (and without repeat) it restarts from the beginning.
    const from = st.playhead >= clip.duration && !st.loop ? 0 : st.playhead;
    elapsed = clip.delay + from;
    lastNow = typeof performance !== "undefined" ? performance.now() : 0;
    set({ playing: true, posed: true, playhead: from, draftClip: null });
    cancelLoop();
    raf = requestAnimationFrame(tick);
  },
  pause: () => {
    cancelLoop();
    if (get().playing) set({ playing: false });
  },
  togglePlay: () => (get().playing ? get().pause() : get().play()),
  stop: () => {
    cancelLoop();
    // Stop returns to time 0; the pose stays only if recording (the first frame is visible).
    set((st) => ({ playing: false, playhead: 0, posed: st.record }));
  },
  setLoop: (v) => set({ loop: v }),
  setSpeed: (v) => set({ speed: SPEEDS.includes(v as never) ? v : 1 }),
  setRecord: (v) => {
    if (v && !sceneClip(get().clipId)) return;
    cancelLoop();
    set(v ? { record: true, posed: true, playing: false } : { record: false, recordDraft: null });
  },
  setZoom: (z) => set({ zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)) }),
  setFilterToSelection: (v) => set({ filterToSelection: v }),
  select: (sel) => set({ selection: sel }),
  setDraftClip: (c) => set({ draftClip: c }),
  setRecordDraft: (d) => set({ recordDraft: d }),
}));

// The canvas changes height when the panel opens/closes/resizes: the
// renderer redraws on invalidation and the window resize is already
// the invalidation that App listens to (same path as shell/panels.ts).
function resizeSoon() {
  if (typeof window !== "undefined" && typeof requestAnimationFrame !== "undefined") {
    requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  }
}

// --- writes to the document --------------------------------------------------------

/** Writes the WHOLE clip with ONE op in ONE gesture: one undo step. */
export function commitClip(clip: ClipLite): void {
  const st = useScene.getState();
  st.beginGesture();
  st.endGesture([makeSetClipOp(clip)]);
}

/** Creates an empty clip for the target and opens it. Returns the clip (or null without a target). */
export function createClip(scene: SceneState, selection: readonly string[]): ClipLite | null {
  const target = defaultTargetId(scene, selection) || scene.pages[0]?.id || "";
  // The target must be a node: without a selection it falls back to the first frame of the page.
  const targetNode = scene.nodes.get(target) ? target : firstContainer(scene);
  if (!targetNode) return null;
  const clip = newClip(uuid(), uniqueClipName(scene.clips), targetNode);
  commitClip(clip);
  useTimeline.getState().openClip(clip.id);
  return clip;
}

function firstContainer(scene: SceneState): string {
  for (const n of scene.nodes.values()) if (n.kind === "frame" && scene.pages.some((p) => p.id === n.parentId)) return n.id;
  return "";
}

export function duplicateClipOp(scene: SceneState, id: string): void {
  const src = scene.clips[id];
  if (!src) return;
  const copy = duplicateClip(src, uuid(), uniqueClipName(scene.clips, src.name.replace(/\s+\d+$/, "") || "Clip"));
  commitClip(copy);
  useTimeline.getState().openClip(copy.id);
}

/**
 * "+ Property": adds the (node, property) track for each given node to the
 * open clip -- or, with no open clip, creates one for the default target and
 * opens it -- with ONE SetClip. Nodes outside the clip's target are skipped
 * (a track outside the target is not exported). Returns how many tracks it added.
 */
export function addPropertyTracks(scene: SceneState, nodeIds: readonly string[], prop: string): number {
  const tl = useTimeline.getState();
  const open = tl.clipId ? scene.clips[tl.clipId] : undefined;
  const base = open ?? newClip(uuid(), uniqueClipName(scene.clips), defaultTargetId(scene, nodeIds));
  if (!scene.nodes.get(base.targetId)) return 0;
  let clip = base;
  let added = 0;
  for (const id of nodeIds) {
    const n = scene.nodes.get(id);
    if (!n || !isInside(scene, id, clip.targetId) || !propsFor(n).includes(prop as never)) continue;
    const next = addPropertyTrack(clip, n, prop);
    if (next !== clip) added++;
    clip = next;
  }
  if (added === 0 && open) return 0;
  commitClip(clip);
  if (!open) tl.openClip(clip.id);
  return added;
}

/** "Animate with a preset": creates the preset's clip for the node and opens it (ONE SetClip). */
export function applyPreset(scene: SceneState, nodeId: string, preset: PresetId): ClipLite | null {
  const n = scene.nodes.get(nodeId);
  if (!n) return null;
  const clip = buildPreset(preset, scene, n, uuid());
  if (!clip || !scene.nodes.get(clip.targetId)) return null;
  commitClip(clip);
  useTimeline.getState().openClip(clip.id);
  return clip;
}

export function removeClip(id: string): void {
  const tl = useTimeline.getState();
  if (tl.clipId === id) tl.openClip(null);
  const st = useScene.getState();
  st.beginGesture();
  st.endGesture([makeDeleteClipOp(id)]);
}

// --- the recording hook ------------------------------------------------------------

function recordCtx(): { scene: SceneState; clip: ClipLite; tl: TimelineState } | null {
  const tl = useTimeline.getState();
  if (!tl.record || !tl.open) return null;
  const scene = useScene.getState().scene;
  const clip = scene && tl.clipId ? scene.clips[tl.clipId] : undefined;
  return scene && clip ? { scene, clip, tl } : null;
}

const hook: RecordHook = {
  preview(op) {
    const c = recordCtx();
    if (!c) return false;
    const ch = propChangesOfOps([op]);
    // Nodes outside the clip's target are not recorded: they are edited normally.
    if (!ch || !ch.every((x) => c.scene.nodes.get(x.nodeId) && isInside(c.scene, x.nodeId, c.clip.targetId))) return false;
    const d = new Map(c.tl.recordDraft ?? []);
    for (const x of ch) d.set(x.nodeId, { ...d.get(x.nodeId), [x.prop]: x.value });
    c.tl.setRecordDraft(d);
    return true;
  },
  final(ops) {
    const c = recordCtx();
    if (!c) return ops;
    const ch = propChangesOfOps(ops);
    if (!ch || !ch.every((x) => c.scene.nodes.get(x.nodeId) && isInside(c.scene, x.nodeId, c.clip.targetId))) {
      if (c.tl.recordDraft) c.tl.setRecordDraft(null);
      return ops;
    }
    const t = c.tl.playhead;
    // the value shown BEFORE the gesture: that of the track at the playhead, or the node's base value
    const shown = (nodeId: string, prop: string): number | undefined => {
      const ti = findTrack(c.clip, nodeId, prop);
      if (ti >= 0) return valueAt(c.clip, ti, t);
      const n = c.scene.nodes.get(nodeId);
      return n ? baseValueOf(n, prop) : undefined;
    };
    const changes = ch.map((x) => {
      const ref = shown(x.nodeId, x.prop);
      return x.prop === "rotation" && ref !== undefined ? { ...x, value: unwrapDegrees(x.value, ref) } : x;
    });
    const next = recordChanges(c.clip, changes, t, shown);
    c.tl.setRecordDraft(null);
    return [makeSetClipOp(next)];
  },
};

// The hook is installed ONLY while recording: with recording off the store
// sees it null and its two ports are the identity.
useTimeline.subscribe((st, prev) => {
  if (st.record === prev.record && st.open === prev.open) return;
  setRecordHook(st.record && st.open ? hook : null);
});

// An abandoned gesture (Esc mid-drag) writes nothing: the draft
// collected so far is thrown away, or the canvas would stay on the pose of the last preview.
useScene.subscribe((st, prev) => {
  if (prev.gesture && !st.gesture && useTimeline.getState().recordDraft) useTimeline.getState().setRecordDraft(null);
});
