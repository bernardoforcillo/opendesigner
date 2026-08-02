import { type Bounds, unionBounds, worldAabbOfNode } from "../canvas/geometry";
import { useScene } from "../store/store";
import { makeSetPropsOp } from "../tools/ops";
import type { SceneState } from "../store/types";
import type { Op } from "../gen/brawt/v1/brawt_pb";

// ALLINEAMENTO E DISTRIBUZIONE.
//
// Sei allineamenti (i tre bordi orizzontali, i tre verticali) e due
// distribuzioni. Tutti muovono i nodi e basta: la mask è sempre ["x", "y"], mai
// width/height/rotation -- allineare non ridimensiona e non ruota.
//
// NODI RUOTATI: si allinea il loro RETTANGOLO ASSE-ALLINEATO (worldAabbOfNode),
// la stessa scelta dello snap (vedi selection/snap.ts) e per la stessa ragione:
// è il rettangolo che il riquadro di selezione disegna e quello che l'occhio
// legge come "il posto che occupa". Il delta calcolato sull'AABB si scrive però
// direttamente in x/y del MODELLO, ed è esatto: una traslazione commuta con la
// rotazione attorno al centro, quindi spostare l'AABB di (dx, dy) è spostare il
// nodo di (dx, dy).
//
// IL TRATTO non conta, di nuovo come per lo snap: si allinea la geometria, non
// la sporgenza del bordo.

export type AlignKind = "left" | "hcenter" | "right" | "top" | "middle" | "bottom";
export type DistributeKind = "distribute-h" | "distribute-v";
export type AlignCommand = AlignKind | DistributeKind;

// LA PAGINA. `brawt.v1.Page` porta oggi solo `id` e `name`: nel modello non
// esiste nessuna geometria di pagina (e aggiungerla è lavoro della traccia 1,
// che possiede pagine e frame). Serve però un rettangolo contro cui allineare
// un nodo SOLO -- allinearlo contro sé stesso non farebbe niente -- e questo è
// quel rettangolo: un foglio 1920x1080 con l'origine nell'origine del mondo, la
// stessa area che la camera inquadra all'apertura.
//
// È dichiarato qui, in un posto solo e con questo commento, proprio perché è
// una CONVENZIONE e non una misura: quando la pagina avrà bounds veri,
// pageBounds() diventa una lettura dal documento e nient'altro cambia.
export const PAGE_BOUNDS: Bounds = { x: 0, y: 0, width: 1920, height: 1080 };

export function pageBounds(_scene: SceneState): Bounds {
  return PAGE_BOUNDS;
}

// I comandi come DATI, con l'etichetta che il pannello mostra: aggiungerne uno
// è aggiungere una riga qui, e il pannello non ha nessun elenco parallelo da
// tenere allineato. L'ordine è quello in cui i pulsanti compaiono.
export const ALIGN_COMMANDS: readonly { id: AlignCommand; label: string }[] = [
  { id: "left", label: "Allinea a sinistra" },
  { id: "hcenter", label: "Centra orizzontalmente" },
  { id: "right", label: "Allinea a destra" },
  { id: "distribute-h", label: "Distribuisci orizzontalmente" },
  { id: "top", label: "Allinea in alto" },
  { id: "middle", label: "Centra verticalmente" },
  { id: "bottom", label: "Allinea in basso" },
  { id: "distribute-v", label: "Distribuisci verticalmente" },
];

export interface Delta { dx: number; dy: number }

const ZERO: Delta = { dx: 0, dy: 0 };

// Lo spostamento che porta `b` sull'allineamento chiesto rispetto a `target`.
// UN asse per comando, sempre: "allinea a sinistra" non deve mai muovere niente
// in verticale.
export function alignDelta(b: Bounds, target: Bounds, kind: AlignKind): Delta {
  switch (kind) {
    case "left":
      return { dx: target.x - b.x, dy: 0 };
    case "hcenter":
      return { dx: target.x + target.width / 2 - (b.x + b.width / 2), dy: 0 };
    case "right":
      return { dx: target.x + target.width - (b.x + b.width), dy: 0 };
    case "top":
      return { dx: 0, dy: target.y - b.y };
    case "middle":
      return { dx: 0, dy: target.y + target.height / 2 - (b.y + b.height / 2) };
    case "bottom":
      return { dx: 0, dy: target.y + target.height - (b.y + b.height) };
  }
}

