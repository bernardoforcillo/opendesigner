import { useScene } from "../store/store";
import { fontString } from "../renderer/text";
import { assetUrl } from "../rpc/assets";
import type { ImageSource } from "../renderer/canvasRenderer";
import type { NodeLite } from "../store/types";
import { exportRegion, type ExportRegion, type ExportScope } from "./region";
import { nodesToSvg, type MeasureText, type ResolveImageHref } from "./svg";
import { canvasToPngBlob, renderRegionToCanvas, type ExportScale } from "./png";

// EXPORT — il comando.
//
// Perché LATO CLIENT. Il design originale prevedeva `ExportImage` come RPC
// server-stream con avanzamento. Per un editor LOCALE è la forma sbagliata: il
// browser ha già la scena e già il renderer che la disegna: mandare il
// documento a Go, ridisegnarlo lì con un secondo renderer e riportare indietro
// i byte aggiungerebbe un giro di rete e -- soprattutto -- una SECONDA
// implementazione del disegno, destinata a divergere da quella che l'utente
// vede sullo schermo. L'export sarebbe l'unica funzione dell'app che non mostra
// ciò che mostra il canvas. L'avanzamento, poi, ha senso su un rendering di
// minuti, non su un canvas che si disegna in un frame.
//
// Quindi: niente `ExportImage` nel proto, niente route sul server, nessun
// percorso a metà. Il PNG passa da un canvas fuori schermo (export/png.ts) e
// l'SVG da un generatore puro (export/svg.ts).

export type ExportFormat = "png" | "svg";

export interface ExportRequest {
  format: ExportFormat;
  scope: ExportScope;
  // Usata solo dal PNG: l'SVG è vettoriale, una "scala" non vuol dire niente.
  scale: ExportScale;
}

// Le dipendenze di CONTORNO (canvas, codifica, salvataggio, misura del testo),
// iniettabili perché nessuna delle quattro esiste in Node: è ciò che rende
// verificabile il percorso senza un browser.
export interface ExportDeps {
  createCanvas?: () => HTMLCanvasElement;
  toPngBlob?: (canvas: HTMLCanvasElement) => Promise<Blob>;
  download?: (blob: Blob, filename: string) => void;
  measure?: MeasureText;
  // I byte di un asset come data URI. Iniettabile come le altre: vuole `fetch`
  // e `FileReader`, che in un test non ci sono. La usano ENTRAMBI i formati --
  // l'SVG per incorporarli, il PNG per decodificarli e disegnarli.
  loadAssetDataUrl?: (docId: string, hash: string) => Promise<string | null>;
  // Come si passa da quei byte a qualcosa che `drawImage` sa disegnare, per il
  // PNG. Iniettabile perché vuole `new Image()` e una decodifica vera.
  decodeImage?: (dataUrl: string) => Promise<HTMLImageElement | null>;
}

const NOTHING_SELECTED =
  "non c'è niente da esportare: seleziona qualcosa, oppure esporta l'intera pagina";
const EMPTY_PAGE = "non c'è niente da esportare: la pagina è vuota";

