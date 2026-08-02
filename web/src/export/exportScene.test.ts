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
    fills: [{ r: 0, g: 0, b: 0, a: 1 }], kind: "rect", cornerRadius: 0,
    ...over,
  };
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
    font: "", textBaseline: "", textAlign: "", fillStyle: "", globalAlpha: 1,
    setTransform: () => {}, clearRect: () => {},
    measureText: (s: string) => ({ width: s.length * 10 }),
    fillText: () => {}, fill: () => {},
  } as unknown as CanvasRenderingContext2D;
  return canvas;
}

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
