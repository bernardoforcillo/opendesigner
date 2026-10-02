import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { makeSetPropsOp } from "../tools/ops";
import { toPbFills } from "../store/types";
import type { FillLite, GradientLite, NodeLite } from "../store/types";
import type { RgbLite } from "./fields/ColorField";

// Gli op del pannello gradienti. Come fillOps nel pannello, toccano SOLO la
// prima tinta del nodo: un nodo con più riempimenti non perde gli altri.
//
// Funzioni pure sul nodo (non leggono lo store): chi le chiama passa il lookup,
// così si provano senza montare niente.
export type NodeLookup = (id: string) => NodeLite | undefined;

export type FillKind = "solid" | "linear" | "radial";

export function fillKindOf(f: FillLite | null): FillKind {
  return f?.gradient?.kind ?? "solid";
}

// Asse di default: lineare dall'alto al basso, radiale dal centro al bordo.
function defaultGeometry(kind: "linear" | "radial") {
  return kind === "linear"
    ? { x1: 0.5, y1: 0, x2: 0.5, y2: 1 }
    : { x1: 0.5, y1: 0.5, x2: 1, y2: 0.5 };
}

// Dal colore piatto a un gradiente che VA dal colore a lui stesso trasparente:
// è un punto di partenza che si vede subito diverso, senza inventare un
// secondo colore che l'utente non ha scelto.
function toGradient(f: FillLite, kind: "linear" | "radial"): FillLite {
  const from = { r: f.r, g: f.g, b: f.b, a: f.a };
  const gradient: GradientLite = {
    kind,
    stops: [
      { color: from, position: 0 },
      { color: { ...from, a: 0 }, position: 1 },
    ],
    ...defaultGeometry(kind),
  };
  return { ...from, gradient };
}

function withFirst(n: NodeLite, first: FillLite): Op {
  return makeSetPropsOp(n.id, { fills: toPbFills([first, ...n.fills.slice(1)]) }, ["fills"]);
}

const BASE: FillLite = { r: 0.8, g: 0.8, b: 0.8, a: 1 };

/** Cambia il TIPO del riempimento. Tornare a "solid" tiene il primo stop. */
export function fillKindOps(ids: readonly string[], lookup: NodeLookup, kind: FillKind): Op[] {
  return ids.flatMap((id) => {
    const n = lookup(id);
    if (!n) return [];
    const cur = n.fills[0] ?? BASE;
    if (fillKindOf(cur) === kind) return [];
    if (kind === "solid") return [withFirst(n, { r: cur.r, g: cur.g, b: cur.b, a: cur.a })];
    // Da gradiente a gradiente cambia solo la forma: gli stop restano, la
    // geometria torna al default del nuovo tipo.
    if (cur.gradient) {
      const gradient: GradientLite = { ...cur.gradient, kind, ...defaultGeometry(kind) };
      return [withFirst(n, { ...cur, gradient })];
    }
    return [withFirst(n, toGradient(cur, kind))];
  });
}

/** Colore (senza alfa) di uno stop, che mantiene la PROPRIA alfa. */
export function gradientStopOps(ids: readonly string[], lookup: NodeLookup, index: number, rgb: RgbLite): Op[] {
  return ids.flatMap((id) => {
    const n = lookup(id);
    const cur = n?.fills[0];
    const g = cur?.gradient;
    if (!n || !cur || !g || index < 0 || index >= g.stops.length) return [];
    const stops = g.stops.map((st, i) => (i === index ? { ...st, color: { ...rgb, a: st.color.a } } : st));
    const first = stops[0].color;
    return [withFirst(n, { r: first.r, g: first.g, b: first.b, a: first.a, gradient: { ...g, stops } })];
  });
}

/** Angolo (gradi, 0 = da sinistra a destra, 90 = dall'alto al basso) di un lineare. */
export function gradientAngleOf(f: FillLite | null): number {
  const g = f?.gradient;
  if (!g || g.kind !== "linear") return 0;
  const deg = (Math.atan2(g.y2 - g.y1, g.x2 - g.x1) * 180) / Math.PI;
  return Math.round(((deg % 360) + 360) % 360 * 100) / 100;
}

export function gradientAngleOps(ids: readonly string[], lookup: NodeLookup, degrees: number): Op[] {
  const rad = (degrees * Math.PI) / 180;
  const dx = Math.cos(rad) / 2, dy = Math.sin(rad) / 2;
  return ids.flatMap((id) => {
    const n = lookup(id);
    const cur = n?.fills[0];
    const g = cur?.gradient;
    if (!n || !cur || !g || g.kind !== "linear") return [];
    const gradient: GradientLite = { ...g, x1: 0.5 - dx, y1: 0.5 - dy, x2: 0.5 + dx, y2: 0.5 + dy };
    return [withFirst(n, { ...cur, gradient })];
  });
}
