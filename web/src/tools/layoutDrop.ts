import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import type { Bounds } from "../canvas/geometry";
import { contentWorldBounds } from "../store/groups";
import { hasLayout, participates } from "../store/layout";
import { orderKeyBetween } from "../store/orderKey";
import { childrenOf, isAncestorOf } from "../store/tree";
import type { NodeLite, SceneState } from "../store/types";
import { makeReparentOp, makeSetPropsOp } from "./ops";

// RIORDINO TRASCINANDO nei frame con auto layout.
//
// Un figlio di un auto layout non si sposta scrivendo x/y: il server li
// ricalcola dopo ogni op e il nodo tornerebbe subito al suo posto. Trascinarlo
// vuol dire invece SCEGLIERE DOVE METTERLO NELLA FILA: la posizione del
// puntatore lungo l'asse del layout dice fra quali fratelli, e il gesto finisce
// in un cambio di order_key (stesso frame) o in un reparent (altro frame con
// auto layout). Le coordinate poi le calcola il layout.
//
// Tutto in funzioni pure: lo stato del gesto sta nel select tool, qui c'è solo
// la geometria e gli op.

export interface LayoutDrop {
  frameId: string;
  // Posizione d'inserimento fra i fratelli NON trascinati, in ordine di
  // order_key: 0 = prima di tutti, n = dopo tutti.
  index: number;
  vertical: boolean;
  // La linea d'inserimento, in coordinate MONDO: un rettangolo sottile
  // attraversato all'asse del layout, nel punto in cui il nodo verrebbe messo.
  indicator: Bounds;
}

// Lo spessore della linea d'inserimento, in unità mondo.
const INDICATOR_THICKNESS = 2;

/**
 * Il frame con auto layout che accoglie TUTTI i nodi dati come figli diretti, o
 * null. È la condizione per cui il trascinamento diventa un riordino invece di
 * uno spostamento: un nodo che il layout non dispone (un gruppo, un'istanza, un
 * nodo nascosto) o un figlio di un frame normale si sposta con x/y come sempre.
 */
export function reorderableParent(scene: SceneState, ids: readonly string[]): string | null {
  if (ids.length === 0) return null;
  const first = scene.nodes[ids[0]];
  if (!first) return null;
  const parent = scene.nodes[first.parentId];
  if (!hasLayout(parent)) return null;
  for (const id of ids) {
    const n = scene.nodes[id];
    if (!n || n.parentId !== parent.id || !participates(n)) return null;
  }
  return parent.id;
}

// Il frame con auto layout PIÙ INTERNO che contiene il punto, escludendo i nodi
// trascinati e tutto ciò che sta dentro di loro (non si può mettere un frame
// dentro sé stesso).
function frameAt(scene: SceneState, dragged: ReadonlySet<string>, p: { x: number; y: number }): NodeLite | null {
  let best: { node: NodeLite; depth: number } | null = null;
  for (const n of Object.values(scene.nodes)) {
    if (!hasLayout(n) || !n.visible) continue;
    if (dragged.has(n.id) || [...dragged].some((d) => isAncestorOf(scene, d, n.id))) continue;
    const b = contentWorldBounds(scene, n);
    if (!b || p.x < b.x || p.x > b.x + b.width || p.y < b.y || p.y > b.y + b.height) continue;
    let depth = 0;
    for (let cur: NodeLite | undefined = n; cur; cur = scene.nodes[cur.parentId]) depth++;
    if (!best || depth > best.depth) best = { node: n, depth };
  }
  return best?.node ?? null;
}

/**
 * Dove cadrebbe il nodo trascinato con il puntatore in `p` (coordinate MONDO).
 *
 * Il frame è quello con auto layout più interno sotto il puntatore; se non ce
 * n'è, resta quello di partenza (`originId`): rilasciare un po' fuori dalla
 * cornice riordina comunque, invece di buttare il gesto. L'indice è il numero di
 * fratelli il cui CENTRO sta prima del puntatore lungo l'asse del layout.
 *
 * null se non c'è nessun frame in cui cadere.
 */
