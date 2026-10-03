import type { AnimInfo, ClipLite, NodeLite, SceneState } from "../store/types";
import { recordDelta } from "../store/sceneDelta";
import { contentWorldBounds } from "../store/groups";
import { applyTransform, invertTransform, worldTransformOf } from "../canvas/transform";
import { sampleClip, type NodeAnim } from "./engine";

// LA SCENA IN POSA.
//
// Mentre una clip gira (o si scorre il playhead, o si registra) la tela non
// mostra il documento ma una SUA VARIANTE: gli stessi nodi con i valori
// campionati al posto di quelli di base. È derivata, mai scritta: il documento
// non cambia, nessun op parte, e smettere di animare riporta alla scena vera
// senza niente da disfare.
//
// La scena derivata è una scena come le altre, quindi il renderer, l'hit-test,
// l'overlay e i tool la leggono senza saperlo:
//   - x, y, rotation, opacity sono i campi veri del nodo;
//   - `scale` e `draw` non hanno un campo nel modello: vanno nei campi
//     TRANSITORI animScale/animPivot/animDraw di NodeLite, che solo il renderer
//     conosce (canvas/transform.ts::localTransformOf, renderer/animDraw.ts).
//
// Il costo è proporzionale ai nodi ANIMATI, non al documento: la mappa dei nodi è
// persistente (si sostituiscono poche voci) e la provenienza (sceneDelta) dice
// all'indice di scena che sono cambiati solo quelli, così non lo ricostruisce.

/** I tipi di nodo su cui `draw` ha senso (hanno un tracciato): parità con core.validTrack. */
export function canDraw(n: Pick<NodeLite, "kind">): boolean {
  return n.kind === "vector" || n.kind === "rect" || n.kind === "ellipse" || n.kind === "frame";
}

/** Unisce `src` dentro `dst`: le proprietà di `src` vincono (le clip dopo sovrascrivono). */
export function mergeAnim(dst: Map<string, NodeAnim>, src: ReadonlyMap<string, NodeAnim>): Map<string, NodeAnim> {
  for (const [id, a] of src) {
    const cur = dst.get(id);
    if (cur) Object.assign(cur, a);
    else dst.set(id, { ...a });
  }
  return dst;
}

/** I valori campionati di una clip a `t` ms, con una bozza (record, trascinamento) sopra. */
export function sampleWithDraft(clip: Pick<ClipLite, "tracks">, t: number, draft?: ReadonlyMap<string, NodeAnim> | null): Map<string, NodeAnim> {
  const out = sampleClip(clip, t);
  return draft && draft.size > 0 ? mergeAnim(out, draft) : out;
}

// Il centro (spazio del parent) attorno a cui scala un GRUPPO: un gruppo non ha un
// box, il suo "centro" è quello dei contenuti. Calcolato sulla scena di BASE
// (la geometria dei figli non è animata da questa traccia) e spostato di quanto
// la traccia sposta il gruppo stesso.
function groupPivot(base: SceneState, n: NodeLite, a: NodeAnim): { x: number; y: number } | undefined {
  const b = contentWorldBounds(base, n);
  if (!b) return undefined;
  const inv = invertTransform(worldTransformOf(base, n.parentId));
  const c = applyTransform(inv, b.x + b.width / 2, b.y + b.height / 2);
  return { x: c.x + ((a.x ?? n.x) - n.x), y: c.y + ((a.y ?? n.y) - n.y) };
}

/**
 * La scena `base` con i valori `anim` applicati ai nodi. Ritorna `base` stessa
 * (stessa identità: nessun ridisegno in più, nessun indice da rifare) se niente
 * cambia -- una clip vuota, valori uguali a quelli di base, nodi spariti.
 */
export function poseScene(base: SceneState, anim: ReadonlyMap<string, NodeAnim>): SceneState {
  if (anim.size === 0) return base;
  let edit: ReturnType<SceneState["nodes"]["edit"]> | null = null;
  const changed: string[] = [];
  const scaled = new Set<string>();
  let hasDraw = false;
  for (const [id, a] of anim) {
    const n = base.nodes.get(id);
    if (!n) continue;
    let next: NodeLite | null = null;
    const patch = () => (next ??= { ...n });
    if (a.opacity !== undefined && a.opacity !== n.opacity) patch().opacity = a.opacity;
    if (a.x !== undefined && a.x !== n.x) patch().x = a.x;
    if (a.y !== undefined && a.y !== n.y) patch().y = a.y;
    if (a.rotation !== undefined && a.rotation !== n.rotation) patch().rotation = a.rotation;
    if (a.scale !== undefined && a.scale !== 1) {
      const p = patch();
      p.animScale = a.scale;
      if (n.kind === "group") p.animPivot = groupPivot(base, n, a);
      scaled.add(id);
    }
    if (a.draw !== undefined && canDraw(n)) {
      patch().animDraw = a.draw;
      // a 1 il tracciato è intero: il renderer GPU lo disegna normalmente, niente ripiego in CPU
      if (a.draw < 1) hasDraw = true;
    }
    if (next) {
      edit ??= base.nodes.edit();
      edit.set(id, next);
      changed.push(id);
    }
  }
  if (!edit) return base;
  // Gli antenati dei nodi scalati: il loro extent è l'unione dei figli.
  const ancestors = new Set<string>();
  for (const id of scaled) {
    for (let cur = base.nodes.get(id), g = 0; cur && g < 1000; cur = base.nodes.get(cur.parentId), g++) {
      if (cur.id !== id) ancestors.add(cur.id);
    }
  }
  const info: AnimInfo = { scaled, ancestors, hasDraw };
  const scene: SceneState = { ...base, nodes: edit.done(), anim: info };
  recordDelta(scene, base, changed);
  return scene;
}
