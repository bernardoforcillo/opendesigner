import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  ALIGN_COMMANDS,
  alignDelta,
  alignOps,
  alignSelection,
  alignTarget,
  distributeDeltas,
  minSelection,
} from "./align";
import type { AlignKind } from "./align";
import { useScene } from "../store/store";
import { emptyScene } from "../store/types";
import type { NodeLite, SceneState } from "../store/types";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";

function node(over: Partial<NodeLite> & { id: string }): NodeLite {
  return {
    parentId: "page1", orderKey: "a0", name: over.id, visible: true, opacity: 1,
    x: 0, y: 0, width: 10, height: 10, rotation: 0,
    fills: [], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false,
    ...over,
  };
}

function sceneWith(nodes: NodeLite[]): SceneState {
  const s = emptyScene("doc-1", "u");
  for (const n of nodes) s.nodes = s.nodes.set(n.id, n);
  return s;
}

// Doppio del trasporto (come in tools/selectTool.test.ts): registra gli op che
// finiscono sul filo e li conferma subito.
class FakeSync {
  sent: Op[] = [];
  submit(op: Op) {
    this.sent.push(op);
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
}

const B = { x: 10, y: 20, width: 100, height: 40 };
const TARGET = { x: 0, y: 0, width: 200, height: 200 };

describe("alignDelta", () => {
  it("left / right put the matching edge on the target's edge", () => {
    expect(alignDelta(B, TARGET, "left")).toEqual({ dx: -10, dy: 0 });
    expect(alignDelta(B, TARGET, "right")).toEqual({ dx: 90, dy: 0 });
  });

  it("top / bottom do the same vertically", () => {
    expect(alignDelta(B, TARGET, "top")).toEqual({ dx: 0, dy: -20 });
    expect(alignDelta(B, TARGET, "bottom")).toEqual({ dx: 0, dy: 140 });
  });

  it("centres put centre on centre", () => {
    // centro di B: (60, 40); centro del bersaglio: (100, 100).
    expect(alignDelta(B, TARGET, "hcenter")).toEqual({ dx: 40, dy: 0 });
    expect(alignDelta(B, TARGET, "middle")).toEqual({ dx: 0, dy: 60 });
  });

  it("touches ONE axis, always — aligning left never moves anything vertically", () => {
    for (const kind of ["left", "hcenter", "right"] as const) {
      expect(alignDelta(B, TARGET, kind).dy).toBe(0);
    }
    for (const kind of ["top", "middle", "bottom"] as const) {
      expect(alignDelta(B, TARGET, kind).dx).toBe(0);
    }
  });

  it("is a no-op on a box already aligned", () => {
    expect(alignDelta(TARGET, TARGET, "left")).toEqual({ dx: 0, dy: 0 });
    expect(alignDelta(TARGET, TARGET, "middle")).toEqual({ dx: 0, dy: 0 });
  });
});

describe("distributeDeltas", () => {
  it("leaves fewer than three boxes alone — there is no gap to equalise", () => {
    const two = [{ x: 0, y: 0, width: 10, height: 10 }, { x: 100, y: 0, width: 10, height: 10 }];
    expect(distributeDeltas(two, "x")).toEqual([{ dx: 0, dy: 0 }, { dx: 0, dy: 0 }]);
    expect(distributeDeltas([], "x")).toEqual([]);
  });

  it("equalises the GAPS and keeps the two extremes where they are", () => {
    // Larghezze 10/20/10 fra 0 e 100: spazio libero 60, due intervalli -> 30.
    const boxes = [
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 15, y: 0, width: 20, height: 10 },
      { x: 90, y: 0, width: 10, height: 10 },
    ];
    const d = distributeDeltas(boxes, "x");
    expect(d[0]).toEqual({ dx: 0, dy: 0 });
    expect(d[2]).toEqual({ dx: 0, dy: 0 });
    // Il box di mezzo parte a 40 (0 + 10 + 30).
    expect(d[1]).toEqual({ dx: 25, dy: 0 });
  });

  it("works vertically with the same rule", () => {
    const boxes = [
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 0, y: 5, width: 10, height: 10 },
      { x: 0, y: 50, width: 10, height: 10 },
    ];
    // Altezze 10/10/10 fra 0 e 60: spazio libero 30, due intervalli -> 15.
    const d = distributeDeltas(boxes, "y");
    expect(d[0]).toEqual({ dx: 0, dy: 0 });
    expect(d[1]).toEqual({ dx: 0, dy: 20 }); // da 5 a 25 (0 + 10 + 15)
    expect(d[2]).toEqual({ dx: 0, dy: 0 });
  });

