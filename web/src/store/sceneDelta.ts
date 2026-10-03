import type { SceneState } from "./types";

// La PROVENIENZA di una scena: da quale scena è stata prodotta e quali nodi sono
// stati toccati. applyOp la registra per gli op che toccano pochi nodi noti
// (creare, scrivere proprietà, testo, tracciato) e per i nodi che l'auto layout
// ha poi ridisposto.
//
// Serve a chi mantiene strutture derivate dalla scena (l'indice di scena): senza,
// per sapere cosa è cambiato devono confrontare TUTTI i nodi -- una scansione
// lineare per ogni op, anche quando l'op ne ha toccato uno. Con la provenienza
// il costo è proporzionale ai nodi toccati.
//
// È solo un SUGGERIMENTO: chi la usa deve poter ricadere sul confronto completo
// (la scena precedente può non avere una struttura derivata, un op può non
// registrarla). WeakMap, così non trattiene scene che nessuno più referenzia.
export interface SceneDelta {
  prev: SceneState;
  // Id dei nodi la cui voce in `nodes` è nuova o cambiata. Mai nodi rimossi: gli
  // op che ne rimuovono non registrano la provenienza.
  changed: readonly string[];
}

const deltas = new WeakMap<SceneState, SceneDelta>();

export function recordDelta(next: SceneState, prev: SceneState, changed: readonly string[]): void {
  if (next !== prev) deltas.set(next, { prev, changed });
}

export function deltaOf(scene: SceneState): SceneDelta | undefined {
  return deltas.get(scene);
}
