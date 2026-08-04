import { describe, it, expect, beforeEach, vi } from "vitest";
import { runExport, exportFileName, downloadBlob } from "./exportScene";
import type { ExportDeps } from "./exportScene";
import { useScene } from "../store/store";
import { emptyScene } from "../store/types";
import type { NodeLite, SceneState } from "../store/types";

function node(over: Partial<NodeLite> & { id: string }): NodeLite {
  return {
    parentId: "page1", orderKey: "a1", name: over.id, visible: true, opacity: 1,
    x: 0, y: 0, width: 10, height: 10, rotation: 0,
    fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false,
    ...over,
  };
}

// Un nodo testo con il box di un nodo appena creato con un click: larghezza di
// wrap 100 e altezza di UNA riga (16 * 1.2 = 19.2). Con la misura finta (10
// unità per carattere) "abcdefghij klm" ne occupa DUE: è il caso in cui il box
// del modello e ciò che il canvas dipinge non coincidono.
function overflowingText(id: string): NodeLite {
  return node({
    id, kind: "text", x: 0, y: 0, width: 100, height: 19.2,
    text: {
      content: "abcdefghij klm",
      style: { fontFamily: "", fontSize: 16, fontWeight: "", lineHeight: 0, align: "left" },
    },
  });
}

function install(scene: SceneState | null, selection: string[] = []): void {
  useScene.setState({ scene, selection, gesture: null, notice: null, camera: { x: 0, y: 0, zoom: 1 } });
}

function sceneWith(name: string, ...nodes: NodeLite[]): SceneState {
  const s = emptyScene("doc", name);
  for (const n of nodes) s.nodes[n.id] = n;
  return s;
}

// Il canvas fuori schermo e la codifica PNG sono doppi: jsdom non ha né
// contesto 2D né toBlob. Qui si verifica il PERCORSO (chi viene chiamato, con
// che nome di file, con che tipo di blob), non i pixel.
class FakePath2D {
  rect() {}
  roundRect() {}
  ellipse() {}
}

function fakeCanvas(): HTMLCanvasElement {
  const canvas = {
    width: 0, height: 0,
    getContext: () => ctx,
  } as unknown as HTMLCanvasElement;
  const ctx = {
    canvas,
    font: "", textBaseline: "", textAlign: "", fillStyle: "", strokeStyle: "", lineWidth: 0,
    globalAlpha: 1,
    setTransform: () => {}, clearRect: () => {},
    measureText: (s: string) => ({ width: s.length * 10 }),
    fillText: () => {}, fill: () => {},
    // Il ramo immagine di drawScene: o `drawImage`, o il segnaposto. Registrati
    // perché è l'unico modo, senza pixel veri, di sapere QUALE dei due è
    // finito nel file.
    drawImage: (img: unknown) => { drawn.push(img); },
    fillRect: () => {}, strokeRect: () => {},
    beginPath: () => {}, moveTo: () => {}, lineTo: () => {}, stroke: () => { crosses++; },
  } as unknown as CanvasRenderingContext2D;
  return canvas;
}

// Che cosa il PNG ha davvero disegnato nell'ultimo export: le immagini passate
// a drawImage e quanti segnaposto (l'unico `stroke()` di drawScene è il loro).
let drawn: unknown[] = [];
let crosses = 0;

function deps(): ExportDeps & { saved: { blob: Blob; filename: string }[] } {
  const saved: { blob: Blob; filename: string }[] = [];
  return {
    saved,
    createCanvas: fakeCanvas,
    toPngBlob: async () => new Blob(["png"], { type: "image/png" }),
    download: (blob, filename) => { saved.push({ blob, filename }); },
    measure: (s: string) => s.length * 10,
  };
}

beforeEach(() => {
  vi.stubGlobal("Path2D", FakePath2D);
  install(null);
  drawn = [];
  crosses = 0;
});

