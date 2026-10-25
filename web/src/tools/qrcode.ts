// QR CODE (ISO/IEC 18004), byte mode, versions 1-10, all four error-correction levels. The result is a matrix of modules; the
// editor draws it as a vector (tools/objectTools.ts), so it prints sharp at any size and needs no image asset.

export type QrLevel = "L" | "M" | "Q" | "H";
export const QR_LEVELS: readonly QrLevel[] = ["L", "M", "Q", "H"];

// [EC codewords per block, blocks in group 1, data codewords each, blocks in group 2, data codewords each] per version 1..10.
const EC: Record<QrLevel, number[][]> = {
  L: [[7, 1, 19, 0, 0], [10, 1, 34, 0, 0], [15, 1, 55, 0, 0], [20, 1, 80, 0, 0], [26, 1, 108, 0, 0], [18, 2, 68, 0, 0], [20, 2, 78, 0, 0], [24, 2, 97, 0, 0], [30, 2, 116, 0, 0], [18, 2, 68, 2, 69]],
  M: [[10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0], [24, 2, 43, 0, 0], [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39], [22, 3, 36, 2, 37], [26, 4, 43, 1, 44]],
  Q: [[13, 1, 13, 0, 0], [22, 1, 22, 0, 0], [18, 2, 17, 0, 0], [26, 2, 24, 0, 0], [18, 2, 15, 2, 16], [24, 4, 19, 0, 0], [18, 2, 14, 4, 15], [22, 4, 18, 2, 19], [20, 4, 16, 4, 17], [24, 6, 19, 2, 20]],
  H: [[17, 1, 9, 0, 0], [28, 1, 16, 0, 0], [22, 2, 13, 0, 0], [16, 4, 9, 0, 0], [22, 2, 11, 2, 12], [28, 4, 15, 0, 0], [26, 4, 13, 1, 14], [26, 4, 14, 2, 15], [24, 4, 12, 4, 13], [28, 6, 15, 2, 16]],
};
const ALIGN: number[][] = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const LEVEL_BITS: Record<QrLevel, number> = { L: 1, M: 0, Q: 3, H: 2 };

export const QR_MAX_BYTES = 271; // version 10, level L

const dataCodewords = (level: QrLevel, v: number): number => { const e = EC[level][v - 1]!; return e[1]! * e[2]! + e[3]! * e[4]!; };

/** The smallest version that holds `byteLength` bytes at `level`, or 0 if none of 1..10 does. */
export function qrVersionFor(byteLength: number, level: QrLevel): number {
  for (let v = 1; v <= 10; v++) {
    const countBits = v < 10 ? 8 : 16;
    if (4 + countBits + byteLength * 8 <= dataCodewords(level, v) * 8) return v;
  }
  return 0;
}

// GF(256), polynomial 0x11d.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!);

function rsRemainder(data: number[], ecLen: number): number[] {
  let gen = [1];
  for (let i = 0; i < ecLen; i++) {
    const next = new Array<number>(gen.length + 1).fill(0);
    gen.forEach((c, k) => { next[k] = next[k]! ^ mul(c, EXP[i]!); next[k + 1] = next[k + 1]! ^ c; });
    gen = next;
  }
  // gen is little-endian here (index = power); the division works on the big-endian form.
  const g = gen.slice().reverse();
  const rem = new Array<number>(ecLen).fill(0);
  for (const d of data) {
    const f = d ^ rem[0]!;
    rem.shift(); rem.push(0);
    for (let i = 0; i < ecLen; i++) rem[i] = rem[i]! ^ mul(g[i + 1]!, f);
  }
  return rem;
}

function bch(value: number, poly: number, polyLen: number, shift: number): number {
  let v = value << shift;
  for (let i = 31 - Math.clz32(v); i >= polyLen - 1; i--) if (v & (1 << i)) v ^= poly << (i - (polyLen - 1));
  return v;
}

/**
 * The modules of the QR code for `text` (UTF-8): `true` is dark. Throws if the text is too long for version 10 at that level.
 */
