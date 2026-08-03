import { describe, it, expect } from "vitest";
import { emptyScene, type NodeLite, type SceneState } from "./types";
import {
  contentWorldBounds,
  enterTargetOf,
  frameOriginOf,
  isGroup,
  selectionTargetOf,
  transformTargetsOf,
} from "./groups";

function node(id: string, parentId: string, x: number, y: number, extra: Partial<NodeLite> = {}): NodeLite {
  return {
    id, parentId, orderKey: "a000000", name: id, visible: true, opacity: 1,
    x, y, width: 50, height: 50, rotation: 0, fills: [], kind: "rect", cornerRadius: 0, ...extra,
  };
}

// Un gruppo NASCE a (0,0) e senza dimensioni proprie: i suoi bounds sono
// l'unione dei figli, e la sua x/y è la traslazione che contribuisce loro.
function group(id: string, parentId: string, extra: Partial<NodeLite> = {}): NodeLite {
  return node(id, parentId, 0, 0, { kind: "group", width: 0, height: 0, ...extra });
}

function scene(nodes: NodeLite[]): SceneState {
  const s = emptyScene("doc1", "Untitled");
  for (const n of nodes) s.nodes[n.id] = n;
  return s;
}

//   page1
//   ├── g  (gruppo, nessuna geometria propria)
//   │   ├── r1 (10,10 50x50)   -> mondo (10,10)-(60,60)
//   │   └── r2 (100,0 20x20)   -> mondo (100,0)-(120,20)
//   └── solo (200,200 10x10)
function grouped(): SceneState {
  return scene([
    group("g", "page1", { orderKey: "a000001" }),
    node("r1", "g", 10, 10, { orderKey: "a000001" }),
    node("r2", "g", 100, 0, { orderKey: "a000002", width: 20, height: 20 }),
    node("solo", "page1", 200, 200, { orderKey: "a000002", width: 10, height: 10 }),
  ]);
}

describe("isGroup", () => {
  it("is true only for a node whose shape is a group", () => {
    const s = grouped();
    expect(isGroup(s.nodes["g"])).toBe(true);
    expect(isGroup(s.nodes["r1"])).toBe(false);
    expect(isGroup(undefined)).toBe(false);
  });
});

describe("contentWorldBounds", () => {
  it("is the node's own world box for anything that is not a group", () => {
    const s = grouped();
    expect(contentWorldBounds(s, s.nodes["solo"])).toEqual({ x: 200, y: 200, width: 10, height: 10 });
  });

  it("is the UNION of the children for a group, not its own (empty) box", () => {
    const s = grouped();
    expect(contentWorldBounds(s, s.nodes["g"])).toEqual({ x: 10, y: 0, width: 110, height: 60 });
  });

  it("follows the group when the group is moved: the children move with it", () => {
    const s = grouped();
    s.nodes["g"] = { ...s.nodes["g"], x: 5, y: 7 };
    expect(contentWorldBounds(s, s.nodes["g"])).toEqual({ x: 15, y: 7, width: 110, height: 60 });
  });

  it("descends through nested groups", () => {
    const s = scene([
      group("g1", "page1"),
      group("g2", "g1", { x: 100, y: 100 }),
      node("r", "g2", 5, 5, { width: 10, height: 10 }),
    ]);
    expect(contentWorldBounds(s, s.nodes["g1"])).toEqual({ x: 105, y: 105, width: 10, height: 10 });
  });

  it("is null for an empty group: there is nothing to frame", () => {
    const s = scene([group("g", "page1")]);
    expect(contentWorldBounds(s, s.nodes["g"])).toBeNull();
  });
});

// L'ANGOLO ALTO-SINISTRA DELLA CORNICE, nello spazio del PARENT: è ciò che il
// pannello proprietà chiama X/Y. Per ogni nodo che non è un gruppo coincide con
// le sue coordinate; per un gruppo NO -- x/y di un gruppo sono la traslazione
// che contribuisce ai figli, non il punto in cui la cornice si vede.
describe("frameOriginOf", () => {
  it("is the node's own x/y for anything that is not a group", () => {
    const s = grouped();
    expect(frameOriginOf(s, s.nodes["solo"])).toEqual({ x: 200, y: 200 });
    // Anche per un figlio DENTRO un gruppo: le sue x/y sono già scritte nello
    // spazio del parent, che è lo spazio in cui questa funzione risponde.
    expect(frameOriginOf(s, s.nodes["r1"])).toEqual({ x: 10, y: 10 });
  });

  it("is the top-left of the CONTENT for a group, not its (0,0) translation", () => {
    const s = grouped();
    expect(s.nodes["g"].x).toBe(0);
    expect(s.nodes["g"].y).toBe(0);
    expect(frameOriginOf(s, s.nodes["g"])).toEqual({ x: 10, y: 0 });
  });

  it("moves with the group", () => {
    const s = grouped();
    s.nodes["g"] = { ...s.nodes["g"], x: 5, y: 7 };
    expect(frameOriginOf(s, s.nodes["g"])).toEqual({ x: 15, y: 7 });
  });

  it("is expressed in the PARENT's space for a nested group, not in world", () => {
    const s = scene([
      group("g1", "page1", { x: 1000, y: 0 }),
      group("g2", "g1", { x: 100, y: 100 }),
      node("r", "g2", 5, 5, { width: 10, height: 10 }),
    ]);
    expect(contentWorldBounds(s, s.nodes["g2"])).toEqual({ x: 1105, y: 105, width: 10, height: 10 });
    // Lo spazio di g1 è quello in cui x/y di g2 sono scritte: 1105 - 1000.
    expect(frameOriginOf(s, s.nodes["g2"])).toEqual({ x: 105, y: 105 });
  });

  it("falls back to the group's own x/y when the group is empty: there is no frame", () => {
    const s = scene([group("g", "page1", { x: 3, y: 4 })]);
    expect(frameOriginOf(s, s.nodes["g"])).toEqual({ x: 3, y: 4 });
  });
});

