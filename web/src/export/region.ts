import type { NodeLite, SceneState } from "../store/types";
import { type Bounds, boundsOfNode, unionBounds } from "../canvas/geometry";
import { sortedVisible } from "../renderer/canvasRenderer";
import { isPaintable } from "../renderer/shapes";

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

/**
 * La regione da esportare, o `null` quando non c'è niente da esportare (pagina
 * vuota, selezione vuota o ridotta a nodi invisibili).
 *
 * I nodi sono scelti e ordinati da `sortedVisible` + `isPaintable`, cioè dalle
 * stesse due funzioni che usa `drawScene`: ciò che si vede sul canvas è ciò che
 * finisce nel file, e -- altrettanto importante -- ciò che NON si vede non
 * allarga i bounds. Un rettangolo 0x0 dimenticato a (5000, 5000) produrrebbe
 * altrimenti un'immagine enorme con il disegno vero in un angolo.
 */
export function exportRegion(
  scene: SceneState,
  selection: readonly string[],
  scope: ExportScope,
): ExportRegion | null {
  const drawn = sortedVisible(scene).filter(isPaintable);
  // Si filtra la lista GIÀ ordinata invece di mappare la selezione: l'ordine di
  // disegno è quello di orderKey, non quello in cui l'utente ha cliccato.
  const nodes =
    scope === "selection" ? drawn.filter((n) => selection.includes(n.id)) : drawn;
  const bounds = unionBounds(nodes.map(boundsOfNode));
  if (bounds === null) return null;
  return {
    scope,
    nodes,
    bounds,
    scene: { ...scene, nodes: Object.fromEntries(nodes.map((n) => [n.id, n])) },
  };
}