export function qrMatrix(text: string, level: QrLevel = "M"): boolean[][] {
  const bytes = [...new TextEncoder().encode(text)];
  const version = qrVersionFor(bytes.length, level);
  if (version === 0) throw new Error(`the text is too long for a QR code here (${bytes.length} bytes; the limit at level ${level} is ${qrCapacity(level)})`);
  const size = 17 + 4 * version;
  const total = dataCodewords(level, version);

  // Bit stream: mode 0100, count, data, terminator, padding.
  const bits: number[] = [];
  const put = (v: number, n: number) => { for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1); };
  put(4, 4); put(bytes.length, version < 10 ? 8 : 16);
  bytes.forEach((b) => put(b, 8));
  put(0, Math.min(4, total * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const cw: number[] = [];
  for (let i = 0; i < bits.length; i += 8) cw.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  for (let pad = 0xec; cw.length < total; pad ^= 0xec ^ 0x11) cw.push(pad);

  // Blocks, error correction, interleaving.
  const [ecLen, n1, d1, n2, d2] = EC[level][version - 1]! as [number, number, number, number, number];
  const blocks: { data: number[]; ec: number[] }[] = [];
  let at = 0;
  for (let i = 0; i < n1 + n2; i++) {
    const len = i < n1 ? d1 : d2;
    const data = cw.slice(at, at + len); at += len;
    blocks.push({ data, ec: rsRemainder(data, ecLen) });
  }
  const out: number[] = [];
  for (let i = 0; i < Math.max(d1, d2); i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]!);
  for (let i = 0; i < ecLen; i++) for (const b of blocks) out.push(b.ec[i]!);

  // Function patterns.
  const m: (boolean | null)[][] = Array.from({ length: size }, () => new Array<boolean | null>(size).fill(null));
  const reserved: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (r: number, c: number, dark: boolean) => { if (r >= 0 && c >= 0 && r < size && c < size) { m[r]![c] = dark; reserved[r]![c] = true; } };
  const finder = (r0: number, c0: number) => {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const inside = r >= 0 && r <= 6 && c >= 0 && c <= 6;
      set(r0 + r, c0 + c, inside && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4)));
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
  const pos = ALIGN[version - 1]!;
  for (const r of pos) for (const c of pos) {
    if (reserved[r]![c]) continue; // under a finder
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
  }
  for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  set(size - 8, 8, true); // the dark module
  // Reserve the format areas (written later) and the version areas.
  for (let i = 0; i < 9; i++) { if (!reserved[8]![i]) set(8, i, false); if (!reserved[i]![8]) set(i, 8, false); }
  for (let i = 0; i < 8; i++) { set(8, size - 1 - i, false); set(size - 1 - i, 8, false); }
  set(size - 8, 8, true);
  if (version >= 7) {
    const info = bch(version, 0x1f25, 13, 12) | (version << 12);
    for (let i = 0; i < 18; i++) { const bit = ((info >> i) & 1) === 1; set(Math.floor(i / 3), size - 11 + (i % 3), bit); set(size - 11 + (i % 3), Math.floor(i / 3), bit); }
  }

  // Data placement, zig-zag from the bottom right.
  const stream: number[] = [];
  out.forEach((b) => { for (let i = 7; i >= 0; i--) stream.push((b >> i) & 1); });
  const cells: [number, number][] = [];
  for (let c = size - 1, up = true; c > 0; c -= 2, up = !up) {
    if (c === 6) c--;
    for (let k = 0; k < size; k++) {
      const r = up ? size - 1 - k : k;
      for (const cc of [c, c - 1]) if (!reserved[r]![cc]) cells.push([r, cc]);
    }
  }
  const MASKS: ((r: number, c: number) => boolean)[] = [
    (r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (_r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0, (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];

  const build = (mask: number): boolean[][] => {
    const g = m.map((row) => row.map((v) => v === true));
    cells.forEach(([r, c], i) => { g[r]![c] = ((stream[i] ?? 0) === 1) !== MASKS[mask]!(r, c); });
    const fmt = (((LEVEL_BITS[level] << 3) | mask) << 10 | bch((LEVEL_BITS[level] << 3) | mask, 0x537, 11, 10)) ^ 0x5412;
    const bit = (i: number) => ((fmt >> i) & 1) === 1;
    for (let i = 0; i < 15; i++) {
      // First copy around the top-left finder, second copy split between the other two.
      if (i < 6) g[i]![8] = bit(i); else if (i < 8) g[i + 1]![8] = bit(i); else if (i === 8) g[8]![7] = bit(i); else g[8]![14 - i] = bit(i);
      if (i < 8) g[8]![size - 1 - i] = bit(i); else g[size - 15 + i]![8] = bit(i);
    }
    g[size - 8]![8] = true;
    return g;
  };
  let best: boolean[][] | null = null, bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const g = build(mask);
    const s = penalty(g);
    if (s < bestScore) { bestScore = s; best = g; }
  }
  return best!;
}

/** The longest text, in bytes, that `level` can hold. */
export function qrCapacity(level: QrLevel): number {
  return dataCodewords(level, 10) - 3;
}

function penalty(g: boolean[][]): number {
  const n = g.length;
  let score = 0;
  const line = (get: (i: number) => boolean) => {
    let run = 1;
    for (let i = 1; i < n; i++) {
      if (get(i) === get(i - 1)) { run++; if (run === 5) score += 3; else if (run > 5) score++; } else run = 1;
    }
    const s = Array.from({ length: n }, (_, i) => (get(i) ? "1" : "0")).join("");
    for (const p of ["10111010000", "00001011101"]) for (let i = s.indexOf(p); i >= 0; i = s.indexOf(p, i + 1)) score += 40;
  };
  for (let r = 0; r < n; r++) line((i) => g[r]![i]!);
  for (let c = 0; c < n; c++) line((i) => g[i]![c]!);
  for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) {
    const v = g[r]![c]; if (v === g[r]![c + 1] && v === g[r + 1]![c] && v === g[r + 1]![c + 1]) score += 3;
  }
  const dark = g.reduce((a, row) => a + row.filter(Boolean).length, 0);
  score += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
  return score;
}

/** Rectangles (module units) covering the dark modules: one per horizontal run. */
export function qrRuns(matrix: boolean[][]): { x: number; y: number; width: number }[] {
  const runs: { x: number; y: number; width: number }[] = [];
  matrix.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (!row[x]) continue;
      let w = 1;
      while (x + w < row.length && row[x + w]) w++;
      runs.push({ x, y, width: w });
      x += w;
    }
  });
  return runs;
}
