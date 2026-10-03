import { Button as RacButton } from "react-aria-components";
import { Button, EmptyState, Icon, IconButton, cls } from "./ds";
import { useScene } from "../store/store";
import { contentWorldBounds } from "../store/groups";
import { nextOrderKey } from "../store/orderKey";
import { makeCreateComponentOp, makeCreateNodeOp, makeInstanceNode, uuid } from "../tools/ops";

// PANNELLO COMPONENTI (M4) — elenca i componenti del documento (SceneState.
// components) e, con un click, PIAZZA un'istanza di quello scelto sulla pagina
// corrente. È il complemento del create-component di selectTool (Ctrl+Alt+K):
// là si registra un master, qui lo si usa.
//
// Come ogni altro pannello obbedisce alla regola dei gesti: piazzare un'istanza
// è UN gesto = un op (CreateNode di un nodo kind "instance") = una voce di undo,
// e passa da beginGesture/endGesture come i tool e gli altri pannelli.

// Di quanto (in unità MONDO) il contenuto dell'istanza appena piazzata è
// spostato rispetto a quello del master: l'istanza rende il master alla propria
// origine (store/instances.ts::instanceDescentLocal), quindi x/y = origine del
// master + offset sposta l'intero sottoalbero reso di quell'offset. Serve solo a
// non far cadere l'istanza ESATTAMENTE sopra il master -- altrimenti sembrerebbe
// che il click non abbia fatto niente.
const PLACE_OFFSET = 20;

export function ComponentsPanel() {
  const scene = useScene((s) => s.scene);
  const entries = scene ? Object.entries(scene.components) : [];
  // "Crea componente" è CONTESTUALE: esiste solo con esattamente un nodo
  // selezionato (come Ctrl/Cmd+Alt+K di selectTool, che qui si replica: stesso
  // op, stesso gesto, stesso nome di ripiego). Con zero o più nodi non c'è
  // niente da fare e il pulsante non si disegna affatto.
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

  // Piazza un'istanza del componente `componentId`. La scena si rilegge FRESCA
  // dallo store (non dalla closure di render, che un op nel frattempo potrebbe
  // aver invecchiato), come fa performDrop di LayersPanel.
  function placeInstance(componentId: string) {
    const store = useScene.getState();
    const cur = store.scene;
    if (!cur) return;
    const comp = cur.components[componentId];
    if (!comp) return;
    const master = cur.nodes.at(comp.rootNodeId);
    // Il core rifiuterebbe un'istanza verso un componente/master assente: non si
    // manda un op noto invalido.
    if (!master) return;
    // La DIMENSIONE mondo del sottoalbero del master: per un frame il suo box,
    // per un gruppo l'unione dei figli (contentWorldBounds). null per un master
    // che non disegna niente -> si ripiega sul box proprio del nodo radice, così
    // il pannello proprietà ha comunque un W/H sensato da mostrare (i bounds
    // veri dell'istanza restano derivati dal master).
    const bounds = contentWorldBounds(cur, master);
    const node = makeInstanceNode({
      id: uuid(),
      // La pagina CORRENTE, come i tool di disegno; il ripiego "page1" copre solo
      // il caso -- irraggiungibile con una scena installata -- in cui
      // currentPageId non è ancora risolto.
      parentId: store.currentPageId ?? "page1",
      // Dopo la cima dei fratelli, come le forme (nextOrderKey).
      orderKey: nextOrderKey(cur),
      name: comp.name,
      // Origine del master + offset: sposta il contenuto reso di PLACE_OFFSET
      // rispetto al master (vedi la costante).
      x: master.x + PLACE_OFFSET,
      y: master.y + PLACE_OFFSET,
      width: bounds?.width ?? master.width,
      height: bounds?.height ?? master.height,
      componentId,
    });
    store.beginGesture();
    // Selezionata SUBITO: endGesture riconcilia la selezione contro la scena
    // FINALE, quindi può già nominare l'istanza che l'op sta per creare (stesso
    // schema del raggruppamento in selectTool).
    store.setSelection([node.id]);
    store.endGesture([makeCreateNodeOp(node)]);
  }

  return (
    <div className="flex flex-col text-[13px] text-fg">
      <div className="flex h-9 items-center gap-2 px-3">
        <h3 className={cls.sectionTitle}>Componenti</h3>
        {entries.length > 0 && <span className="text-[11px] tabular-nums text-fg-subtle">{entries.length}</span>}
        <div className="ml-auto flex items-center">
          {canCreate && entries.length > 0 && (
            <IconButton icon="plus" label="Crea componente dalla selezione" size={24} onPress={createFromSelection} />
          )}
        </div>
      </div>
      {entries.length === 0 ? (
        <EmptyState
          icon="components"
          title="Nessun componente"
          hint="Seleziona un livello e premi Ctrl+Alt+K per trasformarlo in un componente riutilizzabile."
          action={
            canCreate ? (
              <Button variant="secondary" icon="plus" onPress={createFromSelection}>
                Crea componente
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul aria-label="Componenti" className="flex flex-col gap-1 px-2 pb-2">
          {entries.map(([id, comp]) => {
            const label = comp.name.trim() !== "" ? comp.name : "Componente senza nome";
            return (
              <li key={id}>
                {/* Tutta la scheda è il pulsante "Istanzia": il nome accessibile
                    è quello del componente (aria-label), il "+ Istanzia" a destra
                    è solo l'indizio visivo dell'azione e compare al passaggio. */}
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
                    Istanzia
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

