import { describe, it, expect, afterEach, vi } from "vitest";
import {
  renderRegionToCanvas,
  canvasToPngBlob,
  canvasLimitMessage,
  EXPORT_SCALES,
  MAX_CANVAS_SIDE,
  MAX_CANVAS_AREA,
} from "./png";
import { exportRegion } from "./region";
import { emptyScene } from "../store/types";
import type { NodeLite, SceneState } from "../store/types";

// jsdom non ha né il contesto 2D né Path2D: il canvas è un doppio che REGISTRA
// invece di disegnare. È esattamente ciò che serve qui -- la prova a pixel è in
// browser, quella che si può fare in Node è che il canvas fuori schermo sia
// grande quanto deve e trasformato come deve.
class FakePath2D {
  rect() {}
  roundRect() {}
  ellipse() {}
}

interface Recorded {
  transforms: number[][];
  fills: number;
  texts: string[];
}

function fakeCanvas(): { canvas: HTMLCanvasElement; rec: Recorded } {
  const rec: Recorded = { transforms: [], fills: 0, texts: [] };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ctx,
  } as unknown as HTMLCanvasElement;
  const ctx = {
    canvas,
    font: "", textBaseline: "", textAlign: "", fillStyle: "", globalAlpha: 1,
    setTransform: (a: number, b: number, c: number, d: number, e: number, f: number) => {
      rec.transforms.push([a, b, c, d, e, f]);
    },
    clearRect: () => {},
    measureText: (s: string) => ({ width: s.length * 10 }),
    fillText: (t: string) => { rec.texts.push(t); },
    fill: () => { rec.fills++; },
  } as unknown as CanvasRenderingContext2D;
  return { canvas, rec };
}

function node(over: Partial<NodeLite> & { id: string }): NodeLite {
  return {
    parentId: "page1", orderKey: "a1", name: over.id, visible: true, opacity: 1,
    x: 0, y: 0, width: 10, height: 10, rotation: 0,
    fills: [{ r: 0, g: 0, b: 0, a: 1 }], kind: "rect", cornerRadius: 0,
    ...over,
  };
}

function sceneWith(...nodes: NodeLite[]): SceneState {
  const s = emptyScene("doc", "Untitled");
  for (const n of nodes) s.nodes[n.id] = n;
  return s;
}

// La stessa misura finta del ctx qui sopra (10 unità per carattere): la
// regione la usa per sapere quanto è alto il testo, quindi quanto deve essere
// alto il canvas.
const measure = (s: string) => s.length * 10;

function regionOf(scene: SceneState, selection: string[] = [], scope: "page" | "selection" = "page") {
  const r = exportRegion(scene, selection, scope, measure);
  if (!r) throw new Error("regione vuota nel test");
  return r;
}

// L'ULTIMA setTransform è quella con cui si disegna (la prima azzera prima di
// pulire il canvas).
//
// `+ 0` normalizza lo zero NEGATIVO: una regione che parte da x = 0 produce una
// traslazione -0, che per il canvas è la stessa traslazione di 0 ma che
// toEqual distingue (confronta con Object.is). Il segno dello zero non è
// un'informazione, e non deve diventare un motivo per contorcere il codice che
// calcola la trasformazione.
function drawTransform(rec: Recorded): number[] {
  return rec.transforms[rec.transforms.length - 1].map((v) => v + 0);
}

