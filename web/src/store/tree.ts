import type { NodeLite, SceneState } from "./types";

// ATTRAVERSAMENTO DEL DOCUMENTO COME ALBERO.
//
// `parentId` esisteva da M0 ma nessuno lo leggeva: la scena era piatta e ogni
// nodo figlio di "page1". Da qui in poi è la struttura portante -- gruppi,
// frame e componenti sono tutti sottoalberi -- e questi sono gli unici
// attraversamenti che il resto del codice deve usare: renderer, pannello
// livelli, hit-test e le altre tracce.
//
// Metà TS di internal/core/tree.go: stesse regole, stesso ORDINE, stessa
// tolleranza a un documento malformato. Le due implementazioni devono restare
// indistinguibili come applyOp e core.Apply -- l'ordine dei figli decide
// l'ordine di disegno, e l'ordine del sottoalbero decide la sequenza con cui
// una delete a cascata viene annullata.
//
// I nodi vivono in una MAPPA piatta (`scene.nodes`) e i figli non sono
// indicizzati: ogni chiamata scansiona la mappa. È la stessa scelta di
// selectors.ts::layersInDrawOrder (un sort a ogni chiamata) e per la stessa
// ragione: `scene` è immutabile e ricostruita a ogni op, quindi qualunque
// indice andrebbe invalidato di continuo. Se un giorno il costo si vedrà, il
// posto dove metterlo è QUESTO modulo, non i chiamanti.

