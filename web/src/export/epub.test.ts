import { describe, it, expect } from "vitest";
import { buildEpub, xmlEscape } from "@/export/epub";

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

describe("accessible EPUB (fixed layout)", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>';
  const read = async (pages: Parameters<typeof buildEpub>[0]) => {
    const { openZip, readZipText } = await import("@/export/zipRead");
    const z = openZip(buildEpub(pages, { title: "T", language: "it", modified: "2026-01-01T00:00:00Z" }));
    return { opf: (await readZipText(z, "OEBPS/content.opf"))!, page: (await readZipText(z, "OEBPS/page-001.xhtml"))!, nav: (await readZipText(z, "OEBPS/nav.xhtml"))! };
  };
  it("repeats the page text as real headings and paragraphs, hides the picture from screen readers, and claims only what is true", async () => {
    const { opf, page, nav } = await read([{ name: "P1", svg, width: 10, height: 10, text: [{ level: 1, text: "Title & more" }, { level: 0, text: "Body" }], imageAlts: ["A cat", ""] }]);
    expect(page).toContain('<svg aria-hidden="true"');
    expect(page).toContain('<div class="sr-only"><h1>Title &amp; more</h1><p>Body</p></div>');
    expect(opf).toContain('<meta property="schema:accessMode">textual</meta>');
    expect(opf).toContain('<meta property="schema:accessModeSufficient">textual,visual</meta>'); // one image has no alt
    expect(opf).toContain("structuralNavigation");
    expect(opf).not.toContain("alternativeText");
    expect(opf).toContain("not checked against EPUB Accessibility conformance");
    expect(nav).toContain('role="doc-toc"');
    expect(nav).toContain('epub:type="landmarks"');
  });
  it("claims alternative text only when every image has some", async () => {
    const { opf } = await read([{ name: "P1", svg, width: 10, height: 10, text: [{ level: 0, text: "x" }], imageAlts: ["A cat"] }]);
    expect(opf).toContain("alternativeText");
    expect(opf).toContain('accessModeSufficient">textual<');
  });
  it("keeps a page without text data as before (no hidden layer)", async () => {
    const { page, opf } = await read([{ name: "P1", svg, width: 10, height: 10 }]);
    expect(page).not.toContain("sr-only\">");
    expect(opf).toContain('accessModeSufficient">visual<');
  });
});