describe("runExport — SVG", () => {
  it("esporta la pagina e consegna il markup", async () => {
    install(sceneWith("Untitled", node({ id: "a", x: 10, y: 20, width: 30, height: 40 })));
    const d = deps();
    await expect(runExport({ format: "svg", scope: "page", scale: 1 }, d)).resolves.toBe(true);
    expect(d.saved).toHaveLength(1);
    expect(d.saved[0].filename).toBe("Untitled.svg");
    expect(d.saved[0].blob.type).toContain("image/svg+xml");
    const text = await d.saved[0].blob.text();
    expect(text).toContain('<rect x="10" y="20" width="30" height="40"');
    expect(text).toContain('viewBox="10 20 30 40"');
  });

  it("esporta la SELEZIONE: solo i nodi scelti, e si vede dal nome del file", async () => {
    install(
      sceneWith("Untitled", node({ id: "a" }), node({ id: "b", orderKey: "a2", kind: "ellipse", x: 100 })),
      ["b"],
    );
    const d = deps();
    await runExport({ format: "svg", scope: "selection", scale: 1 }, d);
    const text = await d.saved[0].blob.text();
    expect(text).toContain("<ellipse");
    expect(text).not.toContain("<rect");
    expect(d.saved[0].filename).toBe("Untitled-selezione.svg");
  });

  it("NON dipende dalla camera: la vista non entra nel file", async () => {
    install(sceneWith("Untitled", node({ id: "a", x: 10, y: 20, width: 30, height: 40 })));
    const d1 = deps();
    await runExport({ format: "svg", scope: "page", scale: 1 }, d1);
    const first = await d1.saved[0].blob.text();

    // Stessa scena, vista completamente diversa (scrollata e zoomata).
    useScene.setState({ camera: { x: -3000, y: 812.5, zoom: 7.5 } });
    const d2 = deps();
    await runExport({ format: "svg", scope: "page", scale: 1 }, d2);
    expect(await d2.saved[0].blob.text()).toBe(first);
  });

  it("il testo che trabocca il suo box resta DENTRO il viewBox", async () => {
    // Il viewBox è il ritaglio del file: la radice SVG nasconde tutto ciò che
    // ne resta fuori. Con l'altezza del box del modello (19.2) i tspan della
    // seconda riga sarebbero comunque scritti nel file, e comunque invisibili
    // -- un export che sembra riuscito e ha perso metà del testo.
    install(sceneWith("Untitled", overflowingText("t")));
    const d = deps();
    await runExport({ format: "svg", scope: "page", scale: 1 }, d);
    const text = await d.saved[0].blob.text();
    expect(text).toContain('viewBox="0 0 100 38.4"');
    expect(text).toContain('height="38.4"');
    // le due righe, entrambe sopra il bordo inferiore del viewBox
    expect(text).toContain('<tspan x="0" y="14.4">abcdefghij</tspan>');
    expect(text).toContain('<tspan x="0" y="33.6">klm</tspan>');
  });
});

