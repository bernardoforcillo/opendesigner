import type { AnchorLite, SubPathLite } from "../store/types";
import type { Transform } from "../canvas/transform";

// IL PARSER DEL `d` DI UN <path> E LA CONVERSIONE NEL MODELLO VETTORIALE.
//
// Due passi distinti, entrambi puri:
//   1. parsePathData: il testo -> comandi ASSOLUTI e normalizzati a M/L/C/Z.
//      Qui spariscono i relativi, H/V, S/T, Q e gli archi (A -> cubiche): il
//      modello vettoriale ha un solo tipo di segmento, la cubica (la retta è
//      una cubica con le maniglie sugli estremi).
//   2. cmdsToSubPaths: i comandi -> SubPath/Anchor nella convenzione del
//      proto (vedi `Anchor` nel .proto e store/vectorGeometry.ts):
//        - x/y degli ancoraggi: assoluti qui, normalizzati dal chiamante;
//        - inX/inY e outX/outY: OFFSET RELATIVI all'ancoraggio, non punti
//          assoluti. (0,0) = nessuna maniglia = segmento rettilineo.
//
// La specifica SVG dice che un errore nel `d` NON invalida il path: si
// disegna fino al comando difettoso. parsePathData si comporta così (ritorna i
// comandi validi e `error: true`), invece di buttare tutto.

export type PathCmd =
  | { t: "M"; x: number; y: number }
  | { t: "L"; x: number; y: number }
  | { t: "C"; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { t: "Z" };

export interface ParsedPath { cmds: PathCmd[]; error: boolean }

// Tetto di sicurezza: un `d` ostile da milioni di segmenti non deve inchiodare
// il browser. 200k comandi sono ben oltre qualunque illustrazione reale.
export const MAX_PATH_COMMANDS = 200_000;

const ARITY: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };

class Scanner {
  pos = 0;
  constructor(readonly s: string) {}

  skipSep(): void {
    for (;;) {
      const ch = this.s.charCodeAt(this.pos);
      // spazio, \t \n \r \f e virgola
      if (ch === 32 || ch === 9 || ch === 10 || ch === 13 || ch === 12 || ch === 44) this.pos++;
      else break;
    }
  }

  atEnd(): boolean {
    this.skipSep();
    return this.pos >= this.s.length;
  }

  peek(): string {
    this.skipSep();
    return this.s[this.pos] ?? "";
  }

  // Un numero SVG: segno?, (cifre[.cifre] | .cifre), esponente?. Il punto che
  // segue un numero che ne ha già uno apre il numero SUCCESSIVO (".5.5" sono
  // due numeri) e il segno apre sempre un numero nuovo ("10-5").
  number(): number | null {
    this.skipSep();
    const s = this.s;
    let p = this.pos;
    const start = p;
    if (s[p] === "+" || s[p] === "-") p++;
    let digits = 0;
    while (p < s.length && s.charCodeAt(p) >= 48 && s.charCodeAt(p) <= 57) { p++; digits++; }
    if (s[p] === ".") {
      p++;
      while (p < s.length && s.charCodeAt(p) >= 48 && s.charCodeAt(p) <= 57) { p++; digits++; }
    }
    if (digits === 0) return null;
    if (s[p] === "e" || s[p] === "E") {
      let q = p + 1;
      if (s[q] === "+" || s[q] === "-") q++;
      let ed = 0;
      while (q < s.length && s.charCodeAt(q) >= 48 && s.charCodeAt(q) <= 57) { q++; ed++; }
      // "1e" senza cifre non è un esponente: il numero finisce prima della 'e'.
      if (ed > 0) p = q;
    }
    const v = Number(s.slice(start, p));
    if (!Number.isFinite(v)) return null;
    this.pos = p;
    return v;
  }

  // I flag degli archi sono UN carattere ('0' o '1') e possono essere
  // attaccati a ciò che segue: "a1 1 0 00.5.5" -> large=0, sweep=0, x=.5, y=.5.
  flag(): 0 | 1 | null {
    this.skipSep();
    const ch = this.s[this.pos];
    if (ch === "0" || ch === "1") { this.pos++; return ch === "1" ? 1 : 0; }
    return null;
  }
}

/** Angolo (rad) fra due vettori, con segno. */
function vecAngle(ux: number, uy: number, vx: number, vy: number): number {
  const dot = ux * vx + uy * vy;
  const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
  if (len === 0) return 0;
  let a = Math.acos(Math.max(-1, Math.min(1, dot / len)));
  if (ux * vy - uy * vx < 0) a = -a;
  return a;
}

