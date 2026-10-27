import { useScene } from "@/store/store";
import type { NodeLite, SceneState } from "@/store/types";
import { hitTest } from "@/renderer/canvasRenderer";
import { builderFaces, builderSources, faceContains, facesAlong, shapeBuilderOps } from "@/vector/shapeBuilder";
import type { BuilderMode, Face } from "@/vector/shapeBuilder";
import type { Tool } from "@/tools/types";

// THE SHAPE BUILDER TOOL (M): with two or more overlapping shapes selected, click a region to take it as
// a shape of its own, or drag across several to merge them into one; Alt removes the regions instead.
// With fewer than two shapes selected a click on a shape adds it to the selection. The regions are
// vector/shapeBuilder.ts's; one gesture is ONE undo step.

const STEP = 1;

export function createBuilderTool(): Tool {
  let drag: { path: { x: number; y: number }[] } | null = null;
  let cache: { scene: SceneState; key: string; sources: NodeLite[]; faces: Face[] } | null = null;

  // The sources and faces of the current selection, recomputed only when the scene or the selection changes.
  const current = () => {
    const { scene, selection } = useScene.getState();
    if (!scene) return null;
    const key = selection.join(",");
    if (!cache || cache.scene !== scene || cache.key !== key) {
      const sources = builderSources(scene, selection);
      cache = { scene, key, sources, faces: sources.length >= 2 ? builderFaces(scene, sources) : [] };
    }
    return cache;
  };
  const preview = (faces: Face[], picked: readonly number[], mode: BuilderMode) =>
    useScene.getState().setBuilderPreview(picked.length === 0 ? null : { faces: picked.map((i) => faces[i].polygon as [number, number][][]), mode });
  const modeOf = (e: PointerEvent): BuilderMode => (e.altKey ? "remove" : "merge");

  return {
    id: "builder",
    cursor: "crosshair",

    onPointerDown(e, ctx) {
      const w = ctx.toWorld(e);
      const c = current();
      if (c && c.faces.length > 0) {
        drag = { path: [w] };
        preview(c.faces, facesAlong(c.faces, drag.path, STEP), modeOf(e));
        return;
      }
      // Fewer than two shapes: a click on a shape adds it to the selection.
      const st = useScene.getState();
      const scene = ctx.getScene();
      const hit = scene ? hitTest(scene, w.x, w.y, ctx.getCamera().zoom, st.currentPageId) : null;
      if (hit) st.setSelection(st.selection.includes(hit) ? st.selection : [...st.selection, hit]);
    },

    onPointerMove(e, ctx) {
      const c = current();
      if (!c || c.faces.length === 0) return;
      const w = ctx.toWorld(e);
      if (drag) {
        const last = drag.path[drag.path.length - 1];
        if (Math.hypot(w.x - last.x, w.y - last.y) >= STEP) drag.path.push(w);
        preview(c.faces, facesAlong(c.faces, drag.path, STEP), modeOf(e));
        return;
      }
      // Hover: the region a click would take.
      const at = c.faces.findIndex((f) => faceContains(f, w.x, w.y));
      preview(c.faces, at < 0 ? [] : [at], modeOf(e));
    },

    onPointerUp(e, ctx) {
      if (!drag) return;
      const path = [...drag.path, ctx.toWorld(e)];
      drag = null;
      const st = useScene.getState();
      st.setBuilderPreview(null);
      const c = current();
      const scene = ctx.getScene();
      if (!c || !scene) return;
      const res = shapeBuilderOps(scene, c.sources, c.faces, facesAlong(c.faces, path, STEP), modeOf(e));
      if (!res) return;
      st.beginGesture();
      st.endGesture(res.ops);
      st.setSelection(res.selection);
    },

    onKeyDown(e) {
      if (e.key === "Escape" && drag) {
        drag = null;
        useScene.getState().setBuilderPreview(null);
      }
    },

    onDeactivate() {
      drag = null;
      cache = null;
      useScene.getState().setBuilderPreview(null);
    },
  };
}

export const builderTool = createBuilderTool();