describe("renderRegionToCanvas", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("il canvas fuori schermo è grande quanto la regione per la scala", () => {
    vi.stubGlobal("Path2D", FakePath2D);
    const region = regionOf(sceneWith(node({ id: "a", x: 10, y: 20, width: 100, height: 50 })));
    const { canvas } = fakeCanvas();
    renderRegionToCanvas(region, 2, () => canvas);
    expect(canvas.width).toBe(200);
    expect(canvas.height).toBe(100);
  });

  it("la trasformazione porta l'ANGOLO della regione nell'origine, scalato", () => {
    vi.stubGlobal("Path2D", FakePath2D);
    const region = regionOf(sceneWith(node({ id: "a", x: 10, y: 20, width: 100, height: 50 })));
    const { canvas, rec } = fakeCanvas();
    renderRegionToCanvas(region, 2, () => canvas);
    // scale 2, e la traslazione è -origine * scala: il pixel (0,0)
    // dell'immagine è il punto mondo (10, 20).
    expect(drawTransform(rec)).toEqual([2, 0, 0, 2, -20, -40]);
  });

  it("ognuna delle scale offerte", () => {
    vi.stubGlobal("Path2D", FakePath2D);
    const region = regionOf(sceneWith(node({ id: "a", x: 0, y: 0, width: 30, height: 40 })));
    for (const scale of EXPORT_SCALES) {
      const { canvas, rec } = fakeCanvas();
      renderRegionToCanvas(region, scale, () => canvas);
      expect(canvas.width).toBe(30 * scale);
      expect(canvas.height).toBe(40 * scale);
      expect(drawTransform(rec)).toEqual([scale, 0, 0, scale, 0, 0]);
    }
  });

  it("il devicePixelRatio della macchina NON entra nell'export", () => {
    // Il canvas dello schermo scala per il dpr (canvasRenderer.ts) e deve
    // farlo; un canvas fuori schermo non ha un dispositivo. Senza questa
    // regola lo stesso documento esportato a 2x darebbe un file grande il
    // doppio su un portatile HiDPI -- e ritagliato, perché il canvas sarebbe
    // comunque della dimensione richiesta.
    vi.stubGlobal("Path2D", FakePath2D);
    vi.stubGlobal("window", { devicePixelRatio: 3 });
    const region = regionOf(sceneWith(node({ id: "a", x: 0, y: 0, width: 100, height: 100 })));
    const { canvas, rec } = fakeCanvas();
    renderRegionToCanvas(region, 2, () => canvas);
    expect(canvas.width).toBe(200);
    expect(drawTransform(rec)).toEqual([2, 0, 0, 2, 0, 0]);
  });

  it("una regione frazionaria non viene TAGLIATA: si arrotonda per eccesso", () => {
    vi.stubGlobal("Path2D", FakePath2D);
    const region = regionOf(sceneWith(node({ id: "a", x: 0, y: 0, width: 10.2, height: 10.6 })));
    const { canvas } = fakeCanvas();
    renderRegionToCanvas(region, 1, () => canvas);
    expect(canvas.width).toBe(11);
    expect(canvas.height).toBe(11);
  });

  it("un canvas non è mai di lato zero", () => {
    vi.stubGlobal("Path2D", FakePath2D);
    // Un testo ancora VUOTO dentro un box alto 0: nessuna riga da misurare,
    // quindi la regione resta alta 0 -- e un canvas di area nulla fa fallire
    // toBlob invece di produrre un'immagine vuota.
    const region = regionOf(
      sceneWith(node({
        id: "t", kind: "text", width: 100, height: 0,
        text: { content: "", style: { fontFamily: "", fontSize: 16, fontWeight: "", lineHeight: 0, align: "left" } },
      })),
    );
    const { canvas } = fakeCanvas();
    renderRegionToCanvas(region, 1, () => canvas);
    expect(canvas.width).toBe(100);
    expect(canvas.height).toBe(1);
  });

  it("il canvas è alto quanto il testo DIPINTO, non quanto il suo box", () => {
    vi.stubGlobal("Path2D", FakePath2D);
    // Due righe (10 unità per carattere, wrap a 100) dentro un box alto una
    // riga sola: con l'altezza del box il canvas sarebbe alto 20 px e la
    // seconda riga finirebbe fuori dal PNG senza un solo avviso.
    const region = regionOf(
      sceneWith(node({
        id: "t", kind: "text", x: 0, y: 0, width: 100, height: 19.2,
        text: {
          content: "abcdefghij klm",
          style: { fontFamily: "", fontSize: 16, fontWeight: "", lineHeight: 0, align: "left" },
        },
      })),
    );
    const { canvas, rec } = fakeCanvas();
    renderRegionToCanvas(region, 2, () => canvas);
    expect(canvas.width).toBe(200);
    expect(canvas.height).toBe(Math.ceil(38.4 * 2)); // 77, non 39
    // e le due righe ci sono davvero entrambe
    expect(rec.texts).toEqual(["abcdefghij", "klm"]);
  });

  it("disegna SOLO i nodi della regione", () => {
    vi.stubGlobal("Path2D", FakePath2D);
    const scene = sceneWith(
      node({ id: "a", orderKey: "a1" }),
      node({ id: "b", orderKey: "a2", x: 100 }),
    );
    const { canvas, rec } = fakeCanvas();
    renderRegionToCanvas(regionOf(scene, ["b"], "selection"), 1, () => canvas);
    expect(rec.fills).toBe(1);
    // e il canvas è grande quanto il solo nodo selezionato
    expect(canvas.width).toBe(10);
  });

  it("riusa il renderer vero: un nodo testo passa da drawText", () => {
    const scene = sceneWith(node({
      id: "t", kind: "text", x: 0, y: 0, width: 100, height: 40,
      text: { content: "ciao", style: { fontFamily: "", fontSize: 16, fontWeight: "", lineHeight: 0, align: "left" } },
    }));
    const { canvas, rec } = fakeCanvas();
    renderRegionToCanvas(regionOf(scene), 1, () => canvas);
    expect(rec.texts).toEqual(["ciao"]);
  });

  it("se il contesto 2D non c'è, lo dice invece di ritornare un canvas vuoto", () => {
    const canvas = { width: 0, height: 0, getContext: () => null } as unknown as HTMLCanvasElement;
    const region = regionOf(sceneWith(node({ id: "a" })));
    expect(() => renderRegionToCanvas(region, 1, () => canvas)).toThrow(/contesto 2D/i);
  });

  // Il controllo del contesto nullo qui sopra NON basta, ed è il motivo di
  // questi tre test: oltre il tetto Chrome ritorna un contesto regolare su un
  // bitmap che non esiste, disegna nel vuoto e produce un PNG valido e VUOTO.
  // Senza il tetto l'utente scaricherebbe un'immagine bianca senza nessun
  // avviso -- il modo peggiore di fallire, perché sembra riuscito.
  it("una regione oltre il limite di AREA si ferma con un messaggio, non con un PNG vuoto", () => {
    vi.stubGlobal("Path2D", FakePath2D);
    // 6000×6000 unità a 3x = 18000×18000 = 324 Mpx, oltre i 268,4 del canvas.
    const region = regionOf(sceneWith(node({ id: "a", x: 0, y: 0, width: 6000, height: 6000 })));
    let created = 0;
    const create = () => { created++; return fakeCanvas().canvas; };
    expect(() => renderRegionToCanvas(region, 3, create)).toThrow(/troppo grande/i);
    // e si ferma PRIMA di allocare: non c'è nessun canvas da 324 Mpx in giro.
    expect(created).toBe(0);
  });

  it("anche un solo LATO oltre il limite si ferma, per quanto sottile sia la regione", () => {
    vi.stubGlobal("Path2D", FakePath2D);
    // Un nastro lunghissimo: l'area sta larga (327 680 px, un millesimo del
    // tetto) ma il lato no, e un canvas con un lato oltre il massimo è vuoto
    // tanto quanto uno di area eccessiva.
    const region = regionOf(
      sceneWith(node({ id: "a", x: 0, y: 0, width: MAX_CANVAS_SIDE + 1, height: 10 })),
    );
    expect(() => renderRegionToCanvas(region, 1, () => fakeCanvas().canvas)).toThrow(/troppo grande/i);
  });

  it("esattamente al limite di area passa: il tetto non è un margine inventato", () => {
    vi.stubGlobal("Path2D", FakePath2D);
    const side = Math.sqrt(MAX_CANVAS_AREA); // 16384, e nessun lato fuori norma
    const region = regionOf(sceneWith(node({ id: "a", x: 0, y: 0, width: side, height: side })));
    const { canvas } = fakeCanvas();
    renderRegionToCanvas(region, 1, () => canvas);
    expect(canvas.width * canvas.height).toBe(MAX_CANVAS_AREA);
  });
});