describe("runExport — PNG", () => {
  it("passa dal canvas fuori schermo e consegna i byte PNG", async () => {
    install(sceneWith("Untitled", node({ id: "a", width: 30, height: 40 })));
    const d = deps();
    const canvases: HTMLCanvasElement[] = [];
    d.createCanvas = () => { const c = fakeCanvas(); canvases.push(c); return c; };
    await expect(runExport({ format: "png", scope: "page", scale: 2 }, d)).resolves.toBe(true);
    expect(d.saved[0].filename).toBe("Untitled@2x.png");
    expect(d.saved[0].blob.type).toBe("image/png");
    // il canvas è quello della regione per la scala scelta
    expect(canvases.at(-1)!.width).toBe(60);
    expect(canvases.at(-1)!.height).toBe(80);
  });

  it("un'immagine oltre il tetto del canvas diventa un AVVISO, non un PNG bianco", async () => {
    // 6000×6000 unità a 3x = 324 Mpx: oltre il massimo del canvas. Il browser
    // non lo direbbe -- Chrome ritorna un contesto che non disegna e toBlob
    // produce un PNG valido e vuoto -- quindi lo deve dire l'app, e lo dice
    // dallo stesso canale di ogni altro export non riuscito.
    install(sceneWith("Untitled", node({ id: "a", x: 0, y: 0, width: 6000, height: 6000 })));
    const d = deps();
    await expect(runExport({ format: "png", scope: "page", scale: 3 }, d)).resolves.toBe(false);
    expect(d.saved).toHaveLength(0);
    expect(useScene.getState().notice).toMatch(/troppo grande/i);

    // ...e la stessa regione a 1x, o in SVG, esce senza problemi: il tetto è
    // del canvas, non del documento.
    await expect(runExport({ format: "png", scope: "page", scale: 1 }, d)).resolves.toBe(true);
    await expect(runExport({ format: "svg", scope: "page", scale: 3 }, d)).resolves.toBe(true);
  });

  it("il canvas è alto quanto il testo dipinto, anche senza una misura iniettata", async () => {
    // Nessun `measure` nelle deps: la misura la costruisce runExport dal
    // canvas, e serve al PNG tanto quanto all'SVG -- è quella che dice quanto
    // deve essere alto il canvas fuori schermo. Senza, il PNG verrebbe alto
    // 20 px (il box) invece di 39 (le due righe) e taglierebbe la seconda.
    install(sceneWith("Untitled", overflowingText("t")));
    const d = deps();
    d.measure = undefined;
    const canvases: HTMLCanvasElement[] = [];
    d.createCanvas = () => { const c = fakeCanvas(); canvases.push(c); return c; };
    await expect(runExport({ format: "png", scope: "page", scale: 1 }, d)).resolves.toBe(true);
    expect(canvases.at(-1)!.width).toBe(100);
    expect(canvases.at(-1)!.height).toBe(39); // ceil(38.4)
  });

  it("senza contesto 2D l'export lo DICE, invece di esplodere", async () => {
    // La misura del testo si costruisce da un canvas, e ora serve prima ancora
    // di sapere quanto è grande la regione: se quel canvas non dà un contesto,
    // il motivo deve uscire dallo stesso canale di ogni altro export fallito.
    install(sceneWith("Untitled", node({ id: "a" })));
    const d = deps();
    d.measure = undefined;
    d.createCanvas = () => ({ getContext: () => null }) as unknown as HTMLCanvasElement;
    await expect(runExport({ format: "png", scope: "page", scale: 1 }, d)).resolves.toBe(false);
    expect(d.saved).toHaveLength(0);
    expect(useScene.getState().notice).toMatch(/contesto 2D/i);
  });

  it("a 1x il nome del file non porta nessun suffisso di scala", async () => {
    install(sceneWith("Untitled", node({ id: "a" })));
    const d = deps();
    await runExport({ format: "png", scope: "page", scale: 1 }, d);
    expect(d.saved[0].filename).toBe("Untitled.png");
  });
});

describe("runExport — quando non c'è niente da esportare", () => {
  it("nessun documento: non scarica niente", async () => {
    install(null);
    const d = deps();
    await expect(runExport({ format: "svg", scope: "page", scale: 1 }, d)).resolves.toBe(false);
    expect(d.saved).toHaveLength(0);
  });

  it("selezione vuota: lo DICE invece di scaricare un file vuoto", async () => {
    install(sceneWith("Untitled", node({ id: "a" })), []);
    const d = deps();
    await expect(runExport({ format: "svg", scope: "selection", scale: 1 }, d)).resolves.toBe(false);
    expect(d.saved).toHaveLength(0);
    expect(useScene.getState().notice).toMatch(/selezion/i);
  });

  it("pagina vuota: stesso trattamento", async () => {
    install(sceneWith("Untitled"), []);
    const d = deps();
    await expect(runExport({ format: "png", scope: "page", scale: 1 }, d)).resolves.toBe(false);
    expect(useScene.getState().notice).toBeTruthy();
  });

  it("un errore durante l'export diventa un avviso, non un'eccezione in aria", async () => {
    install(sceneWith("Untitled", node({ id: "a" })));
    const d = deps();
    d.toPngBlob = async () => { throw new Error("codifica fallita"); };
    await expect(runExport({ format: "png", scope: "page", scale: 1 }, d)).resolves.toBe(false);
    expect(d.saved).toHaveLength(0);
    expect(useScene.getState().notice).toContain("codifica fallita");
  });
});

