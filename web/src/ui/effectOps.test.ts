import { nodesOf } from "../store/nodeMap";
import { describe, it, expect } from "vitest";
import { applyOp } from "../store/applyOp";
import { emptyScene } from "../store/types";
import type { EffectLite, NodeLite, SceneState } from "../store/types";
import { DEFAULT_SHADOW, blurOf, blurOps, shadowOf, shadowOps } from "./effectOps";

function sceneWith(effects?: EffectLite[]): SceneState {
  const n: NodeLite = {
    id: "a", parentId: "page1", orderKey: "a0", name: "a", visible: true, opacity: 1,
    x: 0, y: 0, width: 100, height: 100, rotation: 0,
    fills: [], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false,
    ...(effects ? { effects } : {}),
  };
  return { ...emptyScene("d", "t"), nodes: nodesOf({ a: n }) };
}
const run = (s: SceneState, ops: ReturnType<typeof shadowOps>): NodeLite => ops.reduce(applyOp, s).nodes.at("a");
const look = (s: SceneState) => (id: string) => s.nodes.at(id);

describe("shadowOps", () => {
  it("accendere l'ombra scrive il default", () => {
    const s = sceneWith();
    const n = run(s, shadowOps(["a"], look(s), { enabled: true }));
    expect(n.effects).toEqual([DEFAULT_SHADOW]);
  });

  it("spegnerla toglie il campo del tutto (non lascia una lista vuota)", () => {
    const s = sceneWith([DEFAULT_SHADOW]);
    const n = run(s, shadowOps(["a"], look(s), { enabled: false }));
    expect(n.effects).toBeUndefined();
    expect("effects" in n).toBe(false);
  });

  it("spegnere un'ombra che non c'è non scrive nulla", () => {
    const s = sceneWith();
    expect(shadowOps(["a"], look(s), { enabled: false })).toEqual([]);
  });

  it("cambia un campo alla volta e tiene gli altri", () => {
    const s = sceneWith([DEFAULT_SHADOW]);
    const n = run(s, shadowOps(["a"], look(s), { offsetX: 7, blur: 20 }));
    expect(shadowOf(n)).toEqual({ ...DEFAULT_SHADOW, offsetX: 7, blur: 20 });
  });

  it("il colore cambia RGB e conserva l'alfa; l'alfa si scrive a parte e si limita a 0..1", () => {
    const s = sceneWith([DEFAULT_SHADOW]);
    const c = run(s, shadowOps(["a"], look(s), { rgb: { r: 1, g: 0, b: 0 } }));
    expect(shadowOf(c)?.color).toEqual({ r: 1, g: 0, b: 0, a: 0.25 });
    expect(shadowOf(run(s, shadowOps(["a"], look(s), { alpha: 5 })))?.color.a).toBe(1);
    expect(shadowOf(run(s, shadowOps(["a"], look(s), { alpha: -1 })))?.color.a).toBe(0);
  });

  it("una sfocatura negativa si porta a 0", () => {
    const s = sceneWith([DEFAULT_SHADOW]);
    expect(shadowOf(run(s, shadowOps(["a"], look(s), { blur: -3 })))?.blur).toBe(0);
  });

  it("un valore identico a quello attuale non produce nessun op", () => {
    const s = sceneWith([DEFAULT_SHADOW]);
    expect(shadowOps(["a"], look(s), { offsetY: DEFAULT_SHADOW.offsetY })).toEqual([]);
  });

  it("gli altri effetti della lista sopravvivono alla modifica dell'ombra", () => {
    const blur: EffectLite = { kind: "layerBlur", radius: 4 };
    const second: EffectLite = { ...DEFAULT_SHADOW, offsetX: 99 };
    const s = sceneWith([blur, DEFAULT_SHADOW, second]);
    const n = run(s, shadowOps(["a"], look(s), { offsetX: 1 }));
    expect(n.effects).toEqual([blur, { ...DEFAULT_SHADOW, offsetX: 1 }, second]);
    const off = run(s, shadowOps(["a"], look(s), { enabled: false }));
    expect(off.effects).toEqual([blur, second]);
  });
});

describe("blurOps", () => {
  it("imposta, cambia e toglie con raggio 0, senza toccare l'ombra", () => {
    let s = sceneWith([DEFAULT_SHADOW]);
    let n = run(s, blurOps(["a"], look(s), 6));
    expect(blurOf(n)).toEqual({ kind: "layerBlur", radius: 6 });
    expect(shadowOf(n)).toEqual(DEFAULT_SHADOW);
    s = { ...s, nodes: nodesOf({ a: n }) };
    n = run(s, blurOps(["a"], look(s), 2));
    expect(blurOf(n)?.radius).toBe(2);
    s = { ...s, nodes: nodesOf({ a: n }) };
    n = run(s, blurOps(["a"], look(s), 0));
    expect(blurOf(n)).toBeUndefined();
    expect(n.effects).toEqual([DEFAULT_SHADOW]);
  });

  it("stesso valore o niente da togliere: nessun op", () => {
    const s = sceneWith([{ kind: "layerBlur", radius: 3 }]);
    expect(blurOps(["a"], look(s), 3)).toEqual([]);
    expect(blurOps(["a"], look(sceneWith()), 0)).toEqual([]);
  });
});
