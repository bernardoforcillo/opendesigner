import { describe, it, expect, vi } from "vitest";
import {
  ImageCache,
  imageCache,
  attachImageRecovery,
  retryDelay,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
} from "./imageCache";

const HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

// Un finto elemento immagine: `new Image()` esiste in jsdom ma non carica
// niente e non emette mai load/error, quindi il caricamento è iniettabile e le
// prove qui sotto decidono loro quando (e come) finisce.
interface FakeImage {
  src: string;
  naturalWidth: number;
  naturalHeight: number;
  onload: (() => void) | null;
  onerror: (() => void) | null;
}

function fakeLoader() {
  const created: FakeImage[] = [];
  const load = (url: string) => {
    const img: FakeImage = { src: url, naturalWidth: 0, naturalHeight: 0, onload: null, onerror: null };
    created.push(img);
    return img as unknown as HTMLImageElement;
  };
  return { load, created };
}

function settle(img: FakeImage, ok: boolean) {
  if (ok) {
    img.naturalWidth = 40;
    img.naturalHeight = 20;
    img.onload?.();
  } else {
    img.onerror?.();
  }
}

describe("ImageCache", () => {
  it("decodifica UNA volta sola: il render loop chiede a ogni frame, il caricamento parte una volta", () => {
    const l = fakeLoader();
    const cache = new ImageCache(l.load);

    // 60 frame di render loop sullo stesso nodo.
    for (let i = 0; i < 60; i++) cache.get("doc1", HASH);
    expect(l.created.length).toBe(1);

    settle(l.created[0], true);
    for (let i = 0; i < 60; i++) expect(cache.get("doc1", HASH).status).toBe("ready");
    // Nemmeno DOPO il caricamento si ricarica: è il punto della cache.
    expect(l.created.length).toBe(1);
  });

  it("parte da 'loading' e passa a 'ready' con l'immagine decodificata", () => {
    const l = fakeLoader();
    const cache = new ImageCache(l.load);

    const first = cache.get("doc1", HASH);
    expect(first.status).toBe("loading");
    expect(first.image).toBeNull();

    settle(l.created[0], true);
    const after = cache.get("doc1", HASH);
    expect(after.status).toBe("ready");
    expect(after.image?.naturalWidth).toBe(40);
  });

  it("un asset che non si carica diventa 'missing', e il render loop non lo richiede più", () => {
    const l = fakeLoader();
    const cache = new ImageCache(l.load, () => {}, () => 0);

    cache.get("doc1", HASH);
    settle(l.created[0], false);

    // Il render loop continua a chiedere: senza questo la cache riproverebbe il
    // fetch 60 volte al secondo su un'immagine che non c'è. L'orologio è fermo,
    // quindi qui dentro non scade nessun tentativo: 60 frame = un frame.
    for (let i = 0; i < 60; i++) expect(cache.get("doc1", HASH).status).toBe("missing");
    expect(l.created.length).toBe(1);
  });

  it("un caricamento riuscito ma con dimensioni nulle è 'missing', non 'ready'", () => {
    // Alcuni browser emettono `load` su una risposta che non è decodificabile.
    // Disegnare quell'elemento non produce pixel: chiamarlo pronto vorrebbe dire
    // mostrare il vuoto invece del segnaposto.
    const l = fakeLoader();
    const cache = new ImageCache(l.load);
    cache.get("doc1", HASH);
    l.created[0].onload?.();
    expect(cache.get("doc1", HASH).status).toBe("missing");
  });

  it("chiede l'URL del documento e dell'hash", () => {
    const l = fakeLoader();
    const cache = new ImageCache(l.load);
    cache.get("doc-42", HASH);
    expect(l.created[0].src).toBe(`/assets-api/doc-42/${HASH}`);
  });

  it("tiene separati due hash e due documenti", () => {
    const l = fakeLoader();
    const cache = new ImageCache(l.load);
    cache.get("doc1", HASH);
    cache.get("doc1", OTHER);
    // Lo stesso hash in un ALTRO documento è un altro file su disco: la chiave
    // deve contenere entrambi, o aprire un secondo documento mostrerebbe le
    // immagini del primo.
    cache.get("doc2", HASH);
    expect(l.created.map((i) => i.src)).toEqual([
      `/assets-api/doc1/${HASH}`,
      `/assets-api/doc1/${OTHER}`,
      `/assets-api/doc2/${HASH}`,
    ]);
  });

  it("un hash vuoto è 'missing' e non tocca la rete", () => {
    // Un ImageNode il cui hash si è perso (payload della clipboard troncato,
    // upload mai riuscito): non c'è niente da chiedere, e chiederlo sarebbe una
    // GET su /assets-api/doc/ a ogni frame.
    const l = fakeLoader();
    const cache = new ImageCache(l.load);
    expect(cache.get("doc1", "").status).toBe("missing");
    expect(l.created.length).toBe(0);
  });

  it("non lancia quando il caricatore stesso fallisce", () => {
    // `new Image()` non esiste in ogni ambiente (un test in Node, un worker):
    // il render loop non deve morire per questo, deve disegnare il segnaposto.
    const cache = new ImageCache(() => {
      throw new Error("no Image in this environment");
    });
    expect(cache.get("doc1", HASH).status).toBe("missing");
  });

  it("il singleton esiste ed è una cache", () => {
    // È quello che usa il renderer: un secondo `new ImageCache()` per frame
    // vanificherebbe la cache.
    expect(imageCache).toBeInstanceOf(ImageCache);
    expect(imageCache.get("doc1", "").status).toBe("missing");
  });

  it("ridisegna solo quando serve: la notifica di cambio scatta a fine caricamento", () => {
    // Il render loop di App.tsx gira comunque a ogni frame, ma un consumatore
    // fuori dal loop (un test, un futuro renderer a invalidazione) deve poter
    // sapere che l'immagine è arrivata.
    const l = fakeLoader();
    const onChange = vi.fn();
    const cache = new ImageCache(l.load, onChange);
    cache.get("doc1", HASH);
    expect(onChange).not.toHaveBeenCalled();
    settle(l.created[0], true);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

// --- si torna indietro da un fallimento ---------------------------------------
//
// "Non si riprova a ogni frame" è la regola giusta per un loop a 60 fps, ma
// "non si riprova mai" è un'altra cosa: un server riavviato, un 5xx, una
// richiesta in volo quando la scheda finisce in secondo piano inchioderebbero
// quel nodo al segnaposto per tutta la vita della pagina -- con il file ancora
// lì sul disco, e (finché l'export leggeva questa cache) anche dentro i file
// esportati.

function clocked() {
  const l = fakeLoader();
  let now = 1_000;
  const onChange = vi.fn();
  const cache = new ImageCache(l.load, onChange, () => now);
  return { ...l, cache, onChange, tick: (ms: number) => { now += ms; } };
}

describe("ImageCache — recupero da un fallimento transitorio", () => {
  it("dopo l'attesa riprova, e l'immagine tornata raggiungibile si ripara", () => {
    const c = clocked();
    c.cache.get("doc1", HASH);
    settle(c.created[0], false);
    expect(c.cache.get("doc1", HASH).status).toBe("missing");

    // Un istante prima della scadenza non si muove niente.
    c.tick(RETRY_BASE_MS - 1);
    expect(c.cache.get("doc1", HASH).status).toBe("missing");
    expect(c.created.length).toBe(1);

    // Scaduta l'attesa, la richiesta riparte da sé: nessuno deve ricaricare la
    // pagina per rivedere un'immagine che il server ha ricominciato a servire.
    c.tick(1);
    expect(c.cache.get("doc1", HASH).status).toBe("loading");
    expect(c.created.length).toBe(2);
    settle(c.created[1], true);
    expect(c.cache.get("doc1", HASH).status).toBe("ready");
  });

  it("nemmeno dopo la scadenza il loop parte due volte: una richiesta, non sessanta", () => {
    const c = clocked();
    c.cache.get("doc1", HASH);
    settle(c.created[0], false);
    c.tick(RETRY_BASE_MS);
    // 60 frame dopo la scadenza: il primo riparte, gli altri 59 leggono la voce
    // "loading" che ha creato lui.
    for (let i = 0; i < 60; i++) c.cache.get("doc1", HASH);
    expect(c.created.length).toBe(2);
  });

  it("l'attesa raddoppia a ogni fallimento, fino a un tetto", () => {
    // Il raddoppio distingue i due casi senza doverli riconoscere: un
    // disservizio di un istante si recupera in due secondi, un asset che
    // davvero non c'è finisce a costare una richiesta ogni mezzo minuto.
    expect(retryDelay(1)).toBe(RETRY_BASE_MS);
    expect(retryDelay(2)).toBe(RETRY_BASE_MS * 2);
    expect(retryDelay(3)).toBe(RETRY_BASE_MS * 4);
    expect(retryDelay(50)).toBe(RETRY_MAX_MS);
    // ...e il tetto non diventa mai "smetti": un asset resta recuperabile.
    expect(retryDelay(1_000)).toBe(RETRY_MAX_MS);

    const c = clocked();
    c.cache.get("doc1", HASH);
    settle(c.created[0], false);
    c.tick(RETRY_BASE_MS);
    c.cache.get("doc1", HASH);
    settle(c.created[1], false);

    // Secondo fallimento: la prima attesa non basta più.
    c.tick(RETRY_BASE_MS);
    expect(c.cache.get("doc1", HASH).status).toBe("missing");
    expect(c.created.length).toBe(2);
    c.tick(RETRY_BASE_MS);
    expect(c.cache.get("doc1", HASH).status).toBe("loading");
    expect(c.created.length).toBe(3);
  });

  it("retryMissing() riporta l'attesa alla base: il mondo è cambiato, non è un terzo tentativo", () => {
    const c = clocked();
    c.cache.get("doc1", HASH);
    settle(c.created[0], false);
    c.tick(RETRY_BASE_MS);
    c.cache.get("doc1", HASH);
    settle(c.created[1], false); // due fallimenti: l'attesa sarebbe 4 * BASE

    c.cache.retryMissing();
    c.cache.get("doc1", HASH);
    settle(c.created[2], false);

    // Riparte dalla base e non da dove era arrivata: dopo un segnale esplicito
    // ("la rete è tornata") l'attesa accumulata parlava di un mondo che non c'è
    // più.
    c.tick(RETRY_BASE_MS);
    expect(c.cache.get("doc1", HASH).status).toBe("loading");
    expect(c.created.length).toBe(4);
  });

  it("retryMissing() riprova SUBITO, senza aspettare la scadenza", () => {
    const c = clocked();
    c.cache.get("doc1", HASH);
    settle(c.created[0], false);

    expect(c.cache.retryMissing()).toBe(1);
    expect(c.cache.get("doc1", HASH).status).toBe("loading");
    expect(c.created.length).toBe(2);
    settle(c.created[1], true);
    expect(c.cache.get("doc1", HASH).status).toBe("ready");
  });

  it("retryMissing() NON ributta via le immagini già pronte", () => {
    // Il nome È il contenuto: i byte a quell'URL non possono essere cambiati, e
    // ricaricarli sarebbe solo un lampeggio di segnaposto su ogni foto della
    // pagina a ogni riconnessione.
    const c = clocked();
    c.cache.get("doc1", HASH);
    settle(c.created[0], true);
    c.cache.get("doc1", OTHER);
    settle(c.created[1], false);

    expect(c.cache.retryMissing()).toBe(1);
    // L'immagine pronta si legge senza nessuna richiesta nuova...
    expect(c.cache.get("doc1", HASH).status).toBe("ready");
    expect(c.created.length).toBe(2);
    // ...e solo quella mancante riparte.
    expect(c.cache.get("doc1", OTHER).status).toBe("loading");
    expect(c.created.length).toBe(3);
  });

  it("un fallimento DEFINITIVO non si riprova: né a scadenza né a comando", () => {
    // Un ambiente senza `new Image()` non ne guadagna uno aspettando, e un hash
    // vuoto non ha niente da chiedere: riprovare sarebbe solo rumore.
    let calls = 0;
    let now = 0;
    const cache = new ImageCache(
      () => { calls++; throw new Error("no Image in this environment"); },
      () => {},
      () => now,
    );
    expect(cache.get("doc1", HASH).status).toBe("missing");
    now += RETRY_MAX_MS * 10;
    expect(cache.get("doc1", HASH).status).toBe("missing");
    expect(cache.retryMissing()).toBe(0);
    expect(cache.get("doc1", HASH).status).toBe("missing");
    expect(calls).toBe(1);

    expect(cache.get("doc1", "").status).toBe("missing");
    expect(calls).toBe(1);
  });

  it("la risposta di una richiesta abbandonata non cancella il tentativo nuovo", () => {
    // Fra la partenza e la risposta può essersi infilato un retryMissing() e un
    // secondo tentativo: l'errore che arriva tardi dal primo non deve
    // riportare a "missing" un'immagine che nel frattempo sta arrivando.
    const c = clocked();
    c.cache.get("doc1", HASH);
    settle(c.created[0], false);
    c.cache.retryMissing();
    c.cache.get("doc1", HASH); // secondo tentativo, in volo

    settle(c.created[0], false); // la risposta VECCHIA arriva adesso
    expect(c.cache.get("doc1", HASH).status).toBe("loading");
    settle(c.created[1], true);
    expect(c.cache.get("doc1", HASH).status).toBe("ready");
  });

  it("un caricamento a dimensioni nulle è recuperabile: una risposta troncata arriva così", () => {
    const c = clocked();
    c.cache.get("doc1", HASH);
    c.created[0].onload?.(); // load, ma 0x0
    expect(c.cache.get("doc1", HASH).status).toBe("missing");
    c.tick(RETRY_BASE_MS);
    expect(c.cache.get("doc1", HASH).status).toBe("loading");
    expect(c.created.length).toBe(2);
  });

  it("riprovare notifica il ridisegno, e non riprovare niente non lo notifica", () => {
    const c = clocked();
    c.cache.get("doc1", HASH);
    settle(c.created[0], false);
    c.onChange.mockClear();

    c.cache.retryMissing();
    expect(c.onChange).toHaveBeenCalledTimes(1);
    c.onChange.mockClear();
    c.cache.retryMissing();
    expect(c.onChange).not.toHaveBeenCalled();
  });
});

describe("attachImageRecovery", () => {
  function fakeTarget() {
    const listeners = new Map<string, () => void>();
    return {
      listeners,
      addEventListener: (type: string, fn: () => void) => { listeners.set(type, fn); },
      removeEventListener: (type: string, fn: () => void) => {
        if (listeners.get(type) === fn) listeners.delete(type);
      },
    };
  }

  it("la rete tornata e la scheda tornata in primo piano riprovano; nascosta no", () => {
    const c = clocked();
    c.cache.get("doc1", HASH);
    settle(c.created[0], false);

    const win = fakeTarget();
    const doc = { ...fakeTarget(), visibilityState: "hidden" };
    const detach = attachImageRecovery(c.cache, win, doc);

    // Nascosta: il browser non disegna niente, riprovare adesso vorrebbe dire
    // spendere una richiesta per un frame che nessuno vedrà.
    doc.listeners.get("visibilitychange")?.();
    expect(c.created.length).toBe(1);

    doc.visibilityState = "visible";
    doc.listeners.get("visibilitychange")?.();
    expect(c.cache.get("doc1", HASH).status).toBe("loading");
    expect(c.created.length).toBe(2);

    settle(c.created[1], false);
    win.listeners.get("online")?.();
    expect(c.cache.get("doc1", HASH).status).toBe("loading");
    expect(c.created.length).toBe(3);

    detach();
    expect(win.listeners.size).toBe(0);
    expect(doc.listeners.size).toBe(0);
  });

  it("aggancia sulla cache condivisa e sulla finestra vera, senza argomenti", () => {
    // È così che la chiama App.tsx: un solo `useEffect`, nessun parametro.
    const detach = attachImageRecovery();
    expect(() => window.dispatchEvent(new Event("online"))).not.toThrow();
    detach();
  });
});
