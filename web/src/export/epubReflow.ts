import type { NodeLite, SceneState, TextStyleLite } from "../store/types";
import { flattenStyle, type FlatStyle } from "../store/richText";
import { destinationsOf, textNodesInReadingOrder, tokensOf, visibleText } from "../store/textTokens";
import { pageNumbers } from "../store/pageNumbers";
import { zipStore, type ZipEntry } from "./zip";
import { opfMetadata, xmlEscape, type EpubMeta } from "./epub";

// EPUB 3, REFLOWABLE: the document's stories in reading order as real text -- headings, paragraphs,
// character styling, footnotes as notes, images -- with the paragraph and character styles turned into
// CSS and the headings into the navigation. Page geometry is deliberately NOT kept (that is the
// fixed-layout EPUB's job): a reader sets the text in its own page size and font size.
//
// Reading order is the order of the pages, then top-to-bottom, left-to-right on a page; threaded frames
// count as one story (its first frame); a level-1 heading starts a new chapter file.
// What does not carry over: tables (their cell text reads in place), text on a path, wrapped-text
// geometry, tabs and leaders, drop caps, OpenType features.

const enc = new TextEncoder();
const bytes = (s: string) => enc.encode(s);

export interface ReflowImage { bytes: Uint8Array; mime: string }

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg" };

function cssOf(s: TextStyleLite, f?: FlatStyle): string {
  const d: string[] = [];
  if (s.fontFamily) d.push(`font-family:${s.fontFamily.replace(/"/g, "'")}`);
  if (s.fontSize) d.push(`font-size:${Math.round((s.fontSize / 16) * 1000) / 1000}em`);
  if (s.fontWeight) d.push(`font-weight:${s.fontWeight}`);
  if (s.italic) d.push("font-style:italic");
  if (s.underline || s.strikethrough) d.push(`text-decoration:${[s.underline ? "underline" : "", s.strikethrough ? "line-through" : ""].filter(Boolean).join(" ")}`);
  if (s.letterSpacing) d.push(`letter-spacing:${s.letterSpacing}px`);
  if (s.smallCaps) d.push("font-variant:small-caps");
  if (s.color) d.push(`color:rgb(${Math.round(s.color.r * 255)},${Math.round(s.color.g * 255)},${Math.round(s.color.b * 255)})`);
  if (f) {
    if (s.lineHeight) d.push(`line-height:${s.lineHeight}`);
    if (s.align) d.push(`text-align:${s.align}`);
    if (f.spaceBefore) d.push(`margin-top:${Math.round((f.spaceBefore / 16) * 1000) / 1000}em`);
    if (f.spaceAfter) d.push(`margin-bottom:${Math.round((f.spaceAfter / 16) * 1000) / 1000}em`);
    if (f.indentFirst) d.push(`text-indent:${Math.round((f.indentFirst / 16) * 1000) / 1000}em`);
    if (f.indentLeft) d.push(`margin-left:${Math.round((f.indentLeft / 16) * 1000) / 1000}em`);
    if (f.hyphenate) d.push("hyphens:auto");
  }
  return d.join(";");
}

interface Block { kind: "p"; level: number; cls: string; html: string; text: string; hid?: string }
interface Fig { kind: "img"; src: string; alt: string }
interface Chapter { title: string; blocks: (Block | Fig)[]; headings: { level: number; text: string; id: string }[] }

