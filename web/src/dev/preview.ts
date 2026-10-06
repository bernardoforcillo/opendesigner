import type { CodeFile } from "./codegen";
import { textOf } from "./codegen";

// THE PREVIEW: the generated screen (html target) inside a sandboxed
// `srcdoc` iframe, next to the code. An HTML file of the html target is SELF-CONTAINED (CSS
// in the <style>), but two things do not work from srcdoc and are fixed here:
//  - images (`assets/<hash>.png`) are paths relative to a folder that
//    does not exist in srcdoc -> they are rewritten as data: URIs with the bytes already in hand;
//  - links between screens (`<a href="payment.html">`) would navigate the iframe
//    to nowhere -> a micro-script intercepts them and notifies the parent page with
//    postMessage, which changes the screen shown.
// The sandbox is `allow-scripts` WITHOUT allow-same-origin: the script is ours, but the
// content cannot touch the parent page or its storage.

export const PREVIEW_MSG = "odPreviewNav";

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  avif: "image/avif", svg: "image/svg+xml", ico: "image/x-icon",
};

function base64(bytes: Uint8Array): string {
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(s);
}

const INTERCEPT =
  `<script>document.addEventListener("click",function(e){var a=e.target&&e.target.closest&&e.target.closest("a[href]");` +
  `if(!a)return;var h=a.getAttribute("href")||"";e.preventDefault();` +
  `if(h&&!/^([a-z][a-z0-9+.-]*:|#)/i.test(h))parent.postMessage({${PREVIEW_MSG}:h},"*")},true)</script>`;

/** The document to put in `srcdoc` for the HTML file `path` (null if it does not exist). */
export function previewDoc(files: readonly CodeFile[], path: string): string | null {
  const page = files.find((f) => f.path === path);
  if (!page) return null;
  let html = textOf(page);
  for (const f of files) {
    if (!f.path.startsWith("assets/")) continue;
    const mime = MIME[f.path.slice(f.path.lastIndexOf(".") + 1).toLowerCase()];
    if (!mime || !html.includes(f.path)) continue;
    html = html.split(f.path).join(`data:${mime};base64,${base64(f.bytes)}`);
  }
  const i = html.toLowerCase().lastIndexOf("</body>");
  return i >= 0 ? html.slice(0, i) + INTERCEPT + html.slice(i) : html + INTERCEPT;
}

/** The file an href in the preview points to (relative, without ./ or query), or null. */
export function resolvePreviewHref(files: readonly CodeFile[], href: string): string | null {
  const clean = href.replace(/^\.\//, "").replace(/[?#].*$/, "");
  return files.some((f) => f.path === clean) ? clean : null;
}
