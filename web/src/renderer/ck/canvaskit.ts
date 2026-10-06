import type { CanvasKit, Font, Typeface } from "canvaskit-wasm";
import { assetUrl } from "../../rpc/assets";
import type { FontLite } from "../../store/types";

// LOADING OF CANVASKIT AND THE FONTS.
//
// CanvasKit is Skia compiled to WebAssembly: the same rasterization engine
// as Chrome, but drivable from here and on WebGL. It weighs ~7 MB, so it is NOT in the
// main bundle: the import is dynamic (a separate file, downloaded only when
// needed) and the module is loaded once per page.
//
// In WASM there are no system fonts. The model's default typeface is
// already Inter (renderer/text.ts::DEFAULT_FONT_FAMILY), so Inter is brought as a
// static file (public/fonts, OFL license) in four weights. Text with another
// family falls back to Inter: it is a declared limit of the GPU renderer, not a
// style choice.

let loading: Promise<CanvasKit> | null = null;

export function loadCanvasKit(): Promise<CanvasKit> {
  if (!loading) {
    loading = (async () => {
      const [{ default: init }, { default: wasmUrl }] = await Promise.all([
        import("canvaskit-wasm"),
        import("canvaskit-wasm/bin/canvaskit.wasm?url"),
      ]);
      return init({ locateFile: () => wasmUrl });
    })();
    // A failed load (network dropped) must not stay memoized: the
    // next attempt restarts from zero.
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}

// The weights for which a file exists. The others are brought to the nearest.
export const FONT_WEIGHTS = [400, 500, 600, 700] as const;
export type FontWeight = (typeof FONT_WEIGHTS)[number];

/** "bold", "normal", "600", "" ... -> the nearest available weight. */
export function nearestWeight(css: string | undefined): FontWeight {
  const s = (css ?? "").trim().toLowerCase();
  let w = 400;
  if (s === "bold") w = 700;
  else if (s === "bolder") w = 700;
  else if (s === "normal" || s === "lighter" || s === "") w = 400;
  else {
    const n = Number.parseInt(s, 10);
    if (Number.isFinite(n)) w = n;
  }
  // 100-300 -> 400; 500 -> 500; 600 -> 600; 700-900 -> 700.
  if (w <= 450) return 400;
  if (w <= 550) return 500;
  if (w <= 650) return 600;
  return 700;
}

export type FetchFont = (url: string) => Promise<ArrayBuffer>;

/** "bold", "normal", "600", "" ... -> a CSS numeric weight 100..900. */
export function cssWeight(css: string | undefined): number {
  const s = (css ?? "").trim().toLowerCase();
  if (s === "bold" || s === "bolder") return 700;
  if (s === "" || s === "normal" || s === "lighter") return 400;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? Math.min(900, Math.max(100, n)) : 400;
}

/** The first family of a CSS family list: `"Brand Sans", sans-serif` -> `Brand Sans`. */
export function firstFamily(list: string | undefined): string {
  return (list ?? "").split(",")[0].trim().replace(/^['"]|['"]$/g, "").toLowerCase();
}

interface CustomFace { font: FontLite; face: Typeface | null }

const defaultFetch: FetchFont = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`font ${url}: HTTP ${res.status}`);
  return res.arrayBuffer();
};

/**
 * The Inter fonts loaded into CanvasKit. 400 is mandatory (without it no
 * text is drawn); the other weights are downloaded on first request and in the
 * meantime the nearest one already ready is used, then `onLoad` asks for a redraw.
 */
export class FontBook {
  private faces = new Map<FontWeight, Typeface>();
  private pending = new Set<FontWeight>();
  private fonts = new Map<string, Font>();
  // The document's uploaded fonts (typography): font id -> its file once loaded.
  private custom = new Map<string, CustomFace>();
  private customDoc = "";
  private customFonts: Record<string, FontLite> | null = null;

  constructor(
    private readonly CK: CanvasKit,
    private readonly onLoad: () => void = () => {},
    private readonly fetchFont: FetchFont = defaultFetch,
    private readonly baseUrl = "/fonts/",
  ) {}

  /** Loads the base weight. Must be awaited before the first draw. */
  async ready(): Promise<void> {
    await this.load(400);
    if (!this.faces.has(400)) throw new Error("base font not loaded");
  }

  private async load(w: FontWeight): Promise<void> {
    if (this.faces.has(w) || this.pending.has(w)) return;
    this.pending.add(w);
    try {
      const data = await this.fetchFont(`${this.baseUrl}Inter-${w}.ttf`);
      const face = this.CK.Typeface.MakeFreeTypeFaceFromData(data);
      if (face) {
        this.faces.set(w, face);
        // Fonts already created for different weights remain valid: they are per (weight,
        // size) and are requested again by fontFor.
        this.onLoad();
      }
    } finally {
      this.pending.delete(w);
    }
  }

  /**
   * Keeps the uploaded fonts in line with the document: loads the new ones,
   * drops the deleted or replaced ones. Cheap when nothing changed (same object),
   * so the renderer can call it every frame. `onLoad` asks for a redraw when a file arrives.
   */
  setDocumentFonts(docId: string, fonts: Record<string, FontLite>): void {
    if (fonts === this.customFonts && docId === this.customDoc) return;
    this.customFonts = fonts;
    const sameDoc = docId === this.customDoc;
    this.customDoc = docId;
    let dropped = false;
    for (const [id, c] of [...this.custom]) {
      const f = sameDoc ? fonts[id] : undefined;
      if (f && f.assetHash === c.font.assetHash && f.family === c.font.family && f.weight === c.font.weight && f.style === c.font.style) continue;
      this.dropCustom(id);
      dropped = true;
    }
    // The text that used a dropped face is measured and drawn again with the fallback.
    if (dropped) this.onLoad();
    for (const f of Object.values(fonts)) {
      if (this.custom.has(f.id)) continue;
      const entry: CustomFace = { font: f, face: null };
      this.custom.set(f.id, entry);
      this.fetchFont(assetUrl(docId, f.assetHash))
        .then((data) => {
          // Replaced or deleted while downloading: the file is not wanted anymore.
          if (this.custom.get(f.id) !== entry) return;
          const face = this.CK.Typeface.MakeFreeTypeFaceFromData(data);
          if (!face) return;
          entry.face = face;
          this.onLoad();
        })
        .catch(() => {});
    }
  }

  private dropCustom(id: string): void {
    const c = this.custom.get(id);
    this.custom.delete(id);
    for (const [key, font] of [...this.fonts]) {
      if (key.startsWith(`c:${id}|`)) { font.delete(); this.fonts.delete(key); }
    }
    c?.face?.delete();
  }

  /** The loaded uploaded face that best matches family, weight and style, or null. */
  private customFor(family: string | undefined, css: string | undefined, italic: boolean): CustomFace | null {
    if (this.custom.size === 0) return null;
    const want = firstFamily(family);
    const w = cssWeight(css);
    let best: CustomFace | null = null;
    for (const c of this.custom.values()) {
      if (!c.face || c.font.family.toLowerCase() !== want) continue;
      const better = (a: CustomFace, b: CustomFace) => {
        const sa = (a.font.style === "italic") === italic ? 0 : 1;
        const sb = (b.font.style === "italic") === italic ? 0 : 1;
        if (sa !== sb) return sa < sb;
        return Math.abs(Number(a.font.weight) - w) < Math.abs(Number(b.font.weight) - w);
      };
      if (!best || better(c, best)) best = c;
    }
    return best;
  }

  /** The Font for weight and size, or null if no face exists yet. An uploaded family wins over Inter. */
  fontFor(css: string | undefined, size: number, family?: string, italic = false): Font | null {
    const custom = this.customFor(family, css, italic);
    if (custom?.face) {
      const key = `c:${custom.font.id}|${size}`;
      let font = this.fonts.get(key);
      if (!font) {
        font = new this.CK.Font(custom.face, size);
        font.setSubpixel(true);
        font.setHinting(this.CK.FontHinting.None);
        font.setEdging(this.CK.FontEdging.SubpixelAntiAlias);
        this.fonts.set(key, font);
      }
      return font;
    }
    const want = nearestWeight(css);
    if (!this.faces.has(want)) void this.load(want).catch(() => {});
    // The nearest ready weight to the wanted one.
    let have: FontWeight | null = null;
    for (const w of FONT_WEIGHTS) {
      if (!this.faces.has(w)) continue;
      if (have === null || Math.abs(w - want) < Math.abs(have - want)) have = w;
    }
    if (have === null) return null;
    const key = `${have}|${size}`;
    let font = this.fonts.get(key);
    if (!font) {
      font = new this.CK.Font(this.faces.get(have) as Typeface, size);
      font.setSubpixel(true);
      font.setHinting(this.CK.FontHinting.None);
      font.setEdging(this.CK.FontEdging.SubpixelAntiAlias);
      this.fonts.set(key, font);
    }
    return font;
  }

  dispose(): void {
    for (const id of [...this.custom.keys()]) this.dropCustom(id);
    for (const f of this.fonts.values()) f.delete();
    for (const t of this.faces.values()) t.delete();
    this.fonts.clear();
    this.faces.clear();
  }
}
