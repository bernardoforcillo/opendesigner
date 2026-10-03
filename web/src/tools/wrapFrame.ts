import { useScene } from "../store/store";
import { wrapInFrameOps } from "./grouping";

/**
 * Avvolge la selezione corrente in un frame, con o senza auto layout, come UN
 * gesto (una voce di undo). Sta qui, e non nel select tool, perché la chiamano
 * sia la scorciatoia (Shift+A, Ctrl+Alt+G) sia il pulsante del pannello. Ritorna
 * se ha fatto qualcosa.
 */
export function wrapSelectionInFrame(withAutoLayout: boolean): boolean {
  const store = useScene.getState();
  const scene = store.scene;
  if (!scene) return false;
  const res = wrapInFrameOps(scene, store.selection, withAutoLayout);
  if (!res) return false;
  store.beginGesture();
  // La selezione voluta PRIMA di chiudere: endGesture la riconcilia contro la
  // scena finale, quindi può già nominare il frame che gli op stanno per creare.
  store.setSelection(res.selection);
  store.endGesture(res.ops);
  return true;
}
