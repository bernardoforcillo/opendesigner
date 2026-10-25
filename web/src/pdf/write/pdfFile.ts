// A MINIMAL PDF FILE WRITER: numbered objects, streams (Flate when the browser can, else stored
// deflate blocks, both valid), a classic cross-reference table, trailer, document ID. It knows
// nothing about pages, fonts or colour -- those are the modules next to it -- only how the bytes of
// a PDF are laid out, so that the rest can be tested on the objects it produces.

const enc = new TextEncoder();

/** A number as PDF writes it: no exponent, at most 4 decimals, no trailing zeros. */
export function num(v: number): string {
  if (!Number.isFinite(v)) return "0";
  const s = (Math.round(v * 10000) / 10000).toFixed(4).replace(/\.?0+$/, "");
  return s === "-0" || s === "" ? "0" : s;
}

/** A name object (`/Foo`); anything outside the regular printable range is #-escaped. */
export function pdfName(s: string): string {
  let out = "/";
  for (const b of enc.encode(s)) {
    out += b < 0x21 || b > 0x7e || "#()<>[]{}/%".includes(String.fromCharCode(b)) ? `#${b.toString(16).padStart(2, "0")}` : String.fromCharCode(b);
  }
  return out;
}

/** A text string: a plain literal for ASCII, UTF-16BE with a BOM otherwise. */
export function pdfText(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return `(${s.replace(/[\\()]/g, "\\$&")})`;
  let hex = "FEFF";
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).padStart(4, "0");
  return `<${hex.toUpperCase()}>`;
}

/** A PDF date (`D:YYYYMMDDHHmmSSZ`). */
export function pdfDate(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `D:${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

export function adler32(data: Uint8Array): number {
  let a = 1, b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]!) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** A zlib stream made of STORED deflate blocks: valid everywhere, no compression. */
export function storedZlib(data: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(data.length / 65535));
  const out = new Uint8Array(2 + data.length + blocks * 5 + 4);
  out[0] = 0x78; out[1] = 0x01;
  let o = 2;
  for (let i = 0; i < blocks; i++) {
    const chunk = data.subarray(i * 65535, Math.min(data.length, (i + 1) * 65535));
    out[o++] = i === blocks - 1 ? 1 : 0;
    out[o++] = chunk.length & 0xff; out[o++] = chunk.length >> 8;
    out[o++] = ~chunk.length & 0xff; out[o++] = (~chunk.length >> 8) & 0xff;
    out.set(chunk, o); o += chunk.length;
  }
  new DataView(out.buffer).setUint32(o, adler32(data));
  return out;
}

/** Flate through the platform's CompressionStream when there is one, else stored blocks. */
export async function zlib(data: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === "undefined") return storedZlib(data);
  try {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return storedZlib(data);
  }
}

interface Entry { dict: string; data?: Uint8Array; compress?: boolean }

/** A PDF under construction. Ids are allocated up front so objects can reference each other in any order. */
export class PdfFile {
  private entries: (Entry | undefined)[] = [undefined];

  /** Reserves an object number to be filled in later with `set`. */
  alloc(): number {
    this.entries.push(undefined);
    return this.entries.length - 1;
  }

  /** Fills object `id` with a body (a dictionary, array, number...). */
  set(id: number, body: string): number {
    this.entries[id] = { dict: body };
    return id;
  }

  add(body: string): number {
    return this.set(this.alloc(), body);
  }

  /** A stream object. `dict` holds the entries WITHOUT /Length and /Filter; `compress` (default true) Flate-encodes the bytes. */
  stream(dict: string, data: Uint8Array | string, compress = true, id = this.alloc()): number {
    this.entries[id] = { dict, data: typeof data === "string" ? enc.encode(data) : data, compress };
    return id;
  }

  ref = (id: number) => `${id} 0 R`;

  get count(): number {
    return this.entries.length - 1;
  }

  /** The finished file. `info` and `fileId` are optional trailer entries. */
  async build(root: number, opts: { info?: number; fileId?: string; header?: string } = {}): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    let size = 0;
    const push = (b: Uint8Array | string) => {
      const u = typeof b === "string" ? latin1(b) : b;
      parts.push(u);
      size += u.length;
    };
    push(opts.header ?? "%PDF-1.7\n");
    // The binary marker: four high bytes tell transfer tools this is not text.
    push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
    const offsets: number[] = [0];
    for (let id = 1; id < this.entries.length; id++) {
      const e = this.entries[id];
      if (!e) throw new Error(`pdf object ${id} was allocated but never filled`);
      offsets[id] = size;
      if (e.data === undefined) {
        push(`${id} 0 obj\n${e.dict}\nendobj\n`);
        continue;
      }
      const body = e.compress === false ? e.data : await zlib(e.data);
      push(`${id} 0 obj\n<<${e.dict}${e.compress === false ? "" : "/Filter/FlateDecode"}/Length ${body.length}>>\nstream\n`);
      push(body);
      push("\nendstream\nendobj\n");
    }
    const xref = size;
    let table = `xref\n0 ${this.entries.length}\n0000000000 65535 f \n`;
    for (let id = 1; id < this.entries.length; id++) table += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
    push(table);
    const fid = (opts.fileId ?? "opendesigner").padEnd(16, "0");
    const hex = Array.from(enc.encode(fid).subarray(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
    push(`trailer\n<</Size ${this.entries.length}/Root ${root} 0 R${opts.info ? `/Info ${opts.info} 0 R` : ""}/ID[<${hex}><${hex}>]>>\nstartxref\n${xref}\n%%EOF\n`);
    const out = new Uint8Array(size);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
}

/** The bytes of a string whose characters are all < 256. */
export function latin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}
