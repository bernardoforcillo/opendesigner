import { describe, it, expect } from "vitest";
import { emptyScene, type NodeLite, type SceneState } from "./types";
import { childrenOf, documentOrder, subtreeOf, descendantsOf, ancestorsOf, isAncestorOf, isReachableFrom, topmostOf } from "./tree";

function node(id: string, parentId: string, orderKey: string): NodeLite {
  return {
    id, parentId, orderKey, name: id, visible: true, opacity: 1,
    x: 0, y: 0, width: 10, height: 10, rotation: 0,
    fills: [], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false,
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
  ]) s.nodes = s.nodes.set(n.id, n);
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
    ]) s.nodes = s.nodes.set(n.id, n);
    expect(ids(childrenOf(s, "g1"))).toEqual(["a", "m", "z"]);
    // Solo i DIRETTI: g1 è figlio della pagina, i suoi figli no.
    expect(ids(childrenOf(s, "page1"))).toEqual(["g1"]);
  });

  it("a parità di orderKey ordina per id (l'ordine di Object.values non è definito)", () => {
    const s = emptyScene("doc1", "Untitled");
    for (const n of [node("b", "page1", "a1"), node("a", "page1", "a1")]) s.nodes = s.nodes.set(n.id, n);
    expect(ids(childrenOf(s, "page1"))).toEqual(["a", "b"]);
  });

  it("lista vuota per un parent senza figli o inesistente", () => {
    expect(childrenOf(tree(), "d1")).toEqual([]);
    expect(childrenOf(tree(), "ghost")).toEqual([]);
  });
});

