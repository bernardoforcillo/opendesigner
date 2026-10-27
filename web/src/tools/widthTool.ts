import { useScene } from "@/store/store";
import type { NodeLite, WidthPointLite } from "@/store/types";
import { hitTest } from "@/renderer/canvasRenderer";
import { PEN_ANCHOR_GRAB_PX } from "@/renderer/overlayRenderer";
import { editable } from "@/vector/editOps";
import {
  dragWidth, insertWidthPoint, locateOnPath, pickWidthHandle, profileOf, removeWidthPoint, sampleAt, setWidthProfileOps,
  widthHandles, widthStrokeOf,
} from "@/vector/widthEdit";
import type { Tool } from "@/tools/types";

// THE VARIABLE WIDTH TOOL (W): edits the width profile of the selected vector's stroke (docs/vector.md).
// A click on the path adds a width point there (the stroke keeps its shape); dragging one of a point's two
// handles sets the width of that side (Alt: both sides); Delete removes the selected point; Escape abandons
// a drag. Each drag is ONE gesture. The rules are in vector/widthEdit.ts; this file turns pointer events
// into them.

type Drag = { node: NodeLite; index: number; side: "left" | "right"; sub: number; started: boolean; sx: number; sy: number };

function targetNode(): NodeLite | null {
  const { scene, selection } = useScene.getState();
  if (!scene || selection.length !== 1) return null;
  const n = scene.nodes.get(selection[0]);
  return editable(n) ? n : null;
}

export function createWidthTool(): Tool {
  let drag: Drag | null = null;
  const setSel = (sel: number | null) => useScene.getState().setWidthEdit({ sel });

  // The profile with the drag applied for the pointer at the node-local (lx, ly): the side's distance off the
  // path, measured along the left normal at the point.
  const dragged = (d: Drag, lx: number, ly: number, both: boolean): WidthPointLite[] => {
    const profile = profileOf(d.node);
    const stroke = widthStrokeOf(d.node);
    const p = profile[d.index];
    const sample = p ? sampleAt(d.node.vector!.subpaths, d.sub, p.position) : null;
    if (!stroke || !sample) return [...profile];
    const sign = d.side === "left" ? 1 : -1;
    const dist = sign * ((lx - sample.x) * sample.nx + (ly - sample.y) * sample.ny);
    return dragWidth(profile, d.index, d.side, dist, stroke.weight, both);
  };

  return {
    id: "width",
    cursor: "default",

    onPointerDown(e, ctx) {
      const st = useScene.getState();
      const n = targetNode();
      const w = ctx.toWorld(e);
      const tol = PEN_ANCHOR_GRAB_PX / ctx.getCamera().zoom;
      if (n) {
        const lx = w.x - n.x, ly = w.y - n.y;
        const handle = pickWidthHandle(widthHandles(n), lx, ly, tol);
        if (handle) {
          setSel(handle.index);
          drag = { node: n, index: handle.index, side: handle.side, sub: handle.sub, started: false, sx: e.clientX, sy: e.clientY };
          return;
        }
        const on = locateOnPath(n.vector!.subpaths, lx, ly, tol);
        if (on) {
          // A click on the path adds a point there; the stroke is unchanged until a handle moves.
          const ins = insertWidthPoint(profileOf(n), on.t);
          if (ins) {
            const ops = setWidthProfileOps(n, ins.profile);
            if (ops.length > 0) {
              st.beginGesture();
              st.endGesture(ops);
            }
            setSel(ins.index);
          }
          return;
        }
      }
      // Empty space: pick another vector, or drop the point selection.
      const scene = ctx.getScene();
      const hit = scene ? hitTest(scene, w.x, w.y, ctx.getCamera().zoom, st.currentPageId) : null;
      const hitNode = hit ? scene!.nodes.get(hit) : undefined;
      setSel(null);
      if (hitNode && hitNode.kind === "vector") st.setSelection([hitNode.id]);
    },

    onPointerMove(e, ctx) {
      if (!drag) return;
      const st = useScene.getState();
      if (!drag.started) {
        if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 3) return;
        drag.started = true;
        st.beginGesture();
      }
      const w = ctx.toWorld(e);
      // Each step is computed from the START node, so the drag never compounds.
      for (const op of setWidthProfileOps(drag.node, dragged(drag, w.x - drag.node.x, w.y - drag.node.y, e.altKey))) st.applyLocal(op);
    },

    onPointerUp(e, ctx) {
      if (!drag) return;
      const d = drag;
      drag = null;
      if (!d.started) return;
      const w = ctx.toWorld(e);
      useScene.getState().endGesture(setWidthProfileOps(d.node, dragged(d, w.x - d.node.x, w.y - d.node.y, e.altKey)));
    },

    onKeyDown(e) {
      const st = useScene.getState();
      if (e.key === "Escape" && drag) {
        st.cancelGesture();
        drag = null;
        return;
      }
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const n = targetNode();
      const sel = st.widthEdit?.sel;
      if (!n || sel === null || sel === undefined || !profileOf(n)[sel]) return;
      e.preventDefault();
      st.beginGesture();
      st.endGesture(setWidthProfileOps(n, removeWidthPoint(profileOf(n), sel)));
      setSel(null);
    },

    onDeactivate() {
      if (drag) {
        useScene.getState().cancelGesture();
        drag = null;
      }
    },
  };
}

export const widthTool = createWidthTool();
