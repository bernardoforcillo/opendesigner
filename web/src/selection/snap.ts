import type { Camera } from "../canvas/camera";
import { type Bounds, worldAabbOfNode } from "../canvas/geometry";
import type { SceneState } from "../store/types";

// SNAP — L'ALLINEAMENTO AUTOMATICO DURANTE UN GESTO.
//
// Il pezzo che conta è una DECISIONE, non un disegno: dati i candidati (le
// coordinate che il box mosso offre e quelle che gli altri nodi espongono),
// quale scatto applicare e dove disegnare la guida. Sta qui, come funzione
// pura, apposta: è dove vivono gli errori di un pixel, e testarla attraverso
// pointerdown/pointermove significherebbe non testarla affatto.
//
// DUE SCELTE DICHIARATE, perché entrambe hanno un'alternativa sensata:
//
//  1. NODI RUOTATI -> si scatta al loro RETTANGOLO ASSE-ALLINEATO (l'AABB, vedi
//     canvas/geometry.ts::worldAabbOfNode), non ai lati inclinati. È quello che
//     fanno gli editor, e la ragione è che una guida ha senso solo se è una
//     RETTA dello schermo: allineare il bordo di un rettangolo dritto al lato
//     obliquo di uno ruotato di 30° non produce nessun allineamento visibile,
//     produce un'intersezione. L'AABB è anche esattamente ciò che il riquadro
//     di selezione mostra per una selezione multipla, quindi quello che l'utente
//     vede scattare è quello che sta guardando.
//
//  2. TRATTO -> NON conta. I bersagli sono la GEOMETRIA (worldAabbOfNode), non
//     il dipinto (worldVisualAabbOfNode): sono gli stessi numeri che il pannello
//     proprietà mostra in X/Y/W/H e che il riquadro di selezione disegna, quindi
//     "i bordi combaciano" resta vero anche dopo aver cambiato lo spessore di un
//     tratto. Contare la sporgenza vorrebbe dire che due rettangoli allineati a
//     x=100 smettono di esserlo appena uno prende un bordo.

// Soglia in px SCHERMO: a ogni livello di zoom lo scatto "scatta" alla stessa
// distanza dal dito. In coordinate mondo la soglia si stringe zoomando (vedi
// worldThreshold), che è il punto: da vicino si posiziona più fine.
export const SNAP_THRESHOLD_PX = 6;

export type SnapAxis = "x" | "y";

// Una guida da disegnare: la retta `pos` sull'asse `axis`, estesa da `from` a
// `to` sull'ALTRO asse. Tutto in coordinate MONDO -- la conversione a schermo è
// del renderer, che passa dalla camera come chiunque altro.
export interface SnapGuide {
  axis: SnapAxis;
  pos: number;
  from: number;
  to: number;
}

export interface SnapResult {
  dx: number;
  dy: number;
  guides: SnapGuide[];
}

// Le coordinate MONDO corrispondenti a SNAP_THRESHOLD_PX px schermo. La camera
// è una similitudine (scala uniforme), quindi il fattore è lo zoom e vale
// identico sui due assi.
export function worldThreshold(cam: Camera): number {
  return SNAP_THRESHOLD_PX / cam.zoom;
}

// Le tre coordinate che un rettangolo offre su un asse: bordo minimo, CENTRO,
// bordo massimo. Il centro c'è per entrambi i ruoli -- un box può scattare col
// proprio centro, e può offrire il proprio centro a chi si muove.
export function snapLines(b: Bounds, axis: SnapAxis): [number, number, number] {
  return axis === "x"
    ? [b.x, b.x + b.width / 2, b.x + b.width]
    : [b.y, b.y + b.height / 2, b.y + b.height];
}

export interface AxisSnap {
  // Quanto spostare il box su questo asse.
  delta: number;
  // Le coordinate su cui lo scatto atterra, crescenti. Sono più di una quando
  // lo STESSO delta allinea due linee diverse (il bordo sinistro a un bordo e
  // il destro a un altro): sono due allineamenti veri, e meritano due guide.
  positions: number[];
}

