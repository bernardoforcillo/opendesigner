import type { ClipLite, KeyframeLite, NodeLite, SceneState, TrackLite } from "../store/types";
import { ancestorsOf } from "../store/tree";
import { sampleTrack, type TrackProp } from "./engine";
import { canDraw } from "./pose";

// LA LOGICA DELLA TIMELINE: funzioni PURE sulla clip, senza DOM né store.
//
// Ogni funzione prende una clip e ne restituisce una NUOVA (mai muta quella in
// ingresso): è ciò che permette alla UI di tenere la bozza di un trascinamento
// come stato locale e di mandare UN SOLO `SetClip` al rilascio -- e all'undo di
// tornare indietro di un passo anche per un gesto che ha toccato dieci keyframe.
// I vincoli del validatore (tempi in [0, durata], ordinati; opacity e draw in
// 0..1; una traccia ha sempre almeno un keyframe) sono mantenuti qui, così una
// clip uscita da queste funzioni è sempre accettata da `SetClip`.

/** Il passo della griglia di aggancio, ms (≈ un frame a 100 fps; due a 50). */
export const SNAP_MS = 10;
/** L'easing dei keyframe creati dall'editor. */
export const DEFAULT_EASING = "easeInOut";
/** La durata massima ammessa per una clip nell'editor (un'ora: oltre è quasi di sicuro un refuso). */
export const MAX_DURATION_MS = 3_600_000;

/** Un keyframe: l'indice della traccia nella clip e quello del keyframe nella traccia. */
export interface KeyRef { track: number; key: number }

export const sameKey = (a: KeyRef, b: KeyRef) => a.track === b.track && a.key === b.key;

// --- valori ----------------------------------------------------------------------

/** Porta un valore dentro i limiti della proprietà (opacity e draw in 0..1); NaN -> `fallback`. */
export function clampValue(prop: string, v: number, fallback = 0): number {
  if (!Number.isFinite(v)) return fallback;
  return prop === "opacity" || prop === "draw" ? Math.min(1, Math.max(0, v)) : v;
}

/** Il valore di BASE di una proprietà di un nodo (quello che vale senza animazione). */
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

/** Le proprietà animabili di un nodo (draw solo se ha un tracciato). */
export function propsFor(n: Pick<NodeLite, "kind">): TrackProp[] {
  const p: TrackProp[] = ["opacity", "x", "y", "scale", "rotation"];
  if (canDraw(n)) p.push("draw");
  return p;
}

export const PROP_LABEL: Record<string, string> = {
  opacity: "Opacità", x: "X", y: "Y", scale: "Scala", rotation: "Rotazione", draw: "Tracciato",
};
export const PROP_UNIT: Record<string, string> = { opacity: "", x: "px", y: "px", scale: "×", rotation: "°", draw: "" };

// --- le tracce -------------------------------------------------------------------

const withTracks = (clip: ClipLite, tracks: TrackLite[]): ClipLite => ({ ...clip, tracks });

export function findTrack(clip: ClipLite, nodeId: string, prop: string): number {
  return clip.tracks.findIndex((t) => t.nodeId === nodeId && t.prop === prop);
}

/**
 * Aggiunge una traccia (nodo, proprietà) con UN keyframe a `time` col valore
 * dato. Se la traccia c'è già la clip torna invariata (stessa identità): una
 * coppia (nodo, proprietà) compare una volta sola per clip.
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
 * Una traccia NUOVA per (nodo, proprietà) già pronta da modificare: due keyframe,
 * all'inizio e alla fine, col valore di base del nodo (la clip parte e finisce dove
 * il nodo sta; il designer ne cambia uno). `draw` fa eccezione: è l'animazione
 * "si disegna", da 0 a 1. Se la traccia c'è già la clip torna invariata.
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

/** Toglie dalla clip le tracce dei nodi non più presenti (dopo una cancellazione). */
export function pruneTracks(clip: ClipLite, exists: (nodeId: string) => boolean): ClipLite {
  const tracks = clip.tracks.filter((t) => exists(t.nodeId));
  return tracks.length === clip.tracks.length ? clip : withTracks(clip, tracks);
}

// --- i keyframe ------------------------------------------------------------------

const byTime = (a: KeyframeLite, b: KeyframeLite) => a.time - b.time;

