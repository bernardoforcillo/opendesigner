import { describe, it, expect, beforeEach, vi } from "vitest";
import { useScene } from "../store/store";
import { emptyScene, type NodeLite } from "../store/types";
import {
  importSvgAt, importSvgFile, importedNotice, isSvgFile, looksLikeSvg, pickSvgFile, viewportCenter,
  type SvgImportDeps,
} from "./svgImport";

const HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 60" width="100" height="60">
  <title>Prova</title>
  <g id="gruppo"><rect id="r" x="10" y="10" width="30" height="20" fill="#f00"/><circle id="c" cx="70" cy="30" r="10"/></g>
  <path id="p" d="M0 0 L50 50" stroke="#00f"/>
</svg>`;

function installScene(): void {
  useScene.setState({ gesture: null, lastError: null, notice: null, selection: [], camera: { x: 0, y: 0, zoom: 1 } });
  useScene.getState().setScene(emptyScene("doc-1", "Untitled"));
}

function nodes(): NodeLite[] {
  const s = useScene.getState().scene;
  return s ? [...s.nodes.values()] : [];
}

function deps(over: Partial<SvgImportDeps> = {}): SvgImportDeps {
  return { upload: async () => ({ hash: HASH, size: 10, contentType: "image/png" }), measureText: () => 10, ...over };
}

describe("looksLikeSvg / isSvgFile", () => {
  it("riconosce la radice <svg> con o senza prologo, commenti e doctype", () => {
    expect(looksLikeSvg(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`)).toBe(true);
    expect(looksLikeSvg(`  \n<svg viewBox="0 0 1 1"/>`)).toBe(true);
    expect(looksLikeSvg(`<?xml version="1.0" encoding="UTF-8"?>\n<!-- Generator: x -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd">\n<svg width="1"></svg>`)).toBe(true);
    expect(looksLikeSvg(`<SVG viewBox="0 0 1 1"></SVG>`)).toBe(true);
  });
  it("e una radice <svg> con del contorno, purché si chiuda", () => {
    expect(looksLikeSvg(`Ecco l'icona:\n<svg viewBox="0 0 1 1"><rect/></svg>\nciao`)).toBe(true);
    expect(looksLikeSvg(`<div><svg width="1"><path/></svg></div>`)).toBe(true);
  });
  it("non confonde altro testo, né un payload JSON che nomina un <svg>", () => {
    expect(looksLikeSvg("")).toBe(false);
    expect(looksLikeSvg("ciao mondo")).toBe(false);
    expect(looksLikeSvg("<html><body>svg</body></html>")).toBe(false);
    // Con la radice in testa ci si prova (e l'import dirà perché non va) ...
    expect(looksLikeSvg("<svg senza chiusura")).toBe(true);
    // ... ma una menzione in mezzo al testo, senza chiusura, non basta.
    expect(looksLikeSvg("guarda: <svg senza chiusura")).toBe(false);
    expect(looksLikeSvg(`{"format":"opendesigner/clipboard","nodes":[{"name":"<svg a></svg>"}]}`)).toBe(false);
    expect(looksLikeSvg("<svgfoo></svgfoo>")).toBe(false);
  });
  it("isSvgFile: dal tipo MIME o dall'estensione", () => {
    expect(isSvgFile({ name: "a.svg", type: "image/svg+xml" })).toBe(true);
    expect(isSvgFile({ name: "A.SVG", type: "" })).toBe(true);
    expect(isSvgFile({ name: "a", type: "image/svg+xml" })).toBe(true);
    expect(isSvgFile({ name: "a.png", type: "image/png" })).toBe(false);
    expect(isSvgFile({ name: "svg.png", type: "" })).toBe(false);
  });
});

describe("importedNotice", () => {
  it("singolare, plurale e avvisi", () => {
    expect(importedNotice(1, [])).toBe("Importato come 1 livello");
    expect(importedNotice(7, [])).toBe("Importato come 7 livelli");
    expect(importedNotice(7, ["a"])).toBe("Importato come 7 livelli · 1 avviso: a");
    expect(importedNotice(7, ["a", "b (2×)"])).toBe("Importato come 7 livelli · 2 avvisi: a; b (2×)");
  });
});