  it("does not depend on the order of the list, only on the positions", () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    const b = { x: 15, y: 0, width: 20, height: 10 };
    const c = { x: 90, y: 0, width: 10, height: 10 };
    // Stessa geometria, lista rimescolata: ogni box riceve lo stesso delta.
    const straight = distributeDeltas([a, b, c], "x");
    const shuffled = distributeDeltas([c, a, b], "x");
    expect(shuffled).toEqual([straight[2], straight[0], straight[1]]);
  });

  it("equalises even when the boxes overlap (the gap simply goes negative)", () => {
    const boxes = [
      { x: 0, y: 0, width: 40, height: 10 },
      { x: 5, y: 0, width: 40, height: 10 },
      { x: 20, y: 0, width: 40, height: 10 },
    ];
    const d = distributeDeltas(boxes, "x");
    const at = boxes.map((b, i) => b.x + d[i].dx);
    expect(at[1] - at[0]).toBeCloseTo(at[2] - at[1], 10);
  });

  // I due test qui sotto guardano lo ZERO ESATTO degli estremi, che i casi a
  // numeri tondi qui sopra non possono vedere: 0/15/90 con larghezze 10/20/10 fa
  // tornare i conti anche con un accumulatore, perché ogni somma è esatta in
  // binario. Su coordinate qualunque no -- e "quasi zero" non è zero per
  // alignOps, che ci manda sopra un op.
  it("keeps the two extremes EXACTLY put, on coordinates that are not round", () => {
    // Caso trovato per forza bruta: con `cursor += size + gap` accumulato,
    // l'ultimo box (a 969.9) riceve -1.1368683772161603e-13 invece di 0.
    const boxes = [
      { x: 969.9, y: 0, width: 31.8, height: 10 },
      { x: 309.3, y: 0, width: 38.7, height: 10 },
      { x: 456.6, y: 0, width: 28.9, height: 10 },
    ];
    const d = distributeDeltas(boxes, "x");
    expect(d[0]).toEqual({ dx: 0, dy: 0 }); // l'ultimo in ordine di posizione
    expect(d[1]).toEqual({ dx: 0, dy: 0 }); // il primo
    expect(d[2].dx).toBeCloseTo(187.9, 10); // quello di mezzo si muove davvero
  });

  it("keeps them exact over thousands of arbitrary layouts, not just the lucky ones", () => {
    // PRNG deterministico (mulberry32): il test non è casuale, è sempre la
    // STESSA batteria di layout -- solo scelti in modo da non essere tondi.
    let s = 0x2f6e2b1;
    const rnd = () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    // Le violazioni si RACCOLGONO e si asseriscono una volta sola: un expect
    // per giro costerebbe secondi, e il messaggio d'errore utile è comunque il
    // primo layout che sbaglia, non il numero del giro.
    const bad: unknown[] = [];
    for (let iter = 0; iter < 5000; iter++) {
      const n = 3 + Math.floor(rnd() * 4);
      const boxes = Array.from({ length: n }, () => ({
        x: rnd() * 1000, y: rnd() * 1000, width: 1 + rnd() * 200, height: 1 + rnd() * 200,
      }));
      for (const axis of ["x", "y"] as const) {
        const d = distributeDeltas(boxes, axis);
        const min = (b: typeof boxes[number]) => (axis === "x" ? b.x : b.y);
        const order = boxes.map((_, i) => i).sort((a, b) => min(boxes[a]) - min(boxes[b]) || a - b);
        for (const k of [order[0], order[n - 1]]) {
          if (d[k].dx !== 0 || d[k].dy !== 0) bad.push({ axis, boxes, delta: d[k] });
        }
      }
    }
    expect(bad.slice(0, 1)).toEqual([]);
  });
});

