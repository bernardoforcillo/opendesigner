import { nodesOf, nodesFromEntries , nodesWith } from "../store/nodeMap";
import { describe, it, expect } from "vitest";
import { applyOp } from "../store/applyOp";
import { emptyScene } from "../store/types";
import type { AutoLayoutLite, NodeLite, SceneState } from "../store/types";
import { computeLayoutDrop, layoutDropOps, reorderableParent } from "./layoutDrop";

const AL: AutoLayoutLite = {
  direction: "horizontal", spacing: 10, paddingLeft: 0, paddingTop: 0, paddingRight: 0, paddingBottom: 0,
  mainAlign: "start", crossAlign: "start", hugWidth: false, hugHeight: false,
};

function node(id: string, parentId: string, key: string, over: Partial<NodeLite> = {}): NodeLite {
  return {
    id, parentId, orderKey: key, name: id, visible: true, opacity: 1, x: 0, y: 0, width: 20, height: 10, rotation: 0,
    fills: [], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false, ...over,
  };
}

// Una fila a 0, 30, 60 (box 20x10, spaziatura 10) dentro un frame 300x100 a (100, 50).
function row(al: Partial<AutoLayoutLite> = {}): SceneState {
  const frame = node("f", "page1", "a0", { kind: "frame", x: 100, y: 50, width: 300, height: 100, autoLayout: { ...AL, ...al } });
  const s = emptyScene("d", "t");
  const nodes = [frame, node("a", "f", "a"), node("b", "f", "b"), node("c", "f", "c")];
  // Passa dal layout vero: le posizioni le decide lui.
  let scene: SceneState = { ...s, nodes: nodesFromEntries(nodes.map((n) => [n.id, n])) };
  scene = applyOp(scene, {
    kind: { case: "setProps", value: { id: "a", patch: { x: 0 }, mask: { paths: ["x"] } } },
  } as never);
  return scene;
}

describe("reorderableParent", () => {
  it("è il frame con auto layout quando TUTTI i nodi ne sono figli diretti che partecipano", () => {
    const s = row();
    expect(reorderableParent(s, ["b"])).toBe("f");
    expect(reorderableParent(s, ["a", "c"])).toBe("f");
  });

  it("null per un figlio di un frame normale, di una pagina, o di nodi non omogenei", () => {
    const s = row();
    expect(reorderableParent(s, ["f"])).toBeNull();
    expect(reorderableParent(s, [])).toBeNull();
    expect(reorderableParent(s, ["ghost"])).toBeNull();
    const plain: SceneState = { ...s, nodes: nodesWith(s.nodes, { f: { ...s.nodes.at("f"), autoLayout: undefined } }) };
    delete (plain.nodes.at("f") as { autoLayout?: unknown }).autoLayout;
    expect(reorderableParent(plain, ["b"])).toBeNull();
    const mixed: SceneState = { ...s, nodes: nodesWith(s.nodes, { z: node("z", "page1", "a9") }) };
    expect(reorderableParent(mixed, ["a", "z"])).toBeNull();
  });

  it("un nodo che il layout non dispone (gruppo, nascosto) non si riordina", () => {
    const s = row();
    const g: SceneState = { ...s, nodes: nodesWith(s.nodes, { a: { ...s.nodes.at("a"), kind: "group" } }) };
    expect(reorderableParent(g, ["a"])).toBeNull();
    const h: SceneState = { ...s, nodes: nodesWith(s.nodes, { a: { ...s.nodes.at("a"), visible: false } }) };
    expect(reorderableParent(h, ["a"])).toBeNull();
  });
});

