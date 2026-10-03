import type { CodeFile } from "./codegen";
import { textOf } from "./codegen";

// L'ANTEPRIMA: la schermata generata (target HTML) dentro un iframe `srcdoc`
// sandboxed, accanto al codice. Un file HTML del target html è AUTOCONTENUTO (CSS
// nel <style>), ma due cose non funzionano da srcdoc e qui si sistemano:
//  - le immagini (`assets/<hash>.png`) sono percorsi relativi a una cartella che
//    nel srcdoc non esiste -> si riscrivono come data: URI coi byte già in mano;
//  - i link fra schermate (`<a href="pagamento.html">`) navigherebbero l'iframe
//    verso il nulla -> un micro-script li intercetta e avvisa la pagina madre con
//    postMessage, che cambia la schermata mostrata.
// Il sandbox è `allow-scripts` SENZA allow-same-origin: lo script è nostro, ma il
// contenuto non può toccare la pagina madre né il suo storage.

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

/** Il documento da mettere in `srcdoc` per il file HTML `path` (null se non esiste). */
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

/** Il file a cui punta un href dell'anteprima (relativo, senza ./ né query), o null. */
export function resolvePreviewHref(files: readonly CodeFile[], href: string): string | null {
  const clean = href.replace(/^\.\//, "").replace(/[?#].*$/, "");
  return files.some((f) => f.path === clean) ? clean : null;
}
