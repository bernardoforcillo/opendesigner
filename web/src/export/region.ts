import type { NodeLite, SceneState } from "../store/types";
import { type Bounds, boundsOfNode, unionBounds } from "../canvas/geometry";
import { sortedVisible } from "../renderer/canvasRenderer";
import { isPaintable } from "../renderer/shapes";
import { textPaintBounds, type MeasureText } from "../renderer/text";

// CHE COSA SI ESPORTA, E DOVE STA.
//
// L'export avviene LATO CLIENT (vedi export/png.ts e export/svg.ts): questo
// modulo è il pezzo comune ai due formati, cioè la risposta a due domande che
// non dipendono dal formato -- quali nodi finiscono nel file, e qual è il
// rettangolo di mondo che il file rappresenta.
//
// Nessun parametro `Camera`, e non è una dimenticanza: è l'invariante di questo
// modulo. La regione esportata è funzione dei NODI, non di dove l'utente aveva
// scrollato o di quanto aveva zoomato. Un export che dipendesse dalla camera
// darebbe file diversi dallo stesso documento.
//
// C'è invece una MISURA DEL TESTO, che non è la stessa cosa: non dice dove
// guarda l'utente, dice quanto è grande un glifo -- una proprietà del
// documento e del font, identica a ogni zoom. Senza, i bounds sarebbero quelli
// dei box del modello, e il testo che trabocca il proprio box (vedi
// renderer/text.ts::textPaintBounds) verrebbe ritagliato via dal file senza un
// avviso. La misura resta iniettata, quindi questo modulo continua a non
// toccare né il DOM né un canvas.

export type ExportScope = "selection" | "page";

export interface ExportRegion {
  scope: ExportScope;
  // I nodi da disegnare, in ORDINE DI DISEGNO (dal fondo alla cima), già
  // filtrati come li filtra il renderer.
  nodes: NodeLite[];
  // Il rettangolo MONDO occupato esattamente da quei nodi.
  bounds: Bounds;
  // La scena RIDOTTA a quei nodi. Serve a export/png.ts, che riusa drawScene
  // (l'unico renderer che esiste) invece di riscriverne un secondo: passargli
  // la scena intera disegnerebbe anche i nodi non selezionati.
  scene: SceneState;
}

// Il rettangolo che un nodo occupa NEL FILE.
//
// Per ogni forma è il box del modello, che è anche tutto ciò che la forma
// dipinge. Il testo è l'eccezione, e l'unica: dipinge le righe che il layout
// produce, che possono uscire dal box in tutte le direzioni. Il ramo è
// esplicito qui invece che nascosto dentro `boundsOfNode` perché `boundsOfNode`
// è il box del MODELLO -- quello delle maniglie, del rettangolo di selezione e
// del pannello proprietà -- e deve restare tale: qui la domanda è un'altra,
// "che cosa verrebbe tagliato via", e la risposta ha bisogno di una misura.
function exportBounds(n: NodeLite, measure: MeasureText): Bounds {
  return n.kind === "text" ? textPaintBounds(measure, n) : boundsOfNode(n);
}

/**
 * La regione da esportare, o `null` quando non c'è niente da esportare (pagina
 * vuota, selezione vuota o ridotta a nodi invisibili).
 *
 * I nodi sono scelti e ordinati da `sortedVisible` + `isPaintable`, cioè dalle
 * stesse due funzioni che usa `drawScene`: ciò che si vede sul canvas è ciò che
 * finisce nel file, e -- altrettanto importante -- ciò che NON si vede non
 * allarga i bounds. Un rettangolo 0x0 dimenticato a (5000, 5000) produrrebbe
 * altrimenti un'immagine enorme con il disegno vero in un angolo.
 *
 * `measure` è obbligatoria e non opzionale di proposito: il valore di ripiego
 * (il box del modello) sarebbe sbagliato per il testo e sbagliato in silenzio,
 * cioè la firma inviterebbe a produrre file ritagliati. Chi esporta un canvas
 * ce l'ha già; chi non può misurare non può nemmeno sapere che cosa esporta.
 */
export function exportRegion(
  scene: SceneState,
  selection: readonly string[],
  scope: ExportScope,
  measure: MeasureText,
): ExportRegion | null {
  const drawn = sortedVisible(scene).filter(isPaintable);
  // Si filtra la lista GIÀ ordinata invece di mappare la selezione: l'ordine di
  // disegno è quello di orderKey, non quello in cui l'utente ha cliccato.
  const nodes =
    scope === "selection" ? drawn.filter((n) => selection.includes(n.id)) : drawn;
  const bounds = unionBounds(nodes.map((n) => exportBounds(n, measure)));
  if (bounds === null) return null;
  return {
    scope,
    nodes,
    bounds,
    scene: { ...scene, nodes: Object.fromEntries(nodes.map((n) => [n.id, n])) },
  };
}
