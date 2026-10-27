import type { FontLite, TextStyleLite } from "@/store/types";
import { fontFamilyOf, fontWeightOf } from "@/renderer/text";
import { sfntKind, sfntTables, unicodeCmap } from "@/pdf/sfnt";
import { num, pdfName, type PdfFile } from "@/pdf/write/pdfFile";

// FONTS IN A PDF. An UPLOADED font (a FontFace asset of the document) is embedded whole as a CID font
// with Identity-H encoding, so the file draws the same glyphs on any machine; its width table and a
// ToUnicode map are written so text stays searchable and copyable. Anything else falls back to the
// standard-14 faces (Helvetica / Times / Courier, WinAnsi), which every viewer has but which are NOT
// embedded -- the preflight reports those. Honest limits: no subsetting (the full font program goes
// in), no OpenType layout (ligatures, alternates) and no variable-font instancing.

export interface FontMetrics {
  unitsPerEm: number; ascent: number; descent: number; capHeight: number;
  bbox: [number, number, number, number]; numGlyphs: number; cff: boolean;
  glyph(cp: number): number; advance(gid: number): number;
}

/** What the PDF font descriptor needs from an sfnt, or null when the data is not a usable font. */
export function readFontMetrics(data: Uint8Array): FontMetrics | null {
  const kind = sfntKind(data);
  const cmap = unicodeCmap(data);
  if (!kind || !cmap) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  try {
    const t = sfntTables(v);
    const head = t.get("head"), hhea = t.get("hhea"), maxp = t.get("maxp"), hmtx = t.get("hmtx");
    if (!head || !hhea || !maxp || !hmtx) return null;
    const unitsPerEm = v.getUint16(head.offset + 18) || 1000;
    const numGlyphs = v.getUint16(maxp.offset + 4);
    const nHM = v.getUint16(hhea.offset + 34);
    const os2 = t.get("OS/2");
    const capHeight = os2 && os2.length >= 90 && v.getUint16(os2.offset) >= 2 ? v.getInt16(os2.offset + 88) : v.getInt16(hhea.offset + 4);
    return {
      unitsPerEm, numGlyphs, cff: kind === "otf", capHeight,
      ascent: v.getInt16(hhea.offset + 4), descent: v.getInt16(hhea.offset + 6),
      bbox: [v.getInt16(head.offset + 36), v.getInt16(head.offset + 38), v.getInt16(head.offset + 40), v.getInt16(head.offset + 42)],
      glyph: cmap,
      advance: (gid) => (nHM === 0 ? 0 : v.getUint16(hmtx.offset + Math.min(gid, nHM - 1) * 4)),
    };
  } catch {
    return null;
  }
}

// --- the standard faces ---------------------------------------------------------------------------

type Base = "Helvetica" | "Times" | "Courier";

function baseOf(family: string): Base {
  const f = family.toLowerCase();
  if (/mono|courier|consolas|menlo|code/.test(f)) return "Courier";
  if (/sans|helvetica|arial|inter|verdana|tahoma|segoe|roboto|system-ui/.test(f)) return "Helvetica";
  if (/serif|times|georgia|garamond|palatino|cambria|book/.test(f)) return "Times";
  return "Helvetica";
}

export function standardFontName(style: TextStyleLite): string {
  const base = baseOf(fontFamilyOf(style));
  const bold = Number(fontWeightOf(style)) >= 600 || /bold/i.test(fontWeightOf(style));
  const italic = style.italic === true;
  if (base === "Times") return bold ? (italic ? "Times-BoldItalic" : "Times-Bold") : italic ? "Times-Italic" : "Times-Roman";
  const stem = base;
  const slant = base === "Courier" || base === "Helvetica" ? "Oblique" : "Italic";
  return bold ? (italic ? `${stem}-Bold${slant}` : `${stem}-Bold`) : italic ? `${stem}-${slant}` : stem;
}

// Unicode -> WinAnsi for the 0x80..0x9f block; everything else in Latin-1 maps to itself.
const WIN_ANSI_EXTRA: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88,
  0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93,
  0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
  0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

function winAnsi(cp: number): number | null {
  if (cp >= 0x20 && cp < 0x7f) return cp;
  if (cp >= 0xa0 && cp <= 0xff) return cp;
  return WIN_ANSI_EXTRA[cp] ?? null;
}

const literal = (bytes: number[]) =>
  "(" + bytes.map((b) => (b === 0x28 || b === 0x29 || b === 0x5c ? "\\" + String.fromCharCode(b) : b < 0x20 || b > 0x7e ? "\\" + b.toString(8).padStart(3, "0") : String.fromCharCode(b))).join("") + ")";

// --- one resolved face ----------------------------------------------------------------------------

export interface PdfFontRef {
  /** The resource name in page content (`F1`). */
  res: string;
  embedded: boolean;
  /** The text as a content-stream string operand. */
  encode(text: string): string;
}

interface Embedded {
  face: FontLite; data: Uint8Array; m: FontMetrics; res: string;
  used: Map<number, number>; // gid -> unicode
}

export class PdfFonts {
  private embedded = new Map<string, Embedded>();
  private standard = new Map<string, string>(); // base font -> resource name
  private n = 0;
  /** Faces the document uses that are not embedded, and characters an embedded font lacks: the preflight reads these. */
  readonly substituted = new Set<string>();
  readonly missingGlyphs = new Set<string>();

  /** `faces` are the document's uploaded fonts with their bytes already loaded. */
  constructor(private faces: readonly { face: FontLite; data: Uint8Array }[]) {}

