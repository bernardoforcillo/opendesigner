import { describe, it, expect, beforeEach, vi } from "vitest";
import { useScene } from "../store/store";
import { emptyScene, type NodeLite } from "../store/types";
import {
  MAX_DROP_SIZE,
  STACK_OFFSET,
  attachImageDrop,
  dropImages,
  imageFilesOf,
  type ImageDropDeps,
} from "./imageDrop";

const HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const HASH2 = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

function installScene(): void {
  // `setScene` azzera coda, storia e avvisi ma NON il gesto aperto (è stato di
  // interazione, non di documento): senza questa riga il test che verifica la
  // guardia "a gesto aperto" lascerebbe il gesto aperto per tutti i successivi.
  useScene.setState({ gesture: null, lastError: null });
  useScene.getState().setScene(emptyScene("doc-1", "Untitled"));
}

function fakeFile(name: string, type: string): File {
  return { name, type, size: 1234 } as unknown as File;
}

// Le due dipendenze di contorno: la misura (che vuole un decoder di immagini) e
// la rete. Nessuna delle due esiste in jsdom, ed è ciò che rende il percorso
// verificabile senza un browser.
function deps(over: Partial<ImageDropDeps> = {}): ImageDropDeps {
  return {
    measure: async () => ({ width: 200, height: 100 }),
    upload: async () => ({ hash: HASH, size: 1234, contentType: "image/png" }),
    ...over,
  };
}

function nodes(): NodeLite[] {
  return Object.values(useScene.getState().scene?.nodes ?? {});
}

