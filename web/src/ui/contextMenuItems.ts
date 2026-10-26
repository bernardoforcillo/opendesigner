import { swapInstance } from "@/store/instanceOps";
import { useScene } from "@/store/store";
import { topmostOf } from "@/store/tree";
import type { SceneState } from "@/store/types";
import { arrangeOps, arrangeSelection } from "@/tools/arrange";
import { duplicateSelection } from "@/tools/clipboard";
import { groupOps, ungroupOps } from "@/tools/grouping";
import { detachSelectedInstances, goToMainComponent, mainComponentOf, resetSelectedInstances, swapSelectedInstances } from "@/tools/instanceActions";
import { makeDeleteOp } from "@/tools/ops";
import { useContextMenu, type MenuEntry } from "@/ui/contextMenuStore";

// WHAT THE CONTEXT MENU OFFERS for a selection. Pure on (scene, selection), so it is tested without a
// DOM; every entry's action goes through the same functions the shortcuts and the properties panel
// use, so each is ONE gesture = one undo step. The shortcut labels are informational.

const mod = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? "") ? "⌘" : "Ctrl+";

function groupSelection(ungroup: boolean): void {
  const store = useScene.getState();
  if (!store.scene) return;
  const res = ungroup ? ungroupOps(store.scene, store.selection) : groupOps(store.scene, store.selection);
  if (!res) return;
  store.beginGesture();
  store.setSelection(res.selection);
  store.endGesture(res.ops);
}

function deleteSelection(): void {
  const store = useScene.getState();
  if (!store.scene) return;
  const ids = topmostOf(store.scene, store.selection);
  if (ids.length === 0) return;
  store.beginGesture();
  store.endGesture(ids.map((id) => makeDeleteOp(id)));
}

/** The instance entries: swap, reset overrides, detach, go to the main component. Empty unless the whole selection is instances. */
function instanceEntries(scene: SceneState, selection: readonly string[]): MenuEntry[] {
  const nodes = selection.map((id) => scene.nodes.at(id));
  if (nodes.length === 0 || !nodes.every((n) => n?.kind === "instance" && n.instance)) return [];
  const current = nodes.length === 1 ? nodes[0]!.instance!.componentId : undefined;
  const choices = Object.entries(scene.components)
    .filter(([id]) => selection.every((sel) => swapInstance(scene, sel, id) !== null))
    .map(([id, c]) => ({ id, name: c.name || "Unnamed" }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const hasChanges = nodes.some((n) => n!.instance!.overrides.length > 0 || Object.keys(n!.instance!.propertyValues ?? {}).length > 0 || Object.keys(n!.instance!.variantProps ?? {}).length > 0);
  const main = nodes.length === 1 && mainComponentOf(scene, selection[0]);
  return [
    {
      id: "swap", label: "Swap instance", disabled: choices.length === 0,
      children: choices.map((c) => ({ id: `swap:${c.id}`, label: c.name, disabled: c.id === current, onSelect: () => swapSelectedInstances(c.id) })),
    },
    { id: "reset-overrides", label: "Reset all changes", disabled: !hasChanges, onSelect: () => resetSelectedInstances() },
    { id: "detach", label: "Detach instance", shortcut: `${mod}Alt+B`, onSelect: () => detachSelectedInstances() },
    ...(main ? [{ id: "go-to-main", label: "Go to main component", onSelect: () => goToMainComponent() } as MenuEntry] : []),
    { type: "separator" },
  ];
}

/** The entries for `selection`, instance actions first, then the common commands. Empty for no selection. */
export function contextMenuEntries(scene: SceneState, selection: readonly string[]): MenuEntry[] {
  if (selection.length === 0) return [];
  const can = (mode: Parameters<typeof arrangeOps>[2]) => arrangeOps(scene, selection, mode).length > 0;
  return [
    ...instanceEntries(scene, selection),
    { id: "group", label: "Group selection", shortcut: `${mod}G`, disabled: !groupOps(scene, selection), onSelect: () => groupSelection(false) },
    { id: "ungroup", label: "Ungroup", shortcut: `${mod}⇧G`, disabled: !ungroupOps(scene, selection), onSelect: () => groupSelection(true) },
    { type: "separator" },
    { id: "front", label: "Bring to front", disabled: !can("front"), onSelect: () => arrangeSelection("front") },
    { id: "forward", label: "Bring forward", disabled: !can("forward"), onSelect: () => arrangeSelection("forward") },
    { id: "backward", label: "Send backward", disabled: !can("backward"), onSelect: () => arrangeSelection("backward") },
    { id: "back", label: "Send to back", disabled: !can("back"), onSelect: () => arrangeSelection("back") },
    { type: "separator" },
    { id: "duplicate", label: "Duplicate", shortcut: `${mod}D`, onSelect: () => { duplicateSelection(); } },
    { id: "delete", label: "Delete", shortcut: "⌫", danger: true, onSelect: () => deleteSelection() },
  ];
}

/**
 * Opens the menu at the pointer for the current selection. `target` is the node under the pointer
 * (a layer row, or what the canvas hit): when it is not part of the selection, it becomes the selection
 * first, like any editor's right click. Returns whether a menu opened.
 */
export function openContextMenu(x: number, y: number, target?: string): boolean {
  const store = useScene.getState();
  if (!store.scene) return false;
  if (target && !store.selection.includes(target)) store.setSelection([target]);
  const { scene, selection } = useScene.getState();
  if (!scene) return false;
  useContextMenu.getState().show(x, y, contextMenuEntries(scene, selection));
  return useContextMenu.getState().open !== null;
}