// LA DECISIONE, NUDA. `moving` sono le coordinate che il box mosso offre su un
// asse, `targets` quelle esposte da tutto il resto; ritorna lo scatto migliore o
// null se nessuna coppia sta entro la soglia.
//
// "Migliore" = distanza minima. A parità ESATTA vince il delta più piccolo
// (cioè quello negativo): serve una regola, e una che non dipenda dall'ORDINE
// degli ingressi -- l'ordine dei nodi in una scena non è stabile
// (Object.values), quindi "il primo che ho incontrato" darebbe scatti diversi
// per la stessa geometria.
//
// La soglia è INCLUSIVA: a distanza esattamente uguale alla soglia si scatta.
// Il confronto è sul valore assoluto della distanza, senza epsilon: un epsilon
// qui allargherebbe la soglia di un valore arbitrario, e la soglia è già
// espressa in una grandezza che l'utente percepisce (px schermo).
export function snapAxis(
  moving: readonly number[],
  targets: readonly number[],
  threshold: number,
): AxisSnap | null {
  if (!(threshold >= 0)) return null;
  let best: number | null = null;
  for (const m of moving) {
    for (const t of targets) {
      const d = t - m;
      const ad = Math.abs(d);
      if (ad > threshold) continue;
      if (best === null) {
        best = d;
        continue;
      }
      const ab = Math.abs(best);
      if (ad < ab || (ad === ab && d < best)) best = d;
    }
  }
  if (best === null) return null;
  const positions: number[] = [];
  for (const m of moving) {
    for (const t of targets) {
      // Uguaglianza ESATTA e non "entro un epsilon": `best` è uno di questi
      // stessi t - m, quindi la coppia che l'ha prodotto si ritrova sempre. Una
      // coppia che dà lo stesso valore solo a meno di errore di virgola mobile
      // è un allineamento che l'utente non distingue: non mostrarne la guida
      // toglie una riga, non uno scatto.
      if (t - m === best && !positions.includes(t)) positions.push(t);
    }
  }
  positions.sort((a, b) => a - b);
  return { delta: best, positions };
}

// L'estensione della guida sull'asse PERPENDICOLARE: dal box mosso fino al più
// lontano dei nodi con cui si è allineato. È il segno che dice "questi due sono
// sulla stessa retta", quindi deve toccarli entrambi.
function extentOf(b: Bounds, axis: SnapAxis): [number, number] {
  return axis === "x" ? [b.y, b.y + b.height] : [b.x, b.x + b.width];
}

function guidesFor(
  box: Bounds,
  targets: readonly Bounds[],
  axis: SnapAxis,
  snap: AxisSnap,
): SnapGuide[] {
  return snap.positions.map((pos) => {
    let [from, to] = extentOf(box, axis);
    for (const t of targets) {
      if (!snapLines(t, axis).includes(pos)) continue;
      const [f, e] = extentOf(t, axis);
      from = Math.min(from, f);
      to = Math.max(to, e);
    }
    return { axis, pos, from, to };
  });
}

// Lo scatto di un rettangolo di cui possono muoversi SOLO certe linee. È la
// forma generale: il trascinamento offre tutte e sei le linee (vedi
// snapBounds), il ridimensionamento solo i bordi che la maniglia muove davvero
// -- scattare il bordo sinistro mentre si trascina il destro sposterebbe il
// nodo invece di ridimensionarlo.
//
// L'estensione delle guide si misura su `box` COM'È: lo scatto lo sposta al
// più di una soglia, cioè di qualche pixel schermo, e una guida lunga qualche
// pixel in meno non è una guida diversa.
export function snapMoving(
  box: Bounds,
  moving: { x: readonly number[]; y: readonly number[] },
  targets: readonly Bounds[] | SnapIndex,
  threshold: number,
): SnapResult {
  const guides: SnapGuide[] = [];
  let dx = 0;
  let dy = 0;
  // Con un indice già preparato (un gesto di trascinamento) si cerca in O(log n);
  // con una lista semplice (un test, un chiamante occasionale) si scansiona.
  const index = targets instanceof SnapIndex ? targets : null;
  const list = targets instanceof SnapIndex ? targets.targets : targets;
  for (const axis of ["x", "y"] as const) {
    if (moving[axis].length === 0) continue;
    if (index) {
      const snap = index.axisSnap(axis, moving[axis], threshold);
      if (!snap) continue;
      if (axis === "x") dx = snap.delta;
      else dy = snap.delta;
      guides.push(...index.guides(box, axis, snap));
      continue;
    }
    const lines: number[] = [];
    for (const t of list) lines.push(...snapLines(t, axis));
    const snap = snapAxis(moving[axis], lines, threshold);
    if (!snap) continue;
    if (axis === "x") dx = snap.delta;
    else dy = snap.delta;
    guides.push(...guidesFor(box, list, axis, snap));
  }
  return { dx, dy, guides };
}

// Il caso del TRASCINAMENTO: il rettangolo si muove tutto intero, quindi offre
// bordi e centri su entrambi gli assi.
export function snapBounds(box: Bounds, targets: readonly Bounds[] | SnapIndex, threshold: number): SnapResult {
  return snapMoving(box, { x: snapLines(box, "x"), y: snapLines(box, "y") }, targets, threshold);
}

