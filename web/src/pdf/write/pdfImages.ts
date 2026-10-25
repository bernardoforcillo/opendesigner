import { type PdfFile } from "./pdfFile";

// IMAGES IN A PDF. JPEGs go in untouched (DCTDecode: no re-encoding, no quality loss, and CMYK
// JPEGs stay CMYK). PNGs without transparency or interlacing go in as their own Flate data with a
// PNG predictor -- again no decode. Everything else (alpha, interlaced, WebP, GIF...) needs pixels, so
// it is rasterized by a caller-supplied function (a canvas in the browser) and written as raw RGB plus
// a soft mask for the alpha.

export interface Pixels { width: number; height: number; rgba: Uint8ClampedArray | Uint8Array }
export type Rasterize = (bytes: Uint8Array, mime: string) => Promise<Pixels | null>;

export type PreparedImage =
  | { kind: "jpeg"; width: number; height: number; bytes: Uint8Array; components: 1 | 3 | 4; invertedCmyk: boolean }
  | { kind: "png"; width: number; height: number; idat: Uint8Array; colors: 1 | 3; bits: number; palette?: Uint8Array }
  | { kind: "rgba"; width: number; height: number; rgba: Uint8ClampedArray | Uint8Array };

/** Bytes and MIME of a `data:` URI, or null when it is not a base64 one. */
export function dataUrlBytes(uri: string): { bytes: Uint8Array; mime: string } | null {
  const m = /^data:([^;,]*)(;[^,]*)?,(.*)$/s.exec(uri);
  if (!m) return null;
  try {
    if (m[2]?.includes("base64")) {
      const bin = atob(m[3]!);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return { bytes, mime: m[1]! };
    }
    return { bytes: new TextEncoder().encode(decodeURIComponent(m[3]!)), mime: m[1]! };
  } catch {
    return null;
  }
}

function jpegInfo(b: Uint8Array): Extract<PreparedImage, { kind: "jpeg" }> | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let adobe = false;
  let o = 2;
  while (o + 4 < b.length) {
    if (b[o] !== 0xff) { o++; continue; }
    const marker = b[o + 1]!;
    if (marker === 0xff) { o++; continue; }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { o += 2; continue; }
    const len = (b[o + 2]! << 8) | b[o + 3]!;
    if (marker === 0xee && len >= 12 && String.fromCharCode(...b.subarray(o + 4, o + 9)) === "Adobe") adobe = true;
    const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (sof) {
      const height = (b[o + 5]! << 8) | b[o + 6]!, width = (b[o + 7]! << 8) | b[o + 8]!, comps = b[o + 9]!;
      if (comps !== 1 && comps !== 3 && comps !== 4) return null;
      if (width === 0 || height === 0) return null;
      return { kind: "jpeg", width, height, bytes: b, components: comps, invertedCmyk: adobe && comps === 4 };
    }
    o += 2 + len;
  }
  return null;
}

function pngInfo(b: Uint8Array): Extract<PreparedImage, { kind: "png" }> | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 33 || sig.some((v, i) => b[i] !== v)) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let width = 0, height = 0, bits = 0, colorType = -1, interlace = 0;
  let palette: Uint8Array | undefined;
  const idat: Uint8Array[] = [];
  let o = 8;
  while (o + 12 <= b.length) {
    const len = v.getUint32(o);
    const type = String.fromCharCode(b[o + 4]!, b[o + 5]!, b[o + 6]!, b[o + 7]!);
    const data = b.subarray(o + 8, o + 8 + len);
    if (type === "IHDR") { width = v.getUint32(o + 8); height = v.getUint32(o + 12); bits = b[o + 16]!; colorType = b[o + 17]!; interlace = b[o + 20]!; }
    else if (type === "PLTE") palette = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    o += 12 + len;
  }
  // Only the colour types a PDF reads straight from PNG data: grey (0), RGB (2), palette (3).
  if (interlace !== 0 || ![0, 2, 3].includes(colorType) || width === 0 || height === 0 || idat.length === 0) return null;
  if (colorType === 3 && !palette) return null;
  const all = new Uint8Array(idat.reduce((s, d) => s + d.length, 0));
  let p = 0;
  for (const d of idat) { all.set(d, p); p += d.length; }
  return { kind: "png", width, height, idat: all, bits, colors: colorType === 2 ? 3 : 1, ...(colorType === 3 ? { palette } : {}) };
}

/** Reads an image's bytes into something the writer can place; null if unusable. */
export async function prepareImage(bytes: Uint8Array, mime: string, rasterize?: Rasterize): Promise<PreparedImage | null> {
  const direct = jpegInfo(bytes) ?? pngInfo(bytes);
  if (direct) return direct;
  const px = rasterize ? await rasterize(bytes, mime) : null;
  return px && px.width > 0 && px.height > 0 ? { kind: "rgba", width: px.width, height: px.height, rgba: px.rgba } : null;
}

/** Writes an image once and returns its XObject number. */
export function writeImage(file: PdfFile, img: PreparedImage): number {
  const base = `/Type/XObject/Subtype/Image/Width ${img.width}/Height ${img.height}`;
  if (img.kind === "jpeg") {
    const cs = img.components === 1 ? "/DeviceGray" : img.components === 3 ? "/DeviceRGB" : "/DeviceCMYK";
    return file.stream(`${base}/ColorSpace${cs}/BitsPerComponent 8/Filter/DCTDecode${img.invertedCmyk ? "/Decode[1 0 1 0 1 0 1 0]" : ""}`, img.bytes, false);
  }
  if (img.kind === "png") {
    let cs = img.colors === 3 ? "/DeviceRGB" : "/DeviceGray";
    if (img.palette) {
      const hex = Array.from(img.palette, (v) => v.toString(16).padStart(2, "0")).join("");
      cs = `[/Indexed/DeviceRGB ${img.palette.length / 3 - 1}<${hex}>]`;
    }
    return file.stream(
      `${base}/ColorSpace${cs}/BitsPerComponent ${img.bits}/Filter/FlateDecode/DecodeParms<</Predictor 15/Colors ${img.palette ? 1 : img.colors}/BitsPerComponent ${img.bits}/Columns ${img.width}>>`,
      img.idat, false,
    );
  }
  const n = img.width * img.height;
  const rgb = new Uint8Array(n * 3);
  let alpha: Uint8Array | null = null;
  for (let i = 0; i < n; i++) {
    rgb[i * 3] = img.rgba[i * 4]!; rgb[i * 3 + 1] = img.rgba[i * 4 + 1]!; rgb[i * 3 + 2] = img.rgba[i * 4 + 2]!;
    const a = img.rgba[i * 4 + 3]!;
    if (a !== 255) (alpha ??= new Uint8Array(n).fill(255))[i] = a;
  }
  const mask = alpha ? file.stream(`/Type/XObject/Subtype/Image/Width ${img.width}/Height ${img.height}/ColorSpace/DeviceGray/BitsPerComponent 8`, alpha) : null;
  return file.stream(`${base}/ColorSpace/DeviceRGB/BitsPerComponent 8${mask ? `/SMask ${mask} 0 R` : ""}`, rgb);
}

/** Effective resolution of an image drawn into a box of `w` x `h` document units (96 per inch). */
export function effectivePpi(img: { width: number; height: number }, w: number, h: number): number {
  if (!(w > 0) || !(h > 0)) return Infinity;
  return Math.min((img.width / w) * 96, (img.height / h) * 96);
}

