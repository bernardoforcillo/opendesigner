import type { NodeLite } from "../store/types";

// THE OUTLINES OF THE PARAMETRIC SHAPES (docs/shapes.md): polygon, star, ellipse arc / ring, and a rectangle
// with corner smoothing or independent radii. One implementation of the geometry, as plain path commands
// in WORLD coordinates (the node's box at its x/y, unrotated -- rotation is a context transform, as for
// every other shape), so the 2D canvas (Path2D), the GPU renderer (CanvasKit paths), the SVG export and
// the boolean operations all draw and hit the SAME outline. A plain rectangle or ellipse is NOT here:
// `outlineCommands` returns null for them and each renderer keeps its native fast path.

export type PathCmd =
  | readonly ["M", number, number]
  | readonly ["L", number, number]
  | readonly ["C", number, number, number, number, number, number]
  | readonly ["Z"];

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

/** True when the node's outline is one of the computed ones (not the plain box or ellipse). */
export function hasComputedOutline(n: NodeLite): boolean {
  return n.kind === "polygon" || n.kind === "star" || (n.kind === "ellipse" && isArc(n)) || (n.kind === "rect" && isCustomRect(n));
}

/** An ellipse that is not the plain full one: a partial sweep and/or a ring. */
export function isArc(n: Pick<NodeLite, "arcSweep" | "innerRatio">): boolean {
  return fullSweep(n.arcSweep ?? 0) === false || (n.innerRatio ?? 0) > 0;
}

/** A rectangle with smoothed corners or its own radii for each corner. */
export function isCustomRect(n: Pick<NodeLite, "cornerSmoothing" | "radii">): boolean {
  return (n.cornerSmoothing ?? 0) > 0 || n.radii !== undefined;
}

const fullSweep = (sweep: number) => sweep === 0 || Math.abs(sweep) >= 360;

/** The outline as path commands, or null for a plain rectangle / ellipse / anything else. */
export function outlineCommands(n: NodeLite): PathCmd[] | null {
  switch (n.kind) {
    case "polygon": return polygonCommands(n, Math.max(3, Math.round(n.sides ?? 3)));
    case "star": return starCommands(n, Math.max(3, Math.round(n.points ?? 5)), n.innerRatio ?? 0.5);
    case "ellipse": return isArc(n) ? arcCommands(n) : null;
    case "rect": return isCustomRect(n) ? roundedRectCommands(n) : null;
    default: return null;
  }
}

// --- polygon and star ----------------------------------------------------------

const vertex = (n: NodeLite, angle: number, k: number): [number, number] => [
  n.x + n.width / 2 + (n.width / 2) * k * Math.cos(angle),
  n.y + n.height / 2 + (n.height / 2) * k * Math.sin(angle),
];

/** The vertices of a regular polygon inscribed in the box's ellipse, the first at the top. */
export function polygonVertices(n: NodeLite, sides: number): [number, number][] {
  return Array.from({ length: sides }, (_, i) => vertex(n, -Math.PI / 2 + (i * TAU) / sides, 1));
}

/** 2 x points vertices alternating outer (the box's ellipse) and inner (`ratio` of it), the first outer one at the top. */
export function starVertices(n: NodeLite, points: number, ratio: number): [number, number][] {
  return Array.from({ length: points * 2 }, (_, i) => vertex(n, -Math.PI / 2 + (i * Math.PI) / points, i % 2 === 0 ? 1 : ratio));
}

function closedPolyline(pts: [number, number][]): PathCmd[] {
  return [["M", pts[0][0], pts[0][1]], ...pts.slice(1).map((p) => ["L", p[0], p[1]] as const), ["Z"]];
}

const polygonCommands = (n: NodeLite, sides: number) => closedPolyline(polygonVertices(n, sides));
const starCommands = (n: NodeLite, points: number, ratio: number) => closedPolyline(starVertices(n, points, ratio));

// --- ellipse arc and ring -------------------------------------------------------

// Cubic segments for the elliptical arc from parametric angle a0 to a1 (radians), at most 90 degrees each.
function arcSegments(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number): PathCmd[] {
  const out: PathCmd[] = [];
  const count = Math.max(1, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 2) - 1e-9));
  const step = (a1 - a0) / count;
  const k = (4 / 3) * Math.tan(step / 4);
  for (let i = 0; i < count; i++) {
    const s = a0 + i * step, e = s + step;
    const cs = Math.cos(s), sn = Math.sin(s), ce = Math.cos(e), se = Math.sin(e);
    out.push(["C",
      cx + rx * (cs - k * sn), cy + ry * (sn + k * cs),
      cx + rx * (ce + k * se), cy + ry * (se - k * ce),
      cx + rx * ce, cy + ry * se]);
  }
  return out;
}

