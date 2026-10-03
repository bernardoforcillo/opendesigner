import { screenToWorld } from "../canvas/camera";
import { nextOrderKey } from "../store/orderKey";
import { useScene } from "../store/store";
import type { TextStyleLite } from "../store/types";
import { uploadAsset, type AssetRef } from "../rpc/assets";
import { fontString } from "../renderer/text";
import { SvgImportError, importSvg } from "../svg/importSvg";

// IMPORTA UN SVG NEL DOCUMENTO.
//
// Un solo punto d'ingresso, `importSvgAt`, per i TRE modi in cui un SVG può
// arrivare: trascinato sul canvas (tools/imageDrop.ts), incollato come testo
// (tools/clipboard.ts) e scelto da "Importa SVG…" (ui/shell/DocMenu.tsx). Tutti
// e tre finiscono qui perché le regole sono le stesse e devono restare tali:
//   - UN gesto = UNA voce di undo, anche per cento nodi;
//   - la radice importata si seleziona subito;
//   - l'esito si dice nel canale `notice` (non `lastError`: nessuna modifica è
//     stata annullata, è un'informazione): "Importato come N livelli" più gli
//     avvisi su ciò che il modello non sa rappresentare.
//
// L'import vero (testo -> op) è puro e vive in svg/importSvg.ts; qui c'è solo
// ciò che tocca lo store e la rete: gli asset incorporati (data URI) si
// caricano PRIMA di applicare gli op, per lo stesso motivo per cui imageDrop
// carica prima di creare -- il nodo ha bisogno dell'hash, e creare-poi-correggere
// vorrebbe dire due gesti per un'azione sola.

export interface SvgImportDeps {
  upload: (docId: string, file: Blob) => Promise<AssetRef>;
  measureText?: (text: string, style: TextStyleLite) => number;
}

const defaultDeps: SvgImportDeps = {
  upload: (docId, file) => uploadAsset(docId, file),
};

// La larghezza di una riga misurata come la misura il canvas (stessa font
// string del renderer): serve ad allineare `text-anchor`. Senza contesto 2D
// (jsdom) ritorna undefined e l'importer ripiega su una stima.
function canvasTextMeasure(): ((text: string, style: TextStyleLite) => number) | undefined {
  // Senza un contesto 2D vero (jsdom non ne ha: CanvasRenderingContext2D non
  // esiste nemmeno come globale) non si tenta neanche di crearlo.
  if (typeof document === "undefined" || typeof CanvasRenderingContext2D === "undefined") return undefined;
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = document.createElement("canvas").getContext("2d");
  } catch {
    ctx = null;
  }
  if (!ctx) return undefined;
  const c = ctx;
  return (text, style) => {
    c.font = fontString(style);
    return c.measureText(text).width;
  };
}

/** Il testo è (probabilmente) un documento SVG? Radice <svg>, con o senza prologo XML. */
export function looksLikeSvg(text: string): boolean {
  const head = text.slice(0, 4096);
  if (/^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(head)) return true;
  // "contiene una radice <svg>": testo con del contorno (un commento, uno
  // snippet incollato da un sito) -- ma che chiuda davvero l'elemento.
  return /<svg[\s>][\s\S]*<\/svg\s*>/i.test(text) && !text.trimStart().startsWith("{");
}

/** Un file SVG, dal tipo dichiarato o dall'estensione (il tipo può essere vuoto). */
export function isSvgFile(file: { name?: string; type?: string }): boolean {
  return file.type === "image/svg+xml" || /\.svg$/i.test(file.name ?? "");
}

/** Il centro della parte di canvas visibile, in coordinate mondo. */
export function viewportCenter(): { x: number; y: number } {
  const cam = useScene.getState().camera;
  const el = typeof document === "undefined"
    ? null
    : (document.getElementById("overlay") ?? document.querySelector("canvas"));
  const r = el?.getBoundingClientRect();
  const w = r && r.width > 0 ? r.width : 800;
  const h = r && r.height > 0 ? r.height : 600;
  return screenToWorld(cam, w / 2, h / 2);
}

export function importedNotice(levels: number, warnings: readonly string[]): string {
  const head = `Importato come ${levels} ${levels === 1 ? "livello" : "livelli"}`;
  if (warnings.length === 0) return head;
  return `${head} · ${warnings.length === 1 ? "1 avviso" : `${warnings.length} avvisi`}: ${warnings.join("; ")}`;
}

function failNotice(message: string): void {
  useScene.setState({ notice: `Importazione SVG non riuscita: ${message}` });
}

/**
 * Importa `source` (il testo di un SVG) CENTRATO su `point` (coordinate mondo)
 * in un solo gesto, e seleziona il gruppo radice. Ritorna l'id della radice,
 * oppure null (con un `notice`) se non è stato importato niente.
 */
