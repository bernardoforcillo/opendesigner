import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, GridList, GridListItem, ListLayout, Virtualizer } from "react-aria-components";
import { EmptyState, Icon, IconButton, cls, type IconName } from "./ds";
import type { Selection } from "react-aria-components";
import { useScene } from "../store/store";
import { orderKeyBetween } from "../store/orderKey";
import { ancestorsOf, childIndexOf, childrenOf, isAncestorOf, subtreeOf, topmostOf } from "../store/tree";
import { sceneIndexOf } from "../renderer/sceneIndex";
import { makeDeleteOp, makeReparentOp, makeSetPropsOp } from "../tools/ops";
import type { NodeLite, SceneState } from "../store/types";

// LAYERS PANEL — TREE of the current page, with selection, visibility,
// deletion, rename and drag to reorder/reparent (Task 7/8 + nesting
// track).
//
// The two-way sync with the canvas selection is not a SEPARATE
// mechanism: `selectedKeys` is read here from the SAME store that
// selectTool writes (store.selection), and `onSelectionChange` writes there with the
// SAME store.setSelection that selectTool calls. A single state, two
// writers -- nothing to keep in sync by hand between canvas and panel.
//
// The tree shows ONLY the current page (store.currentPageId, view state
// like camera and selection): it is the same choice as the renderer, which draws only the
// roots of that page (canvasRenderer.ts::rootsOf). Changing page changes
// the tree, with no op on the wire.
//
// The expansion of containers is local VIEW state (like the camera), not an
// undo entry: it lives in this component and does not travel on the wire. The drag instead
// DOES -- reordering among siblings and reparenting are document edits -- and
// follows the usual rule: one drop = one gesture = one op = one undo entry.

// A CONTAINER takes children and shows them as a subtree: group and frame. The
// page is the root container, but it is not a NodeLite (it is not a row
// of the tree). Only containers are reparenting targets and only they
// expand/collapse: dropping "inside" an empty rect means reordering next to
// it, not entering it.
function isContainer(n: NodeLite): boolean {
  return n.kind === "group" || n.kind === "frame";
}

// A row of the flattened tree: the node, its depth (0 = page root)
// and the expansion state. The tree is RENDERED as a flat list of visible
// rows -- react-aria-components GridList wants a flat collection,
// and flattening here (instead of nesting <GridList> inside <GridList>) keeps
// selection, keyboard navigation and the shift-click anchor all in a
// single collection.
export interface LayerRow {
  id: string;
  node: NodeLite;
  depth: number;
  container: boolean;
  hasChildren: boolean;
  expanded: boolean;
}

// The page's tree in PRE-ORDER, descending only into expanded containers. Each
// level of siblings is in REVERSE draw order -- foreground on top,
// like the old flat list and like Figma -- so childrenOf (ascending,
// background→foreground) is walked backwards.
//
// A `seen` as in tree.ts::subtreeOf: a malformed document (a node that is its
// own child) must not send the recursion to infinity.
//
// `children` is the children-by-parent index (the same list childrenOf would give,
// already sorted): built ONCE instead of scanning the whole scene for
// each row -- with 20,000 nodes the rows were 20,000 scans of 20,000, that is
// 46 seconds to OPEN the document.
export function visibleRows(
  scene: SceneState,
  pageId: string,
  collapsed: ReadonlySet<string> | ((id: string) => boolean),
  children: ReadonlyMap<string, NodeLite[]> = childIndexOf(scene),
): LayerRow[] {
  const isCollapsed = typeof collapsed === "function" ? collapsed : (id: string) => collapsed.has(id);
  const out: LayerRow[] = [];
  const seen = new Set<string>();
  const walk = (parentId: string, depth: number): void => {
    const siblings = children.get(parentId) ?? [];
    for (let i = siblings.length - 1; i >= 0; i--) {
      const n = siblings[i];
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      const container = isContainer(n);
      const hasChildren = container && (children.get(n.id)?.length ?? 0) > 0;
      const expanded = hasChildren && !isCollapsed(n.id);
      out.push({ id: n.id, node: n, depth, container, hasChildren, expanded });
      if (expanded) walk(n.id, depth + 1);
    }
  };
  walk(pageId, 0);
  return out;
}

// The outcome of a drop, computed from the row under the pointer. It is the heart of the
// see-vs-select of the panel: the same geometry (the row hit) decides
// what the drop DOES.
//  - "reorder": same parent, just change the order key -- the
//    reorder-only path already exists (SetProperties order_key) and is reused;
//  - "reparent": the node changes container (inside a group/frame, or out onto
//    another root) -- a ReparentNode is needed, which carries parent and position
//    together.
// null = nothing to do or invalid drop (on itself, or inside its own
// subtree: it would be a cycle, which the core rejects and which is not offered here).
type DropPlan =
  | { kind: "reorder"; key: string }
  | { kind: "reparent"; parentId: string; key: string };

