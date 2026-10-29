// THE DATA FILES OF THE EFFECTS: colour lookup tables (.cube, .3dl), ASC CDL looks (.cdl, .cc, .ccc) and Photoshop curve maps (.acv,
// .amp). An effect names its file in a string parameter (fx/props.ts) whose value is the asset hash. The server only keeps files with a
// known signature, and a LUT is plain text, so the editor uploads it inside a one-line container ("ODFX\n" + the bytes; the server
// accepts only that, internal/store/assets.go). Parsed files are cached by hash, so a file is fetched and parsed once however many
// nodes use it. PURE except the fetch: the parsers and `packImage` are tested without a browser.

import { assetUrl, isAssetHash } from "@/rpc/assets";

export const FX_FILE_MAGIC = "ODFX\n";

/** What a file holds, in the three shapes the shaders know. Values are 0..1 unless the file says otherwise. */
export type FxData =
  /** Three curves of `size` entries (R, G, B), sampled over `domain`. */
  | { kind: "lut1d"; size: number; table: Float32Array; domain: [number, number]; sat: number }
  /** A cube of size³ RGB triples, red varying fastest. */
  | { kind: "lut3d"; size: number; table: Float32Array; domain: [number, number]; sat: number };

export function wrapFxFile(bytes: Uint8Array): Uint8Array {
  const head = new TextEncoder().encode(FX_FILE_MAGIC);
  const out = new Uint8Array(head.length + bytes.length);
  out.set(head, 0);
  out.set(bytes, head.length);
  return out;
}

export function unwrapFxFile(bytes: Uint8Array): Uint8Array | null {
  const head = new TextEncoder().encode(FX_FILE_MAGIC);
  for (let i = 0; i < head.length; i++) if (bytes[i] !== head[i]) return null;
  return bytes.subarray(head.length);
}

const MAX_3D = 65;
const MAX_1D = 4096;
const nums = (line: string): number[] => line.trim().split(/[\s,]+/).map(Number);
const finite = (a: readonly number[]) => a.every((x) => Number.isFinite(x));

/** An Iridas/Adobe .cube file: LUT_1D_SIZE or LUT_3D_SIZE, optional DOMAIN_MIN/MAX, then the table (red fastest). */
export function parseCube(text: string): FxData | null {
  let size1 = 0, size3 = 0;
  let dmin = 0, dmax = 1;
  const rows: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (line === "") continue;
    const word = line.split(/\s+/, 1)[0];
    if (word === "TITLE" || word === "LUT_IN_VIDEO_RANGE" || word === "LUT_OUT_VIDEO_RANGE" || word === "LUT_3D_INPUT_RANGE" || word === "LUT_1D_INPUT_RANGE") continue;
    if (word === "LUT_1D_SIZE") size1 = Number(line.split(/\s+/)[1]);
    else if (word === "LUT_3D_SIZE") size3 = Number(line.split(/\s+/)[1]);
    else if (word === "DOMAIN_MIN") dmin = Number(line.split(/\s+/)[1]);
    else if (word === "DOMAIN_MAX") dmax = Number(line.split(/\s+/)[1]);
    else {
      const v = nums(line);
      if (v.length !== 3 || !finite(v)) return null;
      rows.push(...v);
    }
  }
  if (!(dmax > dmin) || !finite([dmin, dmax])) return null;
  if (size3 > 0 && size1 === 0) {
    if (!Number.isInteger(size3) || size3 < 2 || size3 > MAX_3D || rows.length !== size3 ** 3 * 3) return null;
    return { kind: "lut3d", size: size3, table: Float32Array.from(rows), domain: [dmin, dmax], sat: 1 };
  }
  if (size1 > 0 && size3 === 0) {
    if (!Number.isInteger(size1) || size1 < 2 || size1 > MAX_1D || rows.length !== size1 * 3) return null;
    return { kind: "lut1d", size: size1, table: Float32Array.from(rows), domain: [dmin, dmax], sat: 1 };
  }
  return null;
}

