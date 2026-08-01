import { hitTest } from "../renderer/canvasRenderer";
import { normalizeRect, boundsOfNode, boundsIntersect, type Bounds } from "../canvas/geometry";
import { useScene } from "../store/store";
import { makeDeleteOp, makeSetPropsOp } from "./ops";
import type { SceneState } from "../store/types";
import type { Tool } from "./types";

export type PickResult =
  | { mode: "marquee" }
  | { mode: "single"; id?: string }
  | { mode: "toggle"; id: string };

// Decide il TIPO di gesto senza toccare lo store: pura funzione di scena +
// input, testabile senza DOM (Task 8, step 1). id assente in mode "single"
// significa "il nodo è già selezionato, non toccare la selezione" -- è la
// lettura di "selezione singola (SE NON GIÀ selezionato)" del brief: così un
// drag successivo sposta l'INTERA selezione (anche multipla) invece di
// collassarla prematuramente su un solo nodo.
export function pickTarget(
  scene: SceneState,
  world: { x: number; y: number },
  shiftKey: boolean,
  selection: string[],
): PickResult {
  const id = hitTest(scene, world.x, world.y);
  if (!id) return { mode: "marquee" };
  if (shiftKey) return { mode: "toggle", id };
  return selection.includes(id) ? { mode: "single" } : { mode: "single", id };
}

// Id dei nodi VISIBILI i cui bounds intersecano il marquee, ordinati per
// orderKey per un risultato deterministico (Object.values non garantisce
// l'ordine di inserimento per chiavi stringa).
export function nodesInMarquee(scene: SceneState, bounds: Bounds): string[] {
  return Object.values(scene.nodes)
    .filter((n) => n.visible && boundsIntersect(boundsOfNode(n), bounds))
    .sort((a, b) => (a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : 0))
    .map((n) => n.id);
}

function union(base: string[], extra: string[]): string[] {
  const seen = new Set(base);
  return [...base, ...extra.filter((id) => !seen.has(id))];
}

export function createSelectTool(): Tool {
  // --- drag di spostamento --------------------------------------------------
  // Ancora MONDO e posizione di partenza (MONDO) di ogni nodo trascinato,
  // catturate a pointerdown. Il gesto sullo store (beginGesture) viene aperto
  // in modo PIGRO al primo pointermove reale: un semplice click (down+up
  // senza move in mezzo) non deve mai aprire/chiudere un gesto a vuoto --
  // altrimenti ogni click su un nodo già selezionato spamerebbe un
  // beginGesture "misuso" nei test che testano solo onPointerDown (vedi
  // store.ts: beginGesture con un gesto già aperto avvisa e non annidano).
  let dragAnchor: { x: number; y: number } | null = null;
  let dragStart: Record<string, { x: number; y: number }> | null = null;
  let dragStarted = false;

  // --- marquee ---------------------------------------------------------------
  let marqueeAnchor: { x: number; y: number } | null = null;
  let marqueeBase: string[] | null = null;
  let preMarqueeSelection: string[] | null = null;

  function resetDrag() {
    dragAnchor = null;
    dragStart = null;
    dragStarted = false;
  }

  function resetMarquee() {
    marqueeAnchor = null;
    marqueeBase = null;
    preMarqueeSelection = null;
    useScene.getState().setMarquee(null);
  }

  return {
    id: "select",
    cursor: "default",

    onPointerDown(e, ctx) {
      const scene = ctx.getScene();
      if (!scene) return;
      const world = ctx.toWorld(e);
      const store = useScene.getState();
      const target = pickTarget(scene, world, e.shiftKey, store.selection);

      if (target.mode === "marquee") {
        // shift+click sul vuoto non azzera: è l'inizio di un'aggiunta (unione
        // con la selezione corrente a pointerup).
        const base = e.shiftKey ? store.selection : [];
        preMarqueeSelection = store.selection;
        if (!e.shiftKey) store.clearSelection();
        marqueeBase = base;
        marqueeAnchor = world;
        store.setMarquee({ x: world.x, y: world.y, width: 0, height: 0 });
        return;
      }

      if (target.mode === "toggle") store.toggleSelection(target.id);
      else if (target.id) store.setSelection([target.id]);
      // target.mode === "single" senza id: nodo già selezionato, nessun
      // cambio -- il drag qui sotto userà la selezione (multipla) esistente.

      const selection = useScene.getState().selection;
      const start: Record<string, { x: number; y: number }> = {};
      for (const sid of selection) {
        const n = scene.nodes[sid];
        if (n) start[sid] = { x: n.x, y: n.y };
      }
      dragAnchor = world;
      dragStart = start;
      dragStarted = false;
    },

    onPointerMove(e, ctx) {
      if (marqueeAnchor) {
        const world = ctx.toWorld(e);
        useScene.getState().setMarquee(normalizeRect(marqueeAnchor.x, marqueeAnchor.y, world.x, world.y));
        return;
      }
      if (!dragAnchor || !dragStart) return;
      if (!dragStarted) {
        dragStarted = true;
        useScene.getState().beginGesture();
      }
      const world = ctx.toWorld(e);
      const dx = world.x - dragAnchor.x;
      const dy = world.y - dragAnchor.y;
      for (const [id, start] of Object.entries(dragStart)) {
        useScene.getState().applyLocal(makeSetPropsOp(id, { x: start.x + dx, y: start.y + dy }, ["x", "y"]));
      }
    },

    onPointerUp(e, ctx) {
      if (marqueeAnchor) {
        const scene = ctx.getScene();
        const world = ctx.toWorld(e);
        const box = normalizeRect(marqueeAnchor.x, marqueeAnchor.y, world.x, world.y);
        const inside = scene ? nodesInMarquee(scene, box) : [];
        useScene.getState().setSelection(union(marqueeBase ?? [], inside));
        resetMarquee();
        return;
      }
      if (!dragAnchor || !dragStart) return;
      if (dragStarted) {
        const world = ctx.toWorld(e);
        const dx = world.x - dragAnchor.x;
        const dy = world.y - dragAnchor.y;
        const finalOps = Object.entries(dragStart).map(([id, start]) =>
          makeSetPropsOp(id, { x: start.x + dx, y: start.y + dy }, ["x", "y"]));
        useScene.getState().endGesture(finalOps);
      }
      resetDrag();
    },

    onKeyDown(e) {
      if (e.key === "Escape") {
        if (marqueeAnchor) {
          useScene.getState().setSelection(preMarqueeSelection ?? []);
          resetMarquee();
        } else if (dragAnchor) {
          if (dragStarted) useScene.getState().cancelGesture();
          resetDrag();
        }
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        const store = useScene.getState();
        const ids = store.selection;
        if (ids.length === 0) return;
        store.beginGesture();
        store.endGesture(ids.map((id) => makeDeleteOp(id)));
      }
    },

    // Gesto abbandonato (cambio tool, pointercancel, smontaggio): nessun op.
    onDeactivate() {
      if (marqueeAnchor) {
        useScene.getState().setSelection(preMarqueeSelection ?? []);
        resetMarquee();
      }
      if (dragAnchor) {
        if (dragStarted) useScene.getState().cancelGesture();
        resetDrag();
      }
    },
  };
}

export const selectTool = createSelectTool();
