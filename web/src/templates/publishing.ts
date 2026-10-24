import type { DocSettingsLite, NodeLite, PageLite, TextStyleDefLite } from "../store/types";
import { DocBuilder, hexFill, type BuiltTemplate, type IdGen } from "./builder";
import { META_NEXT } from "../store/threads";

// THE PUBLISHING TEMPLATES: a book, a magazine and a report. Each one is a real document: sized sheets
// with margins, columns and bleed, a master page with the running head and the page number, paragraph and
// character styles, a baseline grid, and body text that flows through linked frames from page to page.
//
// A template builds a BuiltTemplate (pure data) with, besides nodes, the `pages` to set up (the first is
// the document's first page), the `textStyles` and the document `settings`.

export interface PublishingBuilt extends BuiltTemplate {
  /** The pages, in order. The first one is the page the document is born with (its id is `pageId`). */
  pages: PageLite[];
  textStyles: TextStyleDefLite[];
  settings: DocSettingsLite;
}

const SERIF = "Georgia, serif";
const SANS = "Inter, sans-serif";
const INK = "#1c1b1a";
const MUTED = "#7a746c";

const LOREM = [
  "Every document begins as a blank sheet. What makes it a page is the frame around it: the margins that say where the text may go, the columns that give it a rhythm, the grid that keeps every line on the same beat.",
  "Text flows. When a frame is full, the words continue in the next one, wherever it is, whatever its size. Change a margin, add a paragraph, and the whole story settles again, page after page, without touching a single line by hand.",
  "A style is a decision made once. The heading, the body, the caption, the quotation: each has its own look, and editing the style edits every place it is used. This is how a long document stays consistent from the first page to the last.",
  "Masters carry what repeats. The running head, the page number, a rule at the foot of the page are drawn once, on the master, and every page that uses it shows them in the right place with the right number.",
  "When the work is done it leaves as a PDF for the printer, with its bleed, or as an EPUB for the screen. The same pages, the same styles, the same text.",
  "A good page is quiet. The reader should notice the words, not the machinery. Leading that breathes, a measure that is neither too wide nor too narrow, margins that give the text room to be read.",
];

class Pager {
  readonly b: DocBuilder;
  readonly pages: PageLite[] = [];
  constructor(readonly firstPageId: string, readonly newId: IdGen) {
    this.b = new DocBuilder(firstPageId, newId);
  }
  /** Adds a page (the first call describes the document's first page). */
  page(p: Omit<PageLite, "id"> & { id?: string }): PageLite {
    const page: PageLite = { ...p, id: this.pages.length === 0 ? this.firstPageId : p.id ?? this.newId() };
    this.pages.push(page);
    return page;
  }
  text(page: PageLite, content: string, x: number, y: number, w: number, h: number, o: {
    family?: string; size?: number; weight?: string; color?: string; align?: "left" | "center" | "right"; lineHeight?: number;
    name?: string; paragraphStyles?: string[]; runs?: { start: number; end: number; styleId: string }[]; letterSpacing?: number;
  } = {}): NodeLite {
    const style = {
      fontFamily: o.family ?? SERIF, fontSize: o.size ?? 11, fontWeight: o.weight ?? "400", lineHeight: o.lineHeight ?? 0, align: o.align ?? "left",
      ...(o.letterSpacing ? { letterSpacing: o.letterSpacing } : {}),
    };
    return this.b.add({
      id: this.newId(), parentId: page.id, name: o.name ?? content.slice(0, 24).replace(/\n/g, " "), kind: "text",
      x, y, width: w, height: h, fills: [hexFill(o.color ?? INK)],
      text: { content, style, ...(o.paragraphStyles ? { paragraphStyles: o.paragraphStyles } : {}), ...(o.runs ? { runs: o.runs } : {}) },
    });
  }
  rect(page: PageLite, x: number, y: number, w: number, h: number, fill: string, name = "Shape"): NodeLite {
    return this.b.add({ id: this.newId(), parentId: page.id, name, kind: "rect", x, y, width: w, height: h, fills: [hexFill(fill)] });
  }
  /** Links `frames` in reading order: the first one's text flows through the others. */
  thread(frames: NodeLite[]): void {
    for (let i = 0; i + 1 < frames.length; i++) frames[i].meta = { ...(frames[i].meta ?? {}), [META_NEXT]: frames[i + 1].id };
  }
}