// I caratteri che Windows non accetta in un nome di file (gli altri sistemi ne
// vietano meno, quindi questo insieme va bene ovunque), più i caratteri di
// controllo. Il nome del documento lo scrive l'utente e può contenerli.
const ILLEGAL_IN_FILENAME = /[\\/:*?"<>|\x00-\x1f]/g;

// Spazi, trattini e punti in TESTA o in CODA: un nome che finisce con un punto
// è invalido su Windows, uno che comincia con un punto è un file nascosto su
// Unix, e i trattini agli estremi sono quasi sempre il residuo dei caratteri
// appena tolti (un documento chiamato "///" darebbe "---").
const TRIM_FROM_FILENAME = /^[-\s.]+|[-\s.]+$/g;

const FALLBACK_NAME = "opendesigner";

/**
 * Il nome del file proposto per il download: nome del documento, l'ambito se è
 * una selezione, la scala se non è 1x, e l'estensione.
 *
 * Il suffisso di scala è quello che usano gli editor di design (`@2x`), e serve
 * a una cosa concreta: esportare lo stesso documento a due scale non deve
 * produrre due file con lo stesso nome.
 */
export function exportFileName(docName: string, req: ExportRequest): string {
  const base =
    docName.replace(ILLEGAL_IN_FILENAME, "-").replace(TRIM_FROM_FILENAME, "") || FALLBACK_NAME;
  const scope = req.scope === "selection" ? "-selezione" : "";
  const scale = req.format === "png" && req.scale !== 1 ? `@${req.scale}x` : "";
  return `${base}${scope}${scale}.${req.format}`;
}

/**
 * Consegna il blob all'utente come download.
 *
 * L'ancora entra davvero nel documento prima del click: in alcuni browser un
 * elemento staccato non attiva il download. L'URL si revoca in un timer e non
 * subito dopo il click, perché il download parte in modo asincrono e revocare
 * l'URL nello stesso giro di eventi lo annullerebbe.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * La misura del testo per l'SVG, presa da un canvas vero.
 *
 * È la STESSA misura che usa il canvas per andare a capo (`ctx.measureText` con
 * `ctx.font` impostato da `fontString`), quindi l'SVG esportato spezza le righe
 * esattamente dove le spezza lo schermo. Approssimarla qui -- tot pixel per
 * carattere -- darebbe un file che assomiglia al documento senza esserlo.
 */
export function canvasMeasure(createCanvas: () => HTMLCanvasElement): MeasureText {
  const ctx = createCanvas().getContext("2d");
  if (!ctx) throw new Error("il contesto 2D del canvas di export non è disponibile");
  return (text, style) => {
    ctx.font = fontString(style);
    return ctx.measureText(text).width;
  };
}

function defaultCanvas(): HTMLCanvasElement {
  return document.createElement("canvas");
}

// `charset=utf-8` non è decorativo: senza, un file SVG con del testo accentato
// aperto da un browser viene interpretato in latin-1.
const SVG_MIME = "image/svg+xml;charset=utf-8";

/**
 * I byte di un asset come `data:` URI, presi dalla route che li serve.
 *
 * Passa dai BYTE ORIGINALI e non da un ri-encoding del canvas: un JPEG
 * riscritto in PNG cambierebbe peso e (per un'immagine con perdita) qualità,
 * dentro un file che l'utente esporta proprio per consegnarlo a qualcun altro.
 * L'immagine decodificata nella cache del renderer non serve qui: quello che
 * serve sono i byte, e la risposta arriva quasi sempre dalla cache HTTP del
 * browser (la route è `immutable`).
 */
export async function fetchAssetDataUrl(docId: string, hash: string): Promise<string | null> {
  const res = await fetch(assetUrl(docId, hash));
  if (!res.ok) return null;
  const blob = await res.blob();
  return await new Promise<string | null>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    // Un asset illeggibile non fa fallire l'export: diventa un segnaposto, come
    // sul canvas.
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

/**
 * Un data URI in un elemento disegnabile. Non lancia MAI: un asset che non si
 * decodifica è un'immagine mancante, non un export fallito.
 *
 * Dimensioni nulle valgono come fallimento per la stessa ragione della cache
 * del renderer: alcuni browser emettono `load` su byte illeggibili, e disegnare
 * quell'elemento non produce pixel -- meglio il segnaposto del nulla.
 */
export function decodeDataUrl(dataUrl: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth > 0 && img.naturalHeight > 0 ? img : null);
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

// Gli asset della regione, RISOLTI e ATTESI: gli href per l'SVG, le immagini
// decodificate per il PNG, e quanti nodi immagine resteranno un segnaposto.
interface ResolvedAssets {
  href: ResolveImageHref;
  images: ImageSource;
  missing: number;
}

// Nessuna immagine per quell'hash. Non ritorna MAI "loading": l'export ha già
// aspettato, quindi ogni nodo è o disegnato o segnaposto -- non "in arrivo".
const NO_IMAGE = { status: "missing", image: null } as const;

/**
 * Risolve in anticipo gli asset dei nodi immagine, per entrambi i formati.
 *
 * PRIMA e non durante, per due ragioni diverse e ugualmente vincolanti.
 * `nodesToSvg` è una funzione PURA e sincrona e deve restarlo -- è ciò che
 * rende verificabile a tavolino la correttezza del markup. E `drawScene` è
 * SINCRONA per costruzione (gira in un render loop): se le immagini non sono
 * già pronte quando comincia a disegnare, disegna il segnaposto e non c'è un
 * secondo giro. Prendere i pixel dalla cache del renderer -- che si riempie da
 * sé, quando può -- vorrebbe dire che lo stesso documento esportato due volte
 * dà due file diversi a seconda di che cosa questa sessione ha già visto
 * passare: esportare appena aperto darebbe le croci del segnaposto, esportare
 * un secondo dopo le fotografie. Qui i byte si chiedono e si ASPETTANO, sempre,
 * e la sorgente delle immagini è LOCALE a questo export.
 *
 * Gli hash sono deduplicati: la stessa immagine usata da dieci nodi si scarica
 * (e si decodifica) una volta sola. La decodifica la fa solo il PNG: all'SVG i
 * byte bastano così come sono, ed è anche il motivo per cui l'SVG incorpora il
 * file ORIGINALE invece di un ri-encoding.
 */
async function resolveAssets(
  nodes: readonly NodeLite[],
  docId: string,
  format: ExportFormat,
  deps: ExportDeps,
): Promise<ResolvedAssets> {
  const load = deps.loadAssetDataUrl ?? fetchAssetDataUrl;
  const decode = deps.decodeImage ?? decodeDataUrl;
  const imageNodes = nodes.filter((n) => n.kind === "image");
  const hashes = [...new Set(imageNodes.map((n) => n.image?.assetHash ?? "").filter((h) => h !== ""))];

  const uris = new Map<string, string>();
  const decoded = new Map<string, HTMLImageElement>();
  await Promise.all(
    hashes.map(async (hash) => {
      try {
        const uri = await load(docId, hash);
        if (uri === null) return;
        uris.set(hash, uri);
        if (format !== "png") return;
        const img = await decode(uri);
        if (img) decoded.set(hash, img);
      } catch {
        // Un asset che non si scarica è un'immagine MANCANTE, non un export
        // fallito: il documento contiene davvero un riferimento rotto, e il
        // file lo mostra invece di non esistere.
      }
    }),
  );

  // Si contano i NODI e non gli hash: è quello che l'utente vede mancare nel
  // file, ed è anche l'unico modo di contare i nodi il cui hash è vuoto -- che
  // non hanno niente da chiedere e restano comunque un segnaposto.
  const ok = format === "png" ? decoded : uris;
  const missing = imageNodes.filter((n) => !ok.has(n.image?.assetHash ?? "")).length;

  return {
    href: (hash) => uris.get(hash) ?? null,
    images: {
      get: (_docId, hash) => {
        const img = decoded.get(hash);
        return img ? { status: "ready", image: img } : NO_IMAGE;
      },
    },
    missing,
  };
}

/** Quel che si dice quando il file esce con dei buchi. */
function missingImagesNotice(count: number): string {
  return count === 1
    ? "un'immagine non è stata inclusa: il suo file non è raggiungibile, e al suo posto c'è un segnaposto"
    : `${count} immagini non sono state incluse: i loro file non sono raggiungibili, e al loro posto ci sono dei segnaposti`;
}

// I byte del file. Le due strade sono davvero diverse -- il PNG passa da un
// canvas e da una codifica asincrona, l'SVG da una funzione pura -- e tenerle
// in due rami leggibili invece che in un ternario annidato è tutto il vantaggio
// di questa funzione.
async function exportBlob(
  region: ExportRegion,
  req: ExportRequest,
  deps: ExportDeps,
  createCanvas: () => HTMLCanvasElement,
  measure: MeasureText,
  assets: ResolvedAssets,
): Promise<Blob> {
  if (req.format === "png") {
    // Le immagini arrivano da qui e NON dalla cache del renderer: sono già
    // decodificate e già attese, quindi il disegno è deterministico.
    const canvas = renderRegionToCanvas(region, req.scale, createCanvas, assets.images);
    return (deps.toPngBlob ?? canvasToPngBlob)(canvas);
  }
  return new Blob([nodesToSvg(region.nodes, region.bounds, measure, assets.href)], { type: SVG_MIME });
}

/**
 * Esegue un export. Ritorna `false` (senza scaricare niente) quando non c'è
 * nulla da esportare o quando qualcosa va storto: in entrambi i casi il motivo
 * finisce in `notice`, il canale informativo dello store.
 *
 * Passa da `notice` e non da `lastError`: nessuna modifica è stata annullata --
 * l'export non tocca il documento, e infatti non apre nessun gesto e non
 * produce nessun op. È l'unica funzione dell'app che legge la scena e basta.
 */
export async function runExport(req: ExportRequest, deps: ExportDeps = {}): Promise<boolean> {
  const { scene, selection } = useScene.getState();
  if (!scene) return false;

  const createCanvas = deps.createCanvas ?? defaultCanvas;
  try {
    // La misura del testo si costruisce PRIMA della regione, e per ENTRAMBI i
    // formati: non serve solo a mandare a capo l'SVG, serve a sapere quanto è
    // alto il testo -- cioè a dimensionare la regione, quindi anche il canvas
    // del PNG (vedi export/region.ts). Sta dentro il try perché costruirla
    // vuole un contesto 2D, che può non esserci: un motivo in più per cui un
    // export può non riuscire, e passa dal canale di tutti gli altri.
    const measure = deps.measure ?? canvasMeasure(createCanvas);

    const region = exportRegion(scene, selection, req.scope, measure);
    if (!region) {
      useScene.setState({ notice: req.scope === "selection" ? NOTHING_SELECTED : EMPTY_PAGE });
      return false;
    }

    const assets = await resolveAssets(region.nodes, scene.id, req.format, deps);
    const blob = await exportBlob(region, req, deps, createCanvas, measure, assets);
    (deps.download ?? downloadBlob)(blob, exportFileName(scene.name, req));
    // Il file c'è ed è quello chiesto, ma contiene dei segnaposti al posto di
    // delle fotografie: un export che riesce a METÀ e non lo dice è il modo
    // peggiore di fallire, perché l'utente se ne accorge da qualcun altro.
    if (assets.missing > 0) useScene.setState({ notice: missingImagesNotice(assets.missing) });
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    useScene.setState({ notice: `export non riuscito: ${reason}` });
    return false;
  }
}
