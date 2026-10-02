import { type Bounds, boundsOfNode, inflateBounds, intersectBounds, unionBounds, worldVisualAabbOfNode } from "../canvas/geometry";
import { IDENTITY, type Transform, compose, localTransformOf, mapBounds, worldTransformOf } from "../canvas/transform";
import { contentWorldBounds } from "../store/groups";
import { bySiblingOrder, childIndexOf } from "../store/tree";
import type { NodeLite, SceneState } from "../store/types";

// L'INDICE DI SCENA: ciò che il renderer sa del documento e che non cambia
// finché il documento non cambia.
//
// Prima, ogni frame ricostruiva l'indice dei figli (una scansione dell'intera
// mappa e un sort per container) e disegnava OGNI nodo, visibile o no. Con
// 20.000 nodi erano ~140 ms per frame anche con una sola schermata inquadrata.
// L'indice sposta quel lavoro a una volta per scena (le scene sono immutabili e
// ricostruite a ogni op, quindi l'identità della scena è la chiave di cache) e
// dà al disegno e all'hit-test ciò che serve per saltare interi sottoalberi:
//
//   - `children`: i figli per parent, già ordinati (come childIndexOf);
//   - `extent`: per ogni nodo visibile, il rettangolo MONDO che copre TUTTO ciò
//     che il nodo disegna insieme al suo sottoalbero. Se non incontra la vista,
//     nessun pixel di quel sottoalbero può comparire.
//
// `extent` è CONSERVATIVO: errare in eccesso (disegnare un nodo in più) costa un
// po' di tempo, errare in difetto (saltarne uno che si vede) è un bug visibile.
// Per questo include le sporgenze di tratto, ombra e sfocatura, e per il testo
// -- che sporge dal proprio box e non ha bisogno di un ctx per dirlo -- una
// stima abbondante.
export interface SceneIndex {
  children: Map<string, NodeLite[]>;
  extent: Map<string, Bounds>;
}

const cache = new WeakMap<SceneState, SceneIndex>();
// L'ultima scena indicizzata: la base su cui si prova l'aggiornamento
// incrementale. Una sola, perché il caso che conta è la catena di scene di un
// gesto (ogni op ne produce una nuova da quella precedente).
let last: { scene: SceneState; index: SceneIndex } | null = null;

export function sceneIndexOf(scene: SceneState): SceneIndex {
  let idx = cache.get(scene);
  if (idx) return idx;
  if (last) idx = updateIndex(last.scene, last.index, scene) ?? undefined;
  if (!idx) idx = buildIndex(scene);
  cache.set(scene, idx);
  last = { scene, index: idx };
  return idx;
}

// Lo scarto massimo, oltre al box, con cui un nodo dipinge: tratto (già in
// worldVisualAabbOfNode), ombra (offset + metà sfocatura come deviazione, ~3
// deviazioni di coda) e sfocatura del livello (~3 deviazioni).
function effectsOutset(n: NodeLite): number {
  if (!n.effects) return 0;
  let out = 0;
  let shadowSeen = false;
  let blurSeen = false;
  for (const e of n.effects) {
    if (e.kind === "dropShadow" && !shadowSeen) {
      shadowSeen = true;
      out += Math.max(Math.abs(e.offsetX), Math.abs(e.offsetY)) + e.blur * 1.5;
    } else if (e.kind === "layerBlur" && !blurSeen && e.radius > 0) {
      blurSeen = true;
      out += e.radius * 3;
    }
  }
  return out;
}

// Il testo non è ritagliato dal proprio box (renderer/text.ts::textPaintBounds),
// ma misurarlo vuole un ctx. Qui basta un maggiorante: righe stimate con un
// glifo largo 0.8 em, interlinea abbondante, e margine orizzontale per le
// parole spezzate o allineate a destra.
function textBox(n: NodeLite): Bounds {
  const t = n.text;
  const box = boundsOfNode(n);
  if (!t || t.content === "") return box;
  const size = Math.max(1, t.style.fontSize || 16);
  const chars = t.content.length;
  const newlines = (t.content.match(/\n/g) ?? []).length;
  const wrapWidth = Math.max(n.width, size);
  const lines = newlines + Math.ceil((chars * size * 0.8) / wrapWidth) + 1;
  const lineHeight = Math.max(size * 1.6, t.style.lineHeight > 0 ? t.style.lineHeight * 1.2 : 0);
  const xSlack = n.width < size * 2 ? chars * size * 0.8 : size * 2;
  return { x: box.x - xSlack, y: box.y, width: box.width + 2 * xSlack, height: Math.max(box.height, lines * lineHeight) };
}

// Il rettangolo, nello spazio del PARENT, che il nodo dipinge con sé stesso.
function ownLocalBox(n: NodeLite): Bounds {
  const base = n.kind === "text" ? textBox(n) : null;
  const visual = worldVisualAabbOfNode(base ? { ...n, x: base.x, y: base.y, width: base.width, height: base.height } : n);
  return inflateBounds(visual, effectsOutset(n));
}

