import { describe, it, expect } from "vitest";
import { arcToCubics, cmdsToSubPaths, parsePathData, subPathsToD, transformCmds, type PathCmd } from "./pathData";

// A shorthand for reading commands in tests: "M0,0 L10,-5" -> ["M0,0","L10,-5"].
function show(cmds: readonly PathCmd[]): string[] {
  const f = (v: number) => String(Math.round(v * 1e6) / 1e6);
  return cmds.map((c) => {
    if (c.t === "Z") return "Z";
    if (c.t === "C") return `C${f(c.x1)},${f(c.y1)} ${f(c.x2)},${f(c.y2)} ${f(c.x)},${f(c.y)}`;
    return `${c.t}${f(c.x)},${f(c.y)}`;
  });
}

function cubicAt(p: number[], t: number): [number, number] {
  const u = 1 - t;
  const x = u * u * u * p[0] + 3 * u * u * t * p[2] + 3 * u * t * t * p[4] + t * t * t * p[6];
  const y = u * u * u * p[1] + 3 * u * u * t * p[3] + 3 * u * t * t * p[5] + t * t * t * p[7];
  return [x, y];
}

describe("parsePathData: syntax", () => {
  it("coordinate attaccate al segno: M0,0L10-5", () => {
    const r = parsePathData("M0,0L10-5");
    expect(r.error).toBe(false);
    expect(show(r.cmds)).toEqual(["M0,0", "L10,-5"]);
  });

  it("numbers with exponent and dots that open a new number", () => {
    expect(show(parsePathData("M0 0L1e-3 2").cmds)).toEqual(["M0,0", "L0.001,2"]);
    expect(show(parsePathData("M0 0L1E2,3").cmds)).toEqual(["M0,0", "L100,3"]);
    // ".5.5" are TWO numbers
    expect(show(parsePathData("M0 0L.5.5").cmds)).toEqual(["M0,0", "L0.5,0.5"]);
    expect(show(parsePathData("M1.5.5").cmds)).toEqual(["M1.5,0.5"]);
    // "1e" without digits is not an exponent: the number is 1 and then an invalid 'e' arrives
    expect(parsePathData("M1e").error).toBe(true);
  });

  it("mixed separators: commas, spaces, newlines, tabs", () => {
    expect(show(parsePathData("M 1,2\n\tL3 , 4").cmds)).toEqual(["M1,2", "L3,4"]);
    expect(show(parsePathData("  M1 2 ,L 3,4  ").cmds)).toEqual(["M1,2", "L3,4"]);
  });

  it("implicit repetition: after M the pairs are L, after m they are l", () => {
    expect(show(parsePathData("M10 10 20 20 30 10").cmds)).toEqual(["M10,10", "L20,20", "L30,10"]);
    expect(show(parsePathData("m10 10 20 20 -5 5").cmds)).toEqual(["M10,10", "L30,30", "L25,35"]);
    expect(show(parsePathData("M0 0 L1 1 2 2 3 3").cmds)).toEqual(["M0,0", "L1,1", "L2,2", "L3,3"]);
    expect(show(parsePathData("M0 0 C1 1 2 2 3 3 4 4 5 5 6 6").cmds).length).toBe(3);
  });

  it("H, V e relativi", () => {
    expect(show(parsePathData("M10 10 H30 V40 h-5 v-5").cmds)).toEqual(["M10,10", "L30,10", "L30,40", "L25,40", "L25,35"]);
    expect(show(parsePathData("M10 10 H20 30").cmds)).toEqual(["M10,10", "L20,10", "L30,10"]);
  });

  it("C assoluta e relativa", () => {
    expect(show(parsePathData("M0 0 C10 0 20 10 30 10").cmds)[1]).toBe("C10,0 20,10 30,10");
    expect(show(parsePathData("M5 5 c10 0 20 10 30 10").cmds)[1]).toBe("C15,5 25,15 35,15");
  });

  it("S reflects the previous second control; without a preceding C the control is the current point", () => {
    const r = show(parsePathData("M0 0 C0 10 10 20 20 20 S40 10 40 0").cmds);
    // reflection of (10,20) around (20,20) = (30,20)
    expect(r[2]).toBe("C30,20 40,10 40,0");
    expect(show(parsePathData("M0 0 S10 10 20 0").cmds)[1]).toBe("C0,0 10,10 20,0");
    // after an L the reflection does NOT apply
    expect(show(parsePathData("M0 0 L5 5 S10 10 20 0").cmds)[2]).toBe("C5,5 10,10 20,0");
  });

  it("Q becomes a cubic with controls at 2/3; T reflects", () => {
    const q = parsePathData("M0 0 Q30 30 60 0").cmds[1] as Extract<PathCmd, { t: "C" }>;
    expect([q.x1, q.y1, q.x2, q.y2, q.x, q.y]).toEqual([20, 20, 40, 20, 60, 0]);
    const t = parsePathData("M0 0 Q30 30 60 0 T120 0").cmds[2] as Extract<PathCmd, { t: "C" }>;
    // reflected quadratic control: (90,-30) -> cubic 60+2/3*(90-60)=80, -20
    expect([t.x1, t.y1, t.x2, t.y2, t.x, t.y]).toEqual([80, -20, 100, -20, 120, 0]);
  });

  it("Z returns to the starting point and a following command opens a subpath from there", () => {
    expect(show(parsePathData("M10 10 L20 10 L20 20 Z L30 30").cmds)).toEqual([
      "M10,10", "L20,10", "L20,20", "Z", "M10,10", "L30,30",
    ]);
    expect(show(parsePathData("M10 10 L20 10 z m5 5 l1 1").cmds)).toEqual([
      "M10,10", "L20,10", "Z", "M15,15", "L16,16",
    ]);
  });

  it("lowercase/uppercase do not contaminate each other: absolute l after relative l", () => {
    expect(show(parsePathData("M0 0 l10 10 L5 5").cmds)).toEqual(["M0,0", "L10,10", "L5,5"]);
  });
});

