import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import type { PropChange } from "./timelineLogic";

// THE RECORDING HOOK.
//
// With the clip open and "Record" on, modifying x, y, rotation or opacity of
// a node does not change the node: it writes a keyframe in the clip at the playhead. Whoever
// modifies a node -- dragging and rotating on the canvas (tools/
// selectTool.ts), the fields and the opacity slider of the Properties panel
// (ui/PropertiesPanel.tsx), the keyboard -- always does so through the same TWO doors
// of the store: `applyLocal(op)` for the preview at every step, `endGesture(ops)`
// for the release. The hook sits there, and only there: no tool knows recording
// exists, and with recording off the two functions are the identity (the
// hook is null: `recordPreview` returns false, `recordFinal` returns the
// SAME array).
//
// The module imports nothing from the store (the store imports it): whoever registers
// the hook is animation/timelineStore.ts.

export interface RecordHook {
  /** Preview: true = the op was absorbed (into the draft), the scene must NOT be touched. */
  preview(op: Op): boolean;
  /** Release: the ops to actually send in place of `ops` (the draft is closed). */
  final(ops: Op[]): Op[];
}

let hook: RecordHook | null = null;

export function setRecordHook(h: RecordHook | null): void {
  hook = h;
}

export function recordPreview(op: Op): boolean {
  return hook ? hook.preview(op) : false;
}

export function recordFinal(ops: Op[]): Op[] {
  return hook ? hook.final(ops) : ops;
}

// The node properties that recording knows how to translate into tracks, with the name of the
// field in the `setProps` mask and in the track.
const RECORDABLE = new Set(["x", "y", "rotation", "opacity"]);

/**
 * The animatable property changes carried by `ops`, or null if even ONE
 * op is not recordable (it is not a `setProps`, or its mask touches something besides
 * x, y, rotation, opacity -- a resize, a color). All or nothing:
 * a mixed gesture (resize + move) is NOT recorded piecemeal, it passes through as is.
 */
export function propChangesOfOps(ops: readonly Op[]): PropChange[] | null {
  if (ops.length === 0) return null;
  const out: PropChange[] = [];
  for (const op of ops) {
    if (op.kind.case !== "setProps") return null;
    const { id, patch, mask } = op.kind.value;
    const paths = mask?.paths ?? [];
    if (paths.length === 0 || !patch || !paths.every((p) => RECORDABLE.has(p))) return null;
    for (const p of paths) out.push({ nodeId: id, prop: p, value: patch[p as "x" | "y" | "rotation" | "opacity"] });
  }
  return out;
}
