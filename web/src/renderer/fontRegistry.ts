import { assetUrl } from "../rpc/assets";
import type { FontLite } from "../store/types";

// THE DOCUMENT'S FONTS IN THE BROWSER. Each FontFace of the document becomes a CSS
// FontFace added to `document.fonts`, so a text style whose family names it draws
// with the uploaded file -- in the editor, in the prototype player and in PNG export,
// which all go through the 2D canvas. The bytes are a content-addressed asset
// (rpc/assets.ts), downloaded once and cached forever by the browser.
//
// `ui/App.tsx` already redraws on `document.fonts` "loadingdone", so a font that
// arrives later repaints the text that was waiting for it with no extra wiring.
//
// The CanvasKit renderer does not read `document.fonts`: it loads the same files
// itself (renderer/ck/canvaskit.ts::FontBook.setDocumentFonts).

interface FaceSet { add(f: unknown): unknown; delete(f: unknown): unknown }
type FaceCtor = new (family: string, source: string, descriptors: { weight: string; style: string }) => { load(): Promise<unknown> };

const registered = new Map<string, { key: string; face: unknown; loading: boolean }>();
let lastDoc = "";
let lastFonts: Record<string, FontLite> | null = null;

const keyOf = (docId: string, f: FontLite) => `${docId}|${f.assetHash}|${f.family}|${f.weight}|${f.style}`;

/**
 * Brings `document.fonts` in line with the document's fonts: adds the new ones,
 * replaces the changed ones and removes the deleted ones. Idempotent and cheap
 * when nothing changed (same `fonts` object), so the draw loop can call it on
 * every frame.
 */
export function syncDocumentFonts(
  docId: string,
  fonts: Record<string, FontLite>,
  used: ReadonlySet<string> | null = null,
  set: FaceSet | undefined = typeof document !== "undefined" ? (document.fonts as unknown as FaceSet | undefined) : undefined,
  Ctor: FaceCtor | undefined = typeof FontFace !== "undefined" ? (FontFace as unknown as FaceCtor) : undefined,
): void {
  if (!set || !Ctor) return;
  if (fonts === lastFonts && docId === lastDoc) {
    loadUsed(fonts, used);
    return;
  }
  lastFonts = fonts;
  lastDoc = docId;
  for (const [id, cur] of registered) {
    const f = fonts[id];
    if (f && keyOf(docId, f) === cur.key) continue;
    set.delete(cur.face);
    registered.delete(id);
  }
  for (const f of Object.values(fonts)) {
    if (registered.has(f.id)) continue;
    const face = new Ctor(f.family, `url(${assetUrl(docId, f.assetHash)})`, { weight: f.weight, style: f.style });
    registered.set(f.id, { key: keyOf(docId, f), face, loading: false });
    set.add(face);
  }
  loadUsed(fonts, used);
}

// The files are downloaded only for the families the page on screen uses (`used`; null = all). A face
// that is registered but not loaded costs nothing; the browser also loads it on its own the first time
// text with that family is drawn, so this is an optimization and not a requirement.
function loadUsed(fonts: Record<string, FontLite>, used: ReadonlySet<string> | null): void {
  for (const f of Object.values(fonts)) {
    const r = registered.get(f.id);
    if (!r || r.loading) continue;
    if (used && !used.has(f.family.trim().toLowerCase())) continue;
    r.loading = true;
    // A file that fails to load (deleted asset, offline) leaves the text on its fallback font.
    void (r.face as { load(): Promise<unknown> }).load().catch(() => {});
  }
}

/** Test hook: forgets everything this module registered. */
export function resetFontRegistry(): void {
  registered.clear();
  lastFonts = null;
  lastDoc = "";
}
