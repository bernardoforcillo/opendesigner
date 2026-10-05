import type { ClipLite, KeyframeLite, NodeLite, SceneState, TrackLite } from "../store/types";
import { ancestorsOf } from "../store/tree";
import { sampleTrack, type TrackProp } from "./engine";
import { canDraw } from "./pose";

// THE TIMELINE LOGIC: PURE functions on the clip, with no DOM or store.
//
// Every function takes a clip and returns a NEW one (never mutating the one
// passed in): it is what lets the UI keep the draft of a drag
// as local state and send ONE SINGLE `SetClip` on release -- and lets undo
// go back one step even for a gesture that touched ten keyframes.
// The validator's constraints (times in [0, duration], sorted; opacity and draw in
// 0..1; a track always has at least one keyframe) are maintained here, so a
// clip coming out of these functions is always accepted by `SetClip`.

/** The snap grid step, ms (≈ one frame at 100 fps; two at 50). */
export const SNAP_MS = 10;
/** The easing of keyframes created by the editor. */
export const DEFAULT_EASING = "easeInOut";
/** The maximum duration allowed for a clip in the editor (one hour: beyond that it is almost surely a typo). */
export const MAX_DURATION_MS = 3_600_000;

/** A keyframe: the index of the track in the clip and that of the keyframe in the track. */
export interface KeyRef { track: number; key: number }

export const sameKey = (a: KeyRef, b: KeyRef) => a.track === b.track && a.key === b.key;

// --- values ----------------------------------------------------------------------

/** Brings a value within the property's limits (opacity and draw in 0..1); NaN -> `fallback`. */
export function clampValue(prop: string, v: number, fallback = 0): number {
  if (!Number.isFinite(v)) return fallback;
  return prop === "opacity" || prop === "draw" ? Math.min(1, Math.max(0, v)) : v;
}

/** The BASE value of a node property (the one that holds without animation). */
export function baseValueOf(n: Pick<NodeLite, "x" | "y" | "rotation" | "opacity">, prop: string): number {
  switch (prop) {
    case "opacity": return n.opacity;
    case "x": return n.x;
    case "y": return n.y;
    case "rotation": return n.rotation;
    case "scale": return 1;
    case "draw": return 1;
  }
  return 0;
}

/** The animatable properties of a node (draw only if it has a path). */
export function propsFor(n: Pick<NodeLite, "kind">): TrackProp[] {
  const p: TrackProp[] = ["opacity", "x", "y", "scale", "rotation"];
  if (canDraw(n)) p.push("draw");
  return p;
}

export const PROP_LABEL: Record<string, string> = {
  opacity: "Opacity", x: "X", y: "Y", scale: "Scale", rotation: "Rotation", draw: "Draw",
};
export const PROP_UNIT: Record<string, string> = { opacity: "", x: "px", y: "px", scale: "×", rotation: "°", draw: "" };

// --- the tracks ------------------------------------------------------------------

const withTracks = (clip: ClipLite, tracks: TrackLite[]): ClipLite => ({ ...clip, tracks });

export function findTrack(clip: ClipLite, nodeId: string, prop: string): number {
  return clip.tracks.findIndex((t) => t.nodeId === nodeId && t.prop === prop);
}

/**
 * Adds a track (node, property) with ONE keyframe at `time` with the given
 * value. If the track already exists the clip returns unchanged (same identity): a
 * (node, property) pair appears only once per clip.
 */
export function addTrack(clip: ClipLite, nodeId: string, prop: string, value: number, time = 0): ClipLite {
  if (findTrack(clip, nodeId, prop) >= 0) return clip;
  const t = Math.min(clip.duration, Math.max(0, time));
  const kf: KeyframeLite = { time: t, value: clampValue(prop, value), easing: DEFAULT_EASING };
  return withTracks(clip, [...clip.tracks, { nodeId, prop, keyframes: [kf] }]);
}

export function removeTrack(clip: ClipLite, track: number): ClipLite {
  if (track < 0 || track >= clip.tracks.length) return clip;
  return withTracks(clip, clip.tracks.filter((_, i) => i !== track));
}

/**
 * A NEW track for (node, property) ready to be edited: two keyframes,
 * at the start and at the end, with the node's base value (the clip starts and ends where
 * the node is; the designer changes one). `draw` is the exception: it is the
 * "draws itself" animation, from 0 to 1. If the track already exists the clip returns unchanged.
 */