describe("parsePathData: errors (drawn up to the error, without throwing)", () => {
  it("missing arguments", () => {
    const r = parsePathData("M0 0 L10");
    expect(r.error).toBe(true);
    expect(show(r.cmds)).toEqual(["M0,0"]);
  });
  it("does not start with M", () => {
    expect(parsePathData("L10 10")).toEqual({ cmds: [], error: true });
    expect(parsePathData("10 10")).toEqual({ cmds: [], error: true });
  });
  it("comando sconosciuto", () => {
    const r = parsePathData("M0 0 L5 5 X1 1 L9 9");
    expect(r.error).toBe(true);
    expect(show(r.cmds)).toEqual(["M0,0", "L5,5"]);
  });
  it("empty or only spaces", () => {
    expect(parsePathData("")).toEqual({ cmds: [], error: false });
    expect(parsePathData("   ")).toEqual({ cmds: [], error: false });
  });
  it("numbers after Z without a command", () => {
    const r = parsePathData("M0 0 L1 1 Z 5 5");
    expect(r.error).toBe(true);
  });
  it("an enormous d is truncated by the command cap", () => {
    const r = parsePathData("M0 0" + " L1 1".repeat(50), 10);
    expect(r.error).toBe(true);
    expect(r.cmds.length).toBe(10);
  });
  it("Infinity / NaN are rejected", () => {
    expect(parsePathData("M0 0 L1e999 5").error).toBe(true);
  });
});

