import type { NodeEditor } from "./nodeMap";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { childrenOf } from "./tree";
import type { NodeLite, SceneState } from "./types";

// AUTO LAYOUT -- la metà TypeScript di internal/core/layout.go, che è
// l'AUTORITÀ. Questa copia esiste solo perché il client applica gli op in
// locale (vista ottimistica e stato confermato) con applyOp: se non rifacesse
// lo stesso calcolo, il documento che il server ha già disposto e quello che il
// browser ricostruisce dagli stessi op divergerebbero.
//
// Deve dare gli STESSI numeri di Go, bit per bit. Per questo le espressioni
// aritmetiche sono scritte NELLO STESSO ORDINE (a + b + c è (a + b) + c da
// entrambe le parti) e l'ordine dei figli è quello di childrenOf (order_key, poi
// id). La fixture testdata/golden/auto_layout.json, eseguita da entrambi i lati,
// lo fissa.
//
// Partecipano i figli VISIBILI con una misura propria (rect, ellisse, testo,
// immagine, vettoriale, frame). Gruppi e istanze restano dove sono.

const LAYOUT_KINDS: ReadonlySet<NodeLite["kind"]> = new Set(["rect", "ellipse", "text", "image", "vector", "frame"]);

export function participates(n: NodeLite): boolean {
  return n.visible && LAYOUT_KINDS.has(n.kind);
}

export function hasLayout(n: NodeLite | undefined): n is NodeLite & { autoLayout: NonNullable<NodeLite["autoLayout"]> } {
  return n !== undefined && n.kind === "frame" && n.autoLayout !== undefined;
}

// Ridispone i figli di UN frame e, se hug, ne ridimensiona gli assi. Muta
// `nodes` (una mappa PRIVATA di relayout, già copiata) e ritorna se ha cambiato
// qualcosa.
function layoutFrame(scene: SceneState, nodes: NodeEditor, id: string, touched?: string[]): boolean {
  const frame = nodes.get(id);
  if (!hasLayout(frame)) return false;
  const al = frame.autoLayout;
  const vertical = al.direction === "vertical";

  // Lo stato su cui si calcola è `scene` + le correzioni già scritte in `nodes`:
  // childrenOf legge dalla scena, quindi gli si passa una vista con i nodi
  // aggiornati finora.
  const view: SceneState = { ...scene, nodes: nodes.view() };
  const kids = childrenOf(view, id).filter(participates);

  const padL = al.paddingLeft, padT = al.paddingTop, padR = al.paddingRight, padB = al.paddingBottom;
  const [padMainStart, padMainEnd, padCrossStart, padCrossEnd] = vertical ? [padT, padB, padL, padR] : [padL, padR, padT, padB];
  const [hugMain, hugCross] = vertical ? [al.hugHeight, al.hugWidth] : [al.hugWidth, al.hugHeight];
  const mainOf = (n: NodeLite) => (vertical ? n.height : n.width);
  const crossOf = (n: NodeLite) => (vertical ? n.width : n.height);

  const spacing = al.spacing;
  let sum = 0;
  let maxCross = 0;
  for (const k of kids) {
    sum += mainOf(k);
    const c = crossOf(k);
    if (c > maxCross) maxCross = c;
  }
  const gaps = kids.length > 1 ? spacing * (kids.length - 1) : 0;

  let frameMain = mainOf(frame);
  let frameCross = crossOf(frame);
  if (hugMain) frameMain = padMainStart + sum + gaps + padMainEnd;
  if (hugCross) frameCross = padCrossStart + maxCross + padCrossEnd;
  const width = vertical ? frameCross : frameMain;
  const height = vertical ? frameMain : frameCross;

  const innerMain = frameMain - padMainStart - padMainEnd;
  const innerCross = frameCross - padCrossStart - padCrossEnd;
  const free = innerMain - sum - gaps;

  let pos = padMainStart;
  let step = spacing;
  switch (al.mainAlign) {
    case "center": pos = padMainStart + free / 2; break;
    case "end": pos = padMainStart + free; break;
    case "space-between":
      // Meno di due figli: niente fra cui distribuire. Spazio che non basta
      // (free <= 0): non si comprime sotto `spacing`.
      if (kids.length > 1 && free > 0) step = spacing + free / (kids.length - 1);
      break;
    default: break;
  }

  let changed = false;
  if (frame.width !== width || frame.height !== height) {
    nodes.set(id, { ...frame, width, height });
    touched?.push(id);
    changed = true;
  }
  for (const k of kids) {
    let cross = padCrossStart;
    if (al.crossAlign === "center") cross = padCrossStart + (innerCross - crossOf(k)) / 2;
    else if (al.crossAlign === "end") cross = padCrossStart + (innerCross - crossOf(k));
    const x = vertical ? cross : pos;
    const y = vertical ? pos : cross;
    if (k.x !== x || k.y !== y) {
      nodes.set(k.id, { ...k, x, y });
      touched?.push(k.id);
      changed = true;
    }
    pos = pos + mainOf(k) + step;
  }
  return changed;
}