/** An Autodesk/Lustre .3dl file: an optional line of input values (its count is the cube size), then rows of integers, blue fastest. */
export function parse3dl(text: string): FxData | null {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/#.*/, "").trim()).filter((l) => l !== "" && !/^(Mesh|3DMESH|LUT8|gamma)/i.test(l));
  if (lines.length === 0) return null;
  let size = 0;
  const first = nums(lines[0]);
  // the first line lists the input codes (one per cube step) when it is not a row of three, or when the rest is exactly a cube of that many
  if (finite(first) && first.length >= 2 && (first.length !== 3 || lines.length - 1 === 27)) { size = first.length; lines.shift(); }
  const rows: number[][] = lines.map(nums);
  if (rows.some((r) => r.length !== 3 || !finite(r))) return null;
  if (size === 0) { size = Math.round(Math.cbrt(rows.length)); }
  if (size < 2 || size > MAX_3D || rows.length !== size ** 3) return null;
  let max = 0;
  for (const r of rows) for (const x of r) if (x > max) max = x;
  const scale = max <= 1 ? 1 : max <= 1023 ? 1023 : max <= 4095 ? 4095 : 65535;
  // blue fastest in the file; the cube here is red fastest
  const table = new Float32Array(size ** 3 * 3);
  for (let r = 0; r < size; r++) for (let g = 0; g < size; g++) for (let b = 0; b < size; b++) {
    const src = rows[b + g * size + r * size * size];
    const dst = (r + g * size + b * size * size) * 3;
    table[dst] = src[0] / scale; table[dst + 1] = src[1] / scale; table[dst + 2] = src[2] / scale;
  }
  return { kind: "lut3d", size, table, domain: [0, 1], sat: 1 };
}

/** An ASC CDL (.cdl, .cc, .ccc): slope, offset and power per channel and one saturation, baked into a 1D table (saturation stays a number). */
export function parseCdl(text: string): FxData | null {
  const grab = (tag: string, n: number): number[] | null => {
    const m = new RegExp(`<${tag}>([^<]*)</${tag}>`, "i").exec(text);
    if (!m) return null;
    const v = nums(m[1]);
    return v.length === n && finite(v) ? v : null;
  };
  const slope = grab("Slope", 3) ?? [1, 1, 1], offset = grab("Offset", 3) ?? [0, 0, 0], power = grab("Power", 3) ?? [1, 1, 1];
  const sat = grab("Saturation", 1)?.[0] ?? 1;
  if (!/<(Slope|Offset|Power|Saturation)>/i.test(text)) return null;
  const size = 1024;
  const table = new Float32Array(size * 3);
  for (let i = 0; i < size; i++) {
    const x = i / (size - 1);
    for (let c = 0; c < 3; c++) {
      const v = Math.max(0, Math.min(1, x * slope[c] + offset[c]));
      table[i * 3 + c] = v ** power[c];
    }
  }
  return { kind: "lut1d", size, table, domain: [0, 1], sat };
}

/** Photoshop curves (.acv; Arbitrary Map .amp files use the same layout, or are a bare 256 or 3 x 256 byte table). */
export function parseCurves(bytes: Uint8Array): FxData | null {
  const read = (): Float32Array[] | null => {
    if (bytes.length === 256 || bytes.length === 768) {
      const n = bytes.length / 256;
      return Array.from({ length: n }, (_, c) => Float32Array.from({ length: 256 }, (_, i) => bytes[c * 256 + i] / 255));
    }
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 4) return null;
    const version = dv.getUint16(0), count = dv.getUint16(2);
    if (version !== 4 && version !== 1) return null;
    if (count < 1 || count > 32) return null;
    let at = 4;
    const curves: Float32Array[] = [];
    for (let c = 0; c < count; c++) {
      if (at + 2 > bytes.length) return null;
      const n = dv.getUint16(at); at += 2;
      if (n < 2 || n > 19 || at + n * 4 > bytes.length) return null;
      const pts: [number, number][] = [];
      for (let i = 0; i < n; i++) { pts.push([dv.getUint16(at + 2) / 255, dv.getUint16(at) / 255]); at += 4; } // (output, input) on disk
      pts.sort((a, b) => a[0] - b[0]);
      curves.push(sampleCurve(pts));
    }
    return curves;
  };
  const curves = read();
  if (!curves) return null;
  // the first is the composite RGB curve, the next three are R, G, B (a single one applies to all)
  const comp = curves[0];
  const ch = (c: number) => (curves.length >= 4 ? curves[1 + c] : null);
  const table = new Float32Array(256 * 3);
  const at = (t: Float32Array, v: number) => t[Math.max(0, Math.min(255, Math.round(v * 255)))];
  for (let i = 0; i < 256; i++) for (let c = 0; c < 3; c++) {
    const own = curves.length === 3 ? curves[c] : ch(c);
    const v = own ? at(own, i / 255) : i / 255;
    table[i * 3 + c] = curves.length === 3 ? v : at(comp, v);
  }
  return { kind: "lut1d", size: 256, table, domain: [0, 1], sat: 1 };
}

