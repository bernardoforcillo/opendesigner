import type { Diagram, DiagramShape, EdgeStyle } from "./mermaid";

// Disposizione a LIVELLI (stile Sugiyama, versione corta) di un diagramma.
//
//   1. archi di ritorno invertiti con una DFS, così il grafo diventa un DAG;
//   2. ogni nodo al livello del suo percorso più lungo dall'ingresso;
//   3. gli archi che saltano livelli passano da nodi finti, uno per livello,
//      altrimenti attraverserebbero i nodi di mezzo;
//   4. l'ordine dentro il livello si migliora col baricentro dei vicini;
//   5. le posizioni trasversali tirano ogni nodo verso i suoi vicini, senza
//      mai sovrapporli.
//
// Tutto è puro e deterministico: lo stesso testo dà sempre gli stessi byte.

export interface PlacedNode {
  id: string;
  label: string;
  shape: DiagramShape;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Pt {
  x: number;
  y: number;
}

export interface PlacedEdge {
  from: string;
  to: string;
  label?: string;
  style: EdgeStyle;
  arrowEnd: boolean;
  arrowStart: boolean;
  /** Spezzata dal bordo di `from` al bordo di `to`. */
  points: Pt[];
  labelAt?: Pt;
}

export interface Layout {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  width: number;
  height: number;
}

export const FONT_SIZE = 14;
const CHAR_W = 7.4;
const NODE_GAP = 44;
const RANK_GAP = 64;
const MARGIN = 28;

export const textWidth = (s: string): number => Math.max(...s.split("\n").map((l) => l.length), 0) * CHAR_W;
export const textHeight = (s: string): number => s.split("\n").length * FONT_SIZE * 1.3;

export function sizeOf(label: string, shape: DiagramShape): { width: number; height: number } {
  const tw = textWidth(label);
  const th = textHeight(label);
  switch (shape) {
    case "diamond": return { width: Math.max(104, tw * 1.7 + 24), height: Math.max(68, th * 1.9 + 24) };
    case "circle": {
      const d = Math.max(60, tw + 30, th + 30);
      return { width: d, height: d };
    }
    case "stadium": return { width: Math.max(92, tw + 44), height: Math.max(44, th + 22) };
    default: return { width: Math.max(80, tw + 32), height: Math.max(44, th + 22) };
  }
}

interface Item {
  key: string;
  real: boolean;
  rank: number;
  /** Dimensione sull'asse trasversale e su quello dei livelli. */
  across: number;
  along: number;
  pos: number;
}

/** Il punto dove il segmento centro -> `toward` esce dalla forma. */
export function clipToShape(n: PlacedNode, toward: Pt): Pt {
  const cx = n.x + n.width / 2;
  const cy = n.y + n.height / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const hw = n.width / 2;
  const hh = n.height / 2;
  let t: number;
  if (n.shape === "diamond") t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
  else if (n.shape === "circle") t = 1 / Math.hypot(dx / hw, dy / hh);
  else t = 1 / Math.max(Math.abs(dx) / hw, Math.abs(dy) / hh);
  return { x: cx + dx * t, y: cy + dy * t };
}

export function layoutDiagram(d: Diagram): Layout {
  const ids = d.nodes.map((n) => n.id);
  const byId = new Map(d.nodes.map((n) => [n.id, n] as const));
  const vertical = d.direction === "TD" || d.direction === "BT";

  // 1. Cicli: una DFS marca come "di ritorno" gli archi verso un nodo in corso.
  const out = new Map<string, string[]>(ids.map((i) => [i, []]));
  for (const e of d.edges) if (e.from !== e.to && byId.has(e.from) && byId.has(e.to)) out.get(e.from)!.push(e.to);
  const state = new Map<string, 0 | 1 | 2>();
  const back = new Set<string>();
  const visit = (u: string) => {
    state.set(u, 1);
    for (const v of out.get(u)!) {
      const s = state.get(v) ?? 0;
      if (s === 1) back.add(`${u}>${v}`);
      else if (s === 0) visit(v);
    }
    state.set(u, 2);
  };
  // Le sorgenti prima (nessun arco entrante), poi ciò che resta: l'ingresso
  // di un ciclo puro è il primo nodo dichiarato.
  const hasIn = new Set<string>();
  for (const e of d.edges) if (e.from !== e.to) hasIn.add(e.to);
  for (const i of ids) if (!hasIn.has(i) && !state.has(i)) visit(i);
  for (const i of ids) if (!state.has(i)) visit(i);

  // DAG: coppie (da, a) orientate nel verso dei livelli, senza duplicati.
  const dag: [string, string][] = [];
  const seen = new Set<string>();
  for (const e of d.edges) {
    if (e.from === e.to || !byId.has(e.from) || !byId.has(e.to)) continue;
    const rev = back.has(`${e.from}>${e.to}`);
    const [a, b] = rev ? [e.to, e.from] : [e.from, e.to];
    if (!seen.has(`${a}>${b}`)) {
      seen.add(`${a}>${b}`);
      dag.push([a, b]);
    }
  }

  // 2. Livelli: percorso più lungo, in ordine topologico (Kahn).
  const rank = new Map<string, number>(ids.map((i) => [i, 0]));
  const indeg = new Map<string, number>(ids.map((i) => [i, 0]));
  const succ = new Map<string, string[]>(ids.map((i) => [i, []]));
  for (const [a, b] of dag) {
    indeg.set(b, indeg.get(b)! + 1);
    succ.get(a)!.push(b);
  }
  const queue = ids.filter((i) => indeg.get(i) === 0);
  for (let q = 0; q < queue.length; q++) {
    const u = queue[q];
    for (const v of succ.get(u)!) {
      rank.set(v, Math.max(rank.get(v)!, rank.get(u)! + 1));
      indeg.set(v, indeg.get(v)! - 1);
      if (indeg.get(v) === 0) queue.push(v);
    }
  }

  // 3. Elementi per livello: nodi veri e finti.
  const items = new Map<string, Item>();
  const layers: Item[][] = [];
  const put = (it: Item) => {
    items.set(it.key, it);
    (layers[it.rank] ??= []).push(it);
  };
  for (const id of ids) {
    const n = byId.get(id)!;
    const s = sizeOf(n.label, n.shape);
    put({ key: id, real: true, rank: rank.get(id)!, across: vertical ? s.width : s.height, along: vertical ? s.height : s.width, pos: 0 });
  }
  const nbrUp = new Map<string, string[]>();
  const nbrDown = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    (nbrDown.get(a) ?? nbrDown.set(a, []).get(a)!).push(b);
    (nbrUp.get(b) ?? nbrUp.set(b, []).get(b)!).push(a);
  };
  const chains = new Map<string, string[]>(); // "a>b" -> chiavi da a a b
  for (const [a, b] of dag) {
    const chain = [a];
    for (let r = rank.get(a)! + 1; r < rank.get(b)!; r++) {
      const key = `~${a}>${b}@${r}`;
      put({ key, real: false, rank: r, across: 8, along: 0, pos: 0 });
      chain.push(key);
    }
    chain.push(b);
    for (let i = 0; i + 1 < chain.length; i++) link(chain[i], chain[i + 1]);
    chains.set(`${a}>${b}`, chain);
  }
  for (let r = 0; r < layers.length; r++) layers[r] ??= [];