// I frame il cui layout può cambiare per effetto di `op`, letti da `scene` --
// che si interroga PRIMA e DOPO l'op (un nodo cancellato o spostato lascia il
// vecchio parent solo nello stato di prima). Come layoutTargets in Go.
export function layoutTargets(scene: SceneState, op: Op): string[] {
  const parentOf = (id: string): string[] => {
    const n = scene.nodes.get(id);
    return n ? [n.parentId] : [];
  };
  const k = op.kind;
  switch (k.case) {
    case "createNode": return k.value.node ? [k.value.node.parentId, k.value.node.id] : [];
    case "deleteNode": return parentOf(k.value.id);
    case "reparentNode": return [...parentOf(k.value.id), k.value.newParentId];
    case "setProps": return [...parentOf(k.value.id), k.value.id];
    case "setVectorPath": return parentOf(k.value.id);
    default: return [];
  }
}

// Ridispone i frame toccati e risale (un hug che cambia misura sposta i
// fratelli, quindi serve il layout del parent, e così via), dal più profondo:
// un frame hug annidato deve avere la misura giusta PRIMA che il contenitore la
// legga. Ritorna la STESSA scena se non cambia nulla, così chi la confronta per
// identità non ridisegna per niente.
export function relayout(scene: SceneState, ids: readonly string[], touchedOut?: string[]): SceneState {
  const seen = new Set<string>();
  const frames: string[] = [];
  for (const id of ids) {
    if (id !== "" && !seen.has(id) && hasLayout(scene.nodes.get(id))) {
      seen.add(id);
      frames.push(id);
    }
  }
  // Prima di COPIARE la mappa dei nodi (20.000 voci a 12 ms per un documento
  // grande): la stragrande maggioranza degli op non tocca nessun frame con auto
  // layout. Un nodo fuori da un auto layout con un antenato che ne ha uno conta
  // comunque, ma lo si scopre solo risalendo -- e senza frame toccati non c'è
  // niente da risalire.
  if (frames.length === 0) return scene;
  const nodes = scene.nodes.edit();
  const limit = scene.nodes.size;
  for (const id of [...frames]) {
    let cur: NodeLite | undefined = nodes.get(id);
    for (let guard = 0; cur !== undefined && guard <= limit; guard++) {
      const p: NodeLite | undefined = nodes.get(cur.parentId);
      if (p === undefined) break;
      if (hasLayout(p) && !seen.has(p.id)) {
        seen.add(p.id);
        frames.push(p.id);
      }
      cur = p;
    }
  }
  const depth = (id: string): number => {
    let d = 0;
    for (let cur: NodeLite | undefined = nodes.get(id); cur !== undefined && d <= limit; cur = nodes.get(cur.parentId)) d++;
    return d;
  };
  frames.sort((a, b) => depth(b) - depth(a) || (a < b ? -1 : a > b ? 1 : 0));

  let changed = false;
  for (const id of frames) if (layoutFrame(scene, nodes, id, touchedOut)) changed = true;
  return changed ? { ...scene, nodes: nodes.done() } : scene;
}
