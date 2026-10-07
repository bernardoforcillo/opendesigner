// A minimal PNG ENCODER, for what the SVG export has to embed without a canvas (a mesh gradient's
// bitmap): 8-bit RGBA, no filtering, zlib "stored" blocks (no compression). The images are a few
// KB, so compression would buy nothing, and a pure function is the same in a browser, a worker and
// a test.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const u32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

function chunk(type: string, data: Uint8Array): Uint8Array {
  const body = new Uint8Array(4 + data.length);
  for (let i = 0; i < 4; i++) body[i] = type.charCodeAt(i);
  body.set(data, 4);
  return Uint8Array.from([...u32(data.length), ...body, ...u32(crc32(body))]);
}

/** The bytes of a PNG for `rgba` (width * height * 4, straight alpha). */
export function encodePng(width: number, height: number, rgba: Uint8ClampedArray | Uint8Array): Uint8Array {
  if (rgba.length !== width * height * 4) throw new Error("encodePng: the pixel data does not match the size");
  // Each scanline is prefixed with its filter type (0 = none).
  const raw = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const blocks: number[] = [0x78, 0x01];
  for (let i = 0; i < raw.length || i === 0; i += 65535) {
    const n = Math.min(65535, raw.length - i);
    const last = i + n >= raw.length ? 1 : 0;
    blocks.push(last, n & 255, n >>> 8, ~n & 255, (~n >>> 8) & 255);
    for (let k = 0; k < n; k++) blocks.push(raw[i + k]);
    if (last) break;
  }
  blocks.push(...u32(adler32(raw)));
  const ihdr = Uint8Array.from([...u32(width), ...u32(height), 8, 6, 0, 0, 0]);
  const parts = [
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", Uint8Array.from(blocks)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** `data:image/png;base64,...` for the bytes of a PNG. */
export function pngDataUri(png: Uint8Array): string {
  let s = "";
  for (let i = 0; i < png.length; i += 0x8000) s += String.fromCharCode(...png.subarray(i, i + 0x8000));
  return `data:image/png;base64,${btoa(s)}`;
}
