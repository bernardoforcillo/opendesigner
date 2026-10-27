import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";
import { applyOp } from "@/store/applyOp";
import { emptyScene } from "@/store/types";
import { headingsOf } from "@/store/textTokens";
import { parseDocx, parseRtf, parseXlsx, placeTableOps, placeTextOps, PlaceError } from "@/tools/placeDocument";
import { readTable } from "@/tools/tableOps";

const fx = (n: string) => new Uint8Array(readFileSync(join(process.cwd(), "src/tools/__fixtures__", n)));

describe("place Word", () => {
  it("reads headings, text and bold/italic runs from a real .docx (deflated)", async () => {
    const ps = await parseDocx(fx("sample.docx"));
    expect(ps.map((p) => [p.level, p.text])).toEqual([[1, "Chapter One"], [0, "Plain, bold and italic text."], [2, "Section"], [0, "Second paragraph with café."]]);
    expect(ps[1]!.runs).toEqual([{ start: 7, end: 11, bold: true, italic: false }, { start: 16, end: 22, bold: false, italic: true }]);
  });
  it("refuses files that are not .docx", async () => {
    await expect(parseDocx(new Uint8Array([1, 2, 3, 4]))).rejects.toBeInstanceOf(PlaceError);
    await expect(parseDocx(fx("sample.xlsx"))).rejects.toThrow(/no word\/document.xml/);
  });
  it("places a styled frame whose headings reach the table of contents", async () => {
    const base = emptyScene("d", "d");
    const made = placeTextOps(base, await parseDocx(fx("sample.docx")), "page1", 20, 30, 300);
    expect(typeof made).not.toBe("string");
    const after = (made as { ops: Op[] }).ops.reduce(applyOp, base);
    expect(headingsOf(after).map((h) => [h.level, h.text])).toEqual([[1, "Chapter One"], [2, "Section"]]);
    const n = after.nodes.get((made as { nodeId: string }).nodeId)!;
    expect(n.text!.content.split("\n")).toHaveLength(4);
    expect(n.text!.runs!.map((r) => r.styleId)).toEqual(["placed-bold", "placed-italic"]);
  });
});

describe("place RTF", () => {
  it("reads paragraphs, bold, italic, accents and unicode escapes", () => {
    const ps = parseRtf(readFileSync(join(process.cwd(), "src/tools/__fixtures__/sample.rtf"), "utf8"));
    expect(ps.map((p) => p.text)).toEqual(["Hello bold and italic.", "Café € done"]);
    expect(ps[0]!.runs).toEqual([{ start: 6, end: 10, bold: true, italic: false }, { start: 15, end: 21, bold: false, italic: true }]);
    expect(() => parseRtf("plain")).toThrow(PlaceError);
  });
});

describe("place Excel", () => {
  it("reads the first sheet and makes a table with the values", async () => {
    const rows = await parseXlsx(fx("sample.xlsx"));
    expect(rows).toEqual([["Name", "Qty", "Note"], ["Apples", "3", "fresh"], ["Pears", "12", "a & b"]]);
    const base = emptyScene("d", "d");
    const made = placeTableOps(base, rows, "page1", 10, 10) as { ops: never[]; tableId: string };
    const after = made.ops.reduce(applyOp, base);
    const t = readTable(after, made.tableId)!;
    expect(t.cells.get("1,0")!.text!.text!.content).toBe("Apples");
    expect(t.cells.get("2,2")!.text!.text!.content).toBe("a & b");
  });
});