/** The styles every publishing template shares. */
function styles(newId: IdGen, o: { bodySize: number; bodyLeading: number; headSize: number }) {
  const heading: TextStyleDefLite = {
    id: newId(), name: "Heading", style: { fontFamily: SERIF, fontSize: o.headSize, fontWeight: "700", lineHeight: 1.15, align: "left" },
    spaceAfter: o.bodyLeading, nextStyleId: "",
  };
  const body: TextStyleDefLite = {
    id: newId(), name: "Body", style: { fontFamily: SERIF, fontSize: o.bodySize, fontWeight: "400", lineHeight: o.bodyLeading / o.bodySize, align: "left" },
    indentFirst: o.bodySize * 1.2, alignToGrid: true,
  };
  const bodyFirst: TextStyleDefLite = {
    id: newId(), name: "Body (first paragraph)", style: { fontFamily: SERIF, fontSize: o.bodySize, fontWeight: "400", lineHeight: o.bodyLeading / o.bodySize, align: "left" },
    alignToGrid: true,
  };
  heading.nextStyleId = bodyFirst.id;
  bodyFirst.nextStyleId = body.id;
  body.nextStyleId = body.id;
  const emphasis: TextStyleDefLite = { id: newId(), name: "Emphasis", kind: "character", style: { fontFamily: "", fontSize: 0, fontWeight: "", lineHeight: 0, align: "left", italic: true } };
  const folio: TextStyleDefLite = {
    id: newId(), name: "Folio", style: { fontFamily: SANS, fontSize: 9, fontWeight: "500", lineHeight: 1.2, align: "center", letterSpacing: 1 },
  };
  return { heading, body, bodyFirst, emphasis, folio, all: [heading, body, bodyFirst, emphasis, folio] };
}

/** The story: paragraph i gets the first-paragraph style, the others the body style; one phrase in italics. */
function story(st: ReturnType<typeof styles>, paragraphs: number) {
  const parts = Array.from({ length: paragraphs }, (_, i) => LOREM[i % LOREM.length]);
  const content = parts.join("\n");
  const phrase = "A style is a decision made once.";
  const at = content.indexOf(phrase);
  return {
    content,
    paragraphStyles: parts.map((_, i) => (i === 0 ? st.bodyFirst.id : st.body.id)),
    runs: at >= 0 ? [{ start: at, end: at + phrase.length, styleId: st.emphasis.id }] : [],
  };
}