/** An arc / pie / ring of the ellipse inscribed in the box. Angles are parametric, in degrees, clockwise from +x. */
export function arcCommands(n: NodeLite): PathCmd[] {
  const cx = n.x + n.width / 2, cy = n.y + n.height / 2;
  const rx = n.width / 2, ry = n.height / 2;
  const ratio = Math.min(0.99, Math.max(0, n.innerRatio ?? 0));
  const full = fullSweep(n.arcSweep ?? 0);
  const a0 = (n.arcStart ?? 0) * DEG;
  const a1 = a0 + (full ? TAU : (n.arcSweep as number) * DEG);
  const at = (a: number, k: number): [number, number] => [cx + rx * k * Math.cos(a), cy + ry * k * Math.sin(a)];
  const cmds: PathCmd[] = [];
  const [sx, sy] = at(a0, 1);
  if (full) {
    // A ring: the outer circle one way, the hole the other, so any fill rule leaves it empty.
    cmds.push(["M", sx, sy], ...arcSegments(cx, cy, rx, ry, a0, a1), ["Z"]);
    const [ix, iy] = at(a0, ratio);
    cmds.push(["M", ix, iy], ...arcSegments(cx, cy, rx * ratio, ry * ratio, a0, a0 - TAU), ["Z"]);
    return cmds;
  }
  cmds.push(["M", sx, sy], ...arcSegments(cx, cy, rx, ry, a0, a1));
  if (ratio > 0) {
    const [ex, ey] = at(a1, ratio);
    cmds.push(["L", ex, ey], ...arcSegments(cx, cy, rx * ratio, ry * ratio, a1, a0), ["Z"]);
  } else {
    cmds.push(["L", cx, cy], ["Z"]); // a pie slice
  }
  return cmds;
}

// --- rectangle: independent radii and corner smoothing --------------------------

/** The four radii [tl, tr, br, bl], clamped so that neighbours fit along each side (the CSS rule). */
export function clampedRadii(n: Pick<NodeLite, "width" | "height" | "cornerRadius" | "radii">): [number, number, number, number] {
  const r = n.radii
    ? [n.radii.topLeft, n.radii.topRight, n.radii.bottomRight, n.radii.bottomLeft].map((v) => Math.max(0, v))
    : [n.cornerRadius, n.cornerRadius, n.cornerRadius, n.cornerRadius].map((v) => Math.max(0, v));
  const w = Math.max(0, n.width), h = Math.max(0, n.height);
  const pairs: [number, number, number][] = [[r[0] + r[1], w, 0], [r[1] + r[2], h, 0], [r[2] + r[3], w, 0], [r[3] + r[0], h, 0]];
  let f = 1;
  for (const [sum, side] of pairs) if (sum > side && sum > 0) f = Math.min(f, side / sum);
  return [r[0] * f, r[1] * f, r[2] * f, r[3] * f];
}

// One corner in its own frame: the vertex at (0,0), the top edge arriving along -x and the right edge leaving
// along +y (a top-right corner). `p` is how far the curve reaches along each edge; smoothing s in 0..1 stretches
// it past the circular arc (p = r at s = 0) and blends it into the straight edges with two cubic transitions
// around a shortened circular arc (the construction behind iOS-style "continuous" corners).
function cornerLocal(r: number, s: number, budget: number): { p: number; segs: PathCmd[] } {
  let smooth = s;
  let p = (1 + smooth) * r;
  // The plain radius always fits (the radii are clamped to their sides); smoothing only gets what is left.
  const room = Math.max(r, budget);
  if (p > room) {
    // Not enough room along the edge: spend it on smoothing first, then keep the radius.
    smooth = Math.max(0, room / r - 1);
    p = Math.min(p, room);
  }
  const arcMeasure = 90 * (1 - smooth);
  const arcLen = Math.sin((arcMeasure / 2) * DEG) * r * Math.SQRT2;
  const alpha = (90 - arcMeasure) / 2;
  const p3p4 = r * Math.tan((alpha / 2) * DEG);
  const beta = 45 * smooth;
  const c = p3p4 * Math.cos(beta * DEG);
  const d = c * Math.tan(beta * DEG);
  const b = (p - arcLen - c - d) / 3;
  const a = 2 * b;
  const P0: [number, number] = [-p, 0];
  const P1: [number, number] = [P0[0] + a + b + c, d];
  const P2: [number, number] = [P1[0] + arcLen, P1[1] + arcLen];
  const end: [number, number] = [P2[0] + d, P2[1] + a + b + c];
  // The circular arc between P1 and P2 as one cubic (it spans at most 90 degrees).
  const phi = arcMeasure * DEG;
  const L = (4 / 3) * Math.tan(phi / 4) * r;
  const t1: [number, number] = [Math.cos(beta * DEG), Math.sin(beta * DEG)];
  const t2: [number, number] = [Math.sin(beta * DEG), Math.cos(beta * DEG)];
  return {
    p,
    segs: [
      ["C", P0[0] + a, 0, P0[0] + a + b, 0, P1[0], P1[1]],
      ["C", P1[0] + L * t1[0], P1[1] + L * t1[1], P2[0] - L * t2[0], P2[1] - L * t2[1], P2[0], P2[1]],
      ["C", P2[0] + d, P2[1] + c, P2[0] + d, P2[1] + b + c, end[0], end[1]],
    ],
  };
}

