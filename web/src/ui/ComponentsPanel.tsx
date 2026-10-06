import { Button as RacButton } from "react-aria-components";
import { Button, EmptyState, Icon, IconButton, cls } from "./ds";
import { useScene } from "../store/store";
import { contentWorldBounds } from "../store/groups";
import { nextOrderKey } from "../store/orderKey";
import { makeCreateComponentOp, makeCreateNodeOp, makeInstanceNode, uuid } from "../tools/ops";

// COMPONENTS PANEL (M4) — lists the document's components (SceneState.
// components) and, with a click, PLACES an instance of the chosen one on the current
// page. It is the complement of selectTool's create-component (Ctrl+Alt+K):
// there a master is registered, here it is used.
//
// Like every other panel it obeys the gesture rule: placing an instance
// is ONE gesture = one op (CreateNode of a node of kind "instance") = one undo entry,
// and goes through beginGesture/endGesture like the tools and the other panels.

// By how much (in WORLD units) the content of the just-placed instance is
// shifted relative to the master's: the instance renders the master at its own
// origin (store/instances.ts::instanceDescentLocal), so x/y = the master's origin
// + offset shifts the whole rendered subtree by that offset. It only serves to
// keep the instance from landing EXACTLY on top of the master -- otherwise it would look
// as if the click had done nothing.
const PLACE_OFFSET = 20;

export function ComponentsPanel() {
  const scene = useScene((s) => s.scene);
  const entries = scene ? Object.entries(scene.components) : [];
  // "Create component" is CONTEXTUAL: it exists only with exactly one node
  // selected (like selectTool's Ctrl/Cmd+Alt+K, which is replicated here: same
  // op, same gesture, same fallback name). With zero or several nodes there is
  // nothing to do and the button is not drawn at all.
  const selection = useScene((s) => s.selection);
  const canCreate = selection.length === 1;

  function createFromSelection() {
    const store = useScene.getState();
    const cur = store.scene;
    if (!cur || store.selection.length !== 1) return;
    const rootNodeId = store.selection[0];
    const master = cur.nodes.at(rootNodeId);
    if (!master) return;
    const name =
      master.name.trim() !== "" ? master.name : `Component ${Object.keys(cur.components).length + 1}`;
    store.beginGesture();
    store.endGesture([makeCreateComponentOp(uuid(), rootNodeId, name)]);
  }

  // Places an instance of component `componentId`. The scene is re-read FRESH
  // from the store (not from the render closure, which an op in the meantime might
  // have aged), as LayersPanel's performDrop does.
  function placeInstance(componentId: string) {
    const store = useScene.getState();
    const cur = store.scene;
    if (!cur) return;
    const comp = cur.components[componentId];
    if (!comp) return;
    const master = cur.nodes.at(comp.rootNodeId);
    // The core would reject an instance pointing to a missing component/master: we do not
    // send a known-invalid op.
    if (!master) return;
    // The master subtree's WORLD SIZE: for a frame its box,
    // for a group the union of the children (contentWorldBounds). null for a master
    // that draws nothing -> falls back to the root node's own box, so
    // the properties panel still has a sensible W/H to show (the instance's real
    // bounds stay derived from the master).
    const bounds = contentWorldBounds(cur, master);
    const node = makeInstanceNode({
      id: uuid(),
      // The CURRENT page, like the drawing tools; the "page1" fallback covers only
      // the case -- unreachable with an installed scene -- in which
      // currentPageId is not yet resolved.
      parentId: store.currentPageId ?? "page1",
      // After the top of the siblings, like shapes (nextOrderKey).
      orderKey: nextOrderKey(cur),
      name: comp.name,
      // Master's origin + offset: shifts the rendered content by PLACE_OFFSET
      // relative to the master (see the constant).
      x: master.x + PLACE_OFFSET,
      y: master.y + PLACE_OFFSET,
      width: bounds?.width ?? master.width,
      height: bounds?.height ?? master.height,
      componentId,
    });
    store.beginGesture();
    // Selected RIGHT AWAY: endGesture reconciles the selection against the
    // FINAL scene, so it can already name the instance the op is about to create (same
    // pattern as grouping in selectTool).
    store.setSelection([node.id]);
    store.endGesture([makeCreateNodeOp(node)]);
  }

  return (
    <div className="flex flex-col text-[13px] text-fg">
      <div className="flex h-9 items-center gap-2 px-3">
        <h3 className={cls.sectionTitle}>Components</h3>
        {entries.length > 0 && <span className="text-[11px] tabular-nums text-fg-subtle">{entries.length}</span>}
        <div className="ml-auto flex items-center">
          {canCreate && entries.length > 0 && (
            <IconButton icon="plus" label="Create component from selection" size={24} onPress={createFromSelection} />
          )}
        </div>
      </div>
      {entries.length === 0 ? (
        <EmptyState
          icon="components"
          title="No components"
          hint="Select a layer and press Ctrl+Alt+K to turn it into a reusable component."
          action={
            canCreate ? (
              <Button variant="secondary" icon="plus" onPress={createFromSelection}>
                Create component
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul aria-label="Components" className="flex flex-col gap-1 px-2 pb-2">
          {entries.map(([id, comp]) => {
            const label = comp.name.trim() !== "" ? comp.name : "Unnamed component";
            return (
              <li key={id}>
                {/* The whole card is the "Instantiate" button: the accessible name
                    is the component's (aria-label), the "+ Instantiate" on the right
                    is only the visual hint of the action and appears on hover. */}
                <RacButton
                  aria-label={label}
                  onPress={() => placeInstance(id)}
                  className={
                    "group flex h-11 w-full items-center gap-2.5 rounded-lg border border-line bg-surface px-2 text-left outline-none " +
                    "transition-colors hover:border-line-strong hover:bg-surface-2 data-[pressed]:bg-surface-3 " +
                    "data-[focus-visible]:shadow-[var(--ring)]"
                  }
                >
                  <span aria-hidden className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
                    <Icon name="components" size={15} />
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
                  <span
                    aria-hidden
                    className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-fg-subtle opacity-0 transition-opacity group-hover:opacity-100 group-data-[focus-visible]:opacity-100"
                  >
                    <Icon name="plus" size={12} />
                    Instantiate
                  </span>
                </RacButton>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