/** 256 samples of the monotone cubic through the points (x ascending, 0..1). */
function sampleCurve(pts: readonly [number, number][]): Float32Array {
  const n = pts.length;
  const d = pts.slice(1).map((p, i) => (p[1] - pts[i][1]) / Math.max(1e-6, p[0] - pts[i][0]));
  const m = new Array<number>(n);
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  const out = new Float32Array(256);
  for (let k = 0; k < 256; k++) {
    const x = k / 255;
    if (x <= pts[0][0]) { out[k] = pts[0][1]; continue; }
    if (x >= pts[n - 1][0]) { out[k] = pts[n - 1][1]; continue; }
    let i = 0;
    while (i < n - 2 && x > pts[i + 1][0]) i++;
    const h = pts[i + 1][0] - pts[i][0], t = (x - pts[i][0]) / h;
    const t2 = t * t, t3 = t2 * t;
    out[k] = Math.max(0, Math.min(1, (2 * t3 - 3 * t2 + 1) * pts[i][1] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * pts[i + 1][1] + (t3 - t2) * h * m[i + 1]));
  }
  return out;
}

/** Parses by what the bytes are (the extension is not kept: the asset is its hash). */
export function parseFxFile(raw: Uint8Array): FxData | null {
  const bytes = unwrapFxFile(raw);
  if (!bytes) return null;
  if (bytes.length > 4 && bytes[0] === 0 && (bytes[1] === 4 || bytes[1] === 1)) { const c = parseCurves(bytes); if (c) return c; }
  if (bytes.length === 256 || bytes.length === 768) return parseCurves(bytes);
  const text = new TextDecoder().decode(bytes);
  if (/<\s*(ColorCorrection|SOPNode|SatNode|ColorDecisionList|Slope|Power)\b/i.test(text)) return parseCdl(text);
  if (/LUT_(1D|3D)_SIZE/.test(text)) return parseCube(text);
  return parse3dl(text);
}