export function addPropertyTrack(
  clip: ClipLite, node: Pick<NodeLite, "id" | "x" | "y" | "rotation" | "opacity">, prop: string,
): ClipLite {
  if (findTrack(clip, node.id, prop) >= 0) return clip;
  const v = baseValueOf(node, prop);
  const start = prop === "draw" ? 0 : v;
  const withStart = addTrack(clip, node.id, prop, start, 0);
  const ti = withStart.tracks.length - 1;
  return addKeyframe(withStart, ti, clip.duration, v).clip;
}

/** Removes from the clip the tracks of nodes no longer present (after a deletion). */
export function pruneTracks(clip: ClipLite, exists: (nodeId: string) => boolean): ClipLite {
  const tracks = clip.tracks.filter((t) => exists(t.nodeId));
  return tracks.length === clip.tracks.length ? clip : withTracks(clip, tracks);
}

// --- i keyframe ------------------------------------------------------------------

const byTime = (a: KeyframeLite, b: KeyframeLite) => a.time - b.time;

/** Inserts (or, if there is already a keyframe exactly at that time, replaces) a keyframe; also returns its reference. */
export function addKeyframe(
  clip: ClipLite, track: number, time: number, value: number, easing = DEFAULT_EASING,
): { clip: ClipLite; ref: KeyRef } {
  const tr = clip.tracks[track];
  if (!tr) return { clip, ref: { track, key: 0 } };
  const t = Math.min(clip.duration, Math.max(0, time));
  const v = clampValue(tr.prop, value);
  const kf = [...tr.keyframes];
  const same = kf.findIndex((k) => k.time === t);
  if (same >= 0) {
    kf[same] = { ...kf[same], value: v };
    return { clip: withKeys(clip, track, kf), ref: { track, key: same } };
  }
  // after the keyframes with time <= t, so a new keyframe at an already occupied time never jumps over
  let at = kf.length;
  while (at > 0 && kf[at - 1].time > t) at--;
  kf.splice(at, 0, { time: t, value: v, easing });
  return { clip: withKeys(clip, track, kf), ref: { track, key: at } };
}

function withKeys(clip: ClipLite, track: number, keyframes: KeyframeLite[]): ClipLite {
  return withTracks(clip, clip.tracks.map((t, i) => (i === track ? { ...t, keyframes } : t)));
}

/** Edits value / easing / time of ONE keyframe. The time is brought into [0, duration] and the track is re-sorted. */
export function updateKeyframe(
  clip: ClipLite, ref: KeyRef, patch: Partial<KeyframeLite>,
): { clip: ClipLite; ref: KeyRef } {
  const tr = clip.tracks[ref.track];
  const cur = tr?.keyframes[ref.key];
  if (!tr || !cur) return { clip, ref };
  const next: KeyframeLite = { ...cur, ...patch };
  next.value = clampValue(tr.prop, next.value, cur.value);
  next.time = Math.min(clip.duration, Math.max(0, Number.isFinite(next.time) ? next.time : cur.time));
  const kf = tr.keyframes.filter((_, i) => i !== ref.key);
  // collision with another keyframe at the same time: the one that moves replaces
  const clash = kf.findIndex((k) => k.time === next.time);
  if (clash >= 0) kf.splice(clash, 1);
  let at = kf.length;
  while (at > 0 && kf[at - 1].time > next.time) at--;
  kf.splice(at, 0, next);
  return { clip: withKeys(clip, ref.track, kf), ref: { track: ref.track, key: at } };
}

/** Deletes the given keyframes; a track left without keyframes disappears (an empty track is not valid). */
export function deleteKeyframes(clip: ClipLite, sel: readonly KeyRef[]): ClipLite {
  if (sel.length === 0) return clip;
  const tracks: TrackLite[] = [];
  clip.tracks.forEach((t, ti) => {
    const kill = new Set(sel.filter((r) => r.track === ti).map((r) => r.key));
    if (kill.size === 0) { tracks.push(t); return; }
    const keyframes = t.keyframes.filter((_, ki) => !kill.has(ki));
    if (keyframes.length > 0) tracks.push({ ...t, keyframes });
  });
  return withTracks(clip, tracks);
}

/**
 * Moves the selected keyframes by `delta` ms (all by the same step: the
 * group does not deform). The delta is limited so nobody leaves [0, duration]
 * and the result is re-sorted; a keyframe that lands on a NON-selected one
 * of the same track replaces it. Returns the clip and the new references.
 */