/** The EPUB, ready to download. `images` holds the bytes of each image asset by hash. */
export function buildReflowEpub(scene: SceneState, meta: EpubMeta, images: ReadonlyMap<string, ReflowImage>): Uint8Array {
  const lang = meta.language ?? meta.book?.language ?? "en";
  const classOf = new Map<string, string>(); // style id -> css class
  const css: string[] = ["body{font-family:serif;line-height:1.35}img{max-width:100%;height:auto}figure{margin:1em 0;text-align:center}aside.note{font-size:.85em}"];
  const cls = (prefix: string, id: string, rule: string) => {
    const key = prefix + id;
    let c = classOf.get(key);
    if (!c) { c = `${prefix}${[...classOf.keys()].filter((k) => k[0] === prefix).length + 1}`; classOf.set(key, c); if (rule) css.push(`.${c}{${rule}}`); }
    return c;
  };

  const pageIndex = new Map(scene.pages.filter((p) => !p.isMaster).map((p, i) => [p.id, i] as const));
  const pageOf = (n: NodeLite): number => {
    for (let c: NodeLite | undefined = n, g = 0; c && g < 64; c = scene.nodes.get(c.parentId), g++) if (pageIndex.has(c.parentId)) return pageIndex.get(c.parentId)!;
    return -1;
  };
  const continuation = new Set<string>();
  for (const n of scene.nodes.values()) { const next = n.meta?.["text.next"]; if (next) continuation.add(next); }

  type Item = { n: NodeLite; page: number };
  const items: Item[] = [
    ...textNodesInReadingOrder(scene).filter(({ node }) => !continuation.has(node.id) && node.text!.content.trim() !== "").map(({ node }) => ({ n: node, page: pageOf(node) })),
    ...[...scene.nodes.values()].filter((n) => n.kind === "image" && !n.fromMaster && n.image?.assetHash && images.has(n.image.assetHash)).map((n) => ({ n, page: pageOf(n) })),
  ].filter((i) => i.page >= 0);
  // Text keeps the order textNodesInReadingOrder gave it; images slot in by position on their page.
  items.sort((a, b) => a.page - b.page || a.n.y - b.n.y || a.n.x - b.n.x);

  const dests = destinationsOf(scene);
  const labels = pageNumbers(scene.pages);
  const assetFiles = new Map<string, { href: string; mime: string }>();
  const chapters: Chapter[] = [];
  const notes: { id: string; num: number; text: string }[][] = [];
  let footnoteCount = 0;
  let headingCount = 0;
  const open = (title: string) => { chapters.push({ title, blocks: [], headings: [] }); notes.push([]); return chapters[chapters.length - 1]!; };

  for (const { n, page } of items) {
    if (n.kind === "image") {
      const hash = n.image!.assetHash;
      let f = assetFiles.get(hash);
      if (!f) { const img = images.get(hash)!; f = { href: `images/img-${assetFiles.size + 1}.${EXT[img.mime] ?? "bin"}`, mime: img.mime }; assetFiles.set(hash, f); }
      (chapters[chapters.length - 1] ?? open(scene.pages.filter((p) => !p.isMaster)[page]?.name || "Start")).blocks.push({ kind: "img", src: f.href, alt: n.name });
      continue;
    }
    const t = visibleText(scene, n.text!);
    const content = t.content.replace(/\r\n?/g, "\n");
    const tokens = tokensOf(content);
    let ps = 0;
    let listCount = 0, prevList = false;
    content.split("\n").forEach((para, pi) => {
      const start = ps; ps += para.length + 1;
      const styleId = t.paragraphStyles?.[pi] ?? "";
      const flat = styleId ? flattenStyle(scene.textStyles, styleId) : null;
      const level = flat?.outlineLevel ?? 0;
      // Walk the paragraph's characters, applying character-style runs and turning footnote tokens into notes.
      let html = "", plain = "", current = "";
      const close = () => { if (current) html += "</span>"; current = ""; };
      const styleAt = (i: number) => { let id = ""; for (const r of t.runs ?? []) if (i >= r.start && i < r.end) id = r.styleId; return id; };
      for (let i = start; i < start + para.length;) {
        const tok = tokens.find((x) => x.at === i);
        if (tok) {
          close();
          if (tok.kind === "xref") {
            const d = dests.get(tok.text);
            const shown = !d ? "??" : tok.format === "text" ? d.paragraph : labels.get(d.pageId)?.label ?? "??";
            html += xmlEscape(shown); plain += shown;
          }
          if (tok.kind === "footnote" || tok.kind === "endnote") {
            const num = ++footnoteCount;
            (notes[notes.length - 1] ?? (open("Start"), notes[notes.length - 1]!)).push({ id: `fn${num}`, num, text: tok.text });
            html += `<a epub:type="noteref" id="r${num}" href="#fn${num}"><sup>${num}</sup></a>`;
          }
          i = tok.end;
          continue;
        }
        const sid = styleAt(i);
        if (sid !== current) {
          close();
          if (sid) { html += `<span class="${cls("c", sid, cssOf(scene.textStyles[sid]?.style ?? ({} as TextStyleLite)))}">`; current = sid; }
        }
        const ch = String.fromCodePoint(content.codePointAt(i)!);
        html += xmlEscape(ch); plain += ch;
        i += ch.length;
      }
      close();
      if (plain.trim() === "" && html === "") return;
      const isList = flat?.listKind !== undefined;
      listCount = isList ? (prevList ? listCount + 1 : 1) : 0; prevList = isList;
      if (isList) html = `<span class="marker">${flat!.listKind === "bullet" ? (flat!.listMarker || "•") : `${listCount}.`}</span> ${html}`;
      if (level === 1 || chapters.length === 0) open(level === 1 ? plain.trim() : scene.pages.filter((p) => !p.isMaster)[page]?.name || "Start");
      const ch = chapters[chapters.length - 1]!;
      const c = styleId ? cls("p", styleId, cssOf(flat!.style, flat!)) : "";
      if (level > 0) ch.headings.push({ level, text: plain.trim(), id: `h${++headingCount}` });
      ch.blocks.push({ kind: "p", level, cls: c, html, text: plain, ...(level > 0 ? { hid: `h${headingCount}` } : {}) });
    });
  }
  if (chapters.length === 0) throw new Error("nothing to export: no text or images to flow");

  const fileOf = (i: number) => `chapter-${String(i + 1).padStart(3, "0")}.xhtml`;
  const entries: ZipEntry[] = [
    { name: "mimetype", data: bytes("application/epub+zip") },
    { name: "META-INF/container.xml", data: bytes(`<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`) },
    { name: "OEBPS/style.css", data: bytes(css.join("\n") + "\n") },
  ];
  chapters.forEach((ch, i) => {
    const body = ch.blocks.map((b) => {
      if (b.kind === "img") return `<figure><img src="${b.src}" alt="${xmlEscape(b.alt)}"/></figure>`;
      const c = b.cls, hid = b.hid;
      const tag = b.level > 0 ? `h${Math.min(b.level, 6)}` : "p";
      return `<${tag}${c ? ` class="${c}"` : ""}${hid ? ` id="${hid}"` : ""}>${b.html}</${tag}>`;
    }).join("\n");
    const foot = notes[i]!.map((x) => `<aside epub:type="footnote" class="note" id="${x.id}"><p><a href="#r${x.num}">${x.num}</a> ${xmlEscape(x.text)}</p></aside>`).join("\n");
    entries.push({
      name: `OEBPS/${fileOf(i)}`,
      data: bytes(`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${xmlEscape(lang)}"><head><meta charset="utf-8"/><title>${xmlEscape(ch.title)}</title><link rel="stylesheet" href="style.css"/></head><body>\n${body}\n${foot}\n</body></html>`),
    });
  });
  for (const [hash, f] of assetFiles) entries.push({ name: `OEBPS/${f.href}`, data: images.get(hash)!.bytes });

  // Navigation: the headings, nested by level; a chapter without one is listed by its title.
  type Nav = { text: string; href: string; kids: Nav[]; level: number };
  const roots: Nav[] = [], stack: Nav[] = [];
  chapters.forEach((ch, i) => {
    const list = ch.headings.length > 0 ? ch.headings.map((h) => ({ text: h.text, href: `${fileOf(i)}#${h.id}`, kids: [] as Nav[], level: h.level })) : [{ text: ch.title, href: fileOf(i), kids: [] as Nav[], level: 1 }];
    for (const nav of list) {
      while (stack.length && stack[stack.length - 1]!.level >= nav.level) stack.pop();
      (stack.length ? stack[stack.length - 1]!.kids : roots).push(nav);
      stack.push(nav);
    }
  });
  const ol = (list: Nav[]): string => `<ol>${list.map((n) => `<li><a href="${n.href}">${xmlEscape(n.text)}</a>${n.kids.length ? ol(n.kids) : ""}</li>`).join("")}</ol>`;
  const title = xmlEscape(meta.title);
  entries.push({ name: "OEBPS/nav.xhtml", data: bytes(`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${xmlEscape(lang)}"><head><meta charset="utf-8"/><title>${title}</title></head><body><nav epub:type="toc">${ol(roots)}</nav></body></html>`) });

  const manifest = [
    `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`, `<item id="css" href="style.css" media-type="text/css"/>`,
    ...chapters.map((_, i) => `<item id="c${i + 1}" href="${fileOf(i)}" media-type="application/xhtml+xml"/>`),
    ...[...assetFiles.values()].map((f, i) => `<item id="i${i + 1}" href="${f.href}" media-type="${f.mime}"/>`),
  ];
  entries.splice(2, 0, {
    name: "OEBPS/content.opf",
    data: bytes(`<?xml version="1.0" encoding="UTF-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">${opfMetadata(meta)}</metadata><manifest>${manifest.join("")}</manifest><spine>${chapters.map((_, i) => `<itemref idref="c${i + 1}"/>`).join("")}</spine></package>`),
  });
  return zipStore(entries);
}
