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

// LO STATO DELLA TIMELINE: stato di VISTA, come la camera e la selezione -- non è
// documento, non passa dalla rete e non entra nell'undo. Cosa invece è documento
// (le clip, i loro keyframe) si scrive solo con `SetClip` / `DeleteClip`, UN op per
// gesto, tramite `commitClip` / `removeClip` qui sotto.
//
// Tiene anche il TRASPORTO (play, pausa, stop, scorrimento) e il suo ciclo
// requestAnimationFrame, che gira SOLO mentre si riproduce: a timeline ferma o
// chiusa l'editor non pianifica un solo frame.

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
  } catch { /* niente storage */ }
  return DEFAULT_HEIGHT;
}

export interface TimelineState {
  /** Il pannello è aperto. Chiuso, nessun costo: non si monta, non si campiona. */
  open: boolean;
  height: number;
  /** Ridotto alla sola barra del trasporto (la tela riprende lo spazio). */
  collapsed: boolean;
  /** La clip aperta nell'editor (id), o null. */
  clipId: string | null;
  /** Il tempo corrente DENTRO la clip, ms. */
  playhead: number;
  playing: boolean;
  loop: boolean;
  speed: number;
  /** "Registra": le modifiche a x, y, rotazione, opacità diventano keyframe al playhead. */
  record: boolean;
  /** La tela mostra la POSA (valori campionati) invece del documento: da quando si scorre/riproduce/registra fino a Stop. */
  posed: boolean;
  /** Ingrandimento orizzontale rispetto a "tutta la clip nello spazio" (1). */
  zoom: number;
  /** Solo le clip della selezione (schermata/gruppo) o tutte quelle del documento. */
  filterToSelection: boolean;
  /** I keyframe selezionati (indici nella clip, bozza compresa). */
  selection: KeyRef[];
  /** La clip con la bozza di un trascinamento di keyframe: si campiona al posto di quella del documento. */
  draftClip: ClipLite | null;
  /** I valori che la registrazione sta raccogliendo a metà gesto (nodo -> proprietà). */
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

// Il ciclo di riproduzione. `elapsed` è il tempo reale trascorso dall'inizio
// (ritardo compreso) e `clipTimeline` lo traduce nel tempo dentro la clip: così
// l'anteprima rispetta ripetizioni, yoyo e ritardo ESATTAMENTE come il prototipo.
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
  // Un salto lungo (scheda in secondo piano) non deve far saltare l'animazione.
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
    try { localStorage.setItem(HEIGHT_KEY, String(height)); } catch { /* niente storage */ }
    resizeSoon();
  },
  setCollapsed: (v) => {
    if (v === get().collapsed) return;
    set({ collapsed: v });
    resizeSoon();
  },
  // Aprire una clip (dalla lista, dopo averla creata o con un preset) apre anche il pannello.
  openClip: (id) => {
    cancelLoop();
    set({ open: id !== null ? true : get().open, collapsed: id !== null ? false : get().collapsed, clipId: id, playhead: 0, playing: false, posed: false, record: false, selection: [], draftClip: null, recordDraft: null });
    if (id !== null) resizeSoon();
  },
  setPlayhead: (t) => {
    const clip = sceneClip(get().clipId);
    const p = Math.min(clip?.duration ?? 0, Math.max(0, Number.isFinite(t) ? t : 0));
    cancelLoop();
    // scorrere mette in pausa e mostra la posa; il tempo reale riparte da qui
    set({ playhead: p, playing: false, posed: true });
  },
  play: () => {
    const st = get();
    const clip = sceneClip(st.clipId);
    if (!clip || st.playing) return;
    // Da fermo alla fine (e senza ripetizione) si riparte da capo.
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
    // Stop riporta al tempo 0; la posa resta solo se si sta registrando (si vede il primo fotogramma).
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

// La tela cambia altezza quando il pannello si apre/chiude/ridimensiona: il
// renderer ridisegna su invalidazione e il resize della finestra è già
// l'invalidazione che App ascolta (stessa strada di shell/panels.ts).
function resizeSoon() {
  if (typeof window !== "undefined" && typeof requestAnimationFrame !== "undefined") {
    requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  }
}

// --- le scritture sul documento ----------------------------------------------------

/** Scrive la clip INTERA con UN op in UN gesto: un passo di undo. */
export function commitClip(clip: ClipLite): void {
  const st = useScene.getState();
  st.beginGesture();
  st.endGesture([makeSetClipOp(clip)]);
}

/** Crea una clip vuota per il bersaglio e la apre. Torna la clip (o null senza bersaglio). */
export function createClip(scene: SceneState, selection: readonly string[]): ClipLite | null {
  const target = defaultTargetId(scene, selection) || scene.pages[0]?.id || "";
  // Il bersaglio deve essere un nodo: senza selezione si ripiega sul primo frame della pagina.
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
 * "+ Proprietà": aggiunge la traccia (nodo, proprietà) per ogni nodo dato alla
 * clip aperta -- o, senza clip aperta, ne crea una per il bersaglio di default e
 * la apre -- con UN SetClip. I nodi fuori dal bersaglio della clip si saltano
 * (una traccia fuori bersaglio non si esporta). Torna quante tracce ha aggiunto.
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

/** "Anima con un preset": crea la clip del preset per il nodo e la apre (UN SetClip). */
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

// --- il gancio della registrazione -------------------------------------------------

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
    // I nodi fuori dal bersaglio della clip non si registrano: si modificano normalmente.
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
    // il valore mostrato PRIMA del gesto: quello della traccia al playhead, o il valore di base del nodo
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

// Il gancio è installato SOLO mentre si registra: a registrazione spenta lo
// store lo vede null e le sue due porte sono l'identità.
useTimeline.subscribe((st, prev) => {
  if (st.record === prev.record && st.open === prev.open) return;
  setRecordHook(st.record && st.open ? hook : null);
});

// Un gesto abbandonato (Esc a metà trascinamento) non scrive niente: la bozza
// raccolta fin lì si butta, o la tela resterebbe sulla posa dell'ultima anteprima.
useScene.subscribe((st, prev) => {
  if (prev.gesture && !st.gesture && useTimeline.getState().recordDraft) useTimeline.getState().setRecordDraft(null);
});
