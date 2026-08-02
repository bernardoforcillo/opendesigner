import { drawScene } from "../renderer/canvasRenderer";
import type { ExportRegion } from "./region";

// EXPORT PNG — un canvas FUORI SCHERMO, alla scala scelta.
//
// Il disegno lo fa `drawScene`, cioè il renderer del canvas, non una seconda
// copia scritta per l'export. È l'unico modo perché l'immagine esportata resti
// fedele mentre l'editor cresce: ogni forma, ogni stile e ogni correzione che
// arriveranno nel renderer arriveranno anche qui, senza che nessuno debba
// ricordarsi di aggiornare due posti. Il prezzo è una `SceneState` ridotta ai
// nodi da esportare (la costruisce export/region.ts) e una camera COSTRUITA
// invece che letta -- che è anche il modo in cui l'export smette di dipendere
// da dove l'utente aveva scrollato.

// Le scale offerte. 1x/2x/3x sono le densità che contano davvero (schermo
// normale, retina, telefono ad alta densità); un moltiplicatore libero
// aggiungerebbe solo modi di sbagliare.
export const EXPORT_SCALES = [1, 2, 3] as const;
export type ExportScale = (typeof EXPORT_SCALES)[number];

// IL TETTO DEL CANVAS, e perché serve un controllo NOSTRO.
//
// Un canvas troppo grande non fallisce nello stesso modo dappertutto. Firefox
// non alloca e `getContext("2d")` ritorna `null` -- rumoroso, e lo intercetta
// il controllo più sotto. Chrome invece ritorna un contesto REGOLARE su un
// bitmap che non esiste: `drawScene` disegna senza errori, non si vede niente,
// e `toBlob` produce un PNG valido e VUOTO. Senza questo tetto l'utente
// scaricherebbe un'immagine bianca senza un solo messaggio -- il modo peggiore
// di fallire, perché sembra riuscito.
//
// I due numeri sono limiti veri dei motori, non stime, e sono DUE perché i
// motori ne impongono due indipendenti:
//   - 32 767 px per LATO: il più stretto dei limiti per lato in circolazione
//     (Firefox; Chrome e Safari arrivano a 65 535). Un nastro 40 000 × 100 ha
//     un'area minuscola e resta comunque impossibile.
//   - 268 435 456 px di AREA (2^28, il limite di Chrome, il più stretto fra
//     quelli di area): è questo che una regione di 6000 × 6000 unità a 3x
//     supera, con 324 Mpx e nessun lato fuori norma.
// Sotto entrambi il canvas si alloca; sopra ci sarebbero comunque più di un
// miliardo di byte di pixel da codificare.
export const MAX_CANVAS_SIDE = 32_767;
export const MAX_CANVAS_AREA = 268_435_456;

function megapixels(px: number): string {
  return `${(px / 1e6).toFixed(1)} Mpx`;
}

/**
 * `null` se un canvas di `width × height` è allocabile, altrimenti il MOTIVO
 * per cui non lo è -- già scritto per essere letto dall'utente, perché è
 * esattamente quello che ne farà `runExport` (un `notice`, come ogni altro
 * modo in cui questo export può non riuscire).
 *
 * Il messaggio dice la dimensione chiesta, il limite e le vie d'uscita: un
 * avviso che dicesse solo "troppo grande" lascerebbe l'utente a indovinare.
 */
export function canvasLimitMessage(width: number, height: number): string | null {
  const area = width * height;
  if (width <= MAX_CANVAS_SIDE && height <= MAX_CANVAS_SIDE && area <= MAX_CANVAS_AREA) return null;
  return (
    `l'immagine chiesta è troppo grande: ${width}×${height} px (${megapixels(area)}), ` +
    `oltre il limite del canvas del browser (${MAX_CANVAS_SIDE} px per lato, ` +
    `${megapixels(MAX_CANVAS_AREA)} in tutto); ` +
    `scegli una scala più bassa, esporta una selezione più piccola, o usa l'SVG`
  );
}

function defaultCanvas(): HTMLCanvasElement {
  return document.createElement("canvas");
}

/**
 * Disegna la regione su un canvas fuori schermo di `bounds * scale` pixel.
 *
 * Il canvas si crea per iniezione così il calcolo resta verificabile senza un
 * contesto 2D vero (jsdom non ne ha uno): la prova che i PIXEL siano giusti
 * arriva dalla verifica in browser, quella che si può fare qui è che il canvas
 * sia della dimensione giusta e trasformato nel modo giusto.
 */
export function renderRegionToCanvas(
  region: ExportRegion,
  scale: number,
  createCanvas: () => HTMLCanvasElement = defaultCanvas,
): HTMLCanvasElement {
  const { bounds } = region;
  // Per ECCESSO, e mai sotto 1: arrotondare per difetto taglierebbe l'ultima
  // frazione di pixel del disegno, e un canvas con un lato a zero fa fallire
  // toBlob invece di produrre un'immagine vuota.
  const width = Math.max(1, Math.ceil(bounds.width * scale));
  const height = Math.max(1, Math.ceil(bounds.height * scale));

  // Il tetto si controlla PRIMA di allocare: oltre il limite Chrome non
  // fallisce, disegna nel vuoto (vedi MAX_CANVAS_AREA). L'errore diventa un
  // avviso in runExport, come ogni altro modo in cui l'export non riesce.
  const tooBig = canvasLimitMessage(width, height);
  if (tooBig) throw new Error(tooBig);

  const canvas = createCanvas();
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("il contesto 2D del canvas di export non è disponibile");

  // La camera dell'export: zoom = scala scelta, origine spostata sull'angolo
  // della regione. Non è la camera dell'utente e non la legge -- è costruita
  // qui apposta, ed è ciò che garantisce che due export dello stesso documento
  // diano lo stesso file da qualunque posizione della vista.
  //
  // dpr: 1 perché un canvas fuori schermo non ha un dispositivo. La scala la
  // decide l'utente (1x/2x/3x) e il devicePixelRatio della macchina non deve
  // moltiplicarla.
  drawScene(
    ctx,
    region.scene,
    { x: -bounds.x * scale, y: -bounds.y * scale, zoom: scale },
    { dpr: 1 },
  );
  return canvas;
}

/**
 * I byte PNG del canvas. `toBlob` è asincrona e può rispondere `null` (memoria
 * esaurita, canvas contaminato): diventa un errore, perché un download di un
 * file vuoto sarebbe peggio di un messaggio.
 */
export function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("la codifica PNG non ha prodotto nessun dato"));
    }, "image/png");
  });
}
