import { describe, it, expect } from "vitest";
import { buildEpub, xmlEscape } from "./epub";

const text = (u: Uint8Array) => new TextDecoder().decode(u);
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="20"><rect width="10" height="20"/></svg>';

describe("buildEpub", () => {
  const out = buildEpub(
    [
      { name: "Cover & intro", svg, width: 10, height: 20 },
      { name: "Two", svg: `<?xml version="1.0"?>${svg}`, width: 10.2, height: 20 },
    ],
    { title: "My <doc>", identifier: "urn:x:1", modified: "2026-01-01T00:00:00.000Z" },
  );
  const s = text(out);

  it("starts with an uncompressed mimetype entry", () => {
    expect(text(out.slice(30, 38))).toBe("mimetype");
    expect(s.includes("application/epub+zip")).toBe(true);
    expect(new DataView(out.buffer).getUint16(8, true)).toBe(0);
  });

  it("lists every page in manifest, spine and nav", () => {
    expect(s).toContain('href="page-001.xhtml"');
    expect(s).toContain('href="page-002.xhtml"');
    expect(s).toContain('<itemref idref="p2"/>');
    expect(s).toContain("Cover &amp; intro");
    expect(s).toContain("My &lt;doc&gt;");
    expect(s).toContain("rendition:layout\">pre-paginated");
    expect(s).toContain("2026-01-01T00:00:00Z");
  });

  it("embeds the svg without its xml declaration and sizes the viewport", () => {
    expect(s).toContain("OEBPS/page-002.xhtml");
    expect(s).toContain('content="width=11, height=20"');
    expect(s.match(/<\?xml/g)?.length).toBe(5); // container, opf, nav, 2 pages: declarations are the files', not the svg's
  });

  it("refuses an empty document and escapes xml", () => {
    expect(() => buildEpub([], { title: "x" })).toThrow();
    expect(xmlEscape('a<b>&"')).toBe("a&lt;b&gt;&amp;&quot;");
  });
});

describe("book metadata in the package", () => {
  const book = {
    isbn13: "9788804668237", title: "Rosa", subtitle: "Romanzo", language: "ita", publisherName: "Bompiani", publicationDate: "20240229", description: "A & B",
    contributors: [{ role: "A01", personName: "Umberto Eco" }, { role: "B06", personName: "W. Weaver" }], subjects: [{ scheme: "10", code: "FIC014000", heading: "Historical" }],
    seriesName: "Classics", seriesNumber: "3",
  };
  const opf = (meta: Parameters<typeof buildEpub>[1]) => {
    const text = new TextDecoder().decode(buildEpub([{ name: "P", svg: "<svg/>", width: 10, height: 10 }], meta));
    return text.slice(text.indexOf("<package"), text.indexOf("</package>"));
  };
  it("uses the ISBN as the package identifier and writes creators, publisher, date, subjects and series", () => {
    const x = opf({ title: "Doc", identifier: "urn:x", modified: "2026-01-01T00:00:00Z", book });
    expect(x).toContain('<dc:identifier id="uid">urn:isbn:9788804668237</dc:identifier>');
    expect(x).toContain('<dc:title id="t1">Rosa</dc:title>');
    expect(x).toContain('property="title-type">subtitle');
    expect(x).toContain('<dc:creator id="c1">Umberto Eco</dc:creator>');
    expect(x).toContain('<dc:contributor id="c2">W. Weaver</dc:contributor>');
    expect(x).toContain('property="role" scheme="marc:relators">trl');
    expect(x).toContain("<dc:publisher>Bompiani</dc:publisher>");
    expect(x).toContain("<dc:date>2024-02-29</dc:date>");
    expect(x).toContain("<dc:description>A &amp; B</dc:description>");
    expect(x).toContain("<dc:subject>Historical</dc:subject>");
    expect(x).toContain('property="group-position">3');
    expect(x).toContain("<dc:language>ita</dc:language>");
    expect(x).toContain("pre-paginated");
  });
  it("is unchanged when there is no book record", () => {
    const x = opf({ title: "Doc", identifier: "urn:x", modified: "2026-01-01T00:00:00Z" });
    expect(x).toContain('<dc:identifier id="uid">urn:x</dc:identifier><dc:title id="t1">Doc</dc:title><dc:language>en</dc:language>');
    expect(x).not.toContain("dc:creator");
  });
});
