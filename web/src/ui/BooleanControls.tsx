import { useScene } from "../store/store";
import { makeSetPropsOp } from "../tools/ops";
import { canOutlineStroke, outlineStrokeOps } from "../vector/outlineStroke";
import { flattenGroupOps, isBooleanSource, liveBooleanOps, setBooleanOpOps, BOOLEAN_NAMES, type BooleanOp } from "../vector/boolean";
import { booleanOpOf } from "../vector/regions";

const OPS: BooleanOp[] = ["union", "subtract", "intersect", "exclude"];

/**
 * Runs a boolean operation as ONE gesture (one undo step): over a selection of shapes it makes a LIVE
 * boolean group (the shapes stay editable children); on a live group already selected it changes
 * its operation.
 */
export function runBoolean(op: BooleanOp): void {
  const store = useScene.getState();
  const scene = store.scene;
  if (!scene) return;
  const only = store.selection.length === 1 ? scene.nodes.at(store.selection[0]) : undefined;
  if (only && booleanOpOf(only)) {
    const ops = setBooleanOpOps(only, op);
    if (ops.length === 0) return;
    store.beginGesture();
    store.endGesture(ops);
    return;
  }
  const res = liveBooleanOps(scene, store.selection, op);
  if (!res) return;
  store.beginGesture();
  store.setSelection(res.selection);
  store.endGesture(res.ops);
}

/** Flattens the selected live boolean group into a plain vector (the shapes go). One gesture. */
export function runFlatten(): void {
  const store = useScene.getState();
  const scene = store.scene;
  if (!scene || store.selection.length !== 1) return;
  const res = flattenGroupOps(scene, store.selection[0]);
  if (!res) return;
  store.beginGesture();
  store.setSelection(res.selection);
  store.endGesture(res.ops);
}

/** Turns the selected node's stroke into a filled vector (ONE gesture). */
export function runOutlineStroke(): void {
  const store = useScene.getState();
  const scene = store.scene;
  if (!scene || store.selection.length !== 1) return;
  const res = outlineStrokeOps(scene, store.selection[0]);
  if (!res) return;
  store.beginGesture();
  store.setSelection(res.selection);
  store.endGesture(res.ops);
}

/** Toggles the selected shape between mask and normal node (ONE gesture). */
export function toggleMask(): void {
  const store = useScene.getState();
  const scene = store.scene;
  if (!scene || store.selection.length !== 1) return;
  const n = scene.nodes.at(store.selection[0]);
  if (!n) return;
  store.beginGesture();
  store.endGesture([makeSetPropsOp(n.id, { isMask: !n.isMask }, ["is_mask"])]);
}

// Two overlapping squares with the result filled, per operation.
const ICON: Record<BooleanOp, string> = {
  union: "M2 2h8v4h4v8H6v-4H2z",
  subtract: "M2 2h8v4H6v4H2z",
  intersect: "M6 6h4v4H6z",
  exclude: "M2 2h8v4H6v4H2zM10 6h4v8H6v-4h4z",
};

function OpIcon({ op }: { op: BooleanOp }) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
      <rect x="2" y="2" width="8" height="8" opacity="0.45" />
      <rect x="6" y="6" width="8" height="8" opacity="0.45" />
      <path d={ICON[op]} fill="currentColor" fillRule="evenodd" stroke="none" />
    </svg>
  );
}

/**
 * Union / Subtract / Intersect / Exclude of the selected shapes. Shown with two
 * or more shapes selected; the result is a plain vector node ("flatten").
 */
export function BooleanControls() {
  const count = useScene((s) => {
    const scene = s.scene;
    if (!scene) return 0;
    return s.selection.filter((id) => {
      const n = scene.nodes.at(id);
      return !!n && isBooleanSource(scene, n);
    }).length;
  });
  const maskable = useScene((s) => {
    const n = s.selection.length === 1 ? s.scene?.nodes.at(s.selection[0]) : undefined;
    return !!n && (n.kind === "rect" || n.kind === "ellipse" || n.kind === "frame" || n.kind === "vector") ? (n.isMask ? "on" : "off") : null;
  });
  const outlinable = useScene((s) => {
    const n = s.selection.length === 1 ? s.scene?.nodes.at(s.selection[0]) : undefined;
    return !!n && canOutlineStroke(n);
  });
  const liveOp = useScene((s) => {
    const n = s.selection.length === 1 ? s.scene?.nodes.at(s.selection[0]) : undefined;
    return n ? booleanOpOf(n) : null;
  });
  if (liveOp !== null) {
    return (
      <div role="group" aria-label="Boolean operations" className="flex shrink-0 items-center gap-0.5 border-b border-line px-2 py-1.5">
        {OPS.map((op) => (
          <button
            key={op} type="button" aria-label={BOOLEAN_NAMES[op]} aria-pressed={op === liveOp} title={BOOLEAN_NAMES[op]}
            className={`flex h-7 flex-1 items-center justify-center rounded-md outline-none hover:bg-surface-3 hover:text-fg focus-visible:shadow-[var(--ring)] ${op === liveOp ? "bg-surface-3 text-fg" : "text-fg-muted"}`}
            onClick={() => runBoolean(op)}
          >
            <OpIcon op={op} />
          </button>
        ))}
        <button type="button" className="ml-1 h-7 rounded-md px-2 text-[12px] text-fg-muted outline-none hover:bg-surface-3 hover:text-fg focus-visible:shadow-[var(--ring)]" onClick={runFlatten}>
          Flatten
        </button>
      </div>
    );
  }
  if (maskable !== null) {
    const btn = "h-7 flex-1 rounded-md text-[12px] text-fg-muted outline-none hover:bg-surface-3 hover:text-fg focus-visible:shadow-[var(--ring)]";
    return (
      <div role="group" aria-label="Vector tools" className="flex shrink-0 items-center gap-0.5 border-b border-line px-2 py-1.5">
        <button type="button" aria-pressed={maskable === "on"} className={`${btn} ${maskable === "on" ? "bg-surface-3 text-fg" : ""}`} onClick={toggleMask}>
          Use as mask
        </button>
        {outlinable && (
          <button type="button" className={btn} onClick={runOutlineStroke}>
            Outline stroke
          </button>
        )}
      </div>
    );
  }
  if (count < 2) return null;
  return (
    <div role="group" aria-label="Boolean operations" className="flex shrink-0 items-center gap-0.5 border-b border-line px-2 py-1.5">
      {OPS.map((op) => (
        <button
          key={op}
          type="button"
          aria-label={BOOLEAN_NAMES[op]}
          title={BOOLEAN_NAMES[op]}
          className="flex h-7 flex-1 items-center justify-center rounded-md text-fg-muted outline-none hover:bg-surface-3 hover:text-fg focus-visible:shadow-[var(--ring)]"
          onClick={() => runBoolean(op)}
        >
          <OpIcon op={op} />
        </button>
      ))}
    </div>
  );
}