// orderKeyBetween throws if the range is empty (two neighbors with the same key):
// inside a pointerup handler that would mean breaking the app mid-drag,
// so here it degrades to "no drop" (null), as reorderKey does.
function safeBetween(a: string | null, b: string | null): string | null {
  try {
    return orderKeyBetween(a, b);
  } catch {
    return null;
  }
}

export function dropPlanFor(scene: SceneState, fromId: string, overId: string): DropPlan | null {
  if (fromId === overId) return null;
  const from = scene.nodes.at(fromId);
  const over = scene.nodes.at(overId);
  if (!from || !over) return null;
  // CYCLE GUARD: `over` must not be in `from`'s subtree. isAncestorOf
  // is strict (from === over is already excluded above): dropping a node inside
  // one of its own descendants would detach the subtree from the document, and the core
  // rejects it (ErrCycle) -- the UI does not even offer it.
  if (isAncestorOf(scene, fromId, overId)) return null;

  if (isContainer(over)) {
    // INSIDE the container: at the top of its children (foreground side, right below
    // the header). An empty container starts from FIRST_KEY.
    const kids = childrenOf(scene, overId);
    const topKey = kids.length > 0 ? kids[kids.length - 1].orderKey : null;
    const key = safeBetween(topKey, null);
    return key === null ? null : { kind: "reparent", parentId: overId, key };
  }

  // NEXT TO `over` (becomes its sibling). The target's DISPLAYED list of siblings:
  // foreground on top.
  const parentId = over.parentId;
  const displayed = [...childrenOf(scene, parentId)].reverse();
  if (parentId === from.parentId) {
    // Same parent: pure reorder, with the same index-based semantics as the
    // old flat list (reorderKey) -- so the existing reorder tests
    // hold identically when the tree is a single list.
    const key = reorderKey(
      displayed,
      displayed.findIndex((n) => n.id === fromId),
      displayed.findIndex((n) => n.id === overId),
    );
    return key === null ? null : { kind: "reorder", key };
  }
  // Different parent: `from` is not among the target's siblings, so it is slipped in
  // just ABOVE `over` (foreground side), between `over` and the neighbor above.
  const overIdx = displayed.findIndex((n) => n.id === overId);
  const aboveKey = displayed[overIdx - 1]?.orderKey ?? null;
  const key = safeBetween(over.orderKey, aboveKey);
  return key === null ? null : { kind: "reparent", parentId, key };
}

// Maximum length of the content of a text node used as a
// fallback name (step 3): enough to recognize the row without pushing the
// panel horizontally. "…" signals the cut, it is not decorative.
const TEXT_FALLBACK_MAX = 30;

function fallbackName(n: NodeLite): string {
  if (n.kind === "rect") return "Rectangle";
  if (n.kind === "ellipse") return "Ellipse";
  // An image usually already has a name (tools/imageDrop.ts uses the file's),
  // so this fallback shows only for a node renamed to empty or
  // arrived from a paste without a name.
  if (n.kind === "image") return "Image";
  if (n.kind === "vector") return "Vector";
  // A group is born with a name already (tools/grouping.ts::GROUP_NAME): this is
  // the fallback for a group renamed to an empty string, or arrived from a
  // document that did not have it.
  if (n.kind === "group") return "Group";
  if (n.kind === "frame") return "Frame";
  // Shape PRESENT but not recognized by this model (one of the parallel tracks
  // added it to the `shape` oneof): neutral name. The branch exists
  // because without it the node would fall into the TEXT fallback below and the
  // row would say "Text" for something that is not text.
  if (n.kind === "unknown") return "Shape";
  // n.kind === "text": newlines and repeated spaces collapsed, so the label
  // stays on a single line even for multiline text.
  const flat = (n.text?.content ?? "").replace(/\s+/g, " ").trim();
  if (flat === "") return "Text";
  return flat.length > TEXT_FALLBACK_MAX ? `${flat.slice(0, TEXT_FALLBACK_MAX)}…` : flat;
}

// The name shown for a row: `name` if set, otherwise the
// per-type fallback (Task 7, step 3). Exported because the properties panel
// (Task 8) shows the very same name for the same selection -- two
// independent implementations could silently diverge.
export function layerDisplayName(n: NodeLite): string {
  return n.name.trim() !== "" ? n.name : fallbackName(n);
}

// Same set of ids, in any order -- compares a react-aria-components Selection
// (the keys GridList has just given us) against the store's flat
// array.
function sameIds(keys: Exclude<Selection, "all">, ids: readonly string[]): boolean {
  if (keys.size !== ids.length) return false;
  for (const id of ids) if (!keys.has(id)) return false;
  return true;
}

