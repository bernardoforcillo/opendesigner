import { describe, it, expect } from "vitest";
import { inflateRawSync } from "node:zlib";
import { buildReflowEpub } from "./epubReflow";
import { emptyScene } from "../store/types";
import type { NodeLite, SceneState } from "../store/types";

const style = { fontFamily: "", fontSize: 16, fontWeight: "", lineHeight: 0, align: "left" as const };
const text = (id: string, y: number, content: string, over: Partial<NodeLite> = {}, page = "page1"): NodeLite => ({
  id, parentId: page, orderKey: id, name: id, visible: true, opacity: 1, x: 0, y, width: 200, height: 50, rotation: 0,
  fills: [], strokes: [], kind: "text", cornerRadius: 0, clipsContent: false, text: { content, style }, ...over,
});

// zipStore writes STORED entries: read the file back by scanning local headers.
function unzip(data: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let o = 0; o + 30 < data.length && v.getUint32(o, true) === 0x04034b50;) {
    const method = v.getUint16(o + 8, true), size = v.getUint32(o + 18, true), nl = v.getUint16(o + 26, true), xl = v.getUint16(o + 28, true);
    const name = new TextDecoder().decode(data.subarray(o + 30, o + 30 + nl));
    const body = data.subarray(o + 30 + nl + xl, o + 30 + nl + xl + size);
    out.set(name, new TextDecoder().decode(method === 8 ? inflateRawSync(body) : body));
    o += 30 + nl + xl + size;
  }
  return out;
}

function book(): SceneState {
  const s = emptyScene("d", "Book");
  s.textStyles = {
    h1: { id: "h1", name: "Title", style: { ...style, fontSize: 32, fontWeight: "700" }, outlineLevel: 1 },
    h2: { id: "h2", name: "Section", style: { ...style, fontSize: 24 }, outlineLevel: 2 },
    body: { id: "body", name: "Body", style: { ...style, align: "justify" }, spaceAfter: 8 },
    em: { id: "em", name: "Emph", kind: "character", style: { ...style, italic: true } },
  };
  s.pages = [{ id: "page1", name: "One" }, { id: "p2", name: "Two" }];
  const a = text("a", 0, "Chapter One\nIntro\nA body with *stress* and a note[^the note text] here.", {
    text: { content: "Chapter One\nIntro\nA body with *stress* and a note[^the note text] here.", style, paragraphStyles: ["h1", "h2", "body"], runs: [{ start: 30, end: 38, styleId: "em" }] },
  });
  const b = text("b", 0, "Chapter Two\nMore & more <text>", { text: { content: "Chapter Two\nMore & more <text>", style, paragraphStyles: ["h1", "body"] } }, "p2");
  for (const n of [a, b]) s.nodes = s.nodes.set(n.id, n);
  return s;
}

describe("buildReflowEpub", () => {
  it("is a reflowable package: no pre-paginated layout, one chapter per level-1 heading", () => {
    const files = unzip(buildReflowEpub(book(), { title: "Book", modified: "2026-01-01T00:00:00Z" }, new Map()));
    const opf = files.get("OEBPS/content.opf")!;
    expect(opf).not.toContain("pre-paginated");
    expect(opf).toContain("chapter-001.xhtml");
    expect(opf).toContain("chapter-002.xhtml");
    expect([...files.keys()][0]).toBe("mimetype");
  });

  it("sets headings as h1/h2, body as p with a style class, and turns styles into CSS", () => {
    const files = unzip(buildReflowEpub(book(), { title: "Book" }, new Map()));
    const c1 = files.get("OEBPS/chapter-001.xhtml")!;
    expect(c1).toMatch(/<h1 class="p1" id="h1">Chapter One<\/h1>/);
    expect(c1).toMatch(/<h2 class="p2" id="h2">Intro<\/h2>/);
    expect(c1).toMatch(/<p class="p3">A body with /);
    const css = files.get("OEBPS/style.css")!;
    expect(css).toContain("font-size:2em");
    expect(css).toContain("text-align:justify");
    expect(css).toContain("margin-bottom:0.5em");
  });

  it("applies character styles as spans and footnotes as numbered notes", () => {
    const files = unzip(buildReflowEpub(book(), { title: "Book" }, new Map()));
    const c1 = files.get("OEBPS/chapter-001.xhtml")!;
    expect(c1).toContain('<span class="c1">*stress*</span>');
    expect(c1).toContain('<a epub:type="noteref" id="r1" href="#fn1"><sup>1</sup></a>');
    expect(c1).toContain('<aside epub:type="footnote" class="note" id="fn1">');
    expect(c1).toContain("the note text");
    expect(c1).not.toContain("[^");
  });

  it("escapes markup in the text and builds a nested navigation from the headings", () => {
    const files = unzip(buildReflowEpub(book(), { title: "Book" }, new Map()));
    expect(files.get("OEBPS/chapter-002.xhtml")!).toContain("More &amp; more &lt;text&gt;");
    const nav = files.get("OEBPS/nav.xhtml")!;
    expect(nav).toContain('<li><a href="chapter-001.xhtml#h1">Chapter One</a><ol><li><a href="chapter-001.xhtml#h2">Intro</a></li></ol></li>');
    expect(nav).toContain('href="chapter-002.xhtml#h3">Chapter Two');
  });

  it("places images in reading order and packages their bytes", () => {
    const s = book();
    const img: NodeLite = { id: "im", parentId: "page1", orderKey: "z", name: "Photo", visible: true, opacity: 1, x: 0, y: 100, width: 50, height: 50, rotation: 0, fills: [], strokes: [], kind: "image", cornerRadius: 0, clipsContent: false, image: { assetHash: "abc" } };
    s.nodes = s.nodes.set("im", img);
    const files = unzip(buildReflowEpub(s, { title: "Book" }, new Map([["abc", { bytes: new Uint8Array([1, 2, 3]), mime: "image/png" }]])));
    expect(files.get("OEBPS/chapter-001.xhtml")!).toContain('<figure><img src="images/img-1.png" alt="Photo"/></figure>');
    expect(files.has("OEBPS/images/img-1.png")).toBe(true);
    expect(files.get("OEBPS/content.opf")!).toContain('media-type="image/png"');
  });

  it("refuses a document with nothing to flow", () => {
    expect(() => buildReflowEpub(emptyScene("d", "E"), { title: "E" }, new Map())).toThrow(/nothing to export/);
  });
});

describe("long-document tokens in the reflowable book", () => {
  it("resolves cross-references, lists endnotes like notes and leaves hidden conditional text out", () => {
    const s = emptyScene("d", "Book");
    s.settings = { conditions: [{ name: "Web", visible: false }] };
    s.pages = [{ id: "page1", name: "One" }];
    s.nodes = s.nodes
      .set("a", text("a", 0, "Intro [=top]Start here\nSee [>top:text] on page [>top]. Done[*the source][?Web] web only[/?][!todo]"))
      .set("b", text("b", 50, "Second text"));
    const files = unzip(buildReflowEpub(s, { title: "Book" }, new Map()));
    const c = files.get("OEBPS/chapter-001.xhtml")!;
    expect(c).toContain("Intro Start here");
    expect(c).toContain("See Intro Start here on page 1. Done");
    expect(c).not.toContain("web only");
    expect(c).not.toContain("todo");
    expect(c).toContain('epub:type="noteref"');
    expect(c).toContain("the source");
  });
});
