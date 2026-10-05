import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { PrototypePlayer } from "./PrototypePlayer";
import { useScene } from "../store/store";
import { useFlowUi } from "../store/flowUi";
import { baseScene, flowOf, transition, withFlows } from "../flow/testSupport";
import type { ClipLite, SceneState } from "../store/types";
import * as renderer from "../renderer/canvasRenderer";

// Animations in Present: enter and loop start with the screen, hover and tap
// on the target, and a finished animation keeps no frame loop running.

let size = 0;
beforeEach(() => {
  size = 1;
  for (const prop of ["clientWidth", "clientHeight"] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get() { return size ? (prop === "clientWidth" ? 800 : 600) : 0; },
    });
  }
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as never);
  useFlowUi.setState({ currentFlowId: null });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
});

const op = (id: string, extra: Partial<ClipLite> = {}): ClipLite => ({
  id, name: id, duration: 300, trigger: "enter", delay: 0, repeat: 0, yoyo: false, targetId: "A",
  tracks: [{ nodeId: "btn", prop: "opacity", keyframes: [{ time: 0, value: 0.2, easing: "" }, { time: 300, value: 0.9, easing: "" }] }],
  ...extra,
});

function install(...clips: ClipLite[]): SceneState {
  const s = {
    ...withFlows(baseScene(), [flowOf("f1", "A", "Main")], [transition("t1", "f1", "A", "B", { label: "Go" })]),
    clips: Object.fromEntries(clips.map((c) => [c.id, c])),
  };
  useScene.getState().setScene(s);
  return s;
}
const spy = () => vi.spyOn(renderer, "drawScene").mockImplementation(() => {});
const lastBtn = (d: ReturnType<typeof spy>) => d.mock.calls.at(-1)?.[1].nodes.at("btn");
const stage = () => (screen.getByRole("dialog", { name: "Prototype" }).firstElementChild as HTMLElement);
// The player's camera at 800x600 for a 200x300 frame: zoom 1.68, origin (232, 48). btn sits at (60,200) 80x30.
const BTN = { clientX: 232 + 100 * 1.68, clientY: 48 + 215 * 1.68 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Present: document clips", () => {
  it("without clips the usual derived scene is drawn, no frame loop", async () => {
    install();
    const d = spy();
    render(<PrototypePlayer onClose={() => {}} />);
    await waitFor(() => expect(d).toHaveBeenCalled());
    await sleep(60);
    const n = d.mock.calls.length;
    await sleep(200);
    expect(d.mock.calls.length).toBe(n);
    expect(d.mock.calls.at(-1)?.[1].anim).toBeUndefined();
  });

  it("enter: starts with the screen, reaches the final value and then the frames stop", async () => {
    install(op("e"));
    const d = spy();
    render(<PrototypePlayer onClose={() => {}} />);
    // at the start the first keyframe (0.2) applies, at the end the last (0.9) -- and it stays there
    await waitFor(() => expect(lastBtn(d)?.opacity).toBeCloseTo(0.9));
    expect(d.mock.calls.some((c) => c[1].nodes.at("btn").opacity < 0.9)).toBe(true);
    await sleep(80);
    const n = d.mock.calls.length;
    await sleep(250);
    expect(d.mock.calls.length).toBe(n); // finished: no rAF around
    expect(lastBtn(d)?.opacity).toBeCloseTo(0.9);
  });

  it("loop: never ends (the frames continue)", async () => {
    install(op("l", { trigger: "loop" }));
    const d = spy();
    render(<PrototypePlayer onClose={() => {}} />);
    await waitFor(() => expect(d.mock.calls.length).toBeGreaterThan(6));
    const n = d.mock.calls.length;
    await sleep(200);
    expect(d.mock.calls.length).toBeGreaterThan(n + 3);
  });

  it("hover: starts when the pointer enters the target and goes back to the base when it leaves", async () => {
    install(op("h", { trigger: "hover", targetId: "btn" }));
    const d = spy();
    render(<PrototypePlayer onClose={() => {}} />);
    await waitFor(() => expect(d).toHaveBeenCalled());
    expect(lastBtn(d)?.opacity).toBe(1); // base: no animation yet
    fireEvent.pointerMove(stage(), BTN);
    await waitFor(() => expect(lastBtn(d)?.opacity).toBeCloseTo(0.9));
    fireEvent.pointerMove(stage(), { clientX: 10, clientY: 10 }); // outside the target
    await waitFor(() => expect(lastBtn(d)?.opacity).toBe(1));
  });

  it("tap: holds while it stays pressed", async () => {
    install(op("t", { trigger: "tap", targetId: "btn" }));
    const d = spy();
    render(<PrototypePlayer onClose={() => {}} />);
    await waitFor(() => expect(d).toHaveBeenCalled());
    fireEvent.pointerDown(stage(), BTN);
    await waitFor(() => expect(lastBtn(d)?.opacity).toBeCloseTo(0.9));
    fireEvent.pointerUp(stage(), BTN);
    await waitFor(() => expect(lastBtn(d)?.opacity).toBe(1));
  });

  it("changing screen: the new one's clips restart, the other's no longer run", async () => {
    install(op("a"), op("b", { targetId: "B", tracks: [{ nodeId: "B", prop: "opacity", keyframes: [{ time: 0, value: 0.5, easing: "" }] }] }));
    const d = spy();
    render(<PrototypePlayer onClose={() => {}} />);
    await waitFor(() => expect(lastBtn(d)?.opacity).toBeCloseTo(0.9));
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    await waitFor(() => expect(d.mock.calls.at(-1)?.[1].nodes.at("B").opacity).toBe(0.5));
    // the derived scene now shows only B: A's clip is irrelevant
    expect(d.mock.calls.at(-1)?.[1].nodes.at("btn").opacity).toBe(1);
  });

  it("the store's document is not touched", async () => {
    const s = install(op("e"));
    const d = spy();
    render(<PrototypePlayer onClose={() => {}} />);
    await waitFor(() => expect(lastBtn(d)?.opacity).toBeCloseTo(0.9));
    expect(useScene.getState().scene).toBe(s);
    expect(s.nodes.at("btn").opacity).toBe(1);
  });
});
