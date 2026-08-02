import { describe, it, expect, vi } from "vitest";
import { ImageCache, imageCache } from "./imageCache";

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

  it("un asset che non si carica diventa 'missing', e non lo si richiede più", () => {
    const l = fakeLoader();
    const cache = new ImageCache(l.load);

    cache.get("doc1", HASH);
    settle(l.created[0], false);

    // Il render loop continua a chiedere: senza questo la cache riproverebbe il
    // fetch 60 volte al secondo su un'immagine che non c'è.
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

  it("clear() dimentica tutto, e la richiesta successiva ricarica", () => {
    const l = fakeLoader();
    const cache = new ImageCache(l.load);
    cache.get("doc1", HASH);
    settle(l.created[0], false);

    cache.clear();
    expect(cache.get("doc1", HASH).status).toBe("loading");
    expect(l.created.length).toBe(2);
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
