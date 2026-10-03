import { describe, it, expect, beforeEach } from "vitest";
import { baseScene, child } from "../flow/testSupport";
import { nodesWith } from "../store/nodeMap";
import { useScene } from "../store/store";
import type { SceneState } from "../store/types";
import { PRESETS, buildPreset, type PresetId } from "./presets";
import { isValidClip } from "./validate";
import { applyPreset, useTimeline } from "./timelineStore";
import { sampleClip } from "./engine";

function scene(): SceneState {
  const s = baseScene();
  return {
    ...s,
    nodes: nodesWith(s.nodes, {
      vec: { ...child("vec", "A", 10, 120), kind: "vector", vector: { subpaths: [] }, opacity: 0.8, rotation: 30 },
      txt: { ...child("txt", "A", 0, 150), kind: "text" },
    }),
  };
}

describe("buildPreset", () => {
  const ids = PRESETS.map((p) => p.id);
  it("sono sei", () => expect(ids).toEqual(["fadeIn", "slideUp", "pop", "spin", "pulse", "draw"]));

  it.each(ids)("%s dà una clip valida con id, nome e bersaglio", (id) => {
    const s = scene();
    const c = buildPreset(id, s, s.nodes.at("vec"), "nuova");
    expect(c).not.toBeNull();
    expect(c!.id).toBe("nuova");
    expect(c!.name).not.toBe("");
    expect(c!.targetId).toBe("A"); // la schermata che contiene il nodo
    expect(isValidClip(s, c!)).toBe(true);
    expect(c!.tracks.every((t) => t.nodeId === "vec")).toBe(true);
  });

  it("i valori sono relativi a quelli di base del nodo", () => {
    const s = scene();
    const slide = buildPreset("slideUp", s, s.nodes.at("vec"), "k")!;
    const y = slide.tracks.find((t) => t.prop === "y")!;
    expect(y.keyframes.map((k) => k.value)).toEqual([144, 120]); // parte 24 px sotto, finisce dov'è
    const op = slide.tracks.find((t) => t.prop === "opacity")!;
    expect(op.keyframes.at(-1)!.value).toBe(0.8);
    const spin = buildPreset("spin", s, s.nodes.at("vec"), "k")!;
    expect(spin.tracks[0].keyframes.map((k) => k.value)).toEqual([30, 390]);
  });

  it("trigger: ingresso per i preset d'entrata, loop infinito per spin e pulse", () => {
    const s = scene();
    const t = (id: PresetId) => { const c = buildPreset(id, s, s.nodes.at("vec"), "k")!; return [c.trigger, c.repeat]; };
    expect(t("fadeIn")).toEqual(["enter", 0]);
    expect(t("pop")).toEqual(["enter", 0]);
    expect(t("spin")).toEqual(["loop", -1]);
    expect(t("pulse")).toEqual(["loop", -1]);
  });

  it("Pop supera 1 e poi ritorna a 1; Pulse torna al punto di partenza (il loop non scatta)", () => {
    const s = scene();
    const pop = buildPreset("pop", s, s.nodes.at("vec"), "k")!;
    const sc = pop.tracks.find((t) => t.prop === "scale")!;
    expect(Math.max(...sc.keyframes.map((k) => k.value))).toBeGreaterThan(1);
    expect(sc.keyframes.at(-1)!.value).toBe(1);
    const pulse = buildPreset("pulse", s, s.nodes.at("vec"), "k")!;
    const ps = pulse.tracks[0].keyframes;
    expect(ps[0].value).toBe(ps.at(-1)!.value);
    expect(sampleClip(pulse, 0).get("vec")!.scale).toBe(sampleClip(pulse, pulse.duration).get("vec")!.scale);
  });

  it("Draw esiste solo per i nodi con un tracciato", () => {
    const s = scene();
    expect(buildPreset("draw", s, s.nodes.at("vec"), "k")).not.toBeNull();
    expect(buildPreset("draw", s, s.nodes.at("btn"), "k")).not.toBeNull(); // un rettangolo ha un perimetro
    expect(buildPreset("draw", s, s.nodes.at("txt"), "k")).toBeNull();
  });

  it("il nome è libero: non ripete uno già in uso", () => {
    const s = scene();
    const first = buildPreset("fadeIn", s, s.nodes.at("vec"), "k1")!;
    const s2 = { ...s, clips: { k1: first } };
    const second = buildPreset("fadeIn", s2, s2.nodes.at("vec"), "k2")!;
    expect(second.name).not.toBe(first.name);
  });
});

describe("applyPreset (un op, un passo di undo)", () => {
  beforeEach(() => {
    useScene.setState({ undoStack: [], redoStack: [], gesture: null, sync: null });
    useScene.getState().setScene(scene());
    useTimeline.setState({ open: false, clipId: null });
  });

  it("crea la clip con UN gesto, la apre e un undo la toglie", () => {
    const before = useScene.getState().undoStack.length;
    const c = applyPreset(useScene.getState().scene!, "vec", "fadeIn");
    expect(c).not.toBeNull();
    const st = useScene.getState();
    expect(st.scene!.clips[c!.id]).toEqual(c);
    expect(st.undoStack.length).toBe(before + 1);
    expect(useTimeline.getState().clipId).toBe(c!.id);
    expect(useTimeline.getState().open).toBe(true);
    useScene.getState().undo();
    expect(useScene.getState().scene!.clips[c!.id]).toBeUndefined();
  });

  it("un preset che non si applica non scrive niente", () => {
    const before = useScene.getState().undoStack.length;
    expect(applyPreset(useScene.getState().scene!, "txt", "draw")).toBeNull();
    expect(useScene.getState().undoStack.length).toBe(before);
  });
});
