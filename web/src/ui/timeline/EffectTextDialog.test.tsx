import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EffectTextDialog, useEffectText } from "@/ui/timeline/EffectTextDialog";
import { useScene } from "@/store/store";
import { useTimeline } from "@/animation/timelineStore";
import { baseScene, child } from "@/flow/testSupport";
import { nodesWith } from "@/store/nodeMap";
import { parseFxStringProp } from "@/animation/fx/props";
import { stringParamOf } from "@/animation/timelineLogic";
import type { SceneState } from "@/store/types";
import { fxData } from "@/animation/fx/files";
import { parseStrokes } from "@/animation/fx/paint";

// Adding an effect with text asks for the text first; editing it later replaces the track. One undo step each.
const BASIC = "ec.obsolete.basictext";
const sc = () => useScene.getState().scene!;

function install(): SceneState {
  const s = baseScene();
  const scene: SceneState = {
    ...s,
    nodes: nodesWith(s.nodes, { n: child("n", "A", 0, 0) }),
    clips: { k: { id: "k", name: "Clip", duration: 1000, trigger: "enter", delay: 0, repeat: 0, yoyo: false, targetId: "n", tracks: [] } },
  };
  useScene.setState({ undoStack: [], redoStack: [], gesture: null, sync: null, selection: ["n"] });
  useScene.getState().setScene(scene);
  return scene;
}

beforeEach(() => {
  useTimeline.setState({ open: true, clipId: "k", playhead: 0, playing: false, selection: [], draftClip: null, recordDraft: null });
  useEffectText.getState().close();
  install();
});
afterEach(() => {
  cleanup();
  useEffectText.getState().close();
  useTimeline.setState({ open: false });
});

describe("EffectTextDialog", () => {
  it("renders nothing until an effect with text is opened", () => {
    const { container } = render(<EffectTextDialog />);
    expect(container).toBeEmptyDOMElement();
  });

  it("add: asks for the text and the font, then adds the string tracks and the first parameter", async () => {
    render(<EffectTextDialog />);
    act(() => useEffectText.getState().open({ effectId: BASIC, mode: "add" }));
    const text = await screen.findByRole("textbox", { name: "Text" });
    expect(text).toHaveValue("Text"); // the default
    fireEvent.change(text, { target: { value: "Ciao, mondo ✓" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Font" }), { target: { value: "Georgia" } });
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    const clip = sc().clips.k;
    expect(stringParamOf(clip, "n", BASIC, "text")).toBe("Ciao, mondo ✓");
    expect(stringParamOf(clip, "n", BASIC, "font")).toBe("Georgia");
    expect(clip.tracks.some((t) => t.prop === `fx.${BASIC}.size`)).toBe(true);
    expect(clip.tracks.filter((t) => parseFxStringProp(t.prop))).toHaveLength(2);
    expect(useEffectText.getState().target).toBeNull();
  });

  it("cancel adds nothing", async () => {
    render(<EffectTextDialog />);
    act(() => useEffectText.getState().open({ effectId: BASIC, mode: "add" }));
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(sc().clips.k.tracks).toHaveLength(0);
  });

  it("edit: shows the current text and replaces the track instead of adding another", async () => {
    render(<EffectTextDialog />);
    act(() => useEffectText.getState().open({ effectId: BASIC, mode: "add" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Text" }), { target: { value: "first" } });
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    act(() => useEffectText.getState().open({ effectId: BASIC, mode: "edit", nodeId: "n" }));
    const text = await screen.findByRole("textbox", { name: "Text" });
    expect(text).toHaveValue("first");
    fireEvent.change(text, { target: { value: "second" } });
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    const clip = sc().clips.k;
    expect(stringParamOf(clip, "n", BASIC, "text")).toBe("second");
    expect(clip.tracks.filter((t) => parseFxStringProp(t.prop)?.param === "text")).toHaveLength(1);
  });

  it("a file effect: Add waits for a readable file, uploads it wrapped, and stores its hash", async () => {
    const HASH = "e".repeat(64);
    const sent: Blob[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => { sent.push(init?.body as Blob); return new Response(JSON.stringify({ hash: HASH, size: 1, contentType: "application/x-opendesigner-fx" }), { status: 200 }); }) as typeof fetch;
    try {
      render(<EffectTextDialog />);
      act(() => useEffectText.getState().open({ effectId: "ec.utility.applylut", mode: "add" }));
      const add = await screen.findByRole("button", { name: "Add" });
      expect(add).toBeDisabled();
      const input = screen.getByLabelText(/Color LUT file/);
      await userEvent.upload(input, new File(["not a lut"], "bad.cube"));
      expect(await screen.findByText(/cannot read this file/)).toBeInTheDocument();
      expect(sent).toHaveLength(0);
      const cube = "LUT_3D_SIZE 2\n" + Array.from({ length: 8 }, (_, i) => `${i & 1} ${(i >> 1) & 1} ${(i >> 2) & 1}`).join("\n") + "\n";
      await userEvent.upload(input, new File([cube], "id.cube"));
      await screen.findByText("id.cube");
      expect(sent).toHaveLength(1);
      expect(fxData(HASH)?.kind).toBe("lut3d");
      await userEvent.click(screen.getByRole("button", { name: "Add" }));
      expect(stringParamOf(sc().clips.k, "n", "ec.utility.applylut", "file")).toBe(HASH);
    } finally {
      globalThis.fetch = real;
    }
  });

  it("Paint: strokes are drawn on the pad, Add waits for one, and they are kept as the strokes string", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null); // jsdom has no 2D canvas: the pad then just records
    render(<EffectTextDialog />);
    act(() => useEffectText.getState().open({ effectId: "ec.paint.paint", mode: "add" }));
    const add = await screen.findByRole("button", { name: "Add" });
    expect(add).toBeDisabled();
    const pad = screen.getByLabelText("Paint pad");
    pad.getBoundingClientRect = () => ({ left: 0, top: 0, width: 360, height: 360, right: 360, bottom: 360, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(pad, { clientX: 36, clientY: 36, pointerId: 1 });
    fireEvent.pointerMove(pad, { clientX: 180, clientY: 250, pointerId: 1 });
    fireEvent.pointerUp(pad, { clientX: 300, clientY: 60, pointerId: 1 });
    expect(await screen.findByText("1 stroke")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    const saved = parseStrokes(stringParamOf(sc().clips.k, "n", "ec.paint.paint", "strokes") ?? "");
    expect(saved).toHaveLength(1);
    expect(saved[0].points.length).toBeGreaterThanOrEqual(2);
    expect(saved[0].points[0].x).toBeCloseTo(0.1, 1);
  });
});
