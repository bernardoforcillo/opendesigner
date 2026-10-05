import { describe, it, expect, beforeEach } from "vitest";
import { loadRendererChoice, useRenderer } from "./rendererChoice";

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, "", "/");
  useRenderer.setState({ choice: "cpu", status: "cpu", error: null, frameMs: null });
});

describe("loadRendererChoice", () => {
  it("the default is the CPU: the GPU is chosen, not imposed", () => {
    expect(loadRendererChoice()).toBe("cpu");
  });

  it("reads the saved preference; an unknown value means CPU", () => {
    localStorage.setItem("opendesigner.renderer", "gpu");
    expect(loadRendererChoice()).toBe("gpu");
    localStorage.setItem("opendesigner.renderer", "metal");
    expect(loadRendererChoice()).toBe("cpu");
  });

  it("?renderer= wins over the saved preference (to try without touching it)", () => {
    localStorage.setItem("opendesigner.renderer", "cpu");
    window.history.replaceState(null, "", "/?renderer=gpu");
    expect(loadRendererChoice()).toBe("gpu");
    window.history.replaceState(null, "", "/?renderer=nonsense");
    expect(loadRendererChoice()).toBe("cpu");
  });
});

describe("useRenderer", () => {
  it("choosing the GPU saves it and goes to 'loading'; going back to the CPU resets error and time", () => {
    useRenderer.setState({ error: "x", frameMs: 3 });
    useRenderer.getState().setChoice("gpu");
    expect(localStorage.getItem("opendesigner.renderer")).toBe("gpu");
    expect(useRenderer.getState()).toMatchObject({ choice: "gpu", status: "loading", error: null, frameMs: null });
    useRenderer.getState().setChoice("cpu");
    expect(useRenderer.getState()).toMatchObject({ choice: "cpu", status: "cpu" });
    expect(localStorage.getItem("opendesigner.renderer")).toBe("cpu");
  });
});