export async function importSvgAt(
  source: string,
  point: { x: number; y: number },
  opts: { name?: string } = {},
  deps: SvgImportDeps = defaultDeps,
): Promise<string | null> {
  const first = useScene.getState();
  const docId = first.scene?.id;
  if (!first.scene || !docId) return null;
  // Stessa guardia di incolla e rilascio immagini: a gesto aperto gli op
  // entrerebbero nella base del gesto in corso.
  if (first.gesture) return null;

  let result;
  try {
    result = importSvg(source, {
      docId,
      parentId: first.currentPageId ?? first.scene.pages[0]?.id ?? "",
      orderKey: nextOrderKey(first.scene),
      name: opts.name,
      measureText: deps.measureText ?? canvasTextMeasure(),
    });
  } catch (err) {
    failNotice(err instanceof SvgImportError ? err.message : "il file non è leggibile");
    return null;
  }
  const warnings = [...result.warnings];

  // Gli asset incorporati: ognuno si carica e il suo hash entra nel nodo. Un
  // upload fallito lascia il nodo con hash vuoto, che il renderer disegna come
  // segnaposto -- è meglio dell'intero import abortito per un'immagine.
  if (result.assets.length > 0) {
    const nodeOps = new Map(result.ops.map((op) => [op.kind.case === "createNode" ? op.kind.value.node?.id : "", op] as const));
    let failed = 0;
    await Promise.all(result.assets.map(async (a) => {
      try {
        const buf = new Uint8Array(a.bytes).buffer as ArrayBuffer;
        const ref = await deps.upload(docId, new Blob([buf], { type: a.mime }));
        const op = nodeOps.get(a.nodeId);
        const node = op?.kind.case === "createNode" ? op.kind.value.node : undefined;
        if (node && node.shape.case === "image") node.shape.value.assetHash = ref.hash;
      } catch {
        failed++;
      }
    }));
    if (failed > 0) warnings.push(`${failed} ${failed === 1 ? "immagine non caricata" : "immagini non caricate"}: segnaposto al suo posto`);
  }

  // Lo store si RILEGGE adesso: durante gli upload l'utente ha continuato a
  // lavorare (order key, gesto, pagina, documento possono essere cambiati).
  const store = useScene.getState();
  const scene = store.scene;
  if (!scene || scene.id !== docId || store.gesture) return null;
  const root = result.ops[0];
  const rootNode = root.kind.case === "createNode" ? root.kind.value.node : undefined;
  if (!rootNode) return null;
  rootNode.orderKey = nextOrderKey(scene);
  rootNode.parentId = store.currentPageId ?? scene.pages[0]?.id ?? "";
  rootNode.x = Math.round((point.x - result.size.width / 2) * 1e4) / 1e4;
  rootNode.y = Math.round((point.y - result.size.height / 2) * 1e4) / 1e4;

  store.beginGesture();
  useScene.getState().setSelection([result.rootId]);
  useScene.getState().endGesture(result.ops);
  useScene.setState({ notice: importedNotice(result.nodeCount, warnings) });
  return result.rootId;
}

/** Legge il testo di un file/blob (Blob.text() dove c'è, FileReader altrimenti). */
export function readFileText(file: Blob): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ""));
    r.onerror = () => reject(r.error ?? new Error("lettura del file fallita"));
    r.readAsText(file);
  });
}

/** Importa un file SVG (drop o picker) centrato su `point`. */
export async function importSvgFile(
  file: File,
  point: { x: number; y: number },
  deps?: SvgImportDeps,
): Promise<string | null> {
  let text: string;
  try {
    text = await readFileText(file);
  } catch {
    failNotice(`${file.name || "il file"} non è leggibile`);
    return null;
  }
  return importSvgAt(text, point, { name: (file.name ?? "").replace(/\.svg$/i, "") }, deps);
}

/**
 * Apre il selettore di file e importa l'SVG scelto al centro della vista
 * ("Importa SVG…" del menu). `picker` è iniettabile per i test: in jsdom
 * non esiste un selettore di file vero.
 */
export function pickSvgFile(
  picker: () => Promise<File | null> = defaultPicker,
  deps?: SvgImportDeps,
): Promise<string | null> {
  return picker().then((file) => (file ? importSvgFile(file, viewportCenter(), deps) : null));
}

function defaultPicker(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".svg,image/svg+xml";
    input.style.display = "none";
    const done = (f: File | null) => { input.remove(); resolve(f); };
    input.addEventListener("change", () => done(input.files?.[0] ?? null));
    // Annullare il selettore non emette `change`: `cancel` esiste nei browser
    // recenti; in quelli che non lo emettono la promessa resta in sospeso senza
    // costo (nessuna risorsa tenuta).
    input.addEventListener("cancel", () => done(null));
    document.body.appendChild(input);
    input.click();
  });
}
