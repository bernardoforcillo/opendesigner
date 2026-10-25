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
