import { assetUrl } from "../rpc/assets";

// LA CACHE DELLE IMMAGINI DECODIFICATE.
//
// Esiste per una ragione sola, ed è il render loop: `drawScene` gira a 60 fps e
// chiede l'immagine di ogni nodo a OGNI frame. Decodificare lì dentro (un
// `new Image()`, o peggio un fetch) vorrebbe dire sessanta decodifiche al
// secondo per immagine -- il modo più diretto di far scendere il canvas a
// scatti. Qui una richiesta parte una volta sola per (documento, hash) e ogni
// frame successivo legge una voce già pronta, sincrona.
//
// Il ridisegno non ha bisogno di essere notificato: App.tsx ridisegna comunque a
// ogni frame, quindi l'immagine compare da sé appena la voce passa a "ready".
// `onChange` esiste per chi non gira in un loop (i test, e un eventuale renderer
// a invalidazione).

/**
 * Lo stato di un asset per chi disegna.
 *  - "loading": la richiesta è partita, non c'è ancora niente da disegnare;
 *  - "ready":   `image` è decodificata e ha dimensioni > 0;
 *  - "missing": non c'è (404, byte illeggibili, hash vuoto). NON si riprova.
 */
export type ImageStatus = "loading" | "ready" | "missing";

export interface CachedImage {
  status: ImageStatus;
  image: HTMLImageElement | null;
}

const LOADING: CachedImage = { status: "loading", image: null };
const MISSING: CachedImage = { status: "missing", image: null };

/** Come si comincia a caricare un URL. Iniettabile: `Image` non c'è ovunque. */
export type LoadImage = (url: string) => HTMLImageElement;

function domLoader(url: string): HTMLImageElement {
  const img = new Image();
  // Gli asset arrivano dallo STESSO origin dell'editor, quindi non serve
  // crossOrigin; dichiararlo forzerebbe una preflight su una route che non ne
  // ha bisogno.
  img.src = url;
  return img;
}

export class ImageCache {
  private entries = new Map<string, CachedImage>();

  constructor(
    private readonly load: LoadImage = domLoader,
    private readonly onChange: () => void = () => {},
  ) {}

  /**
   * L'immagine di un asset, SUBITO e senza mai lanciare: è pensata per essere
   * chiamata dentro il render loop. La prima chiamata avvia il caricamento e
   * ritorna "loading"; le successive leggono e basta.
   */
  get(docId: string, hash: string): CachedImage {
    // Un hash vuoto non identifica niente: chiedere /assets-api/doc/ a ogni
    // frame sarebbe una richiesta al secondo per nodo, tutte 404.
    if (hash === "") return MISSING;
    const key = `${docId}/${hash}`;
    const found = this.entries.get(key);
    if (found) return found;

    this.entries.set(key, LOADING);
    let img: HTMLImageElement;
    try {
      img = this.load(assetUrl(docId, hash));
    } catch {
      // Nessun modo di caricare immagini in questo ambiente: segnaposto per
      // sempre, e soprattutto nessuna eccezione dentro il loop di disegno.
      this.entries.set(key, MISSING);
      return MISSING;
    }
    img.onload = () => {
      // Un `load` su byte non decodificabili esiste (alcuni browser lo
      // emettono lo stesso): un elemento di dimensione zero non produce pixel,
      // quindi vale come mancante -- meglio il segnaposto del nulla.
      const ok = img.naturalWidth > 0 && img.naturalHeight > 0;
      this.entries.set(key, ok ? { status: "ready", image: img } : MISSING);
      this.onChange();
    };
    img.onerror = () => {
      this.entries.set(key, MISSING);
      this.onChange();
    };
    return LOADING;
  }

  /**
   * Dimentica tutto. La chiama chi cambia documento: le voci sono indicizzate
   * per documento e resterebbero corrette, ma tenere in memoria le immagini di
   * un documento chiuso non serve a nessuno.
   */
  clear(): void {
    this.entries.clear();
  }
}

// La cache che usa il renderer. Una sola per pagina: costruirne una per frame
// (o per componente) annullerebbe esattamente ciò per cui esiste.
export const imageCache = new ImageCache();