// Il rettangolo che `n` copre dato quello dei suoi figli (già portati al mondo):
// il proprio, più i figli. Un gruppo non ha niente di proprio, e un FRAME
// ritagliante conta i figli solo per la parte che ci sta dentro. null se non
// dipinge nulla.
function combine(n: NodeLite, parentWorld: Transform, kidExtents: Bounds[]): Bounds | null {
  const parts: Bounds[] = [];
  if (n.kind !== "group") parts.push(mapBounds(parentWorld, ownLocalBox(n)));
  if (n.kind === "frame" && n.clipsContent) {
    const own = parts[0];
    for (const kb of kidExtents) {
      const inside = intersectBounds(kb, own);
      if (inside) parts.push(inside);
    }
  } else {
    parts.push(...kidExtents);
  }
  return unionBounds(parts);
}

// Percorre un sottoalbero e ne scrive gli extent, azzerando quelli che non
// valgono più (un nodo reso invisibile, o ora vuoto, non deve lasciare un extent
// vecchio: il disegno lo disegnerebbe ancora).
function makeVisitor(scene: SceneState, children: Map<string, NodeLite[]>, extent: Map<string, Bounds>) {
  const clear = (id: string) => {
    extent.delete(id);
    for (const k of children.get(id) ?? []) clear(k.id);
  };
  const seen = new Set<string>();
  const visit = (n: NodeLite, parentWorld: Transform): Bounds | null => {
    if (!n.visible || seen.has(n.id)) {
      clear(n.id);
      return null;
    }
    seen.add(n.id);

    // Un'ISTANZA non ha figli in `children`: il suo sottoalbero è virtuale, e
    // il suo extent è quello del contenuto del master già portato al mondo.
    if (n.kind === "instance") {
      const b = contentWorldBounds(scene, n);
      if (!b) {
        extent.delete(n.id);
        return null;
      }
      const padded = inflateBounds(b, effectsOutset(n));
      extent.set(n.id, padded);
      return padded;
    }

    const kids = children.get(n.id);
    const kidExtents: Bounds[] = [];
    if (kids && kids.length > 0) {
      const childWorld = compose(parentWorld, localTransformOf(n));
      for (const k of kids) {
        const kb = visit(k, childWorld);
        if (kb) kidExtents.push(kb);
      }
    }
    const u = combine(n, parentWorld, kidExtents);
    if (u) extent.set(n.id, u);
    else extent.delete(n.id);
    return u;
  };
  return visit;
}

export function buildIndex(scene: SceneState): SceneIndex {
  const children = childIndexOf(scene);
  const extent = new Map<string, Bounds>();
  const visit = makeVisitor(scene, children, extent);
  for (const page of scene.pages) {
    for (const r of children.get(page.id) ?? []) visit(r, IDENTITY);
  }
  return { children, extent };
}

// --- AGGIORNAMENTO INCREMENTALE ------------------------------------------------
//
// Un gesto (un trascinamento, un resize) produce una scena nuova per ogni op, e
// quasi tutta uguale alla precedente: gli oggetti nodo NON toccati hanno la
// stessa identità. Confrontarli costa un passaggio sulla mappa (pochi ms anche a
// 20.000 nodi), contro il rifacimento dell'indice intero (decine di ms).
//
// Si ricalcola SOLO ciò che può essere cambiato: i nodi diversi con il loro
// sottoalbero (se si sposta un frame si spostano i suoi discendenti), e la
// catena degli antenati (la loro unione dipende dai figli). Le liste dei figli
// si ricopiano solo per i parent toccati; `children` ed `extent` sono COPIE,
// perché l'indice della scena precedente può essere ancora in uso (undo, vista
// ottimistica contro confermata).
//
// Ritorna null quando conviene -- o bisogna -- rifare tutto: troppi nodi
// cambiati, pagine o componenti diversi, o un cambiamento dentro il master di un
// componente (gli extent delle istanze ne dipendono).
const INCREMENTAL_MAX_FRACTION = 0.05;
const INCREMENTAL_MIN_LIMIT = 64;