describe("canvasLimitMessage", () => {
  it("sotto i due limiti non ha niente da dire", () => {
    expect(canvasLimitMessage(1, 1)).toBeNull();
    expect(canvasLimitMessage(16_384, 16_384)).toBeNull();
    expect(canvasLimitMessage(MAX_CANVAS_SIDE, 8_000)).toBeNull();
  });

  it("l'area e il lato sono due limiti INDIPENDENTI, e basta superarne uno", () => {
    // Area oltre (327 Mpx), lati entrambi dentro.
    expect(canvasLimitMessage(MAX_CANVAS_SIDE, 10_000)).toBeTruthy();
    // Lato oltre, area ampiamente dentro (65 536 px).
    expect(canvasLimitMessage(MAX_CANVAS_SIDE + 1, 2)).toBeTruthy();
  });

  it("dice la dimensione chiesta, il limite e come uscirne", () => {
    // Un avviso che dicesse solo "troppo grande" lascerebbe l'utente a
    // indovinare che cosa cambiare.
    const msg = canvasLimitMessage(18000, 18000)!;
    expect(msg).toContain("18000×18000");
    expect(msg).toContain("324.0 Mpx");
    expect(msg).toContain("268.4 Mpx");
    expect(msg).toMatch(/scala più bassa/i);
  });
});

describe("canvasToPngBlob", () => {
  it("chiede image/png e risolve con il blob", async () => {
    const blob = new Blob(["x"], { type: "image/png" });
    const types: (string | undefined)[] = [];
    const canvas = {
      toBlob: (cb: (b: Blob | null) => void, type?: string) => { types.push(type); cb(blob); },
    } as unknown as HTMLCanvasElement;
    await expect(canvasToPngBlob(canvas)).resolves.toBe(blob);
    expect(types).toEqual(["image/png"]);
  });

  it("un blob nullo diventa un errore, non un download vuoto", async () => {
    const canvas = {
      toBlob: (cb: (b: Blob | null) => void) => cb(null),
    } as unknown as HTMLCanvasElement;
    await expect(canvasToPngBlob(canvas)).rejects.toThrow();
  });
});
