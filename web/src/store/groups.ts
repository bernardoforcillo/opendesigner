import { unionBounds, type Bounds } from "../canvas/geometry";
import { worldBoundsOfNode, worldToLocal } from "../canvas/transform";
import { ancestorsOf, childrenOf } from "./tree";
import type { NodeLite, SceneState } from "./types";

// I GRUPPI: cosa sono, dove finiscono i loro bounds e quale nodo seleziona un
// click.
//
// Un gruppo è un contenitore SENZA clipping e senza geometria propria:
//   - non si disegna e non si colpisce (renderer/shapes.ts): non ha niente da
//     riempire, e ciò che l'utente vede sono i figli;
//   - i suoi BOUNDS sono l'unione di quelli dei figli, DERIVATI a ogni lettura
//     invece che memorizzati -- memorizzarli vorrebbe dire ricalcolarli a ogni
//     spostamento di un figlio, in due implementazioni (Go e TS) che devono
//     restare identiche, per un valore che nessun op scrive;
//   - x/y restano la TRASLAZIONE che contribuisce ai figli (transform.ts::
//     localTransformOf): valgono 0 alla creazione -- raggruppare non sposta
//     nulla -- e cambiano quando il gruppo viene trascinato. width/height non
//     li legge nessuno.
//
// La POLITICA DI SELEZIONE sta qui e non nell'hit-test (vedi il commento su
// canvasRenderer.ts::hitTest): l'hit-test risponde "quale nodo c'è sotto il
// puntatore" -- il più interno, sempre -- e queste funzioni rispondono "quale
// nodo va selezionato", che è un'altra domanda e ha un'altra risposta.

export function isGroup(n: NodeLite | undefined): boolean {
  return n?.kind === "group";
}

// Il box MONDO che l'utente VEDE di un nodo: per un gruppo l'unione dei box dei
// figli (ricorsivamente: un gruppo di gruppi è l'unione delle unioni), per
// chiunque altro il proprio.
//
// null quando non c'è niente da incorniciare: un gruppo vuoto (o fatto solo di
// gruppi vuoti) non ha bounds, e chi disegna la cornice di selezione deve
// saltarlo invece di disegnare un rettangolo degenere all'origine.
export function contentWorldBounds(scene: SceneState, n: NodeLite): Bounds | null {
  return contentIn(scene, n, new Set());
}

function contentIn(scene: SceneState, n: NodeLite, seen: Set<string>): Bounds | null {
  if (!isGroup(n)) return worldBoundsOfNode(scene, n);
  // Ciclo in un documento malformato: già visitato, rivisitarlo non finirebbe
  // mai (stessa guardia di tree.ts::subtreeOf).
  if (seen.has(n.id)) return null;
  seen.add(n.id);
  const boxes: Bounds[] = [];
  for (const c of childrenOf(scene, n.id)) {
    const b = contentIn(scene, c, seen);
    if (b) boxes.push(b);
  }
  return unionBounds(boxes);
}

// L'angolo ALTO-SINISTRA della cornice di un nodo, nello spazio del PARENT --
// cioè lo stesso spazio in cui sono scritte le sue x/y, e quello in cui il
// pannello proprietà (ui/PropertiesPanel.tsx) legge e scrive X/Y.
//
// Per qualunque nodo che non sia un gruppo è banalmente la sua x/y: il box del
// modello È la cornice. Per un GRUPPO no, e senza questa funzione il pannello
// direbbe un numero diverso da quello che l'overlay disegna: x/y di un gruppo
// sono la TRASLAZIONE che contribuisce ai figli (0 alla creazione -- raggruppare
// non sposta un pixel), mentre la cornice è l'unione dei figli e può stare
// ovunque. "X" deve voler dire per un gruppo quello che vuol dire per tutti gli
// altri: dove si vede il bordo sinistro.
//
// Un gruppo VUOTO non ha cornice (contentWorldBounds null): resta la sua
// traslazione, che è l'unica coordinata che possiede -- e che il pannello
// scrive allora in modo assoluto, come per ogni altro nodo.
export function frameOriginOf(scene: SceneState, n: NodeLite): { x: number; y: number } {
  if (!isGroup(n)) return { x: n.x, y: n.y };
  const b = contentWorldBounds(scene, n);
  if (!b) return { x: n.x, y: n.y };
  // Dal MONDO (in cui contentWorldBounds risponde) allo spazio del parent: la
  // stessa direzione che l'hit-test usa per il puntatore, e l'unico spazio in
  // cui il numero è confrontabile con la x/y del nodo.
  return worldToLocal(scene, n.parentId, b.x, b.y);
}