// ---------------------------------------------------------------------------------------------------
// BOOK -- 6 x 9 in, a cover, a master, and a chapter that flows over three pages.
// ---------------------------------------------------------------------------------------------------
export function buildBook(pageId: string, newId: IdGen): PublishingBuilt {
  const W = 432, H = 648;
  const sheet = { width: W, height: H, marginTop: 54, marginBottom: 72, marginLeft: 54, marginRight: 54, bleed: 9 };
  const st = styles(newId, { bodySize: 11, bodyLeading: 16, headSize: 30 });
  const p = new Pager(pageId, newId);

  const cover = p.page({ name: "Cover", ...sheet, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0 });
  const master = p.page({ name: "A-Master", isMaster: true, ...sheet });
  const ch1 = p.page({ name: "Chapter 1", masterId: master.id, ...sheet });
  const pg2 = p.page({ name: "Page 2", masterId: master.id, ...sheet });
  const pg3 = p.page({ name: "Page 3", masterId: master.id, ...sheet });

  p.rect(cover, 0, 0, W, H, "#1f3a5f", "Cover background");
  p.rect(cover, 54, 300, 60, 4, "#e9b44c", "Rule");
  p.text(cover, "The Title of the Book", 54, 130, 324, 150, { family: SERIF, size: 44, weight: "700", color: "#ffffff", name: "Title", lineHeight: 1.1 });
  p.text(cover, "A subtitle that says what it is about", 54, 320, 324, 60, { family: SERIF, size: 18, color: "#d9e2ef", name: "Subtitle" });
  p.text(cover, "Author Name", 54, 560, 324, 24, { family: SANS, size: 12, weight: "600", color: "#ffffff", name: "Author", letterSpacing: 2 });

  p.text(master, "<#>", 54, H - 48, W - 108, 16, { family: SANS, size: 9, weight: "500", color: MUTED, align: "center", name: "Page number", letterSpacing: 1 });
  p.text(master, "The Title of the Book", 54, 28, W - 108, 14, { family: SANS, size: 8, color: MUTED, name: "Running head", letterSpacing: 1.5 });
  p.rect(master, 54, 44, W - 108, 0.75, "#cfc8bd", "Head rule");

  p.text(ch1, "Chapter One\nWhere the story starts", 54, 54, 324, 120, {
    size: 30, weight: "700", name: "Chapter title", paragraphStyles: [st.heading.id],
  });
  const text = story(st, 6);
  const f1 = p.text(ch1, text.content, 54, 180, 324, 392, { size: 11, name: "Story", paragraphStyles: text.paragraphStyles, runs: text.runs });
  const f2 = p.text(pg2, "", 54, 54, 324, 522, { size: 11, name: "Story (continued)" });
  const f3 = p.text(pg3, "", 54, 54, 324, 522, { size: 11, name: "Story (continued)" });
  p.thread([f1, f2, f3]);

  return {
    nodes: p.b.nodes, flows: [], transitions: [], pages: p.pages, textStyles: st.all,
    settings: { vertical: "publishing", baselineIncrement: 16, baselineStart: 54 },
  };
}

// ---------------------------------------------------------------------------------------------------
// MAGAZINE -- A4, three columns, a cover and an article that flows across the columns of two pages.
// ---------------------------------------------------------------------------------------------------
export function buildMagazine(pageId: string, newId: IdGen): PublishingBuilt {
  const W = 595, H = 842;
  const sheet = { width: W, height: H, marginTop: 48, marginBottom: 60, marginLeft: 42, marginRight: 42, columns: 3, gutter: 16, bleed: 9 };
  const colW = (W - 84 - 2 * 16) / 3;
  const st = styles(newId, { bodySize: 9.5, bodyLeading: 14, headSize: 40 });
  const p = new Pager(pageId, newId);

  const cover = p.page({ name: "Cover", ...sheet, columns: 0, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0, gutter: 0 });
  const master = p.page({ name: "A-Master", isMaster: true, ...sheet });
  const a1 = p.page({ name: "Article 1", masterId: master.id, ...sheet });
  const a2 = p.page({ name: "Article 2", masterId: master.id, ...sheet });

  p.rect(cover, 0, 0, W, H, "#f2ede4", "Cover background");
  p.rect(cover, 0, 0, W, 300, "#c8452d", "Masthead block");
  p.text(cover, "MAGAZINE", 42, 80, 511, 120, { family: SANS, size: 92, weight: "800", color: "#ffffff", name: "Masthead", letterSpacing: -2 });
  p.text(cover, "The issue about everything that flows", 42, 340, 400, 100, { family: SERIF, size: 34, weight: "700", name: "Cover line", lineHeight: 1.15 });
  p.text(cover, "Issue 01 · Autumn", 42, 780, 300, 20, { family: SANS, size: 10, weight: "600", color: MUTED, name: "Issue", letterSpacing: 2 });

  p.text(master, "<#>", 42, H - 44, 511, 14, { family: SANS, size: 8, weight: "600", color: MUTED, align: "center", name: "Folio", letterSpacing: 1 });
  p.text(master, "MAGAZINE · AUTUMN", 42, 24, 300, 12, { family: SANS, size: 7, color: MUTED, name: "Running head", letterSpacing: 2 });

  p.text(a1, "Pages that\nflow", 42, 48, 511, 120, { size: 40, weight: "700", name: "Headline", paragraphStyles: [st.heading.id, st.heading.id], lineHeight: 1.1 });
  const text = story(st, 6);
  const frames = [
    p.text(a1, text.content, 42, 220, colW, 560, { size: 9.5, name: "Column 1", paragraphStyles: text.paragraphStyles, runs: text.runs }),
    p.text(a1, "", 42 + colW + 16, 220, colW, 560, { size: 9.5, name: "Column 2" }),
    p.text(a1, "", 42 + 2 * (colW + 16), 220, colW, 560, { size: 9.5, name: "Column 3" }),
    p.text(a2, "", 42, 48, colW, 734, { size: 9.5, name: "Column 4" }),
    p.text(a2, "", 42 + colW + 16, 48, colW, 734, { size: 9.5, name: "Column 5" }),
    p.text(a2, "", 42 + 2 * (colW + 16), 48, colW, 734, { size: 9.5, name: "Column 6" }),
  ];
  p.thread(frames);

  return {
    nodes: p.b.nodes, flows: [], transitions: [], pages: p.pages, textStyles: st.all,
    settings: { vertical: "publishing", baselineIncrement: 14, baselineStart: 48 },
  };
}

