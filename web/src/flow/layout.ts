import type { Bounds } from "../canvas/geometry";
import { worldBoundsOfNode } from "../canvas/transform";
import type { SceneState, TransitionLite } from "../store/types";
import {
  arrowBetween, bezierBounds, bezierPoint, distanceToBezier, inflate, laneShift, overlaps,
  type Bezier, type Pt,
} from "./geometry";

// IL LAYOUT DELLE FRECCE: dalle transizioni del documento alle curve in mondo.
// Dipende solo da scene.nodes e scene.transitions, quindi è memoizzato su quei
// due riferimenti: finché non cambiano (camera che si muove, hover, selezione)
// il renderer e il hit-test riusano lo STESSO array, senza allocare.

export interface Arrow {
  id: string;
  flowId: string;
  fromId: string;
  toId: string;
  curve: Bezier;
  /** Il rettangolo che contiene la curva (per il culling). */
  bounds: Bounds;
  /** Il punto medio, dove sta la pillola dell'etichetta. */
  mid: Pt;
  /** L'hotspot (bounds mondo dell'elemento che innesca), se la transizione ne ha uno. */
  hotspot: Bounds | null;
  label: string;
  trigger: string;
  guarded: boolean;
}

export interface FlowLayout {
  arrows: Arrow[];
  byId: Map<string, Arrow>;
}

// Semi-lati (px SCHERMO) della presa sulla pillola dell'etichetta: la pillola si
// clicca come la freccia. Il hit-test li divide per lo zoom.
export const LABEL_HIT = { w: 40, h: 11 };

const EMPTY: FlowLayout = { arrows: [], byId: new Map() };

let memo: { nodes: unknown; transitions: unknown; layout: FlowLayout } | null = null;

function boundsOf(scene: SceneState, id: string): Bounds | null {
  const n = scene.nodes.at(id);
  return n ? worldBoundsOfNode(scene, n) : null;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

/** Il testo della pillola: l'etichetta, altrimenti l'innesco (il "cosa" del passaggio). */
export function arrowLabel(t: Pick<TransitionLite, "label" | "trigger">): string {
  return t.label.trim() !== "" ? t.label.trim() : t.trigger;
}

/** Calcola il layout di TUTTE le transizioni del documento (memoizzato). */
export function flowLayout(scene: SceneState): FlowLayout {
  if (memo && memo.nodes === scene.nodes && memo.transitions === scene.transitions) return memo.layout;
  const all = Object.values(scene.transitions);
  if (all.length === 0) {
    memo = { nodes: scene.nodes, transitions: scene.transitions, layout: EMPTY };
    return EMPTY;
  }
  // Ordine stabile (per id): la corsia di una freccia non deve cambiare quando
  // ne arriva un'altra da un peer.
  all.sort((a, b) => (a.id < b.id ? -1 : 1));
  // Quante frecce condividono ogni coppia di schermate (in qualunque verso).
  const counts = new Map<string, number>();
  for (const t of all) {
    const k = pairKey(t.fromId, t.toId);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  const arrows: Arrow[] = [];
  const byId = new Map<string, Arrow>();
  for (const t of all) {
    const fromScreen = boundsOf(scene, t.fromId);
    const toScreen = boundsOf(scene, t.toId);
    if (!fromScreen || !toScreen) continue;
    const k = pairKey(t.fromId, t.toId);
    const lane = seen.get(k) ?? 0;
    seen.set(k, lane + 1);
    const hotspot = t.elementId !== "" ? boundsOf(scene, t.elementId) : null;
    // Con un hotspot la freccia nasce dall'elemento (il bottone), non dal bordo
    // della schermata: è lì che l'utente la leggerebbe.
    const start = hotspot ?? fromScreen;
    const count = counts.get(k) ?? 1;
    const curve = arrowBetween(start, toScreen, laneShift(lane, count), t.fromId === t.toId);
    const arrow: Arrow = {
      id: t.id,
      flowId: t.flowId,
      fromId: t.fromId,
      toId: t.toId,
      curve,
      bounds: bezierBounds(curve),
      // La pillola sta a metà curva; con più frecce sulla stessa coppia si
      // sfalsa lungo la curva, così le etichette non si coprono a vicenda.
      mid: bezierPoint(curve, count <= 1 ? 0.5 : Math.min(0.72, Math.max(0.28, 0.5 + (lane - (count - 1) / 2) * 0.16))),
      hotspot,
      label: arrowLabel(t),
      trigger: t.trigger,
      guarded: t.guard.trim() !== "",
    };
    arrows.push(arrow);
    byId.set(arrow.id, arrow);
  }
  const layout = { arrows, byId };
  memo = { nodes: scene.nodes, transitions: scene.transitions, layout };
  return layout;
}

/** Le frecce che toccano la vista (mondo): il culling dei documenti grandi. */
export function arrowsInView(layout: FlowLayout, view: Bounds, pad: number): Arrow[] {
  const v = inflate(view, pad);
  return layout.arrows.filter((a) => overlaps(a.bounds, v));
}

/**
 * La freccia sotto (x, y) (mondo), la più vicina entro `tol` unità mondo, con
 * priorità alle frecce del flusso `preferFlowId`. null se nessuna. Pillola
 * dell'etichetta inclusa: `labelHalf` è il semi-lato (mondo) del suo riquadro di
 * presa attorno al punto medio.
 */
export function hitArrow(
  layout: FlowLayout,
  x: number,
  y: number,
  tol: number,
  labelHalf: { w: number; h: number },
  allowed?: (a: Arrow) => boolean,
): Arrow | null {
  let best: Arrow | null = null;
  let bestD = Infinity;
  for (const a of layout.arrows) {
    if (allowed && !allowed(a)) continue;
    // Il prefiltro lascia passare anche la pillola, che sporge dal rettangolo dei
    // punti di controllo (una freccia dritta ha altezza zero).
    const px = Math.max(tol, labelHalf.w);
    const py = Math.max(tol, labelHalf.h);
    if (x < a.bounds.x - px || x > a.bounds.x + a.bounds.width + px) continue;
    if (y < a.bounds.y - py || y > a.bounds.y + a.bounds.height + py) continue;
    let d = distanceToBezier(a.curve, x, y);
    // Dentro la pillola dell'etichetta conta come un colpo pieno.
    if (Math.abs(x - a.mid.x) <= labelHalf.w && Math.abs(y - a.mid.y) <= labelHalf.h) d = 0;
    if (d <= tol && d < bestD) {
      best = a;
      bestD = d;
    }
  }
  return best;
}
