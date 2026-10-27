import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "@/store/store";
import { emptyScene, type EffectLite, type NodeLite } from "@/store/types";
import { EffectsFxControls } from "@/ui/EffectsFxControls";
import { RAMP_DIRECTIONS, glassOps, noiseOps, progressiveOps, progressiveTargetOps, rampDirectionOf, textureOps } from "@/ui/effectFxOps";

class FakeSync {
  submit(op: Op) {
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
}

const rect = (effects?: EffectLite[]): NodeLite => ({
  id: "a", parentId: "page1", orderKey: "a", name: "a", visible: true, opacity: 1,
  x: 0, y: 0, width: 100, height: 100, rotation: 0, fills: [{ r: 1, g: 0, b: 0, a: 1 }], strokes: [],
  kind: "rect", cornerRadius: 0, clipsContent: false, ...(effects ? { effects } : {}),
});

const fx = () => useScene.getState().scene!.nodes.at("a").effects ?? [];
const lookup = (id: string) => useScene.getState().scene?.nodes.at(id);
const run = (build: (ids: readonly string[]) => Op[]) => {
  const store = useScene.getState();
  const ops = build(store.selection);
  if (ops.length === 0) return;
  store.beginGesture();
  store.endGesture(ops);
};

function install(effects?: EffectLite[]) {
  const scene = emptyScene("doc-1", "Untitled");
  scene.nodes = scene.nodes.set("a", rect(effects));
  useScene.getState().setScene(scene);
  useScene.setState({ camera: { x: 0, y: 0, zoom: 1 }, selection: ["a"], marquee: null, gesture: null, editingNodeId: null });
  useScene.getState().setSync(new FakeSync());
}

beforeEach(() => install());
afterEach(cleanup);

describe("effectFxOps", () => {
  it("turns a progressive blur on with the default ramp, edits it and moves it between targets", () => {
    run((ids) => progressiveOps(ids, lookup, false, { enabled: true }));
    expect(fx()).toEqual([{ kind: "progressiveBlur", startRadius: 0, endRadius: 16, x1: 0.5, y1: 0, x2: 0.5, y2: 1, background: false }]);
    run((ids) => progressiveOps(ids, lookup, false, { endRadius: 30, ...RAMP_DIRECTIONS.right }));
    expect(fx()[0]).toMatchObject({ endRadius: 30, x1: 0, y1: 0.5, x2: 1, y2: 0.5 });
    run((ids) => progressiveTargetOps(ids, lookup, "background"));
    expect(fx()[0]).toMatchObject({ background: true, endRadius: 30 });
    run((ids) => progressiveTargetOps(ids, lookup, "none"));
    expect(fx()).toEqual([]);
    expect(rampDirectionOf({ kind: "progressiveBlur", startRadius: 0, endRadius: 1, ...RAMP_DIRECTIONS.up, background: false })).toBe("up");
  });

  it("clamps values and keeps the other effects", () => {
    install([{ kind: "layerBlur", radius: 4 }]);
    run((ids) => noiseOps(ids, lookup, { mode: "multi", density: 3, opacity: -1, size: -2 }));
    expect(fx()[0]).toEqual({ kind: "layerBlur", radius: 4 });
    expect(fx()[1]).toMatchObject({ kind: "noise", mode: "multi", density: 1, opacity: 0, size: 0 });
    run((ids) => textureOps(ids, lookup, { intensity: 9 }));
    run((ids) => glassOps(ids, lookup, { light: 9, frost: -3 }));
    expect(fx().map((e) => e.kind)).toEqual(["layerBlur", "noise", "texture", "glass"]);
    expect(fx()[2]).toMatchObject({ intensity: 1 });
    expect(fx()[3]).toMatchObject({ light: 1, frost: 0 });
    run((ids) => noiseOps(ids, lookup, { enabled: false }));
    expect(fx().map((e) => e.kind)).toEqual(["layerBlur", "texture", "glass"]);
  });

  it("writes nothing when nothing changes", () => {
    expect(noiseOps(["a"], lookup, { enabled: false })).toEqual([]);
    run((ids) => glassOps(ids, lookup, { enabled: true }));
    expect(glassOps(["a"], lookup, { enabled: true })).toEqual([]);
  });
});

describe("EffectsFxControls", () => {
  it("picks a progressive blur target, direction and radii, one undo step each", () => {
    render(<EffectsFxControls run={run} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Progressive blur" }), { target: { value: "background" } });
    expect(fx()[0]).toMatchObject({ kind: "progressiveBlur", background: true });
    fireEvent.change(screen.getByRole("combobox", { name: "Blur direction" }), { target: { value: "left" } });
    expect(fx()[0]).toMatchObject({ x1: 1, x2: 0 });
    expect(useScene.getState().undoStack).toHaveLength(2);
    useScene.getState().undo();
    expect(fx()[0]).toMatchObject({ x1: 0.5, x2: 0.5 });
  });

  it("adds noise of a mode, shows the duo colours only for duo, and removes it", () => {
    render(<EffectsFxControls run={run} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Noise" }), { target: { value: "duo" } });
    expect(fx()[0]).toMatchObject({ kind: "noise", mode: "duo" });
    expect(screen.getByLabelText("Noise color 2")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Noise" }), { target: { value: "mono" } });
    expect(fx()[0]).toMatchObject({ mode: "mono" });
    expect(screen.queryByLabelText("Noise color 2")).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "Noise" }), { target: { value: "" } });
    expect(fx()).toEqual([]);
  });

  it("toggles texture and glass", () => {
    render(<EffectsFxControls run={run} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Texture" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Glass" }));
    expect(fx().map((e) => e.kind)).toEqual(["texture", "glass"]);
    fireEvent.click(screen.getByRole("checkbox", { name: "Glass" }));
    expect(fx().map((e) => e.kind)).toEqual(["texture"]);
  });
});
