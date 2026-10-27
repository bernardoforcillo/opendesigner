import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";
import { openZip, readZipText } from "@/export/zipRead";
import { applyOp } from "@/store/applyOp";
import { orderKeyBetween } from "@/store/orderKey";
import { childrenOf } from "@/store/tree";
import { toPbNode, type NodeLite, type SceneState, type TextStyleDefLite, type TextStyleLite } from "@/store/types";
import { makeCreateNodeOp, makeSetTextOp, makeSetTextStyleDefOp, uuid } from "@/tools/ops";
import { createTableOps, readTable } from "@/tools/tableOps";

// PLACE WORD, RTF AND EXCEL. A Word or RTF file becomes ONE text frame whose paragraphs carry styles (headings get an outline level, so
// the table of contents sees them) and whose bold/italic runs carry character styles. An Excel sheet becomes a table. What is NOT
// carried over: images, tables and footnotes inside Word files, fonts and colours, page layout, formulas (Excel gives the cached values).

export interface PlacedParagraph { text: string; level: number; runs: { start: number; end: number; bold: boolean; italic: boolean }[] }

export class PlaceError extends Error {}

const MAX_PARAGRAPHS = 20000;

const decodeXml = (s: string) =>
  s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) throw new PlaceError("the file's XML is damaged");
  return doc;
}

const W = (el: Element, name: string) => [...el.children].filter((c) => c.localName === name);

/** The paragraphs of a .docx (body only: headings, text, bold and italic, line breaks, tabs). */
export async function parseDocx(bytes: Uint8Array): Promise<PlacedParagraph[]> {
  let zip;
  try { zip = openZip(bytes); } catch { throw new PlaceError("that is not a .docx file"); }
  const xml = await readZipText(zip, "word/document.xml");
  if (xml === null) throw new PlaceError("that is not a .docx file (no word/document.xml)");
  const body = parseXml(xml).getElementsByTagName("w:body")[0] ?? [...parseXml(xml).getElementsByTagName("*")].find((e) => e.localName === "body");
  if (!body) throw new PlaceError("the document has no body");
  const out: PlacedParagraph[] = [];
  const walk = (parent: Element) => {
    for (const el of parent.children) {
      if (el.localName === "p") {
        out.push(paragraphOf(el));
        if (out.length > MAX_PARAGRAPHS) throw new PlaceError("the document has too many paragraphs");
      } else if (el.localName === "tbl" || el.localName === "sdt" || el.localName === "sdtContent") walk(el);
      else if (el.localName === "tr" || el.localName === "tc") walk(el);
    }
  };
  walk(body);
  return out;
}

function paragraphOf(p: Element): PlacedParagraph {
  const pPr = W(p, "pPr")[0];
  const style = pPr ? W(pPr, "pStyle")[0]?.getAttribute("w:val") ?? W(pPr, "pStyle")[0]?.getAttribute("val") ?? "" : "";
  const m = /^(?:heading|titre|überschrift|intestazione)\s*(\d)$/i.exec(style) ?? (/^title$/i.test(style) ? [style, "1"] : null);
  const level = m ? Math.min(3, Number(m[1])) : 0;
  let text = "";
  const runs: PlacedParagraph["runs"] = [];
  const addRuns = (parent: Element) => {
    for (const r of parent.children) {
      if (r.localName === "hyperlink" || r.localName === "smartTag") { addRuns(r); continue; }
      if (r.localName !== "r") continue;
      const rPr = W(r, "rPr")[0];
      const on = (n: string) => { const e = rPr ? W(rPr, n)[0] : undefined; const v = e?.getAttribute("w:val") ?? e?.getAttribute("val"); return e !== undefined && v !== "0" && v !== "false"; };
      const start = text.length;
      for (const c of r.children) {
        if (c.localName === "t") text += c.textContent ?? "";
        else if (c.localName === "tab") text += "\t";
        else if (c.localName === "br" || c.localName === "cr") text += "\n";
      }
      const bold = on("b"), italic = on("i");
      if ((bold || italic) && text.length > start) runs.push({ start, end: text.length, bold, italic });
    }
  };
  addRuns(p);
  return { text: text.replace(/\n/g, " "), level, runs };
}

