import type { ArrowHeadLite, NodeLite } from "@/store/types";
import { anchorPoint, inHandlePoint, outHandlePoint } from "@/store/vectorGeometry";
import type { PathCmd } from "@/renderer/shapeGeometry";

// ARROWHEADS at the ends of an open path (docs/shapes.md). The head's TIP sits on the path's end point and
// the body extends back along the path, so it never overhangs the node's box (a bounds-neutral decoration);
// its size follows the stroke weight. One geometry for the 2D canvas, the GPU renderer and the SVG export:
// `filled` shapes are filled with the stroke's paint, the `open` path (the arrow's V) is stroked with it.

export interface ArrowGeometry { filled: PathCmd[]; open: PathCmd[] }

/** The head's length for a stroke weight (a hairline still gets a visible head). */
export function headSize(weight: number): number {
  return Math.max(8, weight * 4);
}

type V = { x: number; y: number };

/**
 * The head at `tip`, where `out` is the unit vector pointing away from the path's body (the direction the
 * path was travelling when it reached this end).
 */
export function arrowHead(kind: ArrowHeadLite, tip: V, out: V, weight: number): ArrowGeometry {
  const s = headSize(weight);
  const v = { x: -out.y, y: out.x };
  const at = (back: number, side: number): [number, number] => [tip.x - out.x * back + v.x * side, tip.y - out.y * back + v.y * side];
  const poly = (pts: [number, number][]): PathCmd[] => [["M", pts[0][0], pts[0][1]], ...pts.slice(1).map((p) => ["L", p[0], p[1]] as const), ["Z"]];
  switch (kind) {
    case "triangle": return { filled: poly([at(0, 0), at(s, s * 0.45), at(s, -s * 0.45)]), open: [] };
    case "arrow": return { filled: [], open: [["M", ...at(s, s * 0.45)], ["L", ...at(0, 0)], ["L", ...at(s, -s * 0.45)]] };
    case "square": {
      const q = s * 0.7;
      return { filled: poly([at(0, q / 2), at(q, q / 2), at(q, -q / 2), at(0, -q / 2)]), open: [] };
    }
    case "diamond": {
      const r = s * 0.45;
      return { filled: poly([at(0, 0), at(r, r), at(r * 2, 0), at(r, -r)]), open: [] };
    }
    case "circle": {
      const r = s * 0.4, k = r * 0.5523;
      const cx = tip.x - out.x * r, cy = tip.y - out.y * r;
      // Four cubics around the center, in the (out, v) frame.
      const p = (a: number, b: number): [number, number] => [cx + out.x * a + v.x * b, cy + out.y * a + v.y * b];
      return {
        filled: [
          ["M", ...p(r, 0)],
          ["C", ...p(r, k), ...p(k, r), ...p(0, r)],
          ["C", ...p(-k, r), ...p(-r, k), ...p(-r, 0)],
          ["C", ...p(-r, -k), ...p(-k, -r), ...p(0, -r)],
          ["C", ...p(k, -r), ...p(r, -k), ...p(r, 0)],
          ["Z"],
        ],
        open: [],
      };
    }
  }
}

const unit = (dx: number, dy: number): V | null => {
  const len = Math.hypot(dx, dy);
  return len > 1e-9 ? { x: dx / len, y: dy / len } : null;
};

export interface ArrowEnds { start?: { tip: V; out: V }; end?: { tip: V; out: V } }

/**
 * Where the two heads of a vector go: the first anchor of its first OPEN subpath and the last anchor of its last
 * open subpath, with the direction the path leaves each of them (handles first, the neighbouring anchor as the
 * fallback). Closed subpaths have no ends.
 */
export function arrowEnds(n: NodeLite): ArrowEnds {
  const open = (n.vector?.subpaths ?? []).filter((sp) => !sp.closed && sp.anchors.length >= 2);
  const out: ArrowEnds = {};
  const first = open[0];
  if (first) {
    const a = first.anchors[0], b = first.anchors[1];
    const tip = anchorPoint(n, a);
    const toward = outHandlePoint(n, a);
    const dir = unit(tip.x - toward.x, tip.y - toward.y) ?? (() => { const q = anchorPoint(n, b); return unit(tip.x - q.x, tip.y - q.y); })();
    if (dir) out.start = { tip, out: dir };
  }
  const last = open[open.length - 1];
  if (last) {
    const a = last.anchors[last.anchors.length - 1], p = last.anchors[last.anchors.length - 2];
    const tip = anchorPoint(n, a);
    const from = inHandlePoint(n, a);
    const dir = unit(tip.x - from.x, tip.y - from.y) ?? (() => { const q = anchorPoint(n, p); return unit(tip.x - q.x, tip.y - q.y); })();
    if (dir) out.end = { tip, out: dir };
  }
  return out;
}

/** True when a vector has a stroke that asks for an arrowhead and an end to put it on. */
export function hasArrowheads(n: NodeLite): boolean {
  return n.kind === "vector" && n.strokes.some((s) => s.weight > 0 && (s.startCap || s.endCap));
}

/** The geometry of every head of a stroke on a vector (start, then end). */
export function strokeHeads(n: NodeLite, startCap: ArrowHeadLite | undefined, endCap: ArrowHeadLite | undefined, weight: number): ArrowGeometry[] {
  const ends = arrowEnds(n);
  const out: ArrowGeometry[] = [];
  if (startCap && ends.start) out.push(arrowHead(startCap, ends.start.tip, ends.start.out, weight));
  if (endCap && ends.end) out.push(arrowHead(endCap, ends.end.tip, ends.end.out, weight));
  return out;
}