describe("importSvgAt", () => {
  beforeEach(installScene);

  it("crea i nodi sotto la pagina, centrati sul punto, e seleziona la radice", async () => {
    const id = await importSvgAt(SVG, { x: 500, y: 300 }, {}, deps());
    expect(id).not.toBeNull();
    const ns = nodes();
    expect(ns.length).toBe(5); // radice, gruppo, rect, circle, path
    const root = ns.find((n) => n.id === id)!;
    expect(root).toMatchObject({ kind: "group", name: "Prova", parentId: "page1" });
    // 100x60 centrato su (500,300)
    expect(root.x).toBe(450);
    expect(root.y).toBe(270);
    expect(useScene.getState().selection).toEqual([id]);
    expect(ns.find((n) => n.name === "gruppo")).toBeTruthy();
  });

  it("è UN gesto: un annulla toglie tutto, un ripristina lo rimette", async () => {
    await importSvgAt(SVG, { x: 0, y: 0 }, {}, deps());
    expect(nodes().length).toBe(5);
    useScene.getState().undo();
    expect(nodes().length).toBe(0);
    useScene.getState().redo();
    expect(nodes().length).toBe(5);
    useScene.getState().undo();
    expect(nodes().length).toBe(0);
  });

  it("dice com'è andata: 'Importato come N livelli' più gli avvisi", async () => {
    await importSvgAt(SVG, { x: 0, y: 0 }, {}, deps());
    expect(useScene.getState().notice).toBe("Importato come 5 livelli");
    await importSvgAt(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="5" height="5" filter="url(#f)"/></svg>`, { x: 0, y: 0 }, {}, deps());
    expect(useScene.getState().notice).toBe("Importato come 2 livelli · 1 avviso: filtro non supportato: ignorato");
  });

  it("il nome del file è il nome di ripiego della radice", async () => {
    const id = await importSvgAt(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="5" height="5"/></svg>`, { x: 0, y: 0 }, { name: "logo" }, deps());
    expect(nodes().find((n) => n.id === id)!.name).toBe("logo");
  });

  it("un SVG non valido non cambia il documento e lo dice nel notice, senza lanciare", async () => {
    const id = await importSvgAt("<svg><rect></svg>", { x: 0, y: 0 }, {}, deps());
    expect(id).toBeNull();
    expect(nodes().length).toBe(0);
    expect(useScene.getState().notice).toMatch(/Importazione SVG non riuscita: il file non è un SVG valido/);
    expect(useScene.getState().lastError).toBeNull();
  });

  it("troppo grande o troppi nodi: errore chiaro, documento intatto", async () => {
    const many = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${"<rect width='1' height='1'/>".repeat(5100)}</svg>`;
    expect(await importSvgAt(many, { x: 0, y: 0 }, {}, deps())).toBeNull();
    expect(useScene.getState().notice).toMatch(/troppi elementi/);
    expect(nodes().length).toBe(0);
    const huge = `<svg xmlns="http://www.w3.org/2000/svg">${" ".repeat(6 * 1024 * 1024)}</svg>`;
    expect(await importSvgAt(huge, { x: 0, y: 0 }, {}, deps())).toBeNull();
    expect(useScene.getState().notice).toMatch(/supera 5 MB/);
  });

  it("a gesto aperto non fa niente (stessa guardia di incolla e rilascio)", async () => {
    useScene.getState().beginGesture();
    expect(await importSvgAt(SVG, { x: 0, y: 0 }, {}, deps())).toBeNull();
    expect(nodes().length).toBe(0);
    useScene.setState({ gesture: null });
  });

  it("senza documento aperto non fa niente", async () => {
    useScene.setState({ scene: null });
    expect(await importSvgAt(SVG, { x: 0, y: 0 }, {}, deps())).toBeNull();
  });

  it("il parent è la pagina corrente, non per forza la prima", async () => {
    const s = emptyScene("doc-1", "x");
    s.pages = [{ id: "page1", name: "A" }, { id: "page2", name: "B" }];
    useScene.getState().setScene(s);
    useScene.setState({ currentPageId: "page2" });
    const id = await importSvgAt(SVG, { x: 0, y: 0 }, {}, deps());
    expect(nodes().find((n) => n.id === id)!.parentId).toBe("page2");
  });

  it("la radice si accoda sopra ciò che c'è già (order key successiva)", async () => {
    await importSvgAt(SVG, { x: 0, y: 0 }, {}, deps());
    const first = nodes().find((n) => n.parentId === "page1")!;
    const id2 = await importSvgAt(SVG, { x: 200, y: 0 }, {}, deps());
    const second = nodes().find((n) => n.id === id2)!;
    expect(second.orderKey > first.orderKey).toBe(true);
  });

  it("immagini incorporate: si caricano PRIMA, e il nodo riceve l'hash", async () => {
    const upload = vi.fn(async (_d: string, _f: Blob) => ({ hash: HASH, size: 1, contentType: "image/png" }));
    const id = await importSvgAt(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40"><image id="foto" width="40" height="40" preserveAspectRatio="none" href="data:image/png;base64,${PNG}"/></svg>`,
      { x: 0, y: 0 }, {}, deps({ upload }),
    );
    expect(id).not.toBeNull();
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0][0]).toBe("doc-1");
    expect(upload.mock.calls[0][1].type).toBe("image/png");
    const img = nodes().find((n) => n.name === "foto")!;
    expect(img.image?.assetHash).toBe(HASH);
  });

  it("un upload fallito non annulla l'import: segnaposto e avviso", async () => {
    const id = await importSvgAt(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40"><rect id="r" width="5" height="5"/><image id="foto" width="40" height="40" href="data:image/png;base64,${PNG}"/></svg>`,
      { x: 0, y: 0 }, {}, deps({ upload: async () => { throw new Error("rete"); } }),
    );
    expect(id).not.toBeNull();
    expect(nodes().find((n) => n.name === "foto")!.image?.assetHash).toBe("");
    expect(useScene.getState().notice).toMatch(/1 immagine non caricata/);
  });

  it("se durante gli upload il documento cambia, non applica niente", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const p = importSvgAt(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40"><image width="40" height="40" href="data:image/png;base64,${PNG}"/></svg>`,
      { x: 0, y: 0 }, {}, deps({ upload: async () => { await gate; return { hash: HASH, size: 1, contentType: "image/png" }; } }),
    );
    useScene.getState().setScene(emptyScene("doc-2", "Altro"));
    release();
    expect(await p).toBeNull();
    expect(nodes().length).toBe(0);
  });
});