/** The inverse of a 1D table (each channel must rise): for each output step, where in the input it comes from. */
export function invert1d(d: Extract<FxData, { kind: "lut1d" }>): Extract<FxData, { kind: "lut1d" }> {
  const n = d.size;
  const table = new Float32Array(n * 3);
  const lo = d.domain[0], hi = d.domain[1];
  for (let c = 0; c < 3; c++) {
    let j = 0;
    for (let i = 0; i < n; i++) {
      const y = lo + ((hi - lo) * i) / (n - 1);
      while (j < n - 2 && d.table[(j + 1) * 3 + c] < y) j++;
      const a = d.table[j * 3 + c], b = d.table[(j + 1) * 3 + c];
      const t = b === a ? 0 : Math.max(0, Math.min(1, (y - a) / (b - a)));
      table[i * 3 + c] = lo + ((hi - lo) * (j + t)) / (n - 1);
    }
  }
  return { ...d, table, sat: d.sat === 0 ? 0 : 1 / d.sat };
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Trilinear sample of a cube at x in 0..1 (the table's own output values). */
function sample3(d: Extract<FxData, { kind: "lut3d" }>, x: readonly number[], out: number[]): void {
  const n = d.size;
  const t = x.map((v) => clamp01(v) * (n - 1));
  const a = t.map(Math.floor), f = t.map((v, i) => v - a[i]);
  const b = a.map((v) => Math.min(v + 1, n - 1));
  out[0] = out[1] = out[2] = 0;
  for (let k = 0; k < 8; k++) {
    const r = k & 1 ? b[0] : a[0], g = k & 2 ? b[1] : a[1], bl = k & 4 ? b[2] : a[2];
    const w = (k & 1 ? f[0] : 1 - f[0]) * (k & 2 ? f[1] : 1 - f[1]) * (k & 4 ? f[2] : 1 - f[2]);
    const at = (r + g * n + bl * n * n) * 3;
    out[0] += w * d.table[at]; out[1] += w * d.table[at + 1]; out[2] += w * d.table[at + 2];
  }
}

/** The inverse of a cube: for every lattice step of the output, the input that produces it (Newton's method on the trilinear table). */
export function invert3d(d: Extract<FxData, { kind: "lut3d" }>): Extract<FxData, { kind: "lut3d" }> {
  const n = d.size, lo = d.domain[0], span = d.domain[1] - d.domain[0];
  const table = new Float32Array(n * n * n * 3);
  const h = 0.5 / (n - 1);
  const f0 = [0, 0, 0], fa = [0, 0, 0], fb = [0, 0, 0];
  for (let bl = 0; bl < n; bl++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) {
    const target = [lo + (span * r) / (n - 1), lo + (span * g) / (n - 1), lo + (span * bl) / (n - 1)];
    // work in the table's output units: x in 0..1 is the input position, L(x) is compared with `target`
    const x = [r / (n - 1), g / (n - 1), bl / (n - 1)];
    for (let it = 0; it < 12; it++) {
      sample3(d, x, f0);
      const e = [target[0] - f0[0], target[1] - f0[1], target[2] - f0[2]];
      if (Math.abs(e[0]) + Math.abs(e[1]) + Math.abs(e[2]) < 1e-5) break;
      const J: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
      for (let j = 0; j < 3; j++) {
        const xa = x.slice(), xb = x.slice();
        xa[j] = clamp01(x[j] + h); xb[j] = clamp01(x[j] - h);
        sample3(d, xa, fa); sample3(d, xb, fb);
        const dx = xa[j] - xb[j] || 1;
        for (let i = 0; i < 3; i++) J[i][j] = (fa[i] - fb[i]) / dx;
      }
      const det = J[0][0] * (J[1][1] * J[2][2] - J[1][2] * J[2][1]) - J[0][1] * (J[1][0] * J[2][2] - J[1][2] * J[2][0]) + J[0][2] * (J[1][0] * J[2][1] - J[1][1] * J[2][0]);
      let step: number[];
      if (Math.abs(det) < 1e-6) step = e.map((v) => v / Math.max(span, 1e-6));
      else {
        const c = (i: number, j: number) => J[(i + 1) % 3][(j + 1) % 3] * J[(i + 2) % 3][(j + 2) % 3] - J[(i + 1) % 3][(j + 2) % 3] * J[(i + 2) % 3][(j + 1) % 3];
        // J^-1 = adj(J) / det, with adj[i][j] = cofactor(j, i)
        step = [0, 1, 2].map((i) => ([0, 1, 2].reduce((acc, j) => acc + c(j, i) * e[j], 0)) / det);
      }
      for (let i = 0; i < 3; i++) x[i] = clamp01(x[i] + step[i]);
    }
    const at = (r + g * n + bl * n * n) * 3;
    table[at] = lo + span * x[0]; table[at + 1] = lo + span * x[1]; table[at + 2] = lo + span * x[2];
  }
  return { ...d, table };
}

export interface FxImage { width: number; height: number; bytes: Uint8Array; sat: number }

const packed = new WeakMap<FxData, Map<boolean, FxImage>>();

/** The RGBA8 image the shader reads: a 1D table as size x 1; a cube as size² x size (red + blue * size across, green down). */
export function packImage(d: FxData, inverse: boolean): FxImage {
  // (sat is the saturation the file asks for; for the inverse of a 1D table it is the reciprocal)
  const hit = packed.get(d)?.get(inverse);
  if (hit) return hit;
  const use = inverse ? (d.kind === "lut1d" ? invert1d(d) : invert3d(d)) : d;
  const lo = use.domain[0], span = use.domain[1] - use.domain[0];
  const to8 = (v: number) => Math.round(Math.max(0, Math.min(1, (v - lo) / span)) * 255);
  let img: FxImage;
  if (use.kind === "lut1d") {
    const bytes = new Uint8Array(use.size * 4);
    for (let i = 0; i < use.size; i++) { for (let c = 0; c < 3; c++) bytes[i * 4 + c] = to8(use.table[i * 3 + c]); bytes[i * 4 + 3] = 255; }
    img = { width: use.size, height: 1, bytes, sat: use.sat };
  } else {
    const n = use.size;
    const bytes = new Uint8Array(n * n * n * 4);
    for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) {
      const src = (r + g * n + b * n * n) * 3;
      const dst = (g * n * n + b * n + r) * 4;
      for (let c = 0; c < 3; c++) bytes[dst + c] = to8(use.table[src + c]);
      bytes[dst + 3] = 255;
    }
    img = { width: n * n, height: n, bytes, sat: use.sat };
  }
  let m = packed.get(d);
  if (!m) { m = new Map(); packed.set(d, m); }
  m.set(inverse, img);
  return img;
}

const parsed = new Map<string, FxData>();
const loading = new Map<string, Promise<FxData | null>>();
const failed = new Set<string>();
const listeners = new Set<() => void>();

export function onFxFileLoaded(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** The parsed file if it is already here. */
export function fxData(hash: string): FxData | null {
  return parsed.get(hash) ?? null;
}

/** Puts a parsed file in the cache (the tests, and a file just uploaded). */
export function registerFxData(hash: string, d: FxData): void {
  parsed.set(hash, d);
  listeners.forEach((l) => l());
}

/** Starts fetching the file `hash` of document `docId` (once); `fxData` has it when it arrives. A file that cannot be read is not asked for again. */
export function ensureFxData(docId: string, hash: string): void {
  if (parsed.has(hash) || loading.has(hash) || failed.has(hash) || !isAssetHash(hash) || docId === "" || typeof fetch === "undefined") return;
  const p = fetch(assetUrl(docId, hash))
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
    .then((buf) => {
      const d = parseFxFile(new Uint8Array(buf));
      if (!d) { failed.add(hash); return null; }
      parsed.set(hash, d);
      listeners.forEach((l) => l());
      return d;
    })
    .catch(() => { failed.add(hash); return null; })
    .finally(() => { loading.delete(hash); });
  loading.set(hash, p);
}
