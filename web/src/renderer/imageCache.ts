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
//
// UN FALLIMENTO NON È DEFINITIVO. "Non si riprova a ogni frame" è la regola
// giusta per un loop a 60 fps, ma "non si riprova MAI" è un'altra cosa: un
// server riavviato, un 5xx, una richiesta in volo quando la scheda è finita in
// secondo piano inchioderebbero quel (documento, hash) al segnaposto per tutta
// la vita della pagina, con il file ancora lì sul disco. Quindi un "missing"
// TRANSITORIO porta con sé il momento in cui si potrà riprovare, con un'attesa
// che raddoppia a ogni fallimento fino a un tetto: il costo massimo è una
// richiesta ogni RETRY_MAX_MS per immagine rotta, non una per frame.

/**
 * Lo stato di un asset per chi disegna.
 *  - "loading": la richiesta è partita, non c'è ancora niente da disegnare;
 *  - "ready":   `image` è decodificata e ha dimensioni > 0;
 *  - "missing": non c'è (404, byte illeggibili, hash vuoto).
 *
 * "missing" non è per forza definitivo: vedi `retryAt` sulla voce interna e
 * `retryMissing()`.
 */
export type ImageStatus = "loading" | "ready" | "missing";

export interface CachedImage {
  status: ImageStatus;
  image: HTMLImageElement | null;
}

// La voce come la tiene la cache. `retryAt` e `failures` non servono a chi
// disegna (che legge `status` e basta) ma sono ciò che distingue un fallimento
// da cui si può tornare da uno da cui non si torna.
interface Entry extends CachedImage {
  /**
   * Quando questa voce "missing" torna a essere richiedibile.
   * `undefined` = MAI: riprovare non potrebbe cambiare la risposta (hash vuoto,
   * nessun caricatore in questo ambiente).
   */
  retryAt?: number;
  /** Fallimenti consecutivi, cioè quanto si aspetta prima del prossimo. */
  failures: number;
}

// Un hash vuoto e un ambiente senza `Image` sono gli unici due "missing" da cui
// non si torna: nel primo caso non c'è niente da chiedere, nel secondo non c'è
// nessuno a cui chiederlo.
const MISSING_FOREVER: Entry = { status: "missing", image: null, failures: 0 };

/** La prima attesa dopo un fallimento, e il tetto a cui il raddoppio si ferma. */
export const RETRY_BASE_MS = 2_000;
export const RETRY_MAX_MS = 30_000;

/**
 * Quanto si aspetta dopo `failures` fallimenti consecutivi: 2s, 4s, 8s, 16s,
 * poi 30s per sempre.
 *
 * Il raddoppio serve a distinguere i due casi senza doverli riconoscere: un
 * disservizio di un istante si recupera nel giro di due secondi, un asset che
 * davvero non c'è finisce a costare una richiesta ogni mezzo minuto -- e resta
 * comunque recuperabile, perché il tetto non diventa mai "smetti".
 */