/** Inserisce (o, se c'è già un keyframe esattamente a quel tempo, sostituisce) un keyframe; torna anche il suo riferimento. */
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
  // dopo i keyframe con tempo <= t, così un keyframe nuovo a un tempo già occupato non scavalca mai
  let at = kf.length;
  while (at > 0 && kf[at - 1].time > t) at--;
  kf.splice(at, 0, { time: t, value: v, easing });
  return { clip: withKeys(clip, track, kf), ref: { track, key: at } };
}

function withKeys(clip: ClipLite, track: number, keyframes: KeyframeLite[]): ClipLite {
  return withTracks(clip, clip.tracks.map((t, i) => (i === track ? { ...t, keyframes } : t)));
}

/** Modifica valore / easing / tempo di UN keyframe. Il tempo si porta in [0, durata] e la traccia si riordina. */
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
  // collisione con un altro keyframe allo stesso tempo: quello che si muove sostituisce
  const clash = kf.findIndex((k) => k.time === next.time);
  if (clash >= 0) kf.splice(clash, 1);
  let at = kf.length;
  while (at > 0 && kf[at - 1].time > next.time) at--;
  kf.splice(at, 0, next);
  return { clip: withKeys(clip, ref.track, kf), ref: { track: ref.track, key: at } };
}

/** Cancella i keyframe indicati; una traccia rimasta senza keyframe sparisce (una traccia vuota non è valida). */
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
 * Sposta i keyframe selezionati di `delta` ms (tutti dello stesso passo: il
 * gruppo non si deforma). Il delta si limita perché nessuno esca da [0, durata]
 * e il risultato si riordina; un keyframe che atterra su uno NON selezionato
 * della stessa traccia lo sostituisce. Torna la clip e i riferimenti nuovi.
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
 * Duplica i keyframe selezionati: la copia del PRIMO (il più a sinistra) cade a
 * `atTime`, gli altri mantengono le distanze; il gruppo si porta dentro la durata.
 * Una copia che cade su un keyframe esistente lo sostituisce. Torna i
 * riferimenti delle copie (la nuova selezione).
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

// --- il tempo --------------------------------------------------------------------

/**
 * Aggancia un tempo: alla griglia di SNAP_MS e ai tempi `others` (altri keyframe,
 * il playhead) entro `thresholdMs`; i tempi degli altri vincono sulla griglia.
 * `free` (Maiusc) salta l'aggancio e arrotonda al ms. Sempre dentro [0, durata].
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

/** I tempi di tutti i keyframe NON indicati (i bersagli di aggancio di un trascinamento). */
export function timesExcluding(clip: ClipLite, sel: readonly KeyRef[]): number[] {
  const skip = new Set(sel.map((r) => `${r.track}:${r.key}`));
  const out: number[] = [];
  clip.tracks.forEach((t, ti) => t.keyframes.forEach((k, ki) => { if (!skip.has(`${ti}:${ki}`)) out.push(k.time); }));
  return out;
}

