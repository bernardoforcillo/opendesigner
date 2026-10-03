import { create } from "@bufbuild/protobuf";
import { NodeSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { localToWorld, worldToLocal } from "../canvas/transform";
import { contentWorldBounds, isGroup } from "../store/groups";
import { unionBounds } from "../canvas/geometry";
import { orderKeyBetween } from "../store/orderKey";
import { childrenOf, documentOrder, topmostOf } from "../store/tree";
import type { AutoLayoutLite, NodeLite, SceneState } from "../store/types";
import { toPbAutoLayout } from "../store/types";
import { makeCreateNodeOp, makeDeleteOp, makeReparentOp, makeSetPropsOp, uuid } from "./ops";

// RAGGRUPPA (Ctrl+G) e SEPARA (Ctrl+Shift+G) come LISTE DI OP, senza toccare
// lo store: chi chiama le passa a un solo endGesture, e quindi
//   - un solo invio in rete,
//   - una sola voce di undo (un Ctrl+Z disfa il gruppo intero, non l'ultimo
//     figlio riparentato).
// È la ragione per cui queste funzioni sono pure e ritornano op invece di
// applicarli: un gesto è la loro unità, non l'op singolo.
//
// Nessun op NUOVO nel proto: raggruppare è createNode + N reparentNode,
// separare è N reparentNode + deleteNode. Un "GroupNodes" op sarebbe un
// duplicato con invarianti proprie da tenere allineate fra Go e TS, e il suo
// inverso non sarebbe comunque esprimibile in un op solo.

// Il nome di default di un gruppo appena creato. Il pannello livelli mostra il
// fallback per tipo quando `name` è vuoto (LayersPanel.tsx::fallbackName), ma un
// gruppo nasce da un GESTO dell'utente: dargli un nome vero è ciò che rende
// riconoscibile la riga appena comparsa.
export const GROUP_NAME = "Gruppo";

export interface GestureOps {
  // Gli op del gesto, IN ORDINE: vanno applicati così come sono (il gruppo si
  // crea prima di riparentarci dentro, il gruppo si cancella dopo aver tirato
  // fuori i figli).
  ops: Op[];
  // La selezione che il gesto lascia: il gruppo appena creato, o i figli
  // appena liberati.
  selection: string[];
}

// L'indice di ogni nodo nell'ordine di DISEGNO dell'intero documento. Fra due
// nodi con parent diversi le order key non sono confrontabili -- solo l'albero
// dice chi sta sopra (vedi tree.ts::documentOrder).
function orderIndex(scene: SceneState): Map<string, number> {
  const index = new Map<string, number>();
  documentOrder(scene).forEach((n, i) => index.set(n.id, i));
  return index;
}

// Il fratello immediatamente SOPRA `n` fra i figli del suo parent, se c'è.
function siblingAbove(scene: SceneState, n: NodeLite): NodeLite | undefined {
  const siblings = childrenOf(scene, n.parentId);
  const i = siblings.findIndex((s) => s.id === n.id);
  return i < 0 ? undefined : siblings[i + 1];
}

// L'estremo superiore da passare a orderKeyBetween: la chiave del vicino di
// sopra, ma solo se lascia davvero spazio. Due vicini con la STESSA order key
// (un documento vecchio, o due client che hanno scritto la stessa chiave) non
// ne lasciano, e orderKeyBetween lancerebbe: meglio mettere il nodo SOPRA quel
// vicino che far esplodere il gesto a metà.
function upperBound(above: NodeLite | undefined, lower: string): string | null {
  return above && above.orderKey > lower ? above.orderKey : null;
}

// Sposta un nodo sotto `newParentId` CONSERVANDO la sua posizione nel mondo.
//
// `spaceId` è il container il cui spazio locale accoglie le nuove coordinate.
// Non sempre coincide con newParentId, ed è il punto delicato del
// raggruppamento: il gruppo appena creato non esiste ancora nella scena da cui
// si calcolano gli op, ma nasce a (0,0) sotto il proprio parent, quindi il suo
// spazio locale è ESATTAMENTE quello del parent -- che invece nella scena c'è.
//
// Il setProps si aggiunge solo se le coordinate cambiano davvero: un nodo che
// resta nello stesso spazio (il caso normale, tutti i fratelli di una pagina)
// non deve pagare un op in più a ogni raggruppamento.
function moveOps(scene: SceneState, n: NodeLite, newParentId: string, spaceId: string, orderKey: string): Op[] {
  const ops: Op[] = [makeReparentOp(n.id, newParentId, orderKey)];
  const world = localToWorld(scene, n.parentId, n.x, n.y);
  const local = worldToLocal(scene, spaceId, world.x, world.y);
  if (local.x !== n.x || local.y !== n.y) {
    ops.push(makeSetPropsOp(n.id, { x: local.x, y: local.y }, ["x", "y"]));
  }
  return ops;
}

/**
 * Ctrl+G — raggruppa la selezione.
 *
 * Il gruppo nasce come FRATELLO del nodo selezionato più in alto nell'ordine di
 * disegno, subito sopra di lui: è la posizione z che l'utente si aspetta (il
 * gruppo prende il posto del suo elemento più in vista) e l'unica che non
 * scavalca i nodi che stavano sopra la selezione.
 *
 * I selezionati ci finiscono dentro nel loro ordine relativo, con chiavi nuove:
 * la loro vecchia posizione era relativa a fratelli che non sono più i loro.
 *
 * Un discendente selezionato insieme al suo container NON viene riparentato a
 * parte (tree.ts::topmostOf): il container se lo porta dietro, e un reparent suo
 * lo tirerebbe fuori dal container per metterlo nel gruppo -- cioè lo
 * spostamento che l'utente non ha chiesto.
 *
 * null quando non c'è niente da raggruppare: nessun gesto, nessun invio.
 */
export function groupOps(scene: SceneState, selection: readonly string[]): GestureOps | null {
  const index = orderIndex(scene);
  const ids = topmostOf(scene, selection).filter((id) => index.has(id));
  if (ids.length === 0) return null;
  // Ordine di DISEGNO, non ordine di selezione: è ciò che conserva la pila
  // visiva dentro il gruppo (chi era sopra resta sopra).
  const sorted = [...ids].sort((a, b) => (index.get(a) as number) - (index.get(b) as number));
  const top = scene.nodes.at(sorted[sorted.length - 1]);
  const parentId = top.parentId;

  const groupId = uuid();
  const groupNode = create(NodeSchema, {
    id: groupId,
    parentId,
    orderKey: orderKeyBetween(top.orderKey, upperBound(siblingAbove(scene, top), top.orderKey)),
    name: GROUP_NAME,
    visible: true,
    opacity: 1,
    // Nessuna geometria propria: i bounds sono l'unione dei figli (vedi
    // store/groups.ts) e x/y a 0 vuol dire che il gruppo non trasla ancora
    // nessuno -- raggruppare non muove un pixel.
    x: 0, y: 0, width: 0, height: 0, rotation: 0,
    fills: [],
    shape: { case: "group", value: {} },
  });

  const ops: Op[] = [makeCreateNodeOp(groupNode)];
  let prev: string | null = null;
  for (const id of sorted) {
    const key = orderKeyBetween(prev, null);
    prev = key;
    // Lo SPAZIO è quello del parent del gruppo, non del gruppo: vedi moveOps.
    ops.push(...moveOps(scene, scene.nodes.at(id), groupId, parentId, key));
  }
  return { ops, selection: [groupId] };
}

/**
 * Ctrl+Shift+G — separa i gruppi selezionati.
 *
 * I figli tornano fuori nello slot z del gruppo (fra la sua chiave e quella del
 * fratello sopra di lui), nel loro ordine relativo: chi era sopra dentro il
 * gruppo resta sopra fuori. Le coordinate vengono riscritte per conservare la
 * posizione MONDO -- un gruppo trascinato ha una traslazione propria, e senza
 * riscriverle i figli tornerebbero indietro del suo spostamento.
 *
 * Il gruppo si cancella per ULTIMO, quando è già vuoto: deleteNode cancella a
 * cascata (core.applyDelete), quindi cancellarlo prima porterebbe via i figli
 * che stiamo liberando.
 *
 * Se sono selezionati un gruppo e un gruppo suo discendente si separa solo
 * quello ESTERNO (topmostOf): gli op del secondo sarebbero costruiti su uno
 * stato che il primo ha già cambiato.
 *
 * null quando nella selezione non c'è nessun gruppo: nessun gesto, nessun invio.
 */
export function ungroupOps(scene: SceneState, selection: readonly string[]): GestureOps | null {
  const index = orderIndex(scene);
  const groups = topmostOf(scene, selection)
    .map((id) => scene.nodes.at(id))
    .filter((n): n is NodeLite => n !== undefined && isGroup(n) && index.has(n.id))
    .sort((a, b) => (index.get(a.id) as number) - (index.get(b.id) as number));
  if (groups.length === 0) return null;

  const ops: Op[] = [];
  const freed: string[] = [];
  for (const g of groups) {
    const upper = upperBound(siblingAbove(scene, g), g.orderKey);
    let prev = g.orderKey;
    for (const c of childrenOf(scene, g.id)) {
      const key = orderKeyBetween(prev, upper);
      prev = key;
      // Qui parent e spazio coincidono: il gruppo esiste ancora nella scena,
      // quindi la sua traslazione è già dentro localToWorld (vedi moveOps).
      ops.push(...moveOps(scene, c, g.parentId, g.parentId, key));
      freed.push(c.id);
    }
    ops.push(makeDeleteOp(g.id));
  }
  return { ops, selection: freed };
}

// --- AVVOLGI IN UN FRAME ----------------------------------------------------

export const FRAME_NAME = "Frame";

// Lo spazio fra figli consecutivi che l'auto layout deve mantenere per non
// cambiare l'aspetto: la media dei vuoti fra i loro riquadri lungo l'asse,
// arrotondata al pixel e mai negativa (figli sovrapposti = 0).
function averageGap(sorted: readonly { start: number; end: number }[]): number {
  if (sorted.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < sorted.length; i++) total += sorted[i].start - sorted[i - 1].end;
  return Math.max(0, Math.round(total / (sorted.length - 1)));
}

/**
 * Avvolge la selezione in un FRAME (Ctrl+Alt+G) e, con `autoLayout`, lo rende un
 * frame con auto layout (Shift+A). Stessa forma di groupOps: createNode + N
 * reparentNode, UN gesto, una voce di undo.
 *
 * Il frame prende il riquadro dei selezionati, così avvolgerli non sposta un
 * pixel. Senza auto layout i figli conservano la posizione (le loro coordinate
 * diventano relative al frame). Con auto layout il frame sceglie da sé direzione
 * e spaziatura guardando come i figli sono già disposti, e li mette in fila
 * nell'ORDINE SPAZIALE -- l'auto layout dispone nell'ordine dei fratelli, quindi
 * le order key vanno assegnate lungo l'asse e non nell'ordine di disegno.
 *
 * null quando non c'è niente da avvolgere.
 */
export function wrapInFrameOps(
  scene: SceneState,
  selection: readonly string[],
  withAutoLayout: boolean,
): GestureOps | null {
  const index = orderIndex(scene);
  const ids = topmostOf(scene, selection).filter((id) => index.has(id));
  if (ids.length === 0) return null;
  const byZ = [...ids].sort((a, b) => (index.get(a) as number) - (index.get(b) as number));
  const top = scene.nodes.at(byZ[byZ.length - 1]);
  const parentId = top.parentId;

  // I riquadri nel MONDO, poi portati nello spazio del parent del frame.
  const worldBox = new Map(ids.flatMap((id) => {
    const b = contentWorldBounds(scene, scene.nodes.at(id));
    return b ? [[id, b] as const] : [];
  }));
  const union = unionBounds([...worldBox.values()]);
  if (!union) return null;
  const origin = worldToLocal(scene, parentId, union.x, union.y);

  let order = byZ;
  let layout: AutoLayoutLite | null = null;
  if (withAutoLayout) {
    const centers = ids.map((id) => {
      const b = worldBox.get(id);
      return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : { x: 0, y: 0 };
    });
    const spread = (v: number[]) => Math.max(...v) - Math.min(...v);
    const horizontal = spread(centers.map((c) => c.x)) >= spread(centers.map((c) => c.y));
    const start = (id: string) => {
      const b = worldBox.get(id);
      return b ? (horizontal ? b.x : b.y) : 0;
    };
    order = [...ids].sort((a, b) => start(a) - start(b) || (index.get(a) as number) - (index.get(b) as number));
    const spans = order.map((id) => {
      const b = worldBox.get(id);
      const s = start(id);
      return { start: s, end: b ? s + (horizontal ? b.width : b.height) : s };
    });
    layout = {
      direction: horizontal ? "horizontal" : "vertical",
      spacing: averageGap(spans),
      paddingLeft: 0, paddingTop: 0, paddingRight: 0, paddingBottom: 0,
      mainAlign: "start", crossAlign: "start",
      hugWidth: true, hugHeight: true,
    };
  }

  const frameId = uuid();
  const frameNode = create(NodeSchema, {
    id: frameId,
    parentId,
    orderKey: orderKeyBetween(top.orderKey, upperBound(siblingAbove(scene, top), top.orderKey)),
    name: FRAME_NAME,
    visible: true,
    opacity: 1,
    x: origin.x, y: origin.y, width: union.width, height: union.height, rotation: 0,
    fills: [],
    shape: {
      case: "frame",
      value: { clipsContent: false, ...(layout ? { autoLayout: toPbAutoLayout(layout) } : {}) },
    },
  });

  const ops: Op[] = [makeCreateNodeOp(frameNode)];
  let prev: string | null = null;
  for (const id of order) {
    const key = orderKeyBetween(prev, null);
    prev = key;
    const n = scene.nodes.at(id);
    ops.push(makeReparentOp(id, frameId, key));
    // Con auto layout la posizione la decide il server: scriverla qui sarebbe
    // un op in più che il layout sovrascrive subito.
    if (!layout) {
      const world = localToWorld(scene, n.parentId, n.x, n.y);
      const inParent = worldToLocal(scene, parentId, world.x, world.y);
      const x = inParent.x - origin.x;
      const y = inParent.y - origin.y;
      if (x !== n.x || y !== n.y) ops.push(makeSetPropsOp(id, { x, y }, ["x", "y"]));
    }
  }
  return { ops, selection: [frameId] };
}