describe("dropImages", () => {
  beforeEach(() => {
    installScene();
  });

  it("carica il file e crea UN nodo immagine con il solo hash", async () => {
    const upload = vi.fn(async (_docId: string, _file: Blob) => ({
      hash: HASH, size: 1234, contentType: "image/png",
    }));
    const ids = await dropImages([fakeFile("logo.png", "image/png")], { x: 0, y: 0 }, deps({ upload }));

    expect(ids.length).toBe(1);
    expect(upload).toHaveBeenCalledTimes(1);
    // L'upload sa a quale DOCUMENTO appartiene l'asset: la cartella è per
    // documento, e l'URL di lettura pure.
    expect(upload.mock.calls[0][0]).toBe("doc-1");

    const n = nodes()[0];
    expect(n.kind).toBe("image");
    expect(n.image?.assetHash).toBe(HASH);
    // I byte NON sono nel modello: è tutto il punto dell'indirizzamento per
    // contenuto.
    expect(JSON.stringify(n).length).toBeLessThan(500);
  });

  it("il nodo ha l'ASPETTO naturale del file", async () => {
    await dropImages([fakeFile("a.png", "image/png")], { x: 0, y: 0 },
      deps({ measure: async () => ({ width: 200, height: 100 }) }));
    const n = nodes()[0];
    expect(n.width / n.height).toBeCloseTo(2);
    // Sotto il tetto la dimensione è quella vera: un'icona 200x100 non deve
    // atterrare gonfiata.
    expect(n.width).toBe(200);
    expect(n.height).toBe(100);
  });

  it("un'immagine enorme viene rimpicciolita SENZA deformarsi", async () => {
    await dropImages([fakeFile("foto.jpg", "image/jpeg")], { x: 0, y: 0 },
      deps({ measure: async () => ({ width: 4000, height: 2000 }) }));
    const n = nodes()[0];
    // Il lato lungo arriva al tetto, l'aspetto resta 2:1.
    expect(n.width).toBe(MAX_DROP_SIZE);
    expect(n.height).toBe(MAX_DROP_SIZE / 2);
  });

  it("il nodo è CENTRATO sul punto di rilascio", async () => {
    await dropImages([fakeFile("a.png", "image/png")], { x: 500, y: 300 },
      deps({ measure: async () => ({ width: 200, height: 100 }) }));
    const n = nodes()[0];
    expect(n.x).toBe(500 - 100);
    expect(n.y).toBe(300 - 50);
  });

  it("è UN gesto solo, quindi UNA voce di annulla", async () => {
    await dropImages(
      [fakeFile("a.png", "image/png"), fakeFile("b.png", "image/png")],
      { x: 0, y: 0 },
      deps(),
    );
    expect(nodes().length).toBe(2);
    // Due immagini, un Ctrl+Z: il gesto è il rilascio, non il file.
    expect(useScene.getState().undoStack.length).toBe(1);
    expect(useScene.getState().canUndo).toBe(true);
  });

  it("più immagini si scalano invece di sovrapporsi esattamente", async () => {
    const hashes = [HASH, HASH2];
    let i = 0;
    await dropImages(
      [fakeFile("a.png", "image/png"), fakeFile("b.png", "image/png")],
      { x: 0, y: 0 },
      deps({ upload: async () => ({ hash: hashes[i++], size: 1, contentType: "image/png" }) }),
    );
    const sorted = nodes().sort((a, b) => a.x - b.x);
    expect(sorted[1].x - sorted[0].x).toBe(STACK_OFFSET);
    expect(sorted[1].y - sorted[0].y).toBe(STACK_OFFSET);
  });

  it("i nodi creati restano SELEZIONATI", async () => {
    const ids = await dropImages([fakeFile("a.png", "image/png")], { x: 0, y: 0 }, deps());
    expect(useScene.getState().selection).toEqual(ids);
  });

  it("un file che non è un'immagine non crea niente e lo DICE", async () => {
    const upload = vi.fn();
    const ids = await dropImages([fakeFile("appunti.txt", "text/plain")], { x: 0, y: 0 }, deps({ upload }));
    expect(ids).toEqual([]);
    expect(nodes()).toEqual([]);
    expect(upload).not.toHaveBeenCalled();
    expect(useScene.getState().notice).toContain("immagine");
  });

  // Il tipo dichiarato dal sistema operativo può essere "" (estensione ignota):
  // è la MISURA a decidere se un file è un'immagine, non la sua etichetta.
  it("un file senza tipo dichiarato ma decodificabile viene accettato", async () => {
    const ids = await dropImages([fakeFile("senza-estensione", "")], { x: 0, y: 0 }, deps());
    expect(ids.length).toBe(1);
  });

  it("un file che si dichiara immagine ma non si decodifica viene rifiutato", async () => {
    const ids = await dropImages([fakeFile("rotta.png", "image/png")], { x: 0, y: 0 },
      deps({ measure: async () => { throw new Error("decode failed"); } }));
    expect(ids).toEqual([]);
    expect(nodes()).toEqual([]);
    expect(useScene.getState().notice).toBeTruthy();
  });

  it("un upload fallito diventa un AVVISO, non un nodo che punta al nulla", async () => {
    const ids = await dropImages([fakeFile("a.png", "image/png")], { x: 0, y: 0 },
      deps({ upload: async () => { throw new Error("il server ha risposto 413"); } }));
    expect(ids).toEqual([]);
    expect(nodes()).toEqual([]);
    expect(useScene.getState().notice).toContain("413");
    // Passa da `notice` e non da `lastError`: nessuna modifica è stata
    // annullata -- non è mai stata nemmeno tentata.
    expect(useScene.getState().lastError).toBeNull();
  });

  it("se una sola immagine fallisce, le altre atterrano lo stesso", async () => {
    let n = 0;
    const ids = await dropImages(
      [fakeFile("a.png", "image/png"), fakeFile("b.png", "image/png")],
      { x: 0, y: 0 },
      deps({
        upload: async () => {
          if (n++ === 0) throw new Error("boom");
          return { hash: HASH2, size: 1, contentType: "image/png" };
        },
      }),
    );
    expect(ids.length).toBe(1);
    expect(nodes().length).toBe(1);
    expect(useScene.getState().notice).toBeTruthy();
  });

  it("a gesto APERTO il rilascio non fa niente", async () => {
    // Stessa guardia di incolla e undo/redo: gli op finirebbero nella base del
    // gesto in corso, e il pointerup successivo ricostruirebbe da uno stato che
    // non è quello di partenza.
    useScene.getState().beginGesture();
    const ids = await dropImages([fakeFile("a.png", "image/png")], { x: 0, y: 0 }, deps());
    expect(ids).toEqual([]);
    expect(nodes()).toEqual([]);
  });

  it("senza documento aperto non fa niente", async () => {
    useScene.getState().setScene(null);
    expect(await dropImages([fakeFile("a.png", "image/png")], { x: 0, y: 0 }, deps())).toEqual([]);
  });
});