export function moveKeyframes(
  clip: ClipLite, sel: readonly KeyRef[], delta: number,
): { clip: ClipLite; sel: KeyRef[] } {
  if (sel.length === 0 || delta === 0) return { clip, sel: [...sel] };
  let lo = -Infinity, hi = Infinity;
  for (const r of sel) {
    const k = clip.tracks[r.track]?.keyframes[r.key];
    if (!k) continue;
    lo = Math.max(lo, -k.time);
    hi = Math.min(hi, clip.duration - k.time);
  }
  const d = Math.min(hi, Math.max(lo, delta));
  const moving = new Set(sel.map((r) => `${r.track}:${r.key}`));
  const newSel: KeyRef[] = [];
  const tracks = clip.tracks.map((t, ti) => {
    if (!sel.some((r) => r.track === ti)) return t;
    const fixed: KeyframeLite[] = [];
    const moved: KeyframeLite[] = [];
    t.keyframes.forEach((k, ki) => (moving.has(`${ti}:${ki}`) ? moved.push({ ...k, time: k.time + d }) : fixed.push(k)));
    const movedTimes = new Set(moved.map((k) => k.time));
    const kept = fixed.filter((k) => !movedTimes.has(k.time));
    const all = [...kept.map((k) => ({ k, m: false })), ...moved.map((k) => ({ k, m: true }))]
      .sort((a, b) => a.k.time - b.k.time || Number(a.m) - Number(b.m));
    all.forEach((e, i) => { if (e.m) newSel.push({ track: ti, key: i }); });
    return { ...t, keyframes: all.map((e) => e.k) };
  });
  return { clip: withTracks(clip, tracks), sel: newSel };
}

/**
 * Duplicates the selected keyframes: the copy of the FIRST (leftmost) lands at
 * `atTime`, the others keep their distances; the group is brought inside the duration.
 * A copy that lands on an existing keyframe replaces it. Returns the
 * references of the copies (the new selection).
 */
export function duplicateKeyframes(
  clip: ClipLite, sel: readonly KeyRef[], atTime: number,
): { clip: ClipLite; sel: KeyRef[] } {
  const items = sel
    .map((r) => ({ r, k: clip.tracks[r.track]?.keyframes[r.key] }))
    .filter((e): e is { r: KeyRef; k: KeyframeLite } => !!e.k);
  if (items.length === 0) return { clip, sel: [] };
  const first = Math.min(...items.map((e) => e.k.time));
  const last = Math.max(...items.map((e) => e.k.time));
  const shift = Math.min(clip.duration - last, Math.max(-first, atTime - first));
  let cur = clip;
  const copies: { track: number; time: number }[] = [];
  for (const e of items) {
    const time = e.k.time + shift;
    const tr = cur.tracks[e.r.track];
    const kf = tr.keyframes.filter((k) => k.time !== time);
    kf.push({ ...e.k, time });
    kf.sort(byTime);
    cur = withKeys(cur, e.r.track, kf);
    copies.push({ track: e.r.track, time });
  }
  const out: KeyRef[] = copies.map((c) => ({ track: c.track, key: cur.tracks[c.track].keyframes.findIndex((k) => k.time === c.time) }));
  return { clip: cur, sel: out };
}

// --- time ------------------------------------------------------------------------

/**
 * Snaps a time: to the SNAP_MS grid and to the `others` times (other keyframes,
 * the playhead) within `thresholdMs`; the others' times win over the grid.
 * `free` (Shift) skips the snap and rounds to the ms. Always within [0, duration].
 */
export function snapTime(
  t: number, duration: number, others: readonly number[], opts: { free?: boolean; thresholdMs?: number } = {},
): number {
  const clamp = (v: number) => Math.min(duration, Math.max(0, v));
  if (opts.free) return clamp(Math.round(t));
  const th = opts.thresholdMs ?? SNAP_MS;
  let best: number | null = null;
  let bestD = Infinity;
  for (const o of others) {
    const d = Math.abs(o - t);
    if (d <= th && d < bestD) { best = o; bestD = d; }
  }
  if (best !== null) return clamp(best);
  return clamp(Math.round(t / SNAP_MS) * SNAP_MS);
}

/** The times of all the keyframes NOT indicated (the snap targets of a drag). */
export function timesExcluding(clip: ClipLite, sel: readonly KeyRef[]): number[] {
  const skip = new Set(sel.map((r) => `${r.track}:${r.key}`));
  const out: number[] = [];
  clip.tracks.forEach((t, ti) => t.keyframes.forEach((k, ki) => { if (!skip.has(`${ti}:${ki}`)) out.push(k.time); }));
  return out;
}