export function retryDelay(failures: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, failures - 1));
}

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
  private entries = new Map<string, Entry>();

  constructor(
    private readonly load: LoadImage = domLoader,
    private readonly onChange: () => void = () => {},
    // L'orologio è iniettabile perché la scadenza di un tentativo è un
    // comportamento, e un comportamento che dipende dal tempo si verifica solo
    // se il tempo lo decide il test.
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * L'immagine di un asset, SUBITO e senza mai lanciare: è pensata per essere
   * chiamata dentro il render loop. La prima chiamata avvia il caricamento e
   * ritorna "loading"; le successive leggono e basta -- tranne quando la voce è
   * un "missing" transitorio la cui attesa è scaduta, che riparte da sola.
   */
  get(docId: string, hash: string): CachedImage {
    // Un hash vuoto non identifica niente: chiedere /assets-api/doc/ a ogni
    // frame sarebbe una richiesta al secondo per nodo, tutte 404.
    if (hash === "") return MISSING_FOREVER;
    const key = `${docId}/${hash}`;
    const found = this.entries.get(key);
    if (found && !this.expired(found)) return found;
    return this.start(key, assetUrl(docId, hash), found?.failures ?? 0);
  }

  /**
   * Dimentica i fallimenti TRANSITORI, senza aspettarne la scadenza: la
   * prossima `get` riparte subito e da capo (l'attesa torna alla base).
   *
   * La chiama chi ha una ragione per credere che il mondo sia cambiato -- la
   * rete tornata, la scheda tornata in primo piano (vedi
   * `attachImageRecovery`). Le voci pronte restano: il nome È il contenuto,
   * quindi i byte a quell'URL non possono essere cambiati e ricaricarli
   * sarebbe solo un lampeggio di segnaposto.
   *
   * Ritorna quante voci ha dimenticato, che è ciò che rende osservabile "non
   * c'era niente da riprovare".
   */
  retryMissing(): number {
    let forgotten = 0;
    for (const [key, entry] of this.entries) {
      if (entry.status === "missing" && entry.retryAt !== undefined) {
        this.entries.delete(key);
        forgotten++;
      }
    }
    if (forgotten > 0) this.onChange();
    return forgotten;
  }

  private expired(entry: Entry): boolean {
    return entry.status === "missing" && entry.retryAt !== undefined && this.now() >= entry.retryAt;
  }

  private start(key: string, url: string, failures: number): Entry {
    const loading: Entry = { status: "loading", image: null, failures };
    this.entries.set(key, loading);
    let img: HTMLImageElement;
    try {
      img = this.load(url);
    } catch {
      // Nessun modo di caricare immagini in questo ambiente: riprovare non
      // cambierebbe la risposta, quindi la voce è definitiva. E soprattutto
      // nessuna eccezione dentro il loop di disegno.
      const dead: Entry = { status: "missing", image: null, failures: failures + 1 };
      this.entries.set(key, dead);
      return dead;
    }
    img.onload = () => {
      // Un `load` su byte non decodificabili esiste (alcuni browser lo
      // emettono lo stesso): un elemento di dimensione zero non produce pixel,
      // quindi vale come mancante -- meglio il segnaposto del nulla. È
      // transitorio come un errore di rete: una risposta troncata a metà arriva
      // esattamente così.
      const ok = img.naturalWidth > 0 && img.naturalHeight > 0;
      this.settle(key, loading, ok ? { status: "ready", image: img, failures: 0 } : this.retryable(failures));
    };
    img.onerror = () => this.settle(key, loading, this.retryable(failures));
    return loading;
  }

  private retryable(failures: number): Entry {
    const next = failures + 1;
    return {
      status: "missing",
      image: null,
      failures: next,
      retryAt: this.now() + retryDelay(next),
    };
  }

  // La voce si aggiorna solo se è ANCORA quella che aveva avviato questo
  // caricamento: fra la partenza e la risposta possono essere passati un
  // `retryMissing()` e un secondo tentativo, e la risposta vecchia (un errore
  // su una richiesta ormai abbandonata) non deve cancellare il nuovo.
  private settle(key: string, started: Entry, next: Entry): void {
    if (this.entries.get(key) !== started) return;
    this.entries.set(key, next);
    this.onChange();
  }
}

// Il minimo che serve per agganciare e sganciare un ascoltatore. Dichiarato
// così invece che `Window`/`Document` perché è tutto ciò che questa funzione
// usa, ed è ciò che le permette di essere verificata senza né l'uno né l'altro.
interface Listenable {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}
interface VisibilitySource extends Listenable {
  readonly visibilityState: string;
}

/**
 * Aggancia i due segnali che rendono sensato riprovare SUBITO, invece di
 * aspettare la scadenza del tentativo:
 *
 *  - `online`: la rete è tornata, quindi ogni fallimento accumulato mentre non
 *    c'era è per definizione da rifare;
 *  - la scheda che torna in primo piano: un browser sospende (e a volte
 *    interrompe) le richieste di una scheda in secondo piano, e quelle
 *    interruzioni arrivano qui come `error`.
 *
 * Ritorna la funzione che sgancia, perché è montata da un `useEffect`.
 */
export function attachImageRecovery(
  cache: ImageCache = imageCache,
  win: Listenable = window,
  doc: VisibilitySource = document,
): () => void {
  const onOnline = () => {
    cache.retryMissing();
  };
  const onVisible = () => {
    if (doc.visibilityState === "visible") cache.retryMissing();
  };
  win.addEventListener("online", onOnline);
  doc.addEventListener("visibilitychange", onVisible);
  return () => {
    win.removeEventListener("online", onOnline);
    doc.removeEventListener("visibilitychange", onVisible);
  };
}

// La cache che usa il renderer. Una sola per pagina: costruirne una per frame
// (o per componente) annullerebbe esattamente ciò per cui esiste.
//
// Non la usa l'EXPORT: un file esportato non deve dipendere da quali immagini
// questa sessione ha già visto passare (vedi export/exportScene.ts, che i byte
// se li risolve da sé e li ASPETTA).
export const imageCache = new ImageCache();
