import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { App, toolsForMode } from "./App";
import { useFlowUi } from "../store/flowUi";
import { useScene } from "../store/store";
import { emptyScene } from "../store/types";
import { baseScene } from "../flow/testSupport";

// MODALITA' SVILUPPO dentro App: il terzo segmento del selettore, i pannelli che
// sostituiscono quelli di Design/Flussi, gli strumenti ridotti e la scorciatoia S.
// Come per i Flussi, App è l'unico punto in cui diventano raggiungibili.

const exportCode = vi.fn(async () => ({ files: [], warnings: [] }));
vi.mock("../rpc/client", () => ({
  docClient: {
    createDocument: vi.fn(async () => ({ id: "doc-1" })),
    analyzeFlows: vi.fn(async () => ({ reports: [] })),
    exportCode: (...a: unknown[]) => (exportCode as (...x: unknown[]) => unknown)(...a),
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
  exportCode.mockClear();
  useFlowUi.setState({ mode: "design", presenting: false, selectedTransitionId: null, currentFlowId: null });
});

describe("modalità Sviluppo", () => {
  it("toolsForMode: in Sviluppo solo Seleziona e Mano; Design e Flussi come prima", () => {
    expect(toolsForMode("dev").map((t) => t.id)).toEqual(["select", "hand"]);
    expect(toolsForMode("flows").map((t) => t.id)).toEqual(["select", "connect", "hand"]);
    expect(toolsForMode("design").map((t) => t.id)).not.toContain("connect");
  });

  it("il selettore ha tre segmenti; Sviluppo sostituisce livelli e proprietà con Prontezza e Spedisci", () => {
    useScene.getState().setScene(baseScene());
    render(<App />);
    expect(["Design", "Flussi", "Sviluppo"].map((n) => screen.getByRole("radio", { name: n }))).toHaveLength(3);

    fireEvent.click(screen.getByRole("radio", { name: "Sviluppo" }));
    expect(useFlowUi.getState().mode).toBe("dev");
    expect(screen.getByRole("radio", { name: "Sviluppo" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("complementary", { name: "Prontezza" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Spedisci" })).toBeInTheDocument();
    expect(screen.queryByRole("grid", { name: "Livelli" })).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Proprietà" })).not.toBeInTheDocument();
    expect(screen.getByTestId("code-workbench")).toBeInTheDocument();
    // strumenti: solo select e hand; niente forme né Collega né Presenta
    expect(screen.getByRole("radio", { name: "Seleziona" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Mano" })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Rettangolo" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Collega" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Presenta" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "Design" }));
    expect(screen.getByRole("grid", { name: "Livelli" })).toBeInTheDocument();
    expect(screen.queryByTestId("code-workbench")).not.toBeInTheDocument();
  });

  it("S apre Sviluppo e di nuovo S torna a Design; F da Sviluppo torna a Design", () => {
    useScene.getState().setScene(emptyScene("doc-1", "Untitled"));
    render(<App />);
    fireEvent.keyDown(window, { key: "s" });
    expect(useFlowUi.getState().mode).toBe("dev");
    fireEvent.keyDown(window, { key: "s" });
    expect(useFlowUi.getState().mode).toBe("design");
    fireEvent.keyDown(window, { key: "s" });
    fireEvent.keyDown(window, { key: "f" });
    expect(useFlowUi.getState().mode).toBe("design");
    // in Flussi, F porta a Design (invariato) e S a Sviluppo
    fireEvent.keyDown(window, { key: "f" });
    expect(useFlowUi.getState().mode).toBe("flows");
    fireEvent.keyDown(window, { key: "s" });
    expect(useFlowUi.getState().mode).toBe("dev");
  });

  it("S non scatta in un campo di testo né con un modificatore", () => {
    useScene.getState().setScene(emptyScene("doc-1", "Untitled"));
    render(<App />);
    const input = document.createElement("input");
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: "s" });
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    fireEvent.keyDown(window, { key: "s", metaKey: true });
    expect(useFlowUi.getState().mode).toBe("design");
    input.remove();
  });

  it("uno strumento di disegno scelto in Design ricade su Seleziona entrando in Sviluppo", () => {
    useScene.getState().setScene(emptyScene("doc-1", "Untitled"));
    render(<App />);
    fireEvent.click(screen.getByRole("radio", { name: "Rettangolo" }));
    expect(screen.getByRole("radio", { name: "Rettangolo" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("radio", { name: "Sviluppo" }));
    expect(screen.getByRole("radio", { name: "Seleziona" })).toHaveAttribute("aria-checked", "true");
  });

  it("niente lavoro fuori da Sviluppo: ExportCode si chiama solo dentro la modalità", async () => {
    useScene.getState().setScene(baseScene());
    render(<App />);
    fireEvent.keyDown(window, { key: "f" }); // Flussi
    await new Promise((r) => setTimeout(r, 30));
    expect(exportCode).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("radio", { name: "Sviluppo" }));
    await vi.waitFor(() => expect(exportCode).toHaveBeenCalled());
    expect(exportCode.mock.calls[0]).toEqual([{ docId: "doc", target: "react", flowId: "" }, expect.objectContaining({ signal: expect.anything() })]);
  });
});