// IL BERSAGLIO PREPARATO. Un gesto di trascinamento chiede lo scatto a OGNI
// movimento del puntatore, contro gli stessi bersagli: ricostruire ogni volta la
// lista di tutte le loro linee (con 20.000 nodi, 60.000 numeri per asse) e
// cercarci in modo lineare costava ~5 ms per movimento. Qui le linee si
// ordinano UNA volta, e ogni richiesta fa una ricerca binaria nella finestra
// [m - soglia, m + soglia]. Il risultato è IDENTICO a quello della scansione
// lineare (stesso scatto, stesse guide): lo fissa un test contro di essa.
export class SnapIndex {
  readonly targets: readonly Bounds[];
  private readonly lines: Record<SnapAxis, Float64Array>;
  // posizione -> indici dei bersagli che hanno una linea ESATTAMENTE lì, per
  // l'estensione delle guide (guidesFor li cerca per uguaglianza esatta).
  private readonly byPos: Record<SnapAxis, Map<number, number[]>>;

  constructor(targets: readonly Bounds[]) {
    this.targets = targets;
    const mk = (axis: SnapAxis) => {
      const lines = new Float64Array(targets.length * 3);
      const byPos = new Map<number, number[]>();
      targets.forEach((t, i) => {
        const l = snapLines(t, axis);
        for (let k = 0; k < 3; k++) {
          lines[i * 3 + k] = l[k];
          const list = byPos.get(l[k]);
          if (list) {
            if (list[list.length - 1] !== i) list.push(i);
          } else byPos.set(l[k], [i]);
        }
      });
      lines.sort();
      return { lines, byPos };
    };
    const x = mk("x");
    const y = mk("y");
    this.lines = { x: x.lines, y: y.lines };
    this.byPos = { x: x.byPos, y: y.byPos };
  }

  // Lo stesso risultato di snapAxis(moving, tutteLeLinee, threshold).
  axisSnap(axis: SnapAxis, moving: readonly number[], threshold: number): AxisSnap | null {
    if (!(threshold >= 0)) return null;
    const lines = this.lines[axis];
    // La finestra si allarga di un epsilon: |t - m| <= soglia si decide poi con la
    // STESSA espressione della scansione lineare, quindi un bordo che l'aritmetica
    // in virgola mobile mette dentro o fuori lo mette identico.
    const slack = (m: number) => threshold + 1e-9 * (1 + Math.abs(m));
    const lowerBound = (v: number): number => {
      let lo = 0;
      let hi = lines.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (lines[mid] < v) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    let best: number | null = null;
    for (const m of moving) {
      const w = slack(m);
      for (let i = lowerBound(m - w); i < lines.length && lines[i] <= m + w; i++) {
        const d = lines[i] - m;
        const ad = Math.abs(d);
        if (ad > threshold) continue;
        if (best === null) {
          best = d;
          continue;
        }
        const ab = Math.abs(best);
        if (ad < ab || (ad === ab && d < best)) best = d;
      }
    }
    if (best === null) return null;
    const positions: number[] = [];
    for (const m of moving) {
      const t = m + best;
      // Le linee t con t - m === best (uguaglianza esatta): sono quelle a
      // distanza `best`, cioè nell'intorno di m + best.
      const w = 1e-9 * (1 + Math.abs(t));
      for (let i = lowerBound(t - w); i < lines.length && lines[i] <= t + w; i++) {
        if (lines[i] - m === best && !positions.includes(lines[i])) positions.push(lines[i]);
      }
    }
    positions.sort((a, b) => a - b);
    return { delta: best, positions };
  }

  guides(box: Bounds, axis: SnapAxis, snap: AxisSnap): SnapGuide[] {
    return snap.positions.map((pos) => {
      let [from, to] = extentOf(box, axis);
      for (const i of this.byPos[axis].get(pos) ?? []) {
        const [f, e] = extentOf(this.targets[i], axis);
        from = Math.min(from, f);
        to = Math.max(to, e);
      }
      return { axis, pos, from, to };
    });
  }
}

/** Prepara i bersagli per un gesto: le richieste di scatto ripetute costano O(log n). */
export function prepareSnapTargets(targets: readonly Bounds[]): SnapIndex {
  return new SnapIndex(targets);
}

// I rettangoli a cui si può scattare: ogni nodo VISIBILE che non si sta
// muovendo. Invisibile vuol dire che non si vede, e scattare a una retta che
// non c'è è indistinguibile da uno scatto senza motivo.
export function snapTargets(scene: SceneState, exclude: readonly string[]): Bounds[] {
  const skip = new Set(exclude);
  const out: Bounds[] = [];
  for (const n of Object.values(scene.nodes)) {
    if (!n.visible || skip.has(n.id)) continue;
    out.push(worldAabbOfNode(n));
  }
  return out;
}
