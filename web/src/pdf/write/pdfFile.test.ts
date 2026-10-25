import { describe, it, expect } from "vitest";
import { PdfFile, adler32, num, pdfDate, pdfName, pdfText, storedZlib } from "./pdfFile";

describe("pdf primitives", () => {
  it("numbers have no exponent and no trailing zeros", () => {
    expect(num(1)).toBe("1");
    expect(num(0.5)).toBe("0.5");
    expect(num(1 / 3)).toBe("0.3333");
    expect(num(-0.00001)).toBe("0");
    expect(num(1e-9)).toBe("0");
    expect(num(NaN)).toBe("0");
    expect(num(1234.5)).toBe("1234.5");
  });
  it("names escape delimiters and spaces", () => {
    expect(pdfName("Foo")).toBe("/Foo");
    expect(pdfName("A B")).toBe("/A#20B");
    expect(pdfName("a/b")).toBe("/a#2fb");
  });
  it("text is a plain literal for ASCII and UTF-16BE otherwise", () => {
    expect(pdfText("a(b)\\")).toBe("(a\\(b\\)\\\\)");
    expect(pdfText("é")).toBe("<FEFF00E9>");
  });
  it("dates are UTC and fixed width", () => {
    expect(pdfDate(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)))).toBe("D:20260102030405Z");
  });
  it("stored zlib round-trips through a real inflate", async () => {
    const data = new Uint8Array(70000).map((_, i) => i * 7);
    const z = storedZlib(data);
    expect(z[0]).toBe(0x78);
    const { inflateSync } = await import("node:zlib");
    expect(new Uint8Array(inflateSync(z))).toEqual(data);
    expect(new DataView(z.buffer).getUint32(z.length - 4)).toBe(adler32(data));
  });
});

describe("PdfFile", () => {
  it("writes a cross-reference table whose offsets point at the objects", async () => {
    const f = new PdfFile();
    const root = f.alloc();
    const pages = f.add("<</Type/Pages/Count 0/Kids[]>>");
    f.set(root, `<</Type/Catalog/Pages ${pages} 0 R>>`);
    f.stream("", "hello", false);
    const bytes = await f.build(root);
    const text = new TextDecoder("latin1").decode(bytes);
    const start = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(start, start + 4)).toBe("xref");
    const entries = [...text.slice(start).matchAll(/(\d{10}) 00000 n /g)].map((m) => Number(m[1]));
    expect(entries).toHaveLength(3);
    entries.forEach((off, i) => expect(text.slice(off, off + 8)).toBe(`${i + 1} 0 obj\n`));
    expect(text).toContain("/Size 4");
    expect(text.endsWith("%%EOF\n")).toBe(true);
  });
  it("refuses an object that was allocated but never filled", async () => {
    const f = new PdfFile();
    const a = f.alloc();
    f.alloc();
    f.set(a, "1");
    await expect(f.build(a)).rejects.toThrow(/never filled/);
  });
});
