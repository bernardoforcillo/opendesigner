import { Button } from "react-aria-components";
import { useScene } from "../store/store";
import { contentWorldBounds } from "../store/groups";
import { nextOrderKey } from "../store/orderKey";
import { makeCreateNodeOp, makeInstanceNode, uuid } from "../tools/ops";

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

  // Piazza un'istanza del componente `componentId`. La scena si rilegge FRESCA
  // dallo store (non dalla closure di render, che un op nel frattempo potrebbe
  // aver invecchiato), come fa performDrop di LayersPanel.
  function placeInstance(componentId: string) {
    const store = useScene.getState();
    const cur = store.scene;
    if (!cur) return;
    const comp = cur.components[componentId];
    if (!comp) return;
    const master = cur.nodes[comp.rootNodeId];
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
    <div className="flex flex-col border-t border-neutral-200 text-sm text-neutral-700">
      <div className="border-b border-neutral-200 px-2 py-1.5 font-medium text-neutral-500">Componenti</div>
      {entries.length === 0 ? (
        <div className="px-2 py-4 text-neutral-400">Nessun componente</div>
      ) : (
        <ul aria-label="Componenti" className="max-h-40 overflow-auto py-1">
          {entries.map(([id, comp]) => (
            <li key={id}>
              <Button
                onPress={() => placeInstance(id)}
                className="flex w-full items-center gap-1.5 px-2 py-1 text-left outline-none hover:bg-sky-50 data-[focus-visible]:ring-1 data-[focus-visible]:ring-inset data-[focus-visible]:ring-sky-500"
              >
                <span aria-hidden className="text-neutral-400">◇</span>
                <span className="min-w-0 flex-1 truncate">
                  {comp.name.trim() !== "" ? comp.name : "Componente senza nome"}
                </span>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
