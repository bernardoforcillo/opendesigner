import { zipStore, type ZipEntry } from "./zip";

// EPUB 3, FIXED LAYOUT: every page of the document is one XHTML spine item that
// holds the page's SVG as it is exported (export/svg.ts). Fixed layout is the
// right fit for a design: the pages keep their exact geometry instead of being
// reflowed as text. Pure function: the SVG strings come from the caller.

export interface EpubPage {
  name: string;
  /** The page's SVG markup (a complete `<svg>` element). */
  svg: string;
  width: number;
  height: number;
}

export interface EpubMeta {
  title: string;
  /** Stable identifier; defaults to a urn derived from the title. */
  identifier?: string;
  language?: string;
  /** ISO timestamp for dcterms:modified (injectable for reproducible output). */
  modified?: string;
}

const encoder = new TextEncoder();
const bytes = (s: string) => encoder.encode(s);

export function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// The SVG export may start with an XML declaration or carry the default namespace
// already; inside XHTML only the element is wanted.
function inlineSvg(svg: string): string {
  const start = svg.indexOf("<svg");
  const body = start >= 0 ? svg.slice(start) : svg;
  return /xmlns=/.test(body.slice(0, body.indexOf(">")))
    ? body
    : body.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
}

const fileOf = (i: number) => `page-${String(i + 1).padStart(3, "0")}.xhtml`;

export function buildEpub(pages: readonly EpubPage[], meta: EpubMeta): Uint8Array {
  if (pages.length === 0) throw new Error("an EPUB needs at least one page");
  const lang = meta.language ?? "en";
  const title = xmlEscape(meta.title);
  const id = xmlEscape(meta.identifier ?? `urn:opendesigner:${encodeURIComponent(meta.title)}`);
  const modified = (meta.modified ?? new Date().toISOString()).replace(/\.\d+Z$/, "Z");

  const entries: ZipEntry[] = [
    // MUST be first and uncompressed (zipStore never compresses).
    { name: "mimetype", data: bytes("application/epub+zip") },
    {
      name: "META-INF/container.xml",
      data: bytes(
        `<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
      ),
    },
  ];

  const manifest = pages.map((_, i) => `<item id="p${i + 1}" href="${fileOf(i)}" media-type="application/xhtml+xml"/>`);
  const spine = pages.map((_, i) => `<itemref idref="p${i + 1}"/>`);
  entries.push({
    name: "OEBPS/content.opf",
    data: bytes(
      `<?xml version="1.0" encoding="UTF-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" prefix="rendition: http://www.idpf.org/vocab/rendition/#">` +
        `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">` +
        `<dc:identifier id="uid">${id}</dc:identifier><dc:title>${title}</dc:title><dc:language>${xmlEscape(lang)}</dc:language>` +
        `<meta property="dcterms:modified">${modified}</meta>` +
        `<meta property="rendition:layout">pre-paginated</meta><meta property="rendition:orientation">auto</meta><meta property="rendition:spread">none</meta>` +
        `</metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${manifest.join("")}</manifest>` +
        `<spine>${spine.join("")}</spine></package>`,
    ),
  });

  const toc = pages.map((p, i) => `<li><a href="${fileOf(i)}">${xmlEscape(p.name || `Page ${i + 1}`)}</a></li>`).join("");
  entries.push({
    name: "OEBPS/nav.xhtml",
    data: bytes(
      `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${xmlEscape(lang)}"><head><meta charset="utf-8"/><title>${title}</title></head><body><nav epub:type="toc"><ol>${toc}</ol></nav></body></html>`,
    ),
  });

  pages.forEach((p, i) => {
    const w = Math.max(1, Math.ceil(p.width)), h = Math.max(1, Math.ceil(p.height));
    entries.push({
      name: `OEBPS/${fileOf(i)}`,
      data: bytes(
        `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" lang="${xmlEscape(lang)}"><head><meta charset="utf-8"/><title>${xmlEscape(p.name || `Page ${i + 1}`)}</title>` +
          `<meta name="viewport" content="width=${w}, height=${h}"/><style>html,body{margin:0;padding:0}svg{display:block}</style></head><body>${inlineSvg(p.svg)}</body></html>`,
      ),
    });
  });
  return zipStore(entries);
}
