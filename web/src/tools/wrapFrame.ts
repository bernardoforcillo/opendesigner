import { useScene } from "../store/store";
import { wrapInFrameOps } from "./grouping";

/**
 * Wraps the current selection in a frame, with or without auto layout, as ONE
 * gesture (one undo entry). It lives here, not in the select tool, because it is
 * called by both the shortcut (Shift+A, Ctrl+Alt+G) and the panel button. Returns
 * whether it did anything.
 */
export function wrapSelectionInFrame(withAutoLayout: boolean): boolean {
  const store = useScene.getState();
  const scene = store.scene;
  if (!scene) return false;
  const res = wrapInFrameOps(scene, store.selection, withAutoLayout);
  if (!res) return false;
  store.beginGesture();
  // The intended selection BEFORE closing: endGesture reconciles it against the
  // final scene, so it can already name the frame the ops are about to create.
  store.setSelection(res.selection);
  store.endGesture(res.ops);
  return true;
}
