import { describe, it, expect } from "vitest";
import { crc32, dosDateTime, makeZip, safePath } from "./zip";

const enc = (s: string) => new TextEncoder().encode(s);

// Un lettore minimo di zip, scritto qui e indipendente dallo scrittore: legge
// dalla END OF CENTRAL DIRECTORY (la strada che usano unzip e i browser), non dai
// local header, quindi se gli offset o le dimensioni sono sbagliati il test fallisce.
interface Read { path: string; data: Uint8Array; method: number; crcOk: boolean; flags: number }
function readZip(zip: Uint8Array): Read[] {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let e = zip.length - 22;
  while (e >= 0 && v.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error("niente EOCD");
  const n = v.getUint16(e + 10, true);
  let p = v.getUint32(e + 16, true);
  const out: Read[] = [];
  for (let i = 0; i < n; i++) {
    expect(v.getUint32(p, true)).toBe(0x02014b50);
    const flags = v.getUint16(p + 8, true);
    const method = v.getUint16(p + 10, true);
    const crc = v.getUint32(p + 16, true);
    const csize = v.getUint32(p + 20, true);
    const usize = v.getUint32(p + 24, true);
    const nlen = v.getUint16(p + 28, true);
    const xlen = v.getUint16(p + 30, true);
    const clen = v.getUint16(p + 32, true);
    const lho = v.getUint32(p + 42, true);
    const path = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nlen));
    // local header: stessi nome e dimensioni, dati subito dopo
    expect(v.getUint32(lho, true)).toBe(0x04034b50);
    expect(v.getUint16(lho + 26, true)).toBe(nlen);
    const start = lho + 30 + nlen + v.getUint16(lho + 28, true);
    const data = zip.subarray(start, start + csize);
    expect(csize).toBe(usize);
    out.push({ path, data, method, flags, crcOk: crc32(data) === crc });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

describe("crc32", () => {
  it.each([
    ["", 0x00000000],
    ["a", 0xe8b7be43],
    ["123456789", 0xcbf43926],
    ["The quick brown fox jumps over the lazy dog", 0x414fa339],
  ])("crc32(%j) = %s", (s, want) => expect(crc32(enc(s))).toBe(want));

  it("è un uint32 senza segno anche con byte alti", () => {
    expect(crc32(new Uint8Array([255, 255, 255, 255]))).toBe(0xffffffff);
  });
});

describe("safePath", () => {
  it.each([
    ["src/App.tsx", "src/App.tsx"],
    ["/etc/passwd", "etc/passwd"],
    ["../../x", "x"],
    ["a//b/./c", "a/b/c"],
    ["a\\b", "a/b"],
    ["..", ""],
  ])("%j -> %j", (a, b) => expect(safePath(a)).toBe(b));
});

describe("dosDateTime", () => {
  it("codifica anno-1980, mese, giorno, ore, minuti, secondi/2", () => {
    const { time, date } = dosDateTime(new Date(2026, 9, 3, 14, 30, 10));
    expect(date).toBe(((2026 - 1980) << 9) | (10 << 5) | 3);
    expect(time).toBe((14 << 11) | (30 << 5) | 5);
  });
});

describe("makeZip", () => {
  it("un archivio vuoto è solo l'EOCD (22 byte)", () => {
    const z = makeZip([]);
    expect(z).toHaveLength(22);
    expect(readZip(z)).toEqual([]);
  });

  it("round trip: nomi, byte, CRC, metodo store, nomi UTF-8", () => {
    const bin = Uint8Array.from({ length: 300 }, (_, i) => (i * 7) & 255);
    const files = [
      { path: "package.json", data: enc('{"a":1}') },
      { path: "src/screens/Città.tsx", data: enc("export default function Città() {}\n") },
      { path: "public/assets/x.png", data: bin },
      { path: "vuoto.txt", data: new Uint8Array(0) },
    ];
    const got = readZip(makeZip(files, new Date(2026, 0, 2, 3, 4, 6)));
    expect(got.map((g) => g.path)).toEqual(files.map((f) => f.path));
    for (let i = 0; i < files.length; i++) {
      expect(Array.from(got[i].data)).toEqual(Array.from(files[i].data));
      expect(got[i].crcOk).toBe(true);
      expect(got[i].method).toBe(0);
      expect(got[i].flags & 0x0800).toBe(0x0800);
    }
  });

  it("scarta i percorsi vuoti e i doppioni, e neutralizza '..' e '/'", () => {
    const got = readZip(makeZip([
      { path: "a.txt", data: enc("1") },
      { path: "a.txt", data: enc("2") },
      { path: "", data: enc("3") },
      { path: "../../evil.txt", data: enc("4") },
    ]));
    expect(got.map((g) => g.path)).toEqual(["a.txt", "evil.txt"]);
    expect(new TextDecoder().decode(got[0].data)).toBe("1");
  });

  it("l'archivio ha le dimensioni attese: header + nome + dati, poi la directory", () => {
    const z = makeZip([{ path: "ab", data: enc("xyz") }]);
    // local: 30+2+3 = 35; central: 46+2 = 48; eocd: 22
    expect(z).toHaveLength(35 + 48 + 22);
    const v = new DataView(z.buffer);
    expect(v.getUint32(35, true)).toBe(0x02014b50);
    expect(v.getUint32(35 + 48 + 16, true)).toBe(35); // offset della central directory
  });
});