// DISTRIBUZIONE: si equalizzano gli SPAZI FRA i box, non i loro centri.
//
// La differenza si vede appena i box hanno dimensioni diverse: centri
// equidistanti lasciano buchi visibilmente disuguali fra un box largo e uno
// stretto, mentre spazi uguali è ciò che l'occhio legge come "distribuiti". È
// anche la scelta degli editor di design (Figma la chiama "distribute
// spacing").
//
// I due ESTREMI non si muovono: sono loro a definire lo spazio da spartire.
// Meno di tre box non hanno niente da distribuire (i due estremi sono già
// tutto), e la funzione restituisce l'identità invece di inventare un
// movimento.
//
// Lo spazio libero può risultare NEGATIVO se i box si sovrappongono: la formula
// regge lo stesso e produce sovrapposizioni uguali, che è la risposta giusta
// alla domanda "rendili equidistanti".
export function distributeDeltas(boxes: readonly Bounds[], axis: "x" | "y"): Delta[] {
  const out: Delta[] = boxes.map(() => ZERO);
  const n = boxes.length;
  if (n < 3) return out;
  const horiz = axis === "x";
  const min = (b: Bounds) => (horiz ? b.x : b.y);
  const size = (b: Bounds) => (horiz ? b.width : b.height);
  // Ordinati per posizione, con l'INDICE come spareggio: due box che partono
  // esattamente dallo stesso punto devono ricevere un ordine stabile, altrimenti
  // lo stesso comando dato due volte darebbe risultati diversi.
  const order = boxes.map((_, i) => i).sort((a, b) => min(boxes[a]) - min(boxes[b]) || a - b);
  const first = boxes[order[0]];
  const last = boxes[order[n - 1]];
  const start = min(first);
  const end = min(last) + size(last);
  let total = 0;
  for (const b of boxes) total += size(b);
  const gap = (end - start - total) / (n - 1);
  let cursor = start;
  for (const i of order) {
    const d = cursor - min(boxes[i]);
    out[i] = horiz ? { dx: d, dy: 0 } : { dx: 0, dy: d };
    cursor += size(boxes[i]) + gap;
  }
  return out;
}

// Il rettangolo contro cui si allinea:
//  - UN nodo solo -> la PAGINA. Contro sé stesso non ci sarebbe niente da fare,
//    e "allinea a sinistra" con un elemento solo significa, in ogni editor,
//    "portalo a sinistra del foglio".
//  - PIÙ nodi -> il loro riquadro comune (l'unione degli AABB), cioè lo stesso
//    riquadro che l'overlay disegna attorno alla selezione.
// null solo per una selezione vuota.
export function alignTarget(scene: SceneState, ids: readonly string[]): Bounds | null {
  const boxes = boxesOf(scene, ids);
  if (boxes.length === 0) return null;
  if (boxes.length === 1) return pageBounds(scene);
  return unionBounds(boxes.map((b) => b.box));
}

function boxesOf(scene: SceneState, ids: readonly string[]): { id: string; box: Bounds }[] {
  const out: { id: string; box: Bounds }[] = [];
  for (const id of ids) {
    const n = scene.nodes[id];
    if (n) out.push({ id, box: worldAabbOfNode(n) });
  }
  return out;
}

function isDistribute(cmd: AlignCommand): cmd is DistributeKind {
  return cmd === "distribute-h" || cmd === "distribute-v";
}

// Gli op di un comando di allineamento: uno per nodo che si MUOVE davvero.
//
// I nodi già a posto non producono nessun op, e non è un'ottimizzazione: un
// setProps che riscrive gli stessi identici valori viaggerebbe sul filo, e il
// suo inverso finirebbe nella voce di undo -- un Ctrl+Z che "disfa" spostamenti
// mai avvenuti. Se non si muove nessuno la lista è vuota e alignSelection non
// apre nemmeno il gesto.
export function alignOps(scene: SceneState, ids: readonly string[], cmd: AlignCommand): Op[] {
  const boxes = boxesOf(scene, ids);
  if (boxes.length === 0) return [];
  const deltas = isDistribute(cmd)
    ? distributeDeltas(boxes.map((b) => b.box), cmd === "distribute-h" ? "x" : "y")
    : (() => {
        const target = alignTarget(scene, ids);
        return target ? boxes.map((b) => alignDelta(b.box, target, cmd)) : boxes.map(() => ZERO);
      })();
  const ops: Op[] = [];
  boxes.forEach(({ id }, i) => {
    const { dx, dy } = deltas[i];
    if (dx === 0 && dy === 0) return;
    const n = scene.nodes[id];
    // x e y viaggiano SEMPRE insieme, anche quando uno dei due delta è zero: la
    // mask è la stessa per tutti i comandi, quindi le anteprime di gesti
    // diversi si coalescono sulla stessa chiave (vedi store.ts::previewKey) e
    // l'op finale è confrontabile con quello di un trascinamento.
    ops.push(makeSetPropsOp(id, { x: n.x + dx, y: n.y + dy }, ["x", "y"]));
  });
  return ops;
}

// IL COMANDO: un gesto solo, quanti che siano i nodi mossi -- quindi una sola
// voce di undo e un solo giro di riconciliazione, esattamente come un
// trascinamento che sposta dieci nodi.
export function alignSelection(cmd: AlignCommand): void {
  const store = useScene.getState();
  const scene = store.scene;
  if (!scene) return;
  const ops = alignOps(scene, store.selection, cmd);
  if (ops.length === 0) return;
  store.beginGesture();
  store.endGesture(ops);
}
