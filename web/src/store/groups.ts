import { intersectBounds, unionBounds, worldAabbOfNode, type Bounds } from "../canvas/geometry";
import { IDENTITY, compose, localTransformOf, mapBounds, type Transform, worldBoundsOfNode, worldToLocal, worldTransformOf } from "../canvas/transform";
import { ancestorsOf, childrenOf } from "./tree";
import { instanceDescentLocal, isInstance, resolveInstance } from "./instances";
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
//
// UN'ISTANZA (kind "instance", store/instances.ts) è, per i bounds, un GRUPPO il
// cui contenuto è il sottoalbero del master: nessun box proprio (x/y sono la sua
// traslazione, width/height non li legge nessuno), bounds DERIVATI dal master
// mappato dalla trasformazione di discesa (contentIn -> instanceContentBounds).
// La cornice di selezione, le 8 maniglie e la X del pannello leggono da qui,
// come per un gruppo. SEMPLIFICAZIONE consapevole: il ritaglio di un frame
// INTERNO al master (un frame con clipsContent DENTRO il componente, con figli
// che gli sporgono) non è applicato ai bounds derivati -- accumulateMaster
// unisce i box senza rifare la catena clip-aware di clippedWorldBoundsOf, che
// segue gli antenati REALI e non il contesto virtuale dell'istanza. È un caso di
// bordo; l'istanza resta comunque OPACA (marquee e cornice sono un box solo),
// quindi la divergenza è al più una cornice leggermente più larga del dipinto.

export function isGroup(n: NodeLite | undefined): boolean {
  return n?.kind === "group";
}

// Il box MONDO che l'utente VEDE di un nodo: per un gruppo l'unione dei box dei
// figli (ricorsivamente: un gruppo di gruppi è l'unione delle unioni), per
// chiunque altro il proprio.
//
// null quando non c'è niente da incorniciare: un gruppo vuoto (o fatto solo di
// gruppi vuoti, o i cui figli sono tutti NASCOSTI) non ha bounds, e chi disegna
// la cornice di selezione deve saltarlo invece di disegnare un rettangolo
// degenere all'origine.
export function contentWorldBounds(scene: SceneState, n: NodeLite): Bounds | null {
  return contentIn(scene, n, new Set());
}

// Il box MONDO di un nodo, RITAGLIATO ai frame antenati con clipsContent. È la
// stessa regola, identica, delle tre discese del renderer: un FRAME con
// clipsContent nasconde i figli fuori dal proprio box, e quel taglio vale
// insieme per il DISEGNO (drawSiblings), l'HIT-TEST (pickIn) e il MARQUEE
// (collectIn, che interseca il box mondo del frame -- la stessa intersectBounds
// usata qui). La cornice di selezione e le sue 8 MANIGLIE leggono da qui (via
// contentWorldBounds -> selectionWorldBounds): senza il taglio, un figlio che
// sporge da un frame ritagliante avrebbe maniglie disegnate -- e AFFERRABILI
// (selectTool.ts::handleUnderPointer usa lo stesso box) -- su canvas vuoto oltre
// il bordo del frame, dove nessun pixel si disegna. È la divergenza
// vedi-vs-seleziona che contentIn evita già per i figli INVISIBILI di un gruppo,
// presa dal lato del clip.
//
// Un nodo INTERAMENTE fuori dal clip non ha box (null): niente cornice, come un
// gruppo con tutti i figli nascosti. I clip annidati si compongono -- ogni frame
// antenato restringe ancora.
//
// Il box del nodo è ROTAZIONE-INCLUSA (worldAabbOfNode: l'AABB della sua
// geometria ruotata, nello spazio del parent) poi portato al mondo con la
// trasformazione del parent -- così la cornice di selezione di una multipla
// racchiude quello che un nodo ruotato occupa DAVVERO, non il suo box
// asse-allineato non ruotato (traccia 2). Il ritaglio ai frame resta
// axis-aligned (intersectBounds), come le tre discese del renderer.
function clippedWorldBoundsOf(scene: SceneState, n: NodeLite): Bounds | null {
  let box: Bounds = mapBounds(worldTransformOf(scene, n.parentId), worldAabbOfNode(n));
  for (const anc of ancestorsOf(scene, n.id)) {
    if (anc.kind === "frame" && anc.clipsContent) {
      const next = intersectBounds(box, worldBoundsOfNode(scene, anc));
      if (!next) return null;
      box = next;
    }
  }
  return box;
}

function contentIn(scene: SceneState, n: NodeLite, seen: Set<string>): Bounds | null {
  // Un'ISTANZA deriva i suoi bounds dal MASTER, come un gruppo li deriva dai
  // figli: il sottoalbero del master mappato dalla trasformazione di discesa
  // (vedi instanceContentBounds). Non ha un box proprio da leggere -- x/y sono la
  // sua traslazione, width/height non li legge nessuno, come per un gruppo.
  if (isInstance(n)) return instanceContentBounds(scene, n, new Set());
  if (!isGroup(n)) return clippedWorldBoundsOf(scene, n);
  // Ciclo in un documento malformato: già visitato, rivisitarlo non finirebbe
  // mai (stessa guardia di tree.ts::subtreeOf).
  if (seen.has(n.id)) return null;
  seen.add(n.id);
  const boxes: Bounds[] = [];
  for (const c of childrenOf(scene, n.id)) {
    // Un figlio INVISIBILE non è contenuto: la stessa regola, identica, delle
    // tre discese del renderer -- drawSiblings, pickIn e collectIn fanno
    // `continue` su !visible PRIMA di scendere, quindi un nodo nascosto (e con
    // lui tutto il suo sottoalbero: non si disegna il figlio di qualcosa che
    // non c'è) non si vede, non si clicca e il marquee non lo prende.
    // Includerlo qui darebbe a un gruppo una cornice e 8 maniglie su canvas
    // VUOTO -- la stessa divergenza vedi-vs-seleziona che quelle tre discese
    // esistono per evitare -- e, peggio, il pannello proprietà (via
    // frameOriginOf) direbbe come X il bordo del figlio nascosto: digitarci
    // dentro un numero manderebbe il contenuto visibile da un'altra parte.
    // Un gruppo con TUTTI i figli nascosti ricade sul ramo del gruppo vuoto
    // (unionBounds di niente => null), che è esattamente come si comporta.
    if (!c.visible) continue;
    const b = contentIn(scene, c, seen);
    if (b) boxes.push(b);
  }
  return unionBounds(boxes);
}

