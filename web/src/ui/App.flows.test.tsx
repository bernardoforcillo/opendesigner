import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { App, TOOLS } from "./App";
import { connectTool } from "../tools/connectTool";
import { useFlowUi } from "../store/flowUi";
import { useScene } from "../store/store";
import { emptyScene } from "../store/types";

// MODALITÀ FLUSSI dentro App: il toggle in intestazione, gli strumenti, i
// pannelli e le scorciatoie F / K. App è l'unico punto in cui diventano
// raggiungibili (stessa ragione dei test della toolbar in App.test.tsx).

vi.mock("../rpc/client", () => ({
  docClient: {
    createDocument: vi.fn(async () => ({ id: "doc-1" })),
    analyzeFlows: vi.fn(async () => ({ reports: [] })),
  },
}));
vi.mock("../rpc/syncClient", () => ({
  SyncClient: class {
    async start() {}
    stop() {}
  },
}));
vi.stubGlobal("localStorage", { getItem: () => "doc-1", setItem: () => {}, removeItem: () => {} });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useFlowUi.setState({ mode: "design", presenting: false, selectedTransitionId: null, currentFlowId: null });
});

describe("modalità Flussi", () => {
  it("il tool Collega è registrato ed è il connectTool vero", () => {
    expect(TOOLS.connect).toBe(connectTool);
  });

  it("il toggle Design | Flussi cambia pannelli e strumenti", () => {
    useScene.getState().setScene(emptyScene("doc-1", "Untitled"));
    render(<App />);
    expect(screen.getByRole("radio", { name: "Design" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("grid", { name: "Livelli" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "Flussi" }));
    expect(useFlowUi.getState().mode).toBe("flows");
    // Il pannello flussi sostituisce i livelli; "Collega" compare, "Rettangolo" no.
    expect(screen.queryByRole("grid", { name: "Livelli" })).not.toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Flussi" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Collega" })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Rettangolo" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Presenta" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "Design" }));
    expect(screen.getByRole("grid", { name: "Livelli" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Presenta" })).not.toBeInTheDocument();
  });

  it("F alterna la modalità, K entra in Flussi con Collega attivo", () => {
    useScene.getState().setScene(emptyScene("doc-1", "Untitled"));
    const { container } = render(<App />);
    const canvas = container.querySelector("#scene") as HTMLCanvasElement;
    fireEvent.keyDown(window, { key: "f" });
    expect(useFlowUi.getState().mode).toBe("flows");
    fireEvent.keyDown(window, { key: "f" });
    expect(useFlowUi.getState().mode).toBe("design");

    fireEvent.keyDown(window, { key: "k" });
    expect(useFlowUi.getState().mode).toBe("flows");
    expect(screen.getByRole("radio", { name: "Collega" })).toHaveAttribute("aria-checked", "true");
    expect(canvas.style.cursor).toBe(connectTool.cursor);

    // Tornando a Design il tool Collega (che là non esiste) ricade su Seleziona.
    fireEvent.keyDown(window, { key: "f" });
    expect(screen.getByRole("radio", { name: "Seleziona" })).toHaveAttribute("aria-checked", "true");
  });

  it("F e K non scattano mentre si scrive in un campo di testo", () => {
    useScene.getState().setScene(emptyScene("doc-1", "Untitled"));
    render(<App />);
    const input = document.createElement("input");
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: "f" });
    fireEvent.keyDown(input, { key: "k" });
    expect(useFlowUi.getState().mode).toBe("design");
    input.remove();
  });

  it("Presenta apre il prototipo e Esc lo chiude", () => {
    useScene.getState().setScene(emptyScene("doc-1", "Untitled"));
    render(<App />);
    fireEvent.click(screen.getByRole("radio", { name: "Flussi" }));
    fireEvent.click(screen.getByRole("button", { name: "Presenta" }));
    expect(screen.getByRole("dialog", { name: "Prototipo" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Prototipo" })).not.toBeInTheDocument();
  });
});