describe("exportFileName", () => {
  it("parte dal nome del documento", () => {
    expect(exportFileName("Il mio poster", { format: "svg", scope: "page", scale: 1 })).toBe("Il mio poster.svg");
  });

  it("toglie i caratteri che un file system non accetta", () => {
    // \ / : * ? " < > | non possono stare in un nome di file su Windows, e un
    // documento può chiamarsi come gli pare.
    expect(exportFileName('a/b\\c:d*e?f"g<h>i|j', { format: "png", scope: "page", scale: 1 }))
      .toBe("a-b-c-d-e-f-g-h-i-j.png");
  });

  it("un nome vuoto (o fatto di soli caratteri tolti) ricade su un nome buono", () => {
    expect(exportFileName("", { format: "png", scope: "page", scale: 1 })).toBe("brawt.png");
    expect(exportFileName("///", { format: "svg", scope: "page", scale: 1 })).toBe("brawt.svg");
  });

  it("scala e ambito compaiono nel nome", () => {
    expect(exportFileName("Doc", { format: "png", scope: "selection", scale: 3 })).toBe("Doc-selezione@3x.png");
  });
});

describe("downloadBlob", () => {
  it("crea un URL, clicca un <a download> e poi lo revoca", () => {
    const created: Blob[] = [];
    const revoked: string[] = [];
    vi.stubGlobal("URL", {
      createObjectURL: (b: Blob) => { created.push(b); return "blob:finto"; },
      revokeObjectURL: (u: string) => { revoked.push(u); },
    });
    vi.useFakeTimers();
    const blob = new Blob(["x"]);
    let clicked: HTMLAnchorElement | null = null;
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) { clicked = this; });

    downloadBlob(blob, "prova.svg");

    expect(created).toEqual([blob]);
    expect(click).toHaveBeenCalledOnce();
    expect(clicked!.download).toBe("prova.svg");
    expect(clicked!.href).toContain("blob:finto");
    // l'ancora non resta appesa nel documento
    expect(document.querySelector("a[download]")).toBeNull();
    // l'URL si revoca DOPO il click, non prima: revocarlo subito annulla il
    // download in alcuni browser.
    expect(revoked).toEqual([]);
    vi.runAllTimers();
    expect(revoked).toEqual(["blob:finto"]);

    click.mockRestore();
    vi.useRealTimers();
  });
});

// --- immagini nell'export (traccia 3) ----------------------------------------

function imageNode(id: string, hash: string): NodeLite {
  return node({ id, kind: "image", x: 0, y: 0, width: 200, height: 100, image: { assetHash: hash } });
}