// ---------------------------------------------------------------------------------------------------
// REPORT -- US Letter, one wide column with a master (header, footer, page number): title page,
// summary and a body that flows over two pages.
// ---------------------------------------------------------------------------------------------------
export function buildReport(pageId: string, newId: IdGen): PublishingBuilt {
  const W = 612, H = 792;
  const sheet = { width: W, height: H, marginTop: 72, marginBottom: 72, marginLeft: 72, marginRight: 72 };
  const st = styles(newId, { bodySize: 11, bodyLeading: 18, headSize: 26 });
  const p = new Pager(pageId, newId);

  const title = p.page({ name: "Title page", ...sheet });
  const master = p.page({ name: "A-Master", isMaster: true, ...sheet });
  const summary = p.page({ name: "Summary", masterId: master.id, ...sheet });
  const body = p.page({ name: "Findings", masterId: master.id, ...sheet });
  const more = p.page({ name: "Findings 2", masterId: master.id, ...sheet });

  p.rect(title, 72, 260, 80, 5, "#2563eb", "Rule");
  p.text(title, "Annual Report", 72, 280, 468, 80, { family: SANS, size: 44, weight: "700", name: "Title" });
  p.text(title, "Prepared for the board · 2026", 72, 370, 468, 30, { family: SANS, size: 16, color: MUTED, name: "Subtitle" });

  p.rect(master, 72, 56, W - 144, 0.75, "#cbd0d8", "Header rule");
  p.text(master, "Annual Report 2026", 72, 40, 300, 12, { family: SANS, size: 8, color: MUTED, name: "Running head", letterSpacing: 1 });
  p.rect(master, 72, H - 60, W - 144, 0.75, "#cbd0d8", "Footer rule");
  p.text(master, "<#>", W - 144, H - 52, 72, 14, { family: SANS, size: 9, weight: "600", color: MUTED, align: "right", name: "Page number" });

  p.text(summary, "Summary", 72, 72, 468, 60, { size: 26, weight: "700", name: "Heading", paragraphStyles: [st.heading.id] });
  const sum = story(st, 2);
  p.text(summary, sum.content, 72, 130, 468, 500, { size: 11, name: "Summary text", paragraphStyles: sum.paragraphStyles, runs: sum.runs });

  p.text(body, "Findings", 72, 72, 468, 60, { size: 26, weight: "700", name: "Heading", paragraphStyles: [st.heading.id] });
  const text = story(st, 6);
  const f1 = p.text(body, text.content, 72, 130, 468, 560, { size: 11, name: "Findings text", paragraphStyles: text.paragraphStyles, runs: text.runs });
  const f2 = p.text(more, "", 72, 72, 468, 620, { size: 11, name: "Findings (continued)" });
  p.thread([f1, f2]);

  return {
    nodes: p.b.nodes, flows: [], transitions: [], pages: p.pages, textStyles: st.all,
    settings: { vertical: "publishing", baselineIncrement: 18, baselineStart: 72 },
  };
}