describe("alignTarget", () => {
  // Un nodo solo si allinea CONTRO SÉ STESSO, cioè non si muove. Non esiste
  // nessuna pagina nel modello contro cui allinearlo, e inventarne una lo
  // spedirebbe dove il documento non è: vedi il commento su alignTarget e i
  // test "un nodo solo" più sotto.
  it("uses the node's OWN box for a single node — there is no page to align it to", () => {
    const scene = sceneWith([node({ id: "a", x: 5, y: 5 })]);
    expect(alignTarget(scene, ["a"])).toEqual({ x: 5, y: 5, width: 10, height: 10 });
  });

  it("uses the common bounding box for several", () => {
    const scene = sceneWith([node({ id: "a", x: 0, y: 0 }), node({ id: "b", x: 90, y: 40 })]);
    expect(alignTarget(scene, ["a", "b"])).toEqual({ x: 0, y: 0, width: 100, height: 50 });
  });

  it("takes the AABB of a rotated node into the common box", () => {
    const scene = sceneWith([
      node({ id: "a", x: 0, y: 0 }),
      node({ id: "r", x: 100, y: 0, width: 10, height: 10, rotation: 45 }),
    ]);
    const t = alignTarget(scene, ["a", "r"])!;
    expect(t.x + t.width).toBeCloseTo(105 + (10 * Math.SQRT2) / 2, 10);
  });

  it("is null for an empty selection", () => {
    expect(alignTarget(sceneWith([]), [])).toBeNull();
  });
});