/** A small RTF reader: paragraphs, \b and \i toggles, \'xx and \uN escapes, \tab; groups for fonts, colours, headers and pictures are skipped. */
export function parseRtf(text: string): PlacedParagraph[] {
  if (!text.startsWith("{\\rtf")) throw new PlaceError("that is not an RTF file");
  const out: PlacedParagraph[] = [];
  let cur: PlacedParagraph = { text: "", level: 0, runs: [] };
  let bold = false, italic = false;
  const stack: { bold: boolean; italic: boolean; skip: boolean }[] = [];
  let skip = false;
  let runStart = -1;
  const SKIP = new Set(["fonttbl", "colortbl", "stylesheet", "info", "pict", "header", "footer", "footnote", "listtable", "listoverridetable", "generator", "themedata"]);
  const closeRun = () => { if (runStart >= 0 && cur.text.length > runStart && (bold || italic)) cur.runs.push({ start: runStart, end: cur.text.length, bold, italic }); runStart = -1; };
  const put = (s: string) => { if (skip) return; if (runStart < 0) runStart = cur.text.length; cur.text += s; };
  const endPara = () => { closeRun(); out.push(cur); cur = { text: "", level: 0, runs: [] }; if (out.length > MAX_PARAGRAPHS) throw new PlaceError("the document has too many paragraphs"); };
  let skipUc = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "{") { closeRun(); stack.push({ bold, italic, skip }); if (text[i + 1] === "\\" && text[i + 2] === "*") skip = true; }
    else if (ch === "}") { closeRun(); const s = stack.pop(); if (s) { bold = s.bold; italic = s.italic; skip = s.skip; } }
    else if (ch === "\\") {
      const next = text[i + 1] ?? "";
      if (next === "'") { const code = parseInt(text.slice(i + 2, i + 4), 16); if (skipUc > 0) skipUc--; else if (Number.isFinite(code)) put(new TextDecoder("windows-1252").decode(new Uint8Array([code]))); i += 3; continue; }
      if (/[\\{}]/.test(next)) { put(next); i++; continue; }
      if (next === "~") { put(" "); i++; continue; }
      if (next === "-" || next === "_") { put(next === "_" ? "‑" : ""); i++; continue; }
      const m = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(text.slice(i, i + 40));
      if (!m) continue;
      i += m[0].length - 1;
      const word = m[1]!, arg = m[2] === undefined ? undefined : Number(m[2]);
      if (SKIP.has(word) && stack.length > 0 && text[i - m[0].length] === "*") skip = true;
      if (SKIP.has(word)) skip = true;
      if (word === "par") endPara();
      else if (word === "line") put(" ");
      else if (word === "tab") put("\t");
      else if (word === "b" || word === "i") { closeRun(); if (word === "b") bold = arg !== 0; else italic = arg !== 0; }
      else if (word === "pard") { /* new paragraph defaults */ }
      else if (word === "u" && arg !== undefined) { put(String.fromCodePoint(arg < 0 ? arg + 65536 : arg)); skipUc = 1; }
      else if (word === "emdash") put("—");
      else if (word === "endash") put("–");
      else if (word === "bullet") put("•");
      else if (word === "lquote") put("‘");
      else if (word === "rquote") put("’");
      else if (word === "ldblquote") put("“");
      else if (word === "rdblquote") put("”");
      continue;
    } else if (ch !== "\r" && ch !== "\n") { if (skipUc > 0) { skipUc--; continue; } put(ch); }
  }
  if (cur.text !== "") endPara();
  return out;
}

/** The first sheet of an .xlsx as rows of cell text (shared strings and cached formula values; dates stay as their serial number). */
export async function parseXlsx(bytes: Uint8Array): Promise<string[][]> {
  let zip;
  try { zip = openZip(bytes); } catch { throw new PlaceError("that is not an .xlsx file"); }
  const wb = await readZipText(zip, "xl/workbook.xml");
  if (wb === null) throw new PlaceError("that is not an .xlsx file (no xl/workbook.xml)");
  const shared: string[] = [];
  const ss = await readZipText(zip, "xl/sharedStrings.xml");
  if (ss !== null) for (const si of parseXml(ss).getElementsByTagName("si")) shared.push([...si.getElementsByTagName("t")].map((t) => t.textContent ?? "").join(""));
  const sheetName = zip.names.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))[0];
  if (!sheetName) throw new PlaceError("the workbook has no worksheet");
  const sheet = parseXml((await readZipText(zip, sheetName))!);
  const rows: string[][] = [];
  const colIndex = (ref: string) => { let n = 0; for (const c of /^[A-Z]+/i.exec(ref)?.[0].toUpperCase() ?? "") n = n * 26 + c.charCodeAt(0) - 64; return n - 1; };
  for (const row of sheet.getElementsByTagName("row")) {
    const r = Number(row.getAttribute("r") ?? rows.length + 1) - 1;
    if (r < 0 || r > 9999) continue;
    const cells: string[] = [];
    for (const c of row.getElementsByTagName("c")) {
      const col = colIndex(c.getAttribute("r") ?? "A1");
      if (col < 0 || col > 999) continue;
      const t = c.getAttribute("t");
      const v = c.getElementsByTagName("v")[0]?.textContent ?? "";
      const value = t === "s" ? shared[Number(v)] ?? "" : t === "inlineStr" ? [...c.getElementsByTagName("t")].map((e) => e.textContent ?? "").join("") : v;
      cells[col] = decodeXml(value);
    }
    while (rows.length <= r) rows.push([]);
    rows[r] = Array.from(cells, (x) => x ?? "");
  }
  while (rows.length > 0 && rows.at(-1)!.every((c) => c === "")) rows.pop();
  if (rows.length === 0) throw new PlaceError("the first worksheet is empty");
  return rows;
}