// I bounds MONDO del contenuto di un'istanza: il box del sottoalbero del master,
// mappato dalla trasformazione di discesa. Segue alla lettera la formula della
// traccia:
//
//   contentWorldBounds(istanza)
//     = mapBounds( worldTransformOf(parent) ∘ localTransformOf(n) ∘ translate(-master.x,-master.y),
//                  <bounds locali del sottoalbero del master> )
//
// I bounds locali del master sono l'unione dei box del suo sottoalbero nello
// spazio in cui è scritta la x/y della sua radice (accumulateMaster con base
// IDENTITÀ); poi una sola mapBounds attraverso la discesa MONDO li porta dove
// l'istanza li disegna. Così la rotazione PROPRIA dell'istanza compone da sé
// (sta in localTransformOf(n) dentro descentWorld, e mapBounds prende l'AABB del
// box ruotato) -- disegno, hit-test e cornice scendono con la stessa matrice.
//
// `null` (niente cornice) quando il master manca o non disegna niente, e quando
// il componente è già in `visited` (auto-referenza): esattamente come un gruppo
// vuoto.
function instanceContentBounds(scene: SceneState, n: NodeLite, visited: Set<string>): Bounds | null {
  const resolved = resolveInstance(scene, n);
  if (!resolved) return null;
  if (visited.has(resolved.componentId)) return null;
  const nextVisited = new Set(visited).add(resolved.componentId);
  const boxes: Bounds[] = [];
  accumulateMaster(scene, resolved.masterRoot, IDENTITY, boxes, new Set(), nextVisited);
  const local = unionBounds(boxes);
  if (!local) return null;
  const descentWorld = compose(worldTransformOf(scene, n.parentId), instanceDescentLocal(n, resolved.masterRoot));
  return mapBounds(descentWorld, local);
}

// Accumula i box del sottoalbero di un master nello spazio in cui `toBase`
// mappa. Rispecchia la discesa del renderer, per tenere vedi-vs-seleziona:
//   - un nodo (o container) INVISIBILE porta via con sé tutto il suo sottoalbero;
//   - un GRUPPO e un'ISTANZA non hanno box PROPRIO (i loro bounds sono derivati);
//   - un'istanza ANNIDATA contribuisce il proprio contenuto derivato, con la
//     stessa guardia ai cicli per componentId;
//   - ogni altro nodo contribuisce il suo box (AABB ruotato) mappato in base.
// `seen` è la guardia ai cicli STRUTTURALI (parent malformati); `visited` quella
// ai cicli di COMPONENTE. NB: il ritaglio dei frame INTERNI al master non è
// applicato ai bounds -- vedi il commento in cima al file per la scelta.
function accumulateMaster(
  scene: SceneState,
  node: NodeLite,
  toBase: Transform,
  boxes: Bounds[],
  seen: Set<string>,
  visited: ReadonlySet<string>,
): void {
  if (!node.visible || seen.has(node.id)) return;
  seen.add(node.id);
  if (isInstance(node)) {
    const resolved = resolveInstance(scene, node);
    if (resolved && !visited.has(resolved.componentId)) {
      const nextVisited = new Set(visited).add(resolved.componentId);
      const inner: Bounds[] = [];
      accumulateMaster(scene, resolved.masterRoot, IDENTITY, inner, new Set(), nextVisited);
      const innerLocal = unionBounds(inner);
      if (innerLocal) boxes.push(mapBounds(compose(toBase, instanceDescentLocal(node, resolved.masterRoot)), innerLocal));
    }
    // Un'istanza non ha figli in `nodes`: niente discesa oltre qui.
    return;
  }
  // Gruppo: nessun box proprio (i suoi bounds sono l'unione dei figli, qui sotto).
  if (!isGroup(node)) boxes.push(mapBounds(toBase, worldAabbOfNode(node)));
  const childBase = compose(toBase, localTransformOf(node));
  for (const c of childrenOf(scene, node.id)) accumulateMaster(scene, c, childBase, boxes, seen, visited);
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
  // Un'ISTANZA è come un gruppo qui: x/y sono la sua traslazione, non l'angolo
  // della cornice (che è quello del contenuto del master). Vedi contentIn.
  if (!isGroup(n) && !isInstance(n)) return { x: n.x, y: n.y };
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
  if (!scene.nodes.at(id)) return id;
  const path = pathTo(scene, id);
  const entered = enteredContainers(scene, selection);
  // Si salta il PREFISSO di contenitori in cui siamo già entrati: sono
  // trasparenti al click, come lo è la pagina.
  let i = 0;
  while (i < path.length - 1 && entered.has(path[i])) i++;
  for (; i < path.length; i++) {
    if (path[i] === id) return id;
    if (isGroup(scene.nodes.at(path[i]))) return path[i];
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
  if (!scene.nodes.at(id)) return null;
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
    const n = scene.nodes.at(id);
    if (!isGroup(n)) {
      out.push(id);
      return;
    }
    for (const c of childrenOf(scene, id)) push(c.id);
  };
  for (const id of ids) push(id);
  return out;
}
