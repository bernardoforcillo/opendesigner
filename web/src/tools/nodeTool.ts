import { useScene } from "../store/store";
import type { NodeLite, SubPathLite } from "../store/types";
import { hitTest } from "../renderer/canvasRenderer";
import { PEN_ANCHOR_GRAB_PX } from "../renderer/overlayRenderer";
import { editable, setPathOps } from "../vector/editOps";
import {
  deleteAnchor, insertAnchor, isSmooth, makeCorner, makeSmooth, moveAnchor, moveHandle, nearestOnPath,
} from "../vector/pathOps";
import { hasInHandle, hasOutHandle } from "../store/vectorGeometry";
import { makeDeleteOp } from "./ops";
import type { Tool } from "./types";

// THE NODE TOOL (N): edit the anchors of a vector. On the selected vector it drags anchors and their
// handles, a click on the outline adds an anchor there, a double click on an anchor flips it between
// corner and smooth, Delete removes the selected anchor. Each drag is ONE gesture. The geometry
// rules are in vector/pathOps.ts; this file only turns pointer events into them.

const DOUBLE_CLICK_MS = 350;

/** What the pointer is on, in the node's local space. */
export type NodeTarget =
  | { kind: "handle"; sub: number; index: number; which: "in" | "out" }
  | { kind: "anchor"; sub: number; index: number }
  | { kind: "segment"; sub: number; seg: number; t: number }
  | null;

/** The handle, anchor or segment at (lx, ly): handles of the selected anchor first, then anchors, then the outline. */
export function pickNodeTarget(
  subpaths: readonly SubPathLite[], lx: number, ly: number, tol: number, selected: { sub: number; index: number } | null,
): NodeTarget {
  if (selected) {
    const a = subpaths[selected.sub]?.anchors[selected.index];
    if (a) {
      if (hasOutHandle(a) && Math.hypot(a.x + a.outX - lx, a.y + a.outY - ly) <= tol) return { kind: "handle", ...selected, which: "out" };
      if (hasInHandle(a) && Math.hypot(a.x + a.inX - lx, a.y + a.inY - ly) <= tol) return { kind: "handle", ...selected, which: "in" };
    }
  }
  let best: { sub: number; index: number; d: number } | null = null;
  subpaths.forEach((sp, sub) => sp.anchors.forEach((a, index) => {
    const d = Math.hypot(a.x - lx, a.y - ly);
    if (d <= tol && (!best || d < best.d)) best = { sub, index, d };
  }));
  if (best) return { kind: "anchor", sub: (best as { sub: number }).sub, index: (best as { index: number }).index };
  let seg: { sub: number; seg: number; t: number; dist: number } | null = null;
  subpaths.forEach((sp, sub) => {
    const h = nearestOnPath(sp, lx, ly, tol);
    if (h && (!seg || h.dist < seg.dist)) seg = { sub, seg: h.seg, t: h.t, dist: h.dist };
  });
  return seg ? { kind: "segment", sub: (seg as { sub: number }).sub, seg: (seg as { seg: number }).seg, t: (seg as { t: number }).t } : null;
}

function targetNode(): NodeLite | null {
  const { scene, selection } = useScene.getState();
  if (!scene || selection.length !== 1) return null;
  const n = scene.nodes.at(selection[0]);
  return editable(n) ? n : null;
}

const replace = (sps: readonly SubPathLite[], i: number, sp: SubPathLite | null): SubPathLite[] =>
  sp ? sps.map((s, k) => (k === i ? sp : s)) : sps.filter((_, k) => k !== i);

