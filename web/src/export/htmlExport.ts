import { xmlEscape } from "./epub";

// HTML (one file): every page as inline SVG, in reading order, on a neutral background. Text stays real text (selectable and
// searchable), images are embedded, fonts are NOT (the page uses whatever the viewer has). It is the document as it LOOKS, page by
// page; for text that reflows use the reflowable EPUB.

export interface HtmlPage { name: string; svg: string; width: number; height: number }
export interface HtmlMeta { title: string; language?: string; description?: string }

/** The file, as UTF-8 text. `svg` of each page is a complete `<svg ...>` element. */
export function buildHtml(pages: readonly HtmlPage[], meta: HtmlMeta): string {
  const lang = meta.language || "en";
  const body = pages
    .map((p, i) => `<section class="page" id="page-${i + 1}" aria-label="${xmlEscape(p.name)}" style="max-width:${Math.round(p.width)}px">\n${p.svg.replace(/^<\?xml[^>]*\?>\s*/, "")}\n</section>`)
    .join("\n");
  return `<!doctype html>
<html lang="${xmlEscape(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${xmlEscape(meta.title)}</title>${meta.description ? `\n<meta name="description" content="${xmlEscape(meta.description)}">` : ""}
<style>
body{margin:0;padding:24px 12px;background:#e9e9ec;font-family:system-ui,sans-serif}
.page{margin:0 auto 24px;background:#fff;box-shadow:0 1px 6px rgba(0,0,0,.25)}
.page svg{display:block;width:100%;height:auto}
@media print{body{background:none;padding:0}.page{box-shadow:none;margin:0;max-width:none!important;page-break-after:always}}
</style>
</head>
<body>
${body}
</body>
</html>
`;
}