/**
 * The order key to give to row `from` to bring it to position `to`.
 *
 * `layers` is the list AS DISPLAYED -- foreground on top, so DESCENDING
 * order key (see selectors.ts::layersInDrawOrder). The reorder is that of
 * any list: the row is removed from its starting position and slipped into the
 * arrival one; the new key is then any key strictly between the two
 * NEIGHBORS the row finds itself with there -- and the fractional index
 * (store/orderKey.ts) always finds one, even between two consecutive keys,
 * even a thousand times in the same spot.
 *
 * NO other row is touched: a single op for a reorder, instead of
 * renumbering the whole list. It is the whole reason order keys are a
 * fractional index and not integers.
 *
 * The ends are OPEN: at the top there is no neighbor above (`null` = "above
 * everything"), at the bottom there is no neighbor below.
 *
 * null when there is nothing to do (the row does not move, indices out of
 * the list) or when the key does not exist -- two neighbors with the SAME order key
 * leave no room in between. In that case orderKeyBetween would throw, and
 * throwing inside a pointerup handler would mean breaking the app
 * mid-drag: better a reorder that does not happen.
 */
export function reorderKey(layers: readonly NodeLite[], from: number, to: number): string | null {
  if (from === to) return null;
  if (from < 0 || from >= layers.length || to < 0 || to >= layers.length) return null;

  const moved = [...layers];
  moved.splice(to, 0, ...moved.splice(from, 1));
  // Above = HIGHER order key (the list is descending), below = lower.
  const above = moved[to - 1]?.orderKey ?? null;
  const below = moved[to + 1]?.orderKey ?? null;
  if (above !== null && below !== null && below >= above) return null;
  return orderKeyBetween(below, above);
}

// Label of the rename field. A constant and not "Rename {name}": there is
// ONE at a time (renamingId is a single id), and a label that changes with the
// field's content is not a stable name for someone using a screen reader.
const RENAME_LABEL = "Layer name";

// INLINE RENAME FIELD (Task 8, step 1). A separate component, and not an
// inline <input> inside the row, for a precise reason: the edit
// session has its OWN STATE (the text typed so far, and whether it has already
// been closed) which must be born and die with the field. By mounting/unmounting it
// when `renamingId` changes, that state cannot survive onto the wrong
// row.
function RenameField({
  initial,
  placeholder,
  onCommit,
  onCancel,
}: {
  initial: string;
  placeholder: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement | null>(null);
  // A session closes ONLY once: Enter/Escape close, and the blur that
  // arrives right after (the field is about to be unmounted) must not commit
  // a second time -- least of all after a cancel. Same guard as
  // ui/TextEditorOverlay.tsx::done, for the same reason.
  const done = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // Everything selected: typing REPLACES the name, which is what one
    // expects from a rename (and it stays possible to position the cursor).
    el.select();
  }, []);

  function settle(commit: boolean) {
    if (done.current) return;
    done.current = true;
    if (commit) onCommit(value);
    else onCancel();
  }

  return (
    <input
      ref={ref}
      aria-label={RENAME_LABEL}
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      // Leaving the field (click elsewhere, Tab) commits: it is the safety net
      // for the cases nobody handles -- losing focus must not be able to make
      // what the user wrote get lost.
      onBlur={() => settle(true)}
      // A click INSIDE the field (to position the cursor) must not
      // become a click on the row: without it, GridList would change the selection
      // under the fingers of whoever is renaming. BOTH events are needed:
      // react-aria opens the press on pointerdown, but for "virtual"
      // clicks -- those of a screen reader, and those user-event
      // synthesizes in tests, recognized by pressure/width/height (see the
      // comment of press() in LayersPanel.test.tsx) -- it goes through click alone.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        // NO key leaves this field. The app's global shortcuts
        // listen on the WINDOW (undo/redo in ui/App.tsx, Escape/Delete in
        // tools/toolManager.ts) and GridList has its own on the list (arrows,
        // typeahead): without this stop, Delete would delete the node being
        // renamed and typing "Beta" would move the selection to the row
        // starting with B. The two existing isTextField guards cover only the
        // window channel, not GridList's -- which is React and
        // would arrive anyway.
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          settle(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          settle(false);
        }
      }}
      // select-text: the list around is select-none (because dragging a
      // handle must not highlight the names of the rows it crosses),
      // but INSIDE a text field selection is needed.
      // Same field as the rest of the app (cls.input), but 24px: inside a 28
      // row it leaves breathing room above and below. The border is already lit: one is writing.
      className={`${cls.input} h-6! flex-1 select-text border-accent bg-surface focus-visible:shadow-none!`}
    />
  );
}

