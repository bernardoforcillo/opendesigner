import type { SceneState } from "../store/types";

// LA SCENA DEL PROTOTIPO: il documento visto come se contenesse UNA sola pagina
// con UNA sola schermata. Così il renderer di sempre (drawScene) disegna la
// schermata corrente -- stesse regole di clip, effetti, immagini, istanze --
// senza sapere che esiste un prototipo, e senza le altre schermate.
//
// Non si copia niente: la schermata viene RI-GENITORIZZATA sotto una pagina
// finta, e la mappa dei nodi è persistente (store/nodeMap.ts), quindi il costo è
// una sola voce nuova. Le altre schermate restano figlie delle pagine vere, che
// nella scena derivata non esistono: non sono raggiungibili, non si disegnano.
// I componenti restano al loro posto, e le istanze continuano a risolversi.

export const PROTO_PAGE_ID = "__prototype__";

let memo: { scene: SceneState; screenId: string; derived: SceneState } | null = null;

/**
 * La scena che mostra solo `screenId`, o null se il nodo non esiste. Memoizzata
 * sull'ultima coppia (scena, schermata): a ogni frame si restituisce lo STESSO
 * oggetto, e l'indice di scena del renderer non si ricostruisce.
 */
export function sceneForScreen(scene: SceneState, screenId: string): SceneState | null {
  if (memo && memo.scene === scene && memo.screenId === screenId) return memo.derived;
  const root = scene.nodes.at(screenId);
  if (!root) return null;
  const derived: SceneState = {
    ...scene,
    pages: [{ id: PROTO_PAGE_ID, name: "Prototipo" }],
    nodes: scene.nodes.set(screenId, { ...root, parentId: PROTO_PAGE_ID, visible: true }),
  };
  memo = { scene, screenId, derived };
  return derived;
}