// --- ops --------------------------------------------------------------------------------------------------------------------

const BODY: TextStyleLite = { fontFamily: "", fontSize: 12, fontWeight: "", lineHeight: 1.4, align: "left" };
export const PLACED_STYLES = { body: "placed-body", h: (n: number) => `placed-h${n}`, bold: "placed-bold", italic: "placed-italic", boldItalic: "placed-bold-italic" };

function styleDefs(): TextStyleDefLite[] {
  return [
    { id: PLACED_STYLES.body, name: "Body (placed)", style: BODY, spaceAfter: 6 },
    ...[1, 2, 3].map((n) => ({ id: PLACED_STYLES.h(n), name: `Heading ${n} (placed)`, style: { ...BODY, fontSize: [22, 18, 15][n - 1]!, fontWeight: "700" }, spaceBefore: 10, spaceAfter: 6, outlineLevel: n, keepWithNext: true })),
    { id: PLACED_STYLES.bold, name: "Bold (placed)", kind: "character" as const, style: { ...BODY, fontWeight: "700" } },
    { id: PLACED_STYLES.italic, name: "Italic (placed)", kind: "character" as const, style: { ...BODY, italic: true } },
    { id: PLACED_STYLES.boldItalic, name: "Bold italic (placed)", kind: "character" as const, style: { ...BODY, fontWeight: "700", italic: true } },
  ];
}

export interface PlacedText { ops: Op[]; nodeId: string; paragraphs: number }

/** One text frame with the paragraphs, sized to an estimated height (a long text may overflow: thread more frames). */
export function placeTextOps(scene: SceneState, paragraphs: readonly PlacedParagraph[], parentId: string, x: number, y: number, width: number): PlacedText | string {
  if (paragraphs.length === 0) return "there is no text to place";
  if (!(width >= 20) || !Number.isFinite(x) || !Number.isFinite(y)) return "width must be at least 20 and x, y numbers";
  let content = "";
  const styles: string[] = [];
  const runs: { start: number; end: number; styleId: string }[] = [];
  paragraphs.forEach((p, i) => {
    const at = content.length;
    content += (i > 0 ? "\n" : "") + p.text;
    const base = i > 0 ? at + 1 : at;
    styles.push(p.level > 0 ? PLACED_STYLES.h(p.level) : PLACED_STYLES.body);
    for (const r of p.runs) runs.push({ start: base + r.start, end: base + r.end, styleId: r.bold && r.italic ? PLACED_STYLES.boldItalic : r.bold ? PLACED_STYLES.bold : PLACED_STYLES.italic });
  });
  const perLine = Math.max(8, Math.floor(width / (BODY.fontSize * 0.5)));
  const lines = paragraphs.reduce((n, p) => n + Math.max(1, Math.ceil(p.text.length / perLine)), 0);
  const height = Math.max(40, lines * BODY.fontSize * BODY.lineHeight + paragraphs.length * 8);
  const top = childrenOf(scene, parentId).at(-1)?.orderKey ?? null;
  const node: NodeLite = {
    id: uuid(), parentId, orderKey: orderKeyBetween(top, null), name: "Placed text", visible: true, opacity: 1, x, y, width, height, rotation: 0,
    fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind: "text", cornerRadius: 0, clipsContent: false,
    text: { content: "", style: BODY },
  };
  const ops: Op[] = [...styleDefs().map(makeSetTextStyleDefOp), makeCreateNodeOp(toPbNode(node)), makeSetTextOp(node.id, content, BODY, { paragraphStyles: styles, runs })];
  return { ops, nodeId: node.id, paragraphs: paragraphs.length };
}

/** A table with the rows of a sheet (the first row is the header). */
export function placeTableOps(scene: SceneState, rows: readonly (readonly string[])[], parentId: string, x: number, y: number): { ops: Op[]; tableId: string } | string {
  const cols = Math.max(...rows.map((r) => r.length));
  if (rows.length === 0 || cols === 0) return "the sheet is empty";
  const made = createTableOps(scene, parentId, x, y, rows.length, cols, 110, 28, 1);
  if (!made) return "the sheet is too large for a table (at most 100 rows and 100 columns)";
  let cur = scene;
  for (const op of made.ops) cur = applyOp(cur, op);
  const tableId = made.selection[0]!;
  const t = readTable(cur, tableId)!;
  const ops = [...made.ops];
  rows.forEach((row, r) => row.forEach((value, c) => {
    const cell = t.cells.get(`${r},${c}`)?.text;
    if (cell && value !== "") ops.push(makeSetTextOp(cell.id, value, cell.text!.style));
  }));
  return { ops, tableId };
}
