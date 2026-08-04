import { type Bounds, unionBounds, worldAabbOfNode } from "../canvas/geometry";
import { useScene } from "../store/store";
import { makeSetPropsOp } from "../tools/ops";
import type { SceneState } from "../store/types";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";

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
  for (let k = 0; k < n; k++) {
    const i = order[k];
    // I DUE ESTREMI non si muovono: è la DEFINIZIONE della distribuzione (sono
    // loro a delimitare lo spazio da spartire), non il risultato di un conto --
    // e quindi il loro zero va IMPOSTO, non sperato.
    //
    // Sperarlo non funziona: `cursor` accumula (size + gap) in virgola mobile e
    // su coordinate qualunque arriva all'ultimo box a min(last) meno un pelo
    // (con box a 969.9 / 309.3 / 456.6 il delta è -1.1e-13). Un delta di 1e-13
    // non è zero, quindi alignOps -- che confronta con lo zero ESATTO, e deve:
    // un epsilon lì sarebbe una soglia arbitraria su una grandezza che nessuno
    // percepisce -- gli manda un op. Sul filo viaggia uno spostamento
    // invisibile, nell'undo finisce una voce che non disfa niente, e il caso
    // non converge: ridistribuire di nuovo produce lo STESSO delta, per sempre.
    //
    // Il primo estremo verrebbe zero da sé (cursor parte esattamente da lì);
    // resta escluso qui perché la ragione è la stessa e vale per entrambi.
    if (k > 0 && k < n - 1) {
      const d = cursor - min(boxes[i]);
      out[i] = horiz ? { dx: d, dy: 0 } : { dx: 0, dy: d };
    }
    cursor += size(boxes[i]) + gap;
  }
  return out;
}

// Il rettangolo contro cui si allinea: SEMPRE il riquadro comune della
// selezione (l'unione degli AABB), cioè lo stesso riquadro che l'overlay
// disegna. null solo per una selezione vuota.
//
// UN NODO SOLO non si muove, ed è voluto: il suo riquadro comune è lui stesso,
// quindi tutti e sei gli allineamenti sono l'identità e alignOps non produce
// nessun op. È il comportamento di Figma per un oggetto solo sulla tela.
//
// NON esiste una pagina contro cui allinearlo. `opendesigner.v1.Page` porta oggi solo
// `id` e `name`: nel modello non c'è nessuna geometria di pagina (ed è lavoro
// della traccia 1, che possiede pagine e frame). Inventarne una -- un foglio
// 1920x1080 all'origine -- non sarebbe una convenzione innocua ma una
// TELETRASPORTAZIONE: la tela è infinita e un documento può vivere
// legittimamente a x = 10000, dove "allinea a sinistra" su un rettangolo solo
// lo spedirebbe a x = 0, fuori schermo, senza nessun segno che si sia mosso
// invece di sparire (e la camera parte a {0, 0, zoom: 1}, quindi nemmeno
// "l'area che si inquadra all'apertura" sarebbe quel foglio). Quando la
// traccia 1 darà bounds veri a pagine e frame, il riferimento di un nodo solo
// diventerà il suo CONTENITORE -- una LETTURA dal documento, non un numero
// scritto qui.
export function alignTarget(scene: SceneState, ids: readonly string[]): Bounds | null {
  const boxes = boxesOf(scene, ids);
  if (boxes.length === 0) return null;
  return unionBounds(boxes.map((b) => b.box));
}

// Quanti nodi servono perché il comando possa fare qualcosa: DUE per allineare
// (il riferimento è il riquadro comune, e con un nodo solo quel riquadro è il
// nodo stesso), TRE per distribuire (i due estremi non si muovono, quindi sotto
// i tre non c'è niente in mezzo da spartire).
//
// Il pannello ci disabilita i pulsanti: un comando che non farà niente deve
// DIRLO prima, perché un no-op silenzioso è indistinguibile da un comando rotto.
export function minSelection(cmd: AlignCommand): number {
  return isDistribute(cmd) ? 3 : 2;
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