  // 4. Ordine: baricentro, qualche passata giù e su. `sort` è stabile.
  const order = () => {
    for (const L of layers) L.forEach((it, i) => (it.pos = i));
  };
  order();
  const sweep = (down: boolean) => {
    const range = [...layers.keys()];
    if (!down) range.reverse();
    for (const r of range) {
      if (down ? r === 0 : r === layers.length - 1) continue;
      const nb = down ? nbrUp : nbrDown;
      const bary = new Map<string, number>();
      for (const it of layers[r]) {
        const ns = nb.get(it.key);
        bary.set(it.key, ns && ns.length ? ns.reduce((s, k) => s + items.get(k)!.pos, 0) / ns.length : it.pos);
      }
      layers[r].sort((a, b) => bary.get(a.key)! - bary.get(b.key)!);
      layers[r].forEach((it, i) => (it.pos = i));
    }
  };
  for (let i = 0; i < 4; i++) {
    sweep(true);
    sweep(false);
  }

  // 5. Posizioni trasversali: livello per livello, compatte e centrate; poi
  // ogni elemento si avvicina ai vicini (media fra impacchettamento a sinistra
  // e a destra, che mantiene le distanze minime).
  const cross = new Map<string, number>();
  for (const L of layers) {
    let x = 0;
    for (const it of L) {
      cross.set(it.key, x + it.across / 2);
      x += it.across + NODE_GAP;
    }
    const total = x - NODE_GAP;
    for (const it of L) cross.set(it.key, cross.get(it.key)! - total / 2);
  }
  const relax = (down: boolean) => {
    const range = [...layers.keys()];
    if (!down) range.reverse();
    for (const r of range) {
      const L = layers[r];
      if (L.length === 0) continue;
      const nb = down ? nbrUp : nbrDown;
      const want = L.map((it) => {
        const ns = nb.get(it.key);
        return ns && ns.length ? ns.reduce((s, k) => s + cross.get(k)!, 0) / ns.length : cross.get(it.key)!;
      });
      const left: number[] = [];
      for (let i = 0; i < L.length; i++) {
        const min = i === 0 ? -Infinity : left[i - 1] + (L[i - 1].across + L[i].across) / 2 + NODE_GAP;
        left.push(Math.max(want[i], min));
      }
      const right: number[] = new Array(L.length);
      for (let i = L.length - 1; i >= 0; i--) {
        const max = i === L.length - 1 ? Infinity : right[i + 1] - (L[i + 1].across + L[i].across) / 2 - NODE_GAP;
        right[i] = Math.min(want[i], max);
      }
      L.forEach((it, i) => cross.set(it.key, (left[i] + right[i]) / 2));
    }
  };
  for (let i = 0; i < 3; i++) {
    relax(true);
    relax(false);
  }