/**
 * Un arco ellittico SVG (parametrizzazione per estremi) come sequenza di
 * cubiche di Bézier, una per al più 90 gradi: l'errore massimo di
 * un'approssimazione a quarto d'arco è ~0.027% del raggio, invisibile.
 * Segue l'appendice F.6.5/F.6.6 della specifica (raggi troppo piccoli
 * scalati, raggio nullo = retta). Ogni elemento è [x1,y1,x2,y2,x,y].
 */
export function arcToCubics(
  x1: number, y1: number, rxIn: number, ryIn: number, phiDeg: number,
  largeArc: number, sweep: number, x2: number, y2: number,
): number[][] {
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (x1 === x2 && y1 === y2) return [];
  if (rx === 0 || ry === 0) return [[x1, y1, x2, y2, x2, y2]];
  const phi = (((phiDeg % 360) + 360) % 360) * Math.PI / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx2 = (x1 - x2) / 2;
  const dy2 = (y1 - y2) / 2;
  const x1p = cos * dx2 + sin * dy2;
  const y1p = -sin * dx2 + cos * dy2;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }
  const rx2 = rx * rx;
  const ry2 = ry * ry;
  const den = rx2 * y1p * y1p + ry2 * x1p * x1p;
  const num = rx2 * ry2 - den;
  const coef = (largeArc === sweep ? -1 : 1) * Math.sqrt(Math.max(0, den === 0 ? 0 : num / den));
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const ux = (x1p - cxp) / rx;
  const uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx;
  const vy = (-y1p - cyp) / ry;
  const theta1 = vecAngle(1, 0, ux, uy);
  let dTheta = vecAngle(ux, uy, vx, vy);
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
  else if (sweep && dTheta < 0) dTheta += 2 * Math.PI;

  const n = Math.max(1, Math.ceil(Math.abs(dTheta) / (Math.PI / 2) - 1e-9));
  const delta = dTheta / n;
  const k = (4 / 3) * Math.tan(delta / 4);
  const map = (px: number, py: number): [number, number] => [
    cx + rx * px * cos - ry * py * sin,
    cy + rx * px * sin + ry * py * cos,
  ];
  const out: number[][] = [];
  for (let i = 0; i < n; i++) {
    const a1 = theta1 + i * delta;
    const a2 = a1 + delta;
    const c1 = map(Math.cos(a1) - k * Math.sin(a1), Math.sin(a1) + k * Math.cos(a1));
    const c2 = map(Math.cos(a2) + k * Math.sin(a2), Math.sin(a2) - k * Math.cos(a2));
    // L'ultimo estremo è ESATTAMENTE quello richiesto: la deriva
    // trigonometrica non deve lasciare un sub-pixel fra un segmento e il
    // successivo.
    const end: [number, number] = i === n - 1 ? [x2, y2] : map(Math.cos(a2), Math.sin(a2));
    out.push([c1[0], c1[1], c2[0], c2[1], end[0], end[1]]);
  }
  return out;
}

