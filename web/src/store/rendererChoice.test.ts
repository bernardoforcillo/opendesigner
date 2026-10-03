import { describe, it, expect, beforeEach } from "vitest";
import { loadRendererChoice, useRenderer } from "./rendererChoice";

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, "", "/");
  useRenderer.setState({ choice: "cpu", status: "cpu", error: null, frameMs: null });
});

describe("loadRendererChoice", () => {
  it("il predefinito è la CPU: la GPU si sceglie, non si subisce", () => {
    expect(loadRendererChoice()).toBe("cpu");
  });

  it("legge la preferenza salvata; un valore sconosciuto vale CPU", () => {
    localStorage.setItem("opendesigner.renderer", "gpu");
    expect(loadRendererChoice()).toBe("gpu");
    localStorage.setItem("opendesigner.renderer", "metal");
    expect(loadRendererChoice()).toBe("cpu");
  });

  it("?renderer= vince sulla preferenza salvata (per provare senza toccarla)", () => {
    localStorage.setItem("opendesigner.renderer", "cpu");
    window.history.replaceState(null, "", "/?renderer=gpu");
    expect(loadRendererChoice()).toBe("gpu");
    window.history.replaceState(null, "", "/?renderer=nonsense");
    expect(loadRendererChoice()).toBe("cpu");
  });
});

describe("useRenderer", () => {
  it("scegliere la GPU la salva e passa a 'loading'; tornare alla CPU azzera errore e tempo", () => {
    useRenderer.setState({ error: "x", frameMs: 3 });
    useRenderer.getState().setChoice("gpu");
    expect(localStorage.getItem("opendesigner.renderer")).toBe("gpu");
    expect(useRenderer.getState()).toMatchObject({ choice: "gpu", status: "loading", error: null, frameMs: null });
    useRenderer.getState().setChoice("cpu");
    expect(useRenderer.getState()).toMatchObject({ choice: "cpu", status: "cpu" });
    expect(localStorage.getItem("opendesigner.renderer")).toBe("cpu");
  });
});
