// A MINIMAL ZIP READER for the Office formats we place (docx, xlsx) and for IDML: stored and deflate entries, found through the
// central directory. Deflate goes through the platform's DecompressionStream (browsers and Node), so no dependency is added.

export class ZipError extends Error {}

const MAX_ENTRY = 64 * 1024 * 1024;

async function inflateRaw(data: Uint8Array, expected: number): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(data); c.close(); } });
  const stream = source.pipeThrough(new DecompressionStream("deflate-raw") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  if (out.length > MAX_ENTRY || (expected > 0 && out.length !== expected)) throw new ZipError("a zip entry has the wrong size");
  return out;
}

/** The entries of a zip as a name -> bytes map (decompressed lazily on `read`). */
export function openZip(bytes: Uint8Array): { names: string[]; read(name: string): Promise<Uint8Array | null> } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) if (v.getUint32(i, true) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new ZipError("not a zip file");
  const count = v.getUint16(end + 10, true);
  let p = v.getUint32(end + 16, true);
  const entries = new Map<string, { method: number; csize: number; usize: number; offset: number }>();
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || v.getUint32(p, true) !== 0x02014b50) throw new ZipError("damaged zip directory");
    const method = v.getUint16(p + 10, true), csize = v.getUint32(p + 20, true), usize = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true), extraLen = v.getUint16(p + 30, true), commentLen = v.getUint16(p + 32, true);
    const offset = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, { method, csize, usize, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    names: [...entries.keys()],
    async read(name) {
      const e = entries.get(name);
      if (!e) return null;
      if (e.usize > MAX_ENTRY) throw new ZipError("a zip entry is too large");
      if (e.offset + 30 > bytes.length || v.getUint32(e.offset, true) !== 0x04034b50) throw new ZipError("damaged zip entry");
      const start = e.offset + 30 + v.getUint16(e.offset + 26, true) + v.getUint16(e.offset + 28, true);
      const raw = bytes.subarray(start, start + e.csize);
      if (e.method === 0) return raw.slice();
      if (e.method === 8) return inflateRaw(raw, e.usize);
      throw new ZipError(`unsupported zip compression ${e.method}`);
    },
  };
}

/** One entry as text (UTF-8), or null when absent. */
export async function readZipText(zip: ReturnType<typeof openZip>, name: string): Promise<string | null> {
  const b = await zip.read(name);
  return b ? new TextDecoder().decode(b) : null;
}