export function createNodeTool(): Tool {
  type Drag =
    | { kind: "anchor"; sub: number; index: number; node: NodeLite; started: boolean; sx: number; sy: number }
    | { kind: "handle"; sub: number; index: number; which: "in" | "out"; node: NodeLite; started: boolean; sx: number; sy: number };
  let drag: Drag | null = null;
  let lastClick: { t: number; sub: number; index: number } | null = null;

  const setSel = (sel: { sub: number; index: number } | null) => useScene.getState().setNodeEdit({ sel });

  // The path with the drag applied for the pointer at (lx, ly).
  const dragged = (d: Drag, lx: number, ly: number, alt: boolean): SubPathLite[] => {
    const sps = d.node.vector!.subpaths;
    const sp = sps[d.sub];
    return replace(sps, d.sub, d.kind === "anchor" ? moveAnchor(sp, d.index, lx, ly) : moveHandle(sp, d.index, d.which, lx, ly, alt));
  };
  const local = (n: NodeLite, p: { x: number; y: number }) => ({ x: p.x - n.x, y: p.y - n.y });

  return {
    id: "node",
    cursor: "default",

    onPointerDown(e, ctx) {
      const st = useScene.getState();
      const n = targetNode();
      const w = ctx.toWorld(e);
      const tol = PEN_ANCHOR_GRAB_PX / ctx.getCamera().zoom;
      const sel = st.nodeEdit?.sel ?? null;
      const target = n ? pickNodeTarget(n.vector!.subpaths, w.x - n.x, w.y - n.y, tol, sel) : null;
      if (n && target?.kind === "handle") {
        drag = { ...target, node: n, started: false, sx: e.clientX, sy: e.clientY };
        return;
      }
      if (n && target?.kind === "anchor") {
        const now = Date.now();
        const again = lastClick && now - lastClick.t < DOUBLE_CLICK_MS && lastClick.sub === target.sub && lastClick.index === target.index;
        lastClick = { t: now, sub: target.sub, index: target.index };
        setSel({ sub: target.sub, index: target.index });
        if (again) {
          // Double click: flip between corner and smooth.
          const sp = n.vector!.subpaths[target.sub];
          const next = isSmooth(sp.anchors[target.index]) || hasInHandle(sp.anchors[target.index]) || hasOutHandle(sp.anchors[target.index])
            ? makeCorner(sp, target.index) : makeSmooth(sp, target.index);
          st.beginGesture();
          st.endGesture(setPathOps(n, replace(n.vector!.subpaths, target.sub, next)));
          drag = null;
          return;
        }
        drag = { ...target, node: n, started: false, sx: e.clientX, sy: e.clientY };
        return;
      }
      if (n && target?.kind === "segment") {
        // A click on the outline adds an anchor there and picks it up.
        const sp = n.vector!.subpaths[target.sub];
        const inserted = insertAnchor(sp, target.seg, target.t);
        const index = target.seg + 1;
        const next = replace(n.vector!.subpaths, target.sub, inserted);
        st.beginGesture();
        for (const op of setPathOps(n, next)) st.applyLocal(op);
        const after = useScene.getState().scene?.nodes.at(n.id) ?? n;
        setSel({ sub: target.sub, index });
        drag = { kind: "anchor", sub: target.sub, index, node: after, started: true, sx: e.clientX, sy: e.clientY };
        return;
      }
      // Empty space: pick another vector, or drop the anchor selection.
      const scene = ctx.getScene();
      const hit = scene ? hitTest(scene, w.x, w.y, ctx.getCamera().zoom, st.currentPageId) : null;
      const hitNode = hit ? scene!.nodes.at(hit) : undefined;
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
      // The node's origin moves with its box as the path is refit, so each step is computed from the START node.
      const w = ctx.toWorld(e);
      const p = local(drag.node, w);
      for (const op of setPathOps(drag.node, dragged(drag, p.x, p.y, e.altKey))) st.applyLocal(op);
    },

    onPointerUp(e, ctx) {
      if (!drag) return;
      const d = drag;
      drag = null;
      if (!d.started) return;
      const w = ctx.toWorld(e);
      const p = local(d.node, w);
      useScene.getState().endGesture(setPathOps(d.node, dragged(d, p.x, p.y, e.altKey)));
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
      const sel = st.nodeEdit?.sel;
      if (!n || !sel) return;
      e.preventDefault();
      const sp = n.vector!.subpaths[sel.sub];
      if (!sp) return;
      const next = replace(n.vector!.subpaths, sel.sub, deleteAnchor(sp, sel.index));
      st.beginGesture();
      st.endGesture(next.length === 0 ? [makeDeleteOp(n.id)] : setPathOps(n, next));
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

export const nodeTool = createNodeTool();