describe("runExport — immagini", () => {
  it("l'SVG INCORPORA i byte come data URI, non un link al server locale", async () => {
    // Un href a /assets-api/... sarebbe rotto appena il file esce da questa
    // macchina, cioè appena serve a qualcosa.
    install(sceneWith("Untitled", imageNode("i", "abc")));
    const d = { ...deps(), loadAssetDataUrl: async () => "data:image/png;base64,QUJD" };
    await expect(runExport({ format: "svg", scope: "page", scale: 1 }, d)).resolves.toBe(true);
    const text = await d.saved[0].blob.text();
    expect(text).toContain("<image");
    expect(text).toContain("data:image/png;base64,QUJD");
    expect(text).not.toContain("/assets-api/");
  });

  it("chiede i byte UNA volta per hash, anche con lo stesso asset ripetuto", async () => {
    install(sceneWith("Untitled",
      imageNode("i1", "abc"),
      node({ ...imageNode("i2", "abc"), id: "i2", orderKey: "a2", x: 300 }),
      node({ ...imageNode("i3", "def"), id: "i3", orderKey: "a3", x: 600 }),
    ));
    const asked: string[] = [];
    const d = {
      ...deps(),
      loadAssetDataUrl: async (_docId: string, hash: string) => {
        asked.push(hash);
        return `data:image/png;base64,${hash}`;
      },
    };
    await runExport({ format: "svg", scope: "page", scale: 1 }, d);
    expect(asked.sort()).toEqual(["abc", "def"]);
  });

  it("un asset irraggiungibile non fa fallire l'export: esce il segnaposto, e l'utente lo SA", async () => {
    install(sceneWith("Untitled", imageNode("i", "abc")));
    const d = { ...deps(), loadAssetDataUrl: async () => { throw new Error("404"); } };
    await expect(runExport({ format: "svg", scope: "page", scale: 1 }, d)).resolves.toBe(true);
    const text = await d.saved[0].blob.text();
    expect(text).not.toContain("<image");
    expect(text).toContain("<path");
    // L'export è riuscito -- il documento contiene davvero un riferimento
    // rotto, e il file lo mostra invece di non esistere -- ma un file consegnato
    // con dei buchi al posto delle fotografie non può uscire in silenzio.
    expect(useScene.getState().notice).toMatch(/un'immagine non è stata inclusa/);
  });

  it("un export senza buchi non lascia nessun avviso", async () => {
    install(sceneWith("Untitled", imageNode("i", "abc")));
    const d = { ...deps(), loadAssetDataUrl: async () => "data:image/png;base64,QUJD" };
    await runExport({ format: "svg", scope: "page", scale: 1 }, d);
    expect(useScene.getState().notice).toBeNull();
  });

  it("l'avviso conta i NODI che restano segnaposto, hash vuoto compreso", async () => {
    install(sceneWith("Untitled",
      imageNode("i1", "abc"),
      node({ ...imageNode("i2", ""), id: "i2", orderKey: "a2", x: 300 }),
    ));
    const d = { ...deps(), loadAssetDataUrl: async () => null };
    await runExport({ format: "svg", scope: "page", scale: 1 }, d);
    // Il nodo con l'hash vuoto non ha niente da chiedere e non lo chiede, ma
    // nel file è un buco esattamente come l'altro.
    expect(useScene.getState().notice).toMatch(/^2 immagini non sono state incluse/);
  });

  it("la regione tiene conto del box dell'immagine", async () => {
    install(sceneWith("Untitled", imageNode("i", "abc")));
    const d = { ...deps(), loadAssetDataUrl: async () => null };
    await runExport({ format: "svg", scope: "page", scale: 1 }, d);
    const text = await d.saved[0].blob.text();
    expect(text).toContain('viewBox="0 0 200 100"');
  });
});

// --- il PNG ASPETTA le immagini ----------------------------------------------
//
// Il difetto che questi test chiudono: il PNG passava da `drawScene` con la
// sorgente di default, cioè la cache MUTABILE del renderer, e non aspettava
// niente. Aprire un documento ed esportare subito dava un file con i segnaposto;
// esportare un secondo dopo dava le fotografie. Stesso documento, due file, e
// nessun avviso -- per di più in disaccordo con l'SVG dello stesso documento,
// che i byte se li è sempre riscaricati.

const PIXEL = { naturalWidth: 4, naturalHeight: 4 } as unknown as HTMLImageElement;

describe("runExport — PNG e immagini", () => {
  it("chiede i byte, li decodifica e li ASPETTA prima di disegnare", async () => {
    install(sceneWith("Untitled", imageNode("i", "abc")));
    const asked: string[] = [];
    const decoded: string[] = [];
    const d = {
      ...deps(),
      loadAssetDataUrl: async (_doc: string, hash: string) => { asked.push(hash); return `data:image/png;base64,${hash}`; },
      decodeImage: async (uri: string) => { decoded.push(uri); return PIXEL; },
    };
    await expect(runExport({ format: "png", scope: "page", scale: 1 }, d)).resolves.toBe(true);
    expect(asked).toEqual(["abc"]);
    expect(decoded).toEqual(["data:image/png;base64,abc"]);
    // I pixel veri sono finiti sul canvas, e nessun segnaposto con loro.
    expect(drawn).toEqual([PIXEL]);
    expect(crosses).toBe(0);
    expect(useScene.getState().notice).toBeNull();
  });

  it("NON legge la cache del renderer: due export dello stesso documento danno lo stesso file", async () => {
    // La cache condivisa si riempie da sé mentre l'utente guarda lo schermo: se
    // l'export la leggesse, il file dipenderebbe da quanto tempo il documento è
    // aperto. Qui la sorgente è locale all'export, quindi il primo export e il
    // secondo disegnano esattamente le stesse cose.
    install(sceneWith("Untitled", imageNode("i", "abc")));
    const d = {
      ...deps(),
      loadAssetDataUrl: async () => "data:image/png;base64,QUJD",
      decodeImage: async () => PIXEL,
    };
    await runExport({ format: "png", scope: "page", scale: 1 }, d);
    const first = [...drawn];
    drawn = [];
    await runExport({ format: "png", scope: "page", scale: 1 }, d);
    expect(drawn).toEqual(first);
    expect(drawn).toEqual([PIXEL]);
  });

  it("chiede e decodifica UNA volta per hash, anche con lo stesso asset ripetuto", async () => {
    install(sceneWith("Untitled",
      imageNode("i1", "abc"),
      node({ ...imageNode("i2", "abc"), id: "i2", orderKey: "a2", x: 300 }),
    ));
    const asked: string[] = [];
    const decode = vi.fn(async () => PIXEL);
    const d = {
      ...deps(),
      loadAssetDataUrl: async (_doc: string, hash: string) => { asked.push(hash); return "data:x"; },
      decodeImage: decode,
    };
    await runExport({ format: "png", scope: "page", scale: 1 }, d);
    expect(asked).toEqual(["abc"]);
    expect(decode).toHaveBeenCalledTimes(1);
    // Un asset solo, ma disegnato su tutti e due i nodi.
    expect(drawn).toEqual([PIXEL, PIXEL]);
  });

  it("un asset irraggiungibile diventa il segnaposto, e l'export lo DICE", async () => {
    install(sceneWith("Untitled", imageNode("i", "abc")));
    const d = { ...deps(), loadAssetDataUrl: async () => null, decodeImage: async () => PIXEL };
    await expect(runExport({ format: "png", scope: "page", scale: 1 }, d)).resolves.toBe(true);
    expect(drawn).toEqual([]);
    expect(crosses).toBe(1); // la croce del segnaposto, non un'immagine
    expect(useScene.getState().notice).toMatch(/un'immagine non è stata inclusa/);
  });

  it("byte scaricati ma non decodificabili: segnaposto e avviso, non un'eccezione", async () => {
    install(sceneWith("Untitled", imageNode("i", "abc")));
    const d = { ...deps(), loadAssetDataUrl: async () => "data:x", decodeImage: async () => null };
    await expect(runExport({ format: "png", scope: "page", scale: 1 }, d)).resolves.toBe(true);
    expect(drawn).toEqual([]);
    expect(useScene.getState().notice).toMatch(/un'immagine non è stata inclusa/);
  });

  it("l'SVG non paga la decodifica: gli bastano i byte", async () => {
    install(sceneWith("Untitled", imageNode("i", "abc")));
    const decode = vi.fn(async () => PIXEL);
    const d = { ...deps(), loadAssetDataUrl: async () => "data:x", decodeImage: decode };
    await runExport({ format: "svg", scope: "page", scale: 1 }, d);
    expect(decode).not.toHaveBeenCalled();
  });

  it("PNG e SVG dello stesso documento sono d'accordo su che cosa manca", async () => {
    // Prima erano due percorsi diversi: l'SVG riscaricava i byte, il PNG
    // leggeva la cache. Lo stesso documento poteva uscire con l'immagine in un
    // formato e con il segnaposto nell'altro.
    install(sceneWith("Untitled", imageNode("i", "abc")));
    const d = { ...deps(), loadAssetDataUrl: async () => null, decodeImage: async () => PIXEL };
    await runExport({ format: "png", scope: "page", scale: 1 }, d);
    const pngNotice = useScene.getState().notice;
    useScene.setState({ notice: null });
    await runExport({ format: "svg", scope: "page", scale: 1 }, d);
    expect(useScene.getState().notice).toBe(pngNotice);
    expect(await d.saved[1].blob.text()).not.toContain("<image");
    expect(crosses).toBe(1); // il PNG ha disegnato la stessa croce
  });
});
