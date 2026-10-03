import { describe, it, expect } from "vitest";
import { emptyScene, type NodeLite, type SceneState } from "./types";
import {
  contentWorldBounds,
  enterTargetOf,
  frameOriginOf,
  isGroup,
  selectionTargetOf,
  selectionTargetsOf,
  transformTargetsOf,
} from "./groups";

function node(id: string, parentId: string, x: number, y: number, extra: Partial<NodeLite> = {}): NodeLite {
  return {
    id, parentId, orderKey: "a000000", name: id, visible: true, opacity: 1,
    x, y, width: 50, height: 50, rotation: 0, fills: [], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false, ...extra,
  };
}

// Un gruppo NASCE a (0,0) e senza dimensioni proprie: i suoi bounds sono
// l'unione dei figli, e la sua x/y è la traslazione che contribuisce loro.
function group(id: string, parentId: string, extra: Partial<NodeLite> = {}): NodeLite {
  return node(id, parentId, 0, 0, { kind: "group", width: 0, height: 0, ...extra });
}

// Un FRAME, invece, ha geometria PROPRIA: il suo box (x/y/width/height) è suo,
// non l'unione dei figli, e -- a differenza del gruppo -- NON cattura il click
// dei figli (convenzione artboard). `clipsContent` di default true.
function frame(id: string, parentId: string, x: number, y: number, extra: Partial<NodeLite> = {}): NodeLite {
  return node(id, parentId, x, y, { kind: "frame", clipsContent: true, ...extra });
}

function scene(nodes: NodeLite[]): SceneState {
  const s = emptyScene("doc1", "Untitled");
  for (const n of nodes) s.nodes = s.nodes.set(n.id, n);
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
    expect(isGroup(s.nodes.at("g"))).toBe(true);
    expect(isGroup(s.nodes.at("r1"))).toBe(false);
    expect(isGroup(undefined)).toBe(false);
  });
});

describe("contentWorldBounds", () => {
  it("is the node's own world box for anything that is not a group", () => {
    const s = grouped();
    expect(contentWorldBounds(s, s.nodes.at("solo"))).toEqual({ x: 200, y: 200, width: 10, height: 10 });
  });

  it("is the UNION of the children for a group, not its own (empty) box", () => {
    const s = grouped();
    expect(contentWorldBounds(s, s.nodes.at("g"))).toEqual({ x: 10, y: 0, width: 110, height: 60 });
  });

  it("follows the group when the group is moved: the children move with it", () => {
    const s = grouped();
    s.nodes = s.nodes.set("g", { ...s.nodes.at("g"), x: 5, y: 7 });
    expect(contentWorldBounds(s, s.nodes.at("g"))).toEqual({ x: 15, y: 7, width: 110, height: 60 });
  });

  it("descends through nested groups", () => {
    const s = scene([
      group("g1", "page1"),
      group("g2", "g1", { x: 100, y: 100 }),
      node("r", "g2", 5, 5, { width: 10, height: 10 }),
    ]);
    expect(contentWorldBounds(s, s.nodes.at("g1"))).toEqual({ x: 105, y: 105, width: 10, height: 10 });
  });

  it("is null for an empty group: there is nothing to frame", () => {
    const s = scene([group("g", "page1")]);
    expect(contentWorldBounds(s, s.nodes.at("g"))).toBeNull();
  });

  // VEDI-vs-SELEZIONA, dal lato della cornice. Il renderer salta un nodo
  // invisibile e con lui tutto il suo sottoalbero (canvasRenderer.ts:
  // drawSiblings, pickIn, collectIn fanno `continue` su !visible PRIMA di
  // scendere). Se l'unione dei figli non facesse lo stesso, la cornice di un
  // gruppo -- e le sue 8 maniglie, e la X del pannello -- misurerebbero una
  // geometria che non si disegna: rettangolo su canvas vuoto.
  it("skips an INVISIBLE child: the frame measures only what is drawn", () => {
    const s = grouped();
    s.nodes = s.nodes.set("r1", { ...s.nodes.at("r1"), visible: false });
    // Solo r2: (100,0)-(120,20). Con r1 dentro sarebbe {10,0,110,60}.
    expect(contentWorldBounds(s, s.nodes.at("g"))).toEqual({ x: 100, y: 0, width: 20, height: 20 });

    // E simmetricamente dall'altro lato.
    const s2 = grouped();
    s2.nodes = s2.nodes.set("r2", { ...s2.nodes.at("r2"), visible: false });
    expect(contentWorldBounds(s2, s2.nodes.at("g"))).toEqual({ x: 10, y: 10, width: 50, height: 50 });
  });

  it("an invisible GROUP child takes its whole subtree with it, as the renderer's descent does", () => {
    const s = scene([
      group("g", "page1"),
      group("inner", "g", { orderKey: "a000001", visible: false }),
      node("hidden", "inner", 500, 500, { orderKey: "a000001" }),
      node("seen", "g", 10, 10, { orderKey: "a000002" }),
    ]);
    expect(contentWorldBounds(s, s.nodes.at("g"))).toEqual({ x: 10, y: 10, width: 50, height: 50 });
  });

  it("is null for a group whose children are ALL invisible: it behaves like an empty one", () => {
    const s = grouped();
    s.nodes = s.nodes.set("r1", { ...s.nodes.at("r1"), visible: false });
    s.nodes = s.nodes.set("r2", { ...s.nodes.at("r2"), visible: false });
    expect(contentWorldBounds(s, s.nodes.at("g"))).toBeNull();
  });
});

