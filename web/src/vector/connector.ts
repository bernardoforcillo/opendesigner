import type { Bounds } from "../canvas/geometry";
import type { NodeLite, SubPathLite } from "../store/types";

// CONNECTORS: a vector node whose meta names the two nodes it joins. The path is DERIVED from where
// those nodes are (store/connectors.ts), so moving a box moves the arrow. This file is only geometry:
// from two boxes in one space to the subpaths of the line and its arrowheads.

export const META_CONNECTOR_FROM = "connector.from";
export const META_CONNECTOR_TO = "connector.to";
export const META_CONNECTOR_ROUTE = "connector.route";
export const META_CONNECTOR_HEAD = "connector.head";

export type ConnectorRoute = "straight" | "elbow";
export type ConnectorHead = "none" | "end" | "both";

export interface ConnectorSpec { from: string; to: string; route: ConnectorRoute; head: ConnectorHead }

/** What a connector node joins, or null when the node is not one. */
export function connectorOf(n: NodeLite): ConnectorSpec | null {
  if (n.kind !== "vector" || !n.meta) return null;
  const from = n.meta[META_CONNECTOR_FROM];
  const to = n.meta[META_CONNECTOR_TO];
  if (!from || !to || from === to) return null;
  const route: ConnectorRoute = n.meta[META_CONNECTOR_ROUTE] === "elbow" ? "elbow" : "straight";
  const h = n.meta[META_CONNECTOR_HEAD];
  const head: ConnectorHead = h === "none" || h === "both" ? h : "end";
  return { from, to, route, head };
}

interface P { x: number; y: number }
const anchor = (p: P) => ({ x: p.x, y: p.y, inX: 0, inY: 0, outX: 0, outY: 0 });
const centerOf = (b: Bounds): P => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

// Where the ray from the center of `b` toward `target` leaves the box.
function exitPoint(b: Bounds, target: P): P {
  const c = centerOf(b);
  const dx = target.x - c.x, dy = target.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const hw = b.width / 2, hh = b.height / 2;
  const tx = dx === 0 ? Infinity : hw / Math.abs(dx);
  const ty = dy === 0 ? Infinity : hh / Math.abs(dy);
  const t = Math.min(tx, ty);
  return { x: c.x + dx * t, y: c.y + dy * t };
}

/** The corners of the line, from the edge of `a` to the edge of `b`. */
export function connectorPoints(a: Bounds, b: Bounds, route: ConnectorRoute): P[] {
  const ca = centerOf(a), cb = centerOf(b);
  if (route === "straight") return [exitPoint(a, cb), exitPoint(b, ca)];
  const horizontal = Math.abs(cb.x - ca.x) - (a.width + b.width) / 2 >= Math.abs(cb.y - ca.y) - (a.height + b.height) / 2;
  if (horizontal) {
    const sx = cb.x >= ca.x ? a.x + a.width : a.x;
    const ex = cb.x >= ca.x ? b.x : b.x + b.width;
    const mx = (sx + ex) / 2;
    return dedupe([{ x: sx, y: ca.y }, { x: mx, y: ca.y }, { x: mx, y: cb.y }, { x: ex, y: cb.y }]);
  }
  const sy = cb.y >= ca.y ? a.y + a.height : a.y;
  const ey = cb.y >= ca.y ? b.y : b.y + b.height;
  const my = (sy + ey) / 2;
  return dedupe([{ x: ca.x, y: sy }, { x: ca.x, y: my }, { x: cb.x, y: my }, { x: cb.x, y: ey }]);
}

function dedupe(pts: P[]): P[] {
  return pts.filter((p, i) => i === 0 || p.x !== pts[i - 1].x || p.y !== pts[i - 1].y);
}

// An open V at `tip`, pointing along `from -> tip`.
function arrowHead(from: P, tip: P, size: number): SubPathLite | null {
  const dx = tip.x - from.x, dy = tip.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return null;
  const ux = dx / len, uy = dy / len;
  const cos = Math.cos(Math.PI / 7), sin = Math.sin(Math.PI / 7);
  const wing = (s: number): P => ({
    x: tip.x - size * (ux * cos - s * uy * sin),
    y: tip.y - size * (uy * cos + s * ux * sin),
  });
  return { anchors: [anchor(wing(1)), anchor(tip), anchor(wing(-1))], closed: false };
}

/** The subpaths of a connector between two boxes (all in the boxes' space): the line, then its heads. */
export function connectorSubpaths(a: Bounds, b: Bounds, spec: Pick<ConnectorSpec, "route" | "head">, strokeWeight: number): SubPathLite[] {
  const pts = connectorPoints(a, b, spec.route);
  if (pts.length < 2) return [];
  const out: SubPathLite[] = [{ anchors: pts.map(anchor), closed: false }];
  const size = 8 + strokeWeight * 2;
  if (spec.head !== "none") {
    const h = arrowHead(pts[pts.length - 2], pts[pts.length - 1], size);
    if (h) out.push(h);
  }
  if (spec.head === "both") {
    const h = arrowHead(pts[1], pts[0], size);
    if (h) out.push(h);
  }
  return out;
}