export function parsePathData(d: string, maxCommands = MAX_PATH_COMMANDS): ParsedPath {
  const cmds: PathCmd[] = [];
  const sc = new Scanner(d);
  let cx = 0, cy = 0, sx = 0, sy = 0;
  // Ultimo punto di controllo (assoluto) per le riflessioni di S e T.
  let lastC: [number, number] | null = null; // cubica
  let lastQ: [number, number] | null = null; // quadratica
  let cmd = "";
  let first = true;
  // Dopo una Z il punto corrente è l'inizio del sottopercorso: un comando di
  // disegno che segue senza M apre un NUOVO sottopercorso da lì.
  let needMove = false;
  let error = false;

  const push = (c: PathCmd): boolean => {
    if (cmds.length >= maxCommands) { error = true; return false; }
    cmds.push(c);
    return true;
  };
  const ensureMove = (): boolean => {
    if (!needMove) return true;
    needMove = false;
    return push({ t: "M", x: sx, y: sy });
  };

  while (!sc.atEnd()) {
    const ch = sc.peek();
    if (/[a-zA-Z]/.test(ch)) {
      if (!(ch.toLowerCase() in ARITY)) { error = true; break; }
      cmd = ch;
      sc.pos++;
      if (first && cmd !== "M" && cmd !== "m") { error = true; break; }
      first = false;
      if (cmd === "z" || cmd === "Z") {
        // Z su un path senza sottopercorso aperto non fa niente.
        if (cmds.length > 0 && cmds[cmds.length - 1].t !== "Z") {
          if (!push({ t: "Z" })) break;
        }
        cx = sx; cy = sy;
        needMove = true;
        lastC = null; lastQ = null;
        cmd = "";
        continue;
      }
    } else if (cmd === "") {
      // Numeri senza comando (o dopo una Z): errore, si ferma qui.
      error = true;
      break;
    }
    // Argomenti di UN'istanza del comando (le istanze si ripetono finché ci
    // sono numeri: è la ripetizione implicita).
    const lower = cmd.toLowerCase();
    const rel = cmd !== cmd.toUpperCase();
    const args: number[] = [];
    let ok = true;
    for (let i = 0; i < ARITY[lower]; i++) {
      if (lower === "a" && (i === 3 || i === 4)) {
        const f = sc.flag();
        if (f === null) { ok = false; break; }
        args.push(f);
      } else {
        const v = sc.number();
        if (v === null) { ok = false; break; }
        args.push(v);
      }
    }
    if (!ok) { error = true; break; }

    const ox = rel ? cx : 0;
    const oy = rel ? cy : 0;
    switch (lower) {
      case "m": {
        const x = args[0] + ox, y = args[1] + oy;
        if (!push({ t: "M", x, y })) break;
        cx = sx = x; cy = sy = y;
        needMove = false;
        // Le coppie successive di un M sono L (della stessa "relatività").
        cmd = rel ? "l" : "L";
        lastC = null; lastQ = null;
        break;
      }
      case "l": {
        if (!ensureMove()) break;
        const x = args[0] + ox, y = args[1] + oy;
        push({ t: "L", x, y });
        cx = x; cy = y; lastC = null; lastQ = null;
        break;
      }
      case "h": {
        if (!ensureMove()) break;
        const x = args[0] + ox;
        push({ t: "L", x, y: cy });
        cx = x; lastC = null; lastQ = null;
        break;
      }
      case "v": {
        if (!ensureMove()) break;
        const y = args[0] + oy;
        push({ t: "L", x: cx, y });
        cy = y; lastC = null; lastQ = null;
        break;
      }
      case "c": {
        if (!ensureMove()) break;
        const c = { t: "C" as const, x1: args[0] + ox, y1: args[1] + oy, x2: args[2] + ox, y2: args[3] + oy, x: args[4] + ox, y: args[5] + oy };
        push(c);
        lastC = [c.x2, c.y2]; lastQ = null;
        cx = c.x; cy = c.y;
        break;
      }
      case "s": {
        if (!ensureMove()) break;
        // Primo controllo = riflessione del secondo controllo precedente
        // (solo se il comando prima era C/S), altrimenti il punto corrente.
        const x1: number = lastC ? 2 * cx - lastC[0] : cx;
        const y1: number = lastC ? 2 * cy - lastC[1] : cy;
        const c: Extract<PathCmd, { t: "C" }> = { t: "C", x1, y1, x2: args[0] + ox, y2: args[1] + oy, x: args[2] + ox, y: args[3] + oy };
        push(c);
        lastC = [c.x2, c.y2]; lastQ = null;
        cx = c.x; cy = c.y;
        break;
      }
      case "q":
      case "t": {
        if (!ensureMove()) break;
        let qx: number, qy: number, x: number, y: number;
        if (lower === "q") {
          qx = args[0] + ox; qy = args[1] + oy; x = args[2] + ox; y = args[3] + oy;
        } else {
          qx = lastQ ? 2 * cx - lastQ[0] : cx;
          qy = lastQ ? 2 * cy - lastQ[1] : cy;
          x = args[0] + ox; y = args[1] + oy;
        }
        // Quadratica -> cubica: i controlli stanno a 2/3 verso Q.
        push({
          t: "C",
          x1: cx + (2 / 3) * (qx - cx), y1: cy + (2 / 3) * (qy - cy),
          x2: x + (2 / 3) * (qx - x), y2: y + (2 / 3) * (qy - y),
          x, y,
        });
        lastQ = [qx, qy]; lastC = null;
        cx = x; cy = y;
        break;
      }
      case "a": {
        if (!ensureMove()) break;
        const x = args[5] + ox, y = args[6] + oy;
        if (cx === x && cy === y) { lastC = null; lastQ = null; break; }
        for (const s of arcToCubics(cx, cy, args[0], args[1], args[2], args[3], args[4], x, y)) {
          if (!push({ t: "C", x1: s[0], y1: s[1], x2: s[2], y2: s[3], x: s[4], y: s[5] })) break;
        }
        cx = x; cy = y; lastC = null; lastQ = null;
        break;
      }
    }
    if (error) break;
  }
  return { cmds, error };
}