describe("alignOps", () => {
  it("moves every selected node onto the common edge, and only x/y", () => {
    const scene = sceneWith([
      node({ id: "a", x: 0, y: 0 }),
      node({ id: "b", x: 90, y: 40 }),
    ]);
    const ops = alignOps(scene, ["a", "b"], "left");
    expect(ops).toHaveLength(1); // "a" è già a sinistra: nessun op per lui
    const v = ops[0].kind.value as { id: string; patch?: { x: number; y: number }; mask?: { paths: string[] } };
    expect(v.id).toBe("b");
    expect(v.patch?.x).toBe(0);
    expect(v.patch?.y).toBe(40);
    expect(v.mask?.paths).toEqual(["x", "y"]);
  });

  it("emits nothing when the selection is already aligned", () => {
    const scene = sceneWith([node({ id: "a", x: 0 }), node({ id: "b", x: 0, y: 50 })]);
    expect(alignOps(scene, ["a", "b"], "left")).toEqual([]);
  });

  it("moves a ROTATED node by the delta of its AABB, leaving the angle alone", () => {
    const side = 10 * Math.SQRT2;
    const scene = sceneWith([
      node({ id: "a", x: 0, y: 0, width: 100, height: 10 }),
      node({ id: "r", x: 50, y: 50, width: 10, height: 10, rotation: 45 }),
    ]);
    const ops = alignOps(scene, ["a", "r"], "left");
    const v = ops[0].kind.value as { id: string; patch?: { x: number; y: number }; mask?: { paths: string[] } };
    expect(v.id).toBe("r");
    // L'AABB del nodo ruotato parte a 55 - side/2: portarlo a 0 vuol dire
    // scrivere una x di 50 - (55 - side/2).
    expect(v.patch?.x).toBeCloseTo(50 - (55 - side / 2), 10);
    expect(v.mask?.paths).toEqual(["x", "y"]);
  });

  it("distributes with a single command", () => {
    const scene = sceneWith([
      node({ id: "a", x: 0 }),
      node({ id: "b", x: 15 }),
      node({ id: "c", x: 90 }),
    ]);
    // Larghezze 10/10/10 fra 0 e 100: spazio libero 70, due intervalli -> 35.
    const ops = alignOps(scene, ["a", "b", "c"], "distribute-h");
    expect(ops).toHaveLength(1); // gli estremi non si muovono
    const v = ops[0].kind.value as { id: string; patch?: { x: number } };
    expect(v.id).toBe("b");
    expect(v.patch?.x).toBe(45);
  });

  // IL CASO CHE SI VEDE: distribuisci, poi ridistribuisci. La seconda volta il
  // layout è già giusto, quindi non deve viaggiare NIENTE sul filo -- altrimenti
  // si impila una voce di undo che non disfa niente (il Ctrl+Z successivo non fa
  // nulla di visibile). Con l'accumulatore in virgola mobile l'estremo riceveva
  // un delta di -1.1e-13 e l'op partiva a ogni click, all'infinito.
  it("emits nothing on a SECOND distribute — and on a third", () => {
    const ids = ["a", "b", "c"];
    const nodes = [
      node({ id: "a", x: 969.9, width: 31.8 }),
      node({ id: "b", x: 309.3, width: 38.7 }),
      node({ id: "c", x: 456.6, width: 28.9 }),
    ];
    let scene = sceneWith(nodes);
    const apply = (ops: Op[]) => {
      const next = sceneWith(ids.map((id) => scene.nodes.at(id)));
      for (const op of ops) {
        const v = op.kind.value as { id: string; patch?: { x: number; y: number } };
        next.nodes = next.nodes.set(v.id, { ...next.nodes.at(v.id), x: v.patch!.x, y: v.patch!.y });
      }
      scene = next;
    };

    const first = alignOps(scene, ids, "distribute-h");
    expect(first).toHaveLength(1); // solo quello di mezzo si muove
    apply(first);
    expect(alignOps(scene, ids, "distribute-h")).toEqual([]);
    expect(alignOps(scene, ids, "distribute-h")).toEqual([]);
  });

  // UN NODO SOLO NON SI MUOVE, per NESSUNO degli otto comandi.
  //
  // La tela è INFINITA e la camera parte a {0, 0, zoom: 1}: un documento può
  // vivere legittimamente a x = 10000 e non c'è nessun foglio 1920x1080 lì
  // sotto. Allineare un rettangolo solo contro un rettangolo inventato
  // all'origine lo teletrasporterebbe fuori dallo schermo -- e siccome sparisce
  // dalla vista, non si distingue da "l'ho cancellato per sbaglio": l'unico
  // rimedio sarebbe indovinare un Ctrl+Z.
  describe("un nodo solo", () => {
    const ALIGNS: AlignKind[] = ["left", "hcenter", "right", "top", "middle", "bottom"];

    it("non si muove: nessun comando produce un op", () => {
      const scene = sceneWith([node({ id: "a", x: 500, y: 500 })]);
      for (const cmd of ALIGN_COMMANDS) {
        expect({ cmd: cmd.id, ops: alignOps(scene, ["a"], cmd.id) }).toEqual({ cmd: cmd.id, ops: [] });
      }
    });

    it("resta dov'è anche lontanissimo dall'origine (x = 10000)", () => {
      const scene = sceneWith([node({ id: "far", x: 10000, y: 10000, width: 50, height: 50 })]);
      for (const kind of ALIGNS) {
        expect(alignDelta(
          { x: 10000, y: 10000, width: 50, height: 50 },
          alignTarget(scene, ["far"])!,
          kind,
        )).toEqual({ dx: 0, dy: 0 });
      }
      expect(alignOps(scene, ["far"], "left")).toEqual([]);
      expect(alignOps(scene, ["far"], "hcenter")).toEqual([]);
    });

    it("nemmeno se è RUOTATO (il suo AABB è comunque il riquadro comune)", () => {
      const scene = sceneWith([node({ id: "r", x: 700, y: 700, width: 10, height: 10, rotation: 30 })]);
      expect(alignOps(scene, ["r"], "left")).toEqual([]);
      expect(alignOps(scene, ["r"], "middle")).toEqual([]);
    });

    it("has nothing to distribute with a lone node", () => {
      const scene = sceneWith([node({ id: "a", x: 500 })]);
      expect(alignOps(scene, ["a"], "distribute-h")).toEqual([]);
    });
  });

  it("covers every command in ALIGN_COMMANDS", () => {
    const scene = sceneWith([node({ id: "a", x: 0 }), node({ id: "b", x: 15 }), node({ id: "c", x: 90, y: 33 })]);
    for (const cmd of ALIGN_COMMANDS) {
      // Nessun comando esplode e nessuno tocca campi diversi da x/y.
      for (const op of alignOps(scene, ["a", "b", "c"], cmd.id)) {
        expect((op.kind.value as { mask?: { paths: string[] } }).mask?.paths).toEqual(["x", "y"]);
      }
    }
  });
});