// The row's icon says WHAT it is at a glance. They are the same
// icons as the tools: frame -> frame, group -> layers, vector -> pen,
// component instance -> components. `unknown` (a type this client does not
// know) falls back to the rectangle, as fallbackName falls back to "Shape".
function kindIcon(kind: NodeLite["kind"]): IconName {
  switch (kind) {
    case "frame": return "frame";
    case "group": return "layers";
    case "ellipse": return "ellipse";
    case "text": return "text";
    case "image": return "image";
    case "vector": return "pen";
    case "instance": return "components";
    default: return "rect";
  }
}

// Indent step per depth level, and left padding of the root row. The
// indent guides sit at the center of the parent level's chevron.
const INDENT = 14;
const BASE_PAD = 8;

// How many rows are needed for the panel to virtualize, and the height of each
// when it happens (py-1 + text row ≈ 28 px, the same as before).
export const VIRTUALIZE_AFTER_ROWS = 300;
const ROW_HEIGHT = 28;

// Beyond this number of nodes in a document containers start CLOSED: listing
// every node of a file with tens of thousands of elements does not help orientation
// (and costs a collection of tens of thousands of rows). They are opened by hand or, on
// their own, when a node inside is selected.
export const AUTO_COLLAPSE_NODES = 2000;

export function LayersPanel() {
  // The panel redraws for the tree's STRUCTURE (who is where, the names,
  // visibility), not for every new scene: a drag produces one at
  // every step, and without this every step redid 20,000 react-aria rows.
  // The scene is READ (without subscribing) where needed.
  const structure = useScene((s) => (s.scene ? sceneIndexOf(s.scene).structure : null));
  const scene = useScene.getState().scene;
  const selection = useScene((s) => s.selection);
  // The DISPLAYED page: the tree shows only its roots and their
  // subtrees. View state of the store, the same one the renderer reads.
  const currentPageId = useScene((s) => s.currentPageId);
  // The node whose row is showing the rename field, or null. Only one
  // at a time, by construction.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  // The COLLAPSED containers (default: all expanded). A Set of collapsed ids
  // only, so a freshly created container is born open without having to list
  // it. Local VIEW state: it is not an op and not an undo entry.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  // In large documents containers start closed (AUTO_COLLAPSE_NODES): the
  // state is the inverse -- `expanded` lists those the user opened. It is
  // decided ONCE per (document, page) and stays, even if the nodes
  // later grow or shrink around the threshold.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const autoDecided = useRef(new Map<string, boolean>());
  const autoKey = scene && currentPageId ? `${scene.id}:${currentPageId}` : null;
  if (autoKey !== null && scene && !autoDecided.current.has(autoKey)) {
    autoDecided.current.set(autoKey, scene.nodes.size > AUTO_COLLAPSE_NODES);
  }
  const autoCollapse = autoKey !== null && autoDecided.current.get(autoKey) === true;
  const isCollapsed = useCallback(
    (id: string) => collapsed.has(id) || (autoCollapse && !expanded.has(id)),
    [collapsed, expanded, autoCollapse],
  );
  // The drag in progress: which row is being moved and which one the pointer is on
  // right now (`over` starts from the row itself, that is "not moved yet").
  // null = no drag in progress.
  const [drag, setDrag] = useState<{ from: string; over: string } | null>(null);

  // The tree's visible rows. STABLE identity until scene, page or
  // expansion change (a selection alone does not touch them):
  // react-aria-components rebuilds its internal collection -- selection
  // anchor included, the one a shift-click range relies on -- when
  // `items`' identity changes. A new array on EVERY render would break it
  // even when the tree has not changed at all, and a simple subsequent click
  // would behave as "add" instead of "replace".
  //
  // It depends on the scene index's structure TOKEN, not on the scene: a
  // drag produces a new scene at every step, but does not change who is
  // where nor the names, and redoing 20,000 rows at every step would freeze the page.
  const index = scene ? sceneIndexOf(scene) : null;
  // A long list is VIRTUALIZED: only the visible rows are mounted (and a few
  // around), not one per node. Above the threshold, because the virtualizer decides
  // what to show from the container's measure and under jsdom -- where every measure
  // is zero -- a short list would vanish. Virtualized rows have a fixed
  // height (ROW_HEIGHT): it is what lets it avoid measuring them one by one.
  const rows = useMemo(
    () => (scene && index && currentPageId ? visibleRows(scene, currentPageId, isCollapsed, index.children) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `structure` replaces scene/index
    [structure, currentPageId, isCollapsed],
  );

  const virtualized = rows.length > VIRTUALIZE_AFTER_ROWS;

  // The dragged row's subtree (root included): its ids are the INVALID drop
  // targets -- dropping into them would be a cycle. Precomputed
  // once per drag instead of at every row.
  const dragSubtree = useMemo(
    () => (drag && scene ? new Set(subtreeOf(scene, drag.from).map((n) => n.id)) : null),
    [drag, scene],
  );

  // The LAST Selection that GridList itself handed us via
  // onSelectionChange -- with the shift-click ANCHOR (which row opens the
  // range), which store.selection cannot carry: it is a flat array,
  // also written by selectTool on the canvas, which knows nothing about anchors.
  //
  // If the next render arrives with the SAME selection we just
  // emitted (the user clicked a row), we reuse it AS IT WAS,
  // anchor included: rebuilding a new Set from `selection` on every round
  // (identical in content, but a NEW object) is indistinguishable to
  // GridList from "the selection was replaced from outside", and would lose
  // the anchor after EVERY click -- one shift-click after another would always select
  // only two rows, never the range. If instead the selection comes
  // from OUTSIDE (the canvas, via store.setSelection), it does not match the one
  // emitted and we rebuild a flat Set: a lost anchor in that case IS
  // the right outcome, not a bug -- a new starting point for the next
  // shift-click in the panel.
  const lastEmitted = useRef<Selection | null>(null);
  const selectedKeys: Selection = useMemo(() => {
    const cached = lastEmitted.current;
    if (cached && cached !== "all" && sameIds(cached, selection)) return cached;
    return new Set(selection);
  }, [selection]);

  // GridList is CONTROLLED by selection (above) and writes here: a click
  // replaces the selection (selectionBehavior="replace"), ctrl/cmd-click
  // extends it one node at a time, shift-click extends it by range -- the
  // same desktop semantics as selectTool on the canvas, free from
  // react-aria-components.
  function onSelectionChange(keys: Selection) {
    lastEmitted.current = keys;
    const ids = keys === "all" ? rows.map((r) => r.id) : [...keys].map(String);
    useScene.getState().setSelection(ids);
  }

  // One op, one gesture: even the single toggle goes through beginGesture/endGesture
  // (panels obey the same rule as a tool, see the M1b
  // brief), so visibility stays undoable with Ctrl+Z and travels on the wire
  // like any other change.
  function toggleVisible(n: NodeLite) {
    const store = useScene.getState();
    store.beginGesture();
    store.endGesture([makeSetPropsOp(n.id, { visible: !n.visible }, ["visible"])]);
  }

  // A single gesture for the WHOLE selection, not one gesture per node: undoStack
  // gains ONE entry even when deleting ten layers in one go --
  // same pattern as selectTool.ts::onKeyDown for Delete/Backspace on the
  // canvas, here applied to the panel's button.
  // Closes the rename by writing the new name. Like the visibility toggle it is
  // a whole gesture (one undo entry, one op on the wire).
  //
  // Two cases produce NOTHING: the unchanged name and -- for the same reason
  // -- the name that differs only by whitespace at the edges, which is trimmed. An op
  // "that changes nothing" would still cost a network round trip and a Ctrl+Z.
  function commitRename(n: NodeLite, raw: string) {
    setRenamingId(null);
    const name = raw.trim();
    if (name === n.name) return;
    const store = useScene.getState();
    store.beginGesture();
    store.endGesture([makeSetPropsOp(n.id, { name }, ["name"])]);
  }

  // Opens/closes a container. Local VIEW state: no op, no undo entry
  // (like moving the camera).
  function toggleCollapse(id: string) {
    const flip = (prev: ReadonlySet<string>) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    };
    // With containers closed by default, "opening" means adding to
    // `expanded`; otherwise it means removing from `collapsed`.
    if (autoCollapse) setExpanded(flip);
    else setCollapsed(flip);
  }

  // Selecting a node (from the canvas, or with the keyboard) must SHOW it: the
  // closed ancestors are opened. It runs only when the selection changes, so
  // manually closing a container with the selection inside does not get it reopened.
  useEffect(() => {
    const cur = useScene.getState().scene;
    if (!cur || selection.length === 0) return;
    const toOpen = new Set<string>();
    for (const id of selection.slice(0, 20)) {
      for (const anc of ancestorsOf(cur, id)) if (isCollapsed(anc.id)) toOpen.add(anc.id);
    }
    if (toOpen.size === 0) return;
    if (autoCollapse) setExpanded((prev) => new Set([...prev, ...toOpen]));
    else setCollapsed((prev) => new Set([...prev].filter((id) => !toOpen.has(id))));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on selection change
  }, [selection]);

  // KEYBOARD reorder (Alt+arrows on the handle): moves the node one place
  // AMONG ITS SIBLINGS. Same op and same gesture as the reorder-only drag
  // (SetProperties order_key): a single op, neighbors are not touched. `dir` is -1
  // toward the foreground (up), +1 toward the background (down). Outside the siblings'
  // list it does nothing (reorderKey returns null).
  function reorderSibling(id: string, dir: -1 | 1) {
    const cur = useScene.getState().scene;
    if (!cur) return;
    const n = cur.nodes.at(id);
    if (!n) return;
    const displayed = [...childrenOf(cur, n.parentId)].reverse();
    const i = displayed.findIndex((s) => s.id === id);
    const key = reorderKey(displayed, i, i + dir);
    if (key === null) return;
    const store = useScene.getState();
    store.beginGesture();
    store.endGesture([makeSetPropsOp(id, { orderKey: key }, ["order_key"])]);
  }

  // Performs the drop of `fromId` onto row `overId`. One drop = ONE gesture = ONE op =
  // ONE undo entry: reorder (SetProperties order_key) if it stays among siblings,
  // ReparentNode if it changes container. The plan is computed on the store's FRESH
  // scene (not on a closure that might have aged).
  function performDrop(fromId: string, overId: string) {
    const cur = useScene.getState().scene;
    if (!cur) return;
    const plan = dropPlanFor(cur, fromId, overId);
    if (!plan) return;
    const store = useScene.getState();
    store.beginGesture();
    if (plan.kind === "reorder") {
      store.endGesture([makeSetPropsOp(fromId, { orderKey: plan.key }, ["order_key"])]);
      return;
    }
    // Reparenting: the destination container must be EXPANDED, so the node
    // just dropped inside is immediately visible instead of vanishing into a
    // collapsed branch. (If the parent is a page, it is never in `collapsed`: no-op.)
    setCollapsed((prev) => {
      if (!prev.has(plan.parentId)) return prev;
      const next = new Set(prev);
      next.delete(plan.parentId);
      return next;
    });
    store.endGesture([makeReparentOp(fromId, plan.parentId, plan.key)]);
  }

  // The release arrives on the WINDOW and not on the row: the pointer can
  // very well be released outside the list (or outside the window),
  // and a drag that stays "stuck" because the pointerup went elsewhere
  // is the classic flaw of a hand-made drag. Registered only while a
  // drag is in progress.
  useEffect(() => {
    if (!drag) return;
    const { from, over } = drag;
    const drop = () => {
      setDrag(null);
      performDrop(from, over);
    };
    // The browser cancelled the gesture (system gesture, lost capture):
    // it is abandoned without reordering, as the tools' onPointerCancel does
    // (tools/toolManager.ts).
    const abort = () => setDrag(null);
    window.addEventListener("pointerup", drop);
    window.addEventListener("pointercancel", abort);
    return () => {
      window.removeEventListener("pointerup", drop);
      window.removeEventListener("pointercancel", abort);
    };
    // performDrop reads the fresh scene from the store: the closure does not depend on
    // `rows`, so it is enough to rerun the effect when the drag changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag]);

  function deleteSelected() {
    const store = useScene.getState();
    const scene = store.scene;
    if (!scene) return;
    // Only the TOPMOST nodes of the selection: deleteNode cascades, so a
    // child selected together with its group would produce an op rejected by the
    // server and leave the whole gesture without an undo entry (see topmostOf).
    const ids = topmostOf(scene, store.selection);
    if (ids.length === 0) return;
    store.beginGesture();
    store.endGesture(ids.map((id) => makeDeleteOp(id)));
  }

  const list = (
    <GridList
      aria-label="Layers"
      items={rows}
      // The CACHE of react-aria-components' items. With a dynamic
      // collection (`items` + render function) RAC rebuilds the rows only
      // when `items` changes -- not on every render of the panel: `renamingId`
      // and `drag` live in this component's STATE, and without declaring them
      // here the double click / the drop highlight would update the
      // state without the row ever changing. (`collapsed` already changes the identity
      // of `rows`, so it need not be listed.)
      dependencies={[renamingId, drag]}
      selectionMode="multiple"
      selectionBehavior="replace"
      selectedKeys={selectedKeys}
      onSelectionChange={onSelectionChange}
      renderEmptyState={() => (
        <EmptyState
          icon="layers"
          title="No layers"
          hint="Draw a shape with the tools below: it will appear here."
        />
      )}
      className="min-h-0 flex-1 select-none overflow-auto px-1 pb-2 outline-none"
    >
      {(row) => {
        const n = row.node;
        const label = layerDisplayName(n);
        const dragging = drag?.from === n.id;
        // INVALID target during a drag: the dragged row would drop into its
        // own subtree (cycle). It is not offered -- the core would reject it
        // (ErrCycle) and the panel must not even pretend it is possible.
        const invalidTarget = !!drag && !dragging && !!dragSubtree?.has(n.id);
        // How the drop would land HERE: "into" = inside this container,
        // "beside" = reorder/reparent next to it. Decided by the same
        // dropPlanFor that performs the drop, so the preview cannot lie about
        // what will happen.
        let dropMode: "into" | "beside" | null = null;
        if (drag && drag.over === n.id && !dragging && !invalidTarget && scene) {
          const plan = dropPlanFor(scene, drag.from, n.id);
          if (plan) dropMode = plan.kind === "reparent" && plan.parentId === n.id ? "into" : "beside";
        }
        return (
          <GridListItem
            id={n.id}
            textValue={label}
            data-depth={row.depth}
            data-drop-invalid={invalidTarget ? "true" : undefined}
            // Indentation by depth: the same space the renderer
            // expresses going down the tree, here rendered as a left indent.
            style={{ paddingLeft: BASE_PAD + row.depth * INDENT }}
            // The drop target is decided from the row UNDER THE
            // POINTER, not from a calculation on coordinates and heights: the
            // pointermove already arrives on the right row, which is the only
            // information needed. (No setPointerCapture, for this reason:
            // capturing, all the moves would go back to the handle.)
            onPointerMove={() => {
              if (drag && drag.over !== n.id) setDrag({ from: drag.from, over: n.id });
            }}
            className={[
              // h-7 = ROW_HEIGHT (28): the same fixed height that lets the
              // virtualizer avoid measuring rows. `relative` anchors the indent
              // guides, the handle and the drop indicator.
              "group relative flex h-7 items-center gap-1.5 rounded-md pr-1.5 text-[13px] text-fg outline-none",
              "hover:bg-surface-3 data-[selected]:bg-accent-soft data-[selected]:hover:bg-accent-soft",
              "data-[focus-visible]:shadow-[inset_0_0_0_1.5px_var(--accent)]",
              dragging ? "opacity-50" : "",
              invalidTarget ? "cursor-no-drop opacity-40" : "",
              // Drop INSIDE a container: the whole row lights up, in accent.
              dropMode === "into" ? "bg-accent-soft! shadow-[inset_0_0_0_1.5px_var(--accent)]" : "",
            ].join(" ")}
          >
            {/* "beside" DROP INDICATOR: a 2px accent line on the top
                edge (absolute, so it does not change the row's height -- which for
                virtualization is fixed) with a dot on the left. */}
            {dropMode === "beside" && (
              <span aria-hidden className="pointer-events-none absolute inset-x-0 -top-px z-10 h-0.5 rounded-full bg-accent">
                <span className="absolute -left-0.5 -top-[3px] h-2 w-2 rounded-full border-2 border-accent bg-surface" />
              </span>
            )}
            {/* INDENT GUIDES: a vertical line for each ancestor, at the center
                of its chevron. Decorative (aria-hidden) and they do not intercept
                events. */}
            {Array.from({ length: row.depth }, (_, i) => (
              <span
                key={i}
                aria-hidden
                className="pointer-events-none absolute inset-y-0 w-px bg-line"
                style={{ left: BASE_PAD + i * INDENT + 8 }}
              />
            ))}
            {/* DISCLOSURE: expands/collapses a container with children. For rows
                that do not have one, a spacer of the same width,
                so names and handles stay aligned across levels. A real
                <button> (aria-expanded), reachable by keyboard. */}
            {row.container && row.hasChildren ? (
              <button
                type="button"
                aria-label={row.expanded ? `Collapse ${label}` : `Expand ${label}`}
                aria-expanded={row.expanded}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleCollapse(n.id);
                }}
                className="relative z-[1] flex h-5 w-4 shrink-0 items-center justify-center rounded text-fg-subtle outline-none hover:bg-surface-3 hover:text-fg focus-visible:text-accent"
              >
                <Icon name={row.expanded ? "chevronDown" : "chevronRight"} size={12} />
              </button>
            ) : (
              <span aria-hidden className="w-4 shrink-0" />
            )}
            {/* Drag HANDLE. The drag starts from here and not from the whole
                row: a pointerdown on the row is already "select this row"
                (and with shift/ctrl, "extend the selection"), and making it count also
                as the start of a drag would mean deciding after the fact
                -- with a pixel threshold -- which of the two things the user
                meant. A real <button>, not a decorative <div>: it is
                reachable by keyboard and Alt+arrows move it among
                siblings, otherwise reordering would be the panel's only function
                impossible without a mouse. */}
            <button
              type="button"
              aria-label={`Reorder ${label}`}
              title="Drag to reorder or reparent (Alt+↑ / Alt+↓)"
              // As for the rename field: pointerdown for the normal
              // path, click for the "virtual" one (screen reader), so the
              // handle grab does not also become a click on the row.
              onPointerDown={(e) => {
                e.stopPropagation();
                setDrag({ from: n.id, over: n.id });
              }}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                // ALT + arrow, not the arrow alone, and it is not a
                // preference: react-aria RESERVES ArrowUp/ArrowDown for
                // navigation between rows and intercepts them in the CAPTURE
                // phase before they reach the row's children
                // (useGridListItem.mjs: "Prevent this event from reaching row
                // children"), re-dispatching them from the parent. The only combination
                // that lets through is with altKey -- and it is the same one
                // react-aria uses for its own keyboard reorder
                // (useDraggableItem.mjs). A plain arrow here would never
                // arrive: it would be dead code.
                if (!e.altKey) return;
                if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
                e.preventDefault();
                e.stopPropagation();
                reorderSibling(n.id, e.key === "ArrowUp" ? -1 : 1);
              }}
              // touch-none: on a touch screen dragging the handle
              // must not become a panel scroll.
              // Absolute on the left edge and visible only on hover (or keyboard
              // focus): a handle on every row, always lit, is
              // noise. It stays a real <button>, so reachable with Tab.
              className="absolute left-0 top-1/2 z-[2] flex h-5 w-2.5 -translate-y-1/2 cursor-grab touch-none items-center justify-center text-fg-subtle opacity-0 outline-none hover:text-fg focus-visible:text-accent focus-visible:opacity-100 group-hover:opacity-100"
            >
              <svg aria-hidden viewBox="0 0 6 10" width="6" height="10" fill="currentColor">
                <circle cx="1.5" cy="2" r="0.9" /><circle cx="4.5" cy="2" r="0.9" />
                <circle cx="1.5" cy="5" r="0.9" /><circle cx="4.5" cy="5" r="0.9" />
                <circle cx="1.5" cy="8" r="0.9" /><circle cx="4.5" cy="8" r="0.9" />
              </svg>
            </button>
            {/* TYPE ICON: faint; component instances in accent (as
                in the Components panel). A hidden node is entirely dimmed. */}
            <Icon
              name={kindIcon(n.kind)}
              size={14}
              className={`shrink-0 ${n.kind === "instance" ? "text-accent" : "text-fg-subtle"} ${n.visible ? "" : "opacity-50"}`}
            />
            {renamingId === n.id ? (
              <RenameField
                // Seeded with the REAL name, not the displayed one: for a
                // node without a name the field starts empty and the fallback stays the
                // placeholder. Confirming without writing anything must not
                // persist "Rectangle" as an explicit name -- it would be a
                // change the user did not ask for, and an undoable one at that.
                initial={n.name}
                placeholder={label}
                onCommit={(value) => commitRename(n, value)}
                onCancel={() => setRenamingId(null)}
              />
            ) : (
              <span
                className={`min-w-0 flex-1 truncate ${n.visible ? "" : "text-fg-subtle"}`}
                onDoubleClick={() => setRenamingId(n.id)}
              >
                {label}
              </span>
            )}
            {/* stopPropagation: a click here is "hide/show THIS
                row", not "select this row" -- without it, the Button's
                pointerdown would still reach the row below and the
                selection would change together with the visibility. */}
            <Button
              aria-label={n.visible ? `Hide ${label}` : `Show ${label}`}
              onPress={() => toggleVisible(n)}
              onPointerDown={(e) => e.stopPropagation()}
              // Visible: the eye appears only on hover (or focus). Hidden:
              // it ALWAYS stays, dimmed -- it is the only clue that the layer is there
              // but not visible, and the way to turn it back on.
              className={
                "flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-muted outline-none hover:bg-surface-3 hover:text-fg " +
                "data-[focus-visible]:shadow-[var(--ring)] " +
                (n.visible ? "opacity-0 group-hover:opacity-100 focus-visible:opacity-100" : "text-fg-subtle opacity-70")
              }
            >
              <Icon name={n.visible ? "eye" : "eyeOff"} size={14} />
            </Button>
          </GridListItem>
        );
      }}
    </GridList>
  );

  return (
    <div className="flex h-full flex-col text-[13px] text-fg">
      {/* The header appears ONLY with a selection: the title is already in
          the tab, and at rest those 36px are space for layers. */}
      {selection.length > 0 && (
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-3">
        <h3 className={cls.sectionTitle}>{selection.length === 1 ? "1 selected" : `${selection.length} selected`}</h3>
        <div className="ml-auto flex items-center">
          <IconButton
            icon="trash"
            label="Delete the selected layers"
            size={24}
            isDisabled={selection.length === 0}
            onPress={deleteSelected}
          />
        </div>
      </div>
      )}
      {virtualized ? (
        <Virtualizer layout={ListLayout} layoutOptions={{ rowHeight: ROW_HEIGHT }}>
          {list}
        </Virtualizer>
      ) : (
        list
      )}
    </div>
  );
}