/** Applica una matrice affine a tutti i punti (le Bézier sono affini-invarianti). */
export function transformCmds(cmds: readonly PathCmd[], t: Transform): PathCmd[] {
  const px = (x: number, y: number) => t.a * x + t.c * y + t.e;
  const py = (x: number, y: number) => t.b * x + t.d * y + t.f;
  return cmds.map((c): PathCmd => {
    switch (c.t) {
      case "M": return { t: "M", x: px(c.x, c.y), y: py(c.x, c.y) };
      case "L": return { t: "L", x: px(c.x, c.y), y: py(c.x, c.y) };
      case "C": return {
        t: "C",
        x1: px(c.x1, c.y1), y1: py(c.x1, c.y1),
        x2: px(c.x2, c.y2), y2: py(c.x2, c.y2),
        x: px(c.x, c.y), y: py(c.x, c.y),
      };
      default: return c;
    }
  });
}

const CLOSE_EPS = 1e-6;

/**
 * I comandi (già assoluti) nei SubPath del modello, ancora in coordinate
 * ASSOLUTE: la normalizzazione al box del nodo la fa il chiamante, che sa
 * anche calcolare i bounds veri (vectorBounds).
 *
 * Regole che il modello impone e che qui si rispettano:
 *  - un SubPath ha gli ancoraggi e il flag `closed`; il segmento di chiusura
 *    NON ha un ancoraggio duplicato (primo == ultimo non esiste: è `closed`).
 *    Quando il tracciato SVG torna esplicitamente al punto di partenza
 *    (`... L x0 y0 Z` o `... C ... x0 y0 Z`) l'ultimo ancoraggio coincide col
 *    primo e viene FUSO: la sua maniglia entrante diventa quella del primo.
 *  - le maniglie sono relative all'ancoraggio a cui appartengono: la uscente
 *    del precedente è (c1 - p0), l'entrante del successivo è (c2 - p1).
 *  - un sottopercorso con un solo punto (M isolato, o M+Z) non disegna niente
 *    e si scarta.
 */
export function cmdsToSubPaths(cmds: readonly PathCmd[]): SubPathLite[] {
  const out: SubPathLite[] = [];
  let cur: AnchorLite[] | null = null;

  const finish = (closed: boolean) => {
    if (cur && cur.length >= 2) {
      let anchors = cur;
      if (closed) {
        const f = anchors[0];
        const l = anchors[anchors.length - 1];
        if (anchors.length > 2 && Math.abs(f.x - l.x) < CLOSE_EPS && Math.abs(f.y - l.y) < CLOSE_EPS) {
          anchors = anchors.slice(0, -1);
          anchors[0] = { ...f, inX: l.inX, inY: l.inY };
        }
      }
      out.push({ anchors, closed });
    }
    cur = null;
  };

  for (const c of cmds) {
    switch (c.t) {
      case "M":
        finish(false);
        cur = [{ x: c.x, y: c.y, inX: 0, inY: 0, outX: 0, outY: 0 }];
        break;
      case "L":
        if (!cur) break;
        cur.push({ x: c.x, y: c.y, inX: 0, inY: 0, outX: 0, outY: 0 });
        break;
      case "C": {
        if (!cur) break;
        const prev = cur[cur.length - 1];
        prev.outX = c.x1 - prev.x;
        prev.outY = c.y1 - prev.y;
        cur.push({ x: c.x, y: c.y, inX: c.x2 - c.x, inY: c.y2 - c.y, outX: 0, outY: 0 });
        break;
      }
      case "Z":
        finish(true);
        break;
    }
  }
  finish(false);
  return out;
}

/** Il comando `d` equivalente a dei subpath (assoluti), per export e test. */
export function subPathsToD(subpaths: readonly SubPathLite[], ox = 0, oy = 0, digits = 4): string {
  const f = (v: number) => String(Math.round(v * 10 ** digits) / 10 ** digits + 0);
  const parts: string[] = [];
  for (const sp of subpaths) {
    const n = sp.anchors.length;
    if (n === 0) continue;
    const a0 = sp.anchors[0];
    parts.push(`M${f(ox + a0.x)} ${f(oy + a0.y)}`);
    const segs = sp.closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const a = sp.anchors[i];
      const b = sp.anchors[(i + 1) % n];
      parts.push(
        `C${f(ox + a.x + a.outX)} ${f(oy + a.y + a.outY)} ${f(ox + b.x + b.inX)} ${f(oy + b.y + b.inY)} ${f(ox + b.x)} ${f(oy + b.y)}`,
      );
    }
    if (sp.closed) parts.push("Z");
  }
  return parts.join("");
}
