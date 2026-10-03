import { nodesFromEntries } from "../store/nodeMap";
import { describe, it, expect } from "vitest";
import { create } from "@bufbuild/protobuf";
import { OpSchema, NodeSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { applyOp } from "../store/applyOp";
import { emptyScene } from "../store/types";
import type { NodeLite, SceneState } from "../store/types";
import { makeCreateNodeOp, makeDeleteOp, makeReparentOp, makeSetPropsOp } from "../tools/ops";
import { buildIndex, sceneIndexOf } from "./sceneIndex";

function node(id: string, parentId: string, key: string, over: Partial<NodeLite> = {}): NodeLite {
  return {
    id, parentId, orderKey: key, name: id, visible: true, opacity: 1, x: 0, y: 0, width: 40, height: 30, rotation: 0,
    fills: [{ r: 1, g: 0, b: 0, a: 1 }], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false, ...over,
  };
}

function sceneOf(nodes: NodeLite[]): SceneState {
  return { ...emptyScene("d", "t"), nodes: nodesFromEntries(nodes.map((n) => [n.id, n])) };
}

// Le due viste dell'indice, confrontabili con toEqual.
function snapshot(scene: SceneState) {
  const idx = sceneIndexOf(scene);
  const kids = Object.fromEntries([...idx.children].map(([k, v]) => [k, v.map((n) => n.id)]));
  const ext = Object.fromEntries([...idx.extent].sort(([a], [b]) => (a < b ? -1 : 1)));
  return { kids, ext };
}
function fresh(scene: SceneState) {
  const idx = buildIndex(scene);
  const kids = Object.fromEntries([...idx.children].map(([k, v]) => [k, v.map((n) => n.id)]));
  const ext = Object.fromEntries([...idx.extent].sort(([a], [b]) => (a < b ? -1 : 1)));
  return { kids, ext };
}

describe("extent", () => {
  it("un rettangolo copre il proprio box, ruotato e col tratto", () => {
    const s = sceneOf([node("a", "page1", "a", { x: 10, y: 20, strokes: [{ color: { r: 0, g: 0, b: 0, a: 1 }, weight: 4, align: "center" }] })]);
    expect(sceneIndexOf(s).extent.get("a")).toEqual({ x: 8, y: 18, width: 44, height: 34 });
    const r = sceneOf([node("a", "page1", "a", { x: 0, y: 0, width: 100, height: 100, rotation: 45 })]);
    const e = sceneIndexOf(r).extent.get("a")!;
    expect(e.width).toBeCloseTo(141.42, 1);
  });

  it("un gruppo copre i figli; un frame ritagliante solo ciò che sta nel suo box", () => {
    const g = sceneOf([
      node("g", "page1", "a", { kind: "group", width: 0, height: 0, x: 100, y: 100 }),
      node("k", "g", "a", { x: 5, y: 5 }),
    ]);
    expect(sceneIndexOf(g).extent.get("g")).toEqual({ x: 105, y: 105, width: 40, height: 30 });

    const f = sceneOf([
      node("f", "page1", "a", { kind: "frame", width: 50, height: 50, clipsContent: true }),
      node("k", "f", "a", { x: 40, y: 40, width: 500, height: 500 }),
    ]);
    // Il figlio sporge di molto, ma il frame lo ritaglia: l'extent resta il box.
    expect(sceneIndexOf(f).extent.get("f")).toEqual({ x: 0, y: 0, width: 50, height: 50 });
    const nc = sceneOf([
      node("f", "page1", "a", { kind: "frame", width: 50, height: 50, clipsContent: false }),
      node("k", "f", "a", { x: 40, y: 40, width: 500, height: 500 }),
    ]);
    expect(sceneIndexOf(nc).extent.get("f")).toEqual({ x: 0, y: 0, width: 540, height: 540 });
  });

  it("ombra e sfocatura allargano l'extent", () => {
    const s = sceneOf([node("a", "page1", "a", {
      x: 100, y: 100, width: 50, height: 50,
      effects: [{ kind: "dropShadow", color: { r: 0, g: 0, b: 0, a: 1 }, offsetX: 10, offsetY: 4, blur: 8 }],
    })]);
    const e = sceneIndexOf(s).extent.get("a")!;
    // 10 (offset) + 12 (1.5 * blur) = 22 per lato.
    expect(e).toEqual({ x: 78, y: 78, width: 94, height: 94 });
  });

  it("un testo che va a capo sporge dal box: l'extent lo prevede", () => {
    const s = sceneOf([node("t", "page1", "a", {
      kind: "text", x: 0, y: 0, width: 100, height: 20,
      text: { content: "una frase abbastanza lunga da andare a capo più volte nel suo box stretto", style: { fontFamily: "", fontSize: 16, fontWeight: "", lineHeight: 0, align: "left" } },
    })]);
    expect(sceneIndexOf(s).extent.get("t")!.height).toBeGreaterThan(60);
  });

  it("un nodo nascosto non ha extent e porta via il sottoalbero", () => {
    const s = sceneOf([
      node("g", "page1", "a", { kind: "group", visible: false, width: 0, height: 0 }),
      node("k", "g", "a"),
    ]);
    const idx = sceneIndexOf(s);
    expect(idx.extent.has("g")).toBe(false);
    expect(idx.extent.has("k")).toBe(false);
  });
});

// --- l'aggiornamento incrementale deve coincidere con la ricostruzione --------

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function randomScene(r: () => number): SceneState {
  const nodes: NodeLite[] = [];
  let k = 0;
  const key = () => `a${String(k++).padStart(5, "0")}`;
  for (let f = 0; f < 12; f++) {
    nodes.push(node(`f${f}`, "page1", key(), {
      kind: f % 4 === 3 ? "group" : "frame", clipsContent: f % 2 === 0,
      x: (f % 4) * 300, y: Math.floor(f / 4) * 300, width: f % 4 === 3 ? 0 : 260, height: f % 4 === 3 ? 0 : 260,
    }));
    for (let i = 0; i < 8; i++) {
      nodes.push(node(`n${f}_${i}`, `f${f}`, key(), {
        x: r() * 240, y: r() * 240, width: 10 + r() * 80, height: 10 + r() * 80, rotation: r() < 0.2 ? r() * 90 : 0,
        kind: i % 4 === 1 ? "ellipse" : "rect",
        strokes: r() < 0.3 ? [{ color: { r: 0, g: 0, b: 0, a: 1 }, weight: 1 + r() * 6, align: "center" }] : [],
      }));
    }
  }
  return sceneOf(nodes);
}

describe("aggiornamento incrementale", () => {
  // Regressione: creare un nodo DENTRO un frame con auto layout lo registra due
  // volte nella provenienza (toccato dall'op + ridisposto dal layout). L'indice lo
  // inseriva due volte fra i figli e ne perdeva l'extent: il testo di un bottone
  // creato da un altro client (o da un template) non si vedeva fino al reload.
  it("creare un figlio in un frame con auto layout: figlio una volta sola, con il suo extent", () => {
    let scene = sceneOf([
      node("btn", "page1", "a", {
        kind: "frame", width: 200, height: 48, clipsContent: false,
        autoLayout: { direction: "horizontal", spacing: 0, paddingLeft: 16, paddingTop: 0, paddingRight: 16, paddingBottom: 0, mainAlign: "center", crossAlign: "center", hugWidth: false, hugHeight: false },
      }),
    ]);
    sceneIndexOf(scene); // l'indice di base, da cui parte l'aggiornamento incrementale
    scene = applyOp(scene, makeCreateNodeOp(create(NodeSchema, {
      id: "label", parentId: "btn", orderKey: "a0", name: "label", visible: true, opacity: 1,
      x: 0, y: 0, width: 168, height: 20, shape: { case: "rect", value: { cornerRadius: 0 } },
    })));
    const idx = sceneIndexOf(scene);
    expect(idx.children.get("btn")?.map((n) => n.id)).toEqual(["label"]);
    expect(idx.extent.get("label")).toBeDefined();
    expect(snapshot(scene)).toEqual(fresh(scene));
  });

  it.each([42, 1, 2, 3, 4, 5, 6, 7])("seme %i: dopo ogni modifica casuale l'indice è IDENTICO a quello ricostruito da zero", (seed) => {
    const r = rng(seed);
    let scene = randomScene(r);
    expect(snapshot(scene)).toEqual(fresh(scene)); // il primo è una costruzione completa
    const ids = () => [...scene.nodes.ids()];
    const containers = () => ids().filter((id) => scene.nodes.at(id).kind === "frame" || scene.nodes.at(id).kind === "group");
    let created = 0;
    let mismatches = 0;

    for (let step = 0; step < 300; step++) {
      const pick = ids()[Math.floor(r() * ids().length)];
      const choice = Math.floor(r() * 9);
      let op: Op | null = null;
      if (choice === 0) op = makeSetPropsOp(pick, { x: r() * 400, y: r() * 400 }, ["x", "y"]);
      else if (choice === 1) op = makeSetPropsOp(pick, { width: 5 + r() * 200, height: 5 + r() * 200 }, ["width", "height"]);
      else if (choice === 2) op = makeSetPropsOp(pick, { rotation: r() * 180 }, ["rotation"]);
      else if (choice === 3) op = makeSetPropsOp(pick, { visible: r() < 0.5 }, ["visible"]);
      else if (choice === 4) {
        const target = containers()[Math.floor(r() * containers().length)];
        op = makeReparentOp(pick, target, `m${String(step).padStart(5, "0")}`);
      } else if (choice === 5) op = makeDeleteOp(pick);
      else if (choice === 6) {
        const parent = containers()[Math.floor(r() * containers().length)];
        op = makeCreateNodeOp(create(NodeSchema, {
          id: `new${created++}`, parentId: parent, orderKey: `z${String(step).padStart(5, "0")}`, name: "n",
          visible: true, opacity: 1, x: r() * 200, y: r() * 200, width: 30, height: 30,
          shape: { case: "rect", value: { cornerRadius: 0 } },
        }));
      } else if (choice === 7) op = makeSetPropsOp(pick, { orderKey: `q${String(step).padStart(5, "0")}` }, ["order_key"]);
      else {
        op = makeSetPropsOp(pick, {
          effects: [{ kind: { case: "dropShadow", value: { color: { r: 0, g: 0, b: 0, a: 1 }, offsetX: r() * 30, offsetY: r() * 30, blur: r() * 20 } } }],
        }, ["effects"]);
      }
      scene = applyOp(scene, op as Op);
      const got = snapshot(scene);
      const want = fresh(scene);
      const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
      const diffs = [
        ...Object.keys({ ...got.ext, ...want.ext }).filter((k) => !same(got.ext[k], want.ext[k]))
          .map((k) => `ext ${k}: got ${JSON.stringify(got.ext[k])} want ${JSON.stringify(want.ext[k])}`),
        ...Object.keys({ ...got.kids, ...want.kids }).filter((k) => !same(got.kids[k], want.kids[k]))
          .map((k) => `kids ${k}: got ${JSON.stringify(got.kids[k])} want ${JSON.stringify(want.kids[k])}`),
      ];
      if (diffs.length > 0) {
        mismatches++;
        // eslint-disable-next-line no-console
        console.log(`DIFF passo ${step} scelta ${choice} pick=${pick}\n${diffs.slice(0, 6).join("\n")}`);
      }
      expect(got, `passo ${step}, scelta ${choice}`).toEqual(want);
    }
    expect(mismatches).toBe(0);
  });

  it("l'indice della scena PRECEDENTE resta valido (undo, vista contro confermata)", () => {
    const r = rng(7);
    const a = randomScene(r);
    const before = snapshot(a);
    const b = applyOp(a, makeSetPropsOp("n0_0", { x: 999, y: 999 }, ["x", "y"]));
    snapshot(b);
    // Tornare alla scena vecchia non deve vederla mutata dall'aggiornamento.
    expect(snapshot(a)).toEqual(before);
    expect(snapshot(a)).toEqual(fresh(a));
  });

  it("una scena con gli stessi nodi riusa l'indice; troppe modifiche ricostruiscono", () => {
    const r = rng(9);
    const a = randomScene(r);
    const idxA = sceneIndexOf(a);
    expect(sceneIndexOf({ ...a })).toBe(idxA); // nuova scena, stessi nodi
    // Cambio il 100% dei nodi: ricostruzione, ma il risultato è comunque giusto.
    const all: SceneState = { ...a, nodes: nodesFromEntries([...a.nodes.entries()].map(([k, n]) => [k, { ...n, x: n.x + 1 }])) };
    expect(snapshot(all)).toEqual(fresh(all));
  });

  it("un componente: cambiare il master aggiorna le istanze (ricostruzione)", () => {
    const master = node("m", "components", "a", { kind: "group", width: 0, height: 0 });
    const mk = node("mk", "m", "a", { x: 0, y: 0, width: 50, height: 50 });
    const inst = node("i", "page1", "a", { kind: "instance", x: 300, y: 300, width: 0, height: 0, instance: { componentId: "c", overrides: [] } });
    const s0: SceneState = { ...sceneOf([master, mk, inst]), components: { c: { rootNodeId: "m", name: "C" } } };
    const e0 = sceneIndexOf(s0).extent.get("i")!;
    const s1 = applyOp(s0, makeSetPropsOp("mk", { width: 200, height: 200 }, ["width", "height"]));
    const e1 = sceneIndexOf(s1).extent.get("i")!;
    expect(e1.width).toBeGreaterThan(e0.width);
    expect(snapshot(s1)).toEqual(fresh(s1));
  });
});

// Evita un import non usato se OpSchema serve ai tipi di sopra.
void OpSchema;