/**
 * The delta of a drag: the "grabbed" keyframe (the primary) goes to
 * `grabbedStart + rawDelta`, snapped like snapTime; the resulting delta applies
 * to the whole group.
 */
export function dragDelta(
  clip: ClipLite, sel: readonly KeyRef[], primary: KeyRef, rawDelta: number,
  opts: { free?: boolean; thresholdMs?: number; extra?: readonly number[] } = {},
): number {
  const start = clip.tracks[primary.track]?.keyframes[primary.key]?.time;
  if (start === undefined) return 0;
  const targets = [...timesExcluding(clip, sel), ...(opts.extra ?? [])];
  return snapTime(start + rawDelta, clip.duration, targets, opts) - start;
}

/** Changes the duration: keyframes beyond the new end are brought to the end (the clip stays valid). */
export function withDuration(clip: ClipLite, duration: number): ClipLite {
  const d = Math.min(MAX_DURATION_MS, Math.max(SNAP_MS, Number.isFinite(duration) ? duration : clip.duration));
  if (d === clip.duration) return clip;
  const tracks = clip.tracks.map((t) => {
    if (t.keyframes.every((k) => k.time <= d)) return t;
    const kf = t.keyframes.map((k) => (k.time > d ? { ...k, time: d } : k));
    // several keyframes ending up on the same end = a useless step: the last one stays
    const out: KeyframeLite[] = [];
    for (const k of kf) {
      if (out.length > 0 && out[out.length - 1].time === d && k.time === d) out[out.length - 1] = k;
      else out.push(k);
    }
    return { ...t, keyframes: out };
  });
  return { ...clip, duration: d, tracks };
}

// --- registrazione ---------------------------------------------------------------

/** A change to an animatable property of a node, the value in document coordinates. */
export interface PropChange { nodeId: string; prop: string; value: number }

/**
 * The clip with the changes written as keyframes at `time`: in the track
 * (node, property) there is already a keyframe at that time -> its value changes; otherwise
 * one is inserted. A NEW track at a time > 0 also receives a keyframe at 0
 * with the value the node had before (`before`): recording at 600 ms the first
 * time makes the animation start from where it was, instead of holding the new value until
 * 600 ms (which for someone who moved a node would be "nothing happens").
 */
export function recordChanges(
  clip: ClipLite, changes: readonly PropChange[], time: number,
  before: (nodeId: string, prop: string) => number | undefined,
): ClipLite {
  let cur = clip;
  const t = Math.min(clip.duration, Math.max(0, Math.round(time)));
  for (const c of changes) {
    let ti = findTrack(cur, c.nodeId, c.prop);
    if (ti < 0) {
      const b = before(c.nodeId, c.prop);
      cur = addTrack(cur, c.nodeId, c.prop, t > 0 && b !== undefined ? b : c.value, t > 0 && b !== undefined ? 0 : t);
      ti = cur.tracks.length - 1;
      if (t === 0 || b === undefined) continue;
    }
    cur = addKeyframe(cur, ti, t, c.value).clip;
  }
  return cur;
}

/** The value of a track at time `t` (to add a keyframe "where you are"). */
export function valueAt(clip: ClipLite, track: number, t: number): number | undefined {
  const tr = clip.tracks[track];
  if (!tr) return undefined;
  const v = sampleTrack(tr, t);
  return Number.isNaN(v) ? undefined : v;
}

// --- the ruler -------------------------------------------------------------------

const NICE_STEPS = [10, 20, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10_000, 30_000, 60_000, 300_000];

/** The "round" step (ms) between two major ticks so that they are at least `minPx` apart at this zoom. */
export function rulerStep(pxPerMs: number, minPx = 64): number {
  for (const s of NICE_STEPS) if (s * pxPerMs >= minPx) return s;
  return NICE_STEPS[NICE_STEPS.length - 1];
}

export interface Tick { t: number; major: boolean }

/** The ticks from `from` to `to` ms: major every `rulerStep`, minor at a fifth. */
export function rulerTicks(pxPerMs: number, from: number, to: number, minPx = 64): Tick[] {
  const step = rulerStep(pxPerMs, minPx);
  const minor = step / 5 >= SNAP_MS && (step / 5) * pxPerMs >= 8 ? step / 5 : step / 2;
  const out: Tick[] = [];
  const start = Math.floor(from / minor) * minor;
  for (let t = start; t <= to + 1e-6; t += minor) {
    const tt = Math.round(t * 1000) / 1000;
    out.push({ t: tt, major: Math.abs(tt / step - Math.round(tt / step)) < 1e-6 });
  }
  return out;
}

