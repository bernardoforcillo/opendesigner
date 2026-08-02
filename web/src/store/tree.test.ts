import { describe, it, expect } from "vitest";
import { emptyScene, type NodeLite, type SceneState } from "./types";
import { childrenOf, subtreeOf, descendantsOf, ancestorsOf, isAncestorOf } from "./tree";

function node(id: string, parentId: string, orderKey: string): NodeLite {
  return {
    id, parentId, orderKey, name: id, visible: true, opacity: 1,
    x: 0, y: 0, width: 10, height: 10, rotation: 0,
    fills: [], kind: "rect", cornerRadius: 0,
  };
}

// Lo stesso albero di internal/core/tree_test.go::treeDoc, per poter confrontare
// le due implementazioni a occhio oltre che con le fixture golden:
//
//   page1
//   ├── g1
//   │   ├── c1
//   │   │   └── d1
//   │   └── c2
//   └── other
function tree(): SceneState {
  const s = emptyScene("doc1", "Untitled");
  for (const n of [
    node("g1", "page1", "a1"),
    node("c1", "g1", "a1"),
    node("d1", "c1", "a1"),
    node("c2", "g1", "a2"),
    node("other", "page1", "a2"),
  ]) s.nodes[n.id] = n;
  return s;
}

const ids = (nodes: readonly NodeLite[]) => nodes.map((n) => n.id);

describe("childrenOf", () => {
  it("ritorna i figli DIRETTI ordinati per orderKey", () => {
    const s = emptyScene("doc1", "Untitled");
    for (const n of [
      node("g1", "page1", "a1"),
      node("z", "g1", "a3"),
      node("a", "g1", "a1"),
      node("m", "g1", "a2"),
    ]) s.nodes[n.id] = n;
    expect(ids(childrenOf(s, "g1"))).toEqual(["a", "m", "z"]);
    // Solo i DIRETTI: g1 è figlio della pagina, i suoi figli no.
    expect(ids(childrenOf(s, "page1"))).toEqual(["g1"]);
  });

  it("a parità di orderKey ordina per id (l'ordine di Object.values non è definito)", () => {
    const s = emptyScene("doc1", "Untitled");
    for (const n of [node("b", "page1", "a1"), node("a", "page1", "a1")]) s.nodes[n.id] = n;
    expect(ids(childrenOf(s, "page1"))).toEqual(["a", "b"]);
  });

  it("lista vuota per un parent senza figli o inesistente", () => {
    expect(childrenOf(tree(), "d1")).toEqual([]);
    expect(childrenOf(tree(), "ghost")).toEqual([]);
  });
});

describe("subtreeOf / descendantsOf", () => {
  it("visita in profondità, parent PRIMA dei figli", () => {
    expect(ids(subtreeOf(tree(), "g1"))).toEqual(["g1", "c1", "d1", "c2"]);
    expect(ids(descendantsOf(tree(), "g1"))).toEqual(["c1", "d1", "c2"]);
  });

  it("un nodo foglia è il suo solo sottoalbero", () => {
    expect(ids(subtreeOf(tree(), "d1"))).toEqual(["d1"]);
    expect(descendantsOf(tree(), "d1")).toEqual([]);
  });

  it("vuoto per un id inesistente", () => {
    expect(subtreeOf(tree(), "ghost")).toEqual([]);
  });

  // LA proprietà che serve all'undo di una delete a cascata: ricreare i nodi in
  // quest'ordine soddisfa "il parent esiste" a ogni passo.
  it("ogni nodo compare dopo il proprio parent", () => {
    const seen = new Set<string>(["page1"]);
    const sub = subtreeOf(tree(), "g1");
    seen.add(sub[0].parentId);
    for (const n of sub) {
      expect(seen.has(n.parentId)).toBe(true);
      seen.add(n.id);
    }
  });
});

describe("ancestorsOf / isAncestorOf", () => {
  it("risale la catena, dal più vicino al più lontano", () => {
    expect(ids(ancestorsOf(tree(), "d1"))).toEqual(["c1", "g1"]);
    expect(ancestorsOf(tree(), "g1")).toEqual([]); // il parent è una pagina, non un nodo
  });

  it("isAncestorOf è STRETTA e conosce la profondità arbitraria", () => {
    const s = tree();
    expect(isAncestorOf(s, "g1", "d1")).toBe(true);
    expect(isAncestorOf(s, "c1", "d1")).toBe(true);
    expect(isAncestorOf(s, "d1", "g1")).toBe(false);
    expect(isAncestorOf(s, "other", "d1")).toBe(false);
    expect(isAncestorOf(s, "g1", "g1")).toBe(false);
  });
});

// Un documento con un ciclo non è producibile da applyOp (né da core.Apply), ma
// può arrivare da un op-log scritto prima di queste invarianti: l'attraversamento
// deve terminare comunque, non andare in loop infinito.
describe("documento malformato", () => {
  it("un ciclo non manda in loop la discesa né la risalita", () => {
    const s = emptyScene("doc1", "Untitled");
    s.nodes["a"] = node("a", "b", "a1");
    s.nodes["b"] = node("b", "a", "a1");
    expect(ids(subtreeOf(s, "a")).sort()).toEqual(["a", "b"]);
    // La risalita si ferma al primo nodo già visto: "a" non torna in fondo alla
    // propria catena di antenati.
    expect(ids(ancestorsOf(s, "a"))).toEqual(["b"]);
    expect(isAncestorOf(s, "a", "b")).toBe(true);
  });
});