describe("computeLayoutDrop", () => {
  // Nel mondo i figli stanno a x = 100, 130, 160 (20 di larghezza), centri 110, 140, 170.
  it("l'indice conta i fratelli (non trascinati) il cui centro sta prima del puntatore", () => {
    const s = row();
    // Trascino a: restano b (centro 140) e c (170) -- ma nel mondo i box ci sono già.
    const at = (x: number) => computeLayoutDrop(s, ["a"], "f", { x, y: 70 })!.index;
    expect(at(90)).toBe(0);
    expect(at(150)).toBe(1);
    expect(at(300)).toBe(2);
  });

  it("la linea sta nel vuoto fra i vicini, ed è alta quanto il frame (orizzontale)", () => {
    const s = row();
    const d = computeLayoutDrop(s, ["a"], "f", { x: 150, y: 70 })!;
    expect(d.vertical).toBe(false);
    // Fra b (130..150) e c (160..180): metà vuoto = 155; linea di spessore 2.
    expect(d.indicator).toEqual({ x: 154, y: 50, width: 2, height: 100 });
  });

  it("verticale: la linea è orizzontale, larga quanto il frame", () => {
    const s = row({ direction: "vertical" });
    const d = computeLayoutDrop(s, ["a"], "f", { x: 110, y: 60 })!;
    expect(d.vertical).toBe(true);
    expect(d.indicator.width).toBe(300);
    expect(d.indicator.height).toBe(2);
  });

  it("estremi: prima del primo e dopo l'ultimo, a mezza spaziatura dal bordo del fratello", () => {
    const s = row();
    // Prima del primo: mezza spaziatura sarebbe a 95, FUORI dal frame (che parte da
    // 100): la linea si ferma sul bordo.
    expect(computeLayoutDrop(s, ["c"], "f", { x: 90, y: 70 })!.indicator.x).toBe(100 - 1);
    const end = computeLayoutDrop(s, ["a"], "f", { x: 390, y: 70 })!;
    expect(end.index).toBe(2);
    expect(end.indicator.x).toBe(180 + 5 - 1);
  });

  it("rilasciare fuori da ogni frame riordina comunque nel frame di partenza", () => {
    const s = row();
    expect(computeLayoutDrop(s, ["a"], "f", { x: 5000, y: 5000 })!.frameId).toBe("f");
  });

  it("sceglie il frame con auto layout PIÙ INTERNO sotto il puntatore, mai uno trascinato", () => {
    const s = row();
    const inner = node("g", "f", "z", { kind: "frame", x: 0, y: 40, width: 120, height: 50, autoLayout: { ...AL } });
    const scene: SceneState = { ...s, nodes: nodesWith(s.nodes, { g: inner }) };
    // g sta a (100,90) nel mondo, 120x50. Puntatore dentro: vince g.
    expect(computeLayoutDrop(scene, ["a"], "f", { x: 150, y: 110 })!.frameId).toBe("g");
    // Se è g a essere trascinato, non può cadere dentro sé stesso.
    expect(computeLayoutDrop(scene, ["g"], "f", { x: 150, y: 110 })!.frameId).toBe("f");
  });

  it("frame vuoto: la linea sta all'inizio, dopo il padding", () => {
    const s = row({ paddingLeft: 8 });
    const only: SceneState = { ...s, nodes: nodesOf({ f: s.nodes.at("f"), a: s.nodes.at("a") }) };
    const d = computeLayoutDrop(only, ["a"], "f", { x: 200, y: 70 })!;
    expect(d.index).toBe(0);
    expect(d.indicator.x).toBe(100 + 8 - 1);
  });
});

function order(scene: SceneState, frame = "f"): string[] {
  return [...scene.nodes.values()]
    .filter((n) => n.parentId === frame)
    .sort((a, b) => (a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : a.id < b.id ? -1 : 1))
    .map((n) => n.id);
}

describe("layoutDropOps", () => {
  const apply = (s: SceneState, ids: string[], index: number, frameId = "f") => {
    const ops = layoutDropOps(s, ids, { frameId, index, vertical: false, indicator: { x: 0, y: 0, width: 1, height: 1 } });
    return { ops, next: ops.reduce(applyOp, s) };
  };

  it("sposta un figlio avanti e indietro nella fila, e il layout ricalcola le posizioni", () => {
    const s = row();
    const { next } = apply(s, ["a"], 2); // dopo c
    expect(order(next)).toEqual(["b", "c", "a"]);
    expect([next.nodes.at("b").x, next.nodes.at("c").x, next.nodes.at("a").x]).toEqual([0, 30, 60]);
    const back = apply(next, ["a"], 0);
    expect(order(back.next)).toEqual(["a", "b", "c"]);
  });

  it("rilasciare dov'era già non produce nessun op", () => {
    const s = row();
    expect(apply(s, ["a"], 0).ops).toEqual([]); // restano b, c: a prima di tutti = com'era
    expect(apply(s, ["b"], 1).ops).toEqual([]);
    expect(apply(s, ["c"], 2).ops).toEqual([]);
  });

  it("più nodi insieme restano nel loro ordine relativo", () => {
    const s = row();
    const { next } = apply(s, ["a", "b"], 1); // resta solo c: dopo c
    expect(order(next)).toEqual(["c", "a", "b"]);
  });

  it("verso un altro auto layout è un reparent e il frame di partenza si richiude", () => {
    const s = row();
    const other = node("g", "page1", "a1", { kind: "frame", x: 500, y: 50, width: 300, height: 100, autoLayout: { ...AL } });
    const withOther: SceneState = { ...s, nodes: nodesWith(s.nodes, { g: other, d: node("d", "g", "a") }) };
    const { ops, next } = apply(withOther, ["a"], 1, "g");
    expect(ops).toHaveLength(1);
    expect(ops[0].kind.case).toBe("reparentNode");
    expect(order(next, "g")).toEqual(["d", "a"]);
    expect(next.nodes.at("a").parentId).toBe("g");
    // Il frame di partenza non ha più a: b parte dall'inizio.
    expect(next.nodes.at("b")).toMatchObject({ x: 0, y: 0 });
    expect(next.nodes.at("a")).toMatchObject({ x: 30, y: 0 });
  });

  it("chiavi uguali fra i vicini non fanno esplodere il gesto", () => {
    const s = row();
    const same: SceneState = { ...s, nodes: nodesWith(s.nodes, { b: { ...s.nodes.at("b"), orderKey: "a" }, c: { ...s.nodes.at("c"), orderKey: "a" } }) };
    expect(() => apply(same, ["a"], 1)).not.toThrow();
  });
});
