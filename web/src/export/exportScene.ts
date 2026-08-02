import { useScene } from "../store/store";
import { fontString } from "../renderer/text";
import { exportRegion, type ExportRegion, type ExportScope } from "./region";
import { nodesToSvg, type MeasureText } from "./svg";
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

// I byte del file. Le due strade sono davvero diverse -- il PNG passa da un
// canvas e da una codifica asincrona, l'SVG da una funzione pura -- e tenerle
// in due rami leggibili invece che in un ternario annidato è tutto il vantaggio
// di questa funzione.
async function exportBlob(
  region: ExportRegion,
  req: ExportRequest,
  deps: ExportDeps,
  createCanvas: () => HTMLCanvasElement,
): Promise<Blob> {
  if (req.format === "png") {
    const canvas = renderRegionToCanvas(region, req.scale, createCanvas);
    return (deps.toPngBlob ?? canvasToPngBlob)(canvas);
  }
  const measure = deps.measure ?? canvasMeasure(createCanvas);
  return new Blob([nodesToSvg(region.nodes, region.bounds, measure)], { type: SVG_MIME });
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

  const region = exportRegion(scene, selection, req.scope);
  if (!region) {
    useScene.setState({ notice: req.scope === "selection" ? NOTHING_SELECTED : EMPTY_PAGE });
    return false;
  }

  try {
    const blob = await exportBlob(region, req, deps, deps.createCanvas ?? defaultCanvas);
    (deps.download ?? downloadBlob)(blob, exportFileName(scene.name, req));
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    useScene.setState({ notice: `export non riuscito: ${reason}` });
    return false;
  }
}
