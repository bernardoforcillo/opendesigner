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
  it("shows the CPU by default and offers the GPU", () => {
    render(<RendererToggle />);
    expect(button().textContent).toBe("CPU");
    expect(button().getAttribute("aria-label")).toBe("Renderer: CPU. Switch to GPU");
  });

  it("a click picks the GPU, shows 'GPU…' while loading, and saves the choice", async () => {
    render(<RendererToggle />);
    await userEvent.click(button());
    expect(useRenderer.getState().choice).toBe("gpu");
    expect(button().textContent).toBe("GPU…");
    expect(localStorage.getItem("opendesigner.renderer")).toBe("gpu");
  });

  it("with the GPU ready it shows the last frame's time; without it shows nothing", () => {
    useRenderer.setState({ choice: "gpu", status: "gpu", frameMs: null });
    render(<RendererToggle />);
    expect(button().textContent).toBe("GPU");
    cleanup();
    useRenderer.setState({ frameMs: 3.14159 });
    render(<RendererToggle />);
    expect(button().textContent).toBe("GPU3.1 ms");
  });

  it("after a failure it says the GPU does not work and why, and a click retries", async () => {
    useRenderer.setState({ choice: "cpu", status: "error", error: "wasm not downloaded" });
    render(<RendererToggle />);
    expect(button().textContent).toBe("GPU ✕");
    expect(button().getAttribute("title")).toContain("wasm not downloaded");
    await userEvent.click(button());
    expect(useRenderer.getState()).toMatchObject({ choice: "gpu", status: "loading", error: null });
  });

  it("from the GPU a click goes back to the CPU", async () => {
    useRenderer.setState({ choice: "gpu", status: "gpu" });
    render(<RendererToggle />);
    await userEvent.click(button());
    expect(useRenderer.getState().choice).toBe("cpu");
  });
});
