import { create } from "@bufbuild/protobuf";
import { NodeSchema } from "../gen/brawt/v1/brawt_pb";
import type { Op } from "../gen/brawt/v1/brawt_pb";
import { useScene } from "../store/store";
import { nextOrderKey, orderKeyBetween } from "../store/orderKey";
import { uploadAsset, type AssetRef } from "../rpc/assets";
import { makeCreateNodeOp, uuid } from "./ops";

// TRASCINA UN'IMMAGINE SUL CANVAS (traccia 3, task 3).
//
// Il percorso completo di un rilascio, in quest'ordine:
//   1. MISURA il file in locale (l'aspetto naturale, e la prova che è
//      un'immagine decodificabile);
//   2. lo CARICA su POST /assets-api/{docId}, che risponde con lo sha256;
//   3. crea il nodo con l'HASH -- mai i byte -- in UN gesto solo.
//
// La misura viene prima dell'upload di proposito: un file che il browser non sa
// decodificare non arriva nemmeno al server, e l'aspetto serve comunque a
// dimensionare il nodo. L'upload viene prima della creazione perché il nodo ha
// bisogno dell'hash: creare prima e correggere poi vorrebbe dire due op per
// un'azione sola, e un nodo che per un istante punta al nulla.

/**
 * Il lato lungo massimo (in unità mondo) di un'immagine appena rilasciata.
 *
 * Una foto da 4000 px atterrerebbe altrimenti grande venti schermate: si vede
 * un angolo grigio e sembra che sia successo altro. Il rimpicciolimento è
 * PROPORZIONALE, quindi non deforma mai; l'utente può poi ingrandire.
 */
export const MAX_DROP_SIZE = 512;

/** Lo scostamento fra più immagini rilasciate insieme. */
export const STACK_OFFSET = 16;

const NOT_AN_IMAGE =
  "questo file non è un'immagine che il browser sappia leggere: usa PNG, JPEG, GIF o WebP";

/** Le dimensioni naturali di un file immagine, in pixel. */
export interface NaturalSize {
  width: number;
  height: number;
}

// Le due dipendenze di contorno (un decoder di immagini e la rete): nessuna
// delle due esiste fuori da un browser, ed è ciò che rende questo percorso
// verificabile senza uno.
export interface ImageDropDeps {
  measure: (file: Blob) => Promise<NaturalSize>;
  upload: (docId: string, file: Blob) => Promise<AssetRef>;
}

/**
 * Le dimensioni naturali di un file, misurate dal browser.
 *
 * Passa da un `<img>` e da un object URL invece che da `createImageBitmap`
 * perché la domanda è "quanto è grande", non "dammi i pixel decodificati": un
 * ImageBitmap sarebbe una copia decodificata da chiudere subito dopo. L'URL si
 * revoca in ogni caso, riuscita o no -- altrimenti ogni file rilasciato
 * lascerebbe un blob vivo per tutta la sessione.
 */
export function measureImage(file: Blob): Promise<NaturalSize> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    const done = (fn: () => void) => {
      URL.revokeObjectURL(url);
      fn();
    };
    img.onload = () =>
      done(() =>
        img.naturalWidth > 0 && img.naturalHeight > 0
          ? resolve({ width: img.naturalWidth, height: img.naturalHeight })
          : reject(new Error("immagine di dimensione nulla")),
      );
    img.onerror = () => done(() => reject(new Error("immagine non decodificabile")));
    img.src = url;
  });
}

const defaultDeps: ImageDropDeps = {
  measure: measureImage,
  upload: (docId, file) => uploadAsset(docId, file),
};

/**
 * Il box del nodo per un'immagine di dimensioni naturali `size` rilasciata in
 * `point`: aspetto naturale, lato lungo al più MAX_DROP_SIZE, CENTRATO sul
 * punto.
 *
 * Centrato e non con l'angolo sul cursore: un rilascio non ha un rettangolo
 * trascinato a cui ancorare un angolo, e l'utente sta indicando DOVE deve
 * stare l'immagine. Con l'angolo in alto a sinistra sul puntatore, una foto
 * grande finirebbe quasi tutta in basso a destra rispetto a dove è stata
 * lasciata.
 */
export function dropBox(size: NaturalSize, point: { x: number; y: number }) {
  const longest = Math.max(size.width, size.height);
  const scale = longest > MAX_DROP_SIZE ? MAX_DROP_SIZE / longest : 1;
  const width = size.width * scale;
  const height = size.height * scale;
  return { x: point.x - width / 2, y: point.y - height / 2, width, height };
}

/** I file di un trascinamento. Vuoto quando non ce ne sono (testo, link, …). */
export function imageFilesOf(dt: DataTransfer | null): File[] {
  return dt?.files ? Array.from(dt.files) : [];
}

/** Un trascinamento porta dei file? È la domanda del dragover, dove i `files`
 *  non sono ancora leggibili e c'è solo l'elenco dei tipi. */
export function carriesFiles(dt: DataTransfer | null): boolean {
  const types = dt?.types;
  return types ? Array.from(types).includes("Files") : false;
}

/**
 * Rilascia dei file sul canvas: carica le immagini e crea i nodi.
 *
 * Ritorna gli id creati (vuoto se non è atterrato niente). Ogni fallimento --
 * un file che non è un'immagine, un upload rifiutato -- finisce in `notice` e
 * non in `lastError`: nessuna modifica è stata annullata, non è stata nemmeno
 * tentata. È lo stesso canale dell'export e dell'incolla non supportato.
 */
