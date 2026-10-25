import type { Annotation as PbAnnotation, ReadyForDev as PbReady } from "../gen/opendesigner/v1/opendesigner_pb";
import type { AnnotationLite, ReadyLite, SceneState } from "./types";

// DEV MODE: the TypeScript twin of internal/core/devmode.go. Go is the authority; every rule here
// repeats one there. Annotations are notes for the developer attached to a node; a ready frame is
// a frame the designer handed over (the server keeps its snapshot, the editor only needs the mark).

export const MAX_ANNOTATION_RUNES = 2000;
export const MAX_READY_NOTE_RUNES = 500;
export const MAX_DEV_AUTHOR_RUNES = 80;

/** The annotation categories, in display order, with the colour each is drawn with (core.AnnotationColors). */
export const ANNOTATION_CATEGORIES = [
  { id: "note", label: "Note", color: "#8a8f98" },
  { id: "interaction", label: "Interaction", color: "#3b82f6" },
  { id: "accessibility", label: "Accessibility", color: "#22c55e" },
  { id: "content", label: "Content", color: "#f59e0b" },
  { id: "animation", label: "Animation", color: "#a855f7" },
  { id: "layout", label: "Layout", color: "#ef4444" },
] as const;

export type AnnotationCategory = (typeof ANNOTATION_CATEGORIES)[number]["id"];

export function categoryColor(id: string): string {
  return ANNOTATION_CATEGORIES.find((c) => c.id === id)?.color ?? "#8a8f98";
}

const runes = (s: string) => [...s].length;

/** Parity with core.validateAnnotation. */
export function isValidAnnotation(state: SceneState, a: PbAnnotation | undefined): a is PbAnnotation {
  if (!a || a.id === "") return false;
  if (!ANNOTATION_CATEGORIES.some((c) => c.id === a.category)) return false;
  const n = runes(a.text);
  if (n === 0 || n > MAX_ANNOTATION_RUNES) return false;
  if (runes(a.author) > MAX_DEV_AUTHOR_RUNES) return false;
  if (a.createdAt < 0n) return false;
  return state.nodes.has(a.nodeId);
}

/** Parity with core.validateReady: only an existing FRAME, with a short note. */
export function isValidReady(state: SceneState, r: PbReady | undefined): r is PbReady {
  if (!r || r.nodeId === "") return false;
  if (state.nodes.get(r.nodeId)?.kind !== "frame") return false;
  if (runes(r.note) > MAX_READY_NOTE_RUNES) return false;
  if (runes(r.markedBy) > MAX_DEV_AUTHOR_RUNES) return false;
  return r.markedAt >= 0n;
}

const EMPTY_ANN: Record<string, AnnotationLite> = {};
const EMPTY_READY: Record<string, ReadyLite> = {};

export const annotationsOfScene = (state: SceneState) => state.dev?.annotations ?? EMPTY_ANN;
export const readyOfScene = (state: SceneState) => state.dev?.ready ?? EMPTY_READY;

/** The annotations of a node, oldest first (then by id), like core.AnnotationsOf. */
export function annotationsOf(state: SceneState, nodeId: string): AnnotationLite[] {
  return Object.values(annotationsOfScene(state))
    .filter((a) => a.nodeId === nodeId)
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Every annotation of the node and of its descendants (what the ready list shows for a frame). */
export function annotationsInside(state: SceneState, frameId: string): AnnotationLite[] {
  const all = Object.values(annotationsOfScene(state));
  if (all.length === 0) return [];
  const inside = (id: string): boolean => {
    for (let cur = state.nodes.get(id), guard = 0; cur && guard < 10000; cur = state.nodes.get(cur.parentId), guard++) {
      if (cur.id === frameId) return true;
    }
    return false;
  };
  return all
    .filter((a) => inside(a.nodeId))
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The frames marked ready, oldest marking first (then by id), like core.ReadyFrames. */
export function readyFrames(state: SceneState): ReadyLite[] {
  return Object.values(readyOfScene(state)).sort((a, b) => a.markedAt - b.markedAt || (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0));
}