describe("alignSelection", () => {
  let sync: FakeSync;

  beforeEach(() => {
    sync = new FakeSync();
    useScene.setState({ camera: { x: 0, y: 0, zoom: 1 }, selection: [], gesture: null, sync: null });
    useScene.getState().setScene(sceneWith([
      node({ id: "a", x: 0, y: 0 }),
      node({ id: "b", x: 90, y: 40 }),
      node({ id: "c", x: 200, y: 80 }),
    ]));
    useScene.setState({ sync });
  });

  it("is ONE gesture — one undo entry, however many nodes move", () => {
    useScene.setState({ selection: ["a", "b", "c"] });
    alignSelection("left");
    expect(useScene.getState().scene!.nodes.at("b").x).toBe(0);
    expect(useScene.getState().scene!.nodes.at("c").x).toBe(0);
    expect(sync.sent).toHaveLength(2);
    expect(useScene.getState().undoStack).toHaveLength(1);
    useScene.getState().undo();
    expect(useScene.getState().scene!.nodes.at("b").x).toBe(90);
    expect(useScene.getState().scene!.nodes.at("c").x).toBe(200);
  });

  it("leaves no gesture open", () => {
    useScene.setState({ selection: ["a", "b"] });
    alignSelection("top");
    expect(useScene.getState().gesture).toBeNull();
  });

  it("does nothing at all when there is nothing to move", () => {
    useScene.setState({ selection: [] });
    alignSelection("left");
    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().undoStack).toHaveLength(0);
    expect(useScene.getState().gesture).toBeNull();
  });

  it("opens no gesture when every node is already where it should be", () => {
    const begin = vi.spyOn(useScene.getState(), "beginGesture");
    useScene.setState({ selection: ["a", "b"] });
    alignSelection("left");
    sync.sent = [];
    alignSelection("left"); // già allineati
    expect(sync.sent).toHaveLength(0);
    begin.mockRestore();
  });

  it("con un nodo SOLO non manda niente e non apre nessun gesto", () => {
    useScene.setState({ selection: ["a"] });
    for (const cmd of ALIGN_COMMANDS) alignSelection(cmd.id);
    expect(useScene.getState().scene!.nodes.at("a")).toMatchObject({ x: 0, y: 0 });
    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().undoStack).toHaveLength(0);
    expect(useScene.getState().gesture).toBeNull();
  });
});

// La soglia che il pannello usa per DISABILITARE un pulsante. Sta qui, accanto
// alla regola che descrive, e non nel pannello: è la stessa cosa che alignOps
// fa in silenzio (sotto il minimo non produce op), detta prima e a voce alta.
describe("minSelection", () => {
  it("chiede DUE nodi per allineare e TRE per distribuire", () => {
    for (const cmd of ["left", "hcenter", "right", "top", "middle", "bottom"] as const) {
      expect({ cmd, n: minSelection(cmd) }).toEqual({ cmd, n: 2 });
    }
    for (const cmd of ["distribute-h", "distribute-v"] as const) {
      expect({ cmd, n: minSelection(cmd) }).toEqual({ cmd, n: 3 });
    }
  });

  it("copre ogni comando dell'elenco", () => {
    for (const cmd of ALIGN_COMMANDS) expect(minSelection(cmd.id)).toBeGreaterThanOrEqual(2);
  });

  // LA GUARDIA: la soglia non è un numero scritto a mano accanto ai pulsanti,
  // deve essere il punto in cui alignOps smette di produrre op. Con esattamente
  // minSelection - 1 nodi (tutti fuori posto) non deve partire NIENTE; con
  // minSelection nodi deve partire qualcosa.
  it("è esattamente il punto in cui alignOps comincia a produrre op", () => {
    const nodes = [
      node({ id: "a", x: 0, y: 0 }),
      node({ id: "b", x: 40, y: 40 }),
      node({ id: "c", x: 200, y: 90 }),
    ];
    const scene = sceneWith(nodes);
    const ids = ["a", "b", "c"];
    for (const cmd of ALIGN_COMMANDS) {
      const n = minSelection(cmd.id);
      expect({ cmd: cmd.id, ops: alignOps(scene, ids.slice(0, n - 1), cmd.id) })
        .toEqual({ cmd: cmd.id, ops: [] });
      expect(alignOps(scene, ids.slice(0, n), cmd.id).length).toBeGreaterThan(0);
    }
  });
});
