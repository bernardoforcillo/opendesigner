import { describe, it, expect } from "vitest";
import { connectSource, isPageRoot, isScreenNode, screenName, screenOf, topLevelScreens } from "./screens";
import { baseScene, child, frame } from "./testSupport";
import { nodesOf } from "../store/nodeMap";

describe("screenOf", () => {
  const s = baseScene();

  it("un frame di primo livello è la propria schermata", () => {
    expect(screenOf(s, "A")?.id).toBe("A");
  });

  it("un elemento dentro il frame risale alla sua schermata", () => {
    expect(screenOf(s, "btn")?.id).toBe("A");
  });

  it("annidamento profondo: risale fino al figlio della pagina", () => {
    const deep = {
      ...s,
      nodes: nodesOf({
        A: frame("A", 0),
        inner: frame("inner", 0, 0, { parentId: "A" }),
        leaf: child("leaf", "inner", 0, 0),
      }),
    };
    expect(screenOf(deep, "leaf")?.id).toBe("A");
  });

  it("id inesistente o ciclo malformato: null (nessun loop infinito)", () => {
    expect(screenOf(s, "ghost")).toBeNull();
    const cyc = { ...s, nodes: nodesOf({ a: child("a", "b", 0, 0), b: child("b", "a", 0, 0) }) };
    expect(screenOf(cyc, "a")).toBeNull();
  });

  it("isPageRoot: solo i figli diretti di una pagina", () => {
    expect(isPageRoot(s, s.nodes.at("A"))).toBe(true);
    expect(isPageRoot(s, s.nodes.at("btn"))).toBe(false);
  });
});

describe("topLevelScreens", () => {
  it("elenca i frame di primo livello della pagina, non i rettangoli sciolti né i figli", () => {
    const ids = topLevelScreens(baseScene(), "page1").map((n) => n.id);
    expect(ids.sort()).toEqual(["A", "B", "C"]);
  });

  it("senza pagina corrente ripiega sulla prima", () => {
    expect(topLevelScreens(baseScene(), null)).toHaveLength(3);
  });

  it("isScreenNode: solo i frame", () => {
    expect(isScreenNode(baseScene().nodes.at("A"))).toBe(true);
    expect(isScreenNode(baseScene().nodes.at("loose"))).toBe(false);
    expect(isScreenNode(null)).toBe(false);
  });
});

describe("connectSource", () => {
  const s = baseScene();

  it("partire da un frame: nessun hotspot", () => {
    expect(connectSource(s, "A")).toEqual({ screenId: "A", elementId: "" });
  });

  it("partire da un elemento: diventa l'hotspot, fromId è la sua schermata", () => {
    expect(connectSource(s, "btn")).toEqual({ screenId: "A", elementId: "btn" });
  });

  it("un rettangolo sciolto (non dentro una schermata) non è un punto di partenza", () => {
    expect(connectSource(s, "loose")).toBeNull();
    expect(connectSource(s, "ghost")).toBeNull();
  });
});

describe("screenName", () => {
  it("nome, ripiego per il vuoto, ripiego per l'eliminata", () => {
    const s = baseScene();
    expect(screenName(s, "A")).toBe("A");
    expect(screenName({ ...s, nodes: s.nodes.set("A", { ...s.nodes.at("A"), name: "  " }) }, "A")).toBe("Senza nome");
    expect(screenName(s, "ghost")).toBe("(schermata eliminata)");
  });
});
