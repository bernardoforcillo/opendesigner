import type { NodeLite, SceneState } from "../store/types";
import { sceneIndexOf } from "../renderer/sceneIndex";
import { rootsOf } from "../renderer/canvasRenderer";

// CHE COS'È UNA SCHERMATA. Nel modello dei flussi una schermata è un nodo del
// documento (le transizioni lo referenziano per id); in pratica, nell'editor, è
// un FRAME DI PRIMO LIVELLO: figlio diretto di una pagina. Un elemento dentro il
// frame (un bottone) non è una schermata ma può essere il suo "hotspot".

/** Il nodo è figlio diretto di una pagina del documento. */
export function isPageRoot(scene: SceneState, n: NodeLite): boolean {
  return scene.pages.some((p) => p.id === n.parentId);
}

/**
 * La schermata a cui appartiene `id`: l'antenato-o-sé che è figlio diretto di
 * una pagina. null se `id` non esiste o non risale a nessuna pagina (nodo
 * orfano). A prova di ciclo, come tree.ts::ancestorsOf.
 */
export function screenOf(scene: SceneState, id: string): NodeLite | null {
  const seen = new Set<string>();
  let cur = scene.nodes.at(id);
  while (cur && !seen.has(cur.id)) {
    if (isPageRoot(scene, cur)) return cur;
    seen.add(cur.id);
    cur = scene.nodes.at(cur.parentId);
  }
  return null;
}

/** Un frame di primo livello: ciò che "Collega" accetta come estremo di una freccia. */
export function isScreenNode(n: NodeLite | null | undefined): n is NodeLite {
  return !!n && n.kind === "frame";
}

/**
 * Le schermate della pagina (frame di primo livello), nell'ordine del documento.
 * Passa dall'indice di scena memoizzato: nessuna scansione della mappa per
 * chiamata.
 */
export function topLevelScreens(scene: SceneState, pageId: string | null): NodeLite[] {
  const roots = rootsOf(scene, sceneIndexOf(scene).children, pageId);
  return roots.filter(isScreenNode);
}

/**
 * Da dove parte un drag di "Collega": il nodo sotto il puntatore diventa la
 * schermata di partenza (se è un frame di primo livello) oppure l'hotspot
 * `elementId` dentro la sua schermata. null se non c'è nessuna schermata.
 */
export function connectSource(scene: SceneState, hitId: string): { screenId: string; elementId: string } | null {
  const screen = screenOf(scene, hitId);
  if (!isScreenNode(screen)) return null;
  return { screenId: screen.id, elementId: hitId === screen.id ? "" : hitId };
}

/** Il nome da mostrare per una schermata (mai vuoto). */
export function screenName(scene: SceneState, id: string): string {
  const n = scene.nodes.at(id);
  if (!n) return "(schermata eliminata)";
  return n.name.trim() !== "" ? n.name : "Senza nome";
}
