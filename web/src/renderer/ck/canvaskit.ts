import type { CanvasKit, Font, Typeface } from "canvaskit-wasm";

// CARICAMENTO DI CANVASKIT E DEI FONT.
//
// CanvasKit è Skia compilato in WebAssembly: lo stesso motore di rasterizzazione
// di Chrome, ma pilotabile da qui e su WebGL. Pesa ~7 MB, quindi NON sta nel
// bundle principale: l'import è dinamico (un file a parte, scaricato solo quando
// serve) e il modulo si carica una volta sola per pagina.
//
// In WASM non ci sono font di sistema. Il carattere predefinito del modello è
// già Inter (renderer/text.ts::DEFAULT_FONT_FAMILY), quindi si porta Inter come
// file statico (public/fonts, licenza OFL) in quattro pesi. Un testo con un'altra
// famiglia ricade su Inter: è un limite dichiarato del renderer GPU, non una
// scelta di stile.

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
    // Un caricamento fallito (rete caduta) non deve restare memorizzato: il
    // tentativo dopo riparte da zero.
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}

// I pesi per cui esiste un file. Gli altri si portano al più vicino.
export const FONT_WEIGHTS = [400, 500, 600, 700] as const;
export type FontWeight = (typeof FONT_WEIGHTS)[number];

/** "bold", "normal", "600", "" ... -> il peso disponibile più vicino. */
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
 * I font di Inter caricati in CanvasKit. Il 400 è obbligatorio (senza non si
 * disegna testo); gli altri pesi si scaricano alla prima richiesta e nel
 * frattempo si usa il più vicino già pronto, poi `onLoad` chiede un ridisegno.
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

  /** Carica il peso di base. Va atteso prima del primo disegno. */
  async ready(): Promise<void> {
    await this.load(400);
    if (!this.faces.has(400)) throw new Error("font di base non caricato");
  }

  private async load(w: FontWeight): Promise<void> {
    if (this.faces.has(w) || this.pending.has(w)) return;
    this.pending.add(w);
    try {
      const data = await this.fetchFont(`${this.baseUrl}Inter-${w}.ttf`);
      const face = this.CK.Typeface.MakeFreeTypeFaceFromData(data);
      if (face) {
        this.faces.set(w, face);
        // I Font già creati per pesi diversi restano validi: sono per (peso,
        // corpo) e vengono richiesti di nuovo da fontFor.
        this.onLoad();
      }
    } finally {
      this.pending.delete(w);
    }
  }

  /** Il Font per peso e corpo, o null se non c'è ancora nessuna faccia. */
  fontFor(css: string | undefined, size: number): Font | null {
    const want = nearestWeight(css);
    if (!this.faces.has(want)) void this.load(want).catch(() => {});
    // Il peso pronto più vicino a quello voluto.
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