describe("arcs", () => {
  it("a quarter circle: exact endpoints, controls at the Bézier distance (k=0.5523)", () => {
    const [s] = arcToCubics(10, 0, 10, 10, 0, 0, 1, 0, 10);
    expect(s[4]).toBe(0);
    expect(s[5]).toBe(10);
    const k = (4 / 3) * Math.tan(Math.PI / 8);
    expect(s[0]).toBeCloseTo(10, 9);
    expect(s[1]).toBeCloseTo(10 * k, 9);
    expect(s[2]).toBeCloseTo(10 * k, 9);
    expect(s[3]).toBeCloseTo(10, 9);
  });

  it("the cubic's points lie on the circle within 0.03% of the radius", () => {
    for (const [large, sweep] of [[0, 0], [0, 1], [1, 0], [1, 1]] as const) {
      const segs = arcToCubics(50, 10, 40, 40, 0, large, sweep, 90, 50);
      // circle center: derived from the problem's symmetry
      let cx = 0, cy = 0;
      // the two possible centers are (50,50) and (90,10)
      const cands = [[50, 50], [90, 10]];
      let best = Infinity;
      for (const [px, py] of cands) {
        let worst = 0;
        let prev = [50, 10];
        for (const s of segs) {
          const seg = [prev[0], prev[1], ...s];
          for (let t = 0; t <= 1; t += 0.05) {
            const [x, y] = cubicAt(seg, t);
            worst = Math.max(worst, Math.abs(Math.hypot(x - px, y - py) - 40));
          }
          prev = [s[4], s[5]];
        }
        if (worst < best) { best = worst; cx = px; cy = py; }
      }
      expect(best / 40).toBeLessThan(3e-4);
      expect([cx, cy].length).toBe(2);
      // large/small and direction really choose the arc: the endpoints are exact
      expect(segs[segs.length - 1].slice(4)).toEqual([90, 50]);
      // a large arc (>180°) requires more than two 90° segments
      if (large) expect(segs.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("large-arc and sweep choose different arcs (4 combinations, 4 different midpoints)", () => {
    const mids = new Set<string>();
    for (const large of [0, 1]) for (const sweep of [0, 1]) {
      const segs = arcToCubics(0, 0, 10, 10, 0, large, sweep, 10, 10);
      // the path's midpoint (t=1 of the middle segment)
      const half = segs[Math.floor((segs.length - 1) / 2)];
      mids.add(`${Math.round(half[4])},${Math.round(half[5])}`);
    }
    expect(mids.size).toBeGreaterThanOrEqual(2);
  });

  it("null radius = line; coincident endpoints = nothing", () => {
    expect(arcToCubics(0, 0, 0, 5, 0, 0, 1, 10, 10)).toEqual([[0, 0, 10, 10, 10, 10]]);
    expect(arcToCubics(5, 5, 3, 3, 0, 0, 1, 5, 5)).toEqual([]);
  });

  it("radii too small are scaled: it becomes a semicircle between the endpoints", () => {
    const segs = arcToCubics(0, 0, 1, 1, 0, 0, 1, 20, 0);
    expect(segs.length).toBe(2);
    // the midpoint is at distance 10 from the center (10,0) and therefore at y=±10
    expect(Math.abs(segs[0][5])).toBeCloseTo(10, 6);
  });

  it("rotated ellipse: the points satisfy the ellipse equation", () => {
    // ellipse rx=30 ry=10 rotated by 30°, from (0,0) to a point that lies on the ellipse
    const phi = (30 * Math.PI) / 180;
    const pt = (th: number) => [
      50 + 30 * Math.cos(th) * Math.cos(phi) - 10 * Math.sin(th) * Math.sin(phi),
      50 + 30 * Math.cos(th) * Math.sin(phi) + 10 * Math.sin(th) * Math.cos(phi),
    ];
    const a = pt(0.3), b = pt(2.2);
    const segs = arcToCubics(a[0], a[1], 30, 10, 30, 0, 1, b[0], b[1]);
    let prev = a;
    for (const s of segs) {
      for (let t = 0; t <= 1; t += 0.1) {
        const [x, y] = cubicAt([prev[0], prev[1], ...s], t);
        const dx = x - 50, dy = y - 50;
        const u = dx * Math.cos(phi) + dy * Math.sin(phi);
        const v = -dx * Math.sin(phi) + dy * Math.cos(phi);
        expect(Math.abs((u * u) / 900 + (v * v) / 100 - 1)).toBeLessThan(2e-3);
      }
      prev = [s[4], s[5]];
    }
  });

  it("in d: flags attached to numbers (a1 1 0 00.5.5) and relative arcs", () => {
    const r = parsePathData("M0 0 a1 1 0 00.5.5");
    expect(r.error).toBe(false);
    const last = r.cmds[r.cmds.length - 1] as Extract<PathCmd, { t: "C" }>;
    expect([last.x, last.y]).toEqual([0.5, 0.5]);
    const rel = parsePathData("M10 10 a5 5 0 0 1 10 0").cmds;
    const e = rel[rel.length - 1] as Extract<PathCmd, { t: "C" }>;
    expect([e.x, e.y]).toEqual([20, 10]);
    // invalid flags (2) = error
    expect(parsePathData("M0 0 a1 1 0 2 1 5 5").error).toBe(true);
  });

  it("full circle with two arcs: 4 cubics and return to the starting point", () => {
    const r = parsePathData("M10 0 A10 10 0 1 1 -10 0 A10 10 0 1 1 10 0 Z");
    expect(r.cmds.filter((c) => c.t === "C").length).toBe(4);
    const subs = cmdsToSubPaths(r.cmds);
    // closed and without a duplicate anchor: 4 anchors
    expect(subs[0].closed).toBe(true);
    expect(subs[0].anchors.length).toBe(4);
  });
});

describe("cmdsToSubPaths: the model's convention (RELATIVE handles)", () => {
  it("a line has null handles", () => {
    const [sp] = cmdsToSubPaths(parsePathData("M0 0 L10 10").cmds);
    expect(sp.closed).toBe(false);
    expect(sp.anchors).toEqual([
      { x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 },
      { x: 10, y: 10, inX: 0, inY: 0, outX: 0, outY: 0 },
    ]);
  });

  it("a cubic: out of the first = c1 - p0, in of the second = c2 - p1", () => {
    const [sp] = cmdsToSubPaths(parsePathData("M0 0 C10 0 20 10 30 10").cmds);
    expect(sp.anchors[0]).toEqual({ x: 0, y: 0, inX: 0, inY: 0, outX: 10, outY: 0 });
    expect(sp.anchors[1]).toEqual({ x: 30, y: 10, inX: -10, inY: 0, outX: 0, outY: 0 });
  });

  it("closing with a line: the last anchor does not coincide with the first and closed=true", () => {
    const [sp] = cmdsToSubPaths(parsePathData("M0 0 L10 0 L10 10 Z").cmds);
    expect(sp.closed).toBe(true);
    expect(sp.anchors.length).toBe(3);
  });

  it("explicit return to the starting point: merged anchor, the incoming handle goes to the first", () => {
    const [sp] = cmdsToSubPaths(parsePathData("M0 0 L10 0 L10 10 C5 10 0 5 0 0 Z").cmds);
    expect(sp.closed).toBe(true);
    expect(sp.anchors.length).toBe(3);
    // the last C arrives at (0,0) with c2=(0,5): in = (0,5)
    expect(sp.anchors[0]).toEqual({ x: 0, y: 0, inX: 0, inY: 5, outX: 0, outY: 0 });
    // and the outgoing of (10,10) is c1-p = (-5,0)
    expect(sp.anchors[2]).toMatchObject({ x: 10, y: 10, outX: -5, outY: 0 });
  });

  it("several subpaths, and an isolated M is discarded", () => {
    const subs = cmdsToSubPaths(parsePathData("M0 0 L5 5 M20 20 M30 30 L40 40 Z").cmds);
    expect(subs.length).toBe(2);
    expect(subs[0].closed).toBe(false);
    expect(subs[1].closed).toBe(true);
    expect(cmdsToSubPaths(parsePathData("M5 5").cmds)).toEqual([]);
    expect(cmdsToSubPaths(parsePathData("M5 5 Z").cmds)).toEqual([]);
  });

  it("round trip subPathsToD -> parsePathData -> cmdsToSubPaths", () => {
    const d = "M10 10 C20 0 30 20 40 10 L40 30 Q30 40 20 30 Z M60 60 L70 70";
    const a = cmdsToSubPaths(parsePathData(d).cmds);
    const b = cmdsToSubPaths(parsePathData(subPathsToD(a)).cmds);
    // subPathsToD writes 4 decimals: the comparison is at the same precision
    expect(subPathsToD(b)).toBe(subPathsToD(a));
    expect(b.map((s) => [s.closed, s.anchors.length])).toEqual(a.map((s) => [s.closed, s.anchors.length]));
    b[0].anchors.forEach((p, i) => {
      for (const k of ["x", "y", "inX", "inY", "outX", "outY"] as const) expect(p[k]).toBeCloseTo(a[0].anchors[i][k], 3);
    });
  });
});

describe("transformCmds", () => {
  it("applies the matrix to points and controls", () => {
    const cmds = parsePathData("M0 0 C1 0 2 1 3 1").cmds;
    const out = transformCmds(cmds, { a: 2, b: 0, c: 0, d: 3, e: 10, f: 20 });
    expect(show(out)).toEqual(["M10,20", "C12,20 14,23 16,23"]);
  });
});