// Ordine dei fratelli: order key crescente (dal fondo alla cima nell'ordine di
// disegno), id come spareggio. Lo spareggio non è pedanteria: l'ordine di
// Object.values su una mappa non è definito dal linguaggio, quindi senza di
// esso due chiamate identiche potrebbero dare liste diverse -- e la sequenza di
// ripristino di una delete a cascata cambierebbe a ogni esecuzione.
// Confronto per code unit come in Go (byte-wise), non localeCompare: le order
// key sono indici frazionari ASCII, e una collazione locale le ordinerebbe
// diversamente dal server.
function bySiblingOrder(a: NodeLite, b: NodeLite): number {
  if (a.orderKey !== b.orderKey) return a.orderKey < b.orderKey ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// I figli DIRETTI di un container, ordinati. `parentId` può essere l'id di un
// nodo o quello di una Page (i root di quella pagina).
export function childrenOf(scene: SceneState, parentId: string): NodeLite[] {
  return Object.values(scene.nodes).filter((n) => n.parentId === parentId).sort(bySiblingOrder);
}

// TUTTI i figli di TUTTI i container in una passata sola: la stessa lista che
// childrenOf produrrebbe (stesso filtro, stesso ordine), indicizzata per
// parentId. Una chiave esiste solo se ha almeno un figlio.
//
// È l'indice che il commento in cima a questo modulo prevedeva: chi deve
// scendere l'INTERO albero (il renderer, a ogni frame, e l'hit-test) farebbe
// altrimenti una childrenOf -- cioè una scansione della mappa -- per ogni nodo
// visitato, che su una scena di N nodi è N scansioni, N^2 confronti a frame.
// Costruirlo una volta e passarlo alla discesa lo riporta a una passata più un
// sort per container. Resta un indice USA E GETTA, ricostruito a ogni
// chiamata: `scene` è immutabile e ricostruita a ogni op, quindi un indice
// conservato andrebbe invalidato di continuo.
//
// Non ha una controparte in Go: il server non disegna e non fa hit-test, non
// scende mai l'albero intero a ripetizione. Le REGOLE (chi è figlio di chi, in
// che ordine) restano quelle di childrenOf, che la controparte ce l'ha.
export function childIndexOf(scene: SceneState): Map<string, NodeLite[]> {
  const index = new Map<string, NodeLite[]>();
  for (const n of Object.values(scene.nodes)) {
    const siblings = index.get(n.parentId);
    if (siblings) siblings.push(n);
    else index.set(n.parentId, [n]);
  }
  for (const siblings of index.values()) siblings.sort(bySiblingOrder);
  return index;
}

// TUTTO il documento in ordine di DISEGNO: si parte dai figli delle pagine
// (nell'ordine delle pagine) e si scende in pre-ordine -- un container prima
// dei suoi figli, i fratelli per order key. È lo stesso cammino di
// renderer/canvasRenderer.ts::drawScene, quindi l'ultimo elemento è il nodo
// disegnato PIÙ IN ALTO di tutto il documento.
//
// Serve a chi deve confrontare la posizione di due nodi che NON sono fratelli
// -- il raggruppamento, che deve sapere qual è il nodo più in alto della
// selezione per sapere dove nasce il gruppo: fra due parent diversi le order
// key non sono confrontabili, è l'albero a decidere.
//
// Chi NON è raggiungibile da una pagina non compare: non ha un posto nel mondo,
// esattamente come per il renderer.
//
// Come childIndexOf, non ha una controparte in Go (il server non disegna); le
// REGOLE sono quelle di childrenOf, che la controparte ce l'ha.
export function documentOrder(scene: SceneState): NodeLite[] {
  const children = childIndexOf(scene);
  const out: NodeLite[] = [];
  const seen = new Set<string>();
  const roots = scene.pages.flatMap((p) => children.get(p.id) ?? []);
  // Pila esplicita e figli in ordine INVERSO, come subtreeOf: stessa ragione
  // (profondità decisa dall'utente) e stesso ordine di uscita.
  const stack: NodeLite[] = [];
  for (let i = roots.length - 1; i >= 0; i--) stack.push(roots[i]);
  while (stack.length > 0) {
    const n = stack.pop() as NodeLite;
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(n);
    const kids = children.get(n.id) ?? [];
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return out;
}

// Il nodo E tutti i suoi discendenti, in PRE-ORDINE: ogni nodo compare sempre
// dopo il proprio parent, i fratelli in ordine di order key.
//
// L'ordine non è estetico: è ciò che rende la lista riusabile come sequenza di
// RICREAZIONE (l'inverso di una delete a cascata, vedi history.ts::invertOp).
// Ricrearli in quest'ordine soddisfa l'invariante "il parent esiste" a ogni
// passo; in ordine inverso ogni figlio verrebbe rifiutato.
//
// Lista vuota se il nodo non esiste.
export function subtreeOf(scene: SceneState, id: string): NodeLite[] {
  const root = scene.nodes[id];
  if (!root) return [];
  const out: NodeLite[] = [];
  const seen = new Set<string>();
  // Pila esplicita e non ricorsione: la profondità la decide l'utente (gruppi
  // dentro gruppi dentro frame) e un documento malformato potrebbe renderla
  // illimitata. In pila i figli vanno in ordine INVERSO, così escono in ordine
  // di order key.
  const stack: NodeLite[] = [root];
  while (stack.length > 0) {
    const n = stack.pop() as NodeLite;
    // Ciclo in un documento malformato: già visitato, rivisitarlo non
    // finirebbe mai.
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(n);
    const children = childrenOf(scene, n.id);
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  return out;
}

// Il sottoalbero SENZA la radice, stesso ordine.
export function descendantsOf(scene: SceneState, id: string): NodeLite[] {
  return subtreeOf(scene, id).slice(1);
}

// Gli antenati di un nodo, dal più VICINO al più lontano. Si ferma alla pagina:
// una Page non è un NodeLite, quindi un root di pagina non ha antenati.
export function ancestorsOf(scene: SceneState, id: string): NodeLite[] {
  const out: NodeLite[] = [];
  const seen = new Set<string>([id]);
  let cur = scene.nodes[id];
  while (cur) {
    const parent = scene.nodes[cur.parentId];
    // seen: un ciclo in un documento malformato non deve far salire per sempre.
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    out.push(parent);
    cur = parent;
  }
  return out;
}

// Relazione STRETTA: nessuno è antenato di se stesso. Risale la catena invece
// di scendere l'albero -- la profondità è tipicamente molto minore del numero
// di discendenti, ed è la direzione in cui va fatto il controllo dei cicli di
// un reparent.
export function isAncestorOf(scene: SceneState, ancestorId: string, id: string): boolean {
  const seen = new Set<string>();
  let cur = scene.nodes[id];
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (cur.parentId === ancestorId) return true;
    cur = scene.nodes[cur.parentId];
  }
  return false;
}

// I nodi PIÙ IN ALTO di un insieme: toglie ogni id che ha un ANTENATO
// nell'insieme stesso, mantenendo l'ordine di quelli che restano (e senza
// duplicati).
//
// Serve a chi costruisce op che agiscono su un SOTTOALBERO -- oggi la
// cancellazione (deleteNode cascata, vedi applyOp e core.applyDelete). Con la
// scena piatta "un op per id selezionato" era corretto; con l'albero non lo è
// più: se la selezione contiene un gruppo E un suo figlio, il secondo op
// nomina un nodo che la cascata del primo ha già portato via. Il server lo
// rifiuta (ErrNodeNotFound -> rollback e banner rosso) e, molto peggio,
// invertOp su quel secondo op ritorna null, quindi invertChain fa saltare la
// voce di undo dell'INTERO gesto: un gruppo cancellato per sempre, senza
// nessun Ctrl+Z possibile. Potare qui è ciò che rende il gesto UNO e
// annullabile.
//
// Gli id che non stanno nella scena restano (nessun antenato da trovare): non
// è questa funzione a decidere se un id è valido.
export function topmostOf(scene: SceneState, ids: readonly string[]): string[] {
  const set = new Set(ids);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (ancestorsOf(scene, id).some((a) => set.has(a.id))) continue;
    out.push(id);
  }
  return out;
}

// Un nodo è RAGGIUNGIBILE da una pagina quando, risalendo la catena dei parent,
// si incontra quella pagina come container di un antenato (o del nodo stesso).
// È esattamente il criterio con cui il renderer decide se disegnarlo:
// canvasRenderer.ts::rootsOf prende i figli diretti della pagina e drawSiblings
// ne scende il sottoalbero, quindi un nodo si vede su currentPageId sse e solo
// se un suo antenato-o-sé ha parentId === pageId. Tenere questa funzione
// allineata a rootsOf è ciò che impedisce la divergenza vedi-vs-seleziona
// quando la selezione va potata per pagina (store.ts).
//
// false per un id assente (scene.nodes[id] undefined): un nodo che non esiste
// non è raggiungibile da nessuna pagina, quindi questa funzione sussume anche il
// controllo di esistenza. `seen` come in ancestorsOf: un ciclo in un documento
// malformato non deve far risalire per sempre.
export function isReachableFrom(scene: SceneState, id: string, pageId: string): boolean {
  const seen = new Set<string>();
  let cur = scene.nodes[id];
  while (cur && !seen.has(cur.id)) {
    if (cur.parentId === pageId) return true;
    seen.add(cur.id);
    cur = scene.nodes[cur.parentId];
  }
  return false;
}

// Un parent VALIDO: un nodo esistente oppure una Page del documento. La stringa
// vuota non è né l'uno né l'altro -- un nodo senza parent non è raggiungibile da
// nessuna pagina, quindi non è disegnabile né selezionabile: esisterebbe solo
// dentro la mappa. Parità con core.parentExists (Go).
export function parentExists(scene: SceneState, parentId: string): boolean {
  return parentId in scene.nodes || scene.pages.some((p) => p.id === parentId);
}