/** "250 ms", "1.2 s", "1:05": the label of a tick or of the current time. */
export function formatTime(ms: number): string {
  const a = Math.abs(ms);
  if (a < 1000) return `${Math.round(ms)} ms`;
  if (a < 60_000) return `${(ms / 1000).toLocaleString("en-US", { maximumFractionDigits: 2 })} s`;
  const m = Math.floor(a / 60_000);
  const s = Math.floor((a % 60_000) / 1000);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** The time as on a stopwatch: "0:01.250". */
export function formatClock(ms: number): string {
  const t = Math.max(0, Math.round(ms));
  const m = Math.floor(t / 60_000);
  const s = Math.floor((t % 60_000) / 1000);
  return `${m}:${String(s).padStart(2, "0")}.${String(t % 1000).padStart(3, "0")}`;
}

// --- clip and target -------------------------------------------------------------

/**
 * The default target of a clip created for the selection: the closest container
 * (frame or group) to the first selected node, the node itself included if
 * it is one; without containers, the node itself. "" if the selection is empty.
 */
export function defaultTargetId(scene: SceneState, selection: readonly string[]): string {
  const first = selection.length > 0 ? scene.nodes.at(selection[0]) : undefined;
  if (!first) return "";
  const isContainer = (n: NodeLite) => n.kind === "frame" || n.kind === "group";
  if (isContainer(first)) return first.id;
  for (const a of ancestorsOf(scene, first.id)) if (isContainer(a)) return a.id;
  return first.id;
}

/** Is `nodeId` inside (or is it) `targetId`? A clip's tracks must be inside its target. */
export function isInside(scene: SceneState, nodeId: string, targetId: string): boolean {
  if (nodeId === targetId) return true;
  return ancestorsOf(scene, nodeId).some((a) => a.id === targetId);
}

/** A free name "Clip N" for the document. */
export function uniqueClipName(clips: Record<string, ClipLite>, base = "Clip"): string {
  const names = new Set(Object.values(clips).map((c) => c.name));
  for (let i = 1; ; i++) {
    const n = `${base} ${i}`;
    if (!names.has(n)) return n;
  }
}

export function newClip(id: string, name: string, targetId: string): ClipLite {
  return { id, name, duration: 1000, trigger: "enter", delay: 0, repeat: 0, yoyo: false, tracks: [], targetId };
}

export function duplicateClip(src: ClipLite, id: string, name: string): ClipLite {
  return { ...src, id, name, tracks: src.tracks.map((t) => ({ ...t, keyframes: t.keyframes.map((k) => ({ ...k })) })) };
}

/**
 * The value in degrees congruent to `deg` (mod 360) closest to `ref`. The model's
 * rotation lives in [0, 360): recording 10° after 350° would make the
 * track interpolate backwards through 340° instead of advancing 20°. Here we pick the
 * determination that does NOT jump, so the track may leave [0, 360) (it is
 * allowed: `rotation` is any finite number).
 */
export function unwrapDegrees(deg: number, ref: number): number {
  if (!Number.isFinite(deg) || !Number.isFinite(ref)) return deg;
  return deg + 360 * Math.round((ref - deg) / 360);
}

/**
 * The "selection's" clips: those whose target is an ancestor (or itself) of the selected
 * nodes or that have a track on one of them. For filtering the list
 * when working inside a screen or a group. Empty selection = all.
 */
export function clipsForSelection(scene: SceneState, selection: readonly string[]): ClipLite[] {
  const all = Object.values(scene.clips).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1));
  if (selection.length === 0) return all;
  const related = new Set<string>();
  for (const id of selection) {
    related.add(id);
    for (const a of ancestorsOf(scene, id)) related.add(a.id);
  }
  const selected = new Set(selection);
  return all.filter((c) => related.has(c.targetId) || c.tracks.some((t) => selected.has(t.nodeId)));
}

/** The possible targets of a clip: frames and groups of the document (with a cap), plus `include` if missing. */
export function targetCandidates(scene: SceneState, include: string, limit = 300): NodeLite[] {
  const out: NodeLite[] = [];
  for (const n of scene.nodes.values()) {
    if (n.kind === "frame" || n.kind === "group") {
      out.push(n);
      if (out.length >= limit) break;
    }
  }
  const inc = scene.nodes.get(include);
  if (inc && !out.some((n) => n.id === include)) out.push(inc);
  return out;
}