function updateIndex(prevScene: SceneState, prev: SceneIndex, scene: SceneState): SceneIndex | null {
  if (prevScene.pages !== scene.pages || prevScene.components !== scene.components) return null;
  const prevNodes = prevScene.nodes;
  const nodes = scene.nodes;
  const total = Object.keys(nodes).length;
  const limit = Math.max(INCREMENTAL_MIN_LIMIT, Math.floor(total * INCREMENTAL_MAX_FRACTION));

  const changed: string[] = [];
  const removed: string[] = [];
  for (const id in nodes) {
    if (prevNodes[id] !== nodes[id]) {
      changed.push(id);
      if (changed.length > limit) return null;
    }
  }
  for (const id in prevNodes) if (!(id in nodes)) removed.push(id);
  if (removed.length > limit) return null;
  if (changed.length === 0 && removed.length === 0) return prev;

  // Un cambiamento dentro il sottoalbero di un master di componente sposta gli
  // extent delle istanze: rifare tutto.
  const rootIds = Object.values(scene.components).map((c) => c.rootNodeId);
  if (rootIds.length > 0) {
    const roots = new Set(rootIds);
    for (const id of [...changed, ...removed]) {
      const base = nodes[id] ?? prevNodes[id];
      for (let cur: NodeLite | undefined = base, g = 0; cur && g < 1000; cur = (nodes[cur.parentId] ?? prevNodes[cur.parentId]), g++) {
        if (roots.has(cur.id)) return null;
      }
    }
  }

  // Le liste dei figli: copie solo dei parent toccati. Un nodo cambiato può aver
  // cambiato parent o chiave (si riposiziona), o solo geometria (si sostituisce
  // l'oggetto nella stessa posizione).
  const children = new Map(prev.children);
  const touched = new Map<string, NodeLite[]>(); // parentId -> lista copiata (mutabile)
  const listOf = (parentId: string): NodeLite[] => {
    let l = touched.get(parentId);
    if (!l) {
      l = [...(prev.children.get(parentId) ?? [])];
      touched.set(parentId, l);
    }
    return l;
  };
  const dropFrom = (parentId: string, id: string) => {
    const l = listOf(parentId);
    const i = l.findIndex((x) => x.id === id);
    if (i >= 0) l.splice(i, 1);
  };
  const insertInto = (parentId: string, n: NodeLite) => {
    const l = listOf(parentId);
    let lo = 0;
    let hi = l.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (bySiblingOrder(l[mid], n) < 0) lo = mid + 1;
      else hi = mid;
    }
    l.splice(lo, 0, n);
  };
  for (const id of removed) dropFrom(prevNodes[id].parentId, id);
  for (const id of changed) {
    const before = prevNodes[id];
    const after = nodes[id];
    if (before) dropFrom(before.parentId, id);
    insertInto(after.parentId, after);
  }
  for (const [pid, list] of touched) {
    if (list.length === 0) children.delete(pid);
    else children.set(pid, list);
  }

  const extent = new Map(prev.extent);
  for (const id of removed) extent.delete(id);

  const worldOf = (parentId: string): Transform => worldTransformOf(scene, parentId);
  const visit = makeVisitor(scene, children, extent);
  // Come la costruzione completa, che parte dalle pagine e non entra in un
  // sottoalbero nascosto: un nodo che sta sotto un antenato nascosto, o che non è
  // raggiungibile da nessuna pagina (un master di componente), non ha extent.
  const pageIds = new Set(scene.pages.map((p) => p.id));
  const drawn = (n: NodeLite): boolean => {
    for (let cur: NodeLite | undefined = n, g = 0; cur && g < 1000; cur = nodes[cur.parentId], g++) {
      if (!cur.visible) return false;
      if (pageIds.has(cur.parentId)) return true;
    }
    return false;
  };
  const clearTree = (id: string) => {
    extent.delete(id);
    for (const k of children.get(id) ?? []) clearTree(k.id);
  };
  // 1) Sottoalberi dei nodi cambiati (la loro trasformazione può essere nuova).
  const redone = new Set<string>();
  for (const id of changed) {
    // Già rifatto come discendente di un altro cambiato? Un nodo sotto un
    // cambiato viene comunque rivisitato da lui: si salta.
    let covered = false;
    for (let cur = nodes[nodes[id].parentId], g = 0; cur && g < 1000; cur = nodes[cur.parentId], g++) {
      if (redone.has(cur.id)) { covered = true; break; }
    }
    if (covered) continue;
    redone.add(id);
    if (drawn(nodes[id])) visit(nodes[id], worldOf(nodes[id].parentId));
    else clearTree(id);
  }
  // Gli antenati toccati: dei cambiati, dei rimossi e dei VECCHI parent di chi
  // si è spostato. Dal più profondo, con l'unione dei figli già in cache.
  const up = new Set<string>();
  const addChain = (startParentId: string) => {
    for (let cur = nodes[startParentId], g = 0; cur && g < 1000; cur = nodes[cur.parentId], g++) up.add(cur.id);
  };
  for (const id of changed) {
    addChain(nodes[id].parentId);
    if (prevNodes[id]) addChain(prevNodes[id].parentId);
  }
  for (const id of removed) addChain(prevNodes[id].parentId);
  for (const id of redone) up.delete(id);
  const depth = (id: string): number => {
    let d = 0;
    for (let cur: NodeLite | undefined = nodes[id]; cur && d < 1000; cur = nodes[cur.parentId]) d++;
    return d;
  };
  const chain = [...up].sort((a, b) => depth(b) - depth(a));
  for (const id of chain) {
    const n = nodes[id];
    if (!n || n.kind === "instance") continue;
    if (!drawn(n)) {
      extent.delete(id);
      continue;
    }
    const kidExtents: Bounds[] = [];
    for (const k of children.get(id) ?? []) {
      const e = extent.get(k.id);
      if (e && k.visible) kidExtents.push(e);
    }
    const u = combine(n, worldOf(n.parentId), kidExtents);
    if (u) extent.set(id, u);
    else extent.delete(id);
  }
  return { children, extent };
}
