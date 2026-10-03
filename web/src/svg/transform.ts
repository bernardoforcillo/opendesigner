import { IDENTITY, compose, type Transform } from "../canvas/transform";

// L'attributo `transform` di SVG (e la proprietà CSS omonima nei casi semplici)
// come matrice affine {a,b,c,d,e,f} -- la stessa forma di canvas/transform.ts,
// così l'importer compone con compose() e non con una seconda algebra.
//
// Funzioni accettate: matrix, translate, scale, rotate (con centro opzionale),
// skewX, skewY, separate da spazi e/o virgole, con unità `deg`/`rad`/`px`
// tollerate (il CSS le scrive: `rotate(45deg)`, `translate(10px, 5px)`).
// L'ordine è quello SVG: "A B" = A applicata DOPO B ai punti (A è la più
// esterna), cioè M = A · B.

export interface ParsedTransform { matrix: Transform; ok: boolean }

const NUM = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;

function numbers(args: string): { values: number[]; units: string[] } {
  const values: number[] = [];
  const units: string[] = [];
  NUM.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NUM.exec(args)) !== null) {
    values.push(Number(m[0]));
    const unit = /^[a-z%]*/i.exec(args.slice(NUM.lastIndex))?.[0] ?? "";
    units.push(unit.toLowerCase());
  }
  return { values, units };
}

const rad = (deg: number) => (deg * Math.PI) / 180;

export function translateM(tx: number, ty: number): Transform {
  return { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty };
}
export function scaleM(sx: number, sy: number): Transform {
  return { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
}
export function rotateM(deg: number): Transform {
  const r = rad(deg);
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
}

export function parseTransform(input: string | null | undefined): ParsedTransform {
  if (input == null || input.trim() === "") return { matrix: IDENTITY, ok: true };
  const re = /([a-zA-Z]+)\s*\(([^)]*)\)/g;
  let rest = input;
  let m: RegExpExecArray | null;
  let t: Transform = IDENTITY;
  let ok = true;
  let consumed = 0;
  while ((m = re.exec(input)) !== null) {
    consumed += m[0].length;
    const { values: v, units } = numbers(m[2]);
    const name = m[1].toLowerCase();
    // `rad` si converte in gradi; `turn`/`grad` sono ignoti e si trattano da deg.
    const angle = (i: number) => (units[i] === "rad" ? (v[i] * 180) / Math.PI : v[i]);
    let next: Transform | null = null;
    switch (name) {
      case "matrix":
        if (v.length === 6) next = { a: v[0], b: v[1], c: v[2], d: v[3], e: v[4], f: v[5] };
        break;
      case "translate":
        if (v.length === 1 || v.length === 2) next = translateM(v[0], v[1] ?? 0);
        break;
      case "translatex":
        if (v.length === 1) next = translateM(v[0], 0);
        break;
      case "translatey":
        if (v.length === 1) next = translateM(0, v[0]);
        break;
      case "scale":
        if (v.length === 1 || v.length === 2) next = scaleM(v[0], v[1] ?? v[0]);
        break;
      case "scalex":
        if (v.length === 1) next = scaleM(v[0], 1);
        break;
      case "scaley":
        if (v.length === 1) next = scaleM(1, v[0]);
        break;
      case "rotate":
        if (v.length === 1) next = rotateM(angle(0));
        else if (v.length === 3) {
          // rotate(a cx cy) = translate(c) · rotate(a) · translate(-c)
          next = compose(translateM(v[1], v[2]), compose(rotateM(angle(0)), translateM(-v[1], -v[2])));
        }
        break;
      case "skewx":
        if (v.length === 1) next = { a: 1, b: 0, c: Math.tan(rad(angle(0))), d: 1, e: 0, f: 0 };
        break;
      case "skewy":
        if (v.length === 1) next = { a: 1, b: Math.tan(rad(angle(0))), c: 0, d: 1, e: 0, f: 0 };
        break;
      default:
        break;
    }
    if (next === null) { ok = false; continue; }
    t = compose(t, next);
  }
  rest = input.replace(re, "").replace(/[\s,]/g, "");
  if (rest !== "" || consumed === 0) ok = false;
  if (!Object.values(t).every(Number.isFinite)) return { matrix: IDENTITY, ok: false };
  return { matrix: t, ok };
}

export function isIdentityM(t: Transform): boolean {
  return t.a === 1 && t.b === 0 && t.c === 0 && t.d === 1 && t.e === 0 && t.f === 0;
}

/** Sola traslazione (parte lineare identità). */
export function isTranslationM(t: Transform): boolean {
  return t.a === 1 && t.b === 0 && t.c === 0 && t.d === 1;
}

export interface Similarity {
  /** Scala uniforme. */
  s: number;
  /** Rotazione in gradi, normalizzata in [0, 360). */
  rotation: number;
}

/**
 * Se la matrice è una SIMILITUDINE diretta (traslazione + scala uniforme +
 * rotazione, senza riflessione né skew) ne ritorna scala e rotazione: è
 * l'unico caso in cui un rect/ellisse resta un rect/ellisse del modello (che
 * ha solo x/y/width/height/rotation). Altrimenti null, e il chiamante converte
 * la forma in path.
 */
export function similarityOf(t: Transform): Similarity | null {
  const sx = Math.hypot(t.a, t.b);
  const sy = Math.hypot(t.c, t.d);
  const det = t.a * t.d - t.b * t.c;
  const tol = 1e-6 * Math.max(sx, sy, 1e-12);
  if (!(sx > 0) || det <= 0) return null;
  if (Math.abs(sx - sy) > tol) return null;
  if (Math.abs(t.a * t.c + t.b * t.d) > tol * sx) return null;
  let deg = (Math.atan2(t.b, t.a) * 180) / Math.PI;
  deg = ((deg % 360) + 360) % 360;
  // Il rumore numerico attorno a 0/360 non deve diventare una rotazione.
  if (deg < 1e-7 || deg > 360 - 1e-7) deg = 0;
  return { s: sx, rotation: deg };
}

/** Il fattore con cui la matrice scala le LUNGHEZZE (radice del determinante). */
export function lengthScaleOf(t: Transform): number {
  const det = Math.abs(t.a * t.d - t.b * t.c);
  return Math.sqrt(det);
}