export async function dropImages(
  files: readonly File[],
  point: { x: number; y: number },
  deps: ImageDropDeps = defaultDeps,
): Promise<string[]> {
  const docId = useScene.getState().scene?.id;
  if (!docId || files.length === 0) return [];
  // Stessa guardia di incolla e undo/redo (store.ts): a gesto aperto gli op
  // entrerebbero nella BASE del gesto in corso, e il pointerup successivo
  // ricostruirebbe la scena su uno stato che non è quello di partenza.
  if (useScene.getState().gesture) return [];

  // Misura e upload in PARALLELO fra i file (sono indipendenti e ognuno è un
  // giro di rete), ma il risultato resta indicizzato: l'ordine dei nodi creati
  // è quello dei file rilasciati, non quello in cui il server ha risposto.
  const results = await Promise.all(
    files.map(async (file): Promise<{ ref: AssetRef; size: NaturalSize } | string> => {
      // Il tipo dichiarato dal sistema operativo è un filtro A BUON MERCATO,
      // non l'autorità: serve a non decodificare (e non caricare) il video da
      // due gigabyte che qualcuno ha trascinato per sbaglio. Un tipo VUOTO --
      // estensione ignota -- non dice niente e passa alla misura, che è chi
      // decide davvero.
      if (file.type !== "" && !file.type.startsWith("image/")) {
        return `${file.name || "il file"}: ${NOT_AN_IMAGE}`;
      }
      let size: NaturalSize;
      try {
        size = await deps.measure(file);
      } catch {
        // Il tipo dichiarato dal sistema operativo non decide niente (può essere
        // ""): è la misura a dire se il browser sa leggere questo file -- e se
        // non lo sa leggere lui, non potrà nemmeno disegnarlo.
        return `${file.name || "il file"}: ${NOT_AN_IMAGE}`;
      }
      try {
        return { ref: await deps.upload(docId, file), size };
      } catch (err) {
        return `${file.name || "il file"}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }),
  );

  const failures = results.filter((r): r is string => typeof r === "string");
  const ok = results.filter((r): r is { ref: AssetRef; size: NaturalSize } => typeof r !== "string");

  // Lo store si rilegge ADESSO: fra l'inizio e la fine degli upload l'utente ha
  // continuato a lavorare, e la scena (le order key, un gesto appena aperto,
  // perfino il documento) può essere cambiata.
  const store = useScene.getState();
  const scene = store.scene;
  if (!scene || scene.id !== docId || store.gesture || ok.length === 0) {
    if (failures.length > 0) useScene.setState({ notice: failures.join(" · ") });
    return [];
  }

  let key = nextOrderKey(scene);
  const ops: Op[] = [];
  const ids: string[] = [];
  ok.forEach(({ ref, size }, i) => {
    const id = uuid();
    const box = dropBox(size, { x: point.x + i * STACK_OFFSET, y: point.y + i * STACK_OFFSET });
    ops.push(
      makeCreateNodeOp(
        create(NodeSchema, {
          id,
          parentId: scene.pages[0]?.id ?? "",
          orderKey: key,
          // Il nome del file come nome del livello: è così che l'utente
          // riconosce l'immagine nel pannello, e non costa niente.
          name: files[i]?.name ?? "Image",
          visible: true,
          opacity: 1,
          ...box,
          // L'HASH, non i byte: è l'invariante dell'intero percorso.
          shape: { case: "image", value: { assetHash: ref.hash } },
        }),
      ),
    );
    ids.push(id);
    key = orderKeyBetween(key, null);
  });

  // UN gesto per rilascio, non uno per file: un Ctrl+Z toglie quello che
  // l'utente ha lasciato cadere, tutto insieme.
  store.beginGesture();
  useScene.getState().setSelection(ids);
  useScene.getState().endGesture(ops);
  if (failures.length > 0) useScene.setState({ notice: failures.join(" · ") });
  return ids;
}

// Il minimo che serve per agganciarsi: i test passano un doppio invece di un
// vero elemento (stesso motivo di ShortcutTarget in tools/clipboard.ts).
interface DropTarget {
  addEventListener(type: "dragover" | "drop", handler: (e: Event) => void): void;
  removeEventListener(type: "dragover" | "drop", handler: (e: Event) => void): void;
}

/**
 * Collega il rilascio di immagini a un elemento (il canvas della scena).
 * Ritorna la funzione di distacco.
 *
 * I due `preventDefault` non sono formalità:
 *  - su `dragover` è ciò che dichiara l'elemento come bersaglio valido; senza,
 *    l'evento `drop` non arriva MAI;
 *  - su `drop` è ciò che impedisce al browser di NAVIGARE verso il file
 *    rilasciato, cioè di buttare via il documento aperto.
 * Entrambi solo quando il trascinamento porta davvero dei file: un trascinamento
 * di altro genere (il riordino dei livelli, del testo selezionato) deve
 * continuare a comportarsi come si comporterebbe senza di noi.
 */
export function attachImageDrop(
  target: DropTarget,
  toWorld: (e: Event) => { x: number; y: number },
  deps: ImageDropDeps = defaultDeps,
): () => void {
  const onDragOver = (e: Event) => {
    if (!carriesFiles((e as DragEvent).dataTransfer)) return;
    e.preventDefault();
  };
  const onDrop = (e: Event) => {
    const files = imageFilesOf((e as DragEvent).dataTransfer);
    if (files.length === 0) return;
    e.preventDefault();
    // Il punto si legge SUBITO, in modo sincrono: dopo il primo await l'evento
    // non è più affidabile (il browser lo ricicla) e il puntatore è altrove.
    const point = toWorld(e);
    void dropImages(files, point, deps);
  };
  target.addEventListener("dragover", onDragOver);
  target.addEventListener("drop", onDrop);
  return () => {
    target.removeEventListener("dragover", onDragOver);
    target.removeEventListener("drop", onDrop);
  };
}
