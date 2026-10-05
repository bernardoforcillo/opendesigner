import type { CanvasKit, Font, Typeface } from "canvaskit-wasm";

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

  /** The Font for weight and size, or null if no face exists yet. */
  fontFor(css: string | undefined, size: number): Font | null {
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
    for (const f of this.fonts.values()) f.delete();
    for (const t of this.faces.values()) t.delete();
    this.fonts.clear();
    this.faces.clear();
  }
}
