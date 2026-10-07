import { nodesOf } from "../store/nodeMap";
import { describe, it, expect } from "vitest";
import { applyOp } from "../store/applyOp";
import { emptyScene } from "../store/types";
import type { EffectLite, NodeLite, SceneState } from "../store/types";
import {
  DEFAULT_SHADOW, addShadowOps, backgroundBlurOps, blendModeOps, blurOf, blurOps, editShadowOps, removeEffectOps, shadowOf,
  shadowOps, shadowsOf,
} from "./effectOps";

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
  it("turning on the shadow writes the default", () => {
    const s = sceneWith();
    const n = run(s, shadowOps(["a"], look(s), { enabled: true }));
    expect(n.effects).toEqual([DEFAULT_SHADOW]);
  });

  it("turning it off removes the field entirely (does not leave an empty list)", () => {
    const s = sceneWith([DEFAULT_SHADOW]);
    const n = run(s, shadowOps(["a"], look(s), { enabled: false }));
    expect(n.effects).toBeUndefined();
    expect("effects" in n).toBe(false);
  });

  it("turning off a shadow that is not there writes nothing", () => {
    const s = sceneWith();
    expect(shadowOps(["a"], look(s), { enabled: false })).toEqual([]);
  });

  it("changes one field at a time and keeps the others", () => {
    const s = sceneWith([DEFAULT_SHADOW]);
    const n = run(s, shadowOps(["a"], look(s), { offsetX: 7, blur: 20 }));
    expect(shadowOf(n)).toEqual({ ...DEFAULT_SHADOW, offsetX: 7, blur: 20 });
  });

  it("the color changes RGB and keeps alpha; alpha is written separately and clamped to 0..1", () => {
    const s = sceneWith([DEFAULT_SHADOW]);
    const c = run(s, shadowOps(["a"], look(s), { rgb: { r: 1, g: 0, b: 0 } }));
    expect(shadowOf(c)?.color).toEqual({ r: 1, g: 0, b: 0, a: 0.25 });
    expect(shadowOf(run(s, shadowOps(["a"], look(s), { alpha: 5 })))?.color.a).toBe(1);
    expect(shadowOf(run(s, shadowOps(["a"], look(s), { alpha: -1 })))?.color.a).toBe(0);
  });

  it("a negative blur is brought to 0", () => {
    const s = sceneWith([DEFAULT_SHADOW]);
    expect(shadowOf(run(s, shadowOps(["a"], look(s), { blur: -3 })))?.blur).toBe(0);
  });

  it("a value identical to the current one produces no op", () => {
    const s = sceneWith([DEFAULT_SHADOW]);
    expect(shadowOps(["a"], look(s), { offsetY: DEFAULT_SHADOW.offsetY })).toEqual([]);
  });

  it("the list's other effects survive the shadow edit", () => {
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
  it("sets, changes and removes with radius 0, without touching the shadow", () => {
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

  it("same value or nothing to remove: no op", () => {
    const s = sceneWith([{ kind: "layerBlur", radius: 3 }]);
    expect(blurOps(["a"], look(s), 3)).toEqual([]);
    expect(blurOps(["a"], look(sceneWith()), 0)).toEqual([]);
  });
});

describe("the whole effect list", () => {
  it("adds, edits by index and removes shadows of both kinds", () => {
    let s = sceneWith([DEFAULT_SHADOW]);
    let n = run(s, addShadowOps(["a"], look(s), "innerShadow"));
    expect(n.effects?.map((e) => e.kind)).toEqual(["dropShadow", "innerShadow"]);
    s = { ...s, nodes: nodesOf({ a: n }) };
    n = run(s, editShadowOps(["a"], look(s), 1, { blur: 2, offsetY: 1 }));
    expect(shadowsOf(n).map((x) => [x.index, x.shadow.kind, x.shadow.blur])).toEqual([[0, "dropShadow", 8], [1, "innerShadow", 2]]);
    expect(editShadowOps(["a"], look(s), 5, { blur: 1 })).toEqual([]);
    n = run(s, removeEffectOps(["a"], look(s), 0));
    expect(n.effects?.map((e) => e.kind)).toEqual(["innerShadow"]);
  });

  it("the background blur is written and removed with its radius", () => {
    let s = sceneWith();
    const n = run(s, backgroundBlurOps(["a"], look(s), 12));
    expect(n.effects).toEqual([{ kind: "backgroundBlur", radius: 12 }]);
    s = { ...s, nodes: nodesOf({ a: n }) };
    expect(run(s, backgroundBlurOps(["a"], look(s), 0)).effects).toBeUndefined();
  });

  it("the blend mode is written, and normal removes the field", () => {
    let s = sceneWith();
    const n = run(s, blendModeOps(["a"], look(s), "multiply"));
    expect(n.blendMode).toBe("multiply");
    s = { ...s, nodes: nodesOf({ a: n }) };
    expect("blendMode" in run(s, blendModeOps(["a"], look(s), undefined))).toBe(false);
    expect(blendModeOps(["a"], look(s), "multiply")).toEqual([]);
  });
});
