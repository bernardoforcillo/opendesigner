// UN SCRITTORE DI ZIP senza dipendenze: metodo "store" (nessuna compressione) +
// CRC-32. Per un progetto generato (decine di file di testo) la compressione
// risparmierebbe poco e costerebbe una libreria; lo zip "stored" lo aprono tutti
// (unzip, Finder, Explorer). Formato: PKWARE APPNOTE 6.3 -- per ogni file un
// local header + dati, poi la central directory, poi l'End Of Central Directory.
// Niente ZIP64: un export supera 4 GB solo per un errore, e lo si dichiara.

export interface ZipEntry {
  /** Percorso relativo con "/" (mai assoluto, mai "..": lo garantisce `safePath`). */
  path: string;
  data: Uint8Array;
}

const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (IEEE 802.3, il polinomio dello zip): crc32("123456789") = 0xCBF43926. */
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Data e ora nel formato MS-DOS dello zip (granularità 2 s, anni dal 1980). */
export function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Un percorso che non esce dalla cartella dello zip: niente "/" iniziale, "..", "\\" o segmenti vuoti. */
export function safePath(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/").filter((s) => s !== "" && s !== "." && s !== "..");
  return parts.join("/");
}

const UTF8 = new TextEncoder();

export function makeZip(entries: readonly ZipEntry[], when: Date = new Date()): Uint8Array {
  const { time, date } = dosDateTime(when);
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  let count = 0;
  const seen = new Set<string>();
  for (const e of entries) {
    const path = safePath(e.path);
    if (path === "" || seen.has(path)) continue; // un nome vuoto o doppio corromperebbe l'archivio
    seen.add(path);
    const name = UTF8.encode(path);
    const crc = crc32(e.data);
    const size = e.data.length;

    // Local file header (30 byte + nome). Bit 11 dei flag = nome in UTF-8.
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true); // versione minima: 2.0
    lh.setUint16(6, 0x0800, true);
    lh.setUint16(8, 0, true); // metodo 0 = store
    lh.setUint16(10, time, true);
    lh.setUint16(12, date, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, size, true);
    lh.setUint32(22, size, true);
    lh.setUint16(26, name.length, true);
    lh.setUint16(28, 0, true);
    chunks.push(new Uint8Array(lh.buffer), name, e.data);

    // Voce della central directory (46 byte + nome).
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true); // creato con
    ch.setUint16(6, 20, true); // versione minima
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true);
    ch.setUint16(12, time, true);
    ch.setUint16(14, date, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, size, true);
    ch.setUint32(24, size, true);
    ch.setUint16(28, name.length, true);
    // 30..37: extra, commento, disco, attributi interni = 0
    ch.setUint32(38, 0, true); // attributi esterni
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);

    offset += 30 + name.length + size;
    count++;
  }
  const cdSize = central.reduce((a, c) => a + c.length, 0);
  if (offset + cdSize > 0xffffffff || count > 0xffff) throw new Error("zip troppo grande (ZIP64 non supportato)");

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, count, true);
  end.setUint16(10, count, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);

  const out = new Uint8Array(offset + cdSize + 22);
  let p = 0;
  for (const c of [...chunks, ...central, new Uint8Array(end.buffer)]) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

/** Fa scaricare `bytes` come file. In ambienti senza DOM (test) non fa niente e lo dice. */
export function downloadBytes(filename: string, bytes: Uint8Array, mime = "application/zip"): boolean {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}