// LA CONVENZIONE DI SELEZIONE, quella che l'utente nota per prima:
// un click seleziona il gruppo PIÙ ESTERNO, un doppio click entra e seleziona
// il figlio.
describe("selectionTargetOf", () => {
  it("a click on a child of a group selects the group", () => {
    const s = grouped();
    expect(selectionTargetOf(s, "r1", [])).toBe("g");
  });

  it("a click on a node outside any group selects that node", () => {
    const s = grouped();
    expect(selectionTargetOf(s, "solo", [])).toBe("solo");
  });

  it("selects the OUTERMOST group when groups are nested", () => {
    const s = scene([group("g1", "page1"), group("g2", "g1"), node("r", "g2", 0, 0)]);
    expect(selectionTargetOf(s, "r", [])).toBe("g1");
  });

  // "Essere dentro" un gruppo non è uno stato a parte: lo dice la SELEZIONE
  // corrente. Se un figlio del gruppo è selezionato, siamo dentro quel gruppo.
  it("once inside a group, a click on a sibling selects the sibling, not the group again", () => {
    const s = grouped();
    expect(selectionTargetOf(s, "r2", ["r1"])).toBe("r2");
  });

  it("inside a nested group, the click stops at the level of the entered group", () => {
    const s = scene([group("g1", "page1"), group("g2", "g1"), node("r", "g2", 0, 0)]);
    // Selezionato g2 => siamo dentro g1 (ma non dentro g2).
    expect(selectionTargetOf(s, "r", ["g2"])).toBe("g2");
    // Selezionato r => siamo dentro g2 anche.
    expect(selectionTargetOf(s, "r", ["r"])).toBe("r");
  });

  it("clicking outside the entered group leaves it: the outermost group wins again", () => {
    const s = scene([
      group("g1", "page1"),
      node("inside", "g1", 0, 0),
      group("g2", "page1"),
      node("other", "g2", 0, 0),
    ]);
    expect(selectionTargetOf(s, "other", ["inside"])).toBe("g2");
  });

  // Un contenitore che NON è un gruppo (un rettangolo con figli, e domani un
  // frame) non cattura il click: i suoi figli si selezionano direttamente.
  it("a non-group container does not capture the click", () => {
    const s = scene([node("box", "page1", 0, 0), node("child", "box", 0, 0)]);
    expect(selectionTargetOf(s, "child", [])).toBe("child");
  });

  it("still finds the group when it is nested under a non-group container", () => {
    const s = scene([node("box", "page1", 0, 0), group("g", "box"), node("r", "g", 0, 0)]);
    expect(selectionTargetOf(s, "r", [])).toBe("g");
  });

  it("returns the id untouched when it is not in the scene", () => {
    expect(selectionTargetOf(grouped(), "sparito", [])).toBe("sparito");
  });
});

describe("enterTargetOf", () => {
  it("a double click on a child of a group selects the child", () => {
    const s = grouped();
    expect(enterTargetOf(s, "r1", [])).toBe("r1");
  });

  it("enters ONE level at a time when groups are nested", () => {
    const s = scene([group("g1", "page1"), group("g2", "g1"), node("r", "g2", 0, 0)]);
    expect(enterTargetOf(s, "r", [])).toBe("g2");
    expect(enterTargetOf(s, "r", ["g2"])).toBe("r");
  });

  // Niente da entrare = il doppio click resta libero per il suo altro
  // significato (l'editing di un nodo testo, vedi selectTool).
  it("is null when the click already resolves to the node itself", () => {
    const s = grouped();
    expect(enterTargetOf(s, "r1", ["r1"])).toBeNull();
    expect(enterTargetOf(s, "solo", [])).toBeNull();
  });
});

describe("transformTargetsOf", () => {
  it("expands a group into its children: a group has no box of its own to rewrite", () => {
    expect(transformTargetsOf(grouped(), ["g"])).toEqual(["r1", "r2"]);
  });

  it("descends through nested groups down to the leaves", () => {
    const s = scene([group("g1", "page1"), group("g2", "g1"), node("r", "g2", 0, 0)]);
    expect(transformTargetsOf(s, ["g1"])).toEqual(["r"]);
  });

  it("leaves anything that is not a group alone, container or not", () => {
    const s = scene([node("box", "page1", 0, 0), node("child", "box", 0, 0)]);
    expect(transformTargetsOf(s, ["box"])).toEqual(["box"]);
  });

  it("drops an empty group: there is nothing to transform", () => {
    const s = scene([group("g", "page1"), node("solo", "page1", 0, 0)]);
    expect(transformTargetsOf(s, ["g", "solo"])).toEqual(["solo"]);
  });

  it("keeps an unknown id (it is not this function's job to validate)", () => {
    expect(transformTargetsOf(grouped(), ["sparito"])).toEqual(["sparito"]);
  });
});