// I contenitori in cui la selezione corrente è ENTRATA. Non è uno stato a
// parte, e di proposito: "essere dentro un gruppo" lo dice la selezione stessa
// -- se un figlio del gruppo è selezionato, siamo dentro quel gruppo. Uno stato
// separato ("contesto di editing") andrebbe invalidato a ogni cambio di
// selezione, a ogni undo e a ogni op remoto che cancella il contenitore;
// derivarlo non può mai andare fuori sincrono.
function enteredContainers(scene: SceneState, selection: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const id of selection) for (const a of ancestorsOf(scene, id)) out.add(a.id);
  return out;
}

// Il cammino dalla radice al nodo: gli antenati dal più LONTANO al più vicino,
// poi il nodo stesso.
function pathTo(scene: SceneState, id: string): string[] {
  const up = ancestorsOf(scene, id).map((n) => n.id);
  up.reverse();
  up.push(id);
  return up;
}

/**
 * Il nodo che un CLICK su `id` deve selezionare.
 *
 * LA CONVENZIONE (quella che gli utenti notano immediatamente):
 *  - un click seleziona il gruppo PIÙ ESTERNO che contiene ciò che si è
 *    cliccato -- un gruppo si muove come un oggetto solo;
 *  - un doppio click ENTRA nel gruppo (vedi enterTargetOf) e da lì in poi i
 *    click selezionano dentro, un livello per volta;
 *  - cliccare fuori dal gruppo in cui si è entrati ne esce, senza nessun gesto
 *    dedicato: la nuova selezione non ha più quel gruppo fra gli antenati.
 *
 * Solo i GRUPPI catturano il click. Un contenitore che non è un gruppo (oggi un
 * nodo qualunque con figli, domani un frame) lascia passare: i suoi figli si
 * selezionano direttamente, che è la convenzione dei frame/artboard.
 *
 * `id` non presente nella scena torna invariato: non è questa funzione a
 * decidere se un id è valido.
 */
export function selectionTargetOf(scene: SceneState, id: string, selection: readonly string[]): string {
  if (!scene.nodes[id]) return id;
  const path = pathTo(scene, id);
  const entered = enteredContainers(scene, selection);
  // Si salta il PREFISSO di contenitori in cui siamo già entrati: sono
  // trasparenti al click, come lo è la pagina.
  let i = 0;
  while (i < path.length - 1 && entered.has(path[i])) i++;
  for (; i < path.length; i++) {
    if (path[i] === id) return id;
    if (isGroup(scene.nodes[path[i]])) return path[i];
  }
  return id;
}

// La stessa politica applicata a una LISTA (i nodi che un marquee ha preso),
// senza duplicati e nell'ordine di partenza: due figli dello stesso gruppo
// danno il gruppo una volta sola. Il marquee deve selezionare quello che
// selezionerebbe un click, o la banda elastica sarebbe l'unico modo per
// prendere i figli di un gruppo senza entrarci.
export function selectionTargetsOf(scene: SceneState, ids: readonly string[], selection: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const target = selectionTargetOf(scene, id, selection);
    if (seen.has(target)) continue;
    seen.add(target);
    out.push(target);
  }
  return out;
}

/**
 * Il nodo che un DOPPIO CLICK su `id` deve selezionare: un livello più in
 * dentro di quello che il click semplice selezionerebbe.
 *
 * null quando non c'è niente in cui entrare (il click già seleziona `id`
 * stesso). È ciò che lascia il doppio click libero per il suo ALTRO
 * significato -- entrare in editing su un nodo testo, vedi selectTool -- invece
 * di doverli mettere in concorrenza: prima si entra nei gruppi, e quando non ce
 * ne sono più il doppio click torna a essere quello del testo.
 */
export function enterTargetOf(scene: SceneState, id: string, selection: readonly string[]): string | null {
  if (!scene.nodes[id]) return null;
  const current = selectionTargetOf(scene, id, selection);
  if (current === id) return null;
  const path = pathTo(scene, id);
  const i = path.indexOf(current);
  if (i < 0 || i + 1 >= path.length) return null;
  return path[i + 1];
}

/**
 * I nodi che un gesto di TRASFORMAZIONE (il resize) deve toccare davvero: un
 * gruppo viene espanso nei suoi figli, ricorsivamente.
 *
 * Perché il resize sì e lo spostamento no: spostare un gruppo è già espresso
 * dalla sua trasformazione -- x/y del gruppo traslano i figli, e un solo
 * setProps li muove tutti (vedi transform.ts). Una SCALA no: la trasformazione
 * di un container è una traslazione, quindi scrivere width/height su un gruppo
 * non scalerebbe proprio niente. Ridimensionare un gruppo è ridimensionare il
 * suo contenuto, ed è esattamente questa espansione.
 *
 * Un gruppo vuoto sparisce dalla lista (non c'è niente da trasformare); un id
 * che non è nella scena resta (non è questa funzione a validarlo).
 */
export function transformTargetsOf(scene: SceneState, ids: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const n = scene.nodes[id];
    if (!isGroup(n)) {
      out.push(id);
      return;
    }
    for (const c of childrenOf(scene, id)) push(c.id);
  };
  for (const id of ids) push(id);
  return out;
}