// LA CORNICE DI UN FRAME è il SUO box, non l'unione dei figli: un frame non è
// un gruppo, quindi contentWorldBounds torna il suo box proprio (come per un
// rect/ellipse), anche se un figlio sporge ben oltre.
describe("contentWorldBounds for a frame", () => {
  it("is the frame's OWN box, not the union of its children", () => {
    const s = scene([
      frame("f", "page1", 10, 20, { width: 100, height: 80 }),
      // Un figlio che sporge ampiamente: se il frame fosse trattato come un
      // gruppo, la cornice si allargherebbe fino a contenerlo.
      node("child", "f", 5, 5, { width: 500, height: 500 }),
    ]);
    expect(contentWorldBounds(s, s.nodes.at("f"))).toEqual({ x: 10, y: 20, width: 100, height: 80 });
  });

  it("maps the frame box through an ancestor's translation", () => {
    const s = scene([
      group("g", "page1", { x: 1000, y: 100 }),
      frame("f", "g", 10, 20, { width: 100, height: 80 }),
    ]);
    // f.x/y sono scritte nello spazio di g (traslato di 1000,100): il box mondo
    // del frame cade a (1010,120).
    expect(contentWorldBounds(s, s.nodes.at("f"))).toEqual({ x: 1010, y: 120, width: 100, height: 80 });
  });
});

// VEDI-vs-SELEZIONA, dal lato del CLIP. Un frame con clipsContent nasconde i
// figli fuori dal proprio box: il renderer non li disegna (drawSiblings), non
// li clicca (pickIn) e il marquee non li prende (collectIn). La cornice di
// selezione e le sue 8 maniglie leggono da contentWorldBounds (via
// selectionWorldBounds): se NON ritagliasse, un figlio che sporge avrebbe
// maniglie disegnate -- e AFFERRABILI (selectTool.ts::handleUnderPointer usa lo
// stesso box) -- su canvas vuoto oltre il bordo del frame. È la stessa
// divergenza che contentIn evita già per i figli invisibili di un gruppo.
describe("contentWorldBounds clipped by an ancestor frame", () => {
  it("clips an overflowing child to the visible region inside the clipping frame", () => {
    const s = scene([
      frame("f", "page1", 10, 20, { width: 100, height: 80 }), // mondo (10,20)-(110,100)
      node("child", "f", 5, 5, { width: 500, height: 500 }), // mondo (15,25)-(515,525)
    ]);
    // Solo la parte dentro il frame: (15,25)-(110,100).
    expect(contentWorldBounds(s, s.nodes.at("child"))).toEqual({ x: 15, y: 25, width: 95, height: 75 });
  });

  it("is null for a child ENTIRELY outside a clipping frame: no frame, no grabbable handles", () => {
    const s = scene([
      frame("f", "page1", 0, 0, { width: 100, height: 100 }),
      node("child", "f", 200, 200, { width: 50, height: 50 }), // mondo (200,200)-(250,250), fuori
    ]);
    expect(contentWorldBounds(s, s.nodes.at("child"))).toBeNull();
  });

  it("does NOT clip when the ancestor frame has clipsContent=false: the child may overflow", () => {
    const s = scene([
      frame("f", "page1", 10, 20, { width: 100, height: 80, clipsContent: false }),
      node("child", "f", 5, 5, { width: 500, height: 500 }),
    ]);
    expect(contentWorldBounds(s, s.nodes.at("child"))).toEqual({ x: 15, y: 25, width: 500, height: 500 });
  });

  it("composes NESTED clipping frames: each ancestor frame narrows further", () => {
    const s = scene([
      frame("outer", "page1", 0, 0, { width: 100, height: 100 }), // mondo (0,0)-(100,100)
      frame("inner", "outer", 50, 50, { width: 100, height: 100 }), // mondo (50,50)-(150,150)
      node("child", "inner", 10, 10, { width: 200, height: 200 }), // mondo (60,60)-(260,260)
    ]);
    // child ∩ inner = (60,60)-(150,150); poi ∩ outer = (60,60)-(100,100).
    expect(contentWorldBounds(s, s.nodes.at("child"))).toEqual({ x: 60, y: 60, width: 40, height: 40 });
  });

  it("a group inside a clipping frame frames only the VISIBLE part of an overflowing child", () => {
    const s = scene([
      frame("f", "page1", 0, 0, { width: 100, height: 100 }),
      group("g", "f", { orderKey: "a000001" }),
      node("r", "g", 80, 80, { orderKey: "a000001", width: 500, height: 500 }), // mondo (80,80)-(580,580)
    ]);
    // r ritagliato a f (0,0)-(100,100) -> (80,80)-(100,100); il gruppo unisce solo quello.
    expect(contentWorldBounds(s, s.nodes.at("g"))).toEqual({ x: 80, y: 80, width: 20, height: 20 });
  });
});

