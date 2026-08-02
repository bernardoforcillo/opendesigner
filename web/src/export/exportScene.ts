import { useScene } from "../store/store";
import { fontString } from "../renderer/text";
import { assetUrl } from "../rpc/assets";
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
  // I byte di un asset come data URI, per l'SVG. Iniettabile come le altre:
  // vuole `fetch` e `FileReader`, che in un test non ci sono.
  loadAssetDataUrl?: (docId: string, hash: string) => Promise<string | null>;
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

const FALLBACK_NAME = "brawt";

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
 * Risolve in anticipo gli asset dei nodi immagine e ritorna la funzione che
 * `nodesToSvg` userà per gli href.
 *
 * Prima e non durante: `nodesToSvg` è una funzione PURA e sincrona, e deve
 * restarlo -- è ciò che rende verificabile a tavolino la correttezza del
 * markup. Gli hash sono deduplicati: la stessa immagine usata da dieci nodi si
 * scarica (e si incorpora) una volta sola.
 */
async function imageHrefs(
  nodes: readonly NodeLite[],
  docId: string,
  load: (docId: string, hash: string) => Promise<string | null>,
): Promise<ResolveImageHref> {
  const hashes = [
    ...new Set(
      nodes
        .filter((n) => n.kind === "image")
        .map((n) => n.image?.assetHash ?? "")
        .filter((h) => h !== ""),
    ),
  ];
  const resolved = new Map<string, string>();
  await Promise.all(
    hashes.map(async (hash) => {
      try {
        const uri = await load(docId, hash);
        if (uri !== null) resolved.set(hash, uri);
      } catch {
        // Un asset che non si scarica è un'immagine MANCANTE, non un export
        // fallito: il documento contiene davvero un riferimento rotto, e il
        // file lo mostra invece di non esistere.
      }
    }),
  );
  return (hash) => resolved.get(hash) ?? null;
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
  docId: string,
): Promise<Blob> {
  if (req.format === "png") {
    // Nessun asset da scaricare: il PNG passa da drawScene, che prende le
    // immagini già decodificate dalla cache del renderer.
    const canvas = renderRegionToCanvas(region, req.scale, createCanvas);
    return (deps.toPngBlob ?? canvasToPngBlob)(canvas);
  }
  const href = await imageHrefs(region.nodes, docId, deps.loadAssetDataUrl ?? fetchAssetDataUrl);
  return new Blob([nodesToSvg(region.nodes, region.bounds, measure, href)], { type: SVG_MIME });
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

    const blob = await exportBlob(region, req, deps, createCanvas, measure, scene.id);
    (deps.download ?? downloadBlob)(blob, exportFileName(scene.name, req));
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    useScene.setState({ notice: `export non riuscito: ${reason}` });
    return false;
  }
}