/**
 * Il delta di un trascinamento: il keyframe "afferrato" (il primario) va a
 * `grabbedStart + rawDelta`, agganciato come snapTime; il delta risultante vale
 * per tutto il gruppo.
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

/** Cambia la durata: i keyframe oltre la nuova fine si portano alla fine (la clip resta valida). */
export function withDuration(clip: ClipLite, duration: number): ClipLite {
  const d = Math.min(MAX_DURATION_MS, Math.max(SNAP_MS, Number.isFinite(duration) ? duration : clip.duration));
  if (d === clip.duration) return clip;
  const tracks = clip.tracks.map((t) => {
    if (t.keyframes.every((k) => k.time <= d)) return t;
    const kf = t.keyframes.map((k) => (k.time > d ? { ...k, time: d } : k));
    // più keyframe finiti sulla stessa fine = uno scatto inutile: resta l'ultimo
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

/** Una modifica di una proprietà animabile di un nodo, il valore in coordinate di documento. */
export interface PropChange { nodeId: string; prop: string; value: number }

/**
 * La clip con le modifiche scritte come keyframe a `time`: nella traccia
 * (nodo, proprietà) c'è già un keyframe a quel tempo -> ne cambia il valore; sennò
 * ne inserisce uno. Una traccia NUOVA a un tempo > 0 riceve anche un keyframe a 0
 * col valore che il nodo aveva prima (`before`): registrare a 600 ms la prima
 * volta fa partire l'animazione da dov'era, invece di tenere il valore nuovo fino
 * a 600 ms (che per chi ha mosso un nodo sarebbe "non succede niente").
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

/** Il valore di una traccia al tempo `t` (per aggiungere un keyframe "dove si è"). */
export function valueAt(clip: ClipLite, track: number, t: number): number | undefined {
  const tr = clip.tracks[track];
  if (!tr) return undefined;
  const v = sampleTrack(tr, t);
  return Number.isNaN(v) ? undefined : v;
}

// --- il righello -----------------------------------------------------------------

const NICE_STEPS = [10, 20, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10_000, 30_000, 60_000, 300_000];

/** Il passo "tondo" (ms) tra due tacche principali perché distino almeno `minPx` a questo zoom. */
export function rulerStep(pxPerMs: number, minPx = 64): number {
  for (const s of NICE_STEPS) if (s * pxPerMs >= minPx) return s;
  return NICE_STEPS[NICE_STEPS.length - 1];
}

export interface Tick { t: number; major: boolean }

/** Le tacche da `from` a `to` ms: principali ogni `rulerStep`, secondarie a un quinto. */
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

/** "250 ms", "1,2 s", "1:05": l'etichetta di una tacca o del tempo corrente. */
export function formatTime(ms: number): string {
  const a = Math.abs(ms);
  if (a < 1000) return `${Math.round(ms)} ms`;
  if (a < 60_000) return `${(ms / 1000).toLocaleString("it-IT", { maximumFractionDigits: 2 })} s`;
  const m = Math.floor(a / 60_000);
  const s = Math.floor((a % 60_000) / 1000);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Il tempo come in un cronometro: "0:01.250". */
export function formatClock(ms: number): string {
  const t = Math.max(0, Math.round(ms));
  const m = Math.floor(t / 60_000);
  const s = Math.floor((t % 60_000) / 1000);
  return `${m}:${String(s).padStart(2, "0")}.${String(t % 1000).padStart(3, "0")}`;
}

// --- clip e bersaglio ------------------------------------------------------------

/**
 * Il bersaglio di default di una clip creata per la selezione: il contenitore
 * (frame o gruppo) più vicino al primo nodo selezionato, il nodo stesso incluso se
 * lo è; senza contenitori, il nodo stesso. "" se la selezione è vuota.
 */
export function defaultTargetId(scene: SceneState, selection: readonly string[]): string {
  const first = selection.length > 0 ? scene.nodes.at(selection[0]) : undefined;
  if (!first) return "";
  const isContainer = (n: NodeLite) => n.kind === "frame" || n.kind === "group";
  if (isContainer(first)) return first.id;
  for (const a of ancestorsOf(scene, first.id)) if (isContainer(a)) return a.id;
  return first.id;
}

/** `nodeId` sta dentro (o è) `targetId`? Le tracce di una clip devono stare nel suo bersaglio. */
export function isInside(scene: SceneState, nodeId: string, targetId: string): boolean {
  if (nodeId === targetId) return true;
  return ancestorsOf(scene, nodeId).some((a) => a.id === targetId);
}

/** Un nome libero "Clip N" per il documento. */
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
 * Il valore in gradi congruente a `deg` (mod 360) più vicino a `ref`. La rotazione
 * del modello sta in [0, 360): registrare 10° dopo 350° farebbe interpolare la
 * traccia a ritroso per 340° invece di avanzare di 20°. Qui si sceglie la
 * determinazione che NON salta, così la traccia può uscire da [0, 360) (è
 * ammesso: `rotation` è un numero finito qualunque).
 */
export function unwrapDegrees(deg: number, ref: number): number {
  if (!Number.isFinite(deg) || !Number.isFinite(ref)) return deg;
  return deg + 360 * Math.round((ref - deg) / 360);
}

/**
 * Le clip "della selezione": quelle il cui bersaglio è un antenato (o sé) dei nodi
 * selezionati o che hanno una traccia su uno di essi. Per il filtro della lista
 * quando si lavora dentro una schermata o un gruppo. Selezione vuota = tutte.
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

/** I bersagli possibili di una clip: frame e gruppi del documento (con un tetto), più `include` se manca. */
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
