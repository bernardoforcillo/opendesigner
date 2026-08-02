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
