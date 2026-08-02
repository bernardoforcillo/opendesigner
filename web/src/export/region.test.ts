import { describe, it, expect } from "vitest";
import { exportRegion } from "./region";
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

function sceneWith(...nodes: NodeLite[]): SceneState {
  const s = emptyScene("doc", "Untitled");
  for (const n of nodes) s.nodes[n.id] = n;
  return s;
}

describe("exportRegion", () => {
  it("l'intera pagina: tutti i nodi visibili, in ordine di disegno", () => {
    const s = sceneWith(
      node({ id: "sopra", orderKey: "a2", x: 100, y: 100 }),
      node({ id: "sotto", orderKey: "a1", x: 0, y: 0 }),
    );
    const r = exportRegion(s, [], "page");
    expect(r).not.toBeNull();
    expect(r!.nodes.map((n) => n.id)).toEqual(["sotto", "sopra"]);
    expect(r!.bounds).toEqual({ x: 0, y: 0, width: 110, height: 110 });
  });

  it("la selezione: solo i nodi selezionati, con i LORO bounds", () => {
    const s = sceneWith(
      node({ id: "a", x: 0, y: 0 }),
      node({ id: "b", x: 100, y: 200, orderKey: "a2" }),
    );
    const r = exportRegion(s, ["b"], "selection");
    expect(r!.nodes.map((n) => n.id)).toEqual(["b"]);
    // I bounds sono quelli di CIÒ CHE È STATO ESPORTATO, non della pagina.
    expect(r!.bounds).toEqual({ x: 100, y: 200, width: 10, height: 10 });
  });

  it("la selezione resta in ordine di DISEGNO, non nell'ordine in cui è stata cliccata", () => {
    const s = sceneWith(
      node({ id: "sotto", orderKey: "a1" }),
      node({ id: "sopra", orderKey: "a2" }),
    );
    const r = exportRegion(s, ["sopra", "sotto"], "selection");
    expect(r!.nodes.map((n) => n.id)).toEqual(["sotto", "sopra"]);
  });

  it("ignora gli id selezionati che non esistono più nella scena", () => {
    const s = sceneWith(node({ id: "a" }));
    expect(exportRegion(s, ["a", "sparito"], "selection")!.nodes.map((n) => n.id)).toEqual(["a"]);
  });

  it("un nodo INVISIBILE non viene esportato e non allarga la regione", () => {
    const s = sceneWith(
      node({ id: "visibile", x: 0, y: 0 }),
      node({ id: "nascosto", x: 1000, y: 1000, visible: false }),
    );
    const r = exportRegion(s, [], "page");
    expect(r!.nodes.map((n) => n.id)).toEqual(["visibile"]);
    expect(r!.bounds).toEqual({ x: 0, y: 0, width: 10, height: 10 });
  });

  it("una forma DEGENERE non allarga la regione: il renderer non la disegna", () => {
    // Un rettangolo 0x0 lontanissimo: drawScene lo salta (isPaintable), quindi
    // includerlo nell'unione produrrebbe un'immagine enorme e quasi vuota,
    // con il contenuto vero schiacciato in un angolo.
    const s = sceneWith(
      node({ id: "vero", x: 0, y: 0, width: 20, height: 20 }),
      node({ id: "degenere", x: 5000, y: 5000, width: 0, height: 0 }),
    );
    const r = exportRegion(s, [], "page");
    expect(r!.nodes.map((n) => n.id)).toEqual(["vero"]);
    expect(r!.bounds).toEqual({ x: 0, y: 0, width: 20, height: 20 });
  });

  it("un TESTO senza altezza misurata resta esportabile (stessa eccezione del renderer)", () => {
    const s = sceneWith(
      node({
        id: "t", kind: "text", width: 100, height: 0,
        text: { content: "ciao", style: { fontFamily: "", fontSize: 16, fontWeight: "", lineHeight: 0, align: "left" } },
      }),
    );
    expect(exportRegion(s, [], "page")!.nodes.map((n) => n.id)).toEqual(["t"]);
  });

  it("null quando non c'è niente da esportare", () => {
    expect(exportRegion(emptyScene("doc", "Untitled"), [], "page")).toBeNull();
    expect(exportRegion(sceneWith(node({ id: "a" })), [], "selection")).toBeNull();
    expect(exportRegion(sceneWith(node({ id: "a", visible: false })), [], "page")).toBeNull();
  });

  it("la scena ridotta contiene ESATTAMENTE i nodi esportati", () => {
    // È la scena che finisce in drawScene: se ci restasse dentro un nodo non
    // selezionato, l'export della selezione disegnerebbe anche quello.
    const s = sceneWith(node({ id: "a" }), node({ id: "b", orderKey: "a2" }));
    const r = exportRegion(s, ["b"], "selection");
    expect(Object.keys(r!.scene.nodes)).toEqual(["b"]);
    // il resto dell'identità del documento resta quella vera
    expect(r!.scene.id).toBe("doc");
    expect(r!.scene.pages).toEqual(s.pages);
  });
});
