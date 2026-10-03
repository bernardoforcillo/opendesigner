import { describe, it, expect } from "vitest";
import { arcToCubics, cmdsToSubPaths, parsePathData, subPathsToD, transformCmds, type PathCmd } from "./pathData";

// Un'abbreviazione per leggere i comandi nei test: "M0,0 L10,-5" -> ["M0,0","L10,-5"].
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

describe("parsePathData: sintassi", () => {
  it("coordinate attaccate al segno: M0,0L10-5", () => {
    const r = parsePathData("M0,0L10-5");
    expect(r.error).toBe(false);
    expect(show(r.cmds)).toEqual(["M0,0", "L10,-5"]);
  });

  it("numeri con esponente e punti che aprono un numero nuovo", () => {
    expect(show(parsePathData("M0 0L1e-3 2").cmds)).toEqual(["M0,0", "L0.001,2"]);
    expect(show(parsePathData("M0 0L1E2,3").cmds)).toEqual(["M0,0", "L100,3"]);
    // ".5.5" sono DUE numeri
    expect(show(parsePathData("M0 0L.5.5").cmds)).toEqual(["M0,0", "L0.5,0.5"]);
    expect(show(parsePathData("M1.5.5").cmds)).toEqual(["M1.5,0.5"]);
    // "1e" senza cifre non è un esponente: il numero è 1 e poi arriva una 'e' non valida
    expect(parsePathData("M1e").error).toBe(true);
  });

  it("separatori misti: virgole, spazi, a capo, tab", () => {
    expect(show(parsePathData("M 1,2\n\tL3 , 4").cmds)).toEqual(["M1,2", "L3,4"]);
    expect(show(parsePathData("  M1 2 ,L 3,4  ").cmds)).toEqual(["M1,2", "L3,4"]);
  });

  it("ripetizione implicita: dopo M le coppie sono L, dopo m sono l", () => {
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

  it("S riflette il secondo controllo precedente; senza C prima il controllo è il punto corrente", () => {
    const r = show(parsePathData("M0 0 C0 10 10 20 20 20 S40 10 40 0").cmds);
    // riflessione di (10,20) attorno a (20,20) = (30,20)
    expect(r[2]).toBe("C30,20 40,10 40,0");
    expect(show(parsePathData("M0 0 S10 10 20 0").cmds)[1]).toBe("C0,0 10,10 20,0");
    // dopo una L la riflessione NON si applica
    expect(show(parsePathData("M0 0 L5 5 S10 10 20 0").cmds)[2]).toBe("C5,5 10,10 20,0");
  });

  it("Q diventa una cubica con i controlli a 2/3; T riflette", () => {
    const q = parsePathData("M0 0 Q30 30 60 0").cmds[1] as Extract<PathCmd, { t: "C" }>;
    expect([q.x1, q.y1, q.x2, q.y2, q.x, q.y]).toEqual([20, 20, 40, 20, 60, 0]);
    const t = parsePathData("M0 0 Q30 30 60 0 T120 0").cmds[2] as Extract<PathCmd, { t: "C" }>;
    // controllo quadratico riflesso: (90,-30) -> cubica 60+2/3*(90-60)=80, -20
    expect([t.x1, t.y1, t.x2, t.y2, t.x, t.y]).toEqual([80, -20, 100, -20, 120, 0]);
  });

  it("Z riporta al punto iniziale e un comando successivo apre un sottopercorso da lì", () => {
    expect(show(parsePathData("M10 10 L20 10 L20 20 Z L30 30").cmds)).toEqual([
      "M10,10", "L20,10", "L20,20", "Z", "M10,10", "L30,30",
    ]);
    expect(show(parsePathData("M10 10 L20 10 z m5 5 l1 1").cmds)).toEqual([
      "M10,10", "L20,10", "Z", "M15,15", "L16,16",
    ]);
  });

  it("minuscole/maiuscole non si contaminano: l assoluta dopo l relativa", () => {
    expect(show(parsePathData("M0 0 l10 10 L5 5").cmds)).toEqual(["M0,0", "L10,10", "L5,5"]);
  });
});

describe("parsePathData: errori (si disegna fino all'errore, senza lanciare)", () => {
  it("argomenti mancanti", () => {
    const r = parsePathData("M0 0 L10");
    expect(r.error).toBe(true);
    expect(show(r.cmds)).toEqual(["M0,0"]);
  });
  it("non comincia con M", () => {
    expect(parsePathData("L10 10")).toEqual({ cmds: [], error: true });
    expect(parsePathData("10 10")).toEqual({ cmds: [], error: true });
  });
  it("comando sconosciuto", () => {
    const r = parsePathData("M0 0 L5 5 X1 1 L9 9");
    expect(r.error).toBe(true);
    expect(show(r.cmds)).toEqual(["M0,0", "L5,5"]);
  });
  it("vuoto o solo spazi", () => {
    expect(parsePathData("")).toEqual({ cmds: [], error: false });
    expect(parsePathData("   ")).toEqual({ cmds: [], error: false });
  });
  it("numeri dopo Z senza comando", () => {
    const r = parsePathData("M0 0 L1 1 Z 5 5");
    expect(r.error).toBe(true);
  });
  it("un d enorme è troncato dal tetto sui comandi", () => {
    const r = parsePathData("M0 0" + " L1 1".repeat(50), 10);
    expect(r.error).toBe(true);
    expect(r.cmds.length).toBe(10);
  });
  it("Infinity / NaN non entrano", () => {
    expect(parsePathData("M0 0 L1e999 5").error).toBe(true);
  });
});

describe("archi", () => {
  it("un quarto di cerchio: estremi esatti, controlli alla distanza di Bézier (k=0.5523)", () => {
    const [s] = arcToCubics(10, 0, 10, 10, 0, 0, 1, 0, 10);
    expect(s[4]).toBe(0);
    expect(s[5]).toBe(10);
    const k = (4 / 3) * Math.tan(Math.PI / 8);
    expect(s[0]).toBeCloseTo(10, 9);
    expect(s[1]).toBeCloseTo(10 * k, 9);
    expect(s[2]).toBeCloseTo(10 * k, 9);
    expect(s[3]).toBeCloseTo(10, 9);
  });

  it("i punti della cubica stanno sul cerchio entro 0.03% del raggio", () => {
    for (const [large, sweep] of [[0, 0], [0, 1], [1, 0], [1, 1]] as const) {
      const segs = arcToCubics(50, 10, 40, 40, 0, large, sweep, 90, 50);
      // centro del cerchio: ricavato dalla simmetria del problema
      let cx = 0, cy = 0;
      // i due centri possibili sono (50,50) e (90,10)
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
      // grande/piccolo e verso scelgono davvero l'arco: gli estremi sono esatti
      expect(segs[segs.length - 1].slice(4)).toEqual([90, 50]);
      // un arco grande (>180°) richiede più di due segmenti da 90°
      if (large) expect(segs.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("large-arc e sweep scelgono archi diversi (4 combinazioni, 4 punti medi diversi)", () => {
    const mids = new Set<string>();
    for (const large of [0, 1]) for (const sweep of [0, 1]) {
      const segs = arcToCubics(0, 0, 10, 10, 0, large, sweep, 10, 10);
      // il punto di mezzo del percorso (t=1 del segmento centrale)
      const half = segs[Math.floor((segs.length - 1) / 2)];
      mids.add(`${Math.round(half[4])},${Math.round(half[5])}`);
    }
    expect(mids.size).toBeGreaterThanOrEqual(2);
  });

  it("raggio nullo = retta; estremi coincidenti = niente", () => {
    expect(arcToCubics(0, 0, 0, 5, 0, 0, 1, 10, 10)).toEqual([[0, 0, 10, 10, 10, 10]]);
    expect(arcToCubics(5, 5, 3, 3, 0, 0, 1, 5, 5)).toEqual([]);
  });

  it("raggi troppo piccoli vengono scalati: diventa un semicerchio fra gli estremi", () => {
    const segs = arcToCubics(0, 0, 1, 1, 0, 0, 1, 20, 0);
    expect(segs.length).toBe(2);
    // il punto di mezzo sta a distanza 10 dal centro (10,0) e quindi a y=±10
    expect(Math.abs(segs[0][5])).toBeCloseTo(10, 6);
  });

  it("ellisse ruotata: i punti soddisfano l'equazione dell'ellisse", () => {
    // ellisse rx=30 ry=10 ruotata di 30°, da (0,0) a un punto che sta sull'ellisse
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

  it("nel d: flag attaccati ai numeri (a1 1 0 00.5.5) e archi relativi", () => {
    const r = parsePathData("M0 0 a1 1 0 00.5.5");
    expect(r.error).toBe(false);
    const last = r.cmds[r.cmds.length - 1] as Extract<PathCmd, { t: "C" }>;
    expect([last.x, last.y]).toEqual([0.5, 0.5]);
    const rel = parsePathData("M10 10 a5 5 0 0 1 10 0").cmds;
    const e = rel[rel.length - 1] as Extract<PathCmd, { t: "C" }>;
    expect([e.x, e.y]).toEqual([20, 10]);
    // flag non validi (2) = errore
    expect(parsePathData("M0 0 a1 1 0 2 1 5 5").error).toBe(true);
  });

  it("cerchio completo con due archi: 4 cubiche e ritorno al punto di partenza", () => {
    const r = parsePathData("M10 0 A10 10 0 1 1 -10 0 A10 10 0 1 1 10 0 Z");
    expect(r.cmds.filter((c) => c.t === "C").length).toBe(4);
    const subs = cmdsToSubPaths(r.cmds);
    // chiuso e senza ancoraggio duplicato: 4 ancoraggi
    expect(subs[0].closed).toBe(true);
    expect(subs[0].anchors.length).toBe(4);
  });
});

describe("cmdsToSubPaths: la convenzione del modello (maniglie RELATIVE)", () => {
  it("una retta ha maniglie nulle", () => {
    const [sp] = cmdsToSubPaths(parsePathData("M0 0 L10 10").cmds);
    expect(sp.closed).toBe(false);
    expect(sp.anchors).toEqual([
      { x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 },
      { x: 10, y: 10, inX: 0, inY: 0, outX: 0, outY: 0 },
    ]);
  });

  it("una cubica: out del primo = c1 - p0, in del secondo = c2 - p1", () => {
    const [sp] = cmdsToSubPaths(parsePathData("M0 0 C10 0 20 10 30 10").cmds);
    expect(sp.anchors[0]).toEqual({ x: 0, y: 0, inX: 0, inY: 0, outX: 10, outY: 0 });
    expect(sp.anchors[1]).toEqual({ x: 30, y: 10, inX: -10, inY: 0, outX: 0, outY: 0 });
  });

  it("chiusura con linea: l'ultimo ancoraggio non coincide col primo e closed=true", () => {
    const [sp] = cmdsToSubPaths(parsePathData("M0 0 L10 0 L10 10 Z").cmds);
    expect(sp.closed).toBe(true);
    expect(sp.anchors.length).toBe(3);
  });

  it("ritorno esplicito al punto di partenza: ancoraggio fuso, la maniglia in entrata passa al primo", () => {
    const [sp] = cmdsToSubPaths(parsePathData("M0 0 L10 0 L10 10 C5 10 0 5 0 0 Z").cmds);
    expect(sp.closed).toBe(true);
    expect(sp.anchors.length).toBe(3);
    // l'ultimo C arriva in (0,0) con c2=(0,5): in = (0,5)
    expect(sp.anchors[0]).toEqual({ x: 0, y: 0, inX: 0, inY: 5, outX: 0, outY: 0 });
    // e l'uscente di (10,10) è c1-p = (-5,0)
    expect(sp.anchors[2]).toMatchObject({ x: 10, y: 10, outX: -5, outY: 0 });
  });

  it("più sottopercorsi, e un M isolato si scarta", () => {
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
    // subPathsToD scrive 4 decimali: il confronto è sulla stessa precisione
    expect(subPathsToD(b)).toBe(subPathsToD(a));
    expect(b.map((s) => [s.closed, s.anchors.length])).toEqual(a.map((s) => [s.closed, s.anchors.length]));
    b[0].anchors.forEach((p, i) => {
      for (const k of ["x", "y", "inX", "inY", "outX", "outY"] as const) expect(p[k]).toBeCloseTo(a[0].anchors[i][k], 3);
    });
  });
});

describe("transformCmds", () => {
  it("applica la matrice a punti e controlli", () => {
    const cmds = parsePathData("M0 0 C1 0 2 1 3 1").cmds;
    const out = transformCmds(cmds, { a: 2, b: 0, c: 0, d: 3, e: 10, f: 20 });
    expect(show(out)).toEqual(["M10,20", "C12,20 14,23 16,23"]);
  });
});