  // Posizione lungo i livelli: ogni livello alto quanto il suo nodo più alto.
  const along: number[] = [];
  let acc = 0;
  for (let r = 0; r < layers.length; r++) {
    const h = Math.max(0, ...layers[r].map((it) => it.along));
    along[r] = acc + h / 2;
    acc += h + RANK_GAP;
  }
  const totalAlong = Math.max(acc - RANK_GAP, 0);

  // Coordinate finali secondo la direzione.
  const centre = (key: string): Pt => {
    const it = items.get(key)!;
    const a = along[it.rank];
    const c = cross.get(key)!;
    const bx = d.direction === "RL" ? totalAlong - a : a;
    const by = d.direction === "BT" ? totalAlong - a : a;
    return vertical ? { x: c, y: by } : { x: bx, y: c };
  };
  const placed = new Map<string, PlacedNode>();
  for (const id of ids) {
    const n = byId.get(id)!;
    const s = sizeOf(n.label, n.shape);
    const c = centre(id);
    placed.set(id, { id, label: n.label, shape: n.shape, x: c.x - s.width / 2, y: c.y - s.height / 2, width: s.width, height: s.height });
  }

  const edges: PlacedEdge[] = [];
  for (const e of d.edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    const a = placed.get(e.from)!;
    const b = placed.get(e.to)!;
    const base = { from: e.from, to: e.to, label: e.label, style: e.style, arrowEnd: e.arrowEnd, arrowStart: e.arrowStart };
    if (e.from === e.to) {
      // Auto-anello: una staffa sul lato destro (o in basso se il flusso è orizzontale).
      const r = vertical
        ? [{ x: a.x + a.width, y: a.y + a.height * 0.3 }, { x: a.x + a.width + 26, y: a.y + a.height * 0.3 }, { x: a.x + a.width + 26, y: a.y + a.height * 0.7 }, { x: a.x + a.width, y: a.y + a.height * 0.7 }]
        : [{ x: a.x + a.width * 0.3, y: a.y + a.height }, { x: a.x + a.width * 0.3, y: a.y + a.height + 26 }, { x: a.x + a.width * 0.7, y: a.y + a.height + 26 }, { x: a.x + a.width * 0.7, y: a.y + a.height }];
      edges.push({ ...base, points: r, labelAt: e.label ? { x: vertical ? r[1].x + 4 : (r[1].x + r[2].x) / 2, y: vertical ? (r[1].y + r[2].y) / 2 : r[1].y + 12 } : undefined });
      continue;
    }
    const rev = back.has(`${e.from}>${e.to}`);
    const chain = chains.get(rev ? `${e.to}>${e.from}` : `${e.from}>${e.to}`) ?? [e.from, e.to];
    let keys = rev ? [...chain].reverse() : chain;
    const pts = keys.map(centre);
    pts[0] = clipToShape(a, pts[1]);
    pts[pts.length - 1] = clipToShape(b, pts[pts.length - 2]);
    edges.push({ ...base, points: pts, labelAt: e.label ? midpoint(pts) : undefined });
  }

  // Ritaglio al contenuto e margine.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (x: number, y: number) => {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  };
  for (const n of placed.values()) {
    grow(n.x, n.y);
    grow(n.x + n.width, n.y + n.height);
  }
  for (const e of edges) {
    for (const p of e.points) grow(p.x, p.y);
    if (e.labelAt && e.label) {
      const hw = textWidth(e.label) / 2 + 6;
      const hh = textHeight(e.label) / 2 + 3;
      grow(e.labelAt.x - hw, e.labelAt.y - hh);
      grow(e.labelAt.x + hw, e.labelAt.y + hh);
    }
  }
  const dx = MARGIN - minX;
  const dy = MARGIN - minY;
  const nodes = [...placed.values()].map((n) => ({ ...n, x: r2(n.x + dx), y: r2(n.y + dy) }));
  for (const e of edges) {
    e.points = e.points.map((p) => ({ x: r2(p.x + dx), y: r2(p.y + dy) }));
    if (e.labelAt) e.labelAt = { x: r2(e.labelAt.x + dx), y: r2(e.labelAt.y + dy) };
  }
  return { nodes, edges, width: r2(maxX - minX + 2 * MARGIN), height: r2(maxY - minY + 2 * MARGIN) };
}

const r2 = (v: number) => Math.round(v * 100) / 100 + 0;

/** Il punto a metà della lunghezza di una spezzata. */
function midpoint(pts: Pt[]): Pt {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  let left = total / 2;
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (left <= seg && seg > 0) {
      const t = left / seg;
      return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t };
    }
    left -= seg;
  }
  return pts[0];
}
