import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
});
