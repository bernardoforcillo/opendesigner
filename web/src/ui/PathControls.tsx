import { useState } from "react";
import { useScene } from "../store/store";
import { editable, joinNodesOps, offsetOps, pathToolOps, type PathTool } from "../vector/editOps";

const BTN = "h-7 flex-1 rounded-md px-2 text-[12px] text-fg-muted outline-none hover:bg-surface-3 hover:text-fg focus-visible:shadow-[var(--ring)]";

function gesture(ops: ReturnType<typeof pathToolOps>): void {
  if (ops.length === 0) return;
  const st = useScene.getState();
  st.beginGesture();
  st.endGesture(ops);
}

/** Runs a whole-path tool on the selected vector as ONE gesture. */
export function runPathTool(tool: PathTool, tolerance = 1): void {
  const st = useScene.getState();
  const n = st.selection.length === 1 ? st.scene?.nodes.at(st.selection[0]) : undefined;
  if (n) gesture(pathToolOps(n, tool, tolerance));
}

/** Grows (positive) or shrinks (negative) the selected vector's closed shapes. */
export function runOffset(distance: number): void {
  const st = useScene.getState();
  const n = st.selection.length === 1 ? st.scene?.nodes.at(st.selection[0]) : undefined;
  if (n) gesture(offsetOps(n, distance));
}

/** Joins the two selected open paths into one node. */
export function runJoin(): void {
  const st = useScene.getState();
  if (!st.scene || st.selection.length !== 2) return;
  const r = joinNodesOps(st.scene, st.selection[0], st.selection[1]);
  if (!r) return;
  st.beginGesture();
  st.setSelection(r.selection);
  st.endGesture(r.ops);
}

/**
 * Path tools for the selected vector: smooth every point, make them corners, simplify, grow or shrink the
 * shape by a distance; and with two vectors selected, join them. Anchor-level editing is the Node tool (D).
 */
export function PathControls() {
  const single = useScene((s) => {
    const n = s.selection.length === 1 ? s.scene?.nodes.at(s.selection[0]) : undefined;
    return editable(n);
  });
  const pair = useScene((s) => {
    if (s.selection.length !== 2 || !s.scene) return false;
    return s.selection.every((id) => editable(s.scene!.nodes.at(id)));
  });
  const [distance, setDistance] = useState(4);
  if (pair) {
    return (
      <div role="group" aria-label="Join paths" className="flex shrink-0 items-center gap-0.5 border-b border-line px-2 py-1.5">
        <button type="button" className={BTN} onClick={runJoin}>Join paths</button>
      </div>
    );
  }
  if (!single) return null;
  return (
    <div role="group" aria-label="Path tools" className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-line px-2 py-1.5">
      <button type="button" className={BTN} onClick={() => runPathTool("smooth")}>Smooth</button>
      <button type="button" className={BTN} onClick={() => runPathTool("corner")}>Corners</button>
      <button type="button" className={BTN} onClick={() => runPathTool("simplify", 1)}>Simplify</button>
      <span className="flex w-full items-center gap-0.5">
        <button type="button" className={BTN} onClick={() => runOffset(distance)}>Grow</button>
        <input
          aria-label="Offset distance" type="number" min={0.1} step={1} value={distance}
          onChange={(e) => setDistance(Math.max(0.1, Number(e.target.value) || 0.1))}
          className="h-7 w-14 rounded-md bg-surface-3 px-1 text-center text-[12px] outline-none focus-visible:shadow-[var(--ring)]"
        />
        <button type="button" className={BTN} onClick={() => runOffset(-distance)}>Shrink</button>
      </span>
    </div>
  );
}