describe("imageFilesOf", () => {
  it("prende i file e ignora il resto del trascinamento", () => {
    const dt = {
      files: [fakeFile("a.png", "image/png")],
      types: ["Files"],
    } as unknown as DataTransfer;
    expect(imageFilesOf(dt).length).toBe(1);
    expect(imageFilesOf(null).length).toBe(0);
    expect(imageFilesOf({ files: [] } as unknown as DataTransfer).length).toBe(0);
  });
});

describe("attachImageDrop", () => {
  beforeEach(() => {
    installScene();
  });

  function target() {
    const handlers: Record<string, (e: Event) => void> = {};
    return {
      handlers,
      el: {
        addEventListener: (t: string, h: (e: Event) => void) => { handlers[t] = h; },
        removeEventListener: (t: string) => { delete handlers[t]; },
      },
    };
  }

  it("annulla il comportamento del browser sia sul trascinamento sia sul rilascio", () => {
    // SENZA preventDefault su dragover l'evento drop non arriva MAI; senza
    // preventDefault su drop il browser NAVIGA verso il file, cioè butta via il
    // documento aperto. Sono le due righe che fanno esistere la funzione.
    const t = target();
    attachImageDrop(t.el, () => ({ x: 0, y: 0 }), deps());

    const over = { preventDefault: vi.fn(), dataTransfer: { files: [], types: ["Files"] } };
    t.handlers.dragover(over as unknown as Event);
    expect(over.preventDefault).toHaveBeenCalled();

    const drop = {
      preventDefault: vi.fn(),
      dataTransfer: { files: [fakeFile("a.png", "image/png")], types: ["Files"] },
    };
    t.handlers.drop(drop as unknown as Event);
    expect(drop.preventDefault).toHaveBeenCalled();
  });

  it("un trascinamento che non porta file non viene intercettato", () => {
    // Selezionare del testo nel pannello livelli e trascinarlo sul canvas non è
    // un rilascio di immagini: rubare quell'evento impedirebbe qualunque altro
    // trascinamento (il riordino dei livelli, per dire) di funzionare.
    const t = target();
    attachImageDrop(t.el, () => ({ x: 0, y: 0 }), deps());
    const over = { preventDefault: vi.fn(), dataTransfer: { files: [], types: ["text/plain"] } };
    t.handlers.dragover(over as unknown as Event);
    expect(over.preventDefault).not.toHaveBeenCalled();
  });

  it("il rilascio passa dal punto in coordinate MONDO", async () => {
    const t = target();
    const toWorld = vi.fn(() => ({ x: 700, y: 800 }));
    attachImageDrop(t.el, toWorld, deps({ measure: async () => ({ width: 100, height: 100 }) }));
    const drop = {
      preventDefault: vi.fn(),
      dataTransfer: { files: [fakeFile("a.png", "image/png")], types: ["Files"] },
    };
    t.handlers.drop(drop as unknown as Event);
    await vi.waitFor(() => expect(nodes().length).toBe(1));
    expect(toWorld).toHaveBeenCalled();
    expect(nodes()[0].x).toBe(650);
  });

  it("la funzione di distacco toglie davvero i listener", () => {
    const t = target();
    const detach = attachImageDrop(t.el, () => ({ x: 0, y: 0 }), deps());
    expect(Object.keys(t.handlers).sort()).toEqual(["dragover", "drop"]);
    detach();
    expect(Object.keys(t.handlers)).toEqual([]);
  });
});
