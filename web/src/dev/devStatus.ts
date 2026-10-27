import { useEffect, useState } from "react";
import { create } from "@bufbuild/protobuf";
import { CompareReadyRequestSchema, type Op } from "@/gen/opendesigner/v1/opendesigner_pb";
import { docClient } from "@/rpc/client";
import { useScene } from "@/store/store";
import type { SceneState } from "@/store/types";
import { readyOfScene } from "@/store/devMode";
import { makeClearReadyForDevOp, makeDeleteAnnotationOp, makeSetAnnotationOp, makeSetReadyForDevOp, uuid } from "@/tools/ops";

// DEV STATUS: what Develop adds on top of a frame -- "ready for dev", the annotations a designer
// leaves for the developer, and "Compare changes" (the frame now against its state when it was
// marked). The ops are pure (scene -> ops); the comparison is asked of the server
// (CompareReady, internal/devmode), the only place that holds the snapshot.

/**
 * The frame a Dev status applies to: the selected node when it is a frame, otherwise its nearest
 * frame ancestor. null when nothing is selected or the selection is not inside any frame.
 */
export function devFrameOf(scene: SceneState, selection: readonly string[]): string | null {
  for (let cur = selection.length > 0 ? scene.nodes.get(selection[0]) : undefined, guard = 0; cur && guard < 10000; cur = scene.nodes.get(cur.parentId), guard++) {
    if (cur.kind === "frame") return cur.id;
  }
  return null;
}

const now = () => Math.floor(Date.now() / 1000);

/** Marks the frame ready (or marks it again: the server takes a new snapshot, the new baseline). */
export function markReadyOps(nodeId: string, note: string, author: string, at: number = now()): Op[] {
  return [makeSetReadyForDevOp({ nodeId, note: note.trim(), markedBy: author, markedAt: at })];
}

export function unmarkOps(scene: SceneState, nodeId: string): Op[] {
  return readyOfScene(scene)[nodeId] ? [makeClearReadyForDevOp(nodeId)] : [];
}

/** A new annotation on a node; no ops for a blank text. */
export function annotateOps(nodeId: string, category: string, text: string, author: string, at: number = now(), id: string = uuid()): Op[] {
  const t = text.trim();
  if (t === "") return [];
  return [makeSetAnnotationOp({ id, nodeId, category, text: t, author, createdAt: at })];
}

export function deleteAnnotationOps(scene: SceneState, id: string): Op[] {
  return scene.dev?.annotations[id] ? [makeDeleteAnnotationOp(id)] : [];
}

// --- Compare changes ----------------------------------------------------------

export interface ChangeRow {
  nodeId: string;
  nodeName: string;
  kind: "added" | "removed" | "changed";
  /** Empty for an added or removed layer. */
  property: string;
  before: string;
  after: string;
}

export interface ChangeGroup {
  nodeId: string;
  nodeName: string;
  kind: ChangeRow["kind"];
  rows: ChangeRow[];
}

/** One group per layer, in the order the server reported them (geometry first within a layer). */
export function groupChanges(rows: readonly ChangeRow[]): ChangeGroup[] {
  const out: ChangeGroup[] = [];
  const by = new Map<string, ChangeGroup>();
  for (const r of rows) {
    let g = by.get(r.nodeId);
    if (!g) {
      g = { nodeId: r.nodeId, nodeName: r.nodeName, kind: r.kind, rows: [] };
      by.set(r.nodeId, g);
      out.push(g);
    }
    if (r.property !== "") g.rows.push(r);
  }
  return out;
}

/** "corner_radius" -> "Corner radius", "fills[0]" -> "Fill 1", "text.font_size" -> "Text font size". */
export function humanProperty(p: string): string {
  const indexed = /^(fills|strokes|effects|layout_grids)\[(\d+)\]$/.exec(p);
  if (indexed) {
    const singular: Record<string, string> = { fills: "Fill", strokes: "Stroke", effects: "Effect", layout_grids: "Layout grid" };
    return `${singular[indexed[1]]} ${Number(indexed[2]) + 1}`;
  }
  const s = p.replace(/\[(\d+)\]/g, " $1").replace(/[._]/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export interface Comparison {
  markedAt: number;
  changes: ChangeRow[];
}

export type CompareFetcher = (docId: string, nodeId: string, signal: AbortSignal) => Promise<Comparison>;

const defaultFetcher: CompareFetcher = async (docId, nodeId, signal) => {
  const r = await docClient.compareReady(create(CompareReadyRequestSchema, { docId, nodeId }), { signal });
  return {
    markedAt: Number(r.markedAt),
    changes: r.changes.map((c) => ({
      nodeId: c.nodeId, nodeName: c.nodeName, kind: c.kind as ChangeRow["kind"], property: c.property, before: c.before, after: c.after,
    })),
  };
};

let fetcher: CompareFetcher = defaultFetcher;
/** Replaces the transport (tests inject a fake server). With no arguments it restores. */
export function setCompareFetcher(f?: CompareFetcher): void {
  fetcher = f ?? defaultFetcher;
}

export const COMPARE_DEBOUNCE_MS = 600;

export interface ComparisonState {
  status: "idle" | "loading" | "error";
  error: string | null;
  result: Comparison | null;
}

/**
 * The comparison of a ready frame, kept up to date while mounted: asked at once, then after every
 * change of the CONFIRMED document's nodes (the server compares what it has), debounced and never
 * with a gesture open. A frame that is not ready (nodeId null) asks for nothing.
 */
export function useReadyComparison(nodeId: string | null, isReady: boolean, markedAt: number): ComparisonState {
  const [state, setState] = useState<ComparisonState>({ status: "idle", error: null, result: null });
  useEffect(() => {
    if (!nodeId || !isReady) {
      setState({ status: "idle", error: null, result: null });
      return;
    }
    let ctl: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = () => {
      const scene = useScene.getState().scene;
      if (!scene) return;
      if (useScene.getState().gesture) return schedule(COMPARE_DEBOUNCE_MS);
      ctl?.abort();
      const mine = (ctl = new AbortController());
      setState((s) => ({ ...s, status: "loading", error: null }));
      fetcher(scene.id, nodeId, mine.signal).then(
        (result) => { if (!mine.signal.aborted) setState({ status: "idle", error: null, result }); },
        (err) => { if (!mine.signal.aborted) setState((s) => ({ status: "error", error: err instanceof Error ? err.message : String(err), result: s.result })); },
      );
    };
    const schedule = (delay: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; run(); }, delay);
    };
    schedule(0);
    const unsub = useScene.subscribe((st, prev) => {
      if (st.confirmed && (!prev.confirmed || st.confirmed.nodes !== prev.confirmed.nodes)) schedule(COMPARE_DEBOUNCE_MS);
    });
    return () => {
      if (timer) clearTimeout(timer);
      ctl?.abort();
      unsub();
    };
    // markedAt: marking again is a new baseline, so the comparison is asked again.
  }, [nodeId, isReady, markedAt]);
  return state;
}