  private match(style: TextStyleLite): { face: FontLite; data: Uint8Array } | null {
    const family = fontFamilyOf(style).split(",")[0]!.trim().replace(/^["']|["']$/g, "").toLowerCase();
    const weight = Number(fontWeightOf(style)) || 400;
    const italic = style.italic === true;
    let best: { face: FontLite; data: Uint8Array } | null = null, bestScore = Infinity;
    for (const f of this.faces) {
      if (f.face.family.toLowerCase() !== family) continue;
      const score = Math.abs((Number(f.face.weight) || 400) - weight) + ((f.face.style === "italic") === italic ? 0 : 1000);
      if (score < bestScore) { best = f; bestScore = score; }
    }
    return best;
  }

  fontFor(style: TextStyleLite): PdfFontRef {
    const hit = this.match(style);
    if (hit) {
      const m = readFontMetrics(hit.data);
      if (m) {
        let e = this.embedded.get(hit.face.id);
        if (!e) {
          e = { face: hit.face, data: hit.data, m, res: `F${++this.n}`, used: new Map() };
          this.embedded.set(hit.face.id, e);
        }
        const emb = e;
        return {
          res: emb.res, embedded: true,
          encode: (text) => {
            let hex = "";
            for (const ch of text) {
              const cp = ch.codePointAt(0)!;
              const gid = emb.m.glyph(cp);
              if (gid === 0 && ch.trim() !== "") this.missingGlyphs.add(`${hit.face.family}: ${ch}`);
              emb.used.set(gid, cp);
              hex += gid.toString(16).padStart(4, "0");
            }
            return `<${hex}>`;
          },
        };
      }
    }
    const name = standardFontName(style);
    this.substituted.add(`${fontFamilyOf(style).split(",")[0]!.trim()} → ${name}`);
    let res = this.standard.get(name);
    if (!res) { res = `F${++this.n}`; this.standard.set(name, res); }
    return {
      res, embedded: false,
      encode: (text) => {
        const bytes: number[] = [];
        for (const ch of text) bytes.push(winAnsi(ch.codePointAt(0)!) ?? 0x3f);
        return literal(bytes);
      },
    };
  }

  /** Writes every font object; returns the page-resource entries `/F1 12 0 R ...`. */
  emit(file: PdfFile): string {
    let out = "";
    for (const [name, res] of this.standard) {
      out += `${pdfName(res)} ${file.add(`<</Type/Font/Subtype/Type1/BaseFont${pdfName(name)}/Encoding/WinAnsiEncoding>>`)} 0 R`;
    }
    for (const e of this.embedded.values()) {
      const { m } = e;
      const k = 1000 / m.unitsPerEm;
      const ps = e.face.family.replace(/[^A-Za-z0-9]/g, "") + "-" + (e.face.weight || "400") + (e.face.style === "italic" ? "Italic" : "");
      const fileId = file.stream(m.cff ? "/Subtype/OpenType" : `/Length1 ${e.data.length}`, e.data);
      const desc = file.add(
        `<</Type/FontDescriptor/FontName${pdfName(ps)}/Flags 4/FontBBox[${m.bbox.map((b) => num(b * k)).join(" ")}]` +
        `/ItalicAngle ${e.face.style === "italic" ? -12 : 0}/Ascent ${num(m.ascent * k)}/Descent ${num(m.descent * k)}` +
        `/CapHeight ${num(m.capHeight * k)}/StemV 80/${m.cff ? "FontFile3" : "FontFile2"} ${fileId} 0 R>>`,
      );
      const gids = [...e.used.keys()].sort((a, b) => a - b);
      const w = gids.map((g) => `${g}[${num(m.advance(g) * k)}]`).join(" ");
      const cid = file.add(
        `<</Type/Font/Subtype/${m.cff ? "CIDFontType0" : "CIDFontType2"}/BaseFont${pdfName(ps)}` +
        `/CIDSystemInfo<</Registry(Adobe)/Ordering(Identity)/Supplement 0>>/FontDescriptor ${desc} 0 R/DW 1000/W[${w}]` +
        (m.cff ? "" : "/CIDToGIDMap/Identity") + ">>",
      );
      const uni = file.stream("", toUnicodeCMap(e.used), true);
      const type0 = file.add(`<</Type/Font/Subtype/Type0/BaseFont${pdfName(ps)}/Encoding/Identity-H/DescendantFonts[${cid} 0 R]/ToUnicode ${uni} 0 R>>`);
      out += `${pdfName(e.res)} ${type0} 0 R`;
    }
    return out;
  }
}

const hex4 = (n: number) => n.toString(16).padStart(4, "0");
const utf16hex = (cp: number) => (cp > 0xffff ? hex4(0xd800 + ((cp - 0x10000) >> 10)) + hex4(0xdc00 + ((cp - 0x10000) & 0x3ff)) : hex4(cp));

/** A ToUnicode CMap for the glyphs used: how a viewer turns glyph ids back into text for search and copy. */
export function toUnicodeCMap(used: ReadonlyMap<number, number>): string {
  const entries = [...used].filter(([g]) => g !== 0).sort((a, b) => a[0] - b[0]);
  const chunks: string[] = [];
  for (let i = 0; i < entries.length; i += 100) {
    const part = entries.slice(i, i + 100);
    chunks.push(`${part.length} beginbfchar\n${part.map(([g, cp]) => `<${hex4(g)}> <${utf16hex(cp)}>`).join("\n")}\nendbfchar`);
  }
  return (
    "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo<</Registry(Adobe)/Ordering(UCS)/Supplement 0>> def\n" +
    "/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n" +
    chunks.join("\n") + "\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n"
  );
}