describe("importSvgFile / pickSvgFile", () => {
  beforeEach(installScene);

  it("legge il file e importa, col nome senza estensione", async () => {
    const file = new File([SVG.replace("<title>Prova</title>", "")], "mio-logo.svg", { type: "image/svg+xml" });
    const id = await importSvgFile(file, { x: 0, y: 0 }, deps());
    expect(nodes().find((n) => n.id === id)!.name).toBe("mio-logo");
  });

  it("un file illeggibile finisce nel notice", async () => {
    const bad = { name: "x.svg", type: "image/svg+xml", text: () => Promise.reject(new Error("boom")) } as unknown as File;
    expect(await importSvgFile(bad, { x: 0, y: 0 }, deps())).toBeNull();
    expect(useScene.getState().notice).toMatch(/non è leggibile/);
  });

  it("pickSvgFile importa al centro della vista; se si annulla non fa niente", async () => {
    useScene.setState({ camera: { x: -100, y: -50, zoom: 2 } });
    const file = new File([SVG], "a.svg", { type: "image/svg+xml" });
    const id = await pickSvgFile(async () => file, deps());
    expect(id).not.toBeNull();
    // senza canvas nel DOM il centro ripiega su 800x600 di schermo -> mondo (450, 325)
    const root = nodes().find((n) => n.id === id)!;
    const c = viewportCenter();
    expect(root.x + 50).toBeCloseTo(c.x, 3);
    expect(root.y + 30).toBeCloseTo(c.y, 3);
    expect(c).toEqual({ x: (400 + 100) / 2, y: (300 + 50) / 2 });
    const before = nodes().length;
    expect(await pickSvgFile(async () => null, deps())).toBeNull();
    expect(nodes().length).toBe(before);
  });
});