describe("documentOrder", () => {
  it("ritorna TUTTO il documento in ordine di disegno: container prima dei figli", () => {
    expect(ids(documentOrder(tree()))).toEqual(["g1", "c1", "d1", "c2", "other"]);
  });

  it("salta i nodi non raggiungibili da una pagina", () => {
    const s = tree();
    s.nodes = s.nodes.set("orfano", node("orfano", "sparito", "a0"));
    expect(ids(documentOrder(s))).not.toContain("orfano");
  });

  it("termina su un documento con un ciclo", () => {
    const s = emptyScene("doc1", "Untitled");
    s.nodes = s.nodes.set("a", node("a", "b", "a1"));
    s.nodes = s.nodes.set("b", node("b", "a", "a1"));
    // Nessuno dei due pende da una pagina: il ciclo non è nemmeno raggiungibile.
    expect(documentOrder(s)).toEqual([]);
  });

  // È la ragione per cui esiste: fra due parent diversi le order key non sono
  // confrontabili, e il raggruppamento deve sapere qual è il nodo più in alto.
  it("l'albero domina un confronto piatto di order key", () => {
    const s = emptyScene("doc1", "Untitled");
    for (const n of [
      node("sotto", "page1", "a1"),
      node("figlioSotto", "sotto", "z9"), // order key altissima, ma dentro "sotto"
      node("sopra", "page1", "a2"),
    ]) s.nodes = s.nodes.set(n.id, n);
    expect(ids(documentOrder(s))).toEqual(["sotto", "figlioSotto", "sopra"]);
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

describe("topmostOf", () => {
  it("toglie gli id che hanno un ANTENATO nella selezione, a qualunque profondità", () => {
    const s = tree();
    // g1 porta via c1, d1 e c2 con la cascata: resta un op solo, più "other".
    expect(topmostOf(s, ["g1", "c1", "d1", "c2", "other"])).toEqual(["g1", "other"]);
    // Anche quando l'antenato è selezionato DOPO il discendente: la potatura
    // guarda l'insieme, non l'ordine di selezione.
    expect(topmostOf(s, ["d1", "g1"])).toEqual(["g1"]);
    // Un antenato intermedio basta: c1 copre d1 anche senza g1.
    expect(topmostOf(s, ["c1", "d1"])).toEqual(["c1"]);
  });

  it("lascia intatta una selezione di soli fratelli o cugini, nell'ordine dato", () => {
    const s = tree();
    expect(topmostOf(s, ["c2", "c1"])).toEqual(["c2", "c1"]);
    expect(topmostOf(s, ["d1", "other"])).toEqual(["d1", "other"]);
    expect(topmostOf(s, [])).toEqual([]);
  });

  it("toglie i duplicati e tiene gli id sconosciuti (non è lui a validarli)", () => {
    const s = tree();
    expect(topmostOf(s, ["g1", "g1"])).toEqual(["g1"]);
    expect(topmostOf(s, ["ghost", "g1"])).toEqual(["ghost", "g1"]);
  });

  it("un ciclo in un documento malformato non manda in loop la potatura", () => {
    const s = emptyScene("doc1", "Untitled");
    s.nodes = s.nodes.set("a", node("a", "b", "a1"));
    s.nodes = s.nodes.set("b", node("b", "a", "a1"));
    // Ognuno dei due è antenato dell'altro: la risalita si ferma comunque, e
    // il risultato è vuoto invece che un ciclo infinito.
    expect(topmostOf(s, ["a", "b"])).toEqual([]);
  });
});

// Un documento con un ciclo non è producibile da applyOp (né da core.Apply), ma
// può arrivare da un op-log scritto prima di queste invarianti: l'attraversamento
// deve terminare comunque, non andare in loop infinito.
describe("documento malformato", () => {
  it("un ciclo non manda in loop la discesa né la risalita", () => {
    const s = emptyScene("doc1", "Untitled");
    s.nodes = s.nodes.set("a", node("a", "b", "a1"));
    s.nodes = s.nodes.set("b", node("b", "a", "a1"));
    expect(ids(subtreeOf(s, "a")).sort()).toEqual(["a", "b"]);
    // La risalita si ferma al primo nodo già visto: "a" non torna in fondo alla
    // propria catena di antenati.
    expect(ids(ancestorsOf(s, "a"))).toEqual(["b"]);
    expect(isAncestorOf(s, "a", "b")).toBe(true);
  });
});

// Raggiungibilità da una pagina: stesso criterio con cui rootsOf decide se
// disegnare un nodo, quindi ciò che tiene la selezione scoping-per-pagina in
// accordo col canvas (store.ts::pruneSelectionToPage).
describe("isReachableFrom", () => {
  // Come tree() ma con una seconda pagina e un nodo che le pende sotto:
  //   page1 ── g1 ── c1 ── d1 ; g1 ── c2 ; page1 ── other
  //   page2 ── far
  function twoPages(): SceneState {
    const s = tree();
    s.pages.push({ id: "page2", name: "Page 2" });
    s.nodes = s.nodes.set("far", node("far", "page2", "a1"));
    return s;
  }

  it("è vero per un figlio DIRETTO della pagina", () => {
    expect(isReachableFrom(twoPages(), "g1", "page1")).toBe(true);
    expect(isReachableFrom(twoPages(), "far", "page2")).toBe(true);
  });

  it("è vero per un discendente PROFONDO (risale g1>c1>d1 fino a page1)", () => {
    expect(isReachableFrom(twoPages(), "d1", "page1")).toBe(true);
  });

  it("è falso per un nodo che pende da un'ALTRA pagina", () => {
    expect(isReachableFrom(twoPages(), "d1", "page2")).toBe(false);
    expect(isReachableFrom(twoPages(), "far", "page1")).toBe(false);
  });

  it("è falso per un id inesistente (sussume l'esistenza)", () => {
    expect(isReachableFrom(twoPages(), "ghost", "page1")).toBe(false);
  });

  it("non manda in loop su un ciclo staccato da ogni pagina", () => {
    const s = emptyScene("doc1", "Untitled");
    s.nodes = s.nodes.set("a", node("a", "b", "a1"));
    s.nodes = s.nodes.set("b", node("b", "a", "a1"));
    expect(isReachableFrom(s, "a", "page1")).toBe(false);
  });
});
