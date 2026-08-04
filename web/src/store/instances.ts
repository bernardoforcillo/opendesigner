import { type Transform, compose, localTransformOf, translation } from "../canvas/transform";
import type { InstanceOverrideLite, NodeLite, SceneState } from "./types";

// LE ISTANZE: il sottoalbero VIRTUALE di un componente, e come si scende dentro.
//
// Un'istanza (kind "instance") non ha figli propri in `scene.nodes`: rende il
// sottoalbero del MASTER, che è un normale sottoalbero radicato in
// scene.components[componentId].rootNodeId. È quindi, in tutto e per tutto, "un
// GRUPPO i cui figli sono il sottoalbero del master, spostato all'origine
// dell'istanza, con degli override per nodo" -- e le quattro discese del
// renderer (disegno, hit-test, marquee) più i bounds la trattano proprio così,
// da questi due mattoni condivisi: la RISOLUZIONE del master e la
// TRASFORMAZIONE DI DISCESA. Averli in un posto solo è ciò che tiene
// vedi-vs-seleziona: disegno, click e cornice scendono con la stessa matrice.

export function isInstance(n: NodeLite | undefined): boolean {
  return n?.kind === "instance";
}

// Il master risolto di un'istanza: la radice del suo sottoalbero (un nodo VIVO
// in `scene.nodes`) e il componentId che rende. `null` quando l'istanza non ha
// contenuto da mostrare -- componente assente da `components`, oppure master
// assente da `nodes`: in quel caso non si disegna niente, non si colpisce niente
// e i bounds sono null, esattamente come un gruppo vuoto. Anche un nodo che non
// è un'istanza (o senza payload `instance`) ricade su null.
export interface ResolvedInstance {
  masterRoot: NodeLite;
  componentId: string;
}

export function resolveInstance(scene: SceneState, n: NodeLite): ResolvedInstance | null {
  if (n.kind !== "instance" || !n.instance) return null;
  const comp = scene.components[n.instance.componentId];
  if (!comp) return null;
  const masterRoot = scene.nodes[comp.rootNodeId];
  if (!masterRoot) return null;
  return { masterRoot, componentId: n.instance.componentId };
}

// Gli override dell'istanza indicizzati per nodo del master (masterNodeId ->
// override). È la mappa che il disegno FILA lungo la discesa del master: quando
// disegna un nodo del master il cui id è qui dentro, usa i `fills`/`text`
// dell'override al posto di quelli del nodo (vedi renderer/canvasRenderer.ts).
// I bounds NON la usano: un override di fill o testo non sposta la geometria (un
// testo più lungo potrebbe, ma questo modello non rimisura -- vedi il commento
// sui bounds in store/groups.ts).
export function instanceOverrideMap(n: NodeLite): Map<string, InstanceOverrideLite> {
  const map = new Map<string, InstanceOverrideLite>();
  if (n.instance) for (const o of n.instance.overrides) map.set(o.masterNodeId, o);
  return map;
}

// La trasformazione che PIAZZA il sottoalbero del master all'istanza, nello
// spazio del PARENT dell'istanza. Due pezzi:
//   - localTransformOf(n): la posizione (e la rotazione) dell'istanza nel suo
//     parent, IDENTICA a quella di un qualunque altro nodo;
//   - translation(-masterRoot.x, -masterRoot.y): dentro lo spazio locale
//     dell'istanza, sposta il master così che l'ORIGINE della sua radice cada
//     sull'origine dell'istanza. Senza, il master comparirebbe alle proprie
//     coordinate assolute invece che dove sta l'istanza.
// Il renderer la applica al ctx scendendo; l'hit-test le applica l'INVERSA al
// punto; i bounds la compongono con worldTransformOf(parent) e ci mappano i box
// del master. Sono le tre direzioni della stessa matrice, e devono restare la
// stessa matrice -- come localTransformOf per i container normali.
export function instanceDescentLocal(n: NodeLite, masterRoot: NodeLite): Transform {
  return compose(localTransformOf(n), translation(-masterRoot.x, -masterRoot.y));
}
