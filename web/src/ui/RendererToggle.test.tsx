import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RendererToggle } from "./RendererToggle";
import { useRenderer } from "../store/rendererChoice";

beforeEach(() => {
  localStorage.clear();
  useRenderer.setState({ choice: "cpu", status: "cpu", error: null, frameMs: null });
});
afterEach(cleanup);

const button = () => screen.getByRole("button", { name: /Renderer:/ });

describe("RendererToggle", () => {
  it("mostra la CPU di default e propone la GPU", () => {
    render(<RendererToggle />);
    expect(button().textContent).toBe("CPU");
    expect(button().getAttribute("aria-label")).toBe("Renderer: CPU. Passa a GPU");
  });

  it("un clic sceglie la GPU, mostra 'GPU…' mentre carica, e salva la scelta", async () => {
    render(<RendererToggle />);
    await userEvent.click(button());
    expect(useRenderer.getState().choice).toBe("gpu");
    expect(button().textContent).toBe("GPU…");
    expect(localStorage.getItem("opendesigner.renderer")).toBe("gpu");
  });

  it("a GPU pronta mostra il tempo dell'ultimo frame; senza non mostra nulla", () => {
    useRenderer.setState({ choice: "gpu", status: "gpu", frameMs: null });
    render(<RendererToggle />);
    expect(button().textContent).toBe("GPU");
    cleanup();
    useRenderer.setState({ frameMs: 3.14159 });
    render(<RendererToggle />);
    expect(button().textContent).toBe("GPU3.1 ms");
  });

  it("dopo un guasto dice che la GPU non va e perché, e un clic riprova", async () => {
    useRenderer.setState({ choice: "cpu", status: "error", error: "wasm non scaricato" });
    render(<RendererToggle />);
    expect(button().textContent).toBe("GPU ✕");
    expect(button().getAttribute("title")).toContain("wasm non scaricato");
    await userEvent.click(button());
    expect(useRenderer.getState()).toMatchObject({ choice: "gpu", status: "loading", error: null });
  });

  it("da GPU un clic torna alla CPU", async () => {
    useRenderer.setState({ choice: "gpu", status: "gpu" });
    render(<RendererToggle />);
    await userEvent.click(button());
    expect(useRenderer.getState().choice).toBe("cpu");
  });
});