/** A rectangle outline with independent corner radii and/or corner smoothing, in world coordinates. */
export function roundedRectCommands(n: NodeLite): PathCmd[] {
  const { x, y, width: w, height: h } = n;
  const s = Math.min(1, Math.max(0, n.cornerSmoothing ?? 0));
  const [tl, tr, br, bl] = clampedRadii(n);
  const budget = Math.min(w, h) / 2;
  // corner vertex, the radius, and the rotation that takes the top-right frame to this corner.
  const corners: { vx: number; vy: number; r: number; rot: 0 | 1 | 2 | 3 }[] = [
    { vx: x + w, vy: y, r: tr, rot: 0 },
    { vx: x + w, vy: y + h, r: br, rot: 1 },
    { vx: x, vy: y + h, r: bl, rot: 2 },
    { vx: x, vy: y, r: tl, rot: 3 },
  ];
  const place = (rot: number, lx: number, ly: number, vx: number, vy: number): [number, number] => {
    switch (rot) {
      case 0: return [vx + lx, vy + ly];
      case 1: return [vx - ly, vy + lx];
      case 2: return [vx - lx, vy - ly];
      default: return [vx + ly, vy - lx];
    }
  };
  const out: PathCmd[] = [];
  corners.forEach((cn, i) => {
    if (!(cn.r > 0)) {
      const [px, py] = place(cn.rot, 0, 0, cn.vx, cn.vy);
      out.push(i === 0 ? ["M", px, py] : ["L", px, py]);
      return;
    }
    const { p, segs } = cornerLocal(cn.r, s, budget);
    const [sx, sy] = place(cn.rot, -p, 0, cn.vx, cn.vy);
    out.push(i === 0 ? ["M", sx, sy] : ["L", sx, sy]);
    for (const seg of segs) {
      if (seg[0] !== "C") continue;
      const [x1, y1] = place(cn.rot, seg[1], seg[2], cn.vx, cn.vy);
      const [x2, y2] = place(cn.rot, seg[3], seg[4], cn.vx, cn.vy);
      const [x3, y3] = place(cn.rot, seg[5], seg[6], cn.vx, cn.vy);
      out.push(["C", x1, y1, x2, y2, x3, y3]);
    }
  });
  out.push(["Z"]);
  return out;
}

// --- consumers' helpers ---------------------------------------------------------

/** The commands as an SVG path `d` string (numbers rounded to `decimals`). */
export function commandsToD(cmds: readonly PathCmd[], decimals = 3): string {
  const f = (v: number) => String(Number(v.toFixed(decimals)));
  return cmds.map((c) => (c[0] === "Z" ? "Z" : `${c[0]}${c.slice(1).map((v) => f(v as number)).join(" ")}`)).join("");
}

/** Traces the commands on anything shaped like a Path2D. */
export function traceCommands(
  p: Pick<Path2D, "moveTo" | "lineTo" | "bezierCurveTo" | "closePath">, cmds: readonly PathCmd[],
): void {
  for (const c of cmds) {
    if (c[0] === "M") p.moveTo(c[1], c[2]);
    else if (c[0] === "L") p.lineTo(c[1], c[2]);
    else if (c[0] === "C") p.bezierCurveTo(c[1], c[2], c[3], c[4], c[5], c[6]);
    else p.closePath();
  }
}

/** The commands as polylines (one ring per M..Z), curves flattened into `steps` segments. For hit-tests and booleans. */
export function flattenCommands(cmds: readonly PathCmd[], steps = 12): [number, number][][] {
  const rings: [number, number][][] = [];
  let cur: [number, number][] = [];
  let at: [number, number] = [0, 0];
  for (const c of cmds) {
    if (c[0] === "M") {
      if (cur.length) rings.push(cur);
      at = [c[1], c[2]];
      cur = [at];
    } else if (c[0] === "L") {
      at = [c[1], c[2]];
      cur.push(at);
    } else if (c[0] === "C") {
      const [x0, y0] = at;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps, u = 1 - t;
        cur.push([
          u * u * u * x0 + 3 * u * u * t * c[1] + 3 * u * t * t * c[3] + t * t * t * c[5],
          u * u * u * y0 + 3 * u * u * t * c[2] + 3 * u * t * t * c[4] + t * t * t * c[6],
        ]);
      }
      at = [c[5], c[6]];
    }
  }
  if (cur.length) rings.push(cur);
  return rings;
}

/** Even-odd point-in-rings test (the rule the shapes are filled with). */
export function pointInRings(rings: readonly (readonly [number, number][])[], x: number, y: number): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}