// L'ANGOLO ALTO-SINISTRA DELLA CORNICE, nello spazio del PARENT: è ciò che il
// pannello proprietà chiama X/Y. Per ogni nodo che non è un gruppo coincide con
// le sue coordinate; per un gruppo NO -- x/y di un gruppo sono la traslazione
// che contribuisce ai figli, non il punto in cui la cornice si vede.
describe("frameOriginOf", () => {
  it("is the node's own x/y for anything that is not a group", () => {
    const s = grouped();
    expect(frameOriginOf(s, s.nodes.at("solo"))).toEqual({ x: 200, y: 200 });
    // Anche per un figlio DENTRO un gruppo: le sue x/y sono già scritte nello
    // spazio del parent, che è lo spazio in cui questa funzione risponde.
    expect(frameOriginOf(s, s.nodes.at("r1"))).toEqual({ x: 10, y: 10 });
  });

  it("is the top-left of the CONTENT for a group, not its (0,0) translation", () => {
    const s = grouped();
    expect(s.nodes.at("g").x).toBe(0);
    expect(s.nodes.at("g").y).toBe(0);
    expect(frameOriginOf(s, s.nodes.at("g"))).toEqual({ x: 10, y: 0 });
  });

  it("moves with the group", () => {
    const s = grouped();
    s.nodes = s.nodes.set("g", { ...s.nodes.at("g"), x: 5, y: 7 });
    expect(frameOriginOf(s, s.nodes.at("g"))).toEqual({ x: 15, y: 7 });
  });

  it("is expressed in the PARENT's space for a nested group, not in world", () => {
    const s = scene([
      group("g1", "page1", { x: 1000, y: 0 }),
      group("g2", "g1", { x: 100, y: 100 }),
      node("r", "g2", 5, 5, { width: 10, height: 10 }),
    ]);
    expect(contentWorldBounds(s, s.nodes.at("g2"))).toEqual({ x: 1105, y: 105, width: 10, height: 10 });
    // Lo spazio di g1 è quello in cui x/y di g2 sono scritte: 1105 - 1000.
    expect(frameOriginOf(s, s.nodes.at("g2"))).toEqual({ x: 105, y: 105 });
  });

  it("falls back to the group's own x/y when the group is empty: there is no frame", () => {
    const s = scene([group("g", "page1", { x: 3, y: 4 })]);
    expect(frameOriginOf(s, s.nodes.at("g"))).toEqual({ x: 3, y: 4 });
  });

  // Il numero che il pannello proprietà mostra come X (selectors.ts::
  // selectionSummary) e su cui scrive (PropertiesPanel.tsx::positionValueFor).
  // Se contasse un figlio nascosto, digitare una X porterebbe il bordo del
  // figlio NASCOSTO a quel numero -- e il contenuto visibile finirebbe altrove.
  it("is the left edge of the VISIBLE content, not of a hidden child", () => {
    const s = grouped();
    s.nodes = s.nodes.set("r1", { ...s.nodes.at("r1"), visible: false });
    expect(frameOriginOf(s, s.nodes.at("g"))).toEqual({ x: 100, y: 0 });
  });

  it("falls back to the group's own x/y when EVERY child is hidden: same as empty", () => {
    const s = grouped();
    s.nodes = s.nodes.set("g", { ...s.nodes.at("g"), x: 3, y: 4 });
    s.nodes = s.nodes.set("r1", { ...s.nodes.at("r1"), visible: false });
    s.nodes = s.nodes.set("r2", { ...s.nodes.at("r2"), visible: false });
    expect(frameOriginOf(s, s.nodes.at("g"))).toEqual({ x: 3, y: 4 });
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

  // UN FRAME NON CATTURA IL CLICK (a differenza del gruppo): solo i GRUPPI lo
  // fanno (isGroup nel prefisso di selezione). Cliccare un figlio di un frame
  // seleziona il FIGLIO, non il frame -- è la convenzione artboard.
  it("a frame does NOT capture the click: a child of a frame selects the child", () => {
    const s = scene([frame("f", "page1", 0, 0, { width: 100, height: 100 }), node("child", "f", 10, 10)]);
    expect(selectionTargetOf(s, "child", [])).toBe("child");
  });

  it("clicking the frame's own body selects the frame itself", () => {
    const s = scene([frame("f", "page1", 0, 0, { width: 100, height: 100 })]);
    expect(selectionTargetOf(s, "f", [])).toBe("f");
  });

  // Un frame ANNIDATO dentro un gruppo non intercetta la risalita: è il gruppo
  // esterno a catturare, il frame resta trasparente al click come ogni
  // contenitore non-gruppo.
  it("still finds the outer group when a frame sits between it and the child", () => {
    const s = scene([group("g", "page1"), frame("f", "g", 0, 0, { width: 100, height: 100 }), node("r", "f", 0, 0)]);
    expect(selectionTargetOf(s, "r", [])).toBe("g");
  });

  // Al contrario, un GRUPPO annidato dentro un frame cattura: solo il gruppo lo
  // fa, il frame lo lascia passare.
  it("finds a group nested inside a frame: only the group captures", () => {
    const s = scene([frame("f", "page1", 0, 0, { width: 200, height: 200 }), group("g", "f"), node("r", "g", 0, 0)]);
    expect(selectionTargetOf(s, "r", [])).toBe("g");
  });
});

// La stessa politica su una LISTA (i figli di un frame presi da un marquee):
// nessuno viene sostituito dal frame, perché il frame non cattura.
describe("selectionTargetsOf with a frame", () => {
  it("leaves a frame's children as themselves: no frame is captured", () => {
    const s = scene([
      frame("f", "page1", 0, 0, { width: 100, height: 100 }),
      node("a", "f", 10, 10),
      node("b", "f", 20, 20),
    ]);
    expect(selectionTargetsOf(s, ["a", "b"], [])).toEqual(["a", "b"]);
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

  // Un FRAME ha un box PROPRIO da ridimensionare: non si espande nei figli come
  // un gruppo, resta se stesso.
  it("keeps a frame: it has a box of its own to resize", () => {
    const s = scene([frame("f", "page1", 0, 0, { width: 100, height: 100 }), node("c", "f", 0, 0)]);
    expect(transformTargetsOf(s, ["f"])).toEqual(["f"]);
  });

  it("drops an empty group: there is nothing to transform", () => {
    const s = scene([group("g", "page1"), node("solo", "page1", 0, 0)]);
    expect(transformTargetsOf(s, ["g", "solo"])).toEqual(["solo"]);
  });

  it("keeps an unknown id (it is not this function's job to validate)", () => {
    expect(transformTargetsOf(grouped(), ["sparito"])).toEqual(["sparito"]);
  });
});

// LE ISTANZE (M4), lato BOUNDS e POLITICA DI SELEZIONE. Un'istanza è, qui, un
// GRUPPO il cui contenuto è il sottoalbero del master spostato all'origine
// dell'istanza: bounds DERIVATI, nessun box proprio, selezionata come un'unità.
// I master vivono sotto parentId "components" (non è una pagina), come un
// componente reale sta su una pagina a parte.
function instance(id: string, parentId: string, x: number, y: number, componentId: string, overrides: import("./types").InstanceOverrideLite[] = []): NodeLite {
  return node(id, parentId, x, y, { kind: "instance", instance: { componentId, overrides }, fills: [] });
}

describe("contentWorldBounds for an instance", () => {
  it("is the master root's box, shifted so the root origin lands at the instance origin", () => {
    const s = scene([
      node("mr", "components", 10, 10), // master rect 50x50 a (10,10)
      instance("i", "page1", 100, 100, "comp"),
    ]);
    s.components["comp"] = { rootNodeId: "mr", name: "Comp" };
    expect(contentWorldBounds(s, s.nodes.at("i"))).toEqual({ x: 100, y: 100, width: 50, height: 50 });
  });

  it("unions a group master's children, shifted to the instance origin", () => {
    const s = scene([
      group("gm", "components"),
      node("r1", "gm", 0, 0),
      node("r2", "gm", 100, 0, { width: 20, height: 20 }),
      instance("i", "page1", 200, 200, "comp"),
    ]);
    s.components["comp"] = { rootNodeId: "gm", name: "Comp" };
    // Unione locale del master: (0,0,50,50) ∪ (100,0,20,20) = (0,0,120,50).
    expect(contentWorldBounds(s, s.nodes.at("i"))).toEqual({ x: 200, y: 200, width: 120, height: 50 });
  });

  it("maps the content through an ancestor's translation, like any other node", () => {
    const s = scene([
      group("wrap", "page1", { x: 1000, y: 0 }),
      node("mr", "components", 0, 0),
      instance("i", "wrap", 100, 100, "comp"),
    ]);
    s.components["comp"] = { rootNodeId: "mr", name: "Comp" };
    // i.x/y sono nello spazio di wrap (traslato di 1000,0): mondo (1100,100).
    expect(contentWorldBounds(s, s.nodes.at("i"))).toEqual({ x: 1100, y: 100, width: 50, height: 50 });
  });

  it("is null when the component is missing (nothing to frame)", () => {
    const s = scene([instance("i", "page1", 0, 0, "nope")]);
    expect(contentWorldBounds(s, s.nodes.at("i"))).toBeNull();
  });

  it("is null when the master root node is missing", () => {
    const s = scene([instance("i", "page1", 0, 0, "comp")]);
    s.components["comp"] = { rootNodeId: "gone", name: "Comp" };
    expect(contentWorldBounds(s, s.nodes.at("i"))).toBeNull();
  });

  it("ignores fill/text overrides: an override changes paint, not geometry", () => {
    const s = scene([
      node("mr", "components", 10, 10),
      instance("i", "page1", 100, 100, "comp", [{ masterNodeId: "mr", fills: [{ r: 1, g: 0, b: 0, a: 1 }] }]),
    ]);
    s.components["comp"] = { rootNodeId: "mr", name: "Comp" };
    expect(contentWorldBounds(s, s.nodes.at("i"))).toEqual({ x: 100, y: 100, width: 50, height: 50 });
  });

  it("does not infinite-loop on a self-referential component: null, and it returns", () => {
    const s = scene([
      group("gs", "components"),
      instance("ci", "gs", 0, 0, "self"),
      instance("i", "page1", 0, 0, "self"),
    ]);
    s.components["self"] = { rootNodeId: "gs", name: "Self" };
    expect(contentWorldBounds(s, s.nodes.at("i"))).toBeNull();
  });
});

describe("instance selection policy", () => {
  function withInstance(): SceneState {
    const s = scene([node("mr", "components", 0, 0), instance("i", "page1", 100, 100, "comp")]);
    s.components["comp"] = { rootNodeId: "mr", name: "Comp" };
    return s;
  }

  it("selects the instance as a unit: a click resolves to the instance, not a master node", () => {
    expect(selectionTargetOf(withInstance(), "i", [])).toBe("i");
  });

  it("is NOT expanded by transformTargetsOf: it has a box of its own to resize, unlike a group", () => {
    expect(transformTargetsOf(withInstance(), ["i"])).toEqual(["i"]);
  });

  it("frameOriginOf is the content's top-left in parent space, not the instance's own x/y", () => {
    const s = scene([
      group("gm", "components"),
      node("r", "gm", -5, -5, { width: 10, height: 10 }), // il contenuto sporge in alto a sinistra della radice
      instance("i", "page1", 100, 100, "comp"),
    ]);
    s.components["comp"] = { rootNodeId: "gm", name: "Comp" };
    // La radice del master cade a (100,100); il figlio a (-5,-5) porta il bordo
    // del contenuto a (95,95) -- diverso dalla x/y propria dell'istanza (100).
    expect(s.nodes.at("i").x).toBe(100);
    expect(frameOriginOf(s, s.nodes.at("i"))).toEqual({ x: 95, y: 95 });
  });
});