export function computeLayoutDrop(
  scene: SceneState,
  draggedIds: readonly string[],
  originId: string,
  p: { x: number; y: number },
): LayoutDrop | null {
  const dragged = new Set(draggedIds);
  const frame = frameAt(scene, dragged, p) ?? scene.nodes[originId];
  if (!hasLayout(frame)) return null;
  const frameBox = contentWorldBounds(scene, frame);
  if (!frameBox) return null;
  const al = frame.autoLayout;
  const vertical = al.direction === "vertical";

  const siblings = childrenOf(scene, frame.id).filter((c) => participates(c) && !dragged.has(c.id));
  const boxes = siblings.map((c) => contentWorldBounds(scene, c)).filter((b): b is Bounds => b !== null);
  if (boxes.length !== siblings.length) return null; // un figlio senza riquadro: non si decide

  const centerOf = (b: Bounds) => (vertical ? b.y + b.height / 2 : b.x + b.width / 2);
  const at = vertical ? p.y : p.x;
  let index = 0;
  for (const b of boxes) if (centerOf(b) < at) index++;

  // Il punto lungo l'asse in cui disegnare la linea.
  const startOf = (b: Bounds) => (vertical ? b.y : b.x);
  const endOf = (b: Bounds) => (vertical ? b.y + b.height : b.x + b.width);
  const frameStart = startOf(frameBox);
  const padStart = vertical ? al.paddingTop : al.paddingLeft;
  let pos: number;
  if (boxes.length === 0) pos = frameStart + padStart;
  else if (index === 0) pos = startOf(boxes[0]) - al.spacing / 2;
  else if (index === boxes.length) pos = endOf(boxes[index - 1]) + al.spacing / 2;
  else pos = (endOf(boxes[index - 1]) + startOf(boxes[index])) / 2;
  // Mai fuori dal frame.
  pos = Math.max(frameStart, Math.min(pos, endOf(frameBox)));

  const half = INDICATOR_THICKNESS / 2;
  const indicator: Bounds = vertical
    ? { x: frameBox.x, y: pos - half, width: frameBox.width, height: INDICATOR_THICKNESS }
    : { x: pos - half, y: frameBox.y, width: INDICATOR_THICKNESS, height: frameBox.height };
  return { frameId: frame.id, index, vertical, indicator };
}

/**
 * Gli op che mettono i nodi trascinati nel punto indicato. Vuoti quando non
 * cambia nulla (stesso frame, stessa posizione nella fila): il gesto si
 * annulla invece di produrre una voce di undo che non fa niente.
 *
 * I nodi trascinati restano nel loro ordine relativo di fratelli. Stesso frame:
 * un setProps di `order_key` ciascuno (è un campo come gli altri, non un op
 * dedicato). Altro frame: un reparent con la chiave nuova, che porta l'ordine con
 * sé. Le posizioni NON si scrivono: le calcola il layout.
 */
export function layoutDropOps(scene: SceneState, draggedIds: readonly string[], drop: LayoutDrop): Op[] {
  const dragged = new Set(draggedIds);
  // Nell'ordine in cui stavano nella fila di partenza.
  const moving = draggedIds
    .map((id) => scene.nodes[id])
    .filter((n): n is NodeLite => n !== undefined)
    .sort((a, b) => (a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : a.id < b.id ? -1 : 1));
  const siblings = childrenOf(scene, drop.frameId).filter((c) => participates(c) && !dragged.has(c.id));

  // Già lì? Stesso frame e i trascinati occupano esattamente le posizioni
  // [index, index + k) della fila completa.
  const sameFrame = moving.every((n) => n.parentId === drop.frameId);
  if (sameFrame) {
    const full = childrenOf(scene, drop.frameId).filter(participates).map((c) => c.id);
    const wanted = [...siblings.slice(0, drop.index), ...moving, ...siblings.slice(drop.index)].map((c) => c.id);
    if (full.length === wanted.length && full.every((id, i) => id === wanted[i])) return [];
  }

  let prev: string | null = drop.index > 0 ? siblings[drop.index - 1].orderKey : null;
  const next: string | null = drop.index < siblings.length ? siblings[drop.index].orderKey : null;
  const ops: Op[] = [];
  for (const n of moving) {
    // Due vicini con la STESSA chiave non lasciano spazio: si mette il nodo
    // dopo `prev` e basta, piuttosto che far fallire il gesto.
    const upper = next !== null && prev !== null && prev >= next ? null : next;
    const key = orderKeyBetween(prev, upper);
    prev = key;
    ops.push(n.parentId === drop.frameId ? makeSetPropsOp(n.id, { orderKey: key }, ["order_key"]) : makeReparentOp(n.id, drop.frameId, key));
  }
  return ops;
}
